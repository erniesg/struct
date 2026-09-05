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

PROFILE_SUFFIX = {"paperPro": "paperpro", "paperProMove": "papermove", "mobile": "mobile"}


def convert(pdf: Path, out_dir: Path, formula: bool, reuse_json: bool):
    from docling_core.types.doc import DoclingDocument, ImageRefMode

    json_path = out_dir / f"{pdf.stem}.docling.json"
    if reuse_json and json_path.exists():
        return DoclingDocument.load_from_json(json_path), 0.0

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
    source_text = SourceText(pdf)
    draft, adapter = to_struct_draft(doc, pdf, sha, links, boxes, page_text_lines(pdf), source_text, page_layout_lines(pdf))
    source_text.close()
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
    build_report = asdict(adapter)
    build_report["convert_seconds"] = round(convert_seconds, 1)
    build_report["render"] = render_report
    build_report["struct_ready"] = draft["recovery"]["status"] == "ready"
    primary = next((p for p in render_report.get("profiles", []) if p["id"] == profiles[0]), None)
    if primary is None:
        document = {
            "basename": pdf.name,
            "sha256": sha,
            "byteLength": pdf.stat().st_size,
            "pageCount": len(doc.pages),
            "pipeline": "docling-struct-v1",
            "code": "STRUCT_RENDER_REFUSED",
            "message": "; ".join(f"{e.get('stage')}: {e.get('message')}" for e in render_report.get("errors", []))[:600],
            "build": build_report,
        }
        (out_dir / f"{pdf.stem}.report.json").write_text(json.dumps(document, indent=1))
        return document
    epub_path = out_dir / primary["fileName"]
    if run_epubcheck:
        check = epubcheck(epub_path)
        build_report["epubcheck"] = check
        build_report["epubcheck_errors"] = check.get("errors") or 0
    document = evaluate(pdf, epub_path, build_report, draft_path)
    document["pipeline"] = "docling-struct-v1"
    document["seconds"] = round(time.time() - started, 1)
    (out_dir / f"{pdf.stem}.report.json").write_text(json.dumps(document, indent=1))
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
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

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
