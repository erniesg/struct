#!/usr/bin/env python
"""PDF -> StructDocument (Docling adapter) -> EPUB (rendered by @erniesg/struct).

Usage:
  python pdf2epub.py <pdf>... --out <dir> [--profiles paperPro,paperProMove,mobile]
                     [--formula] [--reuse-json] [--no-epubcheck] [--workers N]
                     [--struct-dir <erniesg/struct checkout>]

Per PDF (under <dir>/<stem>/):
  <stem>.docling.json         Docling document (referenced images)
  <stem>.struct-draft.json    StructDocument draft from the adapter
  struct.json                 sealed, codec-validated StructDocument
  content.xhtml               struct's XHTML rendition
  <stem>-<profile>.epub       struct's EPUB per device profile
  <stem>.report.json          adapter + render + evaluation report
and <dir>/corpus-report.json in the corpus-audit document shape for
`tools/pdf-success-scorecard.mjs`.

Runs locally; nothing leaves the machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from evaluate import epubcheck, evaluate  # noqa: E402
from pdf_links import attach_words, extract_links, page_layout_lines, page_text_lines, word_boxes  # noqa: E402
from pdf_text import SourceText  # noqa: E402
from source_raster import SourceRaster, SourceRasterError  # noqa: E402
from verify_outputs import check_cache, check_source_binding, iter_uris, required_metrics, reuse_cache_problems, sha256  # noqa: E402

PROFILE_SUFFIX = {"paperPro": "paperpro", "paperProMove": "papermove", "mobile": "mobile"}


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=1) + "\n")
    temporary.replace(path)


def write_reuse_manifests(out_root: Path, pdfs: list[Path], documents: list[dict]) -> None:
    """Bind fresh cache bytes and every referenced image for a later replay."""
    paths = [out_root / "source-report.json", out_root / "cache-manifest.json"]
    # Invalidate stale evidence before fresh cache validation or publication.
    for path in paths:
        path.unlink(missing_ok=True)
    by_name = {pdf.name: pdf for pdf in pdfs}
    source_docs = []
    cache_docs = []
    problems = []
    for document in documents:
        pdf = by_name[document["basename"]]
        source_docs.append(document)
        stem = pdf.stem
        cache = out_root / stem / f"{stem}.docling.json"
        cache_json = json.loads(cache.read_text())
        assets = {}
        for uri in iter_uris(cache_json):
            if uri.startswith("data:") or uri.startswith("file://"):
                raise ValueError("fresh cache has unsupported image URI scheme")
            target = Path(uri)
            if not target.is_absolute():
                target = cache.parent / target
            target = target.resolve()
            if not target.is_file():
                raise ValueError(f"fresh cache image is missing: {uri}")
            assets[str(target)] = {"path": str(target), "sha256": sha256(target)}
        entry = {"basename": pdf.name, "sha256": document["sha256"], "byteLength": document["byteLength"],
                 "sourcePath": str(pdf.absolute()), "cache": {"path": str(cache.relative_to(out_root)),
                 "originalSha256": sha256(cache), "relocatedSha256": sha256(cache)}, "assets": list(assets.values())}
        check_source_binding(document, entry, [], f"fresh/{stem}", problems, pdf)
        required_metrics(document, f"fresh/{stem}", problems)
        check_cache(out_root, "fresh", document, entry, problems)
        cache_docs.append(entry)
    if not documents or len(documents) != len(pdfs) or problems:
        raise ValueError("; ".join(problems) or "fresh manifest document set is incomplete")
    try:
        atomic_json(paths[0], {"schemaVersion": "pdf-source-report-1", "documents": source_docs})
        atomic_json(paths[1], {"schemaVersion": "pdf-cache-manifest-1", "documents": cache_docs})
    except BaseException:
        for path in paths:
            path.unlink(missing_ok=True)
            path.with_name(path.name + ".tmp").unlink(missing_ok=True)
        raise


def convert(pdf: Path, out_dir: Path, formula: bool, reuse_json: bool):
    from docling_core.types.doc import DoclingDocument, ImageRefMode

    json_path = out_dir / f"{pdf.stem}.docling.json"
    if reuse_json and json_path.exists():
        failures = reuse_cache_problems(out_dir.parent, pdf, json_path)
        if failures:
            raise ValueError("; ".join(failures))
        return DoclingDocument.load_from_json(json_path), 0.0
    if reuse_json:
        raise ValueError(f"{pdf.name}: cache file is missing")

    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.generate_picture_images = True
    options.generate_page_images = True
    options.images_scale = 2.0
    options.heading_hierarchy_options.enabled = True
    options.do_formula_enrichment = formula
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    started = time.time()
    document = converter.convert(str(pdf)).document
    elapsed = time.time() - started
    document.save_as_json(json_path, image_mode=ImageRefMode.REFERENCED)
    return document, elapsed


def process(pdf: Path, out_root: Path, profiles: list[str], formula: bool, reuse_json: bool, run_epubcheck: bool, struct_dir: str | None) -> dict:
    """All source consumers share one private snapshot, including evaluation."""
    identity = lambda path: (path.stat().st_dev, path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns, path.stat().st_ctime_ns)
    try:
        original_identity = identity(pdf)
        with SourceRaster(pdf) as source_raster:
            snapshot = source_raster.snapshot_path
            sha = source_raster.source_sha256
            byte_length = snapshot.stat().st_size
            document = _process_snapshot(snapshot, out_root, profiles, formula, reuse_json, run_epubcheck, struct_dir, source_raster)
            if identity(pdf) != original_identity or sha256(pdf) != sha:
                document = {"basename": pdf.name, "sha256": sha, "byteLength": byte_length, "code": "SOURCE_CHANGED", "message": "input PDF changed during processing", "pipeline": "docling-struct-v1"}
            elif document.get("sha256") != sha or document.get("byteLength", byte_length) != byte_length:
                document = {"basename": pdf.name, "sha256": sha, "byteLength": byte_length, "code": "SOURCE_CHANGED", "message": "source consumer binding mismatch", "pipeline": "docling-struct-v1"}
            document["byteLength"] = byte_length
    except (SourceRasterError, OSError) as error:
        document = {"basename": pdf.name, "code": "SOURCE_RASTER_FAILED", "message": str(error)[:600], "pipeline": "docling-struct-v1"}
    out_dir = out_root / pdf.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(out_dir / f"{pdf.stem}.report.json", document)
    return document


def _process_snapshot(pdf: Path, out_root: Path, profiles: list[str], formula: bool, reuse_json: bool, run_epubcheck: bool, struct_dir: str | None, source_raster: SourceRaster) -> dict:
    from pdf2struct import to_struct_draft

    out_dir = out_root / pdf.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    try:
        doc, convert_seconds = convert(pdf, out_dir, formula, reuse_json)
    except Exception as error:
        return {"basename": pdf.name, "sha256": sha, "code": "AUDIT_FAILED", "message": f"docling conversion failed: {type(error).__name__}", "pipeline": "docling-struct-v1"}
    links, sizes = extract_links(pdf)
    boxes = word_boxes(pdf)
    attach_words(links, boxes, sizes)
    try:
        source_text = SourceText(pdf)
        try:
            draft, adapter = to_struct_draft(doc, pdf, sha, links, boxes, page_text_lines(pdf), source_text, page_layout_lines(pdf), source_raster)
        finally:
            source_text.close()
    except SourceRasterError as error:
        return {"basename": pdf.name, "sha256": sha, "code": "SOURCE_RASTER_FAILED", "message": str(error)[:600], "pipeline": "docling-struct-v1"}
    draft_path = out_dir / f"{pdf.stem}.struct-draft.json"
    draft_path.write_text(json.dumps(draft, ensure_ascii=False))
    command = ["node", str(HERE / "render.mjs"), str(draft_path), "--out", str(out_dir), "--profiles", ",".join(profiles)]
    if struct_dir:
        command += ["--struct-dir", struct_dir]
    rendered = subprocess.run(command, capture_output=True, text=True)
    try:
        render_report = json.loads(rendered.stdout.strip().splitlines()[-1]) if rendered.stdout.strip() else {"errors": [{"stage": "render", "message": rendered.stderr[-800:]}], "profiles": []}
    except json.JSONDecodeError:
        render_report = {"errors": [{"stage": "render", "message": (rendered.stdout + rendered.stderr)[-800:]}], "profiles": []}
    render_report["returncode"] = rendered.returncode
    (out_dir / "render-report.json").write_text(json.dumps(render_report, indent=1))
    build_report = asdict(adapter)
    build_report["convert_seconds"] = round(convert_seconds, 1)
    build_report["render"] = render_report
    build_report["struct_ready"] = draft["recovery"]["status"] == "ready"
    profile_ids = [p.get("id") for p in render_report.get("profiles", []) if isinstance(p, dict)]
    primary = next((p for p in render_report.get("profiles", []) if p.get("id") == profiles[0]), None)
    expected_files = {profile: f"{pdf.stem}-{PROFILE_SUFFIX[profile]}.epub" for profile in profiles}
    safe_profiles = all(profile.get("fileName") == expected_files.get(profile.get("id")) and (out_dir / profile["fileName"]).resolve().parent == out_dir.resolve() for profile in render_report.get("profiles", []) if isinstance(profile, dict))
    if rendered.returncode != 0 or render_report.get("errors") or primary is None or set(profile_ids) != set(profiles) or len(profile_ids) != len(profiles) or not safe_profiles:
        document = {
            "basename": pdf.name,
            "sha256": sha,
            "byteLength": pdf.stat().st_size,
            "pageCount": len(doc.pages),
            "pipeline": "docling-struct-v1",
            "code": "STRUCT_RENDER_REFUSED",
            "message": "; ".join(f"{e.get('stage')}: {e.get('message')}" for e in render_report.get("errors", []))[:600] or "renderer returned incomplete profiles or a nonzero status",
            "build": build_report,
        }
        return document
    epub_path = out_dir / primary["fileName"]
    if run_epubcheck:
        checks = {profile["id"]: epubcheck(out_dir / profile["fileName"]) for profile in render_report["profiles"]}
        build_report["epubcheck"] = checks[profiles[0]]
        build_report["epubchecks"] = checks
        build_report["epubcheck_errors"] = sum(check.get("errors") or 0 for check in checks.values())
        if any(not check.get("available") or check.get("returncode") != 0 for check in checks.values()):
            document = {"basename": pdf.name, "sha256": sha, "byteLength": pdf.stat().st_size, "pageCount": len(doc.pages), "pipeline": "docling-struct-v1", "code": "EPUBCHECK_FAILED", "message": "EPUBCheck was unavailable or rejected an output", "build": build_report}
            return document
    document = evaluate(pdf, epub_path, build_report, draft_path)
    document["pipeline"] = "docling-struct-v1"
    document["seconds"] = round(time.time() - started, 1)
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdfs", nargs="+")
    parser.add_argument("--out", required=True)
    parser.add_argument("--profiles", default="paperPro,paperProMove,mobile")
    parser.add_argument("--formula", action="store_true", help="enable Docling formula enrichment (slower)")
    parser.add_argument("--reuse-json", action="store_true", help="reuse an existing Docling JSON instead of re-extracting")
    parser.add_argument("--no-epubcheck", action="store_true")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--struct-dir", default=None)
    args = parser.parse_args()

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not profiles:
        parser.error("at least one profile is required")
    if len(profiles) != len(set(profiles)):
        parser.error("duplicate profiles are not allowed")
    unknown = [p for p in profiles if p not in PROFILE_SUFFIX]
    if unknown:
        parser.error(f"unknown profile(s): {', '.join(unknown)}")
    pdfs: list[Path] = []
    for raw in args.pdfs:
        path = Path(raw)
        if path.is_dir():
            pdfs.extend(sorted(p for p in path.iterdir() if p.suffix.lower() == ".pdf"))
        else:
            pdfs.append(path)
    stems = [pdf.stem for pdf in pdfs]
    if len(stems) != len(set(stems)):
        parser.error("duplicate PDF stems would overwrite output directories")
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    if not args.reuse_json:
        for name in ("source-report.json", "cache-manifest.json"):
            (out_root / name).unlink(missing_ok=True)

    documents = []
    if args.workers > 1:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(process, pdf, out_root, profiles, args.formula, args.reuse_json, not args.no_epubcheck, args.struct_dir): pdf for pdf in pdfs}
            for future in as_completed(futures):
                document = future.result()
                documents.append(document)
                _print_line(document)
    else:
        for pdf in pdfs:
            document = process(pdf, out_root, profiles, args.formula, args.reuse_json, not args.no_epubcheck, args.struct_dir)
            documents.append(document)
            _print_line(document)
    documents.sort(key=lambda d: d["basename"])
    corpus = {"schemaVersion": "docling-struct-report-1.0.0", "privacy": "basenames-hashes-counts-diagnostic-codes-only", "documents": documents}
    (out_root / "corpus-report.json").write_text(json.dumps(corpus, indent=1))
    if any(document.get("code") for document in documents):
        return 1
    if not args.reuse_json:
        try:
            write_reuse_manifests(out_root, pdfs, documents)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"FAIL manifest generation: {type(error).__name__}: {error}", file=sys.stderr)
            return 1
    return 0


def _print_line(document: dict) -> None:
    if document.get("code"):
        print(f"FAIL {document['basename']:40} {document['code']} {document.get('message', '')[:160]}", flush=True)
        return
    completeness = document["completeness"]
    build = document["build"]
    print(
        f"{document['readiness']['status']:16} {document['basename']:40} "
        f"cov={completeness['textCoverage']:.3f} figs={completeness['exportedAssetCount']}/{completeness['sourceAssetCount']} "
        f"tables={completeness['resolvedSemanticTableCount']}/{completeness['expectedSemanticTableCount']} "
        f"links={completeness['mappedHyperlinkCount']}/{completeness['expectedHyperlinkCount']} "
        f"notes={build.get('footnotes_linked', 0)}/{build.get('footnotes', 0)} "
        f"furniture={completeness['furnitureContaminationCount']} epubcheck={build.get('epubcheck_errors')} "
        f"{document.get('seconds')}s",
        flush=True,
    )


if __name__ == "__main__":
    raise SystemExit(main())
