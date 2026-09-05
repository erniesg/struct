#!/usr/bin/env python
"""Does this PDF's own text layer carry page furniture at all?

The spec-052 furniture criterion guards against a pipeline that passes by
silence: a multi-page document must have *accounted* furniture, or it fails.
That guard misreads a paper which simply has no running heads and no page
numbers — there is nothing to account for, and the document is marked down for
the absence of something it never had.

This module answers the prior question from the source, never from the adapter's
output: read the top and bottom edge bands of every page and report whether any
line repeats across pages, or whether the edge carries a bare page number. A
document where both are absent has no furniture to account for, and the
criterion should read `n/a` rather than `fail`.

  python source_furniture.py paper.pdf [paper.pdf ...]
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pdf_links import page_layout_lines  # noqa: E402

BAND = 0.12  # fraction of page height counted as an edge band
DIGITS = re.compile(r"^[\[\(]?(?:page\s*)?[ivxlcdm]{0,7}\d{0,4}[\]\)\.]?$", re.I)
NUMBERISH = re.compile(r"\d")


def _normalize(text: str) -> str:
    """Fold the parts of a running head that legitimately change per page."""
    folded = re.sub(r"\d+", "#", " ".join(text.split()).lower())
    return re.sub(r"[^a-z#]+", " ", folded).strip()


def source_furniture(pdf: Path) -> dict:
    pages = page_layout_lines(pdf)
    if len(pages) < 3:
        return {"pages": len(pages), "repeatedEdgeLines": 0, "edgeNumberPages": 0, "hasFurniture": None}

    edge_lines: list[tuple[int, str]] = []
    number_pages: set[int] = set()
    for index, page in enumerate(pages):
        height = float(page.get("height") or 792) or 792
        for line in page.get("lines") or []:
            text = " ".join((line.get("text") or "").split())
            if not text:
                continue
            top = float(line.get("ymin", 0) or 0)
            bottom = float(line.get("ymax", top) or top)
            if top > height * BAND and bottom < height * (1 - BAND):
                continue  # not in an edge band
            edge_lines.append((index, _normalize(text)))
            stripped = text.strip()
            if DIGITS.fullmatch(stripped) and NUMBERISH.search(stripped):
                number_pages.add(index)

    counts = Counter()
    for index, text in {(i, t) for i, t in edge_lines if len(t) >= 3}:
        counts[text] += 1
    repeated = sum(1 for text, pages_seen in counts.items() if pages_seen >= 3)

    return {
        "pages": len(pages),
        "repeatedEdgeLines": repeated,
        "edgeNumberPages": len(number_pages),
        # three pages carrying the same edge line, or three pages numbered at the edge
        "hasFurniture": bool(repeated or len(number_pages) >= 3),
    }


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    for raw in argv:
        path = Path(raw)
        print(json.dumps({"pdf": path.name, **source_furniture(path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
