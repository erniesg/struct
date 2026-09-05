#!/usr/bin/env python
"""Derive a strata manifest for a corpus, in the shape `scorecard.mjs --strata`
expects, from the PDFs themselves.

Layout, source and kind are read from the file, never typed in, so a hold-out
corpus can be stratified the same way the tuning corpus was without anybody
deciding which lane a paper belongs in.

  layout  one-column | two-column   from the width of a typical text line
  source  latex | publisher | word-processor | scan-or-print | other
                                    from the PDF's own Producer/Creator
  kind    born-digital | scanned    from whether pages carry a text layer

  python strata.py <dir-or-pdf>... --out strata.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pdf_links import page_layout_lines  # noqa: E402

LATEX = ("pdftex", "pdflatex", "xetex", "luatex", "tex", "dvips", "textures")
PUBLISHER = ("springer", "elsevier", "acrobat distiller", "arbortext", "3b2", "prince",
             "ieee", "atypon", "sciencedirect", "wiley", "nature")
WORD = ("microsoft word", "libreoffice", "openoffice", "pages", "quark", "indesign")
SCAN = ("scanner", "abbyy", "imagemagick", "ghostscript")


def _producer(pdf: Path) -> str:
    try:
        from pypdf import PdfReader

        info = PdfReader(str(pdf), strict=False).metadata or {}
        return " ".join(str(v) for v in (info.get("/Producer"), info.get("/Creator")) if v).lower()
    except Exception:
        return ""


def _source(producer: str) -> str:
    for names, label in ((LATEX, "latex"), (PUBLISHER, "publisher"), (WORD, "word-processor"), (SCAN, "scan-or-print")):
        if any(name in producer for name in names):
            return label
    return "other"


def _layout(pdf: Path) -> tuple[str, int, bool]:
    """Two-column when a typical text line spans less than 55 % of the page.

    Word-box centres do not separate the two layouts — words are spread across
    the whole line either way. Line width does: over the 80-paper corpus this
    threshold agrees with the hand-labelled manifest on 75 of the 78 documents
    that have a text layer.
    """
    pages = page_layout_lines(pdf)
    if not pages:
        return "one-column", 0, False
    fractions: list[float] = []
    for page in pages[1 : min(len(pages) - 1, 12) or 1]:
        width = float(page.get("width") or 612) or 612
        widths = [
            (line["xmax"] - line["xmin"]) / width
            for line in (page.get("lines") or [])
            if len((line.get("text") or "").split()) >= 6
        ]
        if len(widths) >= 8:
            fractions.append(statistics.median(widths))
    if not fractions:
        return "one-column", len(pages), False
    return ("two-column" if statistics.median(fractions) < 0.55 else "one-column"), len(pages), True


def describe(pdf: Path) -> dict:
    producer = _producer(pdf)
    layout, pages, has_text = _layout(pdf)
    source = _source(producer)
    if not has_text:
        source = "scan-or-print"  # a scan's producer string describes the scanner, not the paper
    return {
        "layout": layout,
        "source": source,
        "kind": "born-digital" if has_text else "scanned",
        "pages": pages,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    pdfs: list[Path] = []
    for raw in args.inputs:
        path = Path(raw)
        pdfs.extend(sorted(p for p in path.iterdir() if p.suffix.lower() == ".pdf") if path.is_dir() else [path])

    documents = {}
    for pdf in pdfs:
        documents[pdf.name] = describe(pdf)
        print(f"{pdf.name:34} {documents[pdf.name]}", flush=True)

    Path(args.out).write_text(json.dumps(
        {"schemaVersion": "pdf-corpus-strata-1.0.0",
         "privacy": "basenames-and-lane-labels-only",
         "documents": documents}, indent=1))
    print(f"\nwrote {len(documents)} documents to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
