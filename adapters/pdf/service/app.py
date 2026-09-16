#!/usr/bin/env python
"""A small private HTTP front end for adapters/pdf.

Upload a PDF, the service runs the same `pdf2epub.py` pipeline the CLI runs,
and hands back one EPUB per device profile plus the evaluation report.

Nothing about the conversion changes: the service is a queue and a file store
around the CLI. One job runs at a time, in a subprocess, with a wall clock.

Deployment contract (see README.md):
  - bind to 127.0.0.1 and put TLS + a hostname in front (nginx on the VM);
  - PDF2EPUB_TOKEN must be set, every route except /health requires it;
  - uploads are capped by bytes and by page count before Docling ever runs.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

HERE = Path(__file__).resolve().parent
ADAPTER = HERE.parent

PROFILE_SUFFIX = {"paperPro": "paperpro", "paperProMove": "papermove", "mobile": "mobile"}
PROFILE_LABEL = {
    "paperPro": "reMarkable Paper Pro",
    "paperProMove": "reMarkable Paper Pro Move",
    "mobile": "phone / small screen",
}

DATA = Path(os.environ.get("PDF2EPUB_DATA", HERE / "data")).resolve()
TOKEN = os.environ.get("PDF2EPUB_TOKEN", "").strip()
ALLOW_ANON = os.environ.get("PDF2EPUB_ALLOW_ANONYMOUS", "").strip() in {"1", "true", "yes"}
MAX_BYTES = int(os.environ.get("PDF2EPUB_MAX_BYTES", 40 * 1024 * 1024))
MAX_PAGES = int(os.environ.get("PDF2EPUB_MAX_PAGES", 400))
JOB_TIMEOUT = int(os.environ.get("PDF2EPUB_TIMEOUT", 3600))
QUEUE_LIMIT = int(os.environ.get("PDF2EPUB_QUEUE_LIMIT", 20))
RETENTION_HOURS = float(os.environ.get("PDF2EPUB_RETENTION_HOURS", 72))
KEEP_INTERMEDIATES = os.environ.get("PDF2EPUB_KEEP_INTERMEDIATES", "").strip() in {"1", "true", "yes"}
PREVIEW_DPI = max(36, min(300, int(os.environ.get("PDF2EPUB_PREVIEW_DPI", 110))))
EXPORT_TIMEOUT = int(os.environ.get("PDF2EPUB_EXPORT_TIMEOUT", 600))
EXPORT_KEEP = max(1, int(os.environ.get("PDF2EPUB_EXPORT_KEEP", 12)))
PYTHON = os.environ.get("PDF2EPUB_PYTHON", sys.executable)
STRUCT_DIR = os.environ.get("PDF2EPUB_STRUCT_DIR", "").strip() or None
VERSION = "pdf2epub-service-1"

DATA.mkdir(parents=True, exist_ok=True)

if not TOKEN and not ALLOW_ANON:
    raise SystemExit(
        "PDF2EPUB_TOKEN is not set. Set it to a shared secret, or set "
        "PDF2EPUB_ALLOW_ANONYMOUS=1 for a loopback-only development run."
    )

app = FastAPI(title="pdf2epub", version=VERSION, docs_url=None, redoc_url=None)

_jobs: "queue.Queue[str]" = queue.Queue()
_lock = threading.Lock()
_current: str | None = None
# The preview's two derived artefacts are the only places this service runs
# anything outside the conversion queue: rastering a source page and
# re-rendering the kept draft. Both are bounded so a preview cannot crowd out
# the converter on a four-core host.
_rasters = threading.Semaphore(2)
_exports = threading.Semaphore(1)


# --------------------------------------------------------------------------- auth


def _authorized(request: Request) -> bool:
    if ALLOW_ANON:
        return True
    presented = ""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        presented = header[7:].strip()
    presented = presented or request.headers.get("x-auth-token", "").strip()
    presented = presented or request.cookies.get("pdf2epub_token", "").strip()
    presented = presented or (request.query_params.get("token") or "").strip()
    return bool(presented) and secrets.compare_digest(presented, TOKEN)


def require_auth(request: Request) -> None:
    if not _authorized(request):
        raise HTTPException(status_code=401, detail="a valid token is required")


# --------------------------------------------------------------------------- jobs


@dataclass
class JobPaths:
    root: Path

    @property
    def state(self) -> Path:
        return self.root / "job.json"

    @property
    def log(self) -> Path:
        return self.root / "run.log"

    @property
    def work(self) -> Path:
        return self.root / "work"


def _job_paths(job_id: str) -> JobPaths:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(status_code=404, detail="no such job")
    root = DATA / job_id
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="no such job")
    return JobPaths(root)


def _read_state(root: Path) -> dict:
    try:
        return json.loads((root / "job.json").read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _write_state(root: Path, state: dict) -> None:
    tmp = root / "job.json.tmp"
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(root / "job.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _page_count(pdf: Path) -> int | None:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf), strict=False).pages)
    except Exception:
        return None


def _scorecard(corpus_report: Path) -> list[dict]:
    """The nine spec-052 reader criteria for this one document."""
    if not corpus_report.is_file():
        return []
    try:
        completed = subprocess.run(
            ["node", str(ADAPTER / "scorecard.mjs"), str(corpus_report)],
            cwd=str(ADAPTER),
            capture_output=True,
            text=True,
            timeout=120,
        )
        scorecard = json.loads(completed.stdout[completed.stdout.index("{") :])
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    verdicts = (scorecard.get("perDocument") or [{}])[0].get("criteria", {})
    return [
        {"id": criterion["id"], "title": criterion["title"], "verdict": verdicts.get(criterion["id"], "n/a")}
        for criterion in scorecard.get("criteria", [])
    ]


def _summarize(report: dict, criteria: list[dict]) -> dict:
    """The few numbers a person actually reads after a conversion."""
    if report.get("code"):
        return {"status": "failed", "code": report["code"], "message": report.get("message", "")}
    completeness = report.get("completeness", {})
    build = report.get("build", {})
    return {
        "status": report.get("readiness", {}).get("status", "unknown"),
        "pageCount": report.get("pageCount"),
        "textCoverage": completeness.get("textCoverage"),
        "figures": [completeness.get("exportedAssetCount"), completeness.get("sourceAssetCount")],
        "tables": [completeness.get("resolvedSemanticTableCount"), completeness.get("expectedSemanticTableCount")],
        "links": [completeness.get("mappedHyperlinkCount"), completeness.get("expectedHyperlinkCount")],
        "notes": [build.get("footnotes_linked", 0), build.get("footnotes", 0)],
        "furnitureLeaks": completeness.get("furnitureContaminationCount"),
        "epubcheckErrors": build.get("epubcheck_errors"),
        "epubcheckAvailable": (build.get("epubcheck") or {}).get("available"),
        "criteria": criteria,
        "seconds": report.get("seconds"),
    }


def _run_job(job_id: str) -> None:
    paths = JobPaths(DATA / job_id)
    state = _read_state(paths.root)
    if not state or state.get("status") not in {"queued"}:
        return
    state.update(status="running", startedAt=_now())
    _write_state(paths.root, state)

    pdf = paths.root / state["storedName"]
    profiles = state["profiles"]
    command = [
        PYTHON,
        str(ADAPTER / "pdf2epub.py"),
        str(pdf),
        "--out",
        str(paths.work),
        "--profiles",
        ",".join(profiles),
        "--workers",
        "1",
    ]
    if STRUCT_DIR:
        command += ["--struct-dir", STRUCT_DIR]
    started = time.time()
    with paths.log.open("w") as log:
        log.write(f"$ {' '.join(command)}\n\n")
        log.flush()
        try:
            completed = subprocess.run(
                command, cwd=str(ADAPTER), stdout=log, stderr=subprocess.STDOUT, timeout=JOB_TIMEOUT
            )
            returncode = completed.returncode
            message = ""
        except subprocess.TimeoutExpired:
            returncode = -1
            message = f"conversion exceeded {JOB_TIMEOUT}s and was stopped"
            log.write(f"\n{message}\n")

    state["seconds"] = round(time.time() - started, 1)
    state["finishedAt"] = _now()

    stem = pdf.stem
    report_path = paths.work / stem / f"{stem}.report.json"
    report = {}
    if report_path.is_file():
        try:
            report = json.loads(report_path.read_text())
        except json.JSONDecodeError:
            report = {}

    files = []
    for profile in profiles:
        name = f"{stem}-{PROFILE_SUFFIX[profile]}.epub"
        candidate = paths.work / stem / name
        if candidate.is_file():
            files.append(
                {
                    "profile": profile,
                    "label": PROFILE_LABEL.get(profile, profile),
                    "name": name,
                    "bytes": candidate.stat().st_size,
                }
            )

    if files and report and not report.get("code"):
        state["status"] = "done"
    else:
        state["status"] = "failed"
        state["message"] = ANSI.sub(
            "", message or report.get("message") or _tail(paths.log, 400) or f"exit {returncode}"
        ).strip()
    state["files"] = files
    state["summary"] = _summarize(report, _scorecard(paths.work / "corpus-report.json")) if report else None
    if state["status"] == "done" and not KEEP_INTERMEDIATES:
        # the page images Docling renders at 2x dominate a job's footprint and
        # nothing downstream reads them once the EPUBs exist
        shutil.rmtree(paths.work / stem / f"{stem}.docling_artifacts", ignore_errors=True)
        (paths.work / stem / f"{stem}.docling.json").unlink(missing_ok=True)
    _write_state(paths.root, state)


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07")


def _tail(path: Path, limit: int) -> str:
    """The converter's log, with the colour codes Docling writes taken out."""
    try:
        return ANSI.sub("", path.read_text(errors="replace"))[-limit:].strip()
    except OSError:
        return ""


def _worker() -> None:
    global _current
    while True:
        job_id = _jobs.get()
        with _lock:
            _current = job_id
        try:
            _run_job(job_id)
        except Exception as error:  # a crash here must not kill the queue
            paths = JobPaths(DATA / job_id)
            state = _read_state(paths.root)
            state.update(status="failed", message=f"{type(error).__name__}: {error}", finishedAt=_now())
            if state:
                _write_state(paths.root, state)
        finally:
            with _lock:
                _current = None
            _jobs.task_done()


def _sweep() -> None:
    """Drop finished jobs (and their PDFs) once they are older than the retention window."""
    while True:
        cutoff = time.time() - RETENTION_HOURS * 3600
        for root in sorted(DATA.iterdir()) if DATA.is_dir() else []:
            if not root.is_dir():
                continue
            state = _read_state(root)
            if state.get("status") in {"queued", "running"}:
                continue
            try:
                if root.stat().st_mtime < cutoff:
                    shutil.rmtree(root, ignore_errors=True)
            except OSError:
                pass
        time.sleep(1800)


def _requeue_orphans() -> None:
    """A restart leaves jobs marked running; put them back in the queue once."""
    for root in sorted(DATA.iterdir()) if DATA.is_dir() else []:
        if not root.is_dir():
            continue
        state = _read_state(root)
        if state.get("status") in {"queued", "running"}:
            state["status"] = "queued"
            _write_state(root, state)
            _jobs.put(root.name)


@app.on_event("startup")
def _startup() -> None:
    _requeue_orphans()
    threading.Thread(target=_worker, daemon=True, name="pdf2epub-worker").start()
    threading.Thread(target=_sweep, daemon=True, name="pdf2epub-sweep").start()


# --------------------------------------------------------------------------- routes


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "version": VERSION,
            "queued": _jobs.qsize(),
            "busy": _current is not None,
            "limits": {"maxBytes": MAX_BYTES, "maxPages": MAX_PAGES, "timeoutSeconds": JOB_TIMEOUT},
        }
    )


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    page = (HERE / "index.html").read_text()
    if not _authorized(request):
        page = (HERE / "login.html").read_text()
    return HTMLResponse(page)


@app.post("/login")
def login(request: Request, token: str = Form("")) -> Response:
    if ALLOW_ANON or (TOKEN and secrets.compare_digest(token.strip(), TOKEN)):
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(
            "pdf2epub_token",
            token.strip(),
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
            max_age=30 * 24 * 3600,
        )
        return response
    return HTMLResponse((HERE / "login.html").read_text().replace("<!--ERROR-->", "That token was not accepted."), status_code=401)


@app.post("/api/jobs", dependencies=[Depends(require_auth)])
async def create_job(file: UploadFile = File(...), profiles: str = Form("paperPro,paperProMove")) -> JSONResponse:
    wanted = [p.strip() for p in profiles.split(",") if p.strip()]
    unknown = [p for p in wanted if p not in PROFILE_SUFFIX]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown profile(s): {', '.join(unknown)}")
    if not wanted:
        raise HTTPException(status_code=400, detail="pick at least one profile")
    if _jobs.qsize() >= QUEUE_LIMIT:
        raise HTTPException(status_code=429, detail="the queue is full; try again shortly")

    job_id = uuid.uuid4().hex
    root = DATA / job_id
    root.mkdir(parents=True)
    stem = _safe_stem(file.filename or "document")
    stored = root / f"{stem}.pdf"

    digest = hashlib.sha256()
    size = 0
    with stored.open("wb") as handle:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_BYTES:
                handle.close()
                shutil.rmtree(root, ignore_errors=True)
                raise HTTPException(status_code=413, detail=f"the PDF is larger than {MAX_BYTES // (1024 * 1024)} MB")
            digest.update(chunk)
            handle.write(chunk)

    if stored.read_bytes()[:5] != b"%PDF-":
        shutil.rmtree(root, ignore_errors=True)
        raise HTTPException(status_code=400, detail="that file does not start with a PDF header")

    pages = _page_count(stored)
    if pages is None:
        shutil.rmtree(root, ignore_errors=True)
        raise HTTPException(status_code=400, detail="the PDF could not be opened")
    if pages > MAX_PAGES:
        shutil.rmtree(root, ignore_errors=True)
        raise HTTPException(status_code=413, detail=f"{pages} pages is over the {MAX_PAGES}-page limit")

    state = {
        "id": job_id,
        "originalName": file.filename,
        "storedName": stored.name,
        "stem": stem,
        "sha256": digest.hexdigest(),
        "bytes": size,
        "pages": pages,
        "profiles": wanted,
        "status": "queued",
        "createdAt": _now(),
    }
    _write_state(root, state)
    _jobs.put(job_id)
    return JSONResponse({"id": job_id, "status": "queued", "position": _jobs.qsize()}, status_code=202)


@app.get("/api/jobs", dependencies=[Depends(require_auth)])
def list_jobs() -> JSONResponse:
    states = []
    for root in DATA.iterdir() if DATA.is_dir() else []:
        if root.is_dir():
            state = _read_state(root)
            if state:
                states.append(state)
    states.sort(key=lambda s: s.get("createdAt", ""), reverse=True)
    return JSONResponse({"jobs": states[:50], "queued": _jobs.qsize(), "busy": _current is not None})


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def get_job(job_id: str) -> JSONResponse:
    paths = _job_paths(job_id)
    state = _read_state(paths.root)
    if not state:
        raise HTTPException(status_code=404, detail="no such job")
    if state.get("status") == "queued":
        state["position"] = _jobs.qsize()
    return JSONResponse(state)


@app.get("/api/jobs/{job_id}/log", dependencies=[Depends(require_auth)])
def get_log(job_id: str) -> Response:
    paths = _job_paths(job_id)
    return Response(_tail(paths.log, 20000) or "(no output yet)", media_type="text/plain")


@app.get("/api/jobs/{job_id}/report", dependencies=[Depends(require_auth)])
def get_report(job_id: str) -> JSONResponse:
    paths = _job_paths(job_id)
    state = _read_state(paths.root)
    stem = state.get("stem", "")
    report = paths.work / stem / f"{stem}.report.json"
    if not report.is_file():
        raise HTTPException(status_code=404, detail="no report yet")
    return JSONResponse(json.loads(report.read_text()))


@app.get("/api/jobs/{job_id}/file/{name}", dependencies=[Depends(require_auth)])
def get_file(job_id: str, name: str) -> FileResponse:
    paths = _job_paths(job_id)
    state = _read_state(paths.root)
    allowed = {entry["name"] for entry in state.get("files", [])}
    if name not in allowed:
        raise HTTPException(status_code=404, detail="no such file")
    path = paths.work / state["stem"] / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such file")
    return FileResponse(path, media_type="application/epub+zip", filename=name)


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def delete_job(job_id: str) -> JSONResponse:
    paths = _job_paths(job_id)
    state = _read_state(paths.root)
    if state.get("status") in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="that job has not finished")
    shutil.rmtree(paths.root, ignore_errors=True)
    return JSONResponse({"deleted": job_id})


# --------------------------------------------------------------------------- preview
#
# Everything under a job directory is derived from a PDF nobody vetted, so the
# three routes that hand those bytes back share one posture:
#
#   - the job id is 32 hex characters and the directory is `DATA / job_id`, so
#     no request-supplied string is ever joined onto a path outside its job;
#   - the only EPUB a job serves is one of the names it recorded in `files`,
#     and entries come out of that archive's own table, not the filesystem;
#   - the response is inert on its own: `nosniff` pins the declared type and
#     `Content-Security-Policy: sandbox` gives a direct navigation an opaque
#     origin with scripting off, so opening EPUB XHTML in a tab cannot reach
#     the token cookie.
#
# The preview page never navigates to these URLs. It fetches them, rewrites the
# markup, and hands the result to a `srcdoc` iframe (see preview.html).

INERT_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
}

EPUB_MEDIA_TYPES = {
    ".xhtml": "application/xhtml+xml",
    ".css": "text/css",
    ".json": "application/json",
    ".xml": "application/xml",
    ".opf": "application/oebps-package+xml",
    ".ncx": "application/x-dtbncx+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".otf": "font/otf",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
ENTRY_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}")
STORED_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
MAX_ENTRY_BYTES = 32 * 1024 * 1024

FONTS = {"default", "serif", "sans"}
TYPOGRAPHY_BOUNDS = {"fontSizePx": (8.0, 40.0), "lineHeight": (1.0, 2.5), "marginEm": (0.0, 6.0)}
TYPOGRAPHY_FLAGS = {"fontSizePx": "--font-size", "lineHeight": "--line-height", "marginEm": "--margin"}


def _finished(paths: JobPaths) -> dict:
    """The state of a job that has something to preview, or a 404.

    A job converted before this page existed wrote none of these routes' needs
    into job.json, so everything is read back off disk and anything missing is
    derived rather than demanded: the stem falls back to the stored file name,
    the stored file name to the stem, the page count to the sealed document.
    """
    state = _read_state(paths.root)
    if not state or state.get("status") != "done":
        raise HTTPException(status_code=404, detail="no finished job")
    stem = state.get("stem") or Path(state.get("storedName") or "").stem
    if not STORED_NAME.fullmatch(stem):
        raise HTTPException(status_code=404, detail="no finished job")
    return {**state, "stem": stem}


def _page_total(paths: JobPaths, state: dict) -> int:
    """How many pages the source has, from job.json or from the sealed document."""
    recorded = state.get("pages")
    if isinstance(recorded, int) and recorded > 0:
        return recorded
    sealed = _sealed_document(paths, state)
    pages = [page.get("page") for page in sealed.get("pages", []) if isinstance(page.get("page"), int)]
    return max(pages) if pages else 0


def _sealed_document(paths: JobPaths, state: dict) -> dict:
    document = _in_job(paths.root, "work", state["stem"], "struct.json")
    if not document.is_file():
        return {}
    try:
        return json.loads(document.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _in_job(root: Path, *parts: str) -> Path:
    """Join under a job root and refuse anything that escapes it."""
    candidate = (root / Path(*parts)).resolve()
    if candidate != root.resolve() and root.resolve() not in candidate.parents:
        raise HTTPException(status_code=404, detail="no such file")
    return candidate


def _stored_pdf(paths: JobPaths, state: dict) -> Path:
    name = state.get("storedName") or f"{state['stem']}.pdf"
    if not STORED_NAME.fullmatch(name) or not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=404, detail="no source PDF")
    pdf = _in_job(paths.root, name)
    if not pdf.is_file():
        raise HTTPException(status_code=404, detail="no source PDF")
    return pdf


def _profile_epub(paths: JobPaths, state: dict, profile: str) -> Path:
    """The EPUB a job listed for one profile — the same allowlist /file/ uses."""
    recorded = [entry.get("name") for entry in state.get("files", []) if isinstance(entry, dict)]
    expected = f"{state['stem']}-{PROFILE_SUFFIX.get(profile, profile)}.epub"
    name = next(
        (entry.get("name") for entry in state.get("files", []) if isinstance(entry, dict) and entry.get("profile") == profile),
        expected if expected in recorded else None,
    )
    if not name or not STORED_NAME.fullmatch(name) or not name.endswith(".epub"):
        raise HTTPException(status_code=404, detail="no such profile")
    archive = _in_job(paths.root, "work", state["stem"], name)
    if not archive.is_file():
        raise HTTPException(status_code=404, detail="no such profile")
    return archive


@app.get("/jobs/{job_id}/preview", response_class=HTMLResponse)
def preview(request: Request, job_id: str) -> HTMLResponse:
    """The side-by-side page. Auth is checked before the job is looked up, so an
    unauthenticated request cannot learn which job ids exist."""
    if not _authorized(request):
        return HTMLResponse((HERE / "login.html").read_text(), status_code=401)
    _finished(_job_paths(job_id))
    return HTMLResponse(
        (HERE / "preview.html").read_text(),
        headers={
            "Content-Security-Policy": (
                "default-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; "
                "script-src 'unsafe-inline'; connect-src 'self'; font-src blob:; "
                "frame-src 'self'; base-uri 'none'; form-action 'none'"
            ),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        },
    )


@app.get("/api/jobs/{job_id}/source.pdf", dependencies=[Depends(require_auth)])
def get_source_pdf(job_id: str) -> FileResponse:
    """The uploaded PDF, inline, so the preview can link to the real thing."""
    paths = _job_paths(job_id)
    pdf = _stored_pdf(paths, _finished(paths))
    return FileResponse(
        pdf,
        media_type="application/pdf",
        headers={**INERT_HEADERS, "Content-Disposition": f'inline; filename="{pdf.name}"'},
    )


@app.get("/api/jobs/{job_id}/page/{number}.png", dependencies=[Depends(require_auth)])
def get_page_image(job_id: str, number: int) -> FileResponse:
    """One source page, rastered by poppler and kept beside the job.

    The PDF pane shows images rather than running a PDF engine in the reviewer's
    browser: the bytes that reach the page are then a PNG this host produced,
    not an attacker's PDF parsed at the preview's own origin.
    """
    paths = _job_paths(job_id)
    state = _finished(paths)
    pages = _page_total(paths, state)
    if number < 1 or (pages and number > pages) or number > MAX_PAGES:
        raise HTTPException(status_code=404, detail="no such page")
    pdf = _stored_pdf(paths, state)
    target = paths.root / "preview-pages" / f"page-{number:04d}.png"
    if target.is_file():
        return FileResponse(target, media_type="image/png", headers=INERT_HEADERS)
    with _rasters:
        if target.is_file():
            return FileResponse(target, media_type="image/png", headers=INERT_HEADERS)
        return Response(_raster_page(pdf, number, target), media_type="image/png", headers=INERT_HEADERS)


def _raster_page(pdf: Path, number: int, target: Path) -> bytes:
    """Render one page and keep it beside the job when the job directory takes it.

    The cache is an addition to a job, never a change to one: if it cannot be
    written — a read-only data directory, a full disk — the page is still served
    and only the next request pays for it again.
    """
    scratch = Path(tempfile.mkdtemp(prefix="pdf2epub-page-"))
    try:
        prefix = scratch / "page"
        try:
            completed = subprocess.run(
                ["pdftoppm", "-png", "-r", str(PREVIEW_DPI), "-f", str(number), "-l", str(number),
                 "-singlefile", str(pdf), str(prefix)],
                capture_output=True, timeout=180,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise HTTPException(status_code=503, detail="page rendering is unavailable") from error
        rendered = prefix.with_suffix(".png")
        if completed.returncode != 0 or not rendered.is_file():
            raise HTTPException(status_code=502, detail="that page could not be rendered")
        payload = rendered.read_bytes()
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            rendered.replace(target)
        except OSError:
            pass
        return payload
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


@app.get("/api/jobs/{job_id}/blocks", dependencies=[Depends(require_auth)])
def get_blocks(job_id: str) -> JSONResponse:
    """Block id -> source page and evidence boxes, which is all the sync needs.

    The ids are the ones already in the EPUB's `data-struct-id`; nothing here
    invents or renumbers them.
    """
    paths = _job_paths(job_id)
    state = _finished(paths)
    sealed = _sealed_document(paths, state)
    if not sealed:
        raise HTTPException(status_code=404, detail="no struct document")
    blocks = [
        {
            "id": block.get("id"),
            "kind": block.get("kind"),
            "page": block.get("page"),
            "text": (block.get("text") or "")[:160],
            "boxes": [
                {key: box.get(key) for key in ("page", "x", "y", "width", "height")}
                for box in (block.get("evidence", {}).get("boxes") or [])
            ],
        }
        for block in sealed.get("blocks", [])
    ]
    pages = [
        {"page": page.get("page"), "width": page.get("width"), "height": page.get("height")}
        for page in sealed.get("pages", [])
    ]
    return JSONResponse({"pageCount": _page_total(paths, state), "pages": pages, "blocks": blocks})


@app.get("/api/jobs/{job_id}/epub/{profile}/{entry:path}", dependencies=[Depends(require_auth)])
def get_epub_entry(job_id: str, profile: str, entry: str) -> Response:
    """One entry out of one of this job's own EPUBs, by its name in the archive."""
    paths = _job_paths(job_id)
    state = _finished(paths)
    if profile not in PROFILE_SUFFIX:
        raise HTTPException(status_code=404, detail="no such profile")
    if not ENTRY_NAME.fullmatch(entry) or ".." in entry.split("/"):
        raise HTTPException(status_code=404, detail="no such entry")
    media_type = EPUB_MEDIA_TYPES.get(Path(entry).suffix.lower())
    if media_type is None:
        raise HTTPException(status_code=404, detail="no such entry")
    archive = _profile_epub(paths, state, profile)
    try:
        with zipfile.ZipFile(archive) as bundle:
            try:
                info = bundle.getinfo(f"EPUB/{entry}")
            except KeyError:
                raise HTTPException(status_code=404, detail="no such entry") from None
            if info.file_size > MAX_ENTRY_BYTES:
                raise HTTPException(status_code=413, detail="that entry is too large to serve")
            payload = bundle.read(info)
    except (OSError, zipfile.BadZipFile) as error:
        raise HTTPException(status_code=404, detail="no such entry") from error
    return Response(payload, media_type=media_type, headers=INERT_HEADERS)


def _typography_arguments(raw: object) -> tuple[list[str], dict]:
    """Turn a requested typography into render.mjs flags, or refuse it.

    Nothing from the request reaches a stylesheet as text: the font is a name
    from a fixed set, and the three numbers are bounded. render.mjs enforces
    the same rules again on its own side.
    """
    if raw is None:
        return [], {}
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="typography must be an object")
    flags: list[str] = []
    echo: dict = {}
    font = raw.get("font")
    if font not in (None, ""):
        if font not in FONTS:
            raise HTTPException(status_code=400, detail=f"font must be one of {', '.join(sorted(FONTS))}")
        flags += ["--font", font]
        echo["font"] = font
    for key, flag in TYPOGRAPHY_FLAGS.items():
        value = raw.get(key)
        if value is None or value == "":
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise HTTPException(status_code=400, detail=f"{key} must be a number")
        low, high = TYPOGRAPHY_BOUNDS[key]
        if not low <= float(value) <= high:
            raise HTTPException(status_code=400, detail=f"{key} must be between {low} and {high}")
        rounded = round(float(value), 2)
        flags += [flag, f"{rounded:g}"]
        echo[key] = rounded
    return flags, echo


def _epubcheck(epub: Path) -> dict:
    """EPUBCheck through the adapter's own helper, so an exported EPUB is judged
    by exactly the counter the conversion report quotes."""
    if str(ADAPTER) not in sys.path:
        sys.path.insert(0, str(ADAPTER))
    from evaluate import epubcheck

    return epubcheck(epub)


def _prune_exports(exports: Path, keep: int) -> None:
    try:
        directories = sorted((d for d in exports.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime)
    except OSError:
        return
    for stale in directories[: max(0, len(directories) - keep)]:
        shutil.rmtree(stale, ignore_errors=True)


@app.post("/api/jobs/{job_id}/export", dependencies=[Depends(require_auth)])
def create_export(job_id: str, body: dict = Body(default={})) -> JSONResponse:
    """Re-render the kept draft with the chosen typography, then EPUBCheck it.

    Only render.mjs runs: extraction is never repeated, and the draft on disk is
    read, never rewritten.
    """
    paths = _job_paths(job_id)
    state = _finished(paths)
    profile = body.get("profile") or (state.get("profiles") or ["paperPro"])[0]
    if profile not in PROFILE_SUFFIX:
        raise HTTPException(status_code=400, detail=f"unknown profile {profile}")
    flags, echo = _typography_arguments(body.get("typography"))
    stem = state["stem"]
    draft = _in_job(paths.root, "work", stem, f"{stem}.struct-draft.json")
    if not draft.is_file():
        raise HTTPException(status_code=409, detail="this job kept no draft to re-render")
    if not _exports.acquire(timeout=1.0):
        raise HTTPException(status_code=429, detail="another export is running; try again shortly")
    try:
        export_id = uuid.uuid4().hex
        out = paths.root / "exports" / export_id
        out.mkdir(parents=True)
        command = ["node", str(ADAPTER / "render.mjs"), str(draft), "--out", str(out), "--profiles", profile, *flags]
        if STRUCT_DIR:
            command += ["--struct-dir", STRUCT_DIR]
        try:
            rendered = subprocess.run(command, capture_output=True, text=True, timeout=EXPORT_TIMEOUT)
        except (OSError, subprocess.SubprocessError) as error:
            shutil.rmtree(out, ignore_errors=True)
            raise HTTPException(status_code=502, detail=f"the renderer could not run: {type(error).__name__}") from error
        name = f"{stem}-{PROFILE_SUFFIX[profile]}.epub"
        epub = out / name
        if rendered.returncode != 0 or not epub.is_file():
            message = ANSI.sub("", (rendered.stdout + rendered.stderr)[-400:]).strip()
            shutil.rmtree(out, ignore_errors=True)
            raise HTTPException(status_code=502, detail=message or "the renderer produced no EPUB")
        for leftover in out.iterdir():
            if leftover != epub and leftover.is_file():
                leftover.unlink(missing_ok=True)
        check = _epubcheck(epub)
        _prune_exports(paths.root / "exports", EXPORT_KEEP)
        return JSONResponse(
            {
                "id": export_id,
                "profile": profile,
                "name": name,
                "bytes": epub.stat().st_size,
                "typography": echo,
                "epubcheck": check,
                "url": f"/api/jobs/{job_id}/export/{export_id}",
            },
            status_code=201,
        )
    finally:
        _exports.release()


@app.get("/api/jobs/{job_id}/export/{export_id}", dependencies=[Depends(require_auth)])
def get_export(job_id: str, export_id: str) -> FileResponse:
    paths = _job_paths(job_id)
    state = _finished(paths)
    if not re.fullmatch(r"[0-9a-f]{32}", export_id):
        raise HTTPException(status_code=404, detail="no such export")
    directory = _in_job(paths.root, "exports", export_id)
    candidates = sorted(directory.glob("*.epub")) if directory.is_dir() else []
    if not candidates:
        raise HTTPException(status_code=404, detail="no such export")
    return FileResponse(
        candidates[0],
        media_type="application/epub+zip",
        filename=candidates[0].name,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"},
    )


def _safe_stem(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")
    return (stem or "document")[:80]
