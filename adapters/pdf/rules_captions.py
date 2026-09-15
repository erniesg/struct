"""Caption ownership: which float a `Figure N` / `Table N` caption belongs to.

What belongs here: attaching captions to figures and tables (adjacent orphans,
by geometry, across a page break, on the paper's caption side), reading a
caption from the text layer (inside a crop, beside a caption-less table),
completing a label-only caption from its lines, and dropping a caption the
figure already holds. Recovering missing artwork for a caption lives in
`rules_figures.py`; ruled boxes beside a caption in `rules_ruled_boxes.py`.
"""

from __future__ import annotations

import re

from docling_core.types.doc import TextItem

from adapter_common import (
    FIGURE_CAPTION_RE,
    SUBCAPTION_RE,
    TABLE_CAPTION_RE,
    canonical_figure_label,
    clean_caption,
    sanitize,
)


class CaptionRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _caption_text(self, item) -> str:
        captions = [ref.resolve(self.doc) for ref in getattr(item, "captions", [])]
        for caption in captions:
            self._caption_refs.add(caption.self_ref)
        return clean_caption(sanitize(" ".join(c.text.strip() for c in captions if isinstance(c, TextItem) and c.text.strip())))

    def _adopt_orphan_captions(self) -> None:
        """A caption-less figure adopts an adjacent orphan caption block on the
        same page (the layout model detected both but did not associate them)."""
        kept: list[dict] = []
        index = 0
        while index < len(self.blocks):
            block = self.blocks[index]
            if block["kind"] == "figure" and not block["text"]:
                for neighbour_index in (index + 1, index - 1):
                    if 0 <= neighbour_index < len(self.blocks):
                        neighbour = self.blocks[neighbour_index]
                        owned = {t for r in self.relationships for t in r["to"]}
                        if (
                            neighbour["kind"] in ("caption", "paragraph")
                            and neighbour["id"] not in owned
                            and neighbour["page"] == block["page"]
                            and FIGURE_CAPTION_RE.match(neighbour["text"])
                            # a paragraph opening `Figure N` is a caption only
                            # when short; a block the layout model labelled a
                            # caption is one at any length (a journal's
                            # 1,700-character panel-by-panel legend)
                            and (neighbour["kind"] == "caption" or len(neighbour["text"]) < 1200)
                        ):
                            block["evidence"]["sourceIds"] = list(dict.fromkeys(block["evidence"].get("sourceIds", []) + neighbour["evidence"].get("sourceIds", [])))
                            block["text"] = clean_caption(neighbour["text"])
                            block["inline"] = neighbour.get("inline", []) if block["text"] == neighbour["text"] else []
                            label = FIGURE_CAPTION_RE.match(neighbour["text"])
                            block["label"] = canonical_figure_label(label)
                            if neighbour["evidence"]["boxes"]:
                                self._attached_caption_boxes[block["id"]] = neighbour["evidence"]["boxes"][0]
                            self.report.figures_with_caption += 1
                            if neighbour["kind"] == "caption":
                                self.report.orphan_captions -= 1
                            else:
                                self.report.paragraphs -= 1
                            self.report.captions_adopted += 1
                            if neighbour_index > index:
                                self.blocks.pop(neighbour_index)
                            else:
                                kept.pop()
                            break
            kept.append(block)
            index += 1
        self.blocks = kept

    def _read_captions_inside_figures(self) -> None:
        """When the layout model swallowed a caption into a picture crop, the
        PDF text layer still holds it. A `Figure N` line at the foot of a
        caption-less figure is its caption (the crop is trimmed above it); a
        `Figure N` line with artwork below it splits the crop into the figure
        that owns the caption and the rest."""
        index = 0
        while index < len(self.blocks):
            block = self.blocks[index]
            index += 1
            if block["kind"] != "figure" or not block["evidence"]["boxes"] or block["page"] is None or not block.get("fallbackAssetIds"):
                continue
            if "rule-box" in (block["evidence"].get("signals") or []):
                continue
            box = block["evidence"]["boxes"][0]
            page = block["page"]
            # Wide artwork can be inset from the caption's hanging label.
            # Read the full nearby line, not only words whose centres happen
            # to fall within the plot's narrow horizontal bounds.
            pad = 0.055 if box["width"] >= 0.5 else 0.01
            lines = self._lines_in(page, box["x"] - pad, box["y"] - 0.005, box["x"] + box["width"] + pad, box["y"] + box["height"] + 0.01)
            caption_index = next((i for i, (_, _, text) in enumerate(lines) if FIGURE_CAPTION_RE.match(clean_caption(text))), None)
            if caption_index is None:
                continue
            # the caption runs over the following lines while they keep the same line spacing
            end = caption_index
            while end + 1 < len(lines) and lines[end + 1][0] - lines[end][1] <= 0.6 * max(lines[end][1] - lines[end][0], 0.005):
                end += 1
            caption_text = clean_caption(sanitize(" ".join(text for _, _, text in lines[caption_index : end + 1])))
            label = FIGURE_CAPTION_RE.match(caption_text)
            if not label or len(caption_text) > 1200:
                continue
            caption_top, caption_bottom = lines[caption_index][0], lines[end][1]
            artwork_below = box["y"] + box["height"] - caption_bottom
            artwork_above = caption_top - box["y"]
            if artwork_below < 0.03:
                # A source caption inside the crop outranks one accidentally
                # attached from the preceding figure. Release that earlier
                # caption with its own geometry so its artwork can recover.
                had_caption = bool(block["text"])
                previous_label = FIGURE_CAPTION_RE.match(block["text"])
                attached = self._attached_caption_boxes.get(block["id"])
                if (previous_label and attached and previous_label.group(2) == label.group(2)
                        and previous_label.group(1).lower().startswith("extended")
                        and not label.group(1).lower().startswith("extended")
                        and abs(attached["y"] - caption_top) < 0.02):
                    # The inset plot can exclude the hanging "Extended Data"
                    # prefix while still intersecting "Fig. N". This is the
                    # same source caption, not a second main-figure identity.
                    label = previous_label
                if had_caption and previous_label and canonical_figure_label(previous_label) != canonical_figure_label(label) and attached:
                    former = {
                        "id": self._id(f"b-released-caption-{block['id']}"), "kind": "caption",
                        "text": block["text"], "page": attached["page"], "order": 0,
                        "column": "single", "inline": block.get("inline", []),
                        "evidence": {"confidence": 0.8, "pages": [attached["page"]],
                                     "boxes": [attached], "sourceIds": list(block["evidence"]["sourceIds"]),
                                     "signals": ["caption-side-fixed"]},
                    }
                    self.blocks.insert(index - 1, former)
                    index += 1
                    self.report.orphan_captions += 1
                same_label = bool(previous_label and canonical_figure_label(previous_label) == canonical_figure_label(label))
                if not same_label:
                    block["text"] = caption_text
                    block["inline"] = []
                block["label"] = canonical_figure_label(label)
                if not same_label or attached is None:
                    self._attached_caption_boxes[block["id"]] = {"page": page, "x": box["x"], "y": round(caption_top, 5), "width": box["width"], "height": round(caption_bottom - caption_top, 5), "rotation": 0}
                self.report.figures_with_caption += int(not had_caption)
                self.report.captions_read_from_source += 1
                if artwork_above >= 0.03:
                    self._recrop_figure(block, box["x"], box["y"], box["x"] + box["width"], caption_top - 0.002)
                continue
            if artwork_above < 0.03:
                continue  # a caption at the head of the crop belongs to the artwork below (caption-above convention): leave it
            # artwork on both sides: the upper part owns this caption, the rest keeps the block's own
            upper_evidence = {
                "confidence": 0.7,
                "pages": [page],
                "boxes": [{"page": page, "x": box["x"], "y": box["y"], "width": box["width"], "height": round(caption_top - 0.002 - box["y"], 5), "rotation": 0}],
                "sourceIds": block["evidence"]["sourceIds"],
                "signals": ["source-region-fallback", "split-at-inner-caption"],
            }
            asset_id = self._crop_asset("figure", f"figure-split-{label.group(2)}", page, box["x"], box["y"], box["x"] + box["width"], caption_top - 0.002, upper_evidence, block["evidence"]["sourceIds"], require_ink=True)
            if not asset_id:
                continue
            upper = {
                "id": self._id(f"b-split-figure-{label.group(2)}"),
                "kind": "figure",
                "text": caption_text,
                "label": canonical_figure_label(label),
                "page": page,
                "order": 0,
                "column": "single",
                "inline": [],
                "evidence": upper_evidence,
                "fallbackAssetIds": [asset_id],
            }
            self._attached_caption_boxes[upper["id"]] = {"page": page, "x": box["x"], "y": round(caption_top, 5), "width": box["width"], "height": round(caption_bottom - caption_top, 5), "rotation": 0}
            remainder = self._page_image(page)
            if remainder is not None:
                width, height = remainder.size
                remainder = remainder.crop((int(box["x"] * width), int((caption_bottom + 0.002) * height), int((box["x"] + box["width"]) * width), int((box["y"] + box["height"]) * height)))
            if remainder is not None and not self._has_ink(remainder):
                # nothing but white (or a page number) under the caption: the upper part was the whole figure
                self.assets = [a for a in self.assets if a["id"] not in set(block.get("fallbackAssetIds", []))]
                self.blocks[index - 1] = upper
                self.report.figures_with_caption += 1
                self.report.captions_read_from_source += 1
                continue
            self._recrop_figure(block, box["x"], caption_bottom + 0.002, box["x"] + box["width"], box["y"] + box["height"])
            self.blocks.insert(index - 1, upper)
            self.report.figures += 1
            self.report.figures_with_caption += 1
            self.report.captions_read_from_source += 1
            self._diagnostic("info", "visuals", "Figure split at an inner caption", f"{upper['label']}: the caption inside the crop separates two figures", None, page)
            # the lower part now sits at `index`: examine it again for a further inner caption

    def _read_table_captions_from_source(self) -> None:
        """A caption-less table whose `Table N` caption the layout model
        dropped: the PDF text layer still holds it in the band just above (or
        below) the table, so the words there become the caption."""
        for block in self.blocks:
            if block["kind"] != "table" or block["text"] or not block["evidence"]["boxes"] or block["page"] is None:
                continue
            box = block["evidence"]["boxes"][0]
            x0, x1 = box["x"] - 0.02, box["x"] + box["width"] + 0.02
            for band in ((box["y"] - 0.06, box["y"] - 0.002), (box["y"] + box["height"] + 0.002, box["y"] + box["height"] + 0.06)):
                words = self._words_in(block["page"], x0, max(0.0, band[0]), x1, min(1.0, band[1]))
                start = next((i for i, (_, t) in enumerate(words) if re.match(r"^Table$", t, re.IGNORECASE)), None)
                if start is None or start + 1 >= len(words) or not re.match(r"^\d+[.:|]?$", words[start + 1][1]):
                    continue
                caption = sanitize(" ".join(t for _, t in words[start:]))
                match = TABLE_CAPTION_RE.match(caption)
                if not match or len(caption) > 1200:
                    continue
                block["text"] = caption
                block["label"] = f"Table {match.group(2)}"
                self.report.table_captions_read_from_source += 1
                break

    def _drop_duplicate_captions(self) -> None:
        """A `Figure N` caption left in the flow after its figure took the same
        words, or their first line (read once from the layout model, once from
        the text layer), is the figure's own caption a second time: the figure
        keeps the whole caption and the block is absorbed."""
        compact = lambda text: re.sub(r"\W", "", text).casefold()
        owners = {}
        for block in self.blocks:
            if block["kind"] == "figure" and block.get("label") and block["text"]:
                owners.setdefault(block["label"], []).append(block)
        for block in list(self.blocks):
            if block["kind"] not in ("caption", "paragraph"):
                continue
            match = FIGURE_CAPTION_RE.match(block["text"])
            if not match:
                continue
            words = compact(block["text"])
            for owner in owners.get(canonical_figure_label(match), []):
                held = compact(owner["text"])
                if abs((owner["page"] or 0) - (block["page"] or 0)) <= 1 and len(held) >= 12 and words.startswith(held):
                    if len(words) > len(held):
                        # the figure read only the caption's first line: the block has all of it
                        owner["text"], owner["inline"] = clean_caption(block["text"]), (block.get("inline", []) if clean_caption(block["text"]) == block["text"] else [])
                    owner["evidence"]["sourceIds"] = list(dict.fromkeys(owner["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
                    self._absorb_block(block)
                    break

    def _complete_short_captions(self) -> None:
        """A caption that is only its label (`Fig. 7.`, `Figure 5.`), orphan or
        attached to its figure, lost the rest of its words to neighbouring
        blocks (`ARM-CL`, `… runtime illustration: …` glued to a diagram
        letter, `LEFT:` / `Two small models …` / `⋆`). The caption's lines on
        the page, read from the label down while the line spacing holds, give
        the whole caption; the blocks whose words it holds, and stray symbols
        inside it, are absorbed. Glyph lines are read before the text layer,
        which cannot always decode the glyphs."""
        for block in list(self.blocks):
            if block not in self.blocks or block["page"] is None or not block["evidence"]["boxes"]:
                continue
            match = FIGURE_CAPTION_RE.match(block["text"])
            if not match or len(block["text"].strip()) > len(match.group(0)) + 12:
                continue
            if block["kind"] == "figure":
                cbox = self._attached_caption_boxes.get(block["id"])
                if cbox is None or cbox["page"] != block["page"]:
                    continue
            elif block["kind"] in ("caption", "paragraph"):
                if any(f["kind"] == "figure" and f.get("label") == canonical_figure_label(match) for f in self.blocks):
                    continue
                cbox = block["evidence"]["boxes"][0]
            else:
                continue
            page = block["page"]
            # the caption's column: the widest body block starting at its left edge
            widths = [b["evidence"]["boxes"][0]["width"] for b in self.blocks
                      if b["page"] == page and b["kind"] == "paragraph" and b["evidence"]["boxes"] and abs(b["evidence"]["boxes"][0]["x"] - cbox["x"]) <= 0.02]
            x1 = min(1.0, cbox["x"] + max(widths + [0.3]) + 0.005)
            label_word = match.group(0).strip().split()[0]
            kept = None
            for lines in (self._glyph_lines_in(page, cbox["x"] - 0.005, cbox["y"] - 0.003, x1, cbox["y"] + 0.12),
                          self._lines_in(page, cbox["x"] - 0.005, cbox["y"] - 0.003, x1, cbox["y"] + 0.12)):
                lines = [line for line in lines if line[1] > cbox["y"]]
                if not lines or not lines[0][2].startswith(label_word):
                    continue
                kept = [lines[0]]
                for line in lines[1:]:
                    previous = kept[-1]
                    if line[0] - previous[1] > 0.8 * (previous[1] - previous[0]):
                        break
                    kept.append(line)
                break
            if not kept:
                continue
            # a caption spanning both columns reaches past the column estimate
            x1 = max([x1] + [line[3] + 0.005 for line in kept if len(line) > 3])
            text = sanitize(" ".join(line[2] for line in kept))
            if len(text) <= len(block["text"]) or not FIGURE_CAPTION_RE.match(text):
                continue
            top, bottom = kept[0][0], kept[-1][1]
            compact = re.sub(r"\W", "", text).casefold()
            absorbed = []
            for other in self.blocks:
                if other is block or other["page"] != page or other["kind"] not in ("paragraph", "caption", "heading") or not other["evidence"]["boxes"]:
                    continue
                inside = [obox for obox in other["evidence"]["boxes"] if obox["page"] == page and obox["y"] + obox["height"] >= top and obox["y"] <= bottom
                          and obox["x"] <= x1 and obox["x"] + obox["width"] >= cbox["x"] - 0.005]
                if not inside:
                    continue
                words = re.sub(r"\W", "", other["text"]).casefold()
                # a diagram letter the layout model glued in front may precede the words
                if len(words) >= 3 and any(words[cut:] and words[cut:] in compact for cut in (0, 1, 2)):
                    absorbed.append(other)
                elif len(words) <= 2 and all(top - 0.003 <= obox["y"] and obox["y"] + obox["height"] <= bottom + 0.003 for obox in inside) and len(inside) == len(other["evidence"]["boxes"]):
                    absorbed.append(other)  # a stray symbol (`⋆`, `).`) of the caption's own line
            block["text"] = clean_caption(text) if block["kind"] == "figure" else text
            block["inline"] = []
            caption_box = {"page": page, "x": cbox["x"], "y": round(top, 5), "width": round(x1 - cbox["x"], 5), "height": round(bottom - top, 5), "rotation": 0}
            if block["kind"] == "figure":
                self._attached_caption_boxes[block["id"]] = caption_box
            else:
                block["evidence"]["boxes"] = [caption_box]
            block["evidence"]["sourceIds"] = list(dict.fromkeys(block["evidence"]["sourceIds"] + [sid for other in absorbed for sid in other["evidence"]["sourceIds"]]))
            block["evidence"].setdefault("signals", []).append("caption-completed-from-source")
            for other in absorbed:
                self._absorb_block(other)

    def _fix_caption_sides(self) -> None:
        """When the paper sets figure captions below their figures, a picture
        whose attached caption sits above it while an orphan `Figure N`
        caption sits right below it took its neighbour's caption: it swaps to
        the caption below, and the caption above becomes an orphan for the
        picture above to adopt (symmetric for captions-above papers)."""
        if len(self._figure_caption_below) < 2:
            return
        below = sum(self._figure_caption_below) > len(self._figure_caption_below) / 2
        for block in list(self.blocks):
            if block["kind"] != "figure" or not block["text"] or not block["evidence"]["boxes"] or block["page"] is None:
                continue
            attached = self._attached_caption_boxes.get(block["id"])
            if attached is None:
                continue
            fbox = block["evidence"]["boxes"][0]
            attached_below = attached["y"] >= fbox["y"] + fbox["height"] * 0.5
            caption_overlap = min(attached["x"] + attached["width"], fbox["x"] + fbox["width"]) - max(attached["x"], fbox["x"])
            if attached_below == below and caption_overlap >= 0.3 * min(attached["width"], fbox["width"]):
                continue
            # The caption can already be owned by the wrong picture even
            # without an orphan on the other side. Transfer it to an
            # uncaptioned picture on the document's normal caption side.
            candidates = []
            for other in self.blocks:
                if other is block or other["kind"] != "figure" or other["text"] or other["page"] != block["page"] or not other["evidence"]["boxes"]:
                    continue
                obox = other["evidence"]["boxes"][0]
                gap = attached["y"] - (obox["y"] + obox["height"]) if below else obox["y"] - (attached["y"] + attached["height"])
                overlap = min(attached["x"] + attached["width"], obox["x"] + obox["width"]) - max(attached["x"], obox["x"])
                if -0.01 <= gap <= 0.07 and overlap >= 0.5 * min(attached["width"], obox["width"]):
                    candidates.append((abs(gap), other))
            if candidates:
                target = min(candidates, key=lambda pair: pair[0])[1]
                target["text"], target["inline"], target["label"] = block["text"], block.get("inline", []), block.get("label")
                target["evidence"]["sourceIds"] = list(dict.fromkeys(target["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
                self._attached_caption_boxes[target["id"]] = attached
                self._attached_caption_boxes.pop(block["id"], None)
                block["text"], block["inline"] = "", []
                block.pop("label", None)
                self.report.caption_sides_fixed += 1
                # Some false picture detections are entirely blank source
                # regions. Keep real artwork for the next panel-union pass.
                image = self._page_image(block["page"])
                if image is not None:
                    w, h = image.size
                    crop = image.crop((int(fbox["x"] * w), int(fbox["y"] * h), int((fbox["x"] + fbox["width"]) * w), int((fbox["y"] + fbox["height"]) * h)))
                    if not self._has_ink(crop):
                        old = set(block.get("fallbackAssetIds", []))
                        self.assets = [a for a in self.assets if a["id"] not in old]
                        self.blocks.remove(block)
                        self.report.figures -= 1
                continue
            for orphan in self.blocks:
                if orphan["kind"] not in ("caption", "paragraph") or orphan["page"] != block["page"] or not orphan["evidence"]["boxes"] or not FIGURE_CAPTION_RE.match(orphan["text"]) or len(orphan["text"]) > 1200:
                    continue
                obox = orphan["evidence"]["boxes"][0]
                gap = obox["y"] - (fbox["y"] + fbox["height"]) if below else fbox["y"] - (obox["y"] + obox["height"])
                overlap = min(fbox["x"] + fbox["width"], obox["x"] + obox["width"]) - max(fbox["x"], obox["x"])
                if not (-0.01 <= gap <= 0.09) or overlap < 0.4 * min(fbox["width"], obox["width"]):
                    continue
                former = self._new_block("caption", None, block["text"]) if False else {
                    "id": self._id(f"b-caption-{block['id']}"),
                    "kind": "caption",
                    "text": block["text"],
                    "page": block["page"],
                    "order": 0,
                    "column": "single",
                    "inline": block.get("inline", []),
                    "evidence": {"confidence": 0.8, "pages": [block["page"]], "boxes": [attached], "sourceIds": block["evidence"]["sourceIds"], "signals": ["docling-layout", "caption-side-fixed"]},
                }
                block["text"] = clean_caption(orphan["text"])
                block["inline"] = orphan.get("inline", []) if block["text"] == orphan["text"] else []
                label = FIGURE_CAPTION_RE.match(block["text"])
                block["label"] = canonical_figure_label(label) if label else block.get("label")
                position = self.blocks.index(orphan)
                self.blocks[position] = former  # the freed caption takes the orphan's place
                self._attached_caption_boxes[block["id"]] = obox
                self.report.orphan_captions += 1
                self.report.caption_sides_fixed += 1
                self._diagnostic("info", "visuals", "Caption reassigned to its figure", f"{block['label']}: the caption on the paper's caption side replaces one attached from the other side", None, block["page"])
                break

    def _adopt_captions_across_page_break(self) -> None:
        """A figure filling the foot of a page in a captions-below paper, whose
        `Figure N` caption the page break pushed to the head of the next page:
        an orphan caption standing first on its page, its label held by no
        figure, adopts the caption-less pictures that close the previous page
        with nothing under them, merged as one figure when they are stacked
        panels (a full-page figure may be taller than the usual union cap)."""
        below = sum(self._figure_caption_below) >= len(self._figure_caption_below) / 2 if self._figure_caption_below else True
        if not below:
            return  # the paper sets captions above their figures; a page-head caption opens the next figure
        owned = {t for r in self.relationships for t in r["to"]}
        held = {b.get("label") for b in self.blocks if b["kind"] == "figure" and b["text"]}

        def box_on(block: dict, page: int) -> dict | None:
            return next((b for b in block["evidence"]["boxes"] if b.get("page", page) == page), None)

        for orphan in list(self.blocks):
            if orphan not in self.blocks or orphan["kind"] not in ("caption", "paragraph") or orphan["page"] is None or orphan["page"] < 2 or orphan["id"] in owned:
                continue
            label = FIGURE_CAPTION_RE.match(orphan["text"])
            if not label or canonical_figure_label(label) in held or (orphan["kind"] != "caption" and len(orphan["text"]) >= 1200):
                continue
            page = orphan["page"]
            obox = box_on(orphan, page)
            if obox is None or obox["y"] > 0.15:
                continue
            above = [b for b in self.blocks if b is not orphan and b["page"] == page and b["kind"] != "furniture" and (bb := box_on(b, page)) is not None and bb["y"] + bb["height"] <= obox["y"] + 0.005]
            if above:
                continue  # something stands over the caption: it is not the first thing on its page
            previous = [b for b in self.blocks if b["page"] == page - 1 and b["kind"] != "furniture" and box_on(b, page - 1) is not None]
            pictures = [b for b in previous if b["kind"] == "figure" and not b["text"]]
            if not pictures or any(b["kind"] in ("caption", "paragraph") and FIGURE_CAPTION_RE.match(b["text"]) for b in previous):
                continue  # a `Figure N` caption on the pictures' own page is theirs, not this one
            foot = max(box_on(b, page - 1)["y"] + box_on(b, page - 1)["height"] for b in pictures)
            if foot < 0.8 or any(box_on(b, page - 1)["y"] >= foot - 0.005 for b in previous if b not in pictures):
                continue  # the pictures do not close their page, or text follows them
            pictures.sort(key=lambda b: box_on(b, page - 1)["y"] + box_on(b, page - 1)["height"], reverse=True)
            run = [pictures[0]]
            for candidate in pictures[1:]:
                last, cbox = box_on(run[-1], page - 1), box_on(candidate, page - 1)
                stacked = last["y"] - (cbox["y"] + cbox["height"]) < 0.1
                aligned = min(last["x"] + last["width"], cbox["x"] + cbox["width"]) - max(last["x"], cbox["x"]) >= 0.3 * min(last["width"], cbox["width"])
                if not (stacked and aligned):
                    break
                run.append(candidate)
            run.sort(key=self.blocks.index)
            keeper = run[0]
            kbox = box_on(keeper, page - 1)
            if min(kbox["x"] + kbox["width"], obox["x"] + obox["width"]) - max(kbox["x"], obox["x"]) < 0.4 * min(kbox["width"], obox["width"]):
                continue  # the caption is not in the pictures' column
            if len(run) >= 2:
                self._union_figure(keeper, run, max_height=0.95)
            keeper["evidence"]["sourceIds"] = list(dict.fromkeys(keeper["evidence"]["sourceIds"] + orphan["evidence"]["sourceIds"]))
            keeper["text"] = clean_caption(orphan["text"])
            keeper["inline"] = orphan.get("inline", []) if keeper["text"] == orphan["text"] else []
            keeper["label"] = canonical_figure_label(label)
            self._attached_caption_boxes[keeper["id"]] = dict(obox)
            held.add(keeper["label"])
            self.blocks.remove(orphan)
            owned.add(orphan["id"])
            self.report.figures_with_caption += 1
            self.report.captions_adopted += 1
            self.report.captions_adopted_across_pages += 1
            if orphan["kind"] == "caption":
                self.report.orphan_captions -= 1
            else:
                self.report.paragraphs -= 1
            self._diagnostic("info", "visuals", "Caption adopted across a page break", f"{keeper['label']}: the caption at the head of page {page} belongs to the figure closing page {page - 1}", None, page - 1)

    def _adopt_captions_by_geometry(self) -> None:
        """A caption-less figure or table adopts the nearest orphan `Figure N`
        / `Table N` caption on its page that shares its column and sits just
        below or above it, wherever the caption landed in reading order."""
        from figure_recovery import adopt_sideways_captions

        adopt_sideways_captions(self)
        owned = {t for r in self.relationships for t in r["to"]}
        for block in list(self.blocks):
            if block["kind"] not in ("figure", "table") or not block["evidence"]["boxes"] or block["page"] is None:
                continue
            if block["text"] and not (block["kind"] == "figure" and SUBCAPTION_RE.match(block["text"]) and len(block["text"]) < 160):
                continue  # `(c) Dynamic outlining …` is a panel's sub-caption, not the figure's caption
            pattern = TABLE_CAPTION_RE if block["kind"] == "table" else FIGURE_CAPTION_RE
            fbox = block["evidence"]["boxes"][0]
            best, best_gap = None, 1.0
            for candidate in self.blocks:
                if candidate is block or candidate["kind"] not in ("caption", "paragraph") or candidate["page"] != block["page"] or candidate["id"] in owned:
                    continue
                if not pattern.match(candidate["text"]) or len(candidate["text"]) > 1200 or not candidate["evidence"]["boxes"]:
                    continue
                cbox = candidate["evidence"]["boxes"][0]
                overlap = min(fbox["x"] + fbox["width"], cbox["x"] + cbox["width"]) - max(fbox["x"], cbox["x"])
                v_overlap = min(fbox["y"] + fbox["height"], cbox["y"] + cbox["height"]) - max(fbox["y"], cbox["y"])
                side_gap = max(cbox["x"] - (fbox["x"] + fbox["width"]), fbox["x"] - (cbox["x"] + cbox["width"]))
                if overlap < 0.4 * min(fbox["width"], cbox["width"]):
                    # a caption set beside its figure (a two-column float with the text on one side)
                    if block["kind"] == "figure" and v_overlap >= 0.5 * cbox["height"] and -0.01 <= side_gap <= 0.06 and side_gap + 0.02 < best_gap:
                        best, best_gap = candidate, side_gap + 0.02
                    continue
                below = cbox["y"] - (fbox["y"] + fbox["height"])
                above = fbox["y"] - (cbox["y"] + cbox["height"])
                gap = below if -0.01 <= below <= 0.08 else (above if -0.01 <= above <= 0.08 else None)
                if gap is not None and abs(gap) < best_gap:
                    best, best_gap = candidate, abs(gap)
            if best is None and block["kind"] == "table":
                # the paper calls this box a figure: a Docling table whose only
                # caption nearby says `Figure N`
                for candidate in self.blocks:
                    if candidate is block or candidate["kind"] not in ("caption", "paragraph") or candidate["page"] != block["page"] or candidate["id"] in owned:
                        continue
                    if not FIGURE_CAPTION_RE.match(candidate["text"]) or len(candidate["text"]) > 1200 or not candidate["evidence"]["boxes"]:
                        continue
                    cbox = candidate["evidence"]["boxes"][0]
                    overlap = min(fbox["x"] + fbox["width"], cbox["x"] + cbox["width"]) - max(fbox["x"], cbox["x"])
                    gap = min(abs(cbox["y"] - (fbox["y"] + fbox["height"])), abs(fbox["y"] - (cbox["y"] + cbox["height"])))
                    if overlap >= 0.4 * min(fbox["width"], cbox["width"]) and gap <= 0.03:
                        evidence = dict(block["evidence"])
                        evidence["signals"] = list(dict.fromkeys((evidence.get("signals") or []) + ["source-region-fallback", "table-item-as-figure"]))
                        asset_id = self._crop_asset("figure", f"figure-from-table-{block['id']}", block["page"], fbox["x"], fbox["y"], fbox["x"] + fbox["width"], fbox["y"] + fbox["height"], evidence, evidence["sourceIds"])
                        if not asset_id:
                            break
                        old_assets = set(block.get("fallbackAssetIds", []))
                        self.assets = [a for a in self.assets if a["id"] not in old_assets]
                        block["kind"] = "figure"
                        block.pop("table", None)
                        block["fallbackAssetIds"] = [asset_id]
                        block["evidence"] = evidence
                        if block.get("table") is None:
                            self.report.tables_semantic = max(0, self.report.tables_semantic - 1)
                        self.report.figures += 1
                        pattern = FIGURE_CAPTION_RE
                        best = candidate
                        break
            if best is None:
                continue
            block["evidence"]["sourceIds"] = list(dict.fromkeys(block["evidence"]["sourceIds"] + best["evidence"]["sourceIds"]))
            label = pattern.match(best["text"])
            block["text"] = clean_caption(best["text"]) if block["kind"] == "figure" else best["text"]
            block["inline"] = best.get("inline", []) if block["text"] == best["text"] else []
            block["label"] = f"Table {label.group(2)}" if block["kind"] == "table" else canonical_figure_label(label)
            self._attached_caption_boxes[block["id"]] = best["evidence"]["boxes"][0]
            self.blocks.remove(best)
            owned.add(best["id"])
            if best["kind"] == "caption":
                self.report.orphan_captions -= 1
            else:
                self.report.paragraphs -= 1
            if block["kind"] == "figure":
                self.report.figures_with_caption += 1
                self.report.captions_adopted_by_geometry += 1
            else:
                self.report.tables_caption_adopted += 1
