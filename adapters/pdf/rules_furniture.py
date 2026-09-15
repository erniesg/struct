"""Page furniture: running heads, footers, page numbers and margin stamps.

What belongs here: rules that decide a line is furniture (accounted, never
rendered) or that rescue content the layout model filed as furniture: edge page
numbers, the furniture layer's captions and single-page prose, text repeated in
an edge band on three or more pages, running heads that repeat a heading or the
title, and a margin stamp glued in front of a paragraph's first line.
"""

from __future__ import annotations

import re

from docling_core.types.doc import ContentLayer, TextItem

from adapter_common import (
    CAPTION_LIKE_RE,
    FIGURE_CAPTION_RE,
    JOURNAL_LINE_RE,
    PAGE_NUMBER_TEXT_RE,
    PARATEXT_NOTE_ANY_RE,
    PARATEXT_NOTE_RE,
    TABLE_CAPTION_RE,
    sanitize,
)


class FurnitureRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _is_edge_page_number(self, item: TextItem) -> bool:
        if not PAGE_NUMBER_TEXT_RE.match(item.text):
            return False
        box = self._box(item)
        if box is None:
            return True
        return box["y"] <= 0.12 or box["y"] + box["height"] >= 0.88

    def _furniture_text_is_prose(self, item: TextItem) -> bool:
        """A furniture-layer text that occurs on one page only, reads as prose
        (six or more words, no journal or licence wording), and is not a
        running line is a paragraph the layout model filed as a footer."""
        text = sanitize(item.text).strip()
        words = text.split()
        if len(words) < 6 or len(text) > 400 or PARATEXT_NOTE_RE.match(text) or PARATEXT_NOTE_ANY_RE.search(text) or JOURNAL_LINE_RE.search(text):
            return False
        key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
        if self._furniture_keys is None:
            counter: dict[str, set[int]] = {}
            for other, _ in self.doc.iterate_items(included_content_layers={ContentLayer.FURNITURE}):
                if isinstance(other, TextItem) and other.prov:
                    other_key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", sanitize(other.text).strip().lower()))
                    counter.setdefault(other_key, set()).add(other.prov[0].page_no)
            self._furniture_keys = counter
        return len(self._furniture_keys.get(key, set())) <= 1

    def _rescue_prose_from_furniture(self, item: TextItem) -> None:
        text = sanitize(item.text).strip()
        block = self._new_block("paragraph", item, text)
        block["inline"] = self._runs_for(item, text)
        block["evidence"]["signals"].append("rescued-from-furniture-layer")
        box = self._box(item)
        position = len(self.blocks)
        if box is not None:
            for i, existing in enumerate(self.blocks):
                if existing["page"] != box["page"] or not existing["evidence"]["boxes"]:
                    continue
                ebox = existing["evidence"]["boxes"][0]
                if ebox["y"] >= box["y"] and min(ebox["x"] + ebox["width"], box["x"] + box["width"]) - max(ebox["x"], box["x"]) > 0:
                    position = i
                    break
            else:
                position = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > box["page"]), len(self.blocks))
        self.blocks.insert(position, block)
        self.report.paragraphs += 1
        self.report.prose_rescued_from_furniture += 1

    def _rescue_caption_from_furniture(self, item: TextItem) -> bool:
        """A `Table N` / `Figure N` caption the layout model filed as page
        furniture is a caption: it goes back into the flow where its geometry
        puts it (before the first block below it on its page)."""
        text = sanitize(item.text).strip()
        if not (FIGURE_CAPTION_RE.match(text) or TABLE_CAPTION_RE.match(text)) or len(text) > 1200:
            return False
        self._flush()
        block = self._new_block("caption", item, text)
        block["inline"] = self._runs_for(item, text)
        box = self._box(item)
        position = len(self.blocks)
        if box is not None:
            for i, existing in enumerate(self.blocks):
                if existing["page"] != box["page"] or not existing["evidence"]["boxes"]:
                    continue
                ebox = existing["evidence"]["boxes"][0]
                if ebox["y"] >= box["y"] and min(ebox["x"] + ebox["width"], box["x"] + box["width"]) - max(ebox["x"], box["x"]) > 0:
                    position = i
                    break
            else:
                position = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > box["page"]), len(self.blocks))
        self.blocks.insert(position, block)
        self.report.orphan_captions += 1
        self.report.captions_rescued_from_furniture += 1
        return True

    def _furniture_block(self, item: TextItem, classification: str, evidence: str | None = None) -> None:
        box = self._box(item)
        page = self._page_of(item)
        band = "top" if box and box["y"] < 0.5 else "bottom"
        block = self._new_block("furniture", item, item.text)
        block["furniture"] = {
            "classification": classification,
            "band": band,
            "pages": [page] if page is not None else [],
            "boxes": [box] if box else [],
            "evidence": [evidence or ("docling-furniture-layer" if classification == "explicit-paratext" else "edge-page-number")],
            "normalizedText": sanitize(item.text).strip().lower(),
        }
        self._push(block)
        self.report.furniture_blocks += 1

    def _strip_glued_heads(self) -> None:
        """The mirror of `_strip_glued_tails`: the layout model sometimes puts a
        margin stamp — usually a page or line number sitting alone at the page
        edge — in front of a paragraph's first line, and the number is then read
        as part of the sentence ("63 lower revenue bound, this algorithm ...").

        Decided by geometry, never by wording: the paragraph must own a separate
        provenance box that is tiny, in an edge band, and nowhere near the box
        that carries the prose, and the text must open with a bare number. The
        number and that box are cut; nothing else about the paragraph changes.
        """
        for block in self.blocks:
            if block["kind"] != "paragraph" or len(block["text"]) < 60:
                continue
            boxes = block["evidence"]["boxes"]
            if len(boxes) < 2:
                continue
            head, body = boxes[0], boxes[1]
            if head["page"] != body["page"]:
                continue
            if head["width"] >= 0.05 or head["height"] >= 0.03:
                continue  # a real line of text, not a stamp
            in_edge_band = (
                head["x"] < 0.12
                or head["x"] + head["width"] > 0.88
                or head["y"] < 0.09
                or head["y"] + head["height"] > 0.91
            )
            if not in_edge_band:
                continue
            if abs(head["y"] - body["y"]) <= 0.05 and abs(head["x"] - body["x"]) <= 0.2:
                continue  # adjacent to the prose: a drop cap or an equation number, not furniture
            match = re.match(r"^(\d{1,4})\s+(?=\S)", block["text"])
            if not match:
                continue
            cut = match.end()
            block["text"] = block["text"][cut:]
            block["inline"] = [
                {**run, "start": max(run["start"] - cut, 0), "end": run["end"] - cut}
                for run in block["inline"]
                if run["end"] > cut
            ]
            block["evidence"]["boxes"] = boxes[1:]
            self.report.glued_heads_stripped += 1

    def _demote_repeated_edge_text(self) -> None:
        """Spec 042 rule: short text repeated on three or more pages inside the
        top or bottom band is page furniture (running heads, journal lines,
        ACM footers), decided by geometry and repetition, never by wording."""
        keyed: dict[str, list[dict]] = {}
        for block in self.blocks:
            # furniture the layout model already separated counts as repetition evidence
            if block["kind"] not in ("paragraph", "caption", "heading", "furniture") or not block["evidence"]["boxes"]:
                continue
            text = block["text"].strip()
            if not text or len(text) > 160 or CAPTION_LIKE_RE.match(text):
                continue  # `Figure 17: …` repeated on four pages is four captions, not a running head
            box = block["evidence"]["boxes"][0]
            if not (box["y"] <= 0.15 or box["y"] + box["height"] >= 0.84):
                continue
            key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
            keyed.setdefault(key, []).append(block)
        for key, group in keyed.items():
            pages = {b["page"] for b in group}
            if len(pages) < 3:
                continue
            for block in group:
                if block["kind"] == "furniture":
                    continue
                box = block["evidence"]["boxes"][0]
                block["kind"] = "furniture"
                block.pop("attributes", None)
                block["inline"] = []
                block["furniture"] = {
                    "classification": "repeated-text",
                    "band": "top" if box["y"] <= 0.15 else "bottom",
                    "pages": sorted(pages),
                    "boxes": [box],
                    "evidence": [f"repeated-on-{len(pages)}-pages", "edge-band"],
                    "normalizedText": key,
                }
                self.report.furniture_blocks += 1
                self.report.repeated_text_demoted += 1

    def _in_furniture_band(self, box: dict) -> bool:
        """Whether furniture on at least two other pages sits at this height."""
        pages = set()
        for other in self.blocks:
            if other["kind"] != "furniture" or not other["evidence"]["boxes"]:
                continue
            obox = other["evidence"]["boxes"][0]
            if abs(obox["y"] - box["y"]) <= 0.015 and obox["page"] != box["page"]:
                pages.add(obox["page"])
        return len(pages) >= 2

    def _demote_heading_running_heads(self) -> None:
        """Running heads that repeat the current section title or the paper
        title (so their text changes from page to page and escapes the
        repetition rule) are furniture when they sit in an edge band."""

        def key(text: str) -> str:
            return re.sub(r"\s+", " ", re.sub(r"^[\dA-Z]+(?:\.\d+)*\.?\s+", "", text.strip().lower()))

        headings = {key(b["text"]) for b in self.blocks if b["kind"] == "heading"}
        title = key(self.title)
        for block in self.blocks:
            if block["kind"] not in ("paragraph", "caption") or not block["evidence"]["boxes"] or block["page"] in (None, 1):
                continue
            text = block["text"].strip()
            if not text or len(text) > 120 or CAPTION_LIKE_RE.match(text):
                continue
            box = block["evidence"]["boxes"][0]
            if not (box["y"] <= 0.12 or box["y"] + box["height"] >= 0.88):
                continue
            if not (box["y"] <= 0.075 or box["y"] + box["height"] >= 0.925) and not self._in_furniture_band(box):
                continue  # a bold lead-in at the foot of a page is prose, not a running head
            normalized = re.sub(r"^\d+\s+|\s+\d+$", "", key(text))
            if len(normalized) < 6:
                continue
            if not (normalized in headings or normalized == title or (len(normalized) >= 12 and (title.startswith(normalized) or normalized in title))):
                continue
            block["kind"] = "furniture"
            block.pop("attributes", None)
            block["inline"] = []
            block["furniture"] = {
                "classification": "repeated-text",
                "band": "top" if box["y"] <= 0.12 else "bottom",
                "pages": [block["page"]],
                "boxes": [box],
                "evidence": ["matches-heading-or-title", "edge-band"],
                "normalizedText": normalized,
            }
            self.report.furniture_blocks += 1
            self.report.heading_running_heads_demoted += 1
