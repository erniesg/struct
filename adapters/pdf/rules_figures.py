"""Figures: picture emission, crops, panel folding and artwork recovery.

What belongs here: emitting a picture as a figure block with its crop; what a
figure's crop absorbs (caption-less panels, sub-captions, chart and tick
labels, a legend line on its foot) and what it must never cross (body text,
linked words, another caption); merging split sub-panels; and recovering
artwork the layout model missed beside an orphan caption or sub-caption. Crop
and PNG asset mechanics live in `rules_assets.py`; caption attachment in
`rules_captions.py`; further figure passes in `figure_recovery.py`.
"""

from __future__ import annotations

import re
import statistics

from docling_core.types.doc import PictureItem, TextItem

from source_raster import SourceRasterError
from adapter_common import (
    CAPTION_LIKE_RE,
    FIGURE_CAPTION_RE,
    FIGURE_OWNER_RE,
    PAGE_NUMBER_TEXT_RE,
    SUBCAPTION_RE,
    TICK_LABEL_RE,
    TICK_ROW_RE,
    canonical_figure_label,
    clean_caption,
    sanitize,
)


class FigureRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _figure_foot_line(self, item: TextItem) -> bool:
        """`Prototypes: cortical L5 · hippocampal CA1 · cerebellar Purkinje`:
        one line of text standing on the foot of a caption-less picture (its
        box overlapping the picture by at least half its height) with a
        `Figure N` caption directly under it is the figure's own text, a
        panel legend the layout model left outside the picture, not a
        paragraph. It belongs to the crop and leaves the flow; the caption
        then stands next to its figure."""
        prov = getattr(item, "prov", None) or []
        if len(prov) != 1:
            return False
        box = self._box(item)
        if box is None or box["height"] > 0.016 or box["width"] < 0.05:
            return False
        text = sanitize(item.text).strip()
        if len(text.split()) < 3 or CAPTION_LIKE_RE.match(text) or PAGE_NUMBER_TEXT_RE.match(text):
            return False
        pictures, captions = self._foot_line_index()
        on_picture = False
        for pbox in pictures.get(box["page"], []):
            x_overlap = min(pbox["x"] + pbox["width"], box["x"] + box["width"]) - max(pbox["x"], box["x"])
            y_overlap = min(pbox["y"] + pbox["height"], box["y"] + box["height"]) - max(pbox["y"], box["y"])
            if x_overlap >= 0.8 * box["width"] and y_overlap >= 0.5 * box["height"]:
                on_picture = True
                break
        if not on_picture:
            return False
        for ref, cbox in captions.get(box["page"], []):
            if ref == item.self_ref:
                continue
            x_overlap = min(cbox["x"] + cbox["width"], box["x"] + box["width"]) - max(cbox["x"], box["x"])
            if x_overlap > 0 and -0.005 <= cbox["y"] - (box["y"] + box["height"]) <= 0.03:
                self.report.figure_foot_lines_absorbed += 1
                return True
        return False

    def _foot_line_index(self) -> tuple[dict, dict]:
        """Per page: the boxes of the caption-less pictures, and of every
        text item that opens as a `Figure N` caption; built once per document."""
        index = getattr(self, "_foot_line_boxes", None)
        if index is not None:
            return index
        pictures: dict[int, list] = {}
        captions: dict[int, list] = {}
        for other, _ in self.doc.iterate_items():
            if isinstance(other, PictureItem) and not getattr(other, "captions", None):
                pbox = self._box(other)
                if pbox is not None:
                    pictures.setdefault(pbox["page"], []).append(pbox)
            elif isinstance(other, TextItem) and FIGURE_CAPTION_RE.match(sanitize(other.text).strip()):
                cbox = self._box(other)
                if cbox is not None:
                    captions.setdefault(cbox["page"], []).append((other.self_ref, cbox))
        self._foot_line_boxes = (pictures, captions)
        return self._foot_line_boxes

    def _emit_picture(self, item: PictureItem) -> None:
        caption = self._caption_text(item)
        box = self._box(item)
        caption_boxes = [self._box(ref.resolve(self.doc)) for ref in getattr(item, "captions", [])]
        caption_boxes = [b for b in caption_boxes if b]
        if box and caption_boxes:
            self._figure_caption_below.append(caption_boxes[0]["y"] >= box["y"] + box["height"] * 0.5)
        if not caption and box and box["width"] * box["height"] < 0.01:
            self.report.decorative_pictures_skipped += 1
            return
        if not caption and box and self._emit_undecodable_text_region(item, box):
            return
        self._flush()
        self.report.figures += 1
        image = None
        try:
            image = item.get_image(self.doc)
        except Exception as error:  # pragma: no cover
            self.report.warnings.append(f"picture image unavailable: {error}")
        if box:
            page_image = self._page_image(box["page"])
            if page_image is not None:
                width, height = page_image.size
                # Detector boxes often land on the outer stroke or glyph.
                # A small source-space margin preserves those edge pixels.
                x0, y0 = max(0.0, box["x"] - 0.002), max(0.0, box["y"] - 0.002)
                x1, y1 = min(1.0, box["x"] + box["width"] + 0.002), min(1.0, box["y"] + box["height"] + 0.002)
                box = {**box, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5)}
                image = page_image.crop((int(x0 * width), int(y0 * height), int(x1 * width), int(y1 * height)))
        label_match = FIGURE_CAPTION_RE.match(caption or "")
        label = canonical_figure_label(label_match) if label_match else None
        block = self._new_block("figure", item, caption, **({"label": label} if label else {}))
        block["inline"] = self._caption_links(item, block["text"])
        if box and image is not None:
            block["evidence"]["boxes"] = [box]
        block["evidence"]["sourceIds"] = list(dict.fromkeys(block["evidence"]["sourceIds"] + [self._source_id(ref.resolve(self.doc)) for ref in item.captions]))
        if caption_boxes:
            self._attached_caption_boxes[block["id"]] = caption_boxes[0]
            if len(caption_boxes) > 1:
                additional = getattr(self, "_additional_caption_boxes", {})
                additional[block["id"]] = [dict(b) for b in caption_boxes[1:]]
                self._additional_caption_boxes = additional
        asset_id = self._asset("figure", f"figure-{self.report.figures:03d}", image, item)
        if asset_id:
            block["fallbackAssetIds"] = [asset_id]
            if box:
                self.assets[-1]["evidence"]["boxes"] = [dict(box)]
        else:
            self.report.figures_without_image += 1
            self._diagnostic("warning", "visuals", "Figure image unavailable", f"{label or 'a caption-less figure'} has no crop", item)
        if caption:
            self.report.figures_with_caption += 1
        self.blocks.append(block)
        # A diagram's linked label must also be available as readable text;
        # walking normally skips PictureItem children.
        for ref in item.children:
            child = ref.resolve(self.doc)
            if isinstance(child, TextItem) and child.self_ref not in self._caption_refs and self._item_links.get(child.self_ref):
                self._emit_paragraph(child)
                self._flush()
                self.blocks[-1]["evidence"].setdefault("signals", []).append("figure-linked-label")

    def _recrop_figure(self, block: dict, x0: float, y0: float, x1: float, y1: float) -> None:
        """Replace a figure's crop with a sub-region of it."""
        if y1 - y0 < 0.02 or x1 - x0 < 0.02:
            return
        page = block["page"]
        evidence = dict(block["evidence"])
        evidence["boxes"] = [{"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0}]
        evidence["signals"] = list(dict.fromkeys((evidence.get("signals") or []) + ["source-region-fallback", "recropped"]))
        asset_id = self._crop_asset("figure", f"figure-recrop-{block['id']}", page, x0, y0, x1, y1, evidence, evidence["sourceIds"])
        if not asset_id:
            return
        old = set(block.get("fallbackAssetIds", []))
        self.assets = [a for a in self.assets if a["id"] not in old]
        block["fallbackAssetIds"] = [asset_id]
        block["evidence"] = evidence

    def _recover_subcaption_panels(self) -> None:
        """A panel of a figure continued over several pages (`(b) Layers 7-13`
        under a page of heat maps) can carry only its sub-caption. With no
        figure on its page and a run of at least five chart labels above it,
        the layout model missed the artwork: the band of labels, grown to the
        drawing's ink, is recovered as a figure that keeps the sub-caption."""
        for index, block in enumerate(list(self.blocks)):
            if block not in self.blocks or block["kind"] != "caption" or block["page"] is None or not block["evidence"]["boxes"]:
                continue
            if not SUBCAPTION_RE.match(block["text"]) or len(block["text"]) > 160:
                continue
            page = block["page"]
            if any(other["kind"] in ("figure", "table") and other["page"] == page for other in self.blocks):
                continue
            band = self._panel_band(self.blocks.index(block), block, "above")
            if band is None:
                continue
            (x0, top, x1, bottom), members = band
            bottom = min(bottom, block["evidence"]["boxes"][0]["y"] - 0.002)  # not the sub-caption's own glyphs
            if len(members) < 5 or bottom - top < 0.1:
                continue
            # the labels beside the column (row names, tick values) belong to the same drawing
            for other in self.blocks:
                if other is block or other in members or other["page"] != page or other["kind"] == "furniture" or not other["evidence"]["boxes"] or not self._figure_like(other):
                    continue
                if all(box["page"] == page and top <= box["y"] and box["y"] + box["height"] <= bottom for box in other["evidence"]["boxes"]):
                    members.append(other)
                    x0 = min(x0, min(box["x"] for box in other["evidence"]["boxes"]) - 0.003)
                    x1 = max(x1, max(box["x"] + box["width"] for box in other["evidence"]["boxes"]) + 0.003)
            x0, x1 = max(0.0, x0), min(1.0, x1)
            image = self._page_image(page)
            if image is None:
                continue
            width, height = image.size
            crop = image.crop((int(x0 * width), int(top * height), int(x1 * width), int(bottom * height)))
            if not self._has_ink(crop):
                continue
            figure = {
                "id": self._id(f"b-recovered-panel-{block['id']}"),
                "kind": "figure",
                "text": block["text"],
                "page": page,
                "order": 0,
                "column": "single",
                "inline": block.get("inline", []),
                "evidence": {
                    "confidence": 0.6,
                    "pages": [page],
                    "boxes": [{"page": page, "x": round(x0, 5), "y": round(top, 5), "width": round(x1 - x0, 5), "height": round(bottom - top, 5), "rotation": 0}],
                    "sourceIds": list(dict.fromkeys(block["evidence"]["sourceIds"] + [sid for member in members for sid in member["evidence"]["sourceIds"]])),
                    "signals": ["source-region-fallback", "sub-caption-panel"],
                },
            }
            asset_id = self._asset_from_image("figure", f"figure-panel-{block['id']}", crop, figure["evidence"], figure["evidence"]["sourceIds"])
            if not asset_id:
                continue
            figure["fallbackAssetIds"] = [asset_id]
            self._attached_caption_boxes[figure["id"]] = dict(block["evidence"]["boxes"][0])
            position = min(self.blocks.index(m) for m in members + [block])
            for member in members:
                self._absorb_block(member)
            self._absorb_block(block)
            self.blocks.insert(min(position, len(self.blocks)), figure)
            self.report.figures += 1
            self.report.figures_with_caption += 1
            self.report.figures_recovered_from_source += 1

    def _recover_uncaptured_figures(self) -> None:
        """An orphan `Figure N` caption with no figure beside it means the layout
        model missed the artwork. Recover it as a source-region crop: the page
        band above the caption, bounded by the previous block in that column
        and the caption's own horizontal extent, cut from the page image."""
        rebuilt: list[dict] = []
        for index, block in enumerate(self.blocks):
            if block.get("_absorbed"):
                continue
            label_match = FIGURE_CAPTION_RE.match(block["text"])
            claimed = any(
                0 <= index + delta < len(self.blocks)
                and self.blocks[index + delta]["kind"] == "figure"
                and (
                    not self.blocks[index + delta]["text"]
                    or (label_match and self.blocks[index + delta].get("label") == canonical_figure_label(label_match))
                )
                for delta in (-1, 1)
            )
            is_orphan = (
                block["kind"] in ("caption", "paragraph")
                and label_match is not None
                and len(block["text"]) < 1200
                and not claimed
                and not any(f.get("label") == canonical_figure_label(label_match) for f in self.blocks if f["kind"] == "figure")
            )
            if not is_orphan or not block["evidence"]["boxes"] or block["page"] is None:
                rebuilt.append(block)
                continue
            page = block["page"]
            caption_box = block["evidence"]["boxes"][0]
            image = self._page_image(page)
            if image is None:
                rebuilt.append(block)
                continue
            absorbed: list[dict] = []
            band = self._panel_band(index, block, "above")
            if band is None and index + 1 < len(self.blocks):
                band = self._panel_band(index, block, "below")
            if band is not None:
                # the caption's neighbours are panels, sub-captions and chart
                # labels: the run of them is the artwork
                (x0, top, x1, bottom), absorbed = band
                x0, top, x1, bottom = max(0.0, x0), max(0.0, top), min(1.0, x1), min(1.0, bottom)
                signals = ["source-region-fallback", "orphan-caption", "panel-band"]
            else:
                # column extent: widen a narrow caption to its column; span captions keep their width
                x0 = max(0.0, caption_box["x"] - 0.02)
                x1 = min(1.0, caption_box["x"] + caption_box["width"] + 0.02)
                if caption_box["width"] < 0.5:
                    x0 = max(0.0, x0 - 0.03)
                    x1 = min(1.0, x1 + 0.03)
                top = 0.06
                for previous in reversed(rebuilt):
                    if previous["page"] != page or not previous["evidence"]["boxes"]:
                        continue
                    pbox = previous["evidence"]["boxes"][-1]
                    overlaps_column = pbox["x"] < x1 and pbox["x"] + pbox["width"] > x0
                    if overlaps_column and pbox["y"] + pbox["height"] <= caption_box["y"]:
                        top = max(top, pbox["y"] + pbox["height"] + 0.005)
                        break
                bottom = caption_box["y"] - 0.003
                signals = ["source-region-fallback", "orphan-caption"]
            if bottom - top < 0.04:
                self._diagnostic("info", "visuals", "No artwork beside caption", f"{label_match.group(0).strip()}: the band {'of panels ' if absorbed else ''}above the caption is {bottom - top:.3f} of the page tall", None, page)
                rebuilt.append(block)
                continue
            width, height = image.size
            crop = image.crop((int(x0 * width), int(top * height), int(x1 * width), int(bottom * height)))
            if not self._has_ink(crop):
                self._diagnostic("info", "visuals", "No artwork beside caption", f"{label_match.group(0).strip()}: the band of panels beside the caption is blank", None, page)
                rebuilt.append(block)
                continue
            self.report.figures += 1
            self.report.figures_with_caption += 1
            self.report.figures_recovered_from_source += 1
            if block["kind"] == "caption":
                self.report.orphan_captions -= 1
            else:
                self.report.paragraphs -= 1
            label = FIGURE_CAPTION_RE.match(block["text"])
            figure = {
                "id": self._id(f"b-recovered-figure-{label.group(2)}"),
                "kind": "figure",
                "text": clean_caption(block["text"]),
                "label": canonical_figure_label(label),
                "page": page,
                "order": 0,
                "column": "single",
                "inline": block.get("inline", []),
                "evidence": {
                    "confidence": 0.6,
                    "pages": [page],
                    "boxes": [{"page": page, "x": round(x0, 5), "y": round(top, 5), "width": round(x1 - x0, 5), "height": round(bottom - top, 5), "rotation": 0}],
                    "sourceIds": list(dict.fromkeys(block["evidence"]["sourceIds"] + [sid for member in absorbed for sid in member["evidence"]["sourceIds"]])),
                    "signals": signals,
                },
            }
            self._attached_caption_boxes[figure["id"]] = dict(caption_box)
            asset_id = self._asset_from_image("figure", f"figure-recovered-{label.group(2)}", crop, figure["evidence"], block["evidence"]["sourceIds"])
            if asset_id:
                figure["fallbackAssetIds"] = [asset_id]
            if absorbed:
                old_assets = {a for m in absorbed for a in m.get("fallbackAssetIds", [])}
                self.assets = [a for a in self.assets if a["id"] not in old_assets]
                for member in absorbed:
                    if member["kind"] == "figure":
                        self.report.figures -= 1
                    if member in rebuilt:
                        rebuilt.remove(member)
                    else:
                        member["_absorbed"] = True
                self.report.figures_from_panel_band += 1
            self._diagnostic("info", "visuals", "Figure recovered from source region", f"{figure['label']} cut from the page band {'of panels beside' if absorbed else 'above'} its caption", None, page)
            rebuilt.append(figure)
        self.blocks = [b for b in rebuilt if not b.get("_absorbed")]

    def _merge_subpanel_figures(self) -> None:
        """Consecutive caption-less pictures on one page that sit beside or
        above one another are the panels of one figure the layout model
        split; they merge into a single figure cropped from the union box."""
        index = 0
        while index < len(self.blocks):
            block = self.blocks[index]
            if not (block["kind"] == "figure" and not block["text"] and block["evidence"]["boxes"] and block["page"] is not None):
                index += 1
                continue
            group = [block]
            j = index + 1
            while j < len(self.blocks):
                nxt = self.blocks[j]
                if nxt["kind"] == "figure" and not nxt["text"] and nxt["evidence"]["boxes"] and nxt["page"] == block["page"]:
                    last = group[-1]["evidence"]["boxes"][0]
                    nbox = nxt["evidence"]["boxes"][0]
                    ux0, ux1 = min(last["x"], nbox["x"]), max(last["x"] + last["width"], nbox["x"] + nbox["width"])
                    if self._caption_between(block["page"], last["y"], last["y"] + last["height"], nbox, ux0, ux1):
                        break  # a caption between two pictures separates two figures
                    group.append(nxt)
                    j += 1
                else:
                    break
            if len(group) >= 2 and self._union_figure(block, group):
                index += 1
                continue
            index += 1

    def _union_figure(self, keeper: dict, group: list[dict], max_height: float = 0.8) -> bool:
        """Replace the keeper's crop with the union of the group's boxes; the
        other members and their assets go away. False when the boxes are not
        aligned neighbours or the union is not compact."""
        boxes = [b["evidence"]["boxes"][0] for b in group]
        aligned = all(
            min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]) >= 0.3 * min(a["width"], b["width"])
            or min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]) >= 0.3 * min(a["height"], b["height"])
            for a, b in zip(boxes, boxes[1:])
        )
        x0 = min(b["x"] for b in boxes)
        y0 = min(b["y"] for b in boxes)
        x1 = max(b["x"] + b["width"] for b in boxes)
        y1 = max(b["y"] + b["height"] for b in boxes)
        panel_area = sum(b["width"] * b["height"] for b in boxes)
        if not aligned or (x1 - x0) * (y1 - y0) > max(1.8 * panel_area, panel_area + 0.02) or y1 - y0 > max_height:
            return False
        page = keeper["page"]
        union = {"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0}
        source_ids = list(dict.fromkeys(sid for b in group for sid in b["evidence"]["sourceIds"]))
        evidence = {"confidence": 0.7, "pages": [page], "boxes": [union], "sourceIds": source_ids, "signals": ["source-region-fallback", "subpanel-union"]}
        asset_id = self._crop_asset("figure", f"figure-panels-{keeper['id']}", page, x0, y0, x1, y1, evidence, source_ids)
        if not asset_id:
            return False
        old_assets = {a for b in group for a in b.get("fallbackAssetIds", [])}
        self.assets = [a for a in self.assets if a["id"] not in old_assets]
        keeper["fallbackAssetIds"] = [asset_id]
        keeper["evidence"] = evidence
        for member in group:
            if member is not keeper and member in self.blocks:
                self.blocks.remove(member)
        self.report.subpanel_figures_merged += len(group) - 1
        self.report.figures -= len(group) - 1
        return True

    def _fold_panels_into_captioned_figures(self) -> None:
        """Caption-less pictures beside a captioned figure on the same page
        (immediately before or after it, aligned and adjacent) are its other
        panels: they fold into that figure's crop."""
        changed = True
        while changed:
            changed = False
            for index, block in enumerate(self.blocks):
                if block["kind"] != "figure" or not block["text"] or not block["evidence"]["boxes"] or block["page"] is None:
                    continue
                fbox = block["evidence"]["boxes"][0]
                for neighbour_index in (index - 1, index + 1):
                    if not (0 <= neighbour_index < len(self.blocks)):
                        continue
                    neighbour = self.blocks[neighbour_index]
                    if neighbour["kind"] != "figure" or neighbour["text"] or neighbour["page"] != block["page"] or not neighbour["evidence"]["boxes"]:
                        continue
                    nbox = neighbour["evidence"]["boxes"][0]
                    vertical_gap = max(nbox["y"] - (fbox["y"] + fbox["height"]), fbox["y"] - (nbox["y"] + nbox["height"]))
                    horizontal_gap = max(nbox["x"] - (fbox["x"] + fbox["width"]), fbox["x"] - (nbox["x"] + nbox["width"]))
                    if min(vertical_gap, horizontal_gap) > 0.04:
                        continue
                    attached = self._attached_caption_boxes.get(block["id"])
                    if attached is not None and vertical_gap > 0:
                        cap_center = attached["y"] + attached["height"] / 2
                        if (nbox["y"] >= fbox["y"] + fbox["height"] and fbox["y"] + fbox["height"] - 0.01 < cap_center < nbox["y"]) or (nbox["y"] + nbox["height"] <= fbox["y"] and nbox["y"] + nbox["height"] < cap_center < fbox["y"] + 0.01):
                            continue  # the neighbour lies beyond this figure's own caption
                    group = [neighbour, block] if neighbour_index < index else [block, neighbour]
                    if self._union_figure(block, group):
                        self.report.figures_with_caption += 0
                        changed = True
                        break
                if changed:
                    break

    def _retained_visual_owner(self, block: dict) -> dict | None:
        """A numeric fragment may leave prose only if its source remains in
        a retained visual crop. Small dimensions alone do not imply noise."""
        boxes = block["evidence"]["boxes"]
        if not boxes or any(run.get("href") or run.get("kind") == "note-reference" for run in block.get("inline", [])):
            return None
        for visual in self.blocks:
            if visual is block or visual["kind"] not in ("figure", "table", "equation") or not visual.get("fallbackAssetIds"):
                continue
            if all(any(
                box["page"] == region["page"] and box["x"] >= region["x"] - 0.004
                and box["y"] >= region["y"] - 0.004
                and box["x"] + box["width"] <= region["x"] + region["width"] + 0.004
                and box["y"] + box["height"] <= region["y"] + region["height"] + 0.004
                for region in visual["evidence"]["boxes"]) for box in boxes):
                return visual
        return None

    def _drop_tick_label_runs(self) -> None:
        """Three or more consecutive number-only blocks on one page are chart
        tick labels that the layout model left outside the picture crop; they
        are figure content, not prose."""
        kept: list[dict] = []
        run: list[dict] = []

        def flush_run() -> None:
            nonlocal run
            if len(run) >= 3:
                dropped = 0
                for label in run:
                    owner = self._retained_visual_owner(label)
                    if owner is None:
                        kept.append(label)
                        continue
                    owner["evidence"]["sourceIds"] = list(dict.fromkeys(owner["evidence"]["sourceIds"] + label["evidence"]["sourceIds"]))
                    dropped += 1
                self.report.tick_label_runs_dropped += dropped
                if dropped:
                    self._diagnostic("info", "visuals", "Chart labels retained in crop", f"{dropped} number-only lines retained as visual content", None, run[0]["page"])
            else:
                kept.extend(run)
            run = []

        for block in self.blocks:
            if block["kind"] == "paragraph" and TICK_LABEL_RE.match(block["text"]) and (not run or run[-1]["page"] == block["page"]):
                run.append(block)
                continue
            flush_run()
            kept.append(block)
        flush_run()
        self.blocks = kept

    def _drop_numeric_fragments(self) -> None:
        """A number-only block the size of a single glyph outside the page's
        edge bands is a fraction digit or chart tick the layout model cut out
        of a formula or figure; it cannot be a page number and reads as noise."""
        kept: list[dict] = []
        for block in self.blocks:
            box = block["evidence"]["boxes"][0] if block["evidence"]["boxes"] else None
            if (
                block["kind"] == "paragraph"
                and box is not None
                and TICK_LABEL_RE.match(block["text"])
                and box["height"] < 0.012
                and box["width"] < 0.025
                and 0.06 < box["y"] < 0.94
                and (owner := self._retained_visual_owner(block)) is not None
            ):
                owner["evidence"]["sourceIds"] = list(dict.fromkeys(owner["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
                self.report.numeric_fragments_dropped += 1
                continue
            kept.append(block)
        self.blocks = kept

    def _set_at_body_size(self, block: dict) -> bool:
        """True when the block's glyphs are at least as tall as the body text
        (median glyph height inside the long paragraphs of its page, or of the
        whole paper when its page has none, a page of figures)."""
        page_text = self._page_text(block["page"])
        if page_text is None or not block["evidence"]["boxes"]:
            return False

        def heights(page: int, boxes: list[dict]) -> list[float]:
            text = self._page_text(page)
            if text is None:
                return []
            return [char.height for box in boxes if box["page"] == page for char in text.chars
                    if char.text.strip() and not char.superscript and text._inside(char, box)]

        def body_size(page: int | None) -> float | None:
            cache = self.__dict__.setdefault("_body_size_cache", {})
            if page not in cache:
                pages = [page] if page is not None else sorted({b["page"] for b in self.blocks if b["page"] is not None})
                found = [h for p in pages for other in self.blocks if other["page"] == p and other["kind"] == "paragraph" and len(other["text"]) >= 200
                         for h in heights(p, other["evidence"]["boxes"])]
                cache[page] = statistics.median(found) if found else None
            return cache[page]

        own = heights(block["page"], block["evidence"]["boxes"])
        body = body_size(block["page"]) or body_size(None)
        if not own or not body:
            return False
        return statistics.median(own) >= 0.95 * body

    def _union_covers_text(self, page: int, x0: float, y0: float, x1: float, y1: float, members: list[dict]) -> bool:
        """True when a block of body text that is not artwork (not figure-like,
        not one of the members) has a box centred inside the region."""
        for other in self.blocks:
            if other["page"] != page or any(other is m for m in members) or other["kind"] not in ("paragraph", "heading", "list-item", "caption", "footnote"):
                continue
            if self._figure_like(other):
                continue
            for box in other["evidence"]["boxes"]:
                cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                if box["page"] == page and x0 + 0.005 < cx < x1 - 0.005 and y0 + 0.005 < cy < y1 - 0.005:
                    return True
        return False

    def _figure_like(self, block: dict) -> bool:
        """Blocks that belong to a figure's artwork when they sit beside it:
        caption-less pictures, sub-captions, chart labels, short labels."""
        if "figure-linked-label" in block["evidence"].get("signals", []):
            return False
        text = block["text"].strip()
        if block["kind"] == "figure" and not CAPTION_LIKE_RE.match(text):
            return True
        if block["kind"] == "caption" and not CAPTION_LIKE_RE.match(text):
            return True
        if block["kind"] in ("paragraph", "caption", "heading", "list-item"):
            if SUBCAPTION_RE.match(text) and len(text) < 160:
                return True
            if TICK_LABEL_RE.match(text) or TICK_ROW_RE.match(text):
                return True
            if len(text) < 60 and not re.search(r"[.!?]\s", text) and not CAPTION_LIKE_RE.match(text):
                return True
            if "caption-head" in (block["evidence"].get("signals") or []):
                return True
        if block["kind"] == "code":
            return True  # a listing the layout model recognised, beside a caption
        if block["kind"] == "paragraph" and block["evidence"]["boxes"] and block["page"] is not None:
            # a listing set in a monospace face between a picture and its caption
            page_text = self._page_text(block["page"])
            if page_text is not None:
                mono = total = 0
                for box in block["evidence"]["boxes"]:
                    if box["page"] != block["page"]:
                        continue
                    share = page_text.font_share(box)
                    mono += share["mono"] * share["total"]
                    total += share["total"]
                if total >= 10 and mono >= 0.5 * total:
                    return True
        return False

    def _panel_band(self, index: int, caption: dict, side: str) -> tuple[tuple[float, float, float, float], list[dict]] | None:
        """The run of figure-like blocks stacked against one side of the
        caption in its column, by geometry rather than reading order (chart
        labels land anywhere in the layout model's order): a region plus the
        blocks it covers; None when the run holds no picture and is too small
        to be artwork."""
        page = caption["page"]
        cbox = caption["evidence"]["boxes"][0]
        x0 = max(0.0, cbox["x"] - 0.015)
        x1 = min(1.0, cbox["x"] + cbox["width"] + 0.015)
        column = []
        for candidate in self.blocks:
            if candidate is caption or candidate["page"] != page or candidate["kind"] == "furniture" or not candidate["evidence"]["boxes"]:
                continue
            box = candidate["evidence"]["boxes"][0]
            if min(box["x"] + box["width"], x1) - max(box["x"], x0) < 0.3 * min(box["width"], x1 - x0):
                continue
            if side == "above" and box["y"] + box["height"] <= cbox["y"] + 0.01:
                column.append((box["y"] + box["height"], candidate))
            elif side == "below" and box["y"] >= cbox["y"] + cbox["height"] - 0.01:
                column.append((-box["y"], candidate))
        column.sort(key=lambda entry: -entry[0])  # nearest the caption first
        members: list[dict] = []
        limit = cbox["y"] if side == "above" else cbox["y"] + cbox["height"]
        edge = 0.06 if side == "above" else 0.94
        for _, candidate in column:
            box = candidate["evidence"]["boxes"][0]
            if not self._figure_like(candidate):
                edge = box["y"] + box["height"] + 0.004 if side == "above" else box["y"] - 0.004
                break
            members.append(candidate)
            limit = min(limit, box["y"]) if side == "above" else max(limit, box["y"] + box["height"])
        if not members:
            return None
        # Every absorbed block must fit horizontally inside the crop,
        # including code listings that are wider than their centred caption.
        member_boxes = [box for member in members for box in member["evidence"]["boxes"] if box.get("page", page) == page]
        x0 = max(0.0, min([x0] + [box["x"] - 0.003 for box in member_boxes]))
        x1 = min(1.0, max([x1] + [box["x"] + box["width"] + 0.003 for box in member_boxes]))
        pictures = [m for m in members if m["kind"] == "figure"]
        if side == "above":
            top, bottom = min(limit, max(edge, 0.0)) if pictures else limit, cbox["y"] - 0.003
            top = max(top, edge) if edge > top else top
        else:
            top, bottom = cbox["y"] + cbox["height"] + 0.003, (max(limit, min(edge, 1.0)) if pictures else limit)
            bottom = min(bottom, edge) if edge < bottom else bottom
        if not pictures and bottom - top < 0.04:
            return None
        if not pictures:
            # labels alone mark where the artwork is, not where it ends: the drawing
            # (a legend row, a frame's top) runs on until blank rows or the edge
            try:
                rows = self._pixel_rows(page, x0, x1)
            except SourceRasterError:
                rows = None
            if rows is not None:
                _, nonwhite, height = rows
                gap = max(3, int(0.008 * height))
                step, start, stop = (-1, int(top * height) - 1, int(max(edge, 0.0) * height)) if side == "above" else (1, int(bottom * height) + 1, int(min(edge, 1.0) * height))
                reached, blank, row = start - step, 0, start
                while (row >= stop if side == "above" else row <= stop) and 0 <= row < len(nonwhite):
                    if nonwhite[row] > 0.002:
                        reached, blank = row, 0
                    else:
                        blank += 1
                        if blank >= gap:
                            break
                    row += step
                if side == "above":
                    top = min(top, reached / height)
                else:
                    bottom = max(bottom, reached / height)
        return (x0, top - 0.003, x1, bottom + 0.003), members

    def _gap_is_figure_like(self, page: int, uy0: float, uy1: float, box: dict, ux0: float, ux1: float) -> bool:
        """A figure may not grow across prose, even if the gap is short."""
        lo = min(uy1, box["y"] + box["height"])
        hi = max(uy0, box["y"])
        for other in self.blocks:
            if other["page"] != page or other["kind"] == "furniture":
                continue
            for obox in other["evidence"]["boxes"]:
                if obox.get("page", page) != page:
                    continue
                cy = obox["y"] + obox["height"] / 2
                if not (lo < cy < hi) or min(ux1, obox["x"] + obox["width"]) - max(ux0, obox["x"]) <= 0:
                    continue
                if not self._figure_like(other):
                    return False
        return True

    def _caption_between(self, page: int, uy0: float, uy1: float, box: dict, ux0: float, ux1: float) -> bool:
        lo = min(uy1, box["y"] + box["height"])
        hi = max(uy0, box["y"])
        for other in self.blocks:
            if other["page"] != page or other["kind"] not in ("caption", "paragraph") or not other["evidence"]["boxes"]:
                continue
            if not CAPTION_LIKE_RE.match(other["text"]):
                continue
            obox = other["evidence"]["boxes"][0]
            cy = obox["y"] + obox["height"] / 2
            if lo < cy < hi and min(ux1, obox["x"] + obox["width"]) - max(ux0, obox["x"]) > 0:
                return True
        return False

    def _fold_panels_by_geometry(self) -> None:
        """A captioned figure gathers the caption-less pictures and
        sub-captions stacked against it in its column, wherever they landed
        in reading order, into one crop."""
        from figure_recovery import recover_picture_galleries

        recover_picture_galleries(self)
        changed = True
        while changed:
            changed = False
            for block in list(self.blocks):
                if block["kind"] != "figure" or not (FIGURE_CAPTION_RE.match(block["text"]) or FIGURE_OWNER_RE.match(block["text"])) or not block["evidence"]["boxes"] or block["page"] is None:
                    continue
                fbox = block["evidence"]["boxes"][0]
                group = [block]
                ux0, uy0, ux1, uy1 = fbox["x"], fbox["y"], fbox["x"] + fbox["width"], fbox["y"] + fbox["height"]
                grew = True
                while grew:
                    grew = False
                    for candidate in self.blocks:
                        if candidate in group or candidate["page"] != block["page"] or not candidate["evidence"]["boxes"]:
                            continue
                        if "figure-linked-label" in candidate["evidence"].get("signals", []) or (
                            candidate["kind"] != "figure" and any(run.get("href") for run in candidate.get("inline", []))
                        ):
                            continue  # a crop cannot carry a hyperlink: linked words stay text
                        box = candidate["evidence"]["boxes"][0]
                        page_boxes = [b for b in candidate["evidence"]["boxes"] if b["page"] == block["page"]]
                        panel_caption = self._attached_caption_boxes.get(candidate["id"])
                        if candidate["kind"] == "figure" and not FIGURE_CAPTION_RE.match(candidate["text"]) and panel_caption and panel_caption["page"] == block["page"]:
                            page_boxes = page_boxes + [panel_caption]
                        cx0, cy0 = min(b["x"] for b in page_boxes), min(b["y"] for b in page_boxes)
                        cx1, cy1 = max(b["x"] + b["width"] for b in page_boxes), max(b["y"] + b["height"] for b in page_boxes)
                        encloses = (
                            candidate["kind"] == "paragraph"
                            and cx0 <= ux0 + 0.02
                            and cx1 >= ux1 - 0.02
                            and cy0 <= uy0 + 0.02
                            and cy1 >= uy1 - 0.02
                            and (cx1 - cx0) * (cy1 - cy0) <= 1.6 * max((ux1 - ux0) * (uy1 - uy0), 1e-6)
                        )
                        if len(page_boxes) > 1:
                            # every box of the candidate on this page: a label run the
                            # walk joined into one paragraph reaches past its first line
                            box = {"page": block["page"], "x": cx0, "y": cy0, "width": cx1 - cx0, "height": cy1 - cy0, "rotation": 0}
                        if not ((candidate["kind"] == "figure" and not candidate["text"]) or self._figure_like(candidate) or encloses):
                            continue  # a paragraph whose box encloses the picture is the picture's own text layer
                        overlap = min(ux1, box["x"] + box["width"]) - max(ux0, box["x"])
                        vertical_gap = max(box["y"] - uy1, uy0 - (box["y"] + box["height"]))
                        horizontal_gap = max(box["x"] - ux1, ux0 - (box["x"] + box["width"]))
                        v_overlap = min(uy1, box["y"] + box["height"]) - max(uy0, box["y"])
                        if vertical_gap > 0 and self._caption_between(block["page"], uy0, uy1, box, ux0, ux1):
                            continue  # a caption between two pictures separates two figures
                        attached = self._attached_caption_boxes.get(block["id"])
                        if attached is not None and vertical_gap > 0:
                            cap_center = attached["y"] + attached["height"] / 2
                            if (box["y"] >= uy1 and cap_center < box["y"] and cap_center > uy1 - 0.01) or (box["y"] + box["height"] <= uy0 and cap_center > box["y"] + box["height"] and cap_center < uy0 + 0.01):
                                continue  # the candidate lies beyond this figure's own caption
                        if vertical_gap > 0 and not self._gap_is_figure_like(block["page"], uy0, uy1, box, min(ux0, box["x"]), max(ux1, box["x"] + box["width"])):
                            continue
                        # a line of text apart from the artwork is not its label unless it is a
                        # sub-caption: a section number and heading over a chart, an author line
                        # over a first-page figure (a label run joined into one paragraph that
                        # reaches into the picture is not apart from it)
                        if candidate["kind"] in ("paragraph", "heading", "list-item") and not encloses and vertical_gap > 0.015 and not SUBCAPTION_RE.match(candidate["text"]):
                            continue
                        # a line set in the body's size or larger, apart from the artwork,
                        # is an author or affiliation line over a first-page figure, not a label
                        if candidate["kind"] in ("paragraph", "heading", "list-item", "caption") and not encloses and vertical_gap > 0.015 and self._set_at_body_size(candidate):
                            continue
                        # a label reached across body text is not the picture's own
                        # (an affiliation line over the abstract beside a first-page figure)
                        if candidate["kind"] != "figure" and not encloses and self._union_covers_text(
                            block["page"], min(ux0, box["x"]), min(uy0, box["y"]), max(ux1, box["x"] + box["width"]), max(uy1, box["y"] + box["height"]), group + [candidate]
                        ):
                            continue
                        stacked = overlap >= 0.3 * min(ux1 - ux0, box["width"]) and vertical_gap <= 0.1
                        if stacked or (v_overlap >= 0.3 * min(uy1 - uy0, box["height"]) and horizontal_gap <= 0.05):
                            group.append(candidate)
                            ux0, uy0 = min(ux0, box["x"]), min(uy0, box["y"])
                            ux1, uy1 = max(ux1, box["x"] + box["width"]), max(uy1, box["y"] + box["height"])
                            grew = True
                if len(group) < 2 or uy1 - uy0 > 0.85:
                    continue
                from figure_recovery import join_caption_columns

                join_caption_columns(self, block, group)
                page = block["page"]
                attached = self._attached_caption_boxes.get(block["id"])
                caption_overlap = min(ux1, attached["x"] + attached["width"]) - max(ux0, attached["x"]) if attached is not None else 0
                if attached is not None and attached["page"] == page and caption_overlap >= 0.3 * min(ux1 - ux0, attached["width"]) and uy0 < attached["y"] + attached["height"] / 2 < uy1:
                    # the crop must not carry the caption the figure already renders
                    if attached["y"] + attached["height"] / 2 > (uy0 + uy1) / 2:
                        uy1 = max(uy0 + 0.02, attached["y"] - 0.003)
                    else:
                        uy0 = min(uy1 - 0.02, attached["y"] + attached["height"] + 0.003)
                evidence = {
                    "confidence": 0.7,
                    "pages": [page],
                    "boxes": [{"page": page, "x": round(ux0, 5), "y": round(uy0, 5), "width": round(ux1 - ux0, 5), "height": round(uy1 - uy0, 5), "rotation": 0}],
                    "sourceIds": list(dict.fromkeys(sid for b in group for sid in b["evidence"]["sourceIds"])),
                    "signals": list(dict.fromkeys(block["evidence"].get("signals", []) + ["source-region-fallback", "panel-union"])),
                }
                asset_id = self._crop_asset("figure", f"figure-panels-{block['id']}", page, ux0, uy0, ux1, uy1, evidence, evidence["sourceIds"])
                if not asset_id:
                    continue
                old_assets = {a for b in group for a in b.get("fallbackAssetIds", [])}
                self.assets = [a for a in self.assets if a["id"] not in old_assets]
                block["fallbackAssetIds"] = [asset_id]
                block["evidence"] = evidence
                for member in group:
                    if member is block:
                        continue
                    if member["kind"] == "figure":
                        self.report.figures -= 1
                        self.report.subpanel_figures_merged += 1
                    self._absorb_block(member)
                self.report.panels_folded_by_geometry += 1
                changed = True
                break
