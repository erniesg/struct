"""Text-layer recovery: words the layout model dropped or could not read.

What belongs here: reading the PDF's own text layer (pdftotext word boxes and
lines, docling-parse glyph lines) inside a region; restoring lines and clauses
missing from a paragraph's box; recovering dropped regions and pages as
fallback paragraphs; folding separately extracted fragments back into a
repaired paragraph; and OCR for a region whose text layer cannot be decoded.
"""

from __future__ import annotations

import re

from docling_core.types.doc import ContentLayer, TextItem

from pdf_links import normalize_uri
from adapter_common import (
    PAGE_NUMBER_TEXT_RE,
    SAFE_HREF_RE,
    TOP_LEVEL_HEADING_RE,
    WORD_RE_ADAPTER,
    _line_words_present,
    first_free_span,
    link_visible_text,
    loose_pattern,
    sanitize,
)


class TextLayerRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _words_in(self, page: int, x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, str]]:
        """Source words (top-left normalized coords) inside a region, as (y, text)."""
        if page - 1 >= len(self.word_boxes) or page not in self.doc.pages:
            return []
        size = self.doc.pages[page].size
        if not size.width or not size.height:
            return []
        words = []
        for wx0, wy0, wx1, wy1, text in self.word_boxes[page - 1]:
            cx, cy = (wx0 + wx1) / 2 / size.width, (wy0 + wy1) / 2 / size.height
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                words.append((round(cy, 4), round(wx0 / size.width, 4), text))
        words.sort()
        return [(y, t) for y, _, t in words]

    def _lines_in(self, page: int, x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float, str]]:
        """Source text lines inside a region as (top, bottom, text), from the
        word boxes grouped by baseline."""
        if page - 1 >= len(self.word_boxes) or page not in self.doc.pages:
            return []
        size = self.doc.pages[page].size
        if not size.width or not size.height:
            return []
        words = []
        for wx0, wy0, wx1, wy1, text in self.word_boxes[page - 1]:
            cx, cy = (wx0 + wx1) / 2 / size.width, (wy0 + wy1) / 2 / size.height
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                words.append((wy0 / size.height, wy1 / size.height, wx0 / size.width, text))
        words.sort(key=lambda w: (round((w[0] + w[1]) / 2, 3), w[2]))
        lines: list[list] = []
        for top, bottom, x, text in words:
            if lines and abs((top + bottom) / 2 - (lines[-1][0] + lines[-1][1]) / 2) <= 0.4 * max(bottom - top, 0.004):
                lines[-1][0] = min(lines[-1][0], top)
                lines[-1][1] = max(lines[-1][1], bottom)
                lines[-1][2].append((x, text))
            else:
                lines.append([top, bottom, [(x, text)]])
        return [(top, bottom, " ".join(t for _, t in sorted(parts))) for top, bottom, parts in lines]

    def _glyph_lines_in(self, page: int, x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float, str]]:
        """Visible glyph lines (docling-parse) starting inside a region, as (top, bottom, text, right), top to bottom."""
        page_text = self._page_text(page)
        if page_text is None:
            return []
        found = []
        for line in page_text.lines:
            if line.height <= 0 or not line.text.strip():
                continue
            top, bottom = 1 - line.t / page_text.height, 1 - line.b / page_text.height
            left = line.l / page_text.width
            if x0 <= left <= x1 and y0 <= (top + bottom) / 2 <= y1:
                found.append((top, bottom, line.text.strip(), line.r / page_text.width))
        return sorted(found)

    def _emit_undecodable_text_region(self, item, box: dict) -> bool:
        """A caption-less picture over lines of prose whose text layer cannot be
        decoded (glyphs without a Unicode map) is text the layout model could not
        read: Tesseract reads the region from the page and each paragraph it
        finds becomes a paragraph block. False (a figure after all) when the
        lines are not prose, the text layer reads fine, or OCR is unavailable."""
        from ocr_region import ocr_paragraphs, short_word_share, undecodable_lines

        page = box["page"]
        if not 0 < page <= len(self.page_layout) or page not in self.doc.pages:
            return False
        layout = self.page_layout[page - 1]
        width, height = layout.get("width") or 0, layout.get("height") or 0
        if not width or not height:
            return False
        lines = [
            line["text"] for line in layout["lines"]
            if box["x"] <= (line["xmin"] + line["xmax"]) / 2 / width <= box["x"] + box["width"]
            and box["y"] <= (line["ymin"] + line["ymax"]) / 2 / height <= box["y"] + box["height"]
            and (line["xmax"] - line["xmin"]) / width >= 0.6 * box["width"]
        ]
        if not undecodable_lines(lines):
            return False
        size = self.doc.pages[page].size
        paragraphs = ocr_paragraphs(self.pdf_path, page, box, size.width, size.height)
        if not paragraphs:
            self._diagnostic("warning", "text", "Undecodable text region kept as an image", "the text layer cannot be decoded and OCR is unavailable", item)
            return False
        texts = []
        for paragraph in paragraphs:
            text = paragraph[0]
            for line in paragraph[1:]:
                joined, fused = self._dehyphenate(text, line)
                text = joined if fused else f"{text} {line}"
            texts.append(sanitize(text))
        share = short_word_share(" ".join(texts))
        if share is None or share > 0.35:
            return False  # OCR read no more prose than the text layer
        self._flush()
        for text in texts:
            block = self._new_block("paragraph", item, text)
            block["evidence"]["boxes"] = [dict(box)]
            block["evidence"]["confidence"] = 0.8
            block["evidence"]["signals"] = ["ocr-undecodable-text-layer"]
            self.blocks.append(block)
            self.report.paragraphs += 1
        self.report.ocr_text_regions += 1
        self._diagnostic("info", "text", "Text region read by OCR", f"{len(texts)} paragraphs whose text layer cannot be decoded", item)
        return True

    def _recover_dropped_pages(self) -> None:
        """When the layout model returns almost no body text for a page that
        the PDF text layer fills, the page's text-layer lines become paragraphs
        (blank-line separated) in pdftotext's own reading order, inserted after
        the last block of the previous page. Marked as a fallback in evidence."""
        if not self.page_lines:
            return
        body_chars: dict[int, int] = {}
        for block in self.blocks:
            if block["kind"] != "furniture" and block["page"] is not None:
                body_chars[block["page"]] = body_chars.get(block["page"], 0) + len(block["text"])
        # running lines: short text repeated near page edges on three or more pages
        edge_counter: dict[str, set[int]] = {}
        for page_index, lines in enumerate(self.page_lines, start=1):
            for line in lines[:6] + lines[-6:]:
                key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", line.strip().lower()))
                if 6 <= len(key) <= 160:
                    edge_counter.setdefault(key, set()).add(page_index)
        running = {key for key, pages in edge_counter.items() if len(pages) >= 3}
        page_links = {}
        for link in self.links:
            if link.kind == "uri" and link.uri and SAFE_HREF_RE.match(link.uri):
                page_links.setdefault(link.page, []).append(link)
        for page_index, lines in enumerate(self.page_lines, start=1):
            if page_index not in self.doc.pages:
                continue
            source_chars = sum(len(line.strip()) for line in lines)
            if source_chars < 400 or body_chars.get(page_index, 0) >= 0.2 * source_chars:
                continue
            paragraphs: list[str] = []
            current: list[str] = []
            for line in lines:
                key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", line.strip().lower()))
                if key in running or PAGE_NUMBER_TEXT_RE.match(line):
                    continue
                if line.strip():
                    current.append(line.strip())
                elif current:
                    paragraphs.append(" ".join(current))
                    current = []
            if current:
                paragraphs.append(" ".join(current))
            insert_at = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > page_index), len(self.blocks))
            new_blocks = []
            for text in paragraphs:
                text = sanitize(text)
                if len(text) < 3 or PAGE_NUMBER_TEXT_RE.match(text):
                    continue
                runs: list[dict] = []
                spans: list[tuple[int, int]] = []
                for link in page_links.get(page_index, []):
                    for candidate in (link.uri, re.sub(r"^https?://", "", link.uri), link.text.rstrip(".,;") if link.text else ""):
                        if not candidate or len(candidate) < 4:
                            continue
                        match = loose_pattern(candidate).search(text)
                        if match and match.end() > match.start() and not any(not (match.end() <= a or match.start() >= b) for a, b in spans):
                            spans.append((match.start(), match.end()))
                            runs.append({"start": match.start(), "end": match.end(), "href": link.uri})
                            self.report.links_mapped += 1
                            self.report.links_unmapped = max(0, self.report.links_unmapped - 1)
                            break
                new_blocks.append(
                    {
                        "id": self._id(f"b-p{page_index}-fallback-{len(new_blocks) + 1}"),
                        "kind": "paragraph",
                        "text": text,
                        "page": page_index,
                        "order": 0,
                        "column": "single",
                        "inline": runs,
                        "evidence": {"confidence": 0.5, "pages": [page_index], "boxes": [], "sourceIds": [f"pdftotext-page-{page_index}"], "signals": ["text-layer-fallback", "layout-model-dropped-page"]},
                    }
                )
            if new_blocks:
                self.blocks[insert_at:insert_at] = new_blocks
                self.report.pages_recovered_from_text_layer += 1
                self.report.paragraphs += len(new_blocks)
                self._diagnostic("warning", "layout", "Page recovered from text layer", f"page {page_index}: layout model returned {body_chars.get(page_index, 0)} of {source_chars} characters", None, page_index)

    def _absorb_inline_prose_fragments(self, block: dict) -> None:
        """Transfer separately extracted source runs back into a repaired
        paragraph, retaining any donor text outside its source region.
        Original IDs identify provenance, not a unique normalized item."""
        if not getattr(self, "doc", None):
            return

        def contained(boxes, regions):
            return bool(boxes) and all(any(
                box["page"] == region["page"] and box["x"] >= region["x"] - 0.004
                and box["y"] >= region["y"] - 0.004
                and box["x"] + box["width"] <= region["x"] + region["width"] + 0.004
                and box["y"] + box["height"] <= region["y"] + region["height"] + 0.004
                for region in regions) for box in boxes)

        regions = list(block["evidence"]["boxes"])
        positions = [i for i, c in enumerate(block["text"]) if c.isascii() and c.isalnum()]
        compact = "".join(block["text"][i].lower() for i in positions)
        sources = {}
        for item, _ in self.doc.iterate_items():
            if not isinstance(item, TextItem):
                continue
            canonical = self._evidence(item)["sourceIds"][0]
            for sid in dict.fromkeys([canonical, self._source_id(item)]):
                sources.setdefault(sid, []).append(item)
        for donor in list(self.blocks):
            if donor is block or donor["kind"] not in ("paragraph", "heading"):
                continue
            donor_compact = re.sub(r"[^a-z0-9]", "", donor["text"].lower())
            entries = []
            unresolved = False
            for sid in donor["evidence"]["sourceIds"]:
                matches = [item for item in sources.get(sid, [])
                           if contained(self._boxes(item), donor["evidence"]["boxes"])
                           and re.sub(r"[^a-z0-9]", "", item.text.lower()) in donor_compact]
                if not matches:
                    unresolved = True
                    break
                entries.extend((sid, item) for item in matches)
            if unresolved:
                continue
            consumed = set()
            for sid, item in entries:
                boxes = self._boxes(item)
                if not contained(boxes, regions):
                    continue
                needle = re.sub(r"[^a-z0-9]", "", item.text.lower())
                literal = sanitize(item.text).strip()
                direct = block["text"].find(literal) if literal else -1
                if direct >= 0 and block["text"].find(literal, direct + 1) < 0:
                    start, end = direct, direct + len(literal)
                else:
                    offset = compact.find(needle) if needle else -1
                    if offset < 0 or compact.find(needle, offset + 1) >= 0:
                        continue
                    start, end = positions[offset], positions[offset + len(needle) - 1] + 1
                part = block["text"][start:end]
                for run in self._runs_for(item, part):
                    shifted = {**run, "start": run["start"] + start, "end": run["end"] + start}
                    if shifted not in block["inline"]:
                        block["inline"].append(shifted)
                canonical = self._evidence(item)["sourceIds"][0]
                if canonical not in block["evidence"]["sourceIds"]:
                    block["evidence"]["sourceIds"].append(canonical)
                block["evidence"]["boxes"].extend(box for box in boxes if box not in block["evidence"]["boxes"])
                block["evidence"]["pages"] = sorted(set(block["evidence"]["pages"] + [box["page"] for box in boxes]))
                block["evidence"]["signals"] = list(dict.fromkeys(block["evidence"].get("signals", []) + donor["evidence"].get("signals", []) + ["inline-source-fragments-integrated"]))
                consumed.add((sid, item.self_ref))
            if not consumed:
                continue
            remaining = [(sid, item) for sid, item in entries if (sid, item.self_ref) not in consumed]
            if not remaining:
                for relationship in self.relationships:
                    if relationship["from"] == donor["id"]:
                        relationship["from"] = block["id"]
                    relationship["to"] = [block["id"] if target == donor["id"] else target for target in relationship["to"]]
                self.blocks.remove(donor)
                if donor["kind"] == "paragraph":
                    self.report.paragraphs -= 1
                continue
            donor["text"], donor["inline"] = "", []
            donor["evidence"]["sourceIds"] = list(dict.fromkeys(self._evidence(item)["sourceIds"][0] for _, item in remaining))
            donor["evidence"]["boxes"] = []
            for sid, item in remaining:
                text = sanitize(item.text).strip()
                base = len(donor["text"]) + (1 if donor["text"] else 0)
                donor["text"] += (" " if donor["text"] else "") + text
                donor["inline"].extend({**run, "start": run["start"] + base, "end": run["end"] + base} for run in self._runs_for(item, text))
                donor["evidence"]["boxes"].extend(self._boxes(item))
            donor["evidence"]["pages"] = sorted({box["page"] for box in donor["evidence"]["boxes"]})
            donor["page"] = donor["evidence"]["pages"][0] if donor["evidence"]["pages"] else None
            if donor["kind"] != "heading" and TOP_LEVEL_HEADING_RE.fullmatch(donor["text"]):
                donor["kind"] = "heading"
                donor["attributes"] = {"level": 2}
                self.report.paragraphs -= 1
                self.report.headings += 1

    def _restore_missing_lines(self) -> None:
        """A text-layer line inside a paragraph's own box whose words the
        layout model did not carry (an italic title, a URL line) goes back
        into the paragraph after the line above it."""
        if not self.page_layout:
            return
        for block in list(self.blocks):
            if block["kind"] not in ("paragraph", "list-item") or block["page"] is None or not block["evidence"]["boxes"] or "text-layer-fallback" in (block["evidence"].get("signals") or []):
                continue
            box = block["evidence"]["boxes"][0]
            page_index = box["page"]
            if page_index - 1 >= len(self.page_layout):
                continue
            layout = self.page_layout[page_index - 1]
            width, height = layout.get("width") or 0, layout.get("height") or 0
            if not width or not height:
                continue
            compact_block = re.sub(r"[^a-z0-9]", "", block["text"].lower())
            page_compacts = [re.sub(r"[^a-z0-9]", "", other["text"].lower()) for other in self.blocks if other is not block and other["page"] == page_index and other["text"]]
            equation_boxes = [region for other in self.blocks if other["kind"] == "equation"
                              for region in other["evidence"]["boxes"] if region["page"] == page_index]
            lines = []
            for line in layout["lines"]:
                # Display-owned source remains in its equation block. A broad
                # paragraph box can surround that display without owning it.
                if any(min(line["xmax"] / width, region["x"] + region["width"]) > max(line["xmin"] / width, region["x"])
                       and min(line["ymax"] / height, region["y"] + region["height"]) > max(line["ymin"] / height, region["y"])
                       for region in equation_boxes):
                    continue
                cx, cy = (line["xmin"] + line["xmax"]) / 2 / width, (line["ymin"] + line["ymax"]) / 2 / height
                if box["x"] - 0.004 <= cx <= box["x"] + box["width"] + 0.004 and box["y"] - 0.004 <= cy <= box["y"] + box["height"] + 0.004:
                    lines.append(line)
            if not lines:
                continue
            lines.sort(key=lambda l: (l["ymin"], l["xmin"]))
            # A suspended compound's hyphen is semantic punctuation, even
            # though alphanumeric coverage treats `intraand` and `intra- and`
            # as identical. Restore only an exact source-line-attested phrase.
            for line in lines:
                source_line = sanitize(line["text"].strip())
                compact_line = re.sub(r"[^a-z0-9]", "", source_line.lower())
                if len(compact_line) < 12 or compact_line not in compact_block:
                    continue
                for compound in re.finditer(r"\b([A-Za-z]{2,})-\s+(and|or)\b", source_line):
                    first, conjunction = compound.groups()
                    pattern = r"(?<![A-Za-z])" + re.escape(first) + r"\s*" + conjunction + r"(?![A-Za-z])"
                    matches = list(re.finditer(pattern, block["text"]))
                    if len(matches) != 1:
                        continue
                    match = matches[0]
                    replacement = first + "- " + conjunction
                    delta = len(replacement) - (match.end() - match.start())
                    block["text"] = block["text"][:match.start()] + replacement + block["text"][match.end():]
                    for run in block["inline"]:
                        if run["start"] >= match.end():
                            run["start"] += delta
                            run["end"] += delta
                        elif run["end"] >= match.end():
                            run["end"] += delta
                    block["evidence"].setdefault("signals", []).append("source-suspended-compound-restored")
            if len(block["evidence"]["boxes"]) != 1:
                continue  # missing-line insertion needs an unambiguous single region
            # Whole-line containment cannot detect a missing clause on an
            # otherwise present line. Recover interior omissions only when the
            # entire emitted alphanumeric stream is an exact subsequence of
            # this one source region; reordered mathematics fails this check.
            from difflib import SequenceMatcher

            def indexed_compact(value):
                positions = [i for i, char in enumerate(value) if char.isascii() and char.isalnum()]
                return "".join(value[i].lower() for i in positions), positions

            source_lines = [sanitize(line["text"].strip()) for line in lines]
            page_text = self._page_text(page_index) if getattr(self, "source_text", None) else None
            if page_text:
                glyph_lines = [line.text for line in page_text.lines_in(box)]
                for position, source_line in enumerate(source_lines):
                    if not re.search(r"\b[A-Z] [A-Z]{2,}", source_line):
                        continue
                    compact_line, _ = indexed_compact(source_line)
                    for glyph_line in glyph_lines:
                        glyph_compact, glyph_positions = indexed_compact(glyph_line)
                        offset = glyph_compact.find(compact_line)
                        if offset >= 0:
                            source_lines[position] = glyph_line[glyph_positions[offset]:glyph_positions[offset + len(compact_line) - 1] + 1]
                            break
            source_region = re.sub(r"([A-Za-z])-\n(?=[a-z])", r"\1", "\n".join(source_lines)).replace("\n", " ")
            source_compact, source_positions = indexed_compact(source_region)
            emitted_compact, emitted_positions = indexed_compact(block["text"])
            edits = SequenceMatcher(None, source_compact, emitted_compact, autojunk=False).get_opcodes()
            recovered_clauses = 0
            if all(tag in ("equal", "delete") for tag, *_ in edits):
                for tag, a0, a1, b0, b1 in reversed(edits):
                    if tag != "delete" or a0 < 12 or len(source_compact) - a1 < 12 or a1 - a0 < 8 or b0 == 0 or b0 >= len(emitted_positions):
                        continue
                    start, end = emitted_positions[b0 - 1] + 1, emitted_positions[b0]
                    if block["text"][start:end].strip():
                        continue  # source text cannot silently replace existing punctuation
                    insertion = source_region[source_positions[a0 - 1] + 1:source_positions[a1]]
                    if not re.search(r"[A-Za-z]", insertion):
                        continue
                    block["text"] = block["text"][:start] + insertion + block["text"][end:]
                    delta = len(insertion) - (end - start)
                    for run in block["inline"]:
                        if run["start"] >= end:
                            run["start"] += delta
                            run["end"] += delta
                        elif run["end"] > start:
                            run["end"] += delta
                    recovered_clauses += 1
                if recovered_clauses:
                    self.report.lines_restored_from_text_layer += recovered_clauses
                    block["evidence"].setdefault("signals", []).append("source-inline-omissions-restored")
                    compact_block = re.sub(r"[^a-z0-9]", "", block["text"].lower())
                    self._absorb_inline_prose_fragments(block)
            inserted = 0
            for i, line in enumerate(lines):
                text = sanitize(line["text"].strip())
                compact = re.sub(r"[^a-z0-9]", "", text.lower())
                if len(compact) < 12 or compact[:24] in compact_block or compact[-24:] in compact_block:
                    continue
                if _line_words_present(text, compact_block) or any(_line_words_present(text, other) for other in page_compacts):
                    continue  # a line of mathematics whose symbols the text layer orders differently, already carried here or by a neighbour
                if any(re.sub(r"[^a-z0-9]", "", t.lower()) and re.sub(r"[^a-z0-9]", "", t.lower())[:24] in re.sub(r"[^a-z0-9]", "", other["text"].lower()) for other in self.blocks if other is not block and other["page"] == page_index for t in [text]):
                    continue  # the words live in another block (a caption, a note)
                # anchor: the tail of the line above, located in the block text
                position = len(block["text"])
                if i > 0:
                    anchor_words = re.findall(r"[A-Za-z0-9]+", lines[i - 1]["text"])[-3:]
                    if anchor_words:
                        match = None
                        for m in re.finditer(r"\s*".join(re.escape(w) for w in anchor_words), block["text"]):
                            match = m
                        if match:
                            position = match.end()
                else:
                    position = 0
                head, tail = block["text"][:position], block["text"][position:]
                joiner = "" if not head or head.endswith(" ") else " "
                insertion = joiner + text + ("" if not tail or tail.startswith(" ") else " ")
                block["text"] = head + insertion + tail
                shift = len(insertion)
                for run in block["inline"]:
                    if run["start"] >= position:
                        run["start"] += shift
                        run["end"] += shift
                    elif run["end"] > position:
                        run["end"] += shift
                compact_block = re.sub(r"[^a-z0-9]", "", block["text"].lower())
                inserted += 1
            if inserted:
                block["evidence"]["signals"] = list(dict.fromkeys((block["evidence"].get("signals") or []) + ["text-layer-lines-restored"]))
                self.report.lines_restored_from_text_layer += inserted
                self._diagnostic("info", "text", "Lines restored from the text layer", f"page {page_index}: {inserted} line(s) inside a paragraph's box that the layout model did not carry", None, page_index)

    def _recover_dropped_regions(self) -> None:
        """Text-layer lines the layout model returned no item for (an author
        line, a reference entry, a whole page) come back as paragraphs with
        their own boxes, in the position their geometry dictates. A line is
        recovered only when no layout item box covers it and no item on the
        page already carries its words."""
        if not self.page_layout:
            return
        covered: dict[int, list[tuple[float, float, float, float]]] = {}
        item_texts: dict[int, list[str]] = {}
        for item, _ in self.doc.iterate_items(included_content_layers={ContentLayer.BODY, ContentLayer.FURNITURE}):
            boxes = self._boxes(item)
            if not boxes:
                continue
            text = getattr(item, "text", None)
            compact_text = re.sub(r"[^a-z0-9]", "", text.lower()) if isinstance(text, str) and text.strip() else ""
            for box in boxes:
                covered.setdefault(box["page"], []).append((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
                if compact_text:
                    item_texts.setdefault(box["page"], []).append(compact_text)
        for block in self.blocks:
            if block["kind"] in ("figure", "table", "equation"):
                for box in block["evidence"]["boxes"]:
                    covered.setdefault(box["page"], []).append((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
        edge_counter: dict[str, set[int]] = {}
        for page_index, lines in enumerate(self.page_lines, start=1):
            for line in lines[:6] + lines[-6:]:
                key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", line.strip().lower()))
                if 6 <= len(key) <= 160:
                    edge_counter.setdefault(key, set()).add(page_index)
        running = {key for key, pages in edge_counter.items() if len(pages) >= 3}
        page_links: dict[int, list] = {}
        for link in self.links:
            if link.kind == "uri" and link.uri:
                page_links.setdefault(link.page, []).append(link)
        recovered_pages: set[int] = set()
        for page_index, layout in enumerate(self.page_layout, start=1):
            if page_index not in self.doc.pages or not layout.get("width") or not layout.get("height"):
                continue
            width, height = layout["width"], layout["height"]
            boxes = covered.get(page_index, [])
            texts = item_texts.get(page_index, [])
            page_text_joined = "\u0001".join(texts)
            page_text_joined = page_text_joined if texts else ""
            groups: list[list[dict]] = []
            for line in layout["lines"]:
                text = line["text"].strip()
                x0, y0, x1, y1 = line["xmin"] / width, line["ymin"] / height, line["xmax"] / width, line["ymax"] / height
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                if not text or cy < 0.05 or cy > 0.95:
                    continue
                key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
                if key in running or PAGE_NUMBER_TEXT_RE.match(text):
                    continue
                if any(bx0 - 0.004 <= cx <= bx1 + 0.004 and by0 - 0.004 <= cy <= by1 + 0.004 for bx0, by0, bx1, by1 in boxes):
                    continue
                compact = re.sub(r"[^a-z0-9]", "", text.lower())
                # the words are already carried by a layout item (a line pdftotext
                # merged across two columns, a hyphenation the extractor undid)
                if compact and ((len(compact) >= 20 and (compact[:40] in page_text_joined or compact[-40:] in page_text_joined)) or (len(compact) < 20 and f"\u0001{compact}\u0001" in f"\u0001{page_text_joined}\u0001")):
                    continue
                entry = {"text": text, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
                last = groups[-1][-1] if groups else None
                if last is not None and 0 <= y0 - last["y1"] <= 1.6 * max(last["y1"] - last["y0"], 0.005) and min(x1, last["x1"]) - max(x0, last["x0"]) > 0:
                    groups[-1].append(entry)
                else:
                    groups.append([entry])
            new_blocks: list[tuple[float, float, dict]] = []
            for group in groups:
                text = sanitize(" ".join(entry["text"] for entry in group))
                if len(text) < 20 or len(WORD_RE_ADAPTER.findall(text)) < 3:
                    continue
                gx0, gy0 = min(e["x0"] for e in group), min(e["y0"] for e in group)
                gx1, gy1 = max(e["x1"] for e in group), max(e["y1"] for e in group)
                runs: list[dict] = []
                spans: list[tuple[int, int]] = []
                for link in page_links.get(page_index, []):
                    l, b, r, t = link.rect
                    lcx, lcy = (l + r) / 2 / width, 1 - (b + t) / 2 / height
                    if not (gx0 - 0.01 <= lcx <= gx1 + 0.01 and gy0 - 0.01 <= lcy <= gy1 + 0.01):
                        continue
                    uri = normalize_uri(link.uri)
                    visible = link_visible_text(text, uri, link.text, link.group_text)
                    span = first_free_span(visible, text, spans) if visible else None
                    if span is None:
                        continue
                    spans.append(span)
                    runs.append({"start": span[0], "end": span[1], "href": uri})
                    self.report.links_mapped += 1
                    self.report.links_unmapped = max(0, self.report.links_unmapped - 1)
                block = {
                    "id": self._id(f"b-p{page_index}-region-{len(new_blocks) + 1}"),
                    "kind": "paragraph",
                    "text": text,
                    "page": page_index,
                    "order": 0,
                    "column": "single",
                    "inline": runs,
                    "evidence": {
                        "confidence": 0.5,
                        "pages": [page_index],
                        "boxes": [{"page": page_index, "x": round(gx0, 5), "y": round(gy0, 5), "width": round(gx1 - gx0, 5), "height": round(gy1 - gy0, 5), "rotation": 0}],
                        "sourceIds": [f"pdftotext-page-{page_index}"],
                        "signals": ["text-layer-fallback", "layout-model-dropped-region"],
                    },
                }
                new_blocks.append((gy0, gx0, block))
            if not new_blocks:
                continue
            for gy0, gx0, block in new_blocks:
                position = None
                for i, existing in enumerate(self.blocks):
                    if existing["page"] != page_index or not existing["evidence"]["boxes"] or existing["kind"] == "furniture":
                        continue
                    ebox = existing["evidence"]["boxes"][0]
                    same_column = min(ebox["x"] + ebox["width"], block["evidence"]["boxes"][0]["x"] + block["evidence"]["boxes"][0]["width"]) - max(ebox["x"], gx0) > 0
                    if same_column and ebox["y"] >= gy0:
                        position = i
                        break
                if position is None:
                    position = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > page_index), len(self.blocks))
                self.blocks.insert(position, block)
                self.report.paragraphs += 1
                self.report.regions_recovered_from_text_layer += 1
            layout_lines = sum(1 for line in layout["lines"] if line["text"].strip())
            if layout_lines and sum(len(g) for g in groups) >= 0.8 * layout_lines:
                recovered_pages.add(page_index)
            self._diagnostic("info", "layout", "Region recovered from text layer", f"page {page_index}: {len(new_blocks)} text-layer paragraph(s) the layout model returned no item for", None, page_index)
        self.report.pages_recovered_from_text_layer += len(recovered_pages)
