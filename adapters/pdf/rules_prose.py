"""Paragraph text: emission, splits, joins and dehyphenation.

What belongs here: rules that decide where a paragraph (or heading) starts and
ends. The walk-time emitters `_emit_paragraph` / `_emit_heading`; splitting a
layout item the model merged across places (a caption glued under a paragraph,
a stray lead word, a side-column tail, a first line merged across a page);
joining halves across column, page and float breaks (`_join_split_paragraphs`,
`_continuation_predecessor`) with hyphen and attested-word fusion; and cutting
chart labels or running footers glued to a paragraph's tail. Table notes glued
to a paragraph live in `rules_notes.py`; margin stamps glued to a paragraph's
head in `rules_furniture.py`.
"""

from __future__ import annotations

import re

from docling_core.types.doc import DocItemLabel, TextItem

from adapter_common import (
    APPENDIX_HEADING_RE,
    CAPTION_LIKE_RE,
    FIGURE_CAPTION_RE,
    FLOAT_KINDS,
    LOWER_START_RE,
    NUMBERED_HEADING_RE,
    TABLE_CAPTION_RE,
    TERMINAL_RE,
    TOP_LEVEL_HEADING_RE,
    VISIBLE_RE,
    heading_level,
    is_terminated,
    sanitize,
)


class ProseRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _dehyphenate(self, previous: str, following: str) -> tuple[str, bool]:
        head = re.search(r"([A-Za-z]+)-$", previous)
        tail = re.match(r"([a-z]+)", following)
        if not head or not tail:
            return previous + following, False
        fused = (head.group(1) + tail.group(1)).lower()
        if self._corpus_words is None:
            words: set[str] = set()
            for item, _ in self.doc.iterate_items():
                if isinstance(item, TextItem):
                    words.update(w.lower() for w in re.findall(r"[A-Za-z]{3,}", item.text))
            self._corpus_words = words
        if fused in self._corpus_words:
            return previous[:-1] + following, True
        return previous + following, False

    def _prov_segments(self, item) -> list[tuple[int, str]]:
        """(provenance index, text) per provenance entry, from the character
        spans the layout model recorded; one segment when there is only one."""
        prov = getattr(item, "prov", None) or []
        text = item.text or ""
        if len(prov) < 2:
            return [(0, text)]
        segments = []
        for index, entry in enumerate(prov):
            span = getattr(entry, "charspan", None)
            # the spans index the text before the model normalised it, and may
            # overshoot the text by a character or two: the starts still hold
            if not span or len(span) != 2 or span[1] <= span[0] or span[1] > len(text) + 3:
                return [(0, text)]
            segments.append((index, text[span[0] : min(span[1], len(text))]))
        return segments

    def _split_merged_caption(self, item: TextItem) -> bool:
        """A text item whose later provenance entries carry a `Figure N` /
        `Table N` caption is a paragraph the layout model merged with a
        caption: the caption segment becomes its own caption block with its
        own box, the rest stays a paragraph."""
        segments = self._prov_segments(item)
        if len(segments) < 2:
            return False
        caption_at = next((i for i, (_, text) in enumerate(segments) if (
            FIGURE_CAPTION_RE.match(text.strip()) or TABLE_CAPTION_RE.match(text.strip())
            or re.match(r"^(?:Listing|Algorithm|Program|Example|Box)\s*\d+[A-Za-z]?\s*[:.]", text.strip(), re.I)
        )), None)
        if caption_at is None:
            return False
        head = " ".join(text.strip() for _, text in segments[:caption_at] if text.strip())
        caption_end = caption_at + 1
        uncertain_from = None
        while caption_end < len(segments):
            previous_index, previous_text = segments[caption_end - 1]
            next_index, next_text = segments[caption_end]
            previous_box, next_box = self._box(item, previous_index), self._box(item, next_index)
            if (previous_box is None or next_box is None or previous_box["page"] != next_box["page"]
                or not -0.005 <= next_box["y"] - previous_box["y"] - previous_box["height"] <= 0.03
                or min(previous_box["x"] + previous_box["width"], next_box["x"] + next_box["width"]) <= max(previous_box["x"], next_box["x"])):
                break
            if is_terminated(previous_text) or not LOWER_START_RE.match(next_text.lstrip()):
                # A new sentence can still be the same caption when its glyph
                # size, left alignment and normal interline gap continue it.
                page_text = self._page_text(previous_box["page"]) if getattr(self, "source_text", None) else None
                before_sizes = sorted(line.height for line in page_text.lines_in(previous_box)) if page_text else []
                after_sizes = sorted(line.height for line in page_text.lines_in(next_box)) if page_text else []
                if not before_sizes or not after_sizes:
                    # Geometry cannot distinguish a new caption sentence from
                    # nearby body prose. Trust an explicit source caption label;
                    # otherwise preserve both spans and report uncertainty.
                    gap = next_box["y"] - previous_box["y"] - previous_box["height"]
                    if (abs(previous_box["x"] - next_box["x"]) > 0.004
                        or gap > 0.5 * min(previous_box["height"], next_box["height"])):
                        break
                    if item.label == DocItemLabel.CAPTION:
                        caption_end += 1
                        continue
                    uncertain_from = caption_end
                    self._diagnostic(
                        "error", "layout", "Caption continuation needs source review",
                        "Adjacent source spans may continue the caption or start body text. "
                        "Glyph evidence is unavailable and this source item is not labelled as a caption; "
                        "the spans remain separate and their role is explicitly uncertain.",
                        None, next_box["page"],
                    )
                    self.diagnostics[-1]["sourceIds"] = self._evidence(item)["sourceIds"]
                    break
                before_size, after_size = before_sizes[len(before_sizes) // 2], after_sizes[len(after_sizes) // 2]
                page_height = self.doc.pages[previous_box["page"]].size.height
                if (abs(before_size - after_size) > 0.1 * before_size
                    or abs(previous_box["x"] - next_box["x"]) > 0.004
                    or next_box["y"] - previous_box["y"] - previous_box["height"] > 0.5 * before_size / page_height):
                    break
            caption_end += 1
        caption_parts = segments[caption_at:caption_end]
        self._flush()
        if head:
            block = self._new_block("paragraph", item, sanitize(head))
            block["evidence"]["boxes"] = [b for i, (index, _) in enumerate(segments[:caption_at]) for b in ([self._box(item, index)] if self._box(item, index) else [])]
            block["evidence"]["pages"] = sorted({b["page"] for b in block["evidence"]["boxes"]}) or block["evidence"]["pages"]
            block["inline"] = self._runs_for(item, block["text"])
            self.blocks.append(block)
            self.report.paragraphs += 1
        caption_text = sanitize(" ".join(text.strip() for _, text in caption_parts if text.strip()))
        caption = self._new_block("caption", item, caption_text)
        caption["evidence"]["boxes"] = [b for index, _ in caption_parts for b in ([self._box(item, index)] if self._box(item, index) else [])]
        caption["evidence"]["pages"] = sorted({b["page"] for b in caption["evidence"]["boxes"]}) or caption["evidence"]["pages"]
        caption["page"] = caption["evidence"]["pages"][0] if caption["evidence"]["pages"] else caption["page"]
        caption["inline"] = self._runs_for(item, caption_text)
        self.blocks.append(caption)
        self.report.orphan_captions += 1
        self.report.captions_split_from_merged_items += 1
        # The caption's role does not propagate into later, distinct source
        # regions. Keep those regions in body flow with their own provenance.
        for position, (index, text) in enumerate(segments[caption_end:], start=caption_end):
            text = sanitize(text).strip()
            if not text:
                continue
            body = self._new_block("paragraph", item, text)
            box = self._box(item, index)
            body["evidence"]["boxes"] = [box] if box else []
            body["evidence"]["pages"] = [box["page"]] if box else []
            body["page"] = box["page"] if box else self._page_of(item)
            body["inline"] = self._runs_for(item, text)
            if uncertain_from is not None and position >= uncertain_from:
                body["evidence"]["confidence"] = 0.5
                body["evidence"]["signals"].append("caption-or-body-role-uncertain")
            self.blocks.append(body)
            self.report.paragraphs += 1
        return True

    def _split_stray_lead(self, item: TextItem) -> bool:
        """`and` between two display equations on one page and `Corollary 4.35
        …` at the top of the next came back as one item: the layout model
        glued a stray word to the paragraph that follows it. When the first
        provenance box holds no more than three words, the rest sits on a
        later page, and body text still lies below the stray words in their
        column, the words stay a paragraph of their own where they are and
        the rest is a paragraph on its own page."""
        segments = self._prov_segments(item)
        if len(segments) < 2:
            return False
        lead_index, lead = segments[0]
        lead = sanitize(lead).strip()
        if not lead or len(lead.split()) > 3 or len(lead) > 24:
            return False
        lead_box = self._box(item, lead_index)
        next_box = self._box(item, segments[1][0])
        if lead_box is None or next_box is None or next_box["page"] <= lead_box["page"]:
            return False
        if not self._body_text_below(lead_box):
            return False
        rest = sanitize(" ".join(text.strip() for _, text in segments[1:] if text.strip()))
        if not rest:
            return False
        self._flush()
        stray = self._new_block("paragraph", item, lead)
        stray["evidence"]["boxes"] = [lead_box]
        stray["evidence"]["pages"] = [lead_box["page"]]
        stray["inline"] = self._runs_for(item, lead)
        self.blocks.append(stray)
        self.report.paragraphs += 1
        body = self._new_block("paragraph", item, rest)
        body["evidence"]["boxes"] = [b for index, _ in segments[1:] for b in ([self._box(item, index)] if self._box(item, index) else [])]
        body["evidence"]["pages"] = sorted({b["page"] for b in body["evidence"]["boxes"]}) or [next_box["page"]]
        body["page"] = body["evidence"]["pages"][0]
        body["inline"] = self._runs_for(item, rest)
        self._pending = body
        self.report.stray_leads_split += 1
        return True

    @staticmethod
    def _is_side_column(box: dict, body: dict) -> bool:
        """Whether a box belongs to a narrow column beside the body's, the way
        a journal's first-page metadata sidebar (`Funding:`, `Competing
        interests:`) sits beside the article: no more than two thirds of the
        body box's width, and no horizontal overlap with it at all. The
        second test is what keeps an ordinary two-column flow out — there the
        columns are disjoint but equally wide."""
        if box["width"] > 0.65 * body["width"]:
            return False
        return box["x"] + box["width"] <= body["x"] or box["x"] >= body["x"] + body["width"]

    def _split_side_column_tail(self, item: TextItem) -> bool:
        """The layout model sometimes continues a body paragraph into the
        narrow sidebar beside it, gluing the journal's funding statement onto
        the end of the article's first sentence. A provenance box in a side
        column ends the paragraph: from there the text is that column's, and
        it becomes a paragraph of its own."""
        segments = self._prov_segments(item)
        if len(segments) < 2:
            return False
        body = self._box(item, segments[0][0])
        if body is None:
            return False
        cut_at = None
        for position, (index, _) in enumerate(segments[1:], start=1):
            box = self._box(item, index)
            if box is not None and self._is_side_column(box, body):
                cut_at = position
                break
        if cut_at is None:
            return False
        head = sanitize(" ".join(text.strip() for _, text in segments[:cut_at] if text.strip()))
        tail = sanitize(" ".join(text.strip() for _, text in segments[cut_at:] if text.strip()))
        if len(head) < 40 or len(tail) < 20:
            return False
        self._flush()
        block = self._new_block("paragraph", item, head)
        block["evidence"]["boxes"] = [b for index, _ in segments[:cut_at] for b in ([self._box(item, index)] if self._box(item, index) else [])]
        block["evidence"]["pages"] = sorted({b["page"] for b in block["evidence"]["boxes"]}) or block["evidence"]["pages"]
        block["inline"] = self._runs_for(item, head)
        self.blocks.append(block)
        self.report.paragraphs += 1
        aside_boxes = [b for index, _ in segments[cut_at:] for b in ([self._box(item, index)] if self._box(item, index) else [])]
        runs = self._runs_for(item, tail)
        owner = self._side_column_owner(aside_boxes[0]) if aside_boxes else None
        if owner is not None:
            # the entry this text continues, still open in its own column
            base = len(owner["text"].rstrip()) + 1
            owner["text"] = owner["text"].rstrip() + " " + tail
            owner["inline"].extend({**run, "start": run["start"] + base, "end": run["end"] + base} for run in runs)
            owner["evidence"]["boxes"].extend(aside_boxes)
            owner["evidence"]["pages"] = sorted(set(owner["evidence"]["pages"] + [b["page"] for b in aside_boxes]))
            self.report.joins += 1
        else:
            aside = self._new_block("paragraph", item, tail)
            aside["evidence"]["boxes"] = aside_boxes
            aside["evidence"]["pages"] = sorted({b["page"] for b in aside_boxes}) or aside["evidence"]["pages"]
            aside["page"] = aside["evidence"]["pages"][0] if aside["evidence"]["pages"] else aside["page"]
            aside["inline"] = runs
            aside["evidence"]["signals"] = list(dict.fromkeys((aside["evidence"].get("signals") or []) + ["side-column-aside"]))
            self.blocks.append(aside)
            self.report.paragraphs += 1
        self.report.side_column_tails_split += 1
        return True

    def _side_column_owner(self, box: dict) -> dict | None:
        """The entry a cut side-column segment continues: the last paragraph
        behind it whose own column is this one (their boxes overlap
        horizontally by most of the narrower box) and whose sentence is still
        open. The body's columns never qualify — they do not overlap it."""
        for candidate in reversed(self.blocks):
            if candidate["kind"] != "paragraph" or not candidate["evidence"]["boxes"]:
                continue
            other = candidate["evidence"]["boxes"][0]
            overlap = min(other["x"] + other["width"], box["x"] + box["width"]) - max(other["x"], box["x"])
            if overlap < 0.6 * min(other["width"], box["width"]):
                continue
            return candidate if not is_terminated(candidate["text"]) else None
        return None

    def _body_text_below(self, box: dict) -> bool:
        """Whether a text item of the body lies below a box in its column on
        the same page: the box is then not the last line of that page."""
        for other, _ in self.doc.iterate_items():
            if not isinstance(other, TextItem) or not (other.text or "").strip():
                continue
            if str(getattr(other, "label", "")).endswith(("page_header", "page_footer")):
                continue
            for obox in self._boxes(other):
                if obox["page"] != box["page"] or obox["y"] < box["y"] + box["height"]:
                    continue
                if min(obox["x"] + obox["width"], box["x"] + box["width"]) - max(obox["x"], box["x"]) > 0:
                    return True
        return False

    def _is_description_item(self, item: TextItem, text: str) -> bool:
        """`resolved_on_timestamp : the time at which …`: a description-list
        entry whose term is set in a monospace face (`\\item[term]`)."""
        match = re.match(r"^([A-Za-z_][\w.\-]*(?:\s[A-Za-z_][\w.\-]*){0,3})\s*:\s+\S", text.strip())
        if not match:
            return False
        page_text = self._page_text(self._page_of(item))
        box = self._box(item)
        if page_text is None or box is None:
            return False
        share = page_text.font_share(box)
        return share["total"] >= 10 and 0.1 <= share["mono"] < 0.8

    def _emit_paragraph(self, item: TextItem) -> None:
        if not VISIBLE_RE.search(sanitize(item.text)):
            self.report.invisible_items_dropped += 1
            return
        if self._figure_foot_line(item):
            return
        if self._split_merged_caption(item):
            return
        if self._split_stray_lead(item):
            return
        if self._split_side_column_tail(item):
            return
        if self._split_table_note_tail(item):
            return
        if self._is_description_item(item, sanitize(item.text)):
            self._flush()
            block = self._new_block("list-item", item, sanitize(item.text).strip())
            block["inline"] = self._runs_for(item, block["text"])
            block["attributes"] = {"ordered": False, "listId": f"deflist-p{self._page_of(item)}"}
            self.blocks.append(block)
            self.report.description_items += 1
            return
        if self._is_edge_page_number(item):
            self.report.edge_page_numbers_dropped += 1
            self._furniture_block(item, "incrementing-numeral")
            return
        text = sanitize(item.text)
        if self._emit_monospace_code(item, text):
            return
        runs = self._runs_for(item, text)
        if self._in_abstract:
            self.abstract_parts.append(text.strip())
        pending = self._pending
        resumed = False
        if pending is None and LOWER_START_RE.match(text.lstrip()):
            # A paragraph interrupted by floats: the last paragraph block sits
            # behind up to three figure/table/caption/equation/footnote blocks.
            for back in range(1, 5):
                if back > len(self.blocks):
                    break
                candidate = self.blocks[-back]
                if candidate["kind"] == "paragraph":
                    between = self.blocks[len(self.blocks) - back + 1 :]
                    if between and all(b["kind"] in FLOAT_KINDS - {"equation"} for b in between) and not is_terminated(candidate["text"]):
                        pending = candidate
                        resumed = True
                    break
                if candidate["kind"] not in FLOAT_KINDS - {"equation"}:
                    break
        if pending is not None and not is_terminated(pending["text"]) and (LOWER_START_RE.match(text.lstrip()) or pending["text"].rstrip().endswith("-")):
            previous = pending["text"].rstrip()
            following = text.lstrip()
            offset_shift = len(text) - len(following)
            if previous.endswith("-"):
                joined, dropped = self._dehyphenate(previous, following)
                if dropped:
                    self.report.joins_dehyphenated += 1
                base = len(previous) - (1 if dropped else 0)
            else:
                fused = self._fuse_words(previous, following)
                if fused is not None:
                    # `op` + `timization`: the hyphen the layout model dropped
                    joined, base = fused, len(previous)
                    self.report.joins_fused_words += 1
                else:
                    joined = previous + " " + following
                    base = len(previous) + 1
            pending["text"] = joined
            for run in runs:
                pending["inline"].append({**run, "start": run["start"] - offset_shift + base, "end": run["end"] - offset_shift + base})
            incoming = self._evidence(item)
            pending["evidence"]["pages"] = sorted(set(pending["evidence"]["pages"] + incoming["pages"]))
            pending["evidence"]["boxes"].extend(box for box in incoming["boxes"] if box not in pending["evidence"]["boxes"])
            pending["evidence"]["sourceIds"] = list(dict.fromkeys(pending["evidence"]["sourceIds"] + incoming["sourceIds"]))
            self.report.joins += 1
            if resumed:
                self.report.float_resumptions += 1
            return
        self._flush()
        block = self._new_block("paragraph", item, text)
        block["inline"] = runs
        self._pending = block

    def _emit_heading(self, item: TextItem) -> None:
        text = sanitize(item.text.strip())
        if not text:
            return
        if (FIGURE_CAPTION_RE.match(text) or TABLE_CAPTION_RE.match(text)) and len(text) < 1200 and self.title_seen:
            # a caption the layout model called a section heading
            self._flush()
            block = self._new_block("caption", item, text)
            block["inline"] = self._runs_for(item, text)
            self.blocks.append(block)
            self.report.orphan_captions += 1
            return
        if not self.title_seen and not self._has_title_item and self._page_of(item) == 1 and not TOP_LEVEL_HEADING_RE.match(text):
            candidate_words = len(text.split())
            if self._title_candidate is None:
                self._title_candidate = (text, item)
                if candidate_words >= 3:
                    self.title_seen = True
                    self.title = text
                    return
                return  # a short banner such as "OPEN FORUM": wait for a real title
            previous_text, previous_item = self._title_candidate
            if candidate_words >= 3:
                # the banner becomes an ordinary paragraph ahead of the title
                banner = self._new_block("paragraph", previous_item, previous_text)
                self.blocks.insert(0, banner)
                self.report.paragraphs += 1
                self.title_seen = True
                self.title = text
                return
        if not self.title_seen and self._title_candidate is not None:
            # no multi-word title on page 1: keep the first heading as the title
            self.title_seen = True
            self.title = self._title_candidate[0]
        if len(text) > 110 or (re.search(r"[.!?]\s+\S", text) and len(text.split()) > 10):
            # a bold lead-in ("Outlining Prompts. Dialogues where …") is a
            # paragraph whose first words are set in bold, not a section
            self.report.headings_demoted_to_paragraph += 1
            self._emit_paragraph(item)
            return
        self._flush()
        self._in_abstract = bool(re.match(r"^abstract\b", text, re.IGNORECASE))
        level = heading_level(text, getattr(item, "level", None), self._last_numbered_level)
        if NUMBERED_HEADING_RE.match(text) or APPENDIX_HEADING_RE.match(text):
            self._last_numbered_level = level
        block = self._new_block("heading", item, text, attributes={"level": min(level + 1, 6)})
        # a heading keeps the hyperlinks under it (`S1 Data.` in a journal's
        # supporting-information list); its face is the heading style, not a run
        block["inline"] = self._runs_for(item, text, styles=False)
        self.blocks.append(block)
        self.report.headings += 1

    def _fuse_words(self, previous: str, following: str) -> str | None:
        """`eval` + `uation` -> `evaluation` when the fused word is attested in
        the paper, letter for letter: `LLM` + `agents` is not `LLMAgents`, a
        heading the layout model ran together; otherwise None."""
        head = re.search(r"([A-Za-z]+)$", previous)
        tail = re.match(r"([a-z]+)", following)
        if not head or not tail:
            return None
        if self._corpus_forms is None:
            forms: set[str] = set()
            for item, _ in self.doc.iterate_items():
                if isinstance(item, TextItem):
                    forms.update(re.findall(r"[A-Za-z]{3,}", item.text))
            self._corpus_forms = forms
        fused = head.group(1) + tail.group(1)
        if fused in self._corpus_forms and fused != head.group(1) and fused != tail.group(1):
            return previous + following
        return None

    def _continuation_predecessor(self, index: int, before: int | None = None) -> tuple[dict | None, str]:
        """The block a lowercase-starting paragraph continues: the nearest
        unterminated paragraph or list item behind it (this page or the
        previous one), looking past floats, listings, list items, listing
        captions typeset as headings, and up to three complete paragraphs
        that belong to another column's flow. A figure whose caption is
        unterminated and sits just above the paragraph is a split caption.
        A paragraph standing inside a run of list entries on its page may
        also look past the headings the layout model read between two
        columns of one reference list, but only to a hyphen-ended entry of
        that list. `before` restarts the search behind an earlier find."""
        block = self.blocks[index]
        skip = FLOAT_KINDS | {"furniture", "code"}
        back = (before if before is not None else index) - 1
        complete_skipped = 0
        entries_skipped = 0
        asides_skipped = 0
        box = block["evidence"]["boxes"][0] if block["evidence"]["boxes"] else None
        prose_between = False
        following = self.blocks[index + 1] if index + 1 < len(self.blocks) else None
        in_entries = block["kind"] == "paragraph" and following is not None and following["kind"] == "list-item" and following["page"] == block["page"]
        past_heading = False
        while back >= 0 and index - back <= (48 if entries_skipped else (24 if past_heading or asides_skipped else 16)):
            candidate = self.blocks[back]
            if "caption-or-body-role-uncertain" in candidate["evidence"].get("signals", []):
                break  # neither joining to nor looking past an unresolved source role is justified
            if candidate["page"] is None or block["page"] is None:
                break
            # a page of floats between the halves is still one sentence
            if block["page"] - candidate["page"] > (1 if prose_between else 2):
                break
            kind = candidate["kind"]
            if kind == "figure" and candidate["text"] and not is_terminated(candidate["text"]) and candidate["page"] == block["page"] and box and candidate["evidence"]["boxes"]:
                fbox = candidate["evidence"]["boxes"][0]
                if -0.01 <= box["y"] - (fbox["y"] + fbox["height"]) <= 0.12 and index - back <= 3:
                    return candidate, "caption"
            if kind == "equation":
                break  # display mathematics remains between its surrounding prose
            if kind in skip:
                back -= 1
                continue
            if kind == "heading":
                if CAPTION_LIKE_RE.match(candidate["text"]) or self._heading_belongs_to_float(back):
                    back -= 1
                    continue
                if in_entries and candidate["page"] == block["page"]:
                    past_heading = True
                    back -= 1
                    continue
                break
            if kind not in ("paragraph", "list-item"):
                break
            if past_heading:
                # beyond the headings only the list's own hyphen-ended entry can be the first half
                if kind == "list-item" and candidate["page"] == block["page"] and candidate["text"].rstrip().endswith("-"):
                    return candidate, kind
                back -= 1
                continue
            if kind == "list-item" and is_terminated(candidate["text"]):
                # A reference list or an enumerated block between the halves is
                # not another column's prose flow — it is a run the eye skips,
                # like a float. It gets its own budget so a sentence broken
                # across a bibliography can still find its first half; the join
                # itself still has to satisfy the hyphen or attested-word test.
                entries_skipped += 1
                if entries_skipped > 32:
                    break
                back -= 1
                continue
            if is_terminated(candidate["text"]):
                candidate_box = candidate["evidence"]["boxes"][0] if candidate["evidence"]["boxes"] else None
                if box is not None and candidate_box is not None and self._is_side_column(candidate_box, box):
                    # a journal's first-page sidebar beside the article: matter the
                    # eye skips, like a float, not the other column's prose flow
                    asides_skipped += 1
                    if asides_skipped > 8:
                        break
                    back -= 1
                    continue
                complete_skipped += 1
                prose_between = True
                if complete_skipped > 3:
                    break
                back -= 1
                continue
            return candidate, kind
        return None, ""

    def _heading_belongs_to_float(self, index: int) -> bool:
        """A short heading directly above a figure, table or listing on the
        same page is that float's own title (a screenshot's caption bar, a
        listing name), not a section boundary."""
        heading = self.blocks[index]
        if len(heading["text"].split()) > 6 or not heading["evidence"]["boxes"]:
            return False
        for j in range(index + 1, min(index + 3, len(self.blocks))):
            nxt = self.blocks[j]
            if nxt["kind"] == "furniture":
                continue
            if nxt["kind"] not in ("figure", "table", "code") or nxt["page"] != heading["page"] or not nxt["evidence"]["boxes"]:
                return False
            hbox, nbox = heading["evidence"]["boxes"][0], nxt["evidence"]["boxes"][0]
            return -0.01 <= nbox["y"] - (hbox["y"] + hbox["height"]) <= 0.03
        return False

    def _join_split_paragraphs(self) -> None:
        """Post-pass join for paragraphs split by floats or furniture that were
        only classified after the walk: the continuation starts lowercase and
        its predecessor lacks terminal punctuation (or the two halves fuse
        into an attested word). Complete paragraphs in between belong to
        another column's flow."""
        index = 1
        while index < len(self.blocks):
            block = self.blocks[index]
            if block["kind"] != "paragraph" or not LOWER_START_RE.match(block["text"].lstrip()):
                index += 1
                continue
            if "caption-or-body-role-uncertain" in (block["evidence"].get("signals") or []):
                index += 1
                continue  # unresolved source role cannot authorize a prose join
            if "side-column-aside" in (block["evidence"].get("signals") or []):
                index += 1
                continue  # the sidebar's own words, just cut from the body: not a continuation of it
            previous, how = self._continuation_predecessor(index)
            if previous is None:
                index += 1
                continue
            prev_text = previous["text"].rstrip()
            following = block["text"].lstrip()
            if prev_text.endswith("-") and how != "caption" and not self._dehyphenate(prev_text, following)[1]:
                # two hyphen-ended halves compete: the one whose fusion the paper attests wins
                # (`com-` + `plex` over `higher-` + `plex`, the reference entry that lay between)
                alternative, alternative_how = self._continuation_predecessor(index, before=self.blocks.index(previous))
                if alternative is not None and alternative["text"].rstrip().endswith("-") and self._dehyphenate(alternative["text"].rstrip(), following)[1]:
                    previous, how, prev_text = alternative, alternative_how, alternative["text"].rstrip()
                    self.report.joins_attested_over_nearer += 1
            shift = len(block["text"]) - len(following)
            if prev_text.endswith("-"):
                joined, dropped = self._dehyphenate(prev_text, following)
                base = len(prev_text) - (1 if dropped else 0)
            else:
                fused = self._fuse_words(prev_text, following)
                if fused is not None:
                    joined, base = fused, len(prev_text)
                    self.report.joins_fused_words += 1
                else:
                    joined, base = prev_text + " " + following, len(prev_text) + 1
            previous["text"] = joined
            for run in block["inline"]:
                previous["inline"].append({**run, "start": run["start"] - shift + base, "end": run["end"] - shift + base})
            previous["evidence"]["pages"] = sorted(set(previous["evidence"]["pages"] + block["evidence"]["pages"]))
            if how != "caption":
                previous["evidence"]["boxes"].extend(block["evidence"]["boxes"])
            previous["evidence"]["sourceIds"] = list(dict.fromkeys(previous["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
            # relationships pointing at the absorbed block now point at the survivor
            for relationship in self.relationships:
                if relationship["from"] == block["id"]:
                    relationship["from"] = previous["id"]
                relationship["to"] = [previous["id"] if t == block["id"] else t for t in relationship["to"]]
            del self.blocks[index]
            self.report.paragraphs -= 1
            self.report.joins += 1
            self.report.post_pass_joins += 1
            if how == "caption":
                self.report.caption_continuations_joined += 1
            elif how == "list-item":
                self.report.list_item_continuations_joined += 1

    def _strip_glued_tails(self) -> None:
        """The layout model sometimes appends a running footer (`Preprint.`) or
        a chart label from a neighbouring figure (`UMAP Dimension 1 (a.u.)`)
        to the last line of a paragraph; the glued words end the paragraph
        with punctuation that is not the sentence's. They are cut when they
        match a furniture text or a text line inside a figure on the page."""
        # A later provenance span may belong wholly to artwork on another
        # column or page. Its text need not be a whole extracted line (the
        # text layer may combine adjacent labels), so use the item's exact
        # character span and the retained crop as independent evidence.
        sources = {self._source_id(item): item for item, _ in self.doc.iterate_items()
                   if isinstance(item, TextItem) and len(item.prov) > 1}
        for block in self.blocks:
            if block["kind"] != "paragraph":
                continue
            for sid in block["evidence"]["sourceIds"]:
                item = sources.get(sid)
                if item is None:
                    continue
                segments = self._prov_segments(item)
                if len(segments) < 2:
                    continue
                index, tail = segments[-1]
                tail = sanitize(tail).strip()
                box = self._box(item, index)
                if not tail or not box or not block["text"].rstrip().endswith(tail):
                    continue
                owner = None
                for figure in self.blocks:
                    if figure["kind"] != "figure" or not figure.get("fallbackAssetIds"):
                        continue
                    for fbox in figure["evidence"]["boxes"]:
                        # an axis title sits just outside the detected picture, as the
                        # text-line rule below allows (0.02 beside, 0.04 under)
                        if (fbox["page"] == box["page"] and box["x"] >= fbox["x"] - 0.02
                            and box["x"] + box["width"] <= fbox["x"] + fbox["width"] + 0.02
                            and box["y"] >= fbox["y"] - 0.02
                            and box["y"] + box["height"] <= fbox["y"] + fbox["height"] + 0.04):
                            owner, owner_box = figure, fbox
                            break
                if owner is None:
                    continue
                cut = len(block["text"].rstrip()) - len(tail)
                head = block["text"][:cut].rstrip()
                if len(head) < 40 or is_terminated(head) or any(
                    run["end"] > len(head) and (run.get("href") or run.get("kind") == "note-reference")
                    for run in block["inline"]
                ):
                    continue
                block["text"] = head
                block["inline"] = [{**run, "end": min(run["end"], len(head))}
                                   for run in block["inline"] if run["start"] < len(head)]
                block["evidence"]["boxes"] = [b for b in block["evidence"]["boxes"] if b != box]
                block["evidence"]["pages"] = sorted({b["page"] for b in block["evidence"]["boxes"]})
                owner["evidence"]["sourceIds"] = list(dict.fromkeys(owner["evidence"]["sourceIds"] + [sid]))
                if not (box["x"] >= owner_box["x"] and box["y"] >= owner_box["y"]
                        and box["x"] + box["width"] <= owner_box["x"] + owner_box["width"]
                        and box["y"] + box["height"] <= owner_box["y"] + owner_box["height"]):
                    # the label cut from the prose must still be seen: widen the crop to it
                    self._recrop_figure(owner, min(owner_box["x"], box["x"]) - 0.002, min(owner_box["y"], box["y"]) - 0.002,
                                        max(owner_box["x"] + owner_box["width"], box["x"] + box["width"]) + 0.002,
                                        max(owner_box["y"] + owner_box["height"], box["y"] + box["height"]) + 0.002)
                owner["evidence"].setdefault("signals", []).append("glued-label-retained-in-crop")
                self.report.glued_tails_stripped += 1
        furniture_texts = {
            re.sub(r"[\s.]+$", "", b["text"].strip().lower())
            for b in self.blocks
            if b["kind"] == "furniture" and 3 <= len(b["text"].strip()) <= 40
        }
        for block in self.blocks:
            if block["kind"] != "paragraph" or block["page"] is None or len(block["text"]) < 60:
                continue
            text = block["text"].rstrip()
            lowered = text.lower()
            tails: list[str] = []
            for furniture in furniture_texts:
                if furniture and re.search(r"(?<![a-z0-9])" + re.escape(furniture) + r"\.?$", lowered) and not lowered.endswith("." + furniture):
                    tails.append(furniture)
            for figure in self.blocks:
                if figure["kind"] != "figure" or figure["page"] not in (block["page"], block["page"] + 1) or not figure["evidence"]["boxes"] or not figure.get("fallbackAssetIds"):
                    continue
                fbox = figure["evidence"]["boxes"][0]
                for _, _, line in self._lines_in(fbox["page"], fbox["x"], fbox["y"], fbox["x"] + fbox["width"], fbox["y"] + fbox["height"]):
                    line = line.strip().lower()
                    if len(line) >= 6 and lowered.endswith(line) and not lowered.endswith("." + line):
                        tails.append(line)
            if not tails:
                continue
            tail = max(tails, key=len)
            cut = lowered.rfind(tail, 0, len(lowered))
            if cut <= 20:
                continue
            head = text[:cut].rstrip()
            if TERMINAL_RE.search(head) or any(
                run["end"] > len(head) and (run.get("href") or run.get("kind") == "note-reference")
                for run in block["inline"]
            ):
                continue  # a complete sentence before it: the words are the paragraph's own (a DOI in a reference block)
            block["text"] = head
            block["inline"] = [{**run, "end": min(run["end"], len(head))}
                               for run in block["inline"] if run["start"] < len(head)]
            self.report.glued_tails_stripped += 1

    def _split_cross_page_spans(self) -> None:
        """A text item whose first line stands mid-page, with the page's body
        continuing under it, and whose second line opens the next page with a
        capitalised sentence, was merged by the layout model across two places
        (`and, for n ≥ 3,` between two display equations, `Proof. By
        Proposition 4.16 …` overleaf). The first line becomes its own paragraph
        before the block under it; the second stays where the walk put it."""
        items = {self._source_id(item): item for item, _ in self.doc.iterate_items() if isinstance(item, TextItem) and len(item.prov) == 2}
        for block in list(self.blocks):
            if block["kind"] != "paragraph" or len(block["evidence"]["sourceIds"]) != 1:
                continue
            item = items.get(block["evidence"]["sourceIds"][0])
            if item is None:
                continue
            segments = self._prov_segments(item)
            if len(segments) != 2:
                continue
            (first_index, head), (second_index, tail) = segments
            head, tail = sanitize(head).strip(), sanitize(tail).strip()
            first, second = self._box(item, first_index), self._box(item, second_index)
            if not head or not tail or not first or not second or second["page"] != first["page"] + 1:
                continue
            if not re.match(r"[A-Z]", tail) or not block["text"].startswith(head) or not block["text"].endswith(tail):
                continue
            bottom = first["y"] + first["height"]
            # the column the line opens: a short line and a centred display
            # equation under it need not overlap
            column = {**first, "width": max(first["width"], 0.4)}
            below = [
                other for other in self.blocks
                if other is not block and other["kind"] not in ("furniture", "footnote") and other["page"] == first["page"] and other["evidence"]["boxes"]
                and other["evidence"]["boxes"][0]["page"] == first["page"] and other["evidence"]["boxes"][0]["y"] >= bottom - 0.002
                and min(column["x"] + column["width"], other["evidence"]["boxes"][0]["x"] + other["evidence"]["boxes"][0]["width"]) - max(column["x"], other["evidence"]["boxes"][0]["x"]) > 0
            ]
            if not below:
                continue  # the line closes its page: an ordinary page-break continuation
            anchor = min(below, key=lambda other: other["evidence"]["boxes"][0]["y"])
            lead = self._new_block("paragraph", item, head)
            lead["id"] = self._id(f"{block['id']}-lead")
            lead["page"] = first["page"]
            lead["evidence"]["boxes"], lead["evidence"]["pages"] = [first], [first["page"]]
            lead["evidence"]["signals"].append("cross-page-merge-split")
            lead["inline"] = self._runs_for(item, head)
            block["text"] = tail
            block["page"] = second["page"]
            block["evidence"]["boxes"], block["evidence"]["pages"] = [second], [second["page"]]
            block["evidence"]["signals"].append("cross-page-merge-split")
            block["inline"] = self._runs_for(item, tail)
            self.blocks.insert(self.blocks.index(anchor), lead)
            self.report.paragraphs += 1
