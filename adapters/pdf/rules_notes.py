"""Footnotes, note markers and table notes.

What belongs here: emitting footnote items (and demoting the paratext,
captions and list items the layout model labelled as notes), locating note
markers in host blocks and table cells from superscript glyph runs or text
heuristics, the `footnote` relationships and `note-reference` runs they
produce, placing a note after the block that references it, and table notes
cut from the paragraph before their table. Note bodies recovered after the
walk live in `note_bodies.py`.
"""

from __future__ import annotations

import re

from docling_core.types.doc import TableItem, TextItem

from pdf_text import normalize_marker
from adapter_common import (
    FIGURE_CAPTION_RE,
    LIST_LIKE_NOTE_RE,
    PARATEXT_NOTE_ANY_RE,
    PARATEXT_NOTE_RE,
    TABLE_CAPTION_RE,
    TABLE_NOTE_LEAD_RE,
    footnote_parts,
    marker_candidates,
    sanitize,
)


class NoteRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _table_above(self, box: dict) -> dict | None:
        """The box of a table on the same page whose foot lies directly above
        `box` (a gap of at most three hundredths of the page) and which
        overlaps it horizontally: the table a note under it annotates."""
        for other, _ in self.doc.iterate_items():
            if not isinstance(other, TableItem):
                continue
            for tbox in self._boxes(other):
                if tbox["page"] != box["page"]:
                    continue
                if not -0.005 <= box["y"] - (tbox["y"] + tbox["height"]) <= 0.03:
                    continue
                if min(tbox["x"] + tbox["width"], box["x"] + box["width"]) - max(tbox["x"], box["x"]) > 0:
                    return tbox
        return None

    @staticmethod
    def _span_gap(item, before: int, index: int) -> str:
        """The characters between two provenance spans of one item, which the
        spans themselves leave out (a raised note marker, a space)."""
        prov = getattr(item, "prov", None) or []
        if before >= len(prov) or index >= len(prov):
            return ""
        first, second = getattr(prov[before], "charspan", None), getattr(prov[index], "charspan", None)
        if not first or not second or len(first) != 2 or len(second) != 2 or second[0] <= first[1]:
            return ""
        return (item.text or "")[first[1] : second[0]].strip()

    def _raised_lead_marker(self, box: dict) -> str | None:
        """The label of a raised glyph run that opens the first line inside
        `box`: a note's own marker, set as a superscript before its text."""
        page_text = self._page_text(box["page"])
        if page_text is None:
            return None
        for glyph_marker in page_text.markers:
            if not glyph_marker.at_line_start or glyph_marker.page != box["page"]:
                continue
            if not (box["x"] - 0.006 <= glyph_marker.x <= box["x"] + 0.03 and box["y"] - 0.006 <= glyph_marker.y <= box["y"] + 0.012):
                continue
            label = glyph_marker.text.strip()
            if 1 <= len(label) <= 3:
                return label
        return None

    def _split_table_note_tail(self, item: TextItem) -> bool:
        """`… leaving room for op` at the foot of one column and `a A complex
        neural network …` directly under the table heading the next column
        came back as one item: the layout model glued a table's note to the
        paragraph before it. A later provenance box that sits directly under
        a table, opens with a note marker, and does not continue a box under
        that same table ends the paragraph; the note becomes an unlabelled
        footnote that keeps its printed marker and is placed after its table."""
        segments = self._prov_segments(item)
        if len(segments) < 2:
            return False
        cut_at, marker, glued = None, "", False
        for position, (index, text) in enumerate(segments[1:], start=1):
            box = self._box(item, index)
            if box is None:
                continue
            # the marker is a raised glyph: the layout model leaves it between
            # the two spans (`… for op` | `a` | `A complex …`) or glues it to
            # the head's last word (`… for opa`), where the text layer's raised
            # run at the start of the note's line names it
            gap = self._span_gap(item, segments[position - 1][0], index)
            head_text = segments[position - 1][1].rstrip()
            raised = self._raised_lead_marker(box)
            if gap and len(gap) <= 3:
                lead, found, from_head = f"{gap} {text}", gap, False
            elif raised and head_text.endswith(raised) and not TABLE_NOTE_LEAD_RE.match(sanitize(text)):
                lead, found, from_head = f"{raised} {text}", raised, True
            else:
                lead, found, from_head = text, "", False
            table = self._table_above(box)
            if table is None:
                continue
            previous = self._box(item, segments[position - 1][0])
            if not TABLE_NOTE_LEAD_RE.match(sanitize(lead)):
                # Unmarked table legends use smaller type than body prose.
                # Geometry alone also fits a normal paragraph below a table;
                # require the source glyphs to demonstrate the type change.
                note_page = self._page_text(box["page"])
                body_page = self._page_text(previous["page"]) if previous else None
                note_sizes = sorted(line.height for line in note_page.lines_in(box)) if note_page else []
                body_sizes = sorted(line.height for line in body_page.lines_in(previous)) if body_page else []
                legend_text = " ".join(part.strip() for _, part in segments[position:])
                notation_cue = re.search(
                    r"\b(?:dashes?|asterisks?|stars?|bold(?:face)?|italics?|parentheses|brackets|shading)"
                    r"\s*(?:\([^)]{0,24}\)\s*)?(?:indicate|denote|represent|mark|show)\b",
                    legend_text, re.I,
                )
                # an abbreviation key (`UH = University of Houston; P1 = Safe Divide; …`)
                # is a legend too, and a segment on another page or column cannot be
                # the paragraph's own next line
                key_cue = len(re.findall(r"\w\s*=\s*\w", legend_text)) >= 2
                discontinuous = previous is not None and (previous["page"] != box["page"] or abs(previous["x"] - box["x"]) > 0.05)
                if (not note_sizes or not body_sizes or not re.match(r"[A-Z]", sanitize(text).lstrip())
                    or note_sizes[len(note_sizes) // 2] >= 0.85 * body_sizes[len(body_sizes) // 2]
                    or not (notation_cue or (key_cue and discontinuous))
                    or FIGURE_CAPTION_RE.match(sanitize(text)) or TABLE_CAPTION_RE.match(sanitize(text))):
                    continue
            if previous is not None and previous["page"] == box["page"] and self._table_above(previous) == table:
                continue  # the note's own second line, not the paragraph's end
            cut_at, marker, glued = position, found, from_head
            break
        if cut_at is None:
            return False
        head = sanitize(" ".join(text.strip() for _, text in segments[:cut_at] if text.strip()))
        if glued and head.endswith(marker):
            head = head[: -len(marker)].rstrip()
        tail = sanitize(" ".join(text.strip() for _, text in segments[cut_at:] if text.strip()))
        if marker:
            tail = f"{marker} {tail}"
        if len(head) < 40 or len(tail) < 20:
            return False
        self._flush()
        block = self._new_block("paragraph", item, head)
        block["evidence"]["boxes"] = [b for index, _ in segments[:cut_at] for b in ([self._box(item, index)] if self._box(item, index) else [])]
        block["evidence"]["pages"] = sorted({b["page"] for b in block["evidence"]["boxes"]}) or block["evidence"]["pages"]
        block["inline"] = self._runs_for(item, head)
        self.blocks.append(block)
        self.report.paragraphs += 1
        note = self._new_block("footnote", item, tail)
        note["evidence"]["boxes"] = [b for index, _ in segments[cut_at:] for b in ([self._box(item, index)] if self._box(item, index) else [])]
        note["evidence"]["pages"] = sorted({b["page"] for b in note["evidence"]["boxes"]}) or note["evidence"]["pages"]
        note["page"] = note["evidence"]["pages"][0] if note["evidence"]["pages"] else note["page"]
        note["inline"] = self._runs_for(item, tail)
        note["evidence"]["signals"] = list(dict.fromkeys((note["evidence"].get("signals") or []) + ["table-note"]))
        self.blocks.append(note)
        self.report.notes_without_reference += 1
        self.report.table_notes_split += 1
        return True

    def _place_table_notes(self) -> None:
        """A note cut from the paragraph before its table follows the table
        (and the table's caption) it sits under, instead of preceding it."""
        for note in [b for b in self.blocks if b["kind"] == "footnote" and "table-note" in (b["evidence"].get("signals") or [])]:
            box = note["evidence"]["boxes"][0] if note["evidence"]["boxes"] else None
            if box is None:
                continue
            position = self.blocks.index(note)
            for index in range(position + 1, min(position + 6, len(self.blocks))):
                table = self.blocks[index]
                if table["kind"] != "table" or table["page"] != note["page"] or not table["evidence"]["boxes"]:
                    continue
                tbox = table["evidence"]["boxes"][0]
                if not -0.005 <= box["y"] - (tbox["y"] + tbox["height"]) <= 0.03:
                    continue
                target = index
                if target + 1 < len(self.blocks) and self.blocks[target + 1]["kind"] == "caption":
                    target += 1
                self.blocks.insert(target + 1, note)
                del self.blocks[position]
                break

    def _emit_footnote(self, item: TextItem) -> None:
        self._flush()
        raw = sanitize(item.text)
        if PARATEXT_NOTE_RE.match(raw.strip()) or PARATEXT_NOTE_ANY_RE.search(raw):
            # copyright, licence, ISSN/DOI and journal lines are page
            # furniture that the layout model labelled as footnotes
            self.report.paratext_notes_demoted += 1
            self._furniture_block(item, "explicit-paratext", "paratext-note")
            return
        if FIGURE_CAPTION_RE.match(raw.strip()) or TABLE_CAPTION_RE.match(raw.strip()):
            # a caption at the foot of the page the layout model called a note
            self.report.orphan_captions += 1
            block = self._new_block("caption", item, raw.strip())
            block["inline"] = self._runs_for(item, block["text"])
            self.blocks.append(block)
            return
        marker, body = footnote_parts(raw)
        previous = next((b for b in reversed(self.blocks) if b["kind"] != "furniture"), None)
        page_text = self._page_text(self._page_of(item))
        if (marker and marker.isdigit() and previous and previous["kind"] == "heading"
                and re.fullmatch(r"(?:References|Bibliography)", previous["text"].strip(), re.I)
                and page_text is not None and not any(m.has_label(marker) for m in page_text.markers)):
            # A baseline-numbered first bibliography entry can be labelled
            # footnote merely because References starts at the page foot.
            block = self._new_block("paragraph", item, raw)
            block["inline"] = self._runs_for(item, raw)
            self.blocks.append(block)
            return
        if LIST_LIKE_NOTE_RE.match(raw) or (marker and marker.isdigit() and re.match(r"^[.)]\s+\S", body)):
            # "1. Preserve the Core Inquiry" / "- Valid values": a list item the layout model mislabelled
            self._list_counter += 1
            block = self._new_block("list-item", item, raw.strip())
            block["inline"] = self._runs_for(item, block["text"])
            block["attributes"] = {"ordered": bool(re.match(r"^\s*\d", raw)), "listId": f"list-fn-{self._list_counter}"}
            self.blocks.append(block)
            return
        self.report.footnotes += 1
        if marker and not marker.isdigit() and not self._symbol_referenced_on_page(marker, item):
            # a `*` note whose star appears nowhere else on the page (the
            # corresponding author marked by an envelope icon): keep the
            # printed symbol in the text, there is no reference to link
            self.report.notes_without_reference += 1
            block = self._new_block("footnote", item, f"{marker} {body}".strip())
            block["inline"] = self._runs_for(item, block["text"])
            self.blocks.append(block)
            return
        block = self._new_block("footnote", item, body, **({"label": marker} if marker else {}))
        block["inline"] = self._runs_for(item, body)
        self.blocks.append(block)
        if marker:
            self.report.footnotes_with_marker += 1
        # linking happens in `_link_notes` once every block on the page exists
        self._notes.append((block, marker, item))

    def _symbol_referenced_on_page(self, marker: str, item: TextItem) -> bool:
        """Whether a symbol marker (`*`, `†`) occurs on the note's page apart
        from the note itself, in the glyphs or the text layer."""
        page = self._page_of(item)
        if page is None:
            return True
        wanted = normalize_marker(marker)
        page_text = self._page_text(page)
        if page_text is not None:
            own_boxes = self._boxes(item)
            if any(m.has_label(wanted) and not any(
                bx["x"] - .004 <= m.x + m.width / 2 <= bx["x"] + bx["width"] + .004
                and bx["y"] - .004 <= m.y + m.height / 2 <= bx["y"] + bx["height"] + .004
                for bx in own_boxes
            ) for m in page_text.markers):
                return True
            lines = [line.text for line in page_text.lines]
        elif 0 < page <= len(self.page_lines):
            lines = self.page_lines[page - 1]
        else:
            return True
        count = sum(normalize_marker(line).count(wanted) for line in lines)
        own = normalize_marker(sanitize(item.text)).count(wanted)
        return count > own

    def _link_notes(self) -> None:
        note_boxes = [(b["page"], box) for b, _, _ in self._notes for box in b["evidence"]["boxes"]]
        alive = {id(b) for b in self.blocks}
        for block, marker, item in self._notes:
            if id(block) not in alive or block["kind"] != "footnote":
                continue
            linked = False
            if marker:
                twins = [b for b, m, _ in self._notes if m == marker and b["page"] == block["page"] and b["kind"] == "footnote" and id(b) in alive]
                rank = next((i for i, b in enumerate(twins) if b is block), 0) if len(twins) > 1 else None
                linked = self._link_marker_by_glyphs(marker, block, item, note_boxes, rank=rank, twins=len(twins))
                if not linked:
                    # no superscript glyph run carries this label (marker set on the
                    # baseline, or on another page): fall back to the text heuristics
                    linked = self._link_marker(marker, block, item)
            if linked:
                self.report.footnotes_linked += 1
            elif marker and marker.isdigit() and self._no_superscript_run(marker, self._page_of(item)):
                # glyph signals are available and no raised run carries this
                # digit on the note's page or the page before: the label is
                # part of the note's text, not a reference
                block["text"] = f"{marker} {block['text']}".strip()
                block.pop("label", None)
                self.report.footnotes_with_marker = max(0, self.report.footnotes_with_marker - 1)
                self.report.notes_without_reference += 1
            else:
                self.report.footnotes_unlinked += 1
                self._diagnostic("warning", "notes", "Footnote marker not found", f"footnote {marker or '?'} has no matched reference", item)

    def _no_superscript_run(self, marker: str, page: int | None) -> bool:
        if page is None:
            return False
        seen_any = False
        for candidate_page in (page, page - 1):
            page_text = self._page_text(candidate_page) if candidate_page >= 1 else None
            if page_text is None:
                continue
            seen_any = True
            if any(m.has_label(marker, loose=True) for m in page_text.markers):
                return False
        return seen_any

    @staticmethod
    def _locate_marker(text: str, left_context: str, token: str, label: str) -> tuple[int, int] | None:
        """Offsets of `label` in `text` where the glyph run `token` follows
        `left_context`, compared without whitespace; longest context first."""
        compact_chars: list[str] = []
        index_map: list[int] = []
        for index, char in enumerate(normalize_marker(text)):
            if not char.isspace():
                compact_chars.append(char)
                index_map.append(index)
        compact = "".join(compact_chars)
        offset_in_token = token.find(label)
        if offset_in_token < 0:
            token, offset_in_token = label, 0
        for k in range(min(len(left_context), 24), 2, -1):
            needle = left_context[-k:] + token
            position = compact.find(needle)
            if position < 0 or compact.find(needle, position + 1) >= 0:
                continue
            start = position + k + offset_in_token
            end = start + len(label)
            if end > len(index_map):
                return None
            return index_map[start], index_map[end - 1] + 1
        return None

    def _add_note_reference(self, block: dict, start: int, end: int, note_block: dict, marker: str, confidence: float, evidence: dict) -> bool:
        if any(not (end <= r["start"] or start >= r["end"]) for r in block["inline"] if r.get("href") or r.get("targetIds")):
            return False
        for run in block["inline"]:
            if run["start"] == start and run["end"] == end and not run.get("semanticRole"):
                run.pop("verticalAlign", None)
        block["inline"][:] = [run for run in block["inline"] if set(run) != {"start", "end"}]
        relationship_id = self._id(f"rel-note-{note_block['id']}")
        self.relationships.append(
            {
                "id": relationship_id,
                "kind": "footnote",
                "from": block["id"],
                "to": [note_block["id"]],
                "label": marker,
                "status": "matched",
                "confidence": confidence,
                "evidence": evidence,
            }
        )
        block["inline"].append(
            {
                "start": start,
                "end": end,
                "targetIds": [note_block["id"]],
                "relationshipId": relationship_id,
                "verticalAlign": "superscript",
                "semanticRole": "note-reference",
            }
        )
        return True

    def _link_marker_by_glyphs(self, marker: str, note_block: dict, item: TextItem, note_boxes: list, rank: int | None = None, twins: int = 1) -> bool:
        """Link a note to every superscript glyph run on its page that carries
        the note's label and sits inside a body block; the run's own left
        context locates the exact characters in the block text."""
        page = self._page_of(item)
        page_text = self._page_text(page)
        if page_text is None:
            return False
        def outside_notes(glyph_marker) -> bool:
            cx, cy = glyph_marker.x + glyph_marker.width / 2, glyph_marker.y + glyph_marker.height / 2
            return not any(p == page and bx["x"] - 0.004 <= cx <= bx["x"] + bx["width"] + 0.004 and bx["y"] - 0.004 <= cy <= bx["y"] + bx["height"] + 0.004 for bx in note_block["evidence"]["boxes"] for p in [bx["page"]])

        usable = [m for m in page_text.markers if not m.at_line_start and outside_notes(m)]
        # A source token "12" is one numeric label; splitting it into 1 and 2
        # would invent an affiliation convention. Explicit 1,2 / 1* tokens
        # remain compound labels through Marker.has_label's exact parts.
        candidates = [m for m in usable if m.has_label(marker)]
        if rank is not None and len(candidates) >= twins:
            # two notes with the same label (an affiliation and a footnote):
            # the k-th note takes the k-th marker in reading order
            ordered = sorted(candidates, key=lambda m: (round(m.y, 2), m.x))
            candidates = ordered[rank : rank + 1] if rank < twins - 1 else ordered[rank:]
        if not candidates:
            return False
        # a paragraph that runs over the page break keeps the page it starts
        # on: blocks of the previous page are candidates too, located by the
        # marker's own left context
        hosts = [
            b
            for b in self.blocks
            if (b["page"] in (page, page - 1) or page in b["evidence"]["pages"]) and (b["kind"] in ("paragraph", "list-item", "heading", "caption", "figure", "quote") or b["kind"] == "footnote") and b is not note_block
        ]
        cell_hosts = [
            (b, cell)
            for b in self.blocks
            if b.get("table") and (b["page"] in (page, page - 1) or page in b["evidence"]["pages"])
            for cell in b["table"]["cells"]
            if cell["text"].strip()
        ]
        linked = False
        for glyph_marker in candidates:
            cx, cy = glyph_marker.x + glyph_marker.width / 2, glyph_marker.y + glyph_marker.height / 2
            containing = [
                b
                for b in hosts
                if any(
                    bx["page"] == page and bx["x"] - 0.006 <= cx <= bx["x"] + bx["width"] + 0.006 and bx["y"] - 0.006 <= cy <= bx["y"] + bx["height"] + 0.006
                    for bx in b["evidence"]["boxes"]
                )
            ]
            containing.sort(key=lambda b: min(bx["width"] * bx["height"] for bx in b["evidence"]["boxes"]))
            others = [b for b in hosts if b not in containing] if len(glyph_marker.left_context) >= 6 else []
            for host in containing + others:
                span = self._locate_marker(host["text"], glyph_marker.left_context, glyph_marker.text, marker)
                if span is None:
                    continue
                evidence = {
                    "confidence": 1.0 if host in containing else 0.8,
                    "pages": [page],
                    "boxes": [{"page": page, "x": glyph_marker.x, "y": glyph_marker.y, "width": max(glyph_marker.width, 0.001), "height": max(glyph_marker.height, 0.001), "rotation": 0}],
                    "sourceIds": [self._source_id(item)],
                    "signals": ["superscript-glyph"],
                }
                if self._add_note_reference(host, span[0], span[1], note_block, marker, evidence["confidence"], evidence):
                    linked = True
                    self.report.footnotes_glyph_linked += 1
                break
            else:
                # the marker sits in a table cell: the cell carries the reference, the table the relationship
                for table_block, cell in cell_hosts:
                    span = self._locate_marker(cell["text"], glyph_marker.left_context, glyph_marker.text, marker)
                    if span is None:
                        continue
                    if any(not (span[1] <= r["start"] or span[0] >= r["end"]) for r in cell["inline"] if r.get("href") or r.get("targetIds")):
                        continue
                    evidence = {
                        "confidence": 0.9,
                        "pages": [page],
                        "boxes": [{"page": page, "x": glyph_marker.x, "y": glyph_marker.y, "width": max(glyph_marker.width, 0.001), "height": max(glyph_marker.height, 0.001), "rotation": 0}],
                        "sourceIds": [self._source_id(item)],
                        "signals": ["superscript-glyph", "table-cell"],
                    }
                    self._add_note_reference({"id": table_block["id"], "inline": cell["inline"]}, span[0], span[1], note_block, marker, 0.9, evidence)
                    linked = True
                    self.report.footnotes_glyph_linked += 1
                    self.report.notes_linked_in_cells += 1
                    break
        return linked

    def _place_notes(self) -> None:
        """A linked footnote follows the block that references it (after the
        rest of that block's list or the table's caption), so the note reads
        beside its reference instead of at the end of the source page."""
        hosts_by_note: dict[str, list[str]] = {}
        for relationship in self.relationships:
            if relationship["kind"] == "footnote":
                for target in relationship["to"]:
                    hosts_by_note.setdefault(target, []).append(relationship["from"])
        order = {b["id"]: i for i, b in enumerate(self.blocks)}
        inserts: dict[str, list[dict]] = {}
        for block in self.blocks:
            hosts = [h for h in hosts_by_note.get(block["id"], []) if h in order and h != block["id"]]
            if block["kind"] != "footnote" or not hosts:
                continue
            host_id = min(hosts, key=lambda h: order[h])
            inserts.setdefault(host_id, []).append(block)
        if not inserts:
            return
        moved = {id(b) for notes in inserts.values() for b in notes}
        remaining = [b for b in self.blocks if id(b) not in moved]

        def chain(notes: list[dict], seen: set[int]) -> list[dict]:
            # a note referenced from inside another note follows that note
            expanded: list[dict] = []
            for note in notes:
                if id(note) in seen:
                    continue
                seen.add(id(note))
                expanded.append(note)
                expanded.extend(chain(inserts.get(note["id"], []), seen))
            return expanded

        placed: set[int] = set()
        rebuilt: list[dict] = []
        index = 0
        while index < len(remaining):
            block = remaining[index]
            rebuilt.append(block)
            index += 1
            notes = chain(inserts.get(block["id"], []), placed)
            if not notes:
                continue
            if block["kind"] == "list-item":
                list_id = block.get("attributes", {}).get("listId")
                while index < len(remaining) and remaining[index]["kind"] == "list-item" and remaining[index].get("attributes", {}).get("listId") == list_id:
                    rebuilt.append(remaining[index])
                    index += 1
            elif block["kind"] == "table" and index < len(remaining) and remaining[index]["kind"] == "caption":
                rebuilt.append(remaining[index])
                index += 1
            rebuilt.extend(notes)
            self.report.footnotes_placed += len(notes)
        # a moved note whose host vanished keeps its place at the end of its page
        for block in self.blocks:
            if id(block) in moved and id(block) not in placed:
                position = next((i for i, b in enumerate(rebuilt) if b["page"] is not None and block["page"] is not None and b["page"] > block["page"]), len(rebuilt))
                rebuilt.insert(position, block)
                placed.add(id(block))
        self.blocks = rebuilt

    def _link_marker(self, marker: str, note_block: dict, item: TextItem) -> bool:
        page = self._page_of(item)
        same_page = [b for b in self.blocks if b["kind"] in ("paragraph", "list-item") and (b["page"] == page or page in b["evidence"].get("pages", [])) and b is not note_block]
        targets = list(reversed(same_page)) if same_page else [b for b in reversed(self.blocks[-14:]) if b["kind"] in ("paragraph", "list-item") and b is not note_block]
        strong_hits = []
        weak_hits = []
        for block in targets:
            candidates = marker_candidates(marker, block["text"])
            strong = [(s, e) for s, e, ok in candidates if ok]
            weak = [(s, e) for s, e, ok in candidates if not ok]
            if strong:
                strong_hits.append((block, strong))
            elif weak:
                weak_hits.append((block, weak))
        chosen = strong_hits or weak_hits[:1]
        if not chosen:
            return False
        linked = False
        for block, spans in chosen:
            for start, end in spans:
                linked = self._add_note_reference(
                    block, start, end, note_block, marker,
                    1 if spans and strong_hits else 0.6, self._evidence(item),
                ) or linked
        return linked
