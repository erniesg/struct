"""Graph integrity: absorbing blocks, compacting provenance, pruning dangling references.

What belongs here: rules that keep the draft's blocks, assets and
relationships consistent for struct's codec and node budget, independent of
any one kind of content: removing an absorbed block (and its report counts),
compacting display provenance while keeping exact evidence in the report, and
pruning relationships and runs that point at nothing.
"""

from __future__ import annotations


class GraphRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _compact_graph(self) -> None:
        """Compact display provenance without erasing source proof or anchors.

        The report retains exact source evidence outside the canonical document
        budget. Note geometry and ownership remain in the document itself.
        """
        from copy import deepcopy

        provenance = self.report.source_provenance
        recorded = {(entry.get("parentBlockId"), entry["id"]) for entry in provenance}
        for node in self.blocks + self.assets:
            records = [(node, None)] + [(cell, node["id"]) for cell in node.get("table", {}).get("cells", [])]
            for obj, parent in records:
                key = (parent, obj["id"])
                if key in recorded:
                    continue
                entry = {"id": obj["id"], "kind": "table-cell" if parent else obj.get("kind", "asset"), "evidence": deepcopy(obj.get("evidence", {}))}
                for field in ("page", "noteBodyBlockIds", "label"):
                    if field in obj:
                        entry[field] = deepcopy(obj[field])
                if parent:
                    entry["parentBlockId"] = parent
                provenance.append(entry)
                recorded.add(key)

        note_ids = {b["id"] for b in self.blocks if b["kind"] == "footnote" or b.get("noteBodyBlockIds") or any(s.startswith("source-note") for s in b["evidence"].get("signals", []))}
        note_ids.update(child for b in self.blocks for child in b.get("noteBodyBlockIds", []))
        note_asset_ids = {asset for b in self.blocks if b["id"] in note_ids for asset in b.get("fallbackAssetIds", [])}
        # Identity-bearing furniture stays separate: changing its text or ID
        # would invalidate link occurrence offsets and report ledger anchors.
        anchored_ids = set(note_ids)
        for relationship in self.relationships:
            anchored_ids.add(relationship["from"])
            anchored_ids.update(relationship["to"])
        for block in self.blocks:
            for obj in [block] + block.get("table", {}).get("cells", []):
                for run in obj.get("inline", []):
                    anchored_ids.update(run.get("targetIds", []))
                    if run.get("href", "").startswith("#"):
                        anchored_ids.add(run["href"][1:])
        for occurrence in self.report.internal_link_coverage.get("occurrences", []):
            anchored_ids.update(occurrence[key] for key in ("blockId", "containerId", "targetId") if occurrence.get(key))

        def union_by_page(boxes):
            by_page: dict[int, list[dict]] = {}
            for box in boxes:
                by_page.setdefault(box["page"], []).append(box)
            union = []
            for page, group in sorted(by_page.items()):
                if len(group) == 1:
                    union.append(group[0])
                    continue
                x0 = min(b["x"] for b in group)
                y0 = min(b["y"] for b in group)
                x1 = max(b["x"] + b["width"] for b in group)
                y1 = max(b["y"] + b["height"] for b in group)
                union.append({"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0})
            return union

        def union_by_band(boxes):
            """Furniture merged on one page keeps a box per edge band: a running
            head, a footer and a margin stamp unioned would cover the page."""
            if len(boxes) <= 8:
                return boxes
            by_band: dict[tuple, list[dict]] = {}
            for box in boxes:
                margin = box["x"] + box["width"] <= 0.08 or box["x"] >= 0.92
                band = "margin" if margin else ("top" if box["y"] + box["height"] / 2 < 0.5 else "bottom")
                by_band.setdefault((box["page"], band), []).append(box)
            return [united for group in by_band.values() for united in union_by_page(group)]

        large = len(self.blocks) + len(self.assets) > 1500
        for block in self.blocks:
            if block["id"] in note_ids:
                continue
            evidence = block["evidence"]
            if len(evidence["boxes"]) > 2 or large:
                evidence["boxes"] = union_by_page(evidence["boxes"])
            evidence["sourceIds"] = evidence["sourceIds"][:2 if large else 8]
            if large:
                evidence.pop("signals", None)
                if block.get("furniture"):
                    block["furniture"]["boxes"] = union_by_page(block["furniture"]["boxes"])
                    block["furniture"]["evidence"] = block["furniture"]["evidence"][:1]
        if large:
            for asset in self.assets:
                if asset["id"] in note_asset_ids:
                    continue
                asset["evidence"].pop("signals", None)
                asset["evidence"]["boxes"] = union_by_page(asset["evidence"]["boxes"])
            self.report.provenance_trimmed_for_budget = True
        merged: list[dict] = []
        furniture_by_page: dict[int, dict] = {}
        for block in self.blocks:
            if block["kind"] != "furniture" or block["page"] is None or block.get("inline") or block["id"] in anchored_ids or block.get("attributes") or block.get("fallbackAssetIds"):
                merged.append(block)
                continue
            existing = furniture_by_page.get(block["page"])
            if existing is None:
                furniture_by_page[block["page"]] = block
                merged.append(block)
                continue
            existing["text"] = f"{existing['text']} {block['text']}".strip()
            existing["evidence"]["boxes"] = union_by_band(existing["evidence"]["boxes"] + block["evidence"]["boxes"])
            existing["evidence"]["pages"] = sorted(set(existing["evidence"]["pages"] + block["evidence"]["pages"]))
            existing["evidence"]["sourceIds"] = list(dict.fromkeys(existing["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))[:2 if large else 8]
            if not large:
                existing["evidence"]["signals"] = list(dict.fromkeys(existing["evidence"].get("signals", []) + block["evidence"].get("signals", [])))
            furniture = existing.get("furniture")
            if furniture:
                furniture["boxes"] = union_by_band(furniture["boxes"] + block.get("furniture", {}).get("boxes", []))
                furniture["evidence"] = list(dict.fromkeys(furniture["evidence"] + block.get("furniture", {}).get("evidence", [])))[:6]
                furniture["normalizedText"] = f"{furniture.get('normalizedText', '')} {block.get('furniture', {}).get('normalizedText', '')}".strip()[:300]
            self.report.furniture_blocks_merged += 1
        self.blocks = merged

    def _prune_dangling_references(self) -> None:
        """Remove invalid references in blocks and cells, preserving valid runs.

        Core local targets are block and asset IDs; table cell IDs are scoped
        to their table and are not relationship endpoints in the codec.
        """
        ids = {b["id"] for b in self.blocks} | {a["id"] for a in self.assets}
        kept = []
        for relationship in self.relationships:
            if relationship["from"] in ids and all(t in ids for t in relationship["to"]):
                kept.append(relationship)
            else:
                self.report.relationships_pruned += 1
        self.relationships = kept
        relationship_ids = {r["id"] for r in self.relationships}
        for block in self.blocks:
            for obj in [block] + block.get("table", {}).get("cells", []):
                runs = []
                for original in obj.get("inline", []):
                    run = dict(original)
                    if run.get("relationshipId") and run["relationshipId"] not in relationship_ids:
                        run.pop("relationshipId")
                    if any(t not in ids for t in run.get("targetIds", [])):
                        targets = [t for t in run["targetIds"] if t in ids]
                        if targets:
                            run["targetIds"] = targets
                        else:
                            run.pop("targetIds")
                    if run.get("href", "").startswith("#") and run["href"][1:] not in ids:
                        run.pop("href")
                    if run != original:
                        self.report.runs_pruned += 1
                        # A removed reference can still carry independent text
                        # styling, external href, or MathML worth preserving.
                        if not (run.get("targetIds") or run.get("href") or run.get("relationshipId")):
                            run.pop("kind", None)
                            run.pop("semanticRole", None)
                            if set(run) <= {"start", "end"}:
                                continue
                    runs.append(run)
                obj["inline"] = runs
            for asset_id in list(block.get("fallbackAssetIds", [])):
                if asset_id not in ids:
                    block["fallbackAssetIds"].remove(asset_id)

    def _absorb_block(self, block: dict) -> None:
        """Remove a block whose content now lives in a crop; relationships to
        it are dropped by `_prune_dangling_references`."""
        if block in self.blocks:
            self.blocks.remove(block)
        if block["kind"] == "paragraph":
            self.report.paragraphs -= 1
        elif block["kind"] == "caption":
            self.report.orphan_captions = max(0, self.report.orphan_captions - 1)
        elif block["kind"] == "footnote":
            self.report.footnotes = max(0, self.report.footnotes - 1)
            if block.get("label"):
                self.report.footnotes_with_marker = max(0, self.report.footnotes_with_marker - 1)
            self._notes = [entry for entry in self._notes if entry[0] is not block]
