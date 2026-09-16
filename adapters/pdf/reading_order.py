#!/usr/bin/env python
"""Compare the layout model's block order against the PDF text layer's.

The adapter prints blocks in the order Docling's layout model returned them.
Where that order is wrong the reader sees a paragraph out of place, and the
pipeline notices only when the break happens to fall mid-sentence (the
lowercase-join counter). This module is the missing sensor: an independent
opinion on the order of the same page, taken from poppler's text layer
(`pdftotext -bbox-layout`, read through `pdf_links.page_layout_lines`), and a
second one taken from the geometry of the boxes alone.

Nothing here decides who is right. `rules_reading_order.py` does that, and only
where both opinions agree against the layout model.

Vocabulary, per page:

  rank         a block's place in the text layer: the lowest index among the
               text-layer lines that fall inside its boxes — where the text
               layer first reaches it.
  coverage     the fraction of body blocks that matched at least one line.
               Below it the comparison is not evidence of anything.
  inversions   pairs of body blocks the two orders disagree about.
  displacement how far a block would move, in block positions, to agree with
               the text layer. Local jitter is 1; a paragraph belonging in the
               other column is the length of a column.
"""

from __future__ import annotations

# Prose the reader follows as one thread. Floats (figures, tables, their
# captions and notes) are out of scope: the text layer has no opinion worth
# trusting about where a float belongs relative to the prose around it.
ORDER_KINDS = ("paragraph", "heading", "list-item")

# A line counts as inside a block when its centre is, give or take a tenth of
# the line's own height — Docling's boxes are tight, and a descender or an
# inline formula can push a line's box a hair past the paragraph's.
TOLERANCE = 0.1

# The gutter band a two-column page keeps clear. A block that crosses it is
# full width — a centred section heading, a page-wide table — and separates the
# columns above it from the columns below.
GUTTER = (0.45, 0.55)


def _page_boxes(block: dict, page: int) -> list[dict]:
    return [b for b in (block.get("evidence", {}).get("boxes") or []) if b.get("page") == page]


def _normalized_lines(page_layout: dict) -> list[dict]:
    width = float(page_layout.get("width") or 0)
    height = float(page_layout.get("height") or 0)
    if width <= 0 or height <= 0:
        return []
    out = []
    for index, line in enumerate(page_layout.get("lines") or []):
        x0, x1 = line["xmin"] / width, line["xmax"] / width
        y0, y1 = line["ymin"] / height, line["ymax"] / height
        out.append({"index": index, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
                    "h": max(y1 - y0, 1e-6), "text": line.get("text", "")})
    return out


def _assign(entries: list[dict], lines: list[dict]) -> None:
    """Attach text-layer line indices to each entry, every line going to the
    smallest box that holds it so nested boxes cannot both claim it."""
    boxes = []
    for entry in entries:
        for box in entry["boxes"]:
            boxes.append((box["width"] * box["height"], entry, box))
    boxes.sort(key=lambda item: item[0])
    for line in lines:
        pad = TOLERANCE * line["h"]
        for _, entry, box in boxes:
            if (box["x"] - pad <= line["cx"] <= box["x"] + box["width"] + pad
                    and box["y"] - pad <= line["cy"] <= box["y"] + box["height"] + pad):
                entry["lines"].append(line["index"])
                break


def _side(box: dict) -> str:
    x0, x1 = box["x"], box["x"] + box["width"]
    if x0 < GUTTER[0] and x1 > GUTTER[1]:
        return "full"
    return "left" if (x0 + x1) / 2 <= 0.5 else "right"


def geometric_order(entries: list[dict]) -> list[int] | None:
    """The page read as two columns: down the left, down the right, band by
    band between the full-width blocks. None where the page is not laid out in
    two columns.

    This is a second opinion the text layer knows nothing about. Where the two
    agree, the order they agree on is not one tool's heuristic.
    """
    placed = []
    for entry in entries:
        box = entry["boxes"][0]  # a paragraph carried over a break starts where it starts
        placed.append((entry["position"], _side(box), box["y"], box["y"] + box["height"]))
    if sum(1 for _, side, _, _ in placed if side == "left") < 2:
        return None
    if sum(1 for _, side, _, _ in placed if side == "right") < 2:
        return None
    bands: list[list[tuple]] = [[]]
    for entry in sorted(placed, key=lambda item: (item[2], item[3])):
        if entry[1] == "full":
            bands.append([entry])
            bands.append([])
        else:
            bands[-1].append(entry)
    order = []
    for band in bands:
        for side in ("full", "left", "right"):
            order += [entry[0] for entry in band if entry[1] == side]
    return order


# A full-width block and a column block may not occupy the same height: on a
# real two-column page the full-width band separates the columns, it does not
# sit beside them. Where they do overlap, the box is a merged span over both
# columns, and neither its place nor its lines mean anything.
BAND_OVERLAP = 0.25


def band_faults(entries: list[dict]) -> list[str]:
    """Why the two-column model does not describe this page."""
    faults = []
    columns = [e for e in entries if _side(e["boxes"][0]) != "full"]
    full = [e for e in entries if _side(e["boxes"][0]) == "full"]
    for wide in full:
        box = wide["boxes"][0]
        top, bottom = box["y"], box["y"] + box["height"]
        for entry in columns:
            other = entry["boxes"][0]
            overlap = min(bottom, other["y"] + other["height"]) - max(top, other["y"])
            shortest = min(box["height"], other["height"])
            if shortest > 0 and overlap > BAND_OVERLAP * shortest:
                faults.append("full-width block overlaps a column block")
                return faults
    return faults


def split_lines(entry: dict) -> bool:
    """Whether a block's text-layer lines are broken by lines it does not own.

    A paragraph is a run of consecutive lines, in either tool's reading. A box
    that holds a scatter of them is a box over something else — a merged span,
    a picture region, a wrapper — and its place in the order is a guess.
    """
    lines = entry["lines"]
    return (max(lines) - min(lines) + 1) - len(lines) > len(lines)


def compare_page(blocks: list[dict], page: int, page_layout: dict) -> dict | None:
    """Docling's order against the text layer's, and against the geometry, for
    one page. `blocks` are the page's blocks in the order the adapter will
    print them. Returns None where there is nothing to compare.
    """
    lines = _normalized_lines(page_layout or {})
    if not lines:
        return None
    body = []
    for position, block in enumerate(blocks):
        if block.get("kind") not in ORDER_KINDS:
            continue
        # A paragraph carried over a page break is held in place by the page it
        # continues onto. One page's evidence does not place it.
        if len(block.get("evidence", {}).get("pages") or []) > 1:
            continue
        boxes = _page_boxes(block, page)
        if boxes:
            body.append({"position": position, "block": block, "boxes": boxes, "lines": []})
    if len(body) < 2:
        return None
    _assign(body, lines)
    known = [entry for entry in body if entry["lines"]]
    coverage = len(known) / len(body)
    base = {"page": page, "blocks": len(body), "matched": len(known), "coverage": round(coverage, 4),
            "geometryAgrees": False, "twoColumn": False, "confident": False,
            "faults": ["too little of the page matched"], "textOrder": [], "doclingOrder": [],
            "inversions": 0, "pairs": 0, "tau": 1.0, "maxDisplacement": 0, "displaced": []}
    if len(known) < 2:
        return base
    for index, entry in enumerate(known):
        entry["seat"] = index
        entry["rank"] = min(entry["lines"])
    by_text = sorted(known, key=lambda entry: (entry["rank"], entry["seat"]))
    text_order = [entry["position"] for entry in by_text]
    geometry = geometric_order(known)
    inversions = 0
    pairs = 0
    for a in range(len(known)):
        for b in range(a + 1, len(known)):
            pairs += 1
            if known[a]["rank"] > known[b]["rank"]:
                inversions += 1
    target = {entry["position"]: seat for seat, entry in enumerate(by_text)}
    displaced = []
    for entry in known:
        gap = entry["seat"] - target[entry["position"]]
        if gap:
            displaced.append({"position": entry["position"], "gap": gap,
                              "kind": entry["block"].get("kind"),
                              "text": (entry["block"].get("text") or "")[:80]})
    docling_order = [entry["position"] for entry in known]
    faults = []
    if geometry is None:
        faults.append("not two-column")
    elif geometry != text_order:
        faults.append("geometry and text layer disagree")
    if coverage < 1.0:
        faults.append("a body block matched no text-layer line")
    faults += band_faults(known)
    scattered = [entry["position"] for entry in known if split_lines(entry)]
    if scattered:
        faults.append("a block's text-layer lines are not one run")
    base.update({
        "twoColumn": geometry is not None,
        "geometryAgrees": geometry is not None and geometry == text_order,
        "confident": not faults and text_order != docling_order,
        "faults": sorted(set(faults)),
        "textOrder": text_order,
        "doclingOrder": docling_order,
        "inversions": inversions,
        "pairs": pairs,
        "tau": round(1 - 2 * inversions / pairs, 4) if pairs else 1.0,
        "maxDisplacement": max((abs(d["gap"]) for d in displaced), default=0),
        "displaced": displaced,
    })
    return base


def compare_document(blocks: list[dict], page_layout: list[dict]) -> list[dict]:
    """`compare_page` for every page that has both blocks and a text layer."""
    if not page_layout:
        return []
    by_page: dict[int, list[dict]] = {}
    for block in blocks:
        page = block.get("page")
        if page is not None:
            by_page.setdefault(page, []).append(block)
    out = []
    for page in sorted(by_page):
        if not 1 <= page <= len(page_layout):
            continue
        result = compare_page(by_page[page], page, page_layout[page - 1])
        if result is not None:
            out.append(result)
    return out
