"""Re-read two prose items the layout model laid over each other on one page.

Now and then the layout model emits two text items whose boxes cover the same
part of a page and splits the page's lines between them out of reading order:
the later item opens with a line from the middle of the page and the earlier one
ends mid-word. Everything downstream then reads the page scrambled.

The page's own text layer has the lines in order. Where two prose items overlap,
this re-reads the union of their boxes line by line and gives the first item as
many words as it already held, the rest to the second. It runs only when
the rebuilt pair carries exactly the words the pair already carried, so a page
of mathematics whose text layer is ordered differently is left alone.
"""

from __future__ import annotations

import re

from docling_core.types.doc import DocItemLabel, DoclingDocument, TextItem

PROSE_LABELS = {DocItemLabel.TEXT, DocItemLabel.PARAGRAPH}


def _words(text: str) -> list[str]:
    return re.findall(r"[0-9A-Za-z]+", (text or "").lower())


def _boxes(doc: DoclingDocument, item: TextItem):
    for provenance in item.prov or []:
        page = doc.pages.get(provenance.page_no)
        if page is None or not page.size.height:
            continue
        box = provenance.bbox.to_top_left_origin(page.size.height)
        yield provenance.page_no, box.l, box.t, box.r, box.b, provenance


def _page_span(item: TextItem, provenance) -> tuple[int, int]:
    """The item's own characters on that page (an item can run over a page break)."""
    span = getattr(provenance, "charspan", None)
    if not span or len(span) != 2 or span[0] >= span[1]:
        return 0, len(item.text or "")
    return max(0, span[0]), min(len(item.text or ""), span[1])


def _joined(lines: list[str]) -> str:
    """The lines as one text, undoing a line-end hyphen the way the layout model does."""
    text = ""
    for line in lines:
        if not text:
            text = line
        elif re.search(r"[A-Za-z]-$", text) and re.match(r"[a-z]", line):
            text = text[:-1] + line
        else:
            text = f"{text} {line}"
    return text


def _overlapping_pairs(doc: DoclingDocument):
    by_page: dict[int, list] = {}
    for item in doc.texts:
        if not isinstance(item, TextItem) or item.label not in PROSE_LABELS or len(item.text or "") < 200:
            continue
        for page, left, top, right, bottom, provenance in _boxes(doc, item):
            by_page.setdefault(page, []).append((item, left, top, right, bottom, provenance))
    for page, entries in by_page.items():
        for index, (first, l1, t1, r1, b1, p1) in enumerate(entries):
            for second, l2, t2, r2, b2, p2 in entries[index + 1:]:
                if first is second:
                    continue
                vertical = min(b1, b2) - max(t1, t2)
                horizontal = min(r1, r2) - max(l1, l2)
                if vertical > 0.5 * min(b1 - t1, b2 - t2) and horizontal > 0.5 * min(r1 - l1, r2 - l2):
                    yield page, (first, l1, t1, r1, b1, p1), (second, l2, t2, r2, b2, p2)


def repair_overlapping_items(doc: DoclingDocument, page_layout: list[dict]) -> int:
    """Rebuild the text of overlapping prose pairs from the page's text layer.

    Returns the number of pairs rebuilt.
    """
    if not page_layout:
        return 0
    repaired = 0
    for page, first, second in list(_overlapping_pairs(doc)):
        if page - 1 >= len(page_layout):
            continue
        layout = page_layout[page - 1]
        width, height = layout.get("width") or 0, layout.get("height") or 0
        size = doc.pages.get(page)
        if not width or not height or size is None or not size.size.width:
            continue
        scale_x, scale_y = size.size.width / width, size.size.height / height
        top = min(first[2], second[2]) - 1
        bottom = max(first[4], second[4]) + 1
        left = min(first[1], second[1]) - 1
        right = max(first[3], second[3]) + 1
        lines = []
        for line in layout["lines"]:
            x0, y0, x1, y1 = line["xmin"] * scale_x, line["ymin"] * scale_y, line["xmax"] * scale_x, line["ymax"] * scale_y
            if left <= (x0 + x1) / 2 <= right and top <= (y0 + y1) / 2 <= bottom and line["text"].strip():
                lines.append((y0, x0, line["text"].strip()))
        if len(lines) < 4:
            continue
        lines.sort()
        head_entry, tail_entry = (first, second) if first[2] <= second[2] else (second, first)
        head_item, head_prov = head_entry[0], head_entry[5]
        tail_item, tail_prov = tail_entry[0], tail_entry[5]
        head_span, tail_span = _page_span(head_item, head_prov), _page_span(tail_item, tail_prov)
        held = _words(head_item.text[head_span[0]:head_span[1]]) + _words(tail_item.text[tail_span[0]:tail_span[1]])
        source = _joined([text for _, _, text in lines])
        if sorted(_words(source)) != sorted(held):
            continue  # the text layer does not carry exactly these words: leave the pair alone
        # the first item keeps as many words as it held: the pair's own split point,
        # wherever the layout model put it, now falls in reading order
        wanted = len(_words(head_item.text[head_span[0]:head_span[1]]))
        boundaries = [match.end() for match in re.finditer(r"[0-9A-Za-z]+", source)]
        if not 0 < wanted < len(boundaries):
            continue
        cut = boundaries[wanted - 1]
        head, tail = source[:cut].strip(), source[cut:].strip()
        if not head or not tail:
            continue
        if head == head_item.text[head_span[0]:head_span[1]] and tail == tail_item.text[tail_span[0]:tail_span[1]]:
            continue
        for item, span, replacement, provenance in ((head_item, head_span, head, head_prov), (tail_item, tail_span, tail, tail_prov)):
            text = item.text or ""
            item.text = text[:span[0]] + replacement + text[span[1]:]
            item.orig = item.text
            delta = len(replacement) - (span[1] - span[0])
            for entry in item.prov or []:
                start, end = getattr(entry, "charspan", (0, len(text)))
                if entry is provenance:
                    entry.charspan = (start, start + len(replacement))
                elif start >= span[1]:
                    entry.charspan = (start + delta, end + delta)
        repaired += 1
    return repaired
