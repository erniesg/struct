#!/usr/bin/env python
"""Compare the layout model's block order against the PDF text layer's.

The adapter prints blocks in the order Docling's layout model returned them.
Where that order is wrong the reader sees a paragraph out of place, and the
pipeline notices only when the break falls mid-word. This module is the missing
sensor: an independent opinion on the order of the same page, taken from
poppler's text layer (`pdftotext -bbox-layout`, through
`pdf_links.page_layout_lines`), and a second one taken from the geometry of the
boxes alone.

Nothing here decides who is right. `rules_reading_order.py` does that, and only
where both opinions agree against the layout model *and* nothing about the page
makes either of them unsafe. The faults are the substance of this module: each
one is a page shape on which two agreeing arbiters are agreeing about the wrong
thing.

Vocabulary, per page:

  rank         a block's place in the text layer: the lowest index among the
               text-layer lines that fall inside its boxes — where the text
               layer first reaches it.
  coverage     the fraction of body blocks that matched at least one line.
               Below 1 the comparison is not evidence of anything.
  inversions   pairs of body blocks the two orders disagree about.
  displacement how far a block would move, in block positions, to agree with
               the text layer. Local jitter is 1; a paragraph belonging in the
               other column is the length of a column.
  faults       why this page's comparison is not evidence.
"""

from __future__ import annotations

# Prose the reader follows as one thread. Floats (figures, tables, their
# captions and notes) are out of scope: neither arbiter has an opinion about
# where a float belongs relative to the prose that is worth trusting.
ORDER_KINDS = ("paragraph", "heading", "list-item")

# A line counts as inside a block when its centre is, give or take a tenth of
# the line's own height — Docling's boxes are tight, and a descender or an
# inline formula can push a line's box a hair past the paragraph's.
TOLERANCE = 0.1

# The gutter band a two-column page keeps clear. A block that crosses it is
# full width — a centred section heading, a page-wide table — and separates the
# columns above it from the columns below.
GUTTER = (0.45, 0.55)

# Two columns of one body are cut to one measure, and a column is a measure: a
# narrow strip beside a wide one is a margin, and a pair of glyph marks in the
# two margins of a one-column page is not a pair of columns at all. Reading
# either as columns hoists text out of the flow it belongs to.
MEASURE_RATIO = 2.0
MEASURE_MIN = 0.15

# A full-width block and a column block may not occupy the same height: on a
# real two-column page the full-width band separates the columns, it does not
# stand beside them. Where one covers a quarter of a column block, and more than
# a hundredth of the page, the box is a merged span over both columns and
# neither its place nor its lines mean anything. Both tests are needed: a
# heading box that abuts the paragraph under it by a point or two is not a span.
BAND_OVERLAP = 0.25
BAND_FLOOR = 0.01

# A block may hold lines the text layer does not give it — a footnote rule, a
# margin number. More gaps than that and the box is over something else.
SCATTER_FLOOR = 3
SCATTER_RATIO = 0.5

# Strongly right-to-left scripts. `geometric_order` reads the left column
# first, which is wrong for a page set in one of them, and poppler may or may
# not have noticed; on such a page the two arbiters can agree and both be wrong.
RTL_RANGES = ((0x0590, 0x05FF), (0x0600, 0x06FF), (0x0700, 0x074F), (0x0750, 0x077F),
              (0x07C0, 0x08FF), (0xFB1D, 0xFDFF), (0xFE70, 0xFEFF),
              (0x10800, 0x10FFF), (0x1E800, 0x1EFFF))
RTL_SHARE = 0.1


def _page_boxes(block: dict, page: int) -> list[dict]:
    return [b for b in (block.get("evidence", {}).get("boxes") or []) if b.get("page") == page]


def _normalized_lines(page_layout: dict) -> tuple[list[dict], float]:
    """Text-layer lines in the [0,1] frame the block boxes use, and the page's
    height/width ratio, which converts a vertical tolerance to a horizontal one
    of the same physical size."""
    width = float(page_layout.get("width") or 0)
    height = float(page_layout.get("height") or 0)
    if width <= 0 or height <= 0:
        return [], 1.0
    out = []
    for index, line in enumerate(page_layout.get("lines") or []):
        x0, x1 = line["xmin"] / width, line["xmax"] / width
        y0, y1 = line["ymin"] / height, line["ymax"] / height
        out.append({"index": index, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
                    "h": max(y1 - y0, 1e-6), "text": line.get("text", "")})
    return out, height / width


def _assign(entries: list[dict], lines: list[dict], aspect: float) -> None:
    """Attach text-layer line indices to each entry, every line going to the
    smallest box that holds it so nested boxes cannot both claim it."""
    boxes = []
    for entry in entries:
        for box in entry["boxes"]:
            boxes.append((box["width"] * box["height"], entry, box))
    boxes.sort(key=lambda item: item[0])
    for line in lines:
        pad_y = TOLERANCE * line["h"]
        pad_x = pad_y * aspect
        for _, entry, box in boxes:
            if (box["x"] - pad_x <= line["cx"] <= box["x"] + box["width"] + pad_x
                    and box["y"] - pad_y <= line["cy"] <= box["y"] + box["height"] + pad_y):
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


def measure_fault(entries: list[dict]) -> bool:
    """Whether the two sides are cut to one measure. A strip of margin notes
    beside a wide body is not a column of it."""
    widths = {"left": [], "right": []}
    for entry in entries:
        side = _side(entry["boxes"][0])
        if side in widths:
            widths[side].append(entry["boxes"][0]["width"])
    if not widths["left"] or not widths["right"]:
        return True
    left, right = max(widths["left"]), max(widths["right"])
    if min(left, right) < MEASURE_MIN:
        return True
    return max(left, right) / min(left, right) > MEASURE_RATIO


def band_faults(entries: list[dict]) -> bool:
    """Whether a full-width block stands beside a column block instead of
    separating the columns — a box over both columns, not a band."""
    columns = [e for e in entries if _side(e["boxes"][0]) != "full"]
    for wide in entries:
        box = wide["boxes"][0]
        if _side(box) != "full":
            continue
        top, bottom = box["y"], box["y"] + box["height"]
        for entry in columns:
            other = entry["boxes"][0]
            overlap = min(bottom, other["y"] + other["height"]) - max(top, other["y"])
            if overlap > BAND_OVERLAP * other["height"] and overlap > BAND_FLOOR:
                return True
    return False


def split_lines(entry: dict) -> bool:
    """Whether a block's text-layer lines are broken by lines it does not own.

    A paragraph is a run of consecutive lines in either tool's reading. A box
    that holds every other line of a span is a box over two columns; a box that
    holds a scatter of them is over a picture, a merged span, a wrapper. Its
    place in the order is a guess.
    """
    lines = entry["lines"]
    gaps = (max(lines) - min(lines) + 1) - len(lines)
    return gaps > max(SCATTER_FLOOR, SCATTER_RATIO * len(lines))


def rtl_fault(lines: list[dict]) -> bool:
    """Whether the page is set in a right-to-left script."""
    strong = rtl = 0
    for line in lines:
        for character in line["text"]:
            code = ord(character)
            if any(low <= code <= high for low, high in RTL_RANGES):
                rtl += 1
                strong += 1
            elif character.isalpha():
                strong += 1
    return strong > 0 and rtl / strong > RTL_SHARE


def barrier_crossed(docling_order: list[int], text_order: list[int], barriers: set[int]) -> bool:
    """Whether the repair would carry a block past a block that must not be
    passed: a heading, which bounds the prose under it in a way the two-column
    model cannot see, or a paragraph carried onto the next page, which is held
    in place by a page this one has no evidence about."""
    for position in barriers:
        before_now = set(docling_order[: docling_order.index(position)])
        before_then = set(text_order[: text_order.index(position)])
        if before_now != before_then:
            return True
    return False


def compare_page(blocks: list[dict], page: int, page_layout: dict) -> dict | None:
    """Docling's order against the text layer's, and against the geometry, for
    one page. `blocks` are the page's blocks in the order the adapter will
    print them. Returns None where there is nothing to compare.
    """
    lines, aspect = _normalized_lines(page_layout or {})
    if not lines:
        return None
    body = []
    for position, block in enumerate(blocks):
        if block.get("kind") not in ORDER_KINDS:
            continue
        boxes = _page_boxes(block, page)
        if boxes:
            body.append({"position": position, "block": block, "boxes": boxes, "lines": [],
                         "spansPages": len(block.get("evidence", {}).get("pages") or []) > 1})
    if len(body) < 2:
        return None
    _assign(body, lines, aspect)
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
    docling_order = [entry["position"] for entry in known]
    geometry = geometric_order(known)

    faults = []
    if geometry is None:
        faults.append("not two-column")
    elif geometry != text_order:
        faults.append("geometry and text layer disagree")
    if coverage < 1.0:
        faults.append("a body block matched no text-layer line")
    if measure_fault(known):
        faults.append("the two sides are not one measure")
    if band_faults(known):
        faults.append("full-width block overlaps a column block")
    if any(split_lines(entry) for entry in known):
        faults.append("a block's text-layer lines are not one run")
    if rtl_fault(lines):
        faults.append("the page is not left-to-right")
    barriers = {entry["position"] for entry in known
                if entry["block"].get("kind") == "heading" or entry["spansPages"]}
    if barrier_crossed(docling_order, text_order, barriers):
        faults.append("a block would move across a heading or a page-spanning paragraph")

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
