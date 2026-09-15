"""Ruled and framed boxes beside a caption.

What belongs here: reading drawn rules (vector paths) and frames or shaded
boxes (page pixels) next to a `Table N` / `Figure N` caption, deciding where
such a box starts and ends (booktabs heavy rules, a caption inside its own
first row, a box running off the page), and turning the box into a text table
or a figure crop. The blocks-to-grid step is `_table_from_blocks` in
`rules_tables.py`.
"""

from __future__ import annotations

from adapter_common import (
    APPENDIX_HEADING_RE,
    CAPTION_LIKE_RE,
    FIGURE_CAPTION_RE,
    NUMBERED_HEADING_RE,
    TABLE_CAPTION_RE,
    TOP_LEVEL_HEADING_RE,
    canonical_figure_label,
    clean_caption,
)


class RuledBoxRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _rule_rows(self, page: int, cbox: dict) -> list[tuple[float, float, float, float]]:
        """Horizontal rules on the page that span the caption's column, merged
        when several segments share a baseline: (y, x0, x1, stroke width)
        sorted by y. Rules in the page's edge bands (the line under a running
        head) are not table rules."""
        page_text = self._page_text(page)
        if page_text is None:
            return []
        cx0, cx1 = cbox["x"], cbox["x"] + cbox["width"]
        rows: list[list[float]] = []
        for rule in page_text.rules:
            if not rule.horizontal or rule.y0 < 0.06 or rule.y0 > 0.95:
                continue
            if rule.x1 - rule.x0 < 0.5 * (cx1 - cx0):
                continue  # a footnote separator under a wide caption
            overlap = min(cx1, rule.x1) - max(cx0, rule.x0)
            if overlap < 0.6 * min(cx1 - cx0, rule.x1 - rule.x0):
                continue
            for row in rows:
                if abs(row[0] - rule.y0) <= 0.003:
                    row[1] = min(row[1], rule.x0)
                    row[2] = max(row[2], rule.x1)
                    row[3] = max(row[3], rule.width)
                    break
            else:
                rows.append([rule.y0, rule.x0, rule.x1, rule.width])
        return sorted((y, x0, x1, w) for y, x0, x1, w in rows)

    def _blocking_between(self, page: int, y_a: float, y_b: float, x0: float, x1: float, exclude: dict) -> bool:
        """Whether another caption, a captioned float, or a section heading
        lies between two rules: the rules then belong to different objects."""
        lo, hi = min(y_a, y_b), max(y_a, y_b)
        for block in self.blocks:
            if block is exclude or block["page"] != page or not block["evidence"]["boxes"]:
                continue
            box = block["evidence"]["boxes"][0]
            if min(x1, box["x"] + box["width"]) - max(x0, box["x"]) < 0.3 * min(x1 - x0, box["width"]):
                continue
            if block["kind"] in ("figure", "table") and block["text"]:
                if min(hi, box["y"] + box["height"]) - max(lo, box["y"]) > 0.005:
                    return True
                continue
            cy = box["y"] + box["height"] / 2
            if not (lo < cy < hi):
                continue
            text = block["text"].strip()
            if CAPTION_LIKE_RE.match(text):
                return True
            if block["kind"] == "heading" and (NUMBERED_HEADING_RE.match(text) or APPENDIX_HEADING_RE.match(text) or TOP_LEVEL_HEADING_RE.match(text)):
                return True
        return False

    def _rule_box(self, page: int, cbox: dict, side: str, exclude: dict, open_ended: bool = False) -> tuple[float, float, float, float] | None:
        """(x0, y0, x1, y1) of the ruled region above or below a caption: the
        rule nearest the caption on that side, extended rule by rule away from
        it while no other caption, captioned float or section heading lies in
        between. A heavy rule (booktabs top/bottom rule) closes the region when
        the near rule is heavy too; vertical rules at the region's sides
        extend it to their far end."""
        rows = self._rule_rows(page, cbox)
        if not rows:
            return None
        if side == "above":
            near_candidates = [r for r in rows if r[0] <= cbox["y"] + 0.004 and cbox["y"] - r[0] <= 0.06]
            near = max(near_candidates) if near_candidates else None
            further = [r for r in rows if near and r[0] < near[0] - 0.005][::-1]
        else:
            bottom = cbox["y"] + cbox["height"]
            near_candidates = [r for r in rows if r[0] >= bottom - 0.004 and r[0] - bottom <= 0.06]
            near = min(near_candidates) if near_candidates else None
            further = [r for r in rows if near and r[0] > near[0] + 0.005]
        if near is None:
            return None
        x0, x1 = near[1], near[2]
        page_text = self._page_text(page)
        if page_text is not None:
            # a framed box: a vertical side through the near rule fixes the far
            # edge outright; nothing inside a frame separates it
            for rule in page_text.rules:
                if rule.horizontal or not (abs(rule.x0 - x0) <= 0.03 or abs(rule.x0 - x1) <= 0.03):
                    continue
                if not (rule.y0 - 0.01 <= near[0] <= rule.y1 + 0.01):
                    continue
                # PDF generators often draw one outer edge as adjacent
                # segments at spanning-row boundaries. Follow the continuous
                # collinear edge, rather than mistaking its internal join for
                # the end of the enclosing table.
                edge_top, edge_bottom = rule.y0, rule.y1
                changed = True
                while changed:
                    changed = False
                    for adjacent in page_text.rules:
                        if adjacent.horizontal or abs(adjacent.x0-rule.x0) > .002:
                            continue
                        if adjacent.y0 <= edge_bottom + .002 and adjacent.y1 >= edge_top - .002:
                            new_top, new_bottom = min(edge_top,adjacent.y0), max(edge_bottom,adjacent.y1)
                            if (new_top,new_bottom) != (edge_top,edge_bottom):
                                edge_top,edge_bottom = new_top,new_bottom
                                changed = True
                end = edge_top if side == "above" else edge_bottom
                if abs(end - near[0]) >= 0.02 and ((side == "above" and end < near[0]) or (side == "below" and end > near[0])):
                    snapped = next((r for r in rows if abs(r[0] - end) <= 0.02), None)
                    far_y = snapped[0] if snapped else end
                    return (x0, min(near[0], far_y), x1, max(near[0], far_y))
        thinnest = min(r[3] for r in rows)
        heavy_edges = near[3] >= 1.5 * thinnest
        far = near
        closed_by_rule = False
        for row in further:
            if abs(row[0] - far[0]) > 0.75 or self._blocking_between(page, far[0], row[0], min(x0, row[1]), max(x1, row[2]), exclude):
                break
            far = row
            x0, x1 = min(x0, row[1]), max(x1, row[2])
            if heavy_edges and row[3] >= 0.9 * near[3]:
                closed_by_rule = True
                break  # the matching heavy rule closes the box
        top, bottom = min(near[0], far[0]), max(near[0], far[0])
        if far is (further[-1] if further else near) and open_ended and not closed_by_rule:
            # the last rule on this side: the box runs off the page (a table
            # continued on the next page) and reaches the page's edge when
            # text blocks sit between the rule and the edge and nothing blocks
            edge = 0.06 if side == "above" else 0.94
            beyond = (x0, min(far[0], edge), x1, max(far[0], edge))
            tail = [m for m in self._blocks_inside(page, beyond, exclude) if m["kind"] in ("paragraph", "list-item", "code", "heading", "footnote") and m["text"].strip()]
            if tail and not self._blocking_between(page, far[0], edge, x0, x1, exclude):
                content_top = min(m["evidence"]["boxes"][0]["y"] for m in tail)
                content_bottom = max(m["evidence"]["boxes"][0]["y"] + m["evidence"]["boxes"][0]["height"] for m in tail)
                top, bottom = min(top, content_top - .003), max(bottom, content_bottom + .003)
        if bottom - top < 0.02:
            return None
        return (x0, top, x1, bottom)

    def _pixel_box(self, page: int, cbox: dict, side: str, exclude: dict) -> tuple[float, float, float, float] | None:
        """The framed or shaded region beside a caption, read from the page
        image when the PDF's vector paths gave no rule: a row of ink across
        the column is a frame edge, a run of tinted rows is a filled box.
        Edges chain away from the caption while no other caption or captioned
        float lies between them."""
        x0 = max(0.0, cbox["x"] - 0.02 - (0.03 if cbox["width"] < 0.5 else 0.0))
        x1 = min(1.0, cbox["x"] + cbox["width"] + 0.02 + (0.03 if cbox["width"] < 0.5 else 0.0))
        rows = self._pixel_rows(page, x0, x1)
        if rows is None:
            return None
        dark, nonwhite, height = rows
        edge_rows = [i for i in range(len(dark)) if dark[i] >= 0.6]
        # merge adjacent rows of one rule
        edges: list[float] = []
        for i in edge_rows:
            if edges and i - edges[-1] * height <= 3:
                continue
            edges.append(i / height)
        edges = [e for e in edges if 0.06 <= e <= 0.95]
        if side == "above":
            start = cbox["y"]
            near_candidates = [e for e in edges if e <= start + 0.004 and start - e <= 0.08]
            near = max(near_candidates) if near_candidates else None
            further = sorted([e for e in edges if near is not None and e < near - 0.01], reverse=True)
        else:
            start = cbox["y"] + cbox["height"]
            near_candidates = [e for e in edges if e >= start - 0.004 and e - start <= 0.08]
            near = min(near_candidates) if near_candidates else None
            further = sorted([e for e in edges if near is not None and e > near + 0.01])
        if near is not None:
            far = near
            for edge in further:
                if abs(edge - far) > 0.75 or self._blocking_between(page, far, edge, x0, x1, exclude):
                    break
                far = edge
            if abs(far - near) >= 0.02:
                return (x0, min(near, far), x1, max(near, far))
        # a shaded box: tinted rows running away from the caption
        tinted = nonwhite >= 0.9
        row = int(start * height) - 1 if side == "above" else int(start * height) + 1
        step = -1 if side == "above" else 1
        gap = 0
        while 0 <= row < height and not tinted[row] and gap < 0.04 * height:
            row += step
            gap += 1
        if not (0 <= row < height) or not tinted[row]:
            return None
        end = row
        misses = 0
        while 0 <= row < height:
            if tinted[row]:
                end = row
                misses = 0
            else:
                misses += 1
                if misses > 4:
                    break
            row += step
        top, bottom = (min(end, int(start * height) - 1), int(start * height) - 1) if side == "above" else (int(start * height) + 1, max(end, int(start * height) + 1))
        if (bottom - top) / height < 0.03:
            return None
        y0, y1 = top / height, bottom / height
        if self._blocking_between(page, y0, y1, x0, x1, exclude):
            return None
        return (x0, y0, x1, y1)

    def _blocks_inside(self, page: int, region: tuple[float, float, float, float], exclude: dict | None = None) -> list[dict]:
        x0, y0, x1, y1 = region
        found = []
        for block in self.blocks:
            if block is exclude or block["page"] != page or not block["evidence"]["boxes"] or block["kind"] == "furniture":
                continue
            if block["kind"] in ("figure", "table") and block["text"]:
                continue  # a captioned float is its own object, never a row of another
            box = block["evidence"]["boxes"][0]
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            if x0 - 0.005 <= cx <= x1 + 0.005 and y0 - 0.005 <= cy <= y1 + 0.005:
                found.append(block)
        return found

    def _caption_sides(self, kind: str) -> list[str]:
        """Which side of a caption its float sits on, the document's own
        convention first (captions below figures is the default)."""
        if kind == "table":
            below = sum(self._captions_below_tables) > len(self._captions_below_tables) / 2 if self._captions_below_tables else False
            return ["above", "below"] if below else ["below", "above"]
        below = sum(self._figure_caption_below) >= len(self._figure_caption_below) / 2 if self._figure_caption_below else True
        return ["above", "below"] if below else ["below", "above"]

    def _recover_ruled_boxes(self) -> None:
        """A `Table N` or `Figure N` caption with no float beside it whose
        neighbouring region is framed by drawn rules: the blocks inside the
        frame are the table's rows (a text table) or, for a figure, the frame
        is cropped as the artwork and the text inside becomes part of it."""
        # A recognized grid can cover only the upper rows of a larger
        # framed table. The shared outer frame owns the prose rows below it.
        for table in list(self.blocks):
            if table["kind"] != "table" or not table.get("table") or not TABLE_CAPTION_RE.match(table["text"]) or not table["evidence"]["boxes"]:
                continue
            caption_box = self._attached_caption_boxes.get(table["id"])
            if not caption_box:
                continue
            box = table["evidence"]["boxes"][0]
            for side in self._caption_sides("table"):
                region = self._rule_box(table["page"], caption_box, side, table)
                if not region:
                    continue
                x0,y0,x1,y1 = region
                # A spanning text section can omit vertical strokes at its
                # heading. Its top rule still exactly shares the native grid's
                # bottom edge, establishing one adjoining captioned table.
                if abs(y0-(box["y"]+box["height"])) <= .003 and abs(x0-box["x"]) <= .005 and abs(x1-(box["x"]+box["width"])) <= .005:
                    y0 = min(y0, box["y"])
                    region = (x0,y0,x1,y1)
                if not (x0-.01 <= box["x"] and x1+.01 >= box["x"]+box["width"] and y0-.01 <= box["y"] and y1+.01 >= box["y"]+box["height"]) or y1-y0 <= box["height"] + .02:
                    continue
                members = self._blocks_inside(table["page"], region, table)
                if not members or any(m["kind"] in ("figure", "table") for m in members):
                    continue
                recovered = self._table_from_blocks(table, table["label"], [table]+members, region)
                table["table"] = recovered["table"]
                table["evidence"] = recovered["evidence"]
                for member in members:
                    self._absorb_block(member)
                break
        # A character avatar inside a dialogue frame is only a component of
        # the figure. The source frame, when it contains that component and is
        # attached to its caption, determines the complete artwork boundary.
        for picture in list(self.blocks):
            if picture["kind"] != "figure" or not FIGURE_CAPTION_RE.match(picture["text"]) or not picture["evidence"]["boxes"]:
                continue
            box = picture["evidence"]["boxes"][0]
            caption_box = self._attached_caption_boxes.get(picture["id"])
            if not caption_box or box["width"] * box["height"] >= .015:
                continue
            for side in self._caption_sides("figure"):
                region = self._rule_box(picture["page"], caption_box, side, picture)
                if region is None:
                    region = self._pixel_box(picture["page"], caption_box, side, picture)
                if region is None:
                    continue
                x0, y0, x1, y1 = region
                if not (x0 <= box["x"] + box["width"] / 2 <= x1 and y0 <= box["y"] + box["height"] / 2 <= y1) or (x1-x0)*(y1-y0) < 4*box["width"]*box["height"]:
                    continue
                self._recrop_figure(picture, x0, y0, x1, y1)
                cropped_box = picture["evidence"]["boxes"][0]
                if abs(cropped_box["width"] - (x1-x0)) > .001 or abs(cropped_box["height"] - (y1-y0)) > .001:
                    continue
                picture["evidence"] = {**picture["evidence"], "boxes": picture["evidence"]["boxes"] + [caption_box]}
                for member in self._blocks_inside(picture["page"], region, picture):
                    self._absorb_block(member)
                break
        from source_tables import grid_from_source
        for picture in self.blocks:
            match = TABLE_CAPTION_RE.match(picture["text"]) if picture["kind"] == "figure" else None
            if not match or not picture["evidence"]["boxes"]:
                continue
            box = picture["evidence"]["boxes"][0]
            grid = grid_from_source(self._page_text(picture["page"]), (box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]), picture["evidence"]["sourceIds"])
            if grid:
                picture["kind"] = "table"
                picture["table"] = grid
                picture["label"] = f"Table {match.group(2)}"
                picture.pop("fallbackAssetIds", None)
                self.report.tables_semantic += 1
                self.report.figures = max(0, self.report.figures - 1)
        index = 0
        while index < len(self.blocks):
            block = self.blocks[index]
            if block["kind"] not in ("caption", "paragraph") or block["page"] is None or not block["evidence"]["boxes"] or (len(block["text"]) > 1200 and not TABLE_CAPTION_RE.match(block["text"])):
                index += 1
                continue
            table_match = TABLE_CAPTION_RE.match(block["text"])
            figure_match = FIGURE_CAPTION_RE.match(block["text"]) if not table_match else None
            if not table_match and not figure_match:
                index += 1
                continue
            kind = "table" if table_match else "figure"
            label = f"Table {table_match.group(2)}" if table_match else canonical_figure_label(figure_match)
            if any(b.get("label") == label for b in self.blocks if b["kind"] in ("table", "figure")):
                self._diagnostic("info", "tables" if table_match else "visuals", "Caption text repeats a float's label", f"{label}: another block already carries this label; left as text", None, block["page"])
                index += 1
                continue
            # caption adoption has already run: a caption-less picture still
            # beside this caption is content inside the box (an icon in a
            # prompt), so the ruled box is read regardless
            page = block["page"]
            cbox = block["evidence"]["boxes"][0]
            chosen = None
            reasons = []
            rows = self._rule_rows(page, cbox)
            spans_caption = lambda r: r[2] - r[1] >= 0.9 * cbox["width"]  # noqa: E731
            rule_above = next((r for r in reversed(rows) if r[0] <= cbox["y"] + 0.004 and cbox["y"] - r[0] <= 0.03 and spans_caption(r)), None)
            rule_below = next((r for r in rows if r[0] >= cbox["y"] + cbox["height"] - 0.004 and r[0] - (cbox["y"] + cbox["height"]) <= 0.06 and spans_caption(r)), None)
            sides = self._caption_sides(kind)
            caption_in_box = rule_above is not None and rule_below is not None
            for position_in_order, side in enumerate(sides):
                region = self._rule_box(page, cbox, side, block, open_ended=position_in_order == 0 or caption_in_box)
                if region is not None and caption_in_box and side == "below":
                    # the caption is the first row of its own box: the box
                    # starts at the rule above it
                    region = (region[0], min(region[1], rule_above[0]), region[2], region[3])
                pixel_box = False
                if region is None:
                    region = self._pixel_box(page, cbox, side, block)
                    pixel_box = region is not None
                if region is None:
                    reasons.append(f"{side}: no rule within reach")
                    continue
                members = self._blocks_inside(page, region, block)
                if kind == "table" and not any((m["kind"] in ("paragraph", "list-item", "code", "heading", "caption", "equation", "footnote") and m["text"].strip()) or m.get("table") for m in members):
                    from source_tables import grid_from_source
                    if not grid_from_source(self._page_text(page), region):
                        reasons.append(f"{side}: ruled region holds no recoverable cell text")
                        continue
                chosen = (region, members)
                break
            if chosen is None:
                self._diagnostic("info", "tables" if kind == "table" else "visuals", "No ruled box beside caption", f"{label}: {'; '.join(reasons)}", None, page)
                index += 1
                continue
            region, members = chosen
            x0, y0, x1, y1 = region
            position = index
            if kind == "table":
                table = self._table_from_blocks(block, label, members, region)
                # the table takes the place of its first member (reading order), else the caption's
                first = min([self.blocks.index(m) for m in members if m in self.blocks] + [position])
                for member in members:
                    self._absorb_block(member)
                self._absorb_block(block)
                self.blocks.insert(min(first, len(self.blocks)), table)
                position = self.blocks.index(table)
                self.report.tables_from_rule_box += 1
                self.report.tables_semantic += 1
                self._diagnostic("info", "tables", "Table read from its ruled box", f"{label}: {len(members)} text blocks inside the drawn rules became rows", None, page)
            else:
                evidence = {
                    "confidence": 0.7,
                    "pages": [page],
                    "boxes": [{"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0}],
                    "sourceIds": list(dict.fromkeys(block["evidence"]["sourceIds"] + [sid for b in members for sid in b["evidence"]["sourceIds"]]))[:8],
                    "signals": ["rule-box", "source-region-fallback", "orphan-caption"],
                }
                asset_id = self._crop_asset("figure", f"figure-ruled-{figure_match.group(2)}", page, x0, y0, x1, y1, evidence, evidence["sourceIds"], require_ink=True)
                if not asset_id:
                    self._diagnostic("info", "visuals", "Ruled box crop refused", f"{label}: the framed region {y0:.3f}-{y1:.3f} holds no ink", None, page)
                    index += 1
                    continue
                figure = {
                    "id": self._id(f"b-ruled-figure-{figure_match.group(2)}"),
                    "kind": "figure",
                    "text": clean_caption(block["text"]),
                    "label": label,
                    "page": page,
                    "order": 0,
                    "column": "single",
                    "inline": block.get("inline", []),
                    "evidence": {**evidence, "boxes": evidence["boxes"] + [cbox]},
                    "fallbackAssetIds": [asset_id],
                }
                self._attached_caption_boxes[figure["id"]] = cbox
                old_assets = {a for m in members for a in m.get("fallbackAssetIds", [])}
                self.assets = [a for a in self.assets if a["id"] not in old_assets]
                figures_inside = sum(1 for m in members if m["kind"] == "figure")
                first = min([self.blocks.index(m) for m in members if m in self.blocks] + [position])
                for member in members:
                    self._absorb_block(member)
                self._absorb_block(block)
                self.blocks.insert(min(first, len(self.blocks)), figure)
                position = self.blocks.index(figure)
                self.report.figures += 1 - figures_inside
                self.report.figures_with_caption += 1
                self.report.figures_from_rule_box += 1
                self._diagnostic("info", "visuals", "Figure cut from its ruled box", f"{label}: the framed region beside the caption ({len(members)} blocks inside) is the artwork", None, page)
            index = position + 1  # continue right after the recovered block; absorbed members shifted the rest up
