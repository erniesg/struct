"""Tables: cell grids, entry lists, continuations and tables built from blocks.

What belongs here: emitting a Docling table as a cell grid (spans clamped,
cell links, collapsed rows split from source glyphs) or its fallback crop, a
caption-less bibliography grid as list entries, a `Table N` caption with no
table recovered from the band of row-like blocks beside it, tables continued
on the next page, and `_table_from_blocks`, which turns text blocks inside a
region into rows and columns. Reading drawn frames lives in
`rules_ruled_boxes.py`; glyph grids in `source_tables.py`.
"""

from __future__ import annotations

import re

from docling_core.types.doc import TableItem, TextItem

from adapter_common import (
    FIGURE_CAPTION_RE,
    PROSE_LIKE_RE,
    TABLE_CAPTION_RE,
    canonical_figure_label,
    clean_caption,
    first_free_span,
    sanitize,
)


class TableRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    @staticmethod
    def _grid_is_entry_list(grid) -> bool:
        """A caption-less grid of one or two columns whose text cells are prose
        (reference entries after a `[AKC+21]` label) is a list, not a table."""
        if not grid or len(grid) < 4 or max(len(row) for row in grid) > 2:
            return False
        # Prose is valid table content. Only explicit citation keys identify
        # bibliography rows; long paired comparison cells remain a table.
        entries = [row for row in grid if any(cell.text.strip() for cell in row)]
        return bool(entries) and all(
            re.match(r"^\s*\[[A-Za-z0-9+–-]+\]", row[0].text)
            for row in entries
        )

    def _emit_table(self, item: TableItem) -> None:
        self._flush()
        caption = self._caption_text(item)
        table_box = self._box(item)
        for ref in getattr(item, "captions", []):
            caption_item = ref.resolve(self.doc)
            caption_box = self._box(caption_item) if isinstance(caption_item, TextItem) else None
            if table_box and caption_box:
                self._captions_below_tables.append(caption_box["y"] >= table_box["y"] + table_box["height"] * 0.5)
        grid = item.data.grid if item.data else []
        if not caption and self._grid_is_entry_list(grid):
            # a bibliography or glossary the layout model read as a table: its
            # rows are entries, not cells; the reader wants them as a list
            self._list_counter += 1
            for r, row in enumerate(grid):
                texts = [sanitize(cell.text).strip() for cell in row if cell.text.strip()]
                if not texts:
                    continue
                entry = " ".join(dict.fromkeys(texts))
                block = self._new_block("list-item", item, entry)
                block["id"] = self._id(f"b-{len(self.blocks) + 1:04d}-entry-{r}")
                block["inline"] = []
                spans: list[tuple[int, int]] = []
                for c, cell in enumerate(row):
                    for visible, href in self._item_links.get(f"{item.self_ref}#c{r}-{c}", []):
                        span = first_free_span(visible, entry, spans)
                        if span is not None:
                            spans.append(span)
                            block["inline"].append({"start": span[0], "end": span[1], "href": href})
                block["attributes"] = {"ordered": False, "listId": f"list-entries-{self._list_counter}"}
                self.blocks.append(block)
            self.report.tables_as_entry_lists += 1
            return
        figure_label = FIGURE_CAPTION_RE.match(caption or "")
        if figure_label:
            # the paper calls this box a figure (a prompt, a code listing in a
            # frame): it is one, and its crop is the artwork
            image = None
            try:
                image = item.get_image(self.doc)
            except Exception:
                image = None
            self.report.figures += 1
            block = self._new_block("figure", item, clean_caption(caption), label=canonical_figure_label(figure_label))
            asset_id = self._asset("figure", f"figure-{self.report.figures:03d}", image, item)
            if asset_id:
                block["fallbackAssetIds"] = [asset_id]
            else:
                self.report.figures_without_image += 1
            for ref in getattr(item, "captions", []):
                caption_box = self._box(ref.resolve(self.doc))
                if caption_box:
                    block["evidence"]["boxes"].append(caption_box)
                    self._attached_caption_boxes[block["id"]] = caption_box
                    break
            self.report.figures_with_caption += 1
            self.report.tables_relabelled_figure += 1
            self.blocks.append(block)
            return
        block = self._new_block("table", item, "")
        for ref in getattr(item, "captions", []):
            caption_box = self._box(ref.resolve(self.doc))
            if caption_box:
                self._attached_caption_boxes[block["id"]] = caption_box
                break
        label_match = re.match(r"^Table\s*((?-i:[A-Z])\.?\d+(?:\.\d+)*|\d+(?:\.\d+)*)", caption or "", re.IGNORECASE)
        if label_match:
            block["label"] = f"Table {label_match.group(1)}"
        usable = bool(grid) and any(cell.text.strip() for row in grid for cell in row)
        if usable:
            rows = len(grid)
            columns = max(len(row) for row in grid)
            if rows * columns == 1 and (PROSE_LIKE_RE.search(grid[0][0].text) or len(grid[0][0].text) > 80):
                # a one-cell table holding prose is a boxed text (a prompt, an
                # example); the text is the structure a reader wants
                self.report.tables_single_cell_text += 1
        if usable:
            cells = []
            seen: set[tuple[int, int]] = set()
            occupied: set[tuple[int, int]] = set()
            rows = len(grid)
            columns = max(len(row) for row in grid)
            origins = {(cell.start_row_offset_idx, cell.start_col_offset_idx) for row in grid for cell in row}
            for r, row in enumerate(grid):
                for c, cell in enumerate(row):
                    key = (cell.start_row_offset_idx, cell.start_col_offset_idx)
                    if key != (r, c) or key in seen:
                        continue
                    seen.add(key)
                    if (r, c) in occupied:
                        self.report.table_cells_dropped += 1
                        continue
                    row_span = max(1, int(cell.row_span))
                    col_span = max(1, int(cell.col_span))
                    # clamp spans so no cell covers an occupied coordinate or leaves the grid
                    row_span = min(row_span, rows - r)
                    col_span = min(col_span, columns - c)
                    # A span cannot own the origin of another source cell.
                    # Resolve the conflicting span before it can suppress that
                    # later cell and silently delete its text.
                    original_span = (row_span, col_span)
                    for other_row, other_column in sorted(origins):
                        if (other_row, other_column) == (r, c):
                            continue
                        if r <= other_row < r + row_span and c <= other_column < c + col_span:
                            if other_row == r:
                                col_span = other_column - c
                            else:
                                row_span = other_row - r
                    if original_span != (row_span, col_span):
                        self.report.table_spans_clamped += 1
                    footprint = {(rr, cc) for rr in range(r, r + row_span) for cc in range(c, c + col_span)}
                    if footprint & occupied:
                        row_span, col_span = 1, 1
                        footprint = {(r, c)}
                        self.report.table_spans_clamped += 1
                    occupied |= footprint
                    cell_text = sanitize(cell.text)
                    cell_runs: list[dict] = []
                    for visible, href in self._item_links.get(f"{item.self_ref}#c{r}-{c}", []):
                        span = first_free_span(visible, cell_text, [(run["start"], run["end"]) for run in cell_runs])
                        if span is None:
                            continue
                        cell_runs.append({"start": span[0], "end": span[1], "href": href})
                    cell_evidence = self._evidence(item)
                    if cell.bbox and len(item.prov) == 1:
                        page_size = self.doc.pages.get(item.prov[0].page_no)
                        if page_size:
                            bounds = cell.bbox.to_bottom_left_origin(page_size.size.height)
                            cell_evidence = {**cell_evidence, "boxes": [{"page": item.prov[0].page_no, "x": bounds.l/page_size.size.width, "y": 1-bounds.t/page_size.size.height, "width": (bounds.r-bounds.l)/page_size.size.width, "height": (bounds.t-bounds.b)/page_size.size.height, "rotation": 0}]}
                    cells.append(
                        {
                            "id": f"c{r}-{c}",
                            "text": cell_text,
                            "row": r,
                            "column": c,
                            "rowSpan": row_span,
                            "columnSpan": col_span,
                            "headerScope": "column" if cell.column_header else ("row" if cell.row_header else None),
                            "inline": cell_runs,
                            "evidence": cell_evidence,
                        }
                    )
            # A merged extraction cell can collapse several source records.
            # Reconstruct only when native glyphs attest the same columns and
            # conserve the extracted text, while exposing additional rows.
            if table_box:
                from source_tables import grid_from_source, split_collapsed_rows
                source_page = self._page_text(block["page"])
                source_cell_boxes = []
                if source_page:
                    for source_cell in item.data.table_cells:
                        if source_cell.bbox:
                            box = source_cell.bbox.to_bottom_left_origin(source_page.height)
                            source_cell_boxes.append((box.l, box.t, box.r, box.b, source_cell.start_row_offset_idx))
                source_grid = grid_from_source(self._page_text(block["page"]), (table_box["x"], table_box["y"], table_box["x"] + table_box["width"], table_box["y"] + table_box["height"]), block["evidence"]["sourceIds"], require_anchors=True, cell_boxes=source_cell_boxes)
                split = split_collapsed_rows(cells, source_grid) if source_grid and source_grid["columns"] == columns and source_grid["rows"] > rows else None
                if split is not None:
                    source_grid = {**source_grid, "cells": split}
                    from source_tables import migrate_cell_runs
                    migration_sources = []
                    for old in cells:
                        source_cell = next((c for c in item.data.table_cells if c.start_row_offset_idx == old["row"] and c.start_col_offset_idx == old["column"]), None)
                        evidence = old["evidence"]
                        if source_cell and source_cell.bbox and source_page:
                            bounds = source_cell.bbox.to_bottom_left_origin(source_page.height)
                            evidence = {**evidence, "boxes": [{"page": block["page"], "x": bounds.l/source_page.width, "y": 1-bounds.t/source_page.height, "width": (bounds.r-bounds.l)/source_page.width, "height": (bounds.t-bounds.b)/source_page.height}]}
                        migration_sources.append({**old, "evidence": evidence})
                    unresolved = migrate_cell_runs(migration_sources, source_grid["cells"])
                    if unresolved:
                        self._diagnostic("warning", "tables", "Source grid link migration ambiguous", f"{len(unresolved)} inline runs could not be placed uniquely; retaining the extracted grid", item)
                    else:
                        cells, rows = source_grid["cells"], source_grid["rows"]
                        block["evidence"].setdefault("signals", []).append("source-grid-repaired-collapsed-rows")
            block["table"] = {"rows": rows, "columns": columns, "cells": cells, "semantic": "verified"}
            # struct renders the table block's text as the caption above the table
            block["text"] = caption
            block["inline"] = self._caption_links(item, caption)
            self.report.tables_semantic += 1
        else:
            image = None
            try:
                image = item.get_image(self.doc)
            except Exception:
                image = None
            asset_id = self._asset("table", f"table-{self.report.tables_fallback_image + 1:03d}", image, item)
            if asset_id:
                self.report.tables_fallback_image += 1
                block["kind"] = "figure"
                block["text"] = caption
                block["fallbackAssetIds"] = [asset_id]
            else:
                self.report.tables_unrendered += 1
                self._diagnostic("error", "tables", "Table not rendered", "no cell grid and no crop", item)
                block["kind"] = "caption"
                block["text"] = caption or "[table unavailable]"
        self.blocks.append(block)
        for ref in getattr(item, "footnotes", []):
            note = ref.resolve(self.doc)
            if isinstance(note, TextItem) and note.text.strip():
                self._caption_refs.add(note.self_ref)
                block = self._new_block("caption", note, sanitize(note.text).strip())
                # the note's own links: a note that is nothing but the address
                # it cites (`3 https://openrouter.ai/`) was emitted with no
                # runs at all, so the link it carries resolved to nothing
                block["inline"] = self._runs_for(note, block["text"])
                self.blocks.append(block)

    def _fix_table_caption_sides(self) -> None:
        """A grid that took the caption of the table below it.

        Where a paper sets its table captions above their tables, a grid
        carrying a caption printed *below* it has taken the next table's
        caption: two tables stacked on a page end up one caption out of step,
        the last grid captionless and the first caption orphaned. The caption
        goes to the grid it stands over, and the caption above this one is
        left for it to adopt.
        """
        sides = []
        for block in self.blocks:
            caption = self._attached_caption_boxes.get(block["id"])
            boxes = block["evidence"]["boxes"]
            if block["kind"] == "table" and block["text"] and caption and boxes:
                sides.append(caption["y"] >= boxes[0]["y"] + boxes[0]["height"] * 0.5)
        # only a paper that clearly sets its captions above its tables can be
        # corrected this way: on a tie, or from a single measured caption, the
        # convention is unknown and moving a caption would invent one
        if len(sides) < 2 or sum(sides) * 2 >= len(sides):
            return
        for block in list(self.blocks):
            if block["kind"] != "table" or not block["text"] or not block["evidence"]["boxes"]:
                continue
            caption = self._attached_caption_boxes.get(block["id"])
            box = block["evidence"]["boxes"][0]
            if caption is None or caption["y"] < box["y"] + box["height"] * 0.5:
                continue
            candidates = []
            for other in self.blocks:
                if other is block or other["kind"] != "table" or other["text"] or other["page"] != block["page"] or not other["evidence"]["boxes"]:
                    continue
                obox = other["evidence"]["boxes"][0]
                gap = obox["y"] - (caption["y"] + caption["height"])
                overlap = min(caption["x"] + caption["width"], obox["x"] + obox["width"]) - max(caption["x"], obox["x"])
                if not (-0.01 <= gap <= 0.07) or overlap < 0.5 * min(caption["width"], obox["width"]):
                    continue
                candidates.append((abs(gap), other))
            # the caption belongs to the grid it stands closest over, not to
            # whichever grid the walk happened to emit first
            if candidates:
                other = min(candidates, key=lambda pair: pair[0])[1]
                other["text"], other["inline"] = block["text"], block.get("inline", [])
                if block.get("label"):
                    other["label"] = block["label"]
                other["evidence"]["sourceIds"] = list(dict.fromkeys(other["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
                self._attached_caption_boxes[other["id"]] = caption
                self._attached_caption_boxes.pop(block["id"], None)
                block["text"], block["inline"] = "", []
                block.pop("label", None)
                self.report.caption_sides_fixed += 1

    def _row_like(self, block: dict) -> bool:
        return (
            block["kind"] in ("paragraph", "list-item", "caption", "equation", "code")
            and len(block["text"]) < 200
            and not PROSE_LIKE_RE.search(block["text"])
            and not FIGURE_CAPTION_RE.match(block["text"])
            and not TABLE_CAPTION_RE.match(block["text"])
        )

    def _recover_uncaptured_tables(self) -> None:
        """A `Table N` caption with no table beside it means the table was
        typeset as text boxes or rules the layout model did not recognise. A
        caption-less table block beside the caption adopts it; otherwise the
        band under (or over) the caption, together with the row-like text
        blocks the model emitted for the table body, becomes one source-region
        crop labelled as that table."""
        index = 0
        while index < len(self.blocks):
            block = self.blocks[index]
            match = TABLE_CAPTION_RE.match(block["text"]) if block["kind"] in ("caption", "paragraph") else None
            if not match or block["page"] is None:
                index += 1
                continue
            label = f"Table {match.group(2)}"
            owner = next((b for b in self.blocks if b["kind"] == "table" and b.get("label") == label), None)
            if owner is not None:
                if owner["text"].strip() == block["text"].strip() and abs((owner["page"] or 0) - block["page"]) <= 1:
                    owner["evidence"]["sourceIds"] = list(dict.fromkeys(owner["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
                    self._absorb_block(block)
                    continue
                index += 1
                continue
            adopted = False
            for delta in (1, -1):
                j = index + delta
                while 0 <= j < len(self.blocks) and self.blocks[j]["kind"] == "furniture":
                    j += delta
                if not 0 <= j < len(self.blocks):
                    continue
                candidate = self.blocks[j]
                if candidate["kind"] != "table" or candidate["text"] or not candidate.get("table"):
                    continue
                cboxes, tboxes = block["evidence"]["boxes"], candidate["evidence"]["boxes"]
                if not cboxes or not tboxes:
                    continue
                cb, tb = cboxes[0], tboxes[0]
                same_page = candidate["page"] == block["page"]
                next_page = candidate["page"] == block["page"] + 1 and delta == 1 and cb["y"] > .65 and tb["y"] < .3
                prev_page = candidate["page"] == block["page"] - 1 and delta == -1 and cb["y"] < .3 and tb["y"] + tb["height"] > .65
                overlap = min(cb["x"] + cb["width"], tb["x"] + tb["width"]) - max(cb["x"], tb["x"])
                if not (same_page or next_page or prev_page) or overlap < .5 * min(cb["width"], tb["width"]):
                    continue
                candidate["text"] = block["text"]
                candidate["inline"] = block.get("inline", [])
                candidate["label"] = label
                self._attached_caption_boxes[candidate["id"]] = cb
                candidate["evidence"]["pages"] = sorted(set(candidate["evidence"]["pages"] + block["evidence"]["pages"]))
                candidate["evidence"]["sourceIds"] = list(dict.fromkeys(candidate["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
                if not same_page:
                    candidate["evidence"].setdefault("signals", []).append("caption-across-page-break")
                self._absorb_block(block)
                self.report.tables_caption_adopted += 1
                adopted = True
                break
            if adopted:
                continue
            if not block["evidence"]["boxes"]:
                index += 1
                continue
            page = block["page"]
            cbox = block["evidence"]["boxes"][0]
            # A caption alone at the head of the next page can close a
            # source-framed text table. Read the ending frame on the prior
            # page; its native code/text remains semantic content.
            if cbox["y"] < .3 and getattr(self, "source_text", None):
                previous_page = page - 1
                rules = self._rule_rows(previous_page, cbox)
                ending = next((r for r in reversed(rules) if r[0] > .65), None)
                if ending:
                    virtual_caption = {**cbox, "page": previous_page, "y": ending[0] + .002, "height": .001}
                    region = self._rule_box(previous_page, virtual_caption, "above", block, open_ended=True)
                    members = self._blocks_inside(previous_page, region, block) if region else []
                    if members and all(m["kind"] in ("code", "list-item", "heading") for m in members) and any(m["kind"] == "code" for m in members):
                        table = self._table_from_blocks({**block, "page": previous_page}, label, members, region)
                        table["evidence"]["pages"] = sorted(set(table["evidence"]["pages"] + [page]))
                        first = min(self.blocks.index(m) for m in members)
                        for member in members:
                            self._absorb_block(member)
                        self._absorb_block(block)
                        self.blocks.insert(first, table)
                        self.report.tables_semantic += 1
                        self.report.tables_recovered_from_source += 1
                        index = first + 1
                        continue
            x0 = max(0.0, cbox["x"] - 0.02)
            x1 = min(1.0, cbox["x"] + cbox["width"] + 0.02)
            if cbox["width"] < 0.5:
                x0 = max(0.0, x0 - 0.03)
                x1 = min(1.0, x1 + 0.03)

            def in_column(box: dict) -> bool:
                return box["x"] < x1 and box["x"] + box["width"] > x0

            # candidate bands under and over the caption. A band bounded by
            # another table's caption belongs to that table and is refused;
            # otherwise the document's own caption convention (above or below
            # its recognised tables) decides, then absorbed rows, then height.
            below_absorbed: list[dict] = []
            below_bound: dict | None = None
            top = cbox["y"] + cbox["height"] + 0.003
            bottom = top
            limit = 0.94
            j = index + 1
            while j < len(self.blocks):
                nxt = self.blocks[j]
                if nxt["page"] != page or not nxt["evidence"]["boxes"]:
                    break
                nbox = nxt["evidence"]["boxes"][0]
                if not in_column(nbox) or nbox["y"] < cbox["y"]:
                    j += 1
                    continue
                if self._row_like(nxt) and nbox["y"] - max(bottom, top) < 0.06:
                    below_absorbed.append(nxt)
                    bottom = max(bottom, nbox["y"] + nbox["height"] + 0.003)
                    j += 1
                    continue
                limit = min(limit, nbox["y"] - 0.004)
                below_bound = nxt
                break
            below = (top, bottom if below_absorbed else limit)
            above_absorbed: list[dict] = []
            above_bound: dict | None = None
            bottom = cbox["y"] - 0.003
            top = bottom
            limit = 0.06
            j = index - 1
            while j >= 0:
                prev = self.blocks[j]
                if prev["page"] != page or not prev["evidence"]["boxes"]:
                    break
                pbox = prev["evidence"]["boxes"][-1]
                if not in_column(pbox) or pbox["y"] + pbox["height"] > cbox["y"] + cbox["height"]:
                    j -= 1
                    continue
                if self._row_like(prev) and min(top, bottom) - (pbox["y"] + pbox["height"]) < 0.06:
                    above_absorbed.append(prev)
                    top = min(top, pbox["y"] - 0.003)
                    j -= 1
                    continue
                limit = max(limit, pbox["y"] + pbox["height"] + 0.004)
                above_bound = prev
                break
            above = (top if above_absorbed else limit, bottom)

            def claimed_by_other_caption(bound: dict | None) -> bool:
                return bound is not None and bound["kind"] in ("caption", "paragraph") and bool(TABLE_CAPTION_RE.match(bound["text"]))

            captions_below = sum(self._captions_below_tables) > len(self._captions_below_tables) / 2 if self._captions_below_tables else False
            options = []
            if not claimed_by_other_caption(below_bound):
                options.append((0 if captions_below else 1, len(below_absorbed), below[1] - below[0], below, below_absorbed))
            if not claimed_by_other_caption(above_bound):
                options.append((1 if captions_below else 0, len(above_absorbed), above[1] - above[0], above, above_absorbed))
            options = [option for option in options if option[3][1] - option[3][0] >= 0.03]
            if not options:
                index += 1
                continue
            options.sort(key=lambda option: (option[1] > 0, option[0], option[1], option[2]), reverse=True)
            _, _, _, band, absorbed = options[0]
            evidence = {
                "confidence": 0.6,
                "pages": [page],
                "boxes": [{"page": page, "x": round(x0, 5), "y": round(band[0], 5), "width": round(x1 - x0, 5), "height": round(band[1] - band[0], 5), "rotation": 0}],
                "sourceIds": block["evidence"]["sourceIds"],
                "signals": ["source-region-fallback", "orphan-table-caption"],
            }
            table = self._table_from_blocks(block, label, absorbed, (x0, band[0], x1, band[1]), bind_relationships=False)
            if not table["table"]["cells"] or table["table"]["columns"] < 2:
                self._diagnostic("warning", "tables", "Table cells unavailable", f"{label}: no semantic cells in the source band", None, page)
                index += 1
                continue
            from source_tables import rebind_table_relationships
            rebind_table_relationships(self.relationships, {block["id"], *(member["id"] for member in absorbed)}, table["id"])
            position = self.blocks.index(block)
            for absorbed_block in absorbed:
                self._absorb_block(absorbed_block)
            self._absorb_block(block)
            self.blocks.insert(min(position, len(self.blocks)), table)
            self.report.tables_recovered_from_source += 1
            self.report.tables_semantic += 1
            self._diagnostic("info", "tables", "Table recovered from source cells", f"{label}: source geometry recovered {table['table']['rows']} rows", None, page)
            index = position + 1

    def _merge_continued_tables(self) -> None:
        """A caption-less (or `continued`) table at the top of a page that
        follows a captioned table with the same column count on the previous
        page continues it: its rows append to that table."""
        for table in list(self.blocks):
            if table["kind"] != "table" or table.get("table", {}).get("columns") != 1 or "rule-box" not in table["evidence"].get("signals", []):
                continue
            while table in self.blocks:
                position = self.blocks.index(table)
                back = position - 1
                while back >= 0 and self.blocks[back]["kind"] == "furniture":
                    back -= 1
                if back < 0:
                    break
                previous = self.blocks[back]
                pages = previous["evidence"].get("pages", [])
                if previous["kind"] != "code" or not pages or max(pages) != min(table["evidence"]["pages"]) - 1:
                    break
                pb = previous["evidence"]["boxes"][-1]
                tb = table["evidence"]["boxes"][0]
                overlap = min(pb["x"]+pb["width"], tb["x"]+tb["width"]) - max(pb["x"],tb["x"])
                if overlap < .8*min(pb["width"],tb["width"]) or pb["y"]+pb["height"] < .8 or tb["y"] > .3:
                    break
                for cell in table["table"]["cells"]:
                    cell["row"] += 1
                    cell["id"] = f"c{cell['row']}-{cell['column']}"
                table["table"]["cells"].insert(0, {"id": "c0-0", "text": previous["text"], "row": 0, "column": 0, "rowSpan": 1, "columnSpan": 1, "headerScope": None, "inline": previous.get("inline", []), "evidence": previous["evidence"]})
                table["table"]["rows"] += 1
                table["evidence"]["pages"] = sorted(set(table["evidence"]["pages"] + pages))
                table["evidence"]["boxes"] = previous["evidence"]["boxes"] + table["evidence"]["boxes"]
                table["evidence"]["sourceIds"] = list(dict.fromkeys(previous["evidence"]["sourceIds"] + table["evidence"]["sourceIds"]))
                table["page"] = min(table["evidence"]["pages"])
                self._absorb_block(previous)
                self.report.tables_continued += 1
        index = 1
        while index < len(self.blocks):
            block = self.blocks[index]
            if block["kind"] == "table" and block.get("table") and block["page"] is not None and block["evidence"]["boxes"]:
                back = index - 1
                steps = 0
                while back >= 0 and self.blocks[back]["kind"] in ("furniture", "footnote") and steps < 4:
                    back -= 1
                    steps += 1
                prev = self.blocks[back] if back >= 0 else None
                continued = not block["text"] or (prev is not None and re.search(r"continued|cont\.", block["text"], re.IGNORECASE) and block.get("label") == prev.get("label"))
                if (
                    prev is not None
                    and prev["kind"] == "table"
                    and prev.get("table")
                    and prev["text"]
                    and prev["page"] == block["page"] - 1
                    and prev["table"]["columns"] == block["table"]["columns"]
                    and continued
                    and block["evidence"]["boxes"][0]["y"] < 0.3
                ):
                    offset = prev["table"]["rows"]
                    for cell in block["table"]["cells"]:
                        cell["row"] += offset
                        cell["id"] = f"c{cell['row']}-{cell['column']}"
                        prev["table"]["cells"].append(cell)
                    prev["table"]["rows"] += block["table"]["rows"]
                    prev["evidence"]["pages"] = sorted(set(prev["evidence"]["pages"] + block["evidence"]["pages"]))
                    prev["evidence"]["boxes"] = (prev["evidence"]["boxes"] + block["evidence"]["boxes"])[:4]
                    for relationship in self.relationships:
                        if relationship["from"] == block["id"]:
                            relationship["from"] = prev["id"]
                        relationship["to"] = [prev["id"] if t == block["id"] else t for t in relationship["to"]]
                    del self.blocks[index]
                    self.report.tables_continued += 1
                    self.report.tables_semantic -= 1
                    continue
            index += 1

    def _table_from_blocks(self, caption: dict, label: str, members: list[dict], region: tuple[float, float, float, float], *, bind_relationships: bool = True) -> dict:
        """A ruled box whose content the layout model emitted as text blocks
        is a text table: one column per x-cluster of blocks, one row per
        block (in column order), the caption as the table's text."""
        from source_tables import grid_from_source
        source_grid = grid_from_source(self._page_text(caption["page"]), region, caption["evidence"]["sourceIds"]) if getattr(self, "source_text", None) else None
        # A layout table already has row/column relationships. Do not flatten
        # its cells when adopting a surrounding caption or ruled frame.
        grids = [b for b in members if b.get("table")]
        text_members = [b for b in members if b["text"].strip() and not b.get("table")]
        if not source_grid and not grids and getattr(self, "source_text", None):
            from source_tables import prose_grid_from_source
            source_grid = prose_grid_from_source(self._page_text(caption["page"]), region, caption["evidence"]["sourceIds"])
        # glyph text of a PDF that sets no space glyphs runs its words together
        # (`BytheMartingaleConvergenceTheorem`); the blocks' own text is kept then
        if source_grid and sum(len(cell["text"].split()) for cell in source_grid["cells"]) < 0.8 * sum(len(b["text"].split()) for b in text_members):
            source_grid = None
        if source_grid and not grids:
            cells, rows, columns = source_grid["cells"], source_grid["rows"], source_grid["columns"]
        elif len(grids) == 1 and not text_members:
            import copy
            recovered_grid = copy.deepcopy(grids[0]["table"])
            cells, rows = recovered_grid["cells"], recovered_grid["rows"]
            columns = recovered_grid["columns"]
        elif len(grids) == 1 and text_members and all(b["evidence"]["boxes"][0]["y"] >= grids[0]["evidence"]["boxes"][0]["y"] + grids[0]["evidence"]["boxes"][0]["height"] - .015 for b in text_members):
            import copy
            recovered_grid = copy.deepcopy(grids[0]["table"])
            cells, rows, columns = recovered_grid["cells"], recovered_grid["rows"], recovered_grid["columns"]
            for member in sorted(text_members, key=lambda b: (b["evidence"]["boxes"][0]["y"], b["evidence"]["boxes"][0]["x"])):
                member_text = member["text"]
                page_text = self._page_text(caption["page"]) if getattr(self, "source_text", None) else None
                if page_text:
                    box = member["evidence"]["boxes"][0]
                    source_text = sanitize(page_text.region_text({**box, "x": region[0], "width": region[2]-region[0]}))
                    if source_text and member_text in source_text:
                        member_text = source_text
                cells.append({"id": f"c{rows}-0", "text": member_text, "row": rows, "column": 0, "rowSpan": 1, "columnSpan": columns, "headerScope": None, "inline": [], "evidence": member["evidence"]})
                rows += 1
        else:
            # Use spatial rows shared by all columns. Counting each column
            # independently silently shifts every later value after a blank.
            items = sorted(text_members, key=lambda b: (b["evidence"]["boxes"][0]["y"], b["evidence"]["boxes"][0]["x"]))
            row_bands: list[list[dict]] = []
            for member in items:
                box = member["evidence"]["boxes"][0]
                for band in row_bands:
                    anchor = band[0]["evidence"]["boxes"][0]
                    if abs(anchor["y"] - box["y"]) <= min(.012, .5 * min(anchor["height"], box["height"])):
                        band.append(member)
                        break
                else:
                    row_bands.append([member])
            anchors: list[float] = []
            for member in sorted(items, key=lambda b: b["evidence"]["boxes"][0]["x"]):
                x = member["evidence"]["boxes"][0]["x"]
                if not anchors or x - anchors[-1] > .02:
                    anchors.append(x)
            # A one-column prose box often indents headings and paragraphs, and
            # more than three x-clusters with most rows holding one block are a box
            # of prose and formula fragments, not columns: one column, one row per
            # block in reading order.
            if row_bands and (max(map(len, row_bands)) == 1 or (len(anchors) > 3 and sum(len(band) >= 2 for band in row_bands) < 0.6 * len(row_bands))):
                row_bands = [[member] for member in items]
                anchors = [min(anchors)]
            cells = []
            for row, band in enumerate(row_bands):
                for member in band:
                    box = member["evidence"]["boxes"][0]
                    column = min(range(len(anchors)), key=lambda c: abs(anchors[c] - box["x"]))
                    shared = next((cell for cell in cells if cell["row"] == row and cell["column"] == column), None)
                    if shared is not None:
                        # two blocks in one cell: the later one continues its text
                        offset = len(shared["text"]) + 1
                        shared["text"] = f"{shared['text']} {member['text']}"
                        shared["inline"] += [{**run, "start": run["start"] + offset, "end": run["end"] + offset} for run in member.get("inline", [])]
                        continue
                    cells.append({
                        "id": f"c{row}-{column}", "text": member["text"],
                        "row": row, "column": column, "rowSpan": 1, "columnSpan": 1,
                        "headerScope": "column" if row == 0 and member["kind"] == "heading" else None,
                        "inline": [dict(run) for run in member.get("inline", [])],
                        "evidence": member["evidence"],
                    })
            rows, columns = len(row_bands), len(anchors)
            # Keep embedded grids intact after the spatial text rows; their
            # columns and spans remain explicit, and no content is discarded.
            for grid in grids:
                for cell in grid["table"]["cells"]:
                    copied = dict(cell)
                    copied["row"] += rows
                    copied["id"] = f"c{copied['row']}-{copied['column']}"
                    cells.append(copied)
                rows += grid["table"]["rows"]
                columns = max(columns, grid["table"]["columns"])
        from source_tables import migrate_cell_runs
        originals = [original for member in members for original in ([member] if not member.get("table") else member["table"]["cells"])]
        unresolved = migrate_cell_runs(originals, cells)
        if unresolved:
            self._diagnostic("warning", "tables", "Recovered table link migration ambiguous", f"{label}: {len(unresolved)} inline runs have no unique source text occurrence", None, caption["page"])
        table_id = caption["id"] if caption["kind"] == "table" else self._id(f"b-ruled-table-{label.split()[-1]}")
        absorbed_ids = {caption["id"], *(member["id"] for member in members)}
        if bind_relationships:
            from source_tables import rebind_table_relationships
            rebind_table_relationships(self.relationships, absorbed_ids, table_id)
        caption_runs = [dict(run) for run in caption.get("inline", [])]
        for inline in [caption_runs] + [cell.get("inline", []) for cell in cells]:
            for run in inline:
                if run.get("targetIds"):
                    run["targetIds"] = list(dict.fromkeys(table_id if target in absorbed_ids else target for target in run["targetIds"]))
        page = caption["page"]
        x0, y0, x1, y1 = region
        return {
            "id": table_id,
            "kind": "table",
            "text": caption["text"],
            "label": label,
            "page": page,
            "order": 0,
            "column": "single",
            "inline": caption_runs,
            "evidence": {
                "confidence": 0.7,
                "pages": [page],
                "boxes": [{"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0}],
                "sourceIds": list(dict.fromkeys(caption["evidence"]["sourceIds"] + [sid for b in members for sid in b["evidence"]["sourceIds"]]))[:8],
                "signals": ["rule-box", "orphan-table-caption"],
            },
            "table": {"rows": rows, "columns": columns, "cells": cells, "semantic": "source-preserved"},
        }
