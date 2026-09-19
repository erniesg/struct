"""Code listings and display equations.

What belongs here: verifying Docling `code` items against glyph faces
(monospace is code, math faces an equation, prose a paragraph), monospace
paragraphs that are listings, equation blocks with MathML from source glyphs
or an original-page crop, and listings split by a caption, note or page break
rejoined. Glyph-to-MathML reconstruction lives in `equation_recovery.py`;
inline formula fragments in `inline_equations.py`.
"""

from __future__ import annotations

import re

from docling_core.types.doc import TextItem

from adapter_common import (
    FIGURE_CAPTION_RE,
    TABLE_CAPTION_RE,
    sanitize,
)


class CodeEquationRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _emit_monospace_code(self, item, text: str) -> bool:
        """A paragraph set almost entirely in a monospace face over two or
        more source lines is a code listing the layout model missed; the
        source line breaks come back from the glyph lines."""
        page_text = self._page_text(self._page_of(item))
        box = self._box(item)
        if page_text is None or box is None or len(text) < 20:
            return False
        share = page_text.font_share(box)
        if share["total"] < 20 or share["mono"] < 0.8:
            return False
        lines = page_text.lines_in(box)
        if len(lines) < 2:
            return False
        self._flush()
        block = self._new_block("code", item, sanitize(page_text.listing_text(box)) or text)
        block["evidence"]["signals"].append("monospace-face")
        block["inline"] = [run for run in self._runs_for(item, block["text"]) if run.get("href")]
        self.blocks.append(block)
        self.report.code_blocks += 1
        self.report.code_from_monospace += 1
        return True

    def _emit_code(self, item) -> None:
        """Docling `code` items are verified against the glyph faces: a
        monospace region is code (with source line breaks); a math-face
        region is a display formula the layout model mislabelled; anything
        else is prose."""
        self._flush()
        text = sanitize(item.text or "")
        page_text = self._page_text(self._page_of(item))
        box = self._box(item)
        if page_text is not None and box is not None:
            share = page_text.font_share(box)
            if share["total"] >= 10 and share["mono"] < 0.5:
                # forty words of prose between the symbols are a paragraph with
                # inline mathematics (a worked solution), not one display formula
                if share["math"] >= 0.35 and len(re.findall(r"[A-Za-z]{3,}", text)) < 40:
                    self.report.code_relabelled_equation += 1
                    self._emit_formula(item, prefer_image=True)
                    return
                self.report.code_relabelled_paragraph += 1
                self._emit_paragraph(item)
                return
            # the region replaces the layout text on the strength of its own
            # characters; its reconstructed indents do not vote for it
            region = sanitize(page_text.region_text(box))
            if region and len(region) >= 0.5 * len(text):
                text = sanitize(page_text.listing_text(box))
        block = self._new_block("code", item, text)
        block["inline"] = [run for run in self._runs_for(item, text) if run.get("href")]
        self.blocks.append(block)
        self.report.code_blocks += 1

    def _emit_formula(self, item: TextItem, prefer_image: bool = False) -> None:
        from equation_recovery import recover_equation

        self._flush()
        latex = sanitize((item.text or "").strip())
        page = self._page_of(item)
        box = self._box(item)
        recovered = recover_equation(self._page_text(page), box)
        block = self._new_block("equation", item, latex, label="Equation")
        mathml = recovered.mathml if recovered else None
        if mathml:
            block["text"] = latex or sanitize(recovered.text)
            block["evidence"]["signals"].append("source-glyph-equation-structure")
        if mathml:
            block["attributes"] = {"mathml": mathml}
            self.report.formulas_mathml += 1
        else:
            # Layout formula text is often empty. Keep the source glyph
            # transcript as evidence, but never treat its visual order as a
            # parsed expression. The original-page crop carries the notation.
            if recovered:
                # the layout model's text keeps word spaces the glyph transcript can lose
                block["text"] = latex or sanitize(recovered.text)
                block["evidence"]["signals"].append("source-glyph-equation-transcript")
            crop = recovered.box if recovered else box
            asset_id = None
            if crop is not None and page is not None:
                asset_id = self._crop_asset(
                    "equation", f"equation-{self.report.formulas_image + 1:03d}", page,
                    crop["x"], crop["y"], crop["x"] + crop["width"], crop["y"] + crop["height"],
                    {**block["evidence"], "boxes": [crop]}, block["evidence"]["sourceIds"],
                )
            if asset_id:
                block["fallbackAssetIds"] = [asset_id]
                self.report.formulas_image += 1
            else:
                self.report.formulas_text += 1
            limitation = recovered.limitation if recovered else "no recoverable source glyph structure"
            self._diagnostic(
                "warning" if asset_id else "error", "text", "Equation structure unavailable",
                f"{limitation}; " + ("original source region retained as visual fallback" if asset_id else "source image unavailable"), item,
            )
        if block.get("attributes", {}).get("mathml") or block.get("fallbackAssetIds"):
            # the MathML or the crop is the formula: its transcript is kept as data,
            # not rendered as a caption of raw `\frac{…}` text under the notation
            block["attributes"] = {**block.get("attributes", {}), **({"transcript": block["text"]} if block["text"] else {})}
            block["text"] = ""
            block.pop("label", None)
        self.blocks.append(block)

    def _rejoin_split_listings(self) -> None:
        """Two code blocks separated only by a caption, footnote, or furniture
        that the layout model interleaved, either on one page with a small
        gap or across a page break (first half at the foot of a page, second
        at the head of the next), are one listing: the halves rejoin with a
        line break, a caption that sits above the first half leads the
        listing, one that sits below the second half follows it."""
        index = 0
        while index < len(self.blocks):
            block = self.blocks[index]
            if block["kind"] != "code" or block["page"] is None or not block["evidence"]["boxes"]:
                index += 1
                continue
            j = index + 1
            between: list[dict] = []
            while j < len(self.blocks) and self.blocks[j]["kind"] in ("caption", "furniture", "footnote") and sum(1 for b in between if b["kind"] != "furniture") < 3:
                between.append(self.blocks[j])
                j += 1
            if j >= len(self.blocks):
                break
            nxt = self.blocks[j]
            if nxt["kind"] != "code" or nxt["page"] is None or not nxt["evidence"]["boxes"]:
                index += 1
                continue
            first, second = block["evidence"]["boxes"][-1], nxt["evidence"]["boxes"][0]
            overlap = min(first["x"] + first["width"], second["x"] + second["width"]) - max(first["x"], second["x"])
            if overlap < 0.5 * min(first["width"], second["width"]):
                index += 1
                continue
            same_page = nxt["page"] == block["page"] and -0.005 <= second["y"] - (first["y"] + first["height"]) <= 0.035
            page_break = nxt["page"] == block["page"] + 1 and first["y"] + first["height"] >= 0.78 and second["y"] <= 0.25
            if not (same_page or page_break):
                index += 1
                continue
            captions = [b for b in between if b["kind"] == "caption"]
            if any(FIGURE_CAPTION_RE.match(c["text"]) or TABLE_CAPTION_RE.match(c["text"]) for c in captions):
                index += 1
                continue
            block["text"] = block["text"].rstrip("\n") + "\n" + nxt["text"].lstrip("\n")
            block["evidence"]["boxes"].append(second)
            block["evidence"]["pages"] = sorted(set(block["evidence"]["pages"] + nxt["evidence"]["pages"]))
            block["evidence"]["sourceIds"] = list(dict.fromkeys(block["evidence"]["sourceIds"] + nxt["evidence"]["sourceIds"]))
            for relationship in self.relationships:
                if relationship["from"] == nxt["id"]:
                    relationship["from"] = block["id"]
                relationship["to"] = [block["id"] if t == nxt["id"] else t for t in relationship["to"]]
            del self.blocks[j]
            for item in between:
                self.blocks.remove(item)
            position = self.blocks.index(block)
            leading = [c for c in captions if c["page"] == block["page"] and c["evidence"]["boxes"] and c["evidence"]["boxes"][0]["y"] < first["y"]]
            trailing = [b for b in between if b not in leading]
            self.blocks[position:position] = leading
            position += len(leading)
            self.blocks[position + 1 : position + 1] = trailing
            self.report.listings_rejoined += 1
            index = position  # a listing split three ways rejoins again
