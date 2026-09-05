"""Docling extraction -> StructDocument draft (the app-owned extraction adapter).

Everything Docling labels becomes STRUCT structure: headings with levels from
their numbering, paragraphs joined across column and page breaks only under an
explicit rule, figures carrying their caption text with the crop as a
fallback asset, tables as cell grids plus a caption block, formulas as
equation blocks (MathML attribute when LaTeX is available, crop asset
otherwise), footnotes as footnote blocks with matched note-reference runs,
code blocks, hyperlinks recovered from the PDF's own annotations as inline
runs, and page headers/footers plus edge page numbers as accounted furniture.

The draft carries every field the STRUCT codec requires except the receipt
counts and digest, which `render.mjs` computes with `@erniesg/struct` before
rendering. Nothing here renders XHTML or packages EPUB: that is struct's job.
"""

from __future__ import annotations

import base64
import hashlib
import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from docling_core.types.doc import (
    CodeItem,
    DocItemLabel,
    DoclingDocument,
    GroupItem,
    ListGroup,
    ListItem,
    PictureItem,
    SectionHeaderItem,
    TableItem,
    TextItem,
    TitleItem,
)
from docling_core.types.doc import ContentLayer
from docling_core.types.doc.document import FormulaItem

from pdf_links import SourceLink
from pdf_text import SourceText, normalize_marker

TERMINAL_RE = re.compile(r"[.!?:;\"”’)\]…]$")
FLOAT_KINDS = {"figure", "table", "caption", "equation", "footnote", "furniture"}
TRAILING_MARKER_RE = re.compile(r"[.!?:;\"”’)\]]\s?(?:\d{1,3}|[*†‡§¶]{1,3})$")
LOWER_START_RE = re.compile(r"^[a-zß-ÿ]")
NUMBERED_HEADING_RE = re.compile(r"^(\d+)(?:\.\d+)*\.?\s+\S")
APPENDIX_HEADING_RE = re.compile(r"^(?:Appendix\s+)?([A-Z])(?:\.\d+)*\.?\s+\S")
TOP_LEVEL_HEADING_RE = re.compile(
    r"^(abstract|introduction|background|related work|methods?|materials and methods|results|discussion|"
    r"conclusions?|limitations|ethics statement|ethical considerations|acknowledg\w*|references|bibliography|"
    r"appendix|appendices|supplementary\b.*|declarations|funding|author contributions|data availability\b.*|"
    r"code availability\b.*|competing interests|conflicts? of interest|keywords|impact statement|broader impacts?)\b",
    re.IGNORECASE,
)
DATE_AFTER_RE = re.compile(
    r"\s+(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b|\d{4}\b|of\s+\d|\(\d{4}\))"
)
FOOTNOTE_MARKER_RE = re.compile(r"^\s*(?:(\d{1,3})(?=\s|[A-Za-z(\[“\"'])|([*∗⋆★✱†‡§¶‖]{1,3}))\s*")
LIST_LIKE_NOTE_RE = re.compile(r"^\s*(?:\d{1,3}[.)]|[-•–—▪◦])\s+\S")
PAGE_NUMBER_TEXT_RE = re.compile(
    r"^\s*(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|/)\s*\d{1,4})?\s*$", re.IGNORECASE
)
REFERENCE_WORD_RE = re.compile(
    r"(figure|fig\.?|table|section|sec\.?|appendix|equation|eq\.?|chapter|page|step|algorithm|theorem|lemma|"
    r"of|and|or|to|the|by|in|at|than|from|with|level|version|layer|model|gpt|llama|top|type|class|round)$",
    re.IGNORECASE,
)
XML_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
SAFE_HREF_RE = re.compile(r"^(https?|mailto|ftp):", re.IGNORECASE)
VISIBLE_RE = re.compile(r"[^\s\u0300-\u036f\u00ad]")
TICK_LABEL_RE = re.compile(r"^\s*[-+]?\d{1,4}(?:[.,]\d+)?%?\s*$")
PARATEXT_NOTE_RE = re.compile(
    r"^(?:Permission to make digital|©|\(c\)\s*\d{4}|Copyright|ISSN|ISBN|ACM ISBN|https?://doi\.org|DOI:|arXiv:|Preprint,|"
    r"Proceedings of|\d{4}-\d{4}/\d{4}|This work is licensed|Licensed under|Received:|Accepted:|Published:|Manuscript submitted|"
    r"Authors?['’] address|Publication rights|Journal of |Vol\. \d)",
    re.IGNORECASE,
)
PARATEXT_NOTE_ANY_RE = re.compile(r"copyright held by|all rights reserved|creative commons|rights licensed to", re.IGNORECASE)
PROSE_LIKE_RE = re.compile(r"[a-z]{3,}[.!?]\s+[A-Z]|[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}")
FIGURE_CAPTION_RE = re.compile(r"^(Figure|Fig\.?)\s*(\d+)\s*(?:[.:|\-–—]|(?=\s+[A-Z]))", re.IGNORECASE)
TABLE_CAPTION_RE = re.compile(r"^(Table)\s*(\d+)\s*(?:[.:|\-–—]|(?=\s+[A-Z]))", re.IGNORECASE)


def sanitize(value: str) -> str:
    return XML_ILLEGAL_RE.sub("", value or "").replace("­", "")


def heading_level(text: str, docling_level: int | None, last_numbered_level: int | None) -> int:
    stripped = text.strip()
    if NUMBERED_HEADING_RE.match(stripped):
        return min(len(re.findall(r"\d+", stripped.split()[0])), 4)
    appendix = re.match(r"^(?:Appendix\s+)?([A-Z](?:\.\d+)*)\.?\s+\S", stripped)
    if appendix and len(stripped.split()) > 1:
        return min(1 + appendix.group(1).count("."), 4)
    if TOP_LEVEL_HEADING_RE.match(stripped):
        return 1
    if last_numbered_level:
        return min(last_numbered_level + 1, 3)
    if docling_level and docling_level > 1:
        return min(docling_level, 4)
    return 1


CAPTION_NOISE_RE = re.compile(r"^\s*(?:(?:\d{1,3}|[ivx]{1,5})\s+)+(?=(?:Figure|Fig\.?|Table)\s*\d)", re.IGNORECASE)


def clean_caption(text: str) -> str:
    """Drop stray page-number or axis tokens glued in front of `Figure N`."""
    return CAPTION_NOISE_RE.sub("", text, count=1).strip()


def footnote_parts(text: str) -> tuple[str | None, str]:
    match = FOOTNOTE_MARKER_RE.match(text)
    if not match:
        return None, text.strip()
    return normalize_marker(match.group(1) or match.group(2)), text[match.end() :].strip()


def loose_pattern(needle: str) -> re.Pattern:
    return re.compile(r"\s*".join(re.escape(ch) for ch in needle if not ch.isspace()))


def marker_candidates(marker: str, text: str) -> list[tuple[int, int, bool]]:
    """(start, end, strong) occurrences of a footnote marker in plain text."""
    results = []
    if marker.isdigit():
        pattern = re.compile(rf"(\s?)({re.escape(marker)})(?![\d.,]\d)(?=[\s.,;:)\]]|$)")
    else:
        pattern = re.compile(rf"(\s?)({re.escape(marker)})(?=[\s.,;:)\]]|$)")
    for match in pattern.finditer(text):
        start = match.start(2)
        before = text[: match.start(1) if match.group(1) else start]
        if not before:
            continue
        prev_char = before[-1]
        if marker.isdigit() and not match.group(1) and prev_char in "0123456789.,:":
            continue  # part of a number such as 1.2 or 3,2
        if marker.isdigit() and DATE_AFTER_RE.match(text, match.end(2)):
            continue  # "2 December 2021", "3 of 10", "2 (2021)"
        if match.group(1):
            prev_word = re.search(r"(\S+)$", before)
            word = prev_word.group(1) if prev_word else ""
            reference_word = bool(REFERENCE_WORD_RE.search(word)) or bool(re.fullmatch(r"\d+[.,]?", word))
            if prev_char in ".,;:)]\"”’'" and not reference_word:
                results.append((start, match.end(2), True))
            elif prev_word and not reference_word and prev_char.isalpha():
                results.append((start, match.end(2), False))
            elif prev_word and not marker.isdigit() and not prev_char.isspace():
                results.append((start, match.end(2), False))
        elif prev_char.isalpha() or prev_char in ")]\"”’'" or (not marker.isdigit() and not prev_char.isspace()):
            results.append((start, match.end(2), True))
    return results


@dataclass
class AdapterReport:
    blocks: int = 0
    paragraphs: int = 0
    joins: int = 0
    joins_dehyphenated: int = 0
    float_resumptions: int = 0
    post_pass_joins: int = 0
    joins_fused_words: int = 0
    headings: int = 0
    figures: int = 0
    figures_with_caption: int = 0
    figures_without_image: int = 0
    figures_recovered_from_source: int = 0
    captions_read_from_source: int = 0
    decorative_pictures_skipped: int = 0
    orphan_captions: int = 0
    captions_adopted: int = 0
    tables_semantic: int = 0
    tables_fallback_image: int = 0
    tables_unrendered: int = 0
    table_spans_clamped: int = 0
    table_cells_dropped: int = 0
    formulas_mathml: int = 0
    formulas_image: int = 0
    formulas_text: int = 0
    code_blocks: int = 0
    footnotes: int = 0
    footnotes_linked: int = 0
    footnotes_unlinked: int = 0
    links_expected: int = 0
    links_mapped: int = 0
    links_unmapped: int = 0
    internal_links_skipped: int = 0
    lists: int = 0
    furniture_blocks: int = 0
    repeated_text_demoted: int = 0
    furniture_blocks_merged: int = 0
    provenance_trimmed_for_budget: bool = False
    relationships_pruned: int = 0
    runs_pruned: int = 0
    pages_recovered_from_text_layer: int = 0
    footnotes_with_marker: int = 0
    orphan_figure_captions: int = 0
    edge_page_numbers_dropped: int = 0
    invisible_items_dropped: int = 0
    tick_label_runs_dropped: int = 0
    source_items: int = 0
    accounted_items: int = 0
    style_runs: int = 0
    code_from_monospace: int = 0
    code_relabelled_equation: int = 0
    code_relabelled_paragraph: int = 0
    paratext_notes_demoted: int = 0
    footnotes_glyph_linked: int = 0
    footnotes_placed: int = 0
    tables_degenerate_grid: int = 0
    tables_recovered_from_source: int = 0
    tables_caption_adopted: int = 0
    tables_continued: int = 0
    table_cell_links: int = 0
    subpanel_figures_merged: int = 0
    captions_adopted_by_geometry: int = 0
    heading_running_heads_demoted: int = 0
    headings_demoted_to_paragraph: int = 0
    listings_rejoined: int = 0
    table_crops_rejected_blank: int = 0
    table_captions_read_from_source: int = 0
    glyph_signals_available: bool = False
    warnings: list[str] = field(default_factory=list)


class StructAdapter:
    def __init__(self, doc: DoclingDocument, pdf_path: Path, source_sha256: str, links: list[SourceLink], word_boxes: list | None = None, page_lines: list | None = None, source_text: SourceText | None = None) -> None:
        self.doc = doc
        self.word_boxes = word_boxes or []
        self.page_lines = page_lines or []
        self.source_text = source_text
        self._notes: list[tuple[dict, str | None, TextItem]] = []
        self.pdf_path = pdf_path
        self.sha = source_sha256
        self.links = links
        self.report = AdapterReport()
        self.blocks: list[dict] = []
        self.assets: list[dict] = []
        self.relationships: list[dict] = []
        self.diagnostics: list[dict] = []
        self.title = sanitize(doc.name or pdf_path.stem)
        self.title_seen = False
        self._title_candidate: tuple[str, TextItem] | None = None
        self.abstract_parts: list[str] = []
        self._in_abstract = False
        self._last_numbered_level: int | None = None
        self._pending: dict | None = None
        self._caption_refs: set[str] = set()
        self._ids: set[str] = set()
        self._list_counter = 0
        self._corpus_words: set[str] | None = None
        self._captions_below_tables: list[bool] = []
        self._item_links = self._index_links()
        self.report.glyph_signals_available = bool(source_text and source_text.available)

    def _page_text(self, page: int | None):
        if page is None or self.source_text is None or not self.source_text.available:
            return None
        return self.source_text.page(page)

    # ------------------------------------------------------------ helpers
    def _id(self, base: str) -> str:
        candidate = re.sub(r"[^A-Za-z0-9._:-]", "-", base).strip("-") or "x"
        if not re.match(r"[A-Za-z0-9]", candidate):
            candidate = f"n{candidate}"
        unique = candidate[:200]
        counter = 2
        while unique in self._ids:
            unique = f"{candidate[:190]}-{counter}"
            counter += 1
        self._ids.add(unique)
        return unique

    def _page_of(self, item) -> int | None:
        prov = getattr(item, "prov", None)
        return prov[0].page_no if prov else None

    def _box(self, item) -> dict | None:
        prov = getattr(item, "prov", None)
        page = self._page_of(item)
        if not prov or page is None or page not in self.doc.pages:
            return None
        bbox = prov[0].bbox
        size = self.doc.pages[page].size
        if not size.width or not size.height:
            return None
        top = max(bbox.t, bbox.b)
        bottom = min(bbox.t, bbox.b)
        if str(bbox.coord_origin).lower().endswith("bottomleft"):
            y = 1 - top / size.height
        else:
            y = bottom / size.height
        width = round(abs(bbox.r - bbox.l) / size.width, 5)
        height = round(abs(top - bottom) / size.height, 5)
        if width <= 0 or height <= 0:
            return None
        return {
            "page": page,
            "x": round(min(max(0.0, min(bbox.l, bbox.r) / size.width), 1.0), 5),
            "y": round(min(max(0.0, y), 1.0), 5),
            "width": min(width, 1.0),
            "height": min(height, 1.0),
            "rotation": 0,
        }

    def _evidence(self, item, confidence: float = 1.0) -> dict:
        page = self._page_of(item)
        box = self._box(item)
        return {
            "confidence": confidence,
            "pages": [page] if page is not None else [],
            "boxes": [box] if box else [],
            "sourceIds": [self._source_id(item)],
            "signals": ["docling-layout"],
        }

    @staticmethod
    def _source_id(item) -> str:
        return getattr(item, "self_ref", "unknown").lstrip("#/").replace("/", "-")

    def _index_links(self) -> dict[str, list[tuple[str, str]]]:
        """Map each URI annotation to the layout item (or table cell) under its
        rectangle, keyed by the item's self_ref (cells: `ref#c<row>-<col>`)."""
        by_page: dict[int, list] = {}
        for item, _ in self.doc.iterate_items():
            if isinstance(item, TextItem) and item.prov:
                bbox = item.prov[0].bbox
                by_page.setdefault(item.prov[0].page_no, []).append((item.self_ref, item.text, (bbox.l, bbox.b, bbox.r, bbox.t)))
            elif isinstance(item, TableItem) and item.prov and item.data:
                page_no = item.prov[0].page_no
                size = self.doc.pages[page_no].size if page_no in self.doc.pages else None
                seen_cells: set[tuple[int, int]] = set()
                for row in item.data.grid:
                    for cell in row:
                        bbox = getattr(cell, "bbox", None)
                        key = (cell.start_row_offset_idx, cell.start_col_offset_idx)
                        if bbox is None or size is None or not cell.text.strip() or key in seen_cells:
                            continue
                        seen_cells.add(key)
                        if str(bbox.coord_origin).lower().endswith("topleft"):
                            box = (bbox.l, size.height - max(bbox.t, bbox.b), bbox.r, size.height - min(bbox.t, bbox.b))
                        else:
                            box = (bbox.l, min(bbox.b, bbox.t), bbox.r, max(bbox.b, bbox.t))
                        by_page.setdefault(page_no, []).append((f"{item.self_ref}#c{key[0]}-{key[1]}", cell.text, box))
        mapped: dict[str, list[tuple[str, str]]] = {}
        for link in self.links:
            if link.kind != "uri" or not link.uri or not SAFE_HREF_RE.match(link.uri):
                self.report.internal_links_skipped += 1
                continue
            self.report.links_expected += 1
            l, b, r, t = link.rect
            best, best_text, best_overlap = None, "", 0.0
            for key, text, (bl, bb, br, bt) in by_page.get(link.page, []):
                overlap = max(0.0, min(r, br) - max(l, bl)) * max(0.0, min(t, bt) - max(b, bb))
                if overlap > best_overlap or (overlap == best_overlap and best is not None and "#c" in key and overlap > 0):
                    best_overlap, best, best_text = overlap, key, text
            area = max((r - l) * (t - b), 1e-6)
            if best is None or best_overlap / area < 0.3:
                self.report.links_unmapped += 1
                continue
            uri = link.uri
            candidates = [uri, re.sub(r"^https?://", "", uri), re.sub(r"^https?://(www\.)?", "", uri).rstrip("/")]
            if link.text:
                candidates.append(link.text.rstrip(".,;"))
            chosen = None
            for candidate in candidates:
                if candidate and len(candidate) >= 4:
                    match = loose_pattern(candidate).search(best_text)
                    if match:
                        chosen = best_text[match.start() : match.end()]
                        break
            if chosen is None:
                self.report.links_unmapped += 1
                continue
            mapped.setdefault(best, []).append((chosen, uri))
            self.report.links_mapped += 1
            if "#c" in best:
                self.report.table_cell_links += 1
        return mapped

    def _runs_for(self, item: TextItem, text: str) -> list[dict]:
        runs: list[dict] = []
        spans: list[tuple[int, int]] = []
        hyperlink = getattr(item, "hyperlink", None)
        pairs = list(self._item_links.get(item.self_ref, []))
        if hyperlink and not pairs and SAFE_HREF_RE.match(str(hyperlink)):
            pairs.append((text, str(hyperlink)))
        for visible, href in pairs:
            match = loose_pattern(visible).search(text) if visible else None
            if not match or match.end() <= match.start():
                continue
            start, end = match.span()
            if any(not (end <= s or start >= e) for s, e in spans):
                continue
            spans.append((start, end))
            runs.append({"start": start, "end": end, "href": href})
        runs.extend(self._style_runs(item, text))
        return runs

    def _style_runs(self, item, text: str) -> list[dict]:
        """Bold/italic runs from the glyph faces under the item's box."""
        page_text = self._page_text(self._page_of(item))
        box = self._box(item)
        if page_text is None or box is None or len(text) < 8:
            return []
        runs = page_text.style_runs(box, text)
        self.report.style_runs += len(runs)
        return runs

    # ------------------------------------------------------------ blocks
    def _new_block(self, kind: str, item, text: str, **extra) -> dict:
        page = self._page_of(item)
        block = {
            "id": self._id(f"b-{len(self.blocks) + (1 if self._pending else 0) + 1:04d}-{kind}"),
            "kind": kind,
            "text": sanitize(text),
            "page": page,
            "order": 0,
            "column": "single",
            "inline": [],
            "evidence": self._evidence(item),
        }
        block.update(extra)
        return block

    def _flush(self) -> None:
        if self._pending is not None:
            self.blocks.append(self._pending)
            self.report.paragraphs += 1
        self._pending = None

    def _push(self, block: dict) -> None:
        self._flush()
        self.blocks.append(block)

    def _is_edge_page_number(self, item: TextItem) -> bool:
        if not PAGE_NUMBER_TEXT_RE.match(item.text):
            return False
        box = self._box(item)
        if box is None:
            return True
        return box["y"] <= 0.12 or box["y"] + box["height"] >= 0.88

    def _furniture_block(self, item: TextItem, classification: str, evidence: str | None = None) -> None:
        box = self._box(item)
        page = self._page_of(item)
        band = "top" if box and box["y"] < 0.5 else "bottom"
        block = self._new_block("furniture", item, item.text)
        block["furniture"] = {
            "classification": classification,
            "band": band,
            "pages": [page] if page is not None else [],
            "boxes": [box] if box else [],
            "evidence": [evidence or ("docling-furniture-layer" if classification == "explicit-paratext" else "edge-page-number")],
            "normalizedText": sanitize(item.text).strip().lower(),
        }
        self._push(block)
        self.report.furniture_blocks += 1

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

    def _emit_paragraph(self, item: TextItem) -> None:
        if not VISIBLE_RE.search(sanitize(item.text)):
            self.report.invisible_items_dropped += 1
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
                    if (
                        between
                        and all(b["kind"] in FLOAT_KINDS for b in between)
                        and not TERMINAL_RE.search(candidate["text"].rstrip())
                        and not TRAILING_MARKER_RE.search(candidate["text"].rstrip())
                    ):
                        pending = candidate
                        resumed = True
                    break
                if candidate["kind"] not in FLOAT_KINDS:
                    break
        if (
            pending is not None
            and not TERMINAL_RE.search(pending["text"].rstrip())
            and not TRAILING_MARKER_RE.search(pending["text"].rstrip())
            and (LOWER_START_RE.match(text.lstrip()) or pending["text"].rstrip().endswith("-"))
        ):
            previous = pending["text"].rstrip()
            following = text.lstrip()
            offset_shift = len(text) - len(following)
            if previous.endswith("-"):
                joined, dropped = self._dehyphenate(previous, following)
                if dropped:
                    self.report.joins_dehyphenated += 1
                base = len(previous) - (1 if dropped else 0)
            else:
                joined = previous + " " + following
                base = len(previous) + 1
            pending["text"] = joined
            for run in runs:
                pending["inline"].append({**run, "start": run["start"] - offset_shift + base, "end": run["end"] - offset_shift + base})
            pending["evidence"]["pages"] = sorted(set(pending["evidence"]["pages"] + ([self._page_of(item)] if self._page_of(item) is not None else [])))
            box = self._box(item)
            if box:
                pending["evidence"]["boxes"].append(box)
            if self._source_id(item) not in pending["evidence"]["sourceIds"]:
                pending["evidence"]["sourceIds"].append(self._source_id(item))
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
        if not self.title_seen and self._page_of(item) == 1 and not TOP_LEVEL_HEADING_RE.match(text):
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
        self.blocks.append(block)
        self.report.headings += 1

    def _caption_text(self, item) -> str:
        captions = [ref.resolve(self.doc) for ref in getattr(item, "captions", [])]
        for caption in captions:
            self._caption_refs.add(caption.self_ref)
        return clean_caption(sanitize(" ".join(c.text.strip() for c in captions if isinstance(c, TextItem) and c.text.strip())))

    def _asset(self, kind: str, base: str, pil_image, item) -> str | None:
        if pil_image is None:
            return None
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG", optimize=True)
        data = buffer.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        asset_id = self._id(f"asset-{base}")
        self.assets.append(
            {
                "id": asset_id,
                "kind": kind,
                "href": f"images/{base}-{digest[:12]}.png",
                "mediaType": "image/png",
                "sha256": digest,
                "width": int(pil_image.width),
                "height": int(pil_image.height),
                "bytes": base64.b64encode(data).decode("ascii"),
                "sourceObjectIds": [self._source_id(item)],
                "evidence": self._evidence(item),
                "fallback": "asset",
            }
        )
        return asset_id

    def _emit_picture(self, item: PictureItem) -> None:
        caption = self._caption_text(item)
        box = self._box(item)
        if not caption and box and box["width"] * box["height"] < 0.01:
            self.report.decorative_pictures_skipped += 1
            return
        self._flush()
        self.report.figures += 1
        image = None
        try:
            image = item.get_image(self.doc)
        except Exception as error:  # pragma: no cover
            self.report.warnings.append(f"picture image unavailable: {error}")
        label_match = re.match(r"^(Figure|Fig\.?)\s*(\d+)", caption or "", re.IGNORECASE)
        label = f"Figure {label_match.group(2)}" if label_match else f"Figure {self.report.figures}"
        block = self._new_block("figure", item, caption, label=label)
        asset_id = self._asset("figure", f"figure-{self.report.figures:03d}", image, item)
        if asset_id:
            block["fallbackAssetIds"] = [asset_id]
        else:
            self.report.figures_without_image += 1
            self._diagnostic("warning", "visuals", "Figure image unavailable", f"{label} has no crop", item)
        if caption:
            self.report.figures_with_caption += 1
        self.blocks.append(block)

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
        block = self._new_block("table", item, "")
        label_match = re.match(r"^Table\s*(\d+)", caption or "", re.IGNORECASE)
        if label_match:
            block["label"] = f"Table {label_match.group(1)}"
        usable = bool(grid) and any(cell.text.strip() for row in grid for cell in row)
        if usable:
            rows = len(grid)
            columns = max(len(row) for row in grid)
            filled = sum(1 for row in grid for cell in row if cell.text.strip())
            if rows * columns < 2 or filled < 0.5 * rows * columns:
                # a single cell or a mostly empty grid is not a table a
                # reader can use; the crop is the honest fallback
                usable = False
                self.report.tables_degenerate_grid += 1
        if usable:
            cells = []
            seen: set[tuple[int, int]] = set()
            occupied: set[tuple[int, int]] = set()
            rows = len(grid)
            columns = max(len(row) for row in grid)
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
                    footprint = {(rr, cc) for rr in range(r, r + row_span) for cc in range(c, c + col_span)}
                    if footprint & occupied:
                        row_span, col_span = 1, 1
                        footprint = {(r, c)}
                        self.report.table_spans_clamped += 1
                    occupied |= footprint
                    cell_text = sanitize(cell.text)
                    cell_runs: list[dict] = []
                    for visible, href in self._item_links.get(f"{item.self_ref}#c{r}-{c}", []):
                        match = loose_pattern(visible).search(cell_text) if visible else None
                        if not match or match.end() <= match.start():
                            continue
                        if any(not (match.end() <= run["start"] or match.start() >= run["end"]) for run in cell_runs):
                            continue
                        cell_runs.append({"start": match.start(), "end": match.end(), "href": href})
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
                            "evidence": self._evidence(item),
                        }
                    )
            block["table"] = {"rows": rows, "columns": columns, "cells": cells, "semantic": "verified"}
            # struct renders the table block's text as the caption above the table
            block["text"] = caption
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
                self.blocks.append(self._new_block("caption", note, note.text.strip()))

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
        block = self._new_block("code", item, sanitize(page_text.region_text(box)) or text)
        block["evidence"]["signals"].append("monospace-face")
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
                if share["math"] >= 0.35:
                    self.report.code_relabelled_equation += 1
                    self._emit_formula(item, prefer_image=True)
                    return
                self.report.code_relabelled_paragraph += 1
                self._emit_paragraph(item)
                return
            region = sanitize(page_text.region_text(box))
            if region and len(region) >= 0.5 * len(text):
                text = region
        self.blocks.append(self._new_block("code", item, text))
        self.report.code_blocks += 1

    def _emit_formula(self, item: TextItem, prefer_image: bool = False) -> None:
        self._flush()
        latex = sanitize((item.text or "").strip())
        block = self._new_block("equation", item, latex, label="Equation")
        mathml = None
        if latex and not prefer_image:
            try:
                import latex2mathml.converter

                mathml = latex2mathml.converter.convert(latex)
                if not mathml.startswith("<math") or "<script" in mathml:
                    mathml = None
            except Exception:
                mathml = None
        if mathml:
            block["attributes"] = {"mathml": mathml}
            self.report.formulas_mathml += 1
        else:
            image = None
            try:
                image = item.get_image(self.doc)
            except Exception:
                image = None
            asset_id = self._asset("equation", f"equation-{self.report.formulas_image + 1:03d}", image, item)
            if asset_id:
                block["fallbackAssetIds"] = [asset_id]
                self.report.formulas_image += 1
            else:
                self.report.formulas_text += 1
        self.blocks.append(block)

    def _emit_footnote(self, item: TextItem) -> None:
        self._flush()
        raw = sanitize(item.text)
        if PARATEXT_NOTE_RE.match(raw.strip()) or PARATEXT_NOTE_ANY_RE.search(raw):
            # copyright, licence, ISSN/DOI and journal lines are page
            # furniture that the layout model labelled as footnotes
            self.report.paratext_notes_demoted += 1
            self._furniture_block(item, "explicit-paratext", "paratext-note")
            return
        marker, body = footnote_parts(raw)
        if LIST_LIKE_NOTE_RE.match(raw) or (marker and marker.isdigit() and re.match(r"^[.)]\s+\S", body)):
            # "1. Preserve the Core Inquiry" / "- Valid values": a list item the layout model mislabelled
            self._list_counter += 1
            block = self._new_block("list-item", item, raw.strip())
            block["inline"] = self._runs_for(item, block["text"])
            block["attributes"] = {"ordered": bool(re.match(r"^\s*\d", raw)), "listId": f"list-fn-{self._list_counter}"}
            self.blocks.append(block)
            return
        self.report.footnotes += 1
        block = self._new_block("footnote", item, body, **({"label": marker} if marker else {}))
        block["inline"] = self._runs_for(item, body)
        self.blocks.append(block)
        if marker:
            self.report.footnotes_with_marker += 1
        # linking happens in `_link_notes` once every block on the page exists
        self._notes.append((block, marker, item))

    def _link_notes(self) -> None:
        note_boxes = [(b["page"], box) for b, _, _ in self._notes for box in b["evidence"]["boxes"]]
        alive = {id(b) for b in self.blocks}
        for block, marker, item in self._notes:
            if id(block) not in alive or block["kind"] != "footnote":
                continue
            linked = False
            if marker:
                linked = self._link_marker_by_glyphs(marker, block, item, note_boxes)
                if not linked:
                    # no superscript glyph run carries this label (marker set on the
                    # baseline, or on another page): fall back to the text heuristics
                    linked = self._link_marker(marker, block, item)
            if linked:
                self.report.footnotes_linked += 1
            else:
                self.report.footnotes_unlinked += 1
                self._diagnostic("warning", "notes", "Footnote marker not found", f"footnote {marker or '?'} has no matched reference", item)

    @staticmethod
    def _locate_marker(text: str, left_context: str, token: str, label: str) -> tuple[int, int] | None:
        """Offsets of `label` in `text` where the glyph run `token` follows
        `left_context`, compared without whitespace; longest context first."""
        compact_chars: list[str] = []
        index_map: list[int] = []
        for index, char in enumerate(text):
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

    def _link_marker_by_glyphs(self, marker: str, note_block: dict, item: TextItem, note_boxes: list) -> bool:
        """Link a note to every superscript glyph run on its page that carries
        the note's label and sits inside a body block; the run's own left
        context locates the exact characters in the block text."""
        page = self._page_of(item)
        page_text = self._page_text(page)
        if page_text is None:
            return False
        def outside_notes(glyph_marker) -> bool:
            cx, cy = glyph_marker.x + glyph_marker.width / 2, glyph_marker.y + glyph_marker.height / 2
            return not any(p == page and bx["x"] - 0.004 <= cx <= bx["x"] + bx["width"] + 0.004 and bx["y"] - 0.004 <= cy <= bx["y"] + bx["height"] + 0.004 for p, bx in note_boxes)

        usable = [m for m in page_text.markers if not m.at_line_start and outside_notes(m)]
        candidates = [m for m in usable if m.has_label(marker)] or [m for m in usable if m.has_label(marker, loose=True)]
        if not candidates:
            return False
        hosts = [b for b in self.blocks if b["page"] == page and b["kind"] in ("paragraph", "list-item", "heading", "caption", "figure", "quote") and b is not note_block]
        linked = False
        for glyph_marker in candidates:
            cx, cy = glyph_marker.x + glyph_marker.width / 2, glyph_marker.y + glyph_marker.height / 2
            containing = [
                b
                for b in hosts
                if any(bx["x"] - 0.006 <= cx <= bx["x"] + bx["width"] + 0.006 and bx["y"] - 0.006 <= cy <= bx["y"] + bx["height"] + 0.006 for bx in b["evidence"]["boxes"])
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
        same_page = [b for b in self.blocks if b["kind"] in ("paragraph", "list-item") and b["page"] == page and b is not note_block]
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
                if any(not (end <= r["start"] or start >= r["end"]) for r in block["inline"] if r.get("href") or r.get("targetIds")):
                    continue
                relationship_id = self._id(f"rel-note-{note_block['id']}")
                self.relationships.append(
                    {
                        "id": relationship_id,
                        "kind": "footnote",
                        "from": block["id"],
                        "to": [note_block["id"]],
                        "label": marker,
                        "status": "matched",
                        "confidence": 1 if spans and strong_hits else 0.6,
                        "evidence": self._evidence(item),
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
                linked = True
        return linked

    def _diagnostic(self, severity: str, category: str, title: str, message: str, item, page: int | None = None) -> None:
        page = self._page_of(item) if item is not None else page
        self.diagnostics.append(
            {
                "id": self._id(f"diag-{len(self.diagnostics) + 1:04d}"),
                "severity": severity,
                "category": category,
                "title": title,
                "message": sanitize(message)[:500],
                "pages": [page] if page is not None else [],
                "sourceIds": [self._source_id(item)] if item is not None else [],
            }
        )

    # ------------------------------------------------------------- walk
    def _walk(self, node, list_context: dict | None = None) -> None:
        for ref in node.children:
            child = ref.resolve(self.doc)
            self.report.source_items += 0 if isinstance(child, GroupItem) else 1
            if isinstance(child, ListGroup):
                self._flush()
                self._list_counter += 1
                context = {"listId": f"list-{self._list_counter}", "ordered": child.first_item_is_enumerated(self.doc)}
                self.report.lists += 1
                self._walk(child, context)
                continue
            if isinstance(child, GroupItem):
                self._walk(child, list_context)
                continue
            self._emit(child, list_context)
            if child.children and not isinstance(child, (PictureItem, TableItem)):
                self._walk(child, list_context)

    def _emit(self, item, list_context: dict | None) -> None:
        self.report.accounted_items += 1
        if isinstance(item, TitleItem):
            self.title_seen = True
            self.title = sanitize(item.text.strip()) or self.title
        elif isinstance(item, SectionHeaderItem):
            self._emit_heading(item)
        elif isinstance(item, PictureItem):
            self._emit_picture(item)
        elif isinstance(item, TableItem):
            self._emit_table(item)
        elif isinstance(item, FormulaItem):
            self._emit_formula(item)
        elif isinstance(item, CodeItem):
            self._emit_code(item)
        elif isinstance(item, ListItem) or (isinstance(item, TextItem) and list_context and item.label == DocItemLabel.TEXT):
            self._flush()
            block = self._new_block("list-item", item, sanitize(item.text))
            block["inline"] = self._runs_for(item, block["text"])
            block["attributes"] = {
                "ordered": bool(list_context["ordered"] if list_context else getattr(item, "enumerated", False)),
                "listId": list_context["listId"] if list_context else f"list-{self._list_counter or 1}",
            }
            self.blocks.append(block)
        elif isinstance(item, TextItem):
            label = item.label
            if label == DocItemLabel.FOOTNOTE:
                self._emit_footnote(item)
            elif label == DocItemLabel.CAPTION:
                if item.self_ref in self._caption_refs:
                    return
                self._flush()
                self.report.orphan_captions += 1
                block = self._new_block("caption", item, sanitize(item.text))
                block["inline"] = self._runs_for(item, block["text"])
                self.blocks.append(block)
            elif label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
                self._furniture_block(item, "explicit-paratext")
            elif label == DocItemLabel.FORMULA:
                self._emit_formula(item)
            elif label == DocItemLabel.CODE:
                self._emit_code(item)
            elif label == DocItemLabel.SECTION_HEADER:
                self._emit_heading(item)
            elif label == DocItemLabel.TITLE:
                self.title_seen = True
                self.title = sanitize(item.text.strip()) or self.title
            else:
                self._emit_paragraph(item)

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

    def _fuse_words(self, previous: str, following: str) -> str | None:
        """`eval` + `uation` -> `evaluation` when the fused word is attested in
        the paper; otherwise None."""
        head = re.search(r"([A-Za-z]+)$", previous)
        tail = re.match(r"([a-z]+)", following)
        if not head or not tail:
            return None
        if self._corpus_words is None:
            words: set[str] = set()
            for item, _ in self.doc.iterate_items():
                if isinstance(item, TextItem):
                    words.update(w.lower() for w in re.findall(r"[A-Za-z]{3,}", item.text))
            self._corpus_words = words
        fused = (head.group(1) + tail.group(1)).lower()
        if fused in self._corpus_words and fused != head.group(1).lower() and fused != tail.group(1):
            return previous + following
        return None

    def _join_split_paragraphs(self) -> None:
        """Post-pass join for paragraphs split by floats or furniture that were
        only classified after the walk: the previous paragraph lacks terminal
        punctuation and the continuation starts lowercase (or the two halves
        fuse into an attested word)."""
        skip = FLOAT_KINDS | {"furniture"}
        index = 1
        while index < len(self.blocks):
            block = self.blocks[index]
            if block["kind"] != "paragraph" or not LOWER_START_RE.match(block["text"].lstrip()):
                index += 1
                continue
            # the continuation's paragraph is the nearest unterminated
            # paragraph behind it, on this page or the previous one; complete
            # paragraphs in between belong to another column's flow
            back = index - 1
            previous = None
            complete_skipped = 0
            while back >= 0 and index - back <= 8:
                candidate = self.blocks[back]
                if candidate["kind"] in skip:
                    back -= 1
                    continue
                if candidate["kind"] != "paragraph" or candidate["page"] is None or block["page"] is None or block["page"] - candidate["page"] > 1:
                    break
                text = candidate["text"].rstrip()
                if TERMINAL_RE.search(text) or TRAILING_MARKER_RE.search(text):
                    complete_skipped += 1
                    if complete_skipped > 3:
                        break
                    back -= 1
                    continue
                previous = candidate
                break
            if previous is None:
                index += 1
                continue
            prev_text = previous["text"].rstrip()
            following = block["text"].lstrip()
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
            previous["evidence"]["boxes"].extend(block["evidence"]["boxes"])
            previous["evidence"]["sourceIds"] = list(dict.fromkeys(previous["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))
            # relationships pointing at the absorbed block now point at the survivor
            for relationship in self.relationships:
                if relationship["from"] == block["id"]:
                    relationship["from"] = previous["id"]
                relationship["to"] = [previous["id"] if t == block["id"] else t for t in relationship["to"]]
            del self.blocks[index]
            self.report.joins += 1
            self.report.post_pass_joins += 1

    def _demote_repeated_edge_text(self) -> None:
        """Spec 042 rule: short text repeated on three or more pages inside the
        top or bottom band is page furniture (running heads, journal lines,
        ACM footers), decided by geometry and repetition, never by wording."""
        keyed: dict[str, list[dict]] = {}
        for block in self.blocks:
            # furniture the layout model already separated counts as repetition evidence
            if block["kind"] not in ("paragraph", "caption", "heading", "furniture") or not block["evidence"]["boxes"]:
                continue
            text = block["text"].strip()
            if not text or len(text) > 160:
                continue
            box = block["evidence"]["boxes"][0]
            if not (box["y"] <= 0.15 or box["y"] + box["height"] >= 0.84):
                continue
            key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
            keyed.setdefault(key, []).append(block)
        for key, group in keyed.items():
            pages = {b["page"] for b in group}
            if len(pages) < 3:
                continue
            for block in group:
                if block["kind"] == "furniture":
                    continue
                box = block["evidence"]["boxes"][0]
                block["kind"] = "furniture"
                block.pop("attributes", None)
                block["inline"] = []
                block["furniture"] = {
                    "classification": "repeated-text",
                    "band": "top" if box["y"] <= 0.15 else "bottom",
                    "pages": sorted(pages),
                    "boxes": [box],
                    "evidence": [f"repeated-on-{len(pages)}-pages", "edge-band"],
                    "normalizedText": key,
                }
                self.report.furniture_blocks += 1
                self.report.repeated_text_demoted += 1

    def _compact_graph(self) -> None:
        """Keep the document inside struct's canonical node budget: joined
        paragraphs keep one union box per page, and furniture on one page
        collapses into a single accounted block."""
        for block in self.blocks:
            boxes = block["evidence"]["boxes"]
            if len(boxes) > 2:
                by_page: dict[int, list[dict]] = {}
                for box in boxes:
                    by_page.setdefault(box["page"], []).append(box)
                union = []
                for page, group in sorted(by_page.items()):
                    x0 = min(b["x"] for b in group)
                    y0 = min(b["y"] for b in group)
                    x1 = max(b["x"] + b["width"] for b in group)
                    y1 = max(b["y"] + b["height"] for b in group)
                    union.append({"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0})
                block["evidence"]["boxes"] = union
            if len(block["evidence"]["sourceIds"]) > 8:
                block["evidence"]["sourceIds"] = block["evidence"]["sourceIds"][:8]
        # very large documents: drop optional provenance signals so the canonical
        # node count stays inside struct's budget (100k nodes)
        if len(self.blocks) + len(self.assets) > 1500:
            for block in self.blocks:
                block["evidence"].pop("signals", None)
                block["evidence"]["boxes"] = block["evidence"]["boxes"][:1]
                block["evidence"]["sourceIds"] = block["evidence"]["sourceIds"][:2]
                if block.get("furniture"):
                    block["furniture"]["boxes"] = block["furniture"]["boxes"][:1]
                    block["furniture"]["evidence"] = block["furniture"]["evidence"][:1]
            for asset in self.assets:
                asset["evidence"].pop("signals", None)
                asset["evidence"]["boxes"] = asset["evidence"]["boxes"][:1]
            self.report.provenance_trimmed_for_budget = True
        merged: list[dict] = []
        furniture_by_page: dict[int, dict] = {}
        for block in self.blocks:
            if block["kind"] != "furniture" or block["page"] is None:
                merged.append(block)
                continue
            existing = furniture_by_page.get(block["page"])
            if existing is None:
                furniture_by_page[block["page"]] = block
                merged.append(block)
                continue
            existing["text"] = f"{existing['text']} {block['text']}".strip()
            existing["evidence"]["boxes"] = (existing["evidence"]["boxes"] + block["evidence"]["boxes"])[:4]
            existing["evidence"]["sourceIds"] = list(dict.fromkeys(existing["evidence"]["sourceIds"] + block["evidence"]["sourceIds"]))[:8]
            furniture = existing.get("furniture")
            if furniture:
                furniture["boxes"] = (furniture["boxes"] + block.get("furniture", {}).get("boxes", []))[:4]
                furniture["evidence"] = list(dict.fromkeys(furniture["evidence"] + block.get("furniture", {}).get("evidence", [])))[:6]
                furniture["normalizedText"] = f"{furniture.get('normalizedText', '')} {block.get('furniture', {}).get('normalizedText', '')}".strip()[:300]
            self.report.furniture_blocks_merged += 1
        self.blocks = merged

    def _prune_dangling_references(self) -> None:
        """Post-passes may absorb or drop blocks; relationships and inline runs
        that point at a vanished block are removed rather than left dangling."""
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
            runs = []
            for run in block["inline"]:
                if any(t not in ids for t in run.get("targetIds", [])) or (run.get("relationshipId") and run["relationshipId"] not in relationship_ids):
                    self.report.runs_pruned += 1
                    continue
                runs.append(run)
            block["inline"] = runs
            for asset_id in list(block.get("fallbackAssetIds", [])):
                if asset_id not in ids:
                    block["fallbackAssetIds"].remove(asset_id)

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
                            and len(neighbour["text"]) < 1200
                        ):
                            block["text"] = clean_caption(neighbour["text"])
                            block["inline"] = neighbour.get("inline", []) if block["text"] == neighbour["text"] else []
                            label = re.match(r"^(Figure|Fig\.?)\s*(\d+)", neighbour["text"], re.IGNORECASE)
                            block["label"] = f"Figure {label.group(2)}"
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

    def _read_captions_inside_figures(self) -> None:
        """When the layout model swallowed the caption into the picture crop, the
        PDF text layer still holds it: read the words in the bottom band of the
        figure box; if they start with `Figure N`, that is the caption."""
        for block in self.blocks:
            if block["kind"] != "figure" or block["text"] or not block["evidence"]["boxes"] or block["page"] is None:
                continue
            box = block["evidence"]["boxes"][0]
            band_top = box["y"] + box["height"] * 0.6
            words = self._words_in(block["page"], box["x"] - 0.01, band_top, box["x"] + box["width"] + 0.01, box["y"] + box["height"] + 0.01)
            if not words:
                continue
            # keep the lines from the first `Figure N` word onward
            start = next((i for i, (_, t) in enumerate(words) if re.match(r"^(Figure|Fig\.?)$", t, re.IGNORECASE)), None)
            if start is None:
                continue
            caption = clean_caption(sanitize(" ".join(t for _, t in words[start:])))
            label = FIGURE_CAPTION_RE.match(caption)
            if not label:
                continue
            block["text"] = caption
            block["label"] = f"Figure {label.group(2)}"
            self.report.figures_with_caption += 1
            self.report.captions_read_from_source += 1

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

    def _recover_uncaptured_figures(self) -> None:
        """An orphan `Figure N` caption with no figure beside it means the layout
        model missed the artwork. Recover it as a source-region crop: the page
        band above the caption, bounded by the previous block in that column
        and the caption's own horizontal extent, cut from the page image."""
        rebuilt: list[dict] = []
        for index, block in enumerate(self.blocks):
            label_match = FIGURE_CAPTION_RE.match(block["text"])
            claimed = any(
                0 <= index + delta < len(self.blocks)
                and self.blocks[index + delta]["kind"] == "figure"
                and (
                    not self.blocks[index + delta]["text"]
                    or (label_match and self.blocks[index + delta].get("label") == f"Figure {label_match.group(2)}")
                )
                for delta in (-1, 1)
            )
            is_orphan = (
                block["kind"] in ("caption", "paragraph")
                and label_match is not None
                and len(block["text"]) < 1200
                and not claimed
                and not any(f.get("label") == f"Figure {label_match.group(2)}" for f in self.blocks if f["kind"] == "figure")
            )
            if not is_orphan or not block["evidence"]["boxes"] or block["page"] is None:
                rebuilt.append(block)
                continue
            page = block["page"]
            caption_box = block["evidence"]["boxes"][0]
            page_item = self.doc.pages.get(page)
            image = None
            try:
                image = page_item.image.pil_image if page_item and page_item.image else None
            except Exception:
                image = None
            if image is None:
                rebuilt.append(block)
                continue
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
            if bottom - top < 0.04:
                rebuilt.append(block)
                continue
            width, height = image.size
            crop = image.crop((int(x0 * width), int(top * height), int(x1 * width), int(bottom * height)))
            self.report.figures += 1
            self.report.figures_with_caption += 1
            self.report.figures_recovered_from_source += 1
            if block["kind"] == "caption":
                self.report.orphan_captions -= 1
            else:
                self.report.paragraphs -= 1
            label = re.match(r"^(Figure|Fig\.?)\s*(\d+)", block["text"], re.IGNORECASE)
            figure = {
                "id": self._id(f"b-recovered-figure-{label.group(2)}"),
                "kind": "figure",
                "text": clean_caption(block["text"]),
                "label": f"Figure {label.group(2)}",
                "page": page,
                "order": 0,
                "column": "single",
                "inline": block.get("inline", []),
                "evidence": {
                    "confidence": 0.6,
                    "pages": [page],
                    "boxes": [{"page": page, "x": round(x0, 5), "y": round(top, 5), "width": round(x1 - x0, 5), "height": round(bottom - top, 5), "rotation": 0}],
                    "sourceIds": block["evidence"]["sourceIds"],
                    "signals": ["source-region-fallback", "orphan-caption"],
                },
            }
            asset_id = self._asset_from_image("figure", f"figure-recovered-{label.group(2)}", crop, figure["evidence"], block["evidence"]["sourceIds"])
            if asset_id:
                figure["fallbackAssetIds"] = [asset_id]
            self._diagnostic("info", "visuals", "Figure recovered from source region", f"{figure['label']} cut from the page band above its caption", None, page)
            rebuilt.append(figure)
        self.blocks = rebuilt

    def _asset_from_image(self, kind: str, base: str, pil_image, evidence: dict, source_ids: list[str]) -> str | None:
        if pil_image is None or pil_image.width < 8 or pil_image.height < 8:
            return None
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG", optimize=True)
        data = buffer.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        asset_id = self._id(f"asset-{base}")
        self.assets.append(
            {
                "id": asset_id,
                "kind": kind,
                "href": f"images/{base}-{digest[:12]}.png",
                "mediaType": "image/png",
                "sha256": digest,
                "width": int(pil_image.width),
                "height": int(pil_image.height),
                "bytes": base64.b64encode(data).decode("ascii"),
                "sourceObjectIds": list(source_ids),
                "evidence": {**evidence, "sourceIds": list(source_ids)},
                "fallback": "source-region",
            }
        )
        return asset_id

    def _page_image(self, page: int | None):
        page_item = self.doc.pages.get(page) if page is not None else None
        try:
            return page_item.image.pil_image if page_item and page_item.image else None
        except Exception:
            return None

    def _crop_asset(self, kind: str, base: str, page: int, x0: float, y0: float, x1: float, y1: float, evidence: dict, source_ids: list[str], require_ink: bool = False) -> str | None:
        image = self._page_image(page)
        if image is None:
            return None
        width, height = image.size
        crop = image.crop((int(x0 * width), int(y0 * height), int(x1 * width), int(y1 * height)))
        if require_ink and not self._has_ink(crop):
            return None
        return self._asset_from_image(kind, base, crop, evidence, source_ids)

    @staticmethod
    def _has_ink(image) -> bool:
        """True when a crop carries content: dark pixels on at least a
        seventh of its rows, so a blank band or a lone rule is refused."""
        try:
            grey = image.convert("L")
            width, height = grey.size
            if width < 8 or height < 8:
                return False
            step = max(1, height // 200)
            inked_rows = 0
            sampled = 0
            pixels = grey.load()
            for y in range(0, height, step):
                sampled += 1
                dark = sum(1 for x in range(0, width, max(1, width // 300)) if pixels[x, y] < 160)
                if dark >= 2:
                    inked_rows += 1
            return sampled > 0 and inked_rows / sampled >= 0.15
        except Exception:
            return True

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
                    group.append(nxt)
                    j += 1
                else:
                    break
            if len(group) >= 2 and self._union_figure(block, group):
                index += 1
                continue
            index += 1

    def _union_figure(self, keeper: dict, group: list[dict]) -> bool:
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
        if not aligned or (x1 - x0) * (y1 - y0) > max(1.8 * panel_area, panel_area + 0.02) or y1 - y0 > 0.8:
            return False
        page = keeper["page"]
        union = {"page": page, "x": round(x0, 5), "y": round(y0, 5), "width": round(x1 - x0, 5), "height": round(y1 - y0, 5), "rotation": 0}
        source_ids = list(dict.fromkeys(sid for b in group for sid in b["evidence"]["sourceIds"]))[:8]
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
                    group = [neighbour, block] if neighbour_index < index else [block, neighbour]
                    if self._union_figure(block, group):
                        self.report.figures_with_caption += 0
                        changed = True
                        break
                if changed:
                    break

    def _adopt_captions_by_geometry(self) -> None:
        """A caption-less figure or table adopts the nearest orphan `Figure N`
        / `Table N` caption on its page that shares its column and sits just
        below or above it, wherever the caption landed in reading order."""
        owned = {t for r in self.relationships for t in r["to"]}
        for block in list(self.blocks):
            if block["kind"] not in ("figure", "table") or block["text"] or not block["evidence"]["boxes"] or block["page"] is None:
                continue
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
                if overlap < 0.4 * min(fbox["width"], cbox["width"]):
                    continue
                below = cbox["y"] - (fbox["y"] + fbox["height"])
                above = fbox["y"] - (cbox["y"] + cbox["height"])
                gap = below if -0.01 <= below <= 0.08 else (above if -0.01 <= above <= 0.08 else None)
                if gap is not None and abs(gap) < best_gap:
                    best, best_gap = candidate, abs(gap)
            if best is None:
                continue
            label = pattern.match(best["text"])
            block["text"] = clean_caption(best["text"]) if block["kind"] == "figure" else best["text"]
            block["inline"] = best.get("inline", []) if block["text"] == best["text"] else []
            block["label"] = f"{'Table' if block['kind'] == 'table' else 'Figure'} {label.group(2)}"
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
            if not match or len(block["text"]) > 1200 or block["page"] is None:
                index += 1
                continue
            label = f"Table {match.group(2)}"
            if any(b.get("label") == label for b in self.blocks if b["kind"] in ("table", "figure")):
                index += 1
                continue
            adopted = False
            for delta in (1, -1):
                j = index + delta
                if 0 <= j < len(self.blocks) and self.blocks[j]["kind"] == "table" and not self.blocks[j]["text"] and self.blocks[j]["page"] == block["page"]:
                    self.blocks[j]["text"] = block["text"]
                    self.blocks[j]["label"] = label
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
            asset_id = self._crop_asset("table", f"table-recovered-{match.group(2)}", page, x0, band[0], x1, band[1], evidence, block["evidence"]["sourceIds"], require_ink=True)
            if not asset_id:
                self.report.table_crops_rejected_blank += 1
                index += 1
                continue
            figure = {
                "id": self._id(f"b-recovered-table-{match.group(2)}"),
                "kind": "figure",
                "text": block["text"],
                "label": label,
                "page": page,
                "order": 0,
                "column": "single",
                "inline": block.get("inline", []),
                "evidence": evidence,
                "fallbackAssetIds": [asset_id],
            }
            position = self.blocks.index(block)
            for absorbed_block in absorbed:
                self._absorb_block(absorbed_block)
            self._absorb_block(block)
            self.blocks.insert(min(position, len(self.blocks)), figure)
            self.report.tables_recovered_from_source += 1
            self.report.tables_fallback_image += 1
            self._diagnostic("info", "tables", "Table recovered from source region", f"{label} cut from the page band beside its caption ({len(absorbed)} text rows absorbed)", None, page)
            index = position + 1

    def _absorb_block(self, block: dict) -> None:
        """Remove a block whose content now lives in a crop; relationships to
        it are dropped by `_prune_dangling_references`."""
        if block in self.blocks:
            self.blocks.remove(block)
        if block["kind"] == "paragraph":
            self.report.paragraphs -= 1
        elif block["kind"] == "caption":
            self.report.orphan_captions = max(0, self.report.orphan_captions - 1)

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

    def _merge_continued_tables(self) -> None:
        """A caption-less (or `continued`) table at the top of a page that
        follows a captioned table with the same column count on the previous
        page continues it: its rows append to that table."""
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

    def _demote_heading_running_heads(self) -> None:
        """Running heads that repeat the current section title or the paper
        title (so their text changes from page to page and escapes the
        repetition rule) are furniture when they sit in an edge band."""

        def key(text: str) -> str:
            return re.sub(r"\s+", " ", re.sub(r"^[\dA-Z]+(?:\.\d+)*\.?\s+", "", text.strip().lower()))

        headings = {key(b["text"]) for b in self.blocks if b["kind"] == "heading"}
        title = key(self.title)
        for block in self.blocks:
            if block["kind"] not in ("paragraph", "caption") or not block["evidence"]["boxes"] or block["page"] in (None, 1):
                continue
            text = block["text"].strip()
            if not text or len(text) > 120:
                continue
            box = block["evidence"]["boxes"][0]
            if not (box["y"] <= 0.12 or box["y"] + box["height"] >= 0.88):
                continue
            normalized = re.sub(r"^\d+\s+|\s+\d+$", "", key(text))
            if len(normalized) < 6:
                continue
            if not (normalized in headings or normalized == title or (len(normalized) >= 12 and (title.startswith(normalized) or normalized in title))):
                continue
            block["kind"] = "furniture"
            block.pop("attributes", None)
            block["inline"] = []
            block["furniture"] = {
                "classification": "repeated-text",
                "band": "top" if box["y"] <= 0.12 else "bottom",
                "pages": [block["page"]],
                "boxes": [box],
                "evidence": ["matches-heading-or-title", "edge-band"],
                "normalizedText": normalized,
            }
            self.report.furniture_blocks += 1
            self.report.heading_running_heads_demoted += 1

    def _drop_tick_label_runs(self) -> None:
        """Three or more consecutive number-only blocks on one page are chart
        tick labels that the layout model left outside the picture crop; they
        are figure content, not prose."""
        kept: list[dict] = []
        run: list[dict] = []

        def flush_run() -> None:
            nonlocal run
            if len(run) >= 3:
                self.report.tick_label_runs_dropped += len(run)
                self._diagnostic("info", "visuals", "Chart labels dropped", f"{len(run)} number-only lines treated as figure content", None, run[0]["page"])
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

    # ------------------------------------------------------------- build
    def build(self) -> tuple[dict, AdapterReport]:
        for floating in list(self.doc.pictures) + list(self.doc.tables):
            for ref in floating.captions:
                self._caption_refs.add(ref.cref)
        self._walk(self.doc.body)
        # furniture layer: page headers/footers Docling already separated
        for item, _ in self.doc.iterate_items(included_content_layers={ContentLayer.FURNITURE}):
            if isinstance(item, TextItem) and item.text.strip():
                self.report.source_items += 1
                self.report.accounted_items += 1
                self._furniture_block(item, "explicit-paratext")
        self._flush()
        self._recover_dropped_pages()
        self._drop_tick_label_runs()
        self._demote_repeated_edge_text()
        self._demote_heading_running_heads()
        self._join_split_paragraphs()
        self._link_notes()
        self._merge_subpanel_figures()
        self._adopt_orphan_captions()
        self._adopt_captions_by_geometry()
        self._read_captions_inside_figures()
        self._read_table_captions_from_source()
        self._fold_panels_into_captioned_figures()
        self._recover_uncaptured_figures()
        self._recover_uncaptured_tables()
        self._merge_continued_tables()
        self._rejoin_split_listings()
        self._compact_graph()
        self._prune_dangling_references()
        self._place_notes()
        for order, block in enumerate(self.blocks):
            block["order"] = order
        page_count = len(self.doc.pages) or 1
        pages = []
        for page_no in sorted(self.doc.pages):
            size = self.doc.pages[page_no].size
            ids = [b["id"] for b in self.blocks if b["page"] == page_no]
            pages.append(
                {
                    "page": page_no,
                    "width": round(float(size.width), 3),
                    "height": round(float(size.height), 3),
                    "rotation": 0,
                    "blocks": ids,
                    "columns": [{"id": f"p{page_no}-single", "side": "single", "blockIds": ids}],
                }
            )
        known_pages = {p["page"] for p in pages}
        for block in self.blocks:
            if block["page"] is not None and block["page"] not in known_pages:
                block["page"] = None
                block["evidence"]["pages"] = []
                block["evidence"]["boxes"] = []
        blocking = [d for d in self.diagnostics if d["severity"] == "error"]
        issues = []
        for category in sorted({d["category"] for d in self.diagnostics}):
            group = [d for d in self.diagnostics if d["category"] == category]
            issues.append(
                {
                    "category": category,
                    "title": group[0]["title"],
                    "count": len(group),
                    "pages": sorted({p for d in group for p in d["pages"]}),
                }
            )
        document = {
            "schemaVersion": "0.2.0",
            "documentId": f"doc-{self.sha[:24]}",
            "source": {
                "format": "pdf",
                "fileName": self.pdf_path.name,
                "sha256": self.sha,
                "byteLength": self.pdf_path.stat().st_size,
                "pageCount": max(page_count, max(known_pages) if known_pages else 1),
                "localOnly": True,
            },
            "metadata": {
                "title": self.title,
                "subtitle": "",
                "authors": [],
                "abstract": " ".join(self.abstract_parts)[:5000],
            },
            "blocks": self.blocks,
            "assets": self.assets,
            "relationships": self.relationships,
            "pages": pages,
            "diagnostics": self.diagnostics,
            "recovery": {
                "status": "review-required" if blocking else "ready",
                "title": "Docling extraction" + (" needs review" if blocking else " complete"),
                "summary": f"{len(self.blocks)} blocks, {len(self.assets)} assets, {len(self.relationships)} relationships, {len(self.diagnostics)} diagnostics.",
                "issues": issues,
            },
            "receipt": {
                "schemaVersion": "0.2.0",
                "documentId": f"doc-{self.sha[:24]}",
                "sourceSha256": self.sha,
                "conservation": {
                    "sourceNodeCount": self.report.source_items,
                    "accountedSourceNodeCount": min(self.report.accounted_items, self.report.source_items),
                    "sourceRegionCount": self.report.source_items,
                    "accountedSourceRegionCount": min(self.report.accounted_items, self.report.source_items),
                    "sourceAnnotationCount": self.report.links_expected + self.report.internal_links_skipped,
                    "accountedSourceAnnotationCount": self.report.links_mapped,
                },
            },
        }
        self.report.blocks = len(self.blocks)
        self.report.orphan_figure_captions = sum(
            1 for b in self.blocks if b["kind"] == "caption" and FIGURE_CAPTION_RE.match(b["text"])
        )
        return document, self.report


def to_struct_draft(doc: DoclingDocument, pdf_path: Path, source_sha256: str, links: list[SourceLink], word_boxes: list | None = None, page_lines: list | None = None, source_text: SourceText | None = None) -> tuple[dict, AdapterReport]:
    return StructAdapter(doc, pdf_path, source_sha256, links, word_boxes, page_lines, source_text).build()
