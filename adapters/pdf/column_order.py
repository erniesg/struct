"""Put a two-column page's items back into reading order before the walk.

The layout model usually emits a page column by column, but on some pages it
emits an item of the left column after the whole right column (the left
column's last paragraph, a display equation, an abstract set above the
introduction). Everything downstream — the joins, note placement, the reader —
then sees a sentence whose halves are the wrong way round.

This repairs the order from geometry alone, and only where the geometry is
unambiguous: the page has two disjoint columns of body items, every item either
sits inside one column or spans the page (a figure, a section heading, a
full-width table), and full-width items cut the page into bands the reader
crosses in turn. Inside a band the left column is read top to bottom, then the
right column. A page that does not look like that is left exactly as it is.
"""

from __future__ import annotations

from docling_core.types.doc import DoclingDocument, DocItem


def _page_box(doc: DoclingDocument, item) -> tuple[int, float, float, float, float] | None:
    """(page, x0, y0, x1, y1) of an item's first box, normalized top-left."""
    boxes = []
    for node in [item] + [child.resolve(doc) for child in getattr(item, "children", [])]:
        for provenance in getattr(node, "prov", None) or []:
            page = doc.pages.get(provenance.page_no)
            if page is None or not page.size.width or not page.size.height:
                continue
            box = provenance.bbox.to_top_left_origin(page.size.height)
            boxes.append((provenance.page_no, box.l / page.size.width, box.t / page.size.height,
                          box.r / page.size.width, box.b / page.size.height))
    if not boxes:
        return None
    page = boxes[0][0]
    same = [box for box in boxes if box[0] == page]
    return (page, min(b[1] for b in same), min(b[2] for b in same), max(b[3] for b in same), max(b[4] for b in same))


def reorder_columns(doc: DoclingDocument) -> int:
    """Reorder the body's children of every unambiguous two-column page.

    Returns the number of pages whose order changed.
    """
    children = list(doc.body.children)
    if len(children) < 4:
        return 0
    placed: list[tuple[int, object, tuple | None]] = []
    for index, reference in enumerate(children):
        item = reference.resolve(doc)
        placed.append((index, reference, _page_box(doc, item) if isinstance(item, DocItem) or getattr(item, "children", None) else None))
    pages: dict[int, list[tuple[int, object, tuple]]] = {}
    for index, reference, box in placed:
        if box is not None:
            pages.setdefault(box[0], []).append((index, reference, box))
    order: dict[int, int] = {}
    changed = 0
    for page, entries in pages.items():
        positions = [index for index, _, _ in entries]
        if positions != sorted(positions) or len(entries) < 4:
            continue  # the page's items are not one contiguous run: leave it alone
        columns = _columns(entries)
        if columns is None:
            continue
        left, right = columns
        bands: list[list[tuple[int, object, tuple]]] = [[]]
        barriers: list[tuple[int, object, tuple]] = []
        for entry in sorted(entries, key=lambda e: (e[2][2], e[2][1])):
            if _spans(entry[2], left, right):
                barriers.append(entry)
                bands.append([])
            else:
                bands[-1].append(entry)
        wanted: list[int] = []
        for index, band in enumerate(bands):
            for column in (left, right):
                for entry in sorted(band, key=lambda e: (e[2][2], e[2][1])):
                    if _in_column(entry[2], column):
                        wanted.append(entry[0])
            if index < len(barriers):
                wanted.append(barriers[index][0])
        if sorted(wanted) != sorted(positions):
            continue  # an item belongs to neither column and is not full width
        if wanted == positions:
            continue
        changed += 1
        for slot, index in zip(positions, wanted):
            order[slot] = index
    if not order:
        return 0
    rebuilt = list(children)
    for slot, index in order.items():
        rebuilt[slot] = children[index]
    doc.body.children = rebuilt
    return changed


def _columns(entries) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """The page's two text columns as (left, right) x ranges, or None."""
    narrow = [entry[2] for entry in entries if entry[2][3] - entry[2][1] <= 0.55]
    left = [box for box in narrow if (box[1] + box[3]) / 2 < 0.5]
    right = [box for box in narrow if (box[1] + box[3]) / 2 >= 0.5]
    if len(left) < 2 or len(right) < 2:
        return None
    left_range = (min(box[1] for box in left), max(box[3] for box in left))
    right_range = (min(box[1] for box in right), max(box[3] for box in right))
    if left_range[1] > right_range[0] - 0.01:
        return None  # the two groups overlap horizontally: not two columns
    return left_range, right_range


def _in_column(box, column) -> bool:
    return box[1] >= column[0] - 0.02 and box[3] <= column[1] + 0.02


def _spans(box, left, right) -> bool:
    return box[1] <= left[1] + 0.02 and box[3] >= right[0] - 0.02
