"""Arbitrate simple list-child order using two independent source signals.

A model's tree order is not necessarily reading order. Only a flat, single-page
vertical list whose provenance and PDF text layer agree can override it. Do not
sort the document globally or infer order from wording/numbered markers.
"""
from __future__ import annotations

import math
import unicodedata

from docling_core.types.doc import ListItem


def _text_key(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKC", text).casefold() if char.isalnum())


def source_ordered_list_children(doc, group, page_layout: list[dict]):
    original = list(group.children)
    if len(original) < 2:
        return original
    items = [ref.resolve(doc) for ref in original]
    if any(not isinstance(item, ListItem) or item.children or len(item.prov) != 1 for item in items):
        return original
    if len({item.enumerated for item in items}) != 1:
        return original
    page_no = items[0].prov[0].page_no
    if any(item.prov[0].page_no != page_no for item in items) or not 1 <= page_no <= len(page_layout):
        return original
    page = doc.pages.get(page_no)
    if page is None:
        return original
    boxes = [item.prov[0].bbox.to_top_left_origin(page.size.height) for item in items]
    if any(not all(math.isfinite(value) for value in (box.l, box.t, box.r, box.b)) or box.r <= box.l or box.b <= box.t for box in boxes):
        return original
    # Every sibling must share a majority-width horizontal corridor. Disjoint
    # columns, marginal notes and ambiguous mixed layouts retain model order.
    corridor = min(box.r for box in boxes) - max(box.l for box in boxes)
    if corridor < .5 * min(box.r - box.l for box in boxes):
        return original
    layout = page_layout[page_no - 1]
    # Both sources must use the same page frame (allow coordinate rounding).
    if not math.isclose(layout.get("width", 0), page.size.width, abs_tol=1) or not math.isclose(layout.get("height", 0), page.size.height, abs_tol=1):
        return original
    lines = layout.get("lines", [])
    if not isinstance(lines, list):
        return original
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("text"), str):
            return original
        values = [line.get(field) for field in ("xmin", "xmax", "ymin", "ymax")]
        if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
            return original
        if values[0] >= values[1] or values[2] >= values[3]:
            return original
    anchors = []
    anchor_lefts = []
    for item, box in zip(items, boxes):
        key = _text_key(item.text)
        if not key:
            return original
        matches = []
        for line in lines:
            x = (line["xmin"] + line["xmax"]) / 2
            y = (line["ymin"] + line["ymax"]) / 2
            if not box.l <= x <= box.r or not box.t <= y <= box.b:
                continue
            text = line["text"].strip()
            candidates = [_text_key(text)]
            marker = item.marker or ""
            if marker and text.startswith(marker):
                candidates.append(_text_key(text[len(marker):]))
            if any(candidate and key.startswith(candidate) for candidate in candidates):
                matches.append((line["ymin"], line["ymax"], line["xmin"]))
        # Repeated/partial/missing matches cannot decide a sibling's position.
        if len(matches) != 1:
            return original
        anchors.append(matches[0])
        anchor_lefts.append(matches[0][2])
    # First text lines must also share a left edge: broad model boxes can
    # overlap across columns even when their actual text occupies separate ones.
    if max(anchor_lefts) - min(anchor_lefts) > 6:
        return original
    geometry_order = sorted(range(len(items)), key=lambda index: boxes[index].t)
    text_order = sorted(range(len(items)), key=lambda index: anchors[index][0])
    if geometry_order != text_order:
        return original
    for first, second in zip(text_order, text_order[1:]):
        if boxes[first].t >= boxes[second].t or anchors[first][1] > anchors[second][0]:
            return original
    return [original[index] for index in text_order]
