"""Normalize a small class of impossible cross-page Docling text items.

Docling occasionally joins a rotated figure caption to a horizontal table
note on the next page.  The two source boxes describe different reading
orders, so preserve each physical source span as a separate text item before
the adapter constructs links and walks the document tree.
"""
from __future__ import annotations

import re

from docling_core.types.doc import DocItemLabel, TextItem


CAPTION_START = re.compile(r"^\s*(?:Figure|Fig\.?)\s*\d+", re.IGNORECASE)


def _is_tall(provenance) -> bool:
    box = provenance.bbox
    return abs(box.b - box.t) > 4 * abs(box.r - box.l)


def _is_wide(provenance) -> bool:
    box = provenance.bbox
    return abs(box.r - box.l) > 4 * abs(box.b - box.t)


def _partition(item: TextItem):
    """Return the two spans only when they account for this text losslessly."""
    if len(item.prov) != 2 or not CAPTION_START.match(item.text):
        return None
    # `charspan` offsets describe `text`; only an equally long source origin
    # can be split without changing or inventing source content.
    if not isinstance(item.orig, str) or len(item.orig) != len(item.text):
        return None
    first, second = item.prov
    if first.page_no == second.page_no or not (_is_tall(first) and _is_wide(second)):
        return None
    start, end = first.charspan
    tail_start, tail_end = second.charspan
    length = len(item.text)
    if start != 0 or end < start or tail_start < end or tail_end < tail_start:
        return None
    # The reader can leave a separator outside both boxes and can overshoot the
    # terminal offset by up to three characters.  Neither may conceal content.
    gap = item.text[end:tail_start]
    if len(gap) > 3 or not gap.isspace() or tail_start > length:
        return None
    if tail_end < length or tail_end > length + 3:
        return None
    return first, second, end, tail_start, length


def _top_and_bottom(doc, provenance):
    page = doc.pages.get(provenance.page_no)
    if page is None:
        return None
    box = provenance.bbox.to_top_left_origin(page.size.height)
    return box.t, box.b


def _preceding_table(doc, page_no: int, tail_provenance):
    """The nearest table that can physically own a tail on its page."""
    tail_bounds = _top_and_bottom(doc, tail_provenance)
    page = doc.pages.get(page_no)
    if tail_bounds is None or page is None:
        return None
    tail_top, _ = tail_bounds
    tail_box = tail_provenance.bbox.to_top_left_origin(page.size.height)
    tail_width = tail_box.r - tail_box.l
    candidates = []
    for table in doc.tables:
        for provenance in table.prov:
            if provenance.page_no != page_no:
                continue
            bounds = _top_and_bottom(doc, provenance)
            if bounds is None or bounds[1] > tail_top:
                continue
            table_box = provenance.bbox.to_top_left_origin(page.size.height)
            table_width = table_box.r - table_box.l
            overlap = min(tail_box.r, table_box.r) - max(tail_box.l, table_box.l)
            if overlap < .25 * min(tail_width, table_width):
                continue
            vertical_gap = tail_top - bounds[1]
            if vertical_gap > max(.15 * page.size.height, 2 * (tail_box.b - tail_box.t)):
                continue
            candidates.append((bounds[1], table))
    return max(candidates, default=(None, None), key=lambda candidate: candidate[0])[1]


def _source_order_key(doc, provenance, original_order: int):
    """Reading order for tails inserted after one source table.

    Columns are read left-to-right and entries in a column top-to-bottom.
    The source-text sequence decides an otherwise geometrically equal tie.
    """
    page = doc.pages.get(provenance.page_no)
    bounds = _top_and_bottom(doc, provenance)
    if page is None or bounds is None:
        return provenance.page_no, float("inf"), float("inf"), original_order
    box = provenance.bbox.to_top_left_origin(page.size.height)
    return provenance.page_no, box.l, bounds[0], original_order


def normalize_provenance(doc) -> tuple[object, dict[str, str]]:
    """Split attested perpendicular caption/note provenance into source order.

    Returns the original document unchanged when no complete, geometrically
    supported partition exists.  For each created text item the accompanying
    map points its new reference to the original caption reference.
    """
    plans = []
    for original_order, item in enumerate(doc.texts):
        if not isinstance(item, TextItem):
            continue
        partition = _partition(item)
        if partition is None:
            continue
        first, second, first_end, tail_start, text_end = partition
        table = _preceding_table(doc, second.page_no, second)
        if table is not None:
            plans.append((item.self_ref, first, second, first_end, tail_start, text_end, table.self_ref, original_order))

    if not plans:
        return doc, {}

    normalized = doc.model_copy(deep=True)
    texts = {item.self_ref: item for item in normalized.texts}
    tables = {item.self_ref: item for item in normalized.tables}
    original_refs: dict[str, str] = {}
    # Insertion immediately after a common table prepends the new sibling.
    # Process source order backwards so the final body order remains forward.
    for item_ref, first, second, first_end, tail_start, text_end, table_ref, _ in reversed(
        sorted(plans, key=lambda plan: _source_order_key(doc, plan[2], plan[-1]))
    ):
        item = texts[item_ref]
        table = tables[table_ref]
        source_origin = item.orig
        first_text = item.text[:tail_start]
        tail_text = item.text[tail_start:text_end]
        item.text = first_text
        item.orig = source_origin[:tail_start]
        item.label = DocItemLabel.CAPTION
        item.prov = [first.model_copy(deep=True)]

        tail = item.model_copy(deep=True)
        tail.text = tail_text
        tail.orig = source_origin[tail_start:text_end]
        tail.label = DocItemLabel.TEXT
        tail.prov = [second.model_copy(deep=True)]
        normalized.insert_item_after_sibling(new_item=tail, sibling=table)
        original_refs[tail.self_ref] = item.self_ref

    return normalized, original_refs
