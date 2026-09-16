"""Hyperlinks and inline style runs.

What belongs here: mapping the PDF's URI annotations onto layout items and
table cells (`_index_links`), turning them into `href` runs on a block's text
(`_runs_for`, `_caption_links`), bold/italic runs from glyph faces
(`_style_runs`), and textless author icons (ORCID, email) given an accessible
label. Internal (GoTo) links are resolved in `internal_links.py`; the matching
helpers (`link_visible_text`, `first_free_span`) are in `adapter_common.py`.
"""

from __future__ import annotations

import re

from docling_core.types.doc import TableItem, TextItem

from pdf_links import group_wrapped_links, normalize_uri
from adapter_common import (
    SAFE_HREF_RE,
    first_free_span,
    link_visible_text,
    loose_pattern,
)



# An author icon's link reads as one of these labels in the output.
ICON_WORD_RE = re.compile(r"\[?(?:orcid|email|envelope)\]?", re.I)
ICON_WORDS_RE = re.compile(r"\[?\b(?:orcid|email|envelope)\b\]?|\s", re.I)
# the glyph names an icon font exposes for the two icons, exactly as read
GLYPH_NAMES = {"[email]": ("envelope",), "[ORCID]": ("orcid",)}


UNLINKED_ICONS = (
    (re.compile(r"\benvelope(?=\s+[\w.{},+-]*[\w}]@[\w-]+\.)"), "[email]"),
    (re.compile(r"\borcid(?=\s+\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b)"), "[ORCID]"),
)


def _replace_span(block: dict, start: int, end: int, label: str, owner: dict | None = None) -> None:
    """Replace `text[start:end]` with `label`, keeping every inline run on the
    characters it covered; `owner` is a run that covered exactly the span."""
    delta = len(label) - (end - start)
    block["text"] = block["text"][:start] + label + block["text"][end:]
    for run in block.get("inline", []):
        if run is owner:
            run["end"] = start + len(label)
            continue
        if run["start"] >= end:
            run["start"] += delta
        if run["end"] >= end:
            run["end"] += delta


def _icon_label(uri: str) -> str | None:
    if re.match(r"https?://orcid\.org/", uri, re.I):
        return "[ORCID]"
    if uri.lower().startswith("mailto:"):
        return "[email]"
    return None


class LinkRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _index_links(self) -> dict[str, list[tuple[str, str]]]:
        """Map each URI annotation to the layout item (or table cell) under its
        rectangle, keyed by the item's self_ref (cells: `ref#c<row>-<col>`)."""
        by_page: dict[int, list] = {}
        table_regions: dict[int, list] = {}
        for item, _ in self.doc.iterate_items():
            if isinstance(item, TextItem) and item.prov:
                for entry in item.prov:  # a paragraph over a column break has a box per column
                    bbox = entry.bbox
                    by_page.setdefault(entry.page_no, []).append((item.self_ref, item.text, (bbox.l, bbox.b, bbox.r, bbox.t)))
            elif isinstance(item, TableItem) and item.prov and item.data:
                seen_cells: set[tuple[int, int]] = set()
                for row in item.data.grid:
                    for cell in row:
                        bbox = getattr(cell, "bbox", None)
                        key = (cell.start_row_offset_idx, cell.start_col_offset_idx)
                        if not cell.text.strip() or key in seen_cells:
                            continue
                        seen_cells.add(key)
                        for entry in item.prov:
                            if entry.page_no not in self.doc.pages:
                                continue
                            height = self.doc.pages[entry.page_no].size.height
                            if bbox is not None:
                                if str(bbox.coord_origin).lower().endswith("topleft"):
                                    box = (bbox.l, height - max(bbox.t, bbox.b), bbox.r, height - min(bbox.t, bbox.b))
                                else:
                                    box = (bbox.l, min(bbox.b, bbox.t), bbox.r, max(bbox.b, bbox.t))
                                by_page.setdefault(entry.page_no, []).append((f"{item.self_ref}#c{key[0]}-{key[1]}", cell.text, box))
                            tb = entry.bbox
                            if str(tb.coord_origin).lower().endswith("topleft"):
                                region = (tb.l, height - max(tb.b, tb.t), tb.r, height - min(tb.b, tb.t))
                            else:
                                region = (tb.l, min(tb.b, tb.t), tb.r, max(tb.b, tb.t))
                            table_regions.setdefault(entry.page_no, []).append((f"{item.self_ref}#c{key[0]}-{key[1]}", cell.text, region))
        mapped: dict[str, list[tuple[str, str]]] = {}
        group_wrapped_links(self.links)
        seen_pairs: set[tuple] = set()
        for link in self.links:
            uri = normalize_uri(link.uri) if link.kind == "uri" and link.uri else ""
            if not uri or not SAFE_HREF_RE.match(uri):
                self.report.internal_links_skipped += 1
                continue
            self.report.links_expected += 1
            l, b, r, t = link.rect
            best, chosen, best_ratio = None, None, 0.0
            best_cells: set[str] = set()
            area = max((r - l) * (t - b), 1e-6)
            for key, text, (bl, bb, br, bt) in by_page.get(link.page, []):
                overlap = max(0.0, min(r, br) - max(l, bl)) * max(0.0, min(t, bt) - max(b, bb))
                if overlap <= 0:
                    continue
                # a table cell's glyph box is far shorter than the annotation
                # rectangle: measure the overlap against the smaller of the two
                ratio = overlap / max(min(area, (br - bl) * (bt - bb)), 1e-6)
                visible = link_visible_text(text, uri, link.text, link.group_text)
                if visible is not None and ratio >= best_ratio:
                    if ratio > best_ratio:
                        best_cells.clear()
                    if "#c" in key:
                        best_cells.add(key)
                    if ratio > best_ratio or "#c" in key:
                        best_ratio, best, chosen = ratio, key, visible
            if len(best_cells) > 1:
                best, best_ratio = None, 0.0
            if best is None or best_ratio < 0.3:
                # A merged reference cell can have an inaccurate glyph box.
                # Its table region and uniquely matching source annotation
                # words still identify the cell; repeated phrases remain
                # ambiguous and receive no guessed association.
                fallback = {}
                for key, text, (bl, bb, br, bt) in table_regions.get(link.page, []):
                    if not (bl <= (l + r) / 2 <= br and bb <= (b + t) / 2 <= bt):
                        continue
                    literal = link_visible_text(text, uri, link.text, link.group_text)
                    if literal is not None:
                        fallback[key] = literal
                if len(fallback) == 1:
                    best, chosen = next(iter(fallback.items()))
                    best_ratio = 1.0
            if best is None or best_ratio < 0.3:
                self.report.links_unmapped += 1
                continue
            # Identical words/targets at distinct source rectangles are
            # distinct link occurrences. Only a complete, attested wrapped
            # phrase shares one output run across its annotation fragments.
            wrapped = (link.group_words is not None and link_visible_text(chosen, "", link.group_text) == chosen)
            occurrence = ("wrapped", id(link.group_words)) if wrapped else (link.page, tuple(link.rect))
            pair_key = (best, chosen, uri, occurrence)
            if pair_key in seen_pairs:
                self.report.links_mapped += 1  # another line of the same wrapped link
                continue
            seen_pairs.add(pair_key)
            mapped.setdefault(best, []).append((chosen, uri))
            self.report.links_mapped += 1
            if "#c" in best:
                self.report.table_cell_links += 1
        return mapped

    def _recover_link_icons(self) -> None:
        """Represent an otherwise textless author icon by an accessible label.

        Its annotation identifies the icon; source words immediately to its
        left locate the insertion in the surviving block. Neither an author
        name nor an anchor location is inferred from the destination URI.
        """
        # Several icons can share the same source word anchor. Keep their
        # horizontal source order even when differing icon heights change the
        # annotation traversal order.
        inserted_at_anchor: dict[tuple, list[tuple[float, int]]] = {}
        processed = getattr(self, "_recovered_icon_annotations", set())
        claimed = getattr(self, "_claimed_icon_runs", set())
        self._recovered_icon_annotations, self._claimed_icon_runs = processed, claimed
        for link in sorted(self.links, key=lambda x: (x.page, -x.rect[3], x.rect[0])):
            uri = normalize_uri(link.uri) if link.kind == "uri" and link.uri else ""
            identity = (link.page, tuple(link.rect), uri)
            if identity in processed or not uri or any(ch.isalnum() for ch in link.text):
                continue
            label = _icon_label(uri)
            if not label or link.page not in self.doc.pages or link.page > len(self.word_boxes):
                continue
            size = self.doc.pages[link.page].size
            l, bottom, r, top = link.rect
            cx, cy = (l + r) / (2 * size.width), 1 - (bottom + top) / (2 * size.height)
            hosts = []
            for block in self.blocks:
                if block["kind"] not in ("paragraph", "heading", "footnote", "figure", "caption"):
                    continue
                for box in block["evidence"]["boxes"]:
                    if (box["page"] == link.page and box["x"] - .005 <= cx <= box["x"] + box["width"] + .025
                            and box["y"] - .006 <= cy <= box["y"] + box["height"] + .006):
                        hosts.append((box["width"] * box["height"], block, box))
            for _, block, box in sorted(hosts, key=lambda h: h[0]):
                words = sorted((word for word in self.word_boxes[link.page - 1]
                                if word[2] <= l + 1 and word[0] >= box["x"] * size.width - 2
                                and size.height - top - 2 <= (word[1] + word[3]) / 2 <= size.height - bottom + 2
                                and any(ch.isalnum() for ch in word[4])), key=lambda w: w[0])
                position = None
                for count in range(min(len(words), 6), 0, -1):
                    context = " ".join(w[4] for w in words[-count:])
                    matches = list(loose_pattern(context).finditer(block["text"]))
                    if len(matches) == 1:
                        position = matches[0].end()
                        break
                if position is None:
                    continue
                anchor = (block["id"], link.page, tuple(words[-1]))
                previous = inserted_at_anchor.setdefault(anchor, [])
                position += sum(length for x, length in previous if x <= l)
                existing = next((run for run in block["inline"]
                                 if id(run) not in claimed and run.get("href") == uri
                                 and run["start"] >= position
                                 and not ICON_WORDS_RE.sub("", block["text"][position:run["start"]])
                                 and ICON_WORD_RE.fullmatch(block["text"][run["start"]:run["end"]])), None)
                if existing is not None:
                    claimed.add(id(existing))
                    processed.add(identity)
                    break
                # an icon whose glyph name the layout model did read is already
                # in the text; one left of this icon on the same line goes first,
                # whichever of the two annotations was visited first
                for run in sorted(block["inline"], key=lambda r: r["start"]):
                    if run["start"] < position or not run.get("href"):
                        continue
                    if (ICON_WORDS_RE.sub("", block["text"][position:run["start"]])
                            or not ICON_WORD_RE.fullmatch(block["text"][run["start"]:run["end"]])):
                        break
                    left_of = [other.rect[0] for other in self.links
                               if other.page == link.page and other is not link and other.kind == "uri" and other.uri
                               and normalize_uri(other.uri) == run["href"]
                               and other.rect[1] <= top and other.rect[3] >= bottom]
                    if not left_of or min(left_of) >= l:
                        break
                    position = run["end"]
                insertion = " " + label
                block["text"] = block["text"][:position] + insertion + block["text"][position:]
                for run in block["inline"]:
                    if run["start"] >= position:
                        run["start"] += len(insertion)
                    if run["end"] > position:
                        run["end"] += len(insertion)
                previous.append((l, len(insertion)))
                block["inline"].append({"start": position + 1, "end": position + len(insertion), "href": uri})
                claimed.add(id(block["inline"][-1]))
                processed.add(identity)
                evidence = block["evidence"]
                evidence.setdefault("signals", []).extend(signal for signal in ("source-icon", "uri-annotation") if signal not in evidence.get("signals", []))
                evidence["boxes"].append({"page": link.page, "x": l / size.width, "y": 1 - top / size.height,
                                          "width": (r - l) / size.width, "height": (top - bottom) / size.height, "rotation": 0})
                self.report.links_mapped += 1
                self.report.links_unmapped = max(0, self.report.links_unmapped - 1)
                break
        self._label_icon_runs(claimed)

    def _label_icon_runs(self, claimed: set[int]) -> None:
        """Show an author icon's link as `[email]` or `[ORCID]`.

        The anchor is either a label inserted above or the glyph name the
        layout model read out of the icon font (`envelope`, `orcid`), which
        reads as a stray word. A glyph name is recognised without a claim; a
        plain `email` or `ORCID` only when the recovery claimed it as an icon,
        so a linked word in prose keeps its text. An unlinked glyph name is a
        label only directly before an address or an ORCID iD.
        """
        for block in self.blocks:
            for run in sorted(block.get("inline", []), key=lambda r: r["start"]):
                label = _icon_label(run.get("href") or "")
                if not label:
                    continue
                start, end = run["start"], run["end"]
                shown = block["text"][start:end]
                if shown == label or not ICON_WORD_RE.fullmatch(shown):
                    continue
                if id(run) not in claimed and shown not in GLYPH_NAMES.get(label, ()):
                    continue
                _replace_span(block, start, end, label, owner=run)
            # an icon with no annotation of its own: the glyph name counts only
            # when what follows it is what the icon stands for
            for pattern, label in UNLINKED_ICONS:
                for match in reversed(list(pattern.finditer(block["text"]))):
                    _replace_span(block, match.start(), match.end(), label)

    def _runs_for(self, item: TextItem, text: str, styles: bool = True) -> list[dict]:
        runs: list[dict] = []
        spans: list[tuple[int, int]] = []
        hyperlink = getattr(item, "hyperlink", None)
        pairs = list(self._item_links.get(item.self_ref, []))
        if hyperlink and not pairs and SAFE_HREF_RE.match(str(hyperlink)):
            pairs.append((text, str(hyperlink)))
        for visible, href in pairs:
            span = first_free_span(visible, text, spans)
            if span is None and len(visible.split()) >= 2:
                # the block text may have shed a leading note marker or label
                span = first_free_span(visible.split(None, 1)[1], text, spans)
            if span is None:
                continue
            spans.append(span)
            runs.append({"start": span[0], "end": span[1], "href": href})
        if styles:
            runs.extend(self._style_runs(item, text))
        return runs

    def _style_runs(self, item, text: str) -> list[dict]:
        """Bold/italic runs from the glyph faces under every box of the item.

        An item read across a column or page break has a box per part; reading
        only the first one loses the emphasis in the rest (a run-in heading at
        the foot of a column, a defined term overleaf).
        """
        if len(text) < 8:
            return []
        runs: list[dict] = []
        for box in self._boxes(item) or []:
            page_text = self._page_text(box["page"])
            if page_text is None:
                continue
            for run in page_text.style_runs(box, text):
                if run not in runs and not any(other["start"] < run["end"] and run["start"] < other["end"]
                                               and other.get("bold") == run.get("bold") and other.get("italic") == run.get("italic")
                                               for other in runs):
                    runs.append(run)
        self.report.style_runs += len(runs)
        return runs

    def _caption_links(self, item, caption: str) -> list[dict]:
        """The hyperlinks of a float's attached caption (`Data source:
        https://www.swebench.com/`), located in the caption text it renders."""
        runs: list[dict] = []
        for ref in getattr(item, "captions", []):
            caption_item = ref.resolve(self.doc)
            if isinstance(caption_item, TextItem) and caption:
                runs += [run for run in self._runs_for(caption_item, caption) if run.get("href") and run not in runs]
        return runs
