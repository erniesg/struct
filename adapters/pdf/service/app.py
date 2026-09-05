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
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
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


def _safe_stem(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")
    return (stem or "document")[:80]
