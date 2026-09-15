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

from pdf_links import SourceLink, group_wrapped_links, normalize_uri
from pdf_text import SourceText, normalize_marker
from source_raster import SourceRasterError
from layout_normalization import normalize_provenance
from figure_recovery import normalize_sideways_captions

TERMINAL_RE = re.compile(r"[.!?:;\"”’)\]…]$")
# a trailing citation (`[85]`, `(Smith et al., 2020)`) is not sentence punctuation
CITATION_TAIL_RE = re.compile(r"(?:\s*(?:\[[\d,\s–\-;]+\]|\([A-Z][^()]{0,80}?\d{4}[a-z]?\)|\(\d{4}[a-z]?\)))+$")
ABBREVIATION_END_RE = re.compile(r"(?:\bet al|\be\.g|\bi\.e|\bcf|\bvs|\bFig|\bEq|\bNo|\bSec|\bTab|\bref)\.$", re.IGNORECASE)
FLOAT_KINDS = {"figure", "table", "caption", "equation", "footnote", "furniture"}
CAPTION_LIKE_RE = re.compile(r"^(?:(?:Extended\s+Data\s+)?(?:Figure|Fig\.?)|Table|Listing|Algorithm|Program|Example|Box)\s*\d+[A-Za-z]?\b", re.IGNORECASE)
SUBCAPTION_RE = re.compile(r"^\(?[a-z]\)\s*\S", re.IGNORECASE)
TRAILING_MARKER_RE = re.compile(r"(?:(?<!\d)\.|[!?:;\"”’)\]])\s?(?:\d{1,3}|[*†‡§¶]{1,3})$")
LOWER_START_RE = re.compile(r"^[a-zß-ÿ]")
# the layout model spaces out mathematics: `κ = 0 . 946` is a decimal, not a full
# stop and a note marker, and `Q Y ( j )` closes a bracket in a formula, not a
# sentence — a paragraph ending that way is still open; `( Fig.2 )`, a spaced
# bracket around a word, is prose and still ends the sentence
SPACED_MATH_TAIL_RE = re.compile(r"(?:\d\s\.\s\d{1,3}|\(\s(?![^()]*[A-Za-z]{3,})[^()]*\S\s\))$")
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
# `a A complex neural network …`: a table's lettered (or symbol, or numbered) note
TABLE_NOTE_LEAD_RE = re.compile(r"^\s*(?:[a-z]|\d{1,2}|[*∗⋆★✱†‡§¶‖]{1,3})\s+[A-Z]")
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
WORD_RE_ADAPTER = re.compile(r"[A-Za-z\u00c0-\u024f]{2,}")
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
JOURNAL_LINE_RE = re.compile(r"\b(?:vol\.?|volume|issue|journal|proceedings|conference|workshop|preprint|arxiv|issn|isbn|doi|©|pp\.|published|under review|accepted)\b", re.IGNORECASE)
PROSE_LIKE_RE = re.compile(r"[a-z]{3,}[.!?]\s+[A-Z]|[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}")
# `Figure 15 shows …` / `Table 22 shows …` are sentences, not captions: the
# word after the label must be capitalised
# the label may be chapter-numbered (`Fig. 2.3`); the separator dot is never a digit's
FIGURE_CAPTION_RE = re.compile(r"^((?:Extended\s+Data\s+)?(?:Figure|Fig\.?))\s*(\d+(?:\.\d+)*)(?!\d)\s*(?:\.(?!\d)|[:|\-–—]|(?=\s+(?-i:[A-Z])))", re.IGNORECASE)
TABLE_CAPTION_RE = re.compile(r"^(Table)\s*(\d+(?:\.\d+)*)(?!\d)\s*(?:\.(?!\d)|[:|\-–—]|(?=\s+(?-i:[A-Z])))", re.IGNORECASE)
EMBEDDED_CAPTION_RE = re.compile(r"(?<![A-Za-z])((?:Extended\s+Data\s+)?(?:Figure|Fig\.))\s*(\d+(?:\.\d+)*)(?!\d)\s*(?:\.(?!\d)|[:|\-–—]|(?=\s+(?-i:[A-Z])))", re.IGNORECASE)


def sanitize(value: str) -> str:
    return XML_ILLEGAL_RE.sub("", value or "").replace("­", "")


def is_terminated(text: str) -> bool:
    """Whether a paragraph ends a sentence: terminal punctuation after any
    trailing citation brackets, or a trailing note marker. A parenthesis
    opened in the last words and never closed keeps the sentence open, and
    so does a spaced-out formula tail (`0 . 946`, `Q Y ( j )`)."""
    stripped = text.rstrip()
    if SPACED_MATH_TAIL_RE.search(stripped):
        return False
    if TRAILING_MARKER_RE.search(stripped):
        return True
    tail = stripped[-60:]
    if tail.count("(") > tail.count(")") and re.search(r"\([^()]*$", tail):
        return False
    core = CITATION_TAIL_RE.sub("", stripped).rstrip()
    if core != stripped and core and (not TERMINAL_RE.search(core) or ABBREVIATION_END_RE.search(core)):
        return False
    return bool(TERMINAL_RE.search(stripped))


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


CAPTION_NOISE_RE = re.compile(r"^\s*(?:(?:\d{1,3}|[ivx]{1,5})\s+)+(?=(?:(?:Extended\s+Data\s+)?(?:Figure|Fig\.?)|Table)\s*\d)", re.IGNORECASE)


def clean_caption(text: str) -> str:
    """Drop stray page-number or axis tokens glued in front of `Figure N`, and
    figure-internal labels (`Continuous warping Modality segmentation Fig. 10.`)
    the layout model merged into the caption item: the caption starts at the
    first `Figure N` when nothing before it reads as a sentence."""
    cleaned = CAPTION_NOISE_RE.sub("", text, count=1).strip()
    if not FIGURE_CAPTION_RE.match(cleaned):
        embedded = EMBEDDED_CAPTION_RE.search(cleaned)
        if embedded and 0 < embedded.start() <= 80 and not re.search(r"[.!?:;]", cleaned[: embedded.start()]):
            cleaned = cleaned[embedded.start() :].strip()
    return cleaned


def canonical_figure_label(value: str | re.Match) -> str | None:
    """Canonical identity retaining the source's main/extended-data namespace."""
    match = FIGURE_CAPTION_RE.match(clean_caption(value)) if isinstance(value, str) else value
    if match is None:
        return None
    namespace = "Extended Data Figure" if re.match(r"Extended\s+Data", match.group(1), re.IGNORECASE) else "Figure"
    return f"{namespace} {match.group(2)}"


def footnote_parts(text: str) -> tuple[str | None, str]:
    match = FOOTNOTE_MARKER_RE.match(text)
    if not match:
        return None, text.strip()
    return normalize_marker(match.group(1) or match.group(2)), text[match.end() :].strip()


def loose_pattern(needle: str) -> re.Pattern:
    """`needle` with any whitespace, soft hyphen or zero-width space allowed
    between its characters (line-wrapped URLs, `http://\u200bwww.\u200b…`)."""
    return re.compile(r"[\s\u00ad\u200b]*".join(re.escape(ch) for ch in needle if not ch.isspace() and ch not in "\u00ad\u200b"))


QUOTE_VARIANTS = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})


def link_visible_text(item_text: str, uri: str, visible: str, group_text: str = "") -> str | None:
    """The words of `item_text` an annotation covers: the target itself in
    any of its spellings, else the visible words (of the whole wrapped link
    first), tolerant of a line-end hyphen and of curly quotes."""
    candidates: list[str] = []
    # Symbol fonts expose glyph names to Docling while pdftotext emits a
    # control character. Use the existing semantic token, never a guessed name.
    if not any(ch.isalnum() for ch in visible):
        icon = "envelope" if uri.lower().startswith("mailto:") else "orcid" if re.match(r"https?://orcid\.org/", uri, re.I) else None
        if icon:
            match = re.search(rf"\b{icon}\b", item_text, re.I)
            if match:
                return match.group()
    # Quote style and dash encoding can differ between the two PDF readers.
    punctuation = str.maketrans({"“": "'", "”": "'", "‘": "'", "’": "'", '"': "'", "–": "-", "−": "-"})
    for text in (group_text, visible):
        text = (text or "").strip().rstrip(".,;")
        if not text:
            continue
        candidates.append(text)
        dewrapped = re.sub(r"-\s+", "", text)  # `init/con- trol` wrapped at a hyphen
        candidates.append(dewrapped)
        for variant in (text, dewrapped):
            if variant.endswith("-"):
                candidates.append(variant[:-1])
            candidates.append(variant.translate(QUOTE_VARIANTS))
            # the extractor may map the quote glyphs to other characters: match the words alone
            bare = variant.strip("\"'“”‘’«»").rstrip(".,;:")
            if bare and bare != variant:
                candidates.append(bare)
                if bare.endswith("-"):
                    candidates.append(bare[:-1])
    # the target's own spellings come last: `www.x.org/` (the canonical form of a
    # bare host) would otherwise land on a later `www.x.org/en` in the same text
    target_candidates = [uri, uri.rstrip("/"), re.sub(r"^https?://", "", uri), re.sub(r"^https?://", "", uri).rstrip("/"), re.sub(r"^https?://(www\.)?", "", uri).rstrip("/")]
    # Preserve the annotation's visible phrase before trying the target's
    # spelling, including when only punctuation normalization can match it.
    for group in (candidates, target_candidates):
        for normalized in (False, True):
            haystack = item_text.translate(punctuation) if normalized else item_text
            for candidate in group:
                if not candidate or len(candidate) < 3 or (len(candidate) < 4 and not candidate[0].isupper()):
                    continue
                needle = candidate.translate(punctuation) if normalized else candidate
                match = loose_pattern(needle).search(haystack)
                if match and match.end() > match.start():
                    return item_text[match.start() : match.end()]
    return None


def first_free_span(visible: str, text: str, taken: list[tuple[int, int]]) -> tuple[int, int] | None:
    """The first occurrence of `visible` in `text` that overlaps none of the
    spans already claimed (two `here` links in one paragraph)."""
    if not visible:
        return None
    for match in loose_pattern(visible).finditer(text):
        start, end = match.span()
        if end <= start:
            continue
        if any(not (end <= s or start >= e) for s, e in taken):
            continue
        return start, end
    return None


def marker_candidates(marker: str, text: str) -> list[tuple[int, int, bool]]:
    """(start, end, strong) occurrences of a footnote marker in plain text."""
    results = []
    text = normalize_marker(text)  # `∗` in the body is the `*` of the note; offsets are preserved
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
            if prev_char in ".,;:)]}\"”’'" and not reference_word:
                results.append((start, match.end(2), True))
            elif prev_word and not reference_word and prev_char.isalpha():
                results.append((start, match.end(2), False))
            elif prev_word and not marker.isdigit() and not prev_char.isspace():
                results.append((start, match.end(2), False))
        elif prev_char.isalpha() or prev_char in ")]}\"”’'" or (not marker.isdigit() and not prev_char.isspace()):
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
    joins_attested_over_nearer: int = 0
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
    internal_link_coverage: dict = field(default_factory=dict)
    source_provenance: list[dict] = field(default_factory=list)
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
    caption_continuations_joined: int = 0
    list_item_continuations_joined: int = 0
    numeric_fragments_dropped: int = 0
    tables_relabelled_figure: int = 0
    tables_single_cell_text: int = 0
    notes_without_reference: int = 0
    regions_recovered_from_text_layer: int = 0
    captions_rescued_from_furniture: int = 0
    prose_rescued_from_furniture: int = 0
    lines_restored_from_text_layer: int = 0
    captions_split_from_merged_items: int = 0
    stray_leads_split: int = 0
    side_column_tails_split: int = 0
    table_notes_split: int = 0
    caption_cross_references_kept: int = 0
    figure_foot_lines_absorbed: int = 0
    captions_adopted_across_pages: int = 0
    tables_from_open_rule_box: int = 0
    description_items: int = 0
    tables_as_entry_lists: int = 0
    glued_tails_stripped: int = 0
    glued_heads_stripped: int = 0
    caption_sides_fixed: int = 0
    notes_linked_in_cells: int = 0
    tables_from_rule_box: int = 0
    figures_from_rule_box: int = 0
    figures_from_panel_band: int = 0
    panels_folded_by_geometry: int = 0
    glyph_signals_available: bool = False
    warnings: list[str] = field(default_factory=list)


def _line_words_present(line: str, compact_block: str) -> bool:
    """Whether a text-layer line's words are already in a block: the block
    holds at least two thirds of the line's words of three or more letters
    (three words at least). A line of mathematics reads `E µ [Σ t ]` in the
    text layer and `E µ [Σ K t ]` from the layout model, so a character
    comparison sees a missing line where the words say otherwise."""
    words = [w.lower() for w in re.findall(r"[A-Za-z]{3,}", line)]
    if len(words) < 3:
        return False
    present = sum(1 for w in words if w in compact_block)
    return present * 3 >= len(words) * 2


class StructAdapter:
    def __init__(self, doc: DoclingDocument, pdf_path: Path, source_sha256: str, links: list[SourceLink], word_boxes: list | None = None, page_lines: list | None = None, source_text: SourceText | None = None, page_layout: list | None = None, source_raster=None) -> None:
        doc, self._original_source_ids = normalize_provenance(doc)
        normalize_sideways_captions(doc)
        self.doc = doc
        self.source_raster = source_raster
        self.word_boxes = word_boxes or []
        self.page_lines = page_lines or []
        self.page_layout = page_layout or []
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
        self._corpus_forms: set[str] | None = None
        self._captions_below_tables: list[bool] = []
        self._figure_caption_below: list[bool] = []
        self._attached_caption_boxes: dict[str, dict] = {}
        self._furniture_keys: dict[str, set[int]] | None = None
        self._has_title_item = any(isinstance(item, TitleItem) for item, _ in doc.iterate_items())
        from source_tables import reconcile_table_captions
        reconcile_table_captions(self)
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

    def _box(self, item, index: int = 0) -> dict | None:
        prov = getattr(item, "prov", None)
        if not prov or index >= len(prov):
            return None
        page = prov[index].page_no
        if page is None or page not in self.doc.pages:
            return None
        bbox = prov[index].bbox
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

    def _boxes(self, item) -> list[dict]:
        """One normalized box per provenance entry (a paragraph that runs over
        a column or page break has several)."""
        boxes = []
        for index in range(len(getattr(item, "prov", None) or [])):
            box = self._box(item, index)
            if box is not None:
                boxes.append(box)
        return boxes

    def _evidence(self, item, confidence: float = 1.0) -> dict:
        page = self._page_of(item)
        boxes = self._boxes(item)
        source_ref = getattr(self, "_original_source_ids", {}).get(getattr(item, "self_ref", ""))
        source_id = source_ref.lstrip("#/").replace("/", "-") if source_ref else self._source_id(item)
        return {
            "confidence": confidence,
            "pages": sorted({b["page"] for b in boxes}) if boxes else ([page] if page is not None else []),
            "boxes": boxes,
            "sourceIds": [source_id],
            "signals": ["docling-layout"],
        }

    @staticmethod
    def _source_id(item) -> str:
        return getattr(item, "self_ref", "unknown").lstrip("#/").replace("/", "-")

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
            label = "ORCID" if re.match(r"https?://orcid\.org/", uri, re.I) else "email" if uri.lower().startswith("mailto:") else None
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
                                 and not re.sub(r"\b(?:ORCID|email|envelope)\b|\s", "", block["text"][position:run["start"]], flags=re.I)
                                 and block["text"][run["start"]:run["end"]].lower() in ("orcid", "email", "envelope")), None)
                if existing is not None:
                    claimed.add(id(existing))
                    processed.add(identity)
                    break
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

    def _furniture_text_is_prose(self, item: TextItem) -> bool:
        """A furniture-layer text that occurs on one page only, reads as prose
        (six or more words, no journal or licence wording), and is not a
        running line is a paragraph the layout model filed as a footer."""
        text = sanitize(item.text).strip()
        words = text.split()
        if len(words) < 6 or len(text) > 400 or PARATEXT_NOTE_RE.match(text) or PARATEXT_NOTE_ANY_RE.search(text) or JOURNAL_LINE_RE.search(text):
            return False
        key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
        if self._furniture_keys is None:
            counter: dict[str, set[int]] = {}
            for other, _ in self.doc.iterate_items(included_content_layers={ContentLayer.FURNITURE}):
                if isinstance(other, TextItem) and other.prov:
                    other_key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", sanitize(other.text).strip().lower()))
                    counter.setdefault(other_key, set()).add(other.prov[0].page_no)
            self._furniture_keys = counter
        return len(self._furniture_keys.get(key, set())) <= 1

    def _rescue_prose_from_furniture(self, item: TextItem) -> None:
        text = sanitize(item.text).strip()
        block = self._new_block("paragraph", item, text)
        block["inline"] = self._runs_for(item, text)
        block["evidence"]["signals"].append("rescued-from-furniture-layer")
        box = self._box(item)
        position = len(self.blocks)
        if box is not None:
            for i, existing in enumerate(self.blocks):
                if existing["page"] != box["page"] or not existing["evidence"]["boxes"]:
                    continue
                ebox = existing["evidence"]["boxes"][0]
                if ebox["y"] >= box["y"] and min(ebox["x"] + ebox["width"], box["x"] + box["width"]) - max(ebox["x"], box["x"]) > 0:
                    position = i
                    break
            else:
                position = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > box["page"]), len(self.blocks))
        self.blocks.insert(position, block)
        self.report.paragraphs += 1
        self.report.prose_rescued_from_furniture += 1

    def _rescue_caption_from_furniture(self, item: TextItem) -> bool:
        """A `Table N` / `Figure N` caption the layout model filed as page
        furniture is a caption: it goes back into the flow where its geometry
        puts it (before the first block below it on its page)."""
        text = sanitize(item.text).strip()
        if not (FIGURE_CAPTION_RE.match(text) or TABLE_CAPTION_RE.match(text)) or len(text) > 1200:
            return False
        self._flush()
        block = self._new_block("caption", item, text)
        block["inline"] = self._runs_for(item, text)
        box = self._box(item)
        position = len(self.blocks)
        if box is not None:
            for i, existing in enumerate(self.blocks):
                if existing["page"] != box["page"] or not existing["evidence"]["boxes"]:
                    continue
                ebox = existing["evidence"]["boxes"][0]
                if ebox["y"] >= box["y"] and min(ebox["x"] + ebox["width"], box["x"] + box["width"]) - max(ebox["x"], box["x"]) > 0:
                    position = i
                    break
            else:
                position = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > box["page"]), len(self.blocks))
        self.blocks.insert(position, block)
        self.report.orphan_captions += 1
        self.report.captions_rescued_from_furniture += 1
        return True

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
                if (not notation_cue or not note_sizes or not body_sizes or not re.match(r"[A-Z]", sanitize(text).lstrip())
                    or note_sizes[len(note_sizes) // 2] >= 0.85 * body_sizes[len(body_sizes) // 2]):
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

    def _caption_links(self, item, caption: str) -> list[dict]:
        """The hyperlinks of a float's attached caption (`Data source:
        https://www.swebench.com/`), located in the caption text it renders."""
        runs: list[dict] = []
        for ref in getattr(item, "captions", []):
            caption_item = ref.resolve(self.doc)
            if isinstance(caption_item, TextItem) and caption:
                runs += [run for run in self._runs_for(caption_item, caption) if run.get("href") and run not in runs]
        return runs

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
        label_match = re.match(r"^Table\s*(\d+(?:\.\d+)*)", caption or "", re.IGNORECASE)
        if label_match:
            block["label"] = f"Table {label_match.group(1)}"
        usable = bool(grid) and any(cell.text.strip() for row in grid for cell in row)
        if usable:
            rows = len(grid)
            columns = max(len(row) for row in grid)
            filled = sum(1 for row in grid for cell in row if cell.text.strip())
            single_text_box = rows * columns == 1 and (PROSE_LIKE_RE.search(grid[0][0].text) or len(grid[0][0].text) > 80)
            if single_text_box:
                # a one-cell table holding prose is a boxed text (a prompt, an
                # example); the text is the structure a reader wants
                self.report.tables_single_cell_text += 1
            elif rows * columns < 1:
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
            region = sanitize(page_text.region_text(box))
            if region and len(region) >= 0.5 * len(text):
                text = region
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
                text = sanitize(item.text)
                embedded = EMBEDDED_CAPTION_RE.search(text) if not FIGURE_CAPTION_RE.match(text.strip()) else None
                if embedded and embedded.start() > 0 and not text[embedded.end() :].strip():
                    # `… The families are drawn in Figure 3.`: a `Figure N`
                    # that closes the caption's last sentence with nothing
                    # after it is a cross-reference, not a second caption
                    embedded = None
                    self.report.caption_cross_references_kept += 1
                if embedded and embedded.start() > 0:
                    # the layout model glued the artwork's own text (a code
                    # listing inside the figure) to the caption: the head stays
                    # beside the figure as its text, the caption starts at `Figure N`
                    head = self._new_block("paragraph", item, text[: embedded.start()].strip())
                    head["evidence"]["signals"].append("caption-head")
                    self.blocks.append(head)
                    self.report.paragraphs += 1
                    text = text[embedded.start() :].strip()
                self.report.orphan_captions += 1
                block = self._new_block("caption", item, text)
                block["inline"] = self._runs_for(item, block["text"])
                self.blocks.append(block)
            elif label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
                if not self._rescue_caption_from_furniture(item):
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

    def _strip_glued_heads(self) -> None:
        """The mirror of `_strip_glued_tails`: the layout model sometimes puts a
        margin stamp — usually a page or line number sitting alone at the page
        edge — in front of a paragraph's first line, and the number is then read
        as part of the sentence ("63 lower revenue bound, this algorithm ...").

        Decided by geometry, never by wording: the paragraph must own a separate
        provenance box that is tiny, in an edge band, and nowhere near the box
        that carries the prose, and the text must open with a bare number. The
        number and that box are cut; nothing else about the paragraph changes.
        """
        for block in self.blocks:
            if block["kind"] != "paragraph" or len(block["text"]) < 60:
                continue
            boxes = block["evidence"]["boxes"]
            if len(boxes) < 2:
                continue
            head, body = boxes[0], boxes[1]
            if head["page"] != body["page"]:
                continue
            if head["width"] >= 0.05 or head["height"] >= 0.03:
                continue  # a real line of text, not a stamp
            in_edge_band = (
                head["x"] < 0.12
                or head["x"] + head["width"] > 0.88
                or head["y"] < 0.09
                or head["y"] + head["height"] > 0.91
            )
            if not in_edge_band:
                continue
            if abs(head["y"] - body["y"]) <= 0.05 and abs(head["x"] - body["x"]) <= 0.2:
                continue  # adjacent to the prose: a drop cap or an equation number, not furniture
            match = re.match(r"^(\d{1,4})\s+(?=\S)", block["text"])
            if not match:
                continue
            cut = match.end()
            block["text"] = block["text"][cut:]
            block["inline"] = [
                {**run, "start": max(run["start"] - cut, 0), "end": run["end"] - cut}
                for run in block["inline"]
                if run["end"] > cut
            ]
            block["evidence"]["boxes"] = boxes[1:]
            self.report.glued_heads_stripped += 1

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
            if not text or len(text) > 160 or CAPTION_LIKE_RE.match(text):
                continue  # `Figure 17: …` repeated on four pages is four captions, not a running head
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

    def _lines_in(self, page: int, x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float, str]]:
        """Source text lines inside a region as (top, bottom, text), from the
        word boxes grouped by baseline."""
        if page - 1 >= len(self.word_boxes) or page not in self.doc.pages:
            return []
        size = self.doc.pages[page].size
        if not size.width or not size.height:
            return []
        words = []
        for wx0, wy0, wx1, wy1, text in self.word_boxes[page - 1]:
            cx, cy = (wx0 + wx1) / 2 / size.width, (wy0 + wy1) / 2 / size.height
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                words.append((wy0 / size.height, wy1 / size.height, wx0 / size.width, text))
        words.sort(key=lambda w: (round((w[0] + w[1]) / 2, 3), w[2]))
        lines: list[list] = []
        for top, bottom, x, text in words:
            if lines and abs((top + bottom) / 2 - (lines[-1][0] + lines[-1][1]) / 2) <= 0.4 * max(bottom - top, 0.004):
                lines[-1][0] = min(lines[-1][0], top)
                lines[-1][1] = max(lines[-1][1], bottom)
                lines[-1][2].append((x, text))
            else:
                lines.append([top, bottom, [(x, text)]])
        return [(top, bottom, " ".join(t for _, t in sorted(parts))) for top, bottom, parts in lines]

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

    def _complete_short_captions(self) -> None:
        """An orphan caption that is only its label (`Fig. 7.`) lost the rest
        of its words to neighbouring blocks (`ARM-CL`, `… runtime
        illustration: …` glued to a diagram letter). The caption's lines in
        the text layer, read from the label down while the line spacing holds,
        give the whole caption; the blocks whose words it holds are absorbed."""
        for block in list(self.blocks):
            if block["kind"] not in ("caption", "paragraph") or block["page"] is None or not block["evidence"]["boxes"]:
                continue
            match = FIGURE_CAPTION_RE.match(block["text"])
            if not match or len(block["text"].strip()) > len(match.group(0)) + 12:
                continue
            if any(f["kind"] == "figure" and f.get("label") == canonical_figure_label(match) for f in self.blocks):
                continue
            page, cbox = block["page"], block["evidence"]["boxes"][0]
            # the caption's column: the widest body block starting at its left edge
            widths = [b["evidence"]["boxes"][0]["width"] for b in self.blocks
                      if b["page"] == page and b["kind"] == "paragraph" and b["evidence"]["boxes"] and abs(b["evidence"]["boxes"][0]["x"] - cbox["x"]) <= 0.02]
            x1 = min(1.0, cbox["x"] + max(widths + [0.3]) + 0.005)
            lines = [line for line in self._lines_in(page, cbox["x"] - 0.005, cbox["y"] - 0.003, x1, cbox["y"] + 0.12) if line[1] > cbox["y"]]
            if not lines or not lines[0][2].startswith(match.group(0).strip().split()[0]):
                continue
            kept = [lines[0]]
            for line in lines[1:]:
                previous = kept[-1]
                if line[0] - previous[1] > 0.8 * (previous[1] - previous[0]):
                    break
                kept.append(line)
            text = sanitize(" ".join(line[2] for line in kept))
            if len(text) <= len(block["text"]) or not FIGURE_CAPTION_RE.match(text):
                continue
            top, bottom = kept[0][0], kept[-1][1]
            compact = re.sub(r"\W", "", text).casefold()
            absorbed = []
            for other in self.blocks:
                if other is block or other["page"] != page or other["kind"] not in ("paragraph", "caption", "heading") or not other["evidence"]["boxes"]:
                    continue
                if not any(obox["page"] == page and obox["y"] + obox["height"] >= top and obox["y"] <= bottom and obox["x"] <= x1 and obox["x"] + obox["width"] >= cbox["x"] - 0.005
                           for obox in other["evidence"]["boxes"]):
                    continue
                words = re.sub(r"\W", "", other["text"]).casefold()
                # a diagram letter the layout model glued in front may precede the words
                if len(words) >= 3 and any(words[cut:] and words[cut:] in compact for cut in (0, 1, 2)):
                    absorbed.append(other)
            block["text"] = text
            block["inline"] = []
            block["evidence"]["boxes"] = [{"page": page, "x": cbox["x"], "y": round(top, 5), "width": round(x1 - cbox["x"], 5), "height": round(bottom - top, 5), "rotation": 0}]
            block["evidence"]["sourceIds"] = list(dict.fromkeys(block["evidence"]["sourceIds"] + [sid for other in absorbed for sid in other["evidence"]["sourceIds"]]))
            block["evidence"].setdefault("signals", []).append("caption-completed-from-source")
            for other in absorbed:
                self._absorb_block(other)

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
                # its own lists: caption boxes later added to the block are not the crop's
                "evidence": {**evidence, "boxes": [dict(box) for box in evidence.get("boxes", [])], "pages": list(evidence.get("pages", [])), "signals": list(evidence.get("signals", [])), "sourceIds": list(source_ids)},
                "fallback": "source-region",
            }
        )
        return asset_id

    def _page_image(self, page: int | None):
        source_raster = getattr(self, "source_raster", None)
        if page is None:
            return None
        if source_raster is None:
            raise SourceRasterError("source raster is required for a recovery crop")
        # Recovery crops must use the original PDF. SourceRaster errors
        # propagate so a masked Docling image can never be substituted.
        return source_raster.page_image(page)

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

    def _in_furniture_band(self, box: dict) -> bool:
        """Whether furniture on at least two other pages sits at this height."""
        pages = set()
        for other in self.blocks:
            if other["kind"] != "furniture" or not other["evidence"]["boxes"]:
                continue
            obox = other["evidence"]["boxes"][0]
            if abs(obox["y"] - box["y"]) <= 0.015 and obox["page"] != box["page"]:
                pages.add(obox["page"])
        return len(pages) >= 2

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
            if not text or len(text) > 120 or CAPTION_LIKE_RE.match(text):
                continue
            box = block["evidence"]["boxes"][0]
            if not (box["y"] <= 0.12 or box["y"] + box["height"] >= 0.88):
                continue
            if not (box["y"] <= 0.075 or box["y"] + box["height"] >= 0.925) and not self._in_furniture_band(box):
                continue  # a bold lead-in at the foot of a page is prose, not a running head
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


    # ------------------------------------------------------------ rule boxes
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

    def _pixel_rows(self, page: int, x0: float, x1: float):
        """Per-row ink and background fractions of a column strip of the page
        image: (dark_fraction, nonwhite_fraction, image_height)."""
        image = self._page_image(page)
        if image is None:
            return None
        try:
            import numpy as np
        except ImportError:  # pragma: no cover
            return None
        width, height = image.size
        px0, px1 = max(0, int(x0 * width)), min(width, int(x1 * width))
        if px1 - px0 < 20:
            return None
        strip = np.asarray(image.convert("L"))[:, px0:px1]
        # a frame edge is a thin line of any grey (anti-aliased at 2x); a shaded
        # box is a run of rows tinted just off white
        dark = (strip < 236).mean(axis=1)
        nonwhite = (strip < 250).mean(axis=1)
        return dark, nonwhite, height

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
            # more than three x-clusters are a box of prose and formula
            # fragments, not columns: one column, one row per block in reading order.
            if row_bands and (max(map(len, row_bands)) == 1 or len(anchors) > 3):
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

    # ------------------------------------------------------------ panel bands
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
            if TICK_LABEL_RE.match(text):
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
            rows = self._pixel_rows(page, x0, x1)
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
                if block["kind"] != "figure" or not FIGURE_CAPTION_RE.match(block["text"]) or not block["evidence"]["boxes"] or block["page"] is None:
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
                        if "figure-linked-label" in candidate["evidence"].get("signals", []):
                            continue
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

    # ------------------------------------------------------------ dropped regions
    def _absorb_inline_prose_fragments(self, block: dict) -> None:
        """Transfer separately extracted source runs back into a repaired
        paragraph, retaining any donor text outside its source region.
        Original IDs identify provenance, not a unique normalized item."""
        if not getattr(self, "doc", None):
            return

        def contained(boxes, regions):
            return bool(boxes) and all(any(
                box["page"] == region["page"] and box["x"] >= region["x"] - 0.004
                and box["y"] >= region["y"] - 0.004
                and box["x"] + box["width"] <= region["x"] + region["width"] + 0.004
                and box["y"] + box["height"] <= region["y"] + region["height"] + 0.004
                for region in regions) for box in boxes)

        regions = list(block["evidence"]["boxes"])
        positions = [i for i, c in enumerate(block["text"]) if c.isascii() and c.isalnum()]
        compact = "".join(block["text"][i].lower() for i in positions)
        sources = {}
        for item, _ in self.doc.iterate_items():
            if not isinstance(item, TextItem):
                continue
            canonical = self._evidence(item)["sourceIds"][0]
            for sid in dict.fromkeys([canonical, self._source_id(item)]):
                sources.setdefault(sid, []).append(item)
        for donor in list(self.blocks):
            if donor is block or donor["kind"] not in ("paragraph", "heading"):
                continue
            donor_compact = re.sub(r"[^a-z0-9]", "", donor["text"].lower())
            entries = []
            unresolved = False
            for sid in donor["evidence"]["sourceIds"]:
                matches = [item for item in sources.get(sid, [])
                           if contained(self._boxes(item), donor["evidence"]["boxes"])
                           and re.sub(r"[^a-z0-9]", "", item.text.lower()) in donor_compact]
                if not matches:
                    unresolved = True
                    break
                entries.extend((sid, item) for item in matches)
            if unresolved:
                continue
            consumed = set()
            for sid, item in entries:
                boxes = self._boxes(item)
                if not contained(boxes, regions):
                    continue
                needle = re.sub(r"[^a-z0-9]", "", item.text.lower())
                literal = sanitize(item.text).strip()
                direct = block["text"].find(literal) if literal else -1
                if direct >= 0 and block["text"].find(literal, direct + 1) < 0:
                    start, end = direct, direct + len(literal)
                else:
                    offset = compact.find(needle) if needle else -1
                    if offset < 0 or compact.find(needle, offset + 1) >= 0:
                        continue
                    start, end = positions[offset], positions[offset + len(needle) - 1] + 1
                part = block["text"][start:end]
                for run in self._runs_for(item, part):
                    shifted = {**run, "start": run["start"] + start, "end": run["end"] + start}
                    if shifted not in block["inline"]:
                        block["inline"].append(shifted)
                canonical = self._evidence(item)["sourceIds"][0]
                if canonical not in block["evidence"]["sourceIds"]:
                    block["evidence"]["sourceIds"].append(canonical)
                block["evidence"]["boxes"].extend(box for box in boxes if box not in block["evidence"]["boxes"])
                block["evidence"]["pages"] = sorted(set(block["evidence"]["pages"] + [box["page"] for box in boxes]))
                block["evidence"]["signals"] = list(dict.fromkeys(block["evidence"].get("signals", []) + donor["evidence"].get("signals", []) + ["inline-source-fragments-integrated"]))
                consumed.add((sid, item.self_ref))
            if not consumed:
                continue
            remaining = [(sid, item) for sid, item in entries if (sid, item.self_ref) not in consumed]
            if not remaining:
                for relationship in self.relationships:
                    if relationship["from"] == donor["id"]:
                        relationship["from"] = block["id"]
                    relationship["to"] = [block["id"] if target == donor["id"] else target for target in relationship["to"]]
                self.blocks.remove(donor)
                if donor["kind"] == "paragraph":
                    self.report.paragraphs -= 1
                continue
            donor["text"], donor["inline"] = "", []
            donor["evidence"]["sourceIds"] = list(dict.fromkeys(self._evidence(item)["sourceIds"][0] for _, item in remaining))
            donor["evidence"]["boxes"] = []
            for sid, item in remaining:
                text = sanitize(item.text).strip()
                base = len(donor["text"]) + (1 if donor["text"] else 0)
                donor["text"] += (" " if donor["text"] else "") + text
                donor["inline"].extend({**run, "start": run["start"] + base, "end": run["end"] + base} for run in self._runs_for(item, text))
                donor["evidence"]["boxes"].extend(self._boxes(item))
            donor["evidence"]["pages"] = sorted({box["page"] for box in donor["evidence"]["boxes"]})
            donor["page"] = donor["evidence"]["pages"][0] if donor["evidence"]["pages"] else None
            if donor["kind"] != "heading" and TOP_LEVEL_HEADING_RE.fullmatch(donor["text"]):
                donor["kind"] = "heading"
                donor["attributes"] = {"level": 2}
                self.report.paragraphs -= 1
                self.report.headings += 1

    def _restore_missing_lines(self) -> None:
        """A text-layer line inside a paragraph's own box whose words the
        layout model did not carry (an italic title, a URL line) goes back
        into the paragraph after the line above it."""
        if not self.page_layout:
            return
        for block in list(self.blocks):
            if block["kind"] not in ("paragraph", "list-item") or block["page"] is None or not block["evidence"]["boxes"] or "text-layer-fallback" in (block["evidence"].get("signals") or []):
                continue
            box = block["evidence"]["boxes"][0]
            page_index = box["page"]
            if page_index - 1 >= len(self.page_layout):
                continue
            layout = self.page_layout[page_index - 1]
            width, height = layout.get("width") or 0, layout.get("height") or 0
            if not width or not height:
                continue
            compact_block = re.sub(r"[^a-z0-9]", "", block["text"].lower())
            page_compacts = [re.sub(r"[^a-z0-9]", "", other["text"].lower()) for other in self.blocks if other is not block and other["page"] == page_index and other["text"]]
            equation_boxes = [region for other in self.blocks if other["kind"] == "equation"
                              for region in other["evidence"]["boxes"] if region["page"] == page_index]
            lines = []
            for line in layout["lines"]:
                # Display-owned source remains in its equation block. A broad
                # paragraph box can surround that display without owning it.
                if any(min(line["xmax"] / width, region["x"] + region["width"]) > max(line["xmin"] / width, region["x"])
                       and min(line["ymax"] / height, region["y"] + region["height"]) > max(line["ymin"] / height, region["y"])
                       for region in equation_boxes):
                    continue
                cx, cy = (line["xmin"] + line["xmax"]) / 2 / width, (line["ymin"] + line["ymax"]) / 2 / height
                if box["x"] - 0.004 <= cx <= box["x"] + box["width"] + 0.004 and box["y"] - 0.004 <= cy <= box["y"] + box["height"] + 0.004:
                    lines.append(line)
            if not lines:
                continue
            lines.sort(key=lambda l: (l["ymin"], l["xmin"]))
            # A suspended compound's hyphen is semantic punctuation, even
            # though alphanumeric coverage treats `intraand` and `intra- and`
            # as identical. Restore only an exact source-line-attested phrase.
            for line in lines:
                source_line = sanitize(line["text"].strip())
                compact_line = re.sub(r"[^a-z0-9]", "", source_line.lower())
                if len(compact_line) < 12 or compact_line not in compact_block:
                    continue
                for compound in re.finditer(r"\b([A-Za-z]{2,})-\s+(and|or)\b", source_line):
                    first, conjunction = compound.groups()
                    pattern = r"(?<![A-Za-z])" + re.escape(first) + r"\s*" + conjunction + r"(?![A-Za-z])"
                    matches = list(re.finditer(pattern, block["text"]))
                    if len(matches) != 1:
                        continue
                    match = matches[0]
                    replacement = first + "- " + conjunction
                    delta = len(replacement) - (match.end() - match.start())
                    block["text"] = block["text"][:match.start()] + replacement + block["text"][match.end():]
                    for run in block["inline"]:
                        if run["start"] >= match.end():
                            run["start"] += delta
                            run["end"] += delta
                        elif run["end"] >= match.end():
                            run["end"] += delta
                    block["evidence"].setdefault("signals", []).append("source-suspended-compound-restored")
            if len(block["evidence"]["boxes"]) != 1:
                continue  # missing-line insertion needs an unambiguous single region
            # Whole-line containment cannot detect a missing clause on an
            # otherwise present line. Recover interior omissions only when the
            # entire emitted alphanumeric stream is an exact subsequence of
            # this one source region; reordered mathematics fails this check.
            from difflib import SequenceMatcher

            def indexed_compact(value):
                positions = [i for i, char in enumerate(value) if char.isascii() and char.isalnum()]
                return "".join(value[i].lower() for i in positions), positions

            source_lines = [sanitize(line["text"].strip()) for line in lines]
            page_text = self._page_text(page_index) if getattr(self, "source_text", None) else None
            if page_text:
                glyph_lines = [line.text for line in page_text.lines_in(box)]
                for position, source_line in enumerate(source_lines):
                    if not re.search(r"\b[A-Z] [A-Z]{2,}", source_line):
                        continue
                    compact_line, _ = indexed_compact(source_line)
                    for glyph_line in glyph_lines:
                        glyph_compact, glyph_positions = indexed_compact(glyph_line)
                        offset = glyph_compact.find(compact_line)
                        if offset >= 0:
                            source_lines[position] = glyph_line[glyph_positions[offset]:glyph_positions[offset + len(compact_line) - 1] + 1]
                            break
            source_region = re.sub(r"([A-Za-z])-\n(?=[a-z])", r"\1", "\n".join(source_lines)).replace("\n", " ")
            source_compact, source_positions = indexed_compact(source_region)
            emitted_compact, emitted_positions = indexed_compact(block["text"])
            edits = SequenceMatcher(None, source_compact, emitted_compact, autojunk=False).get_opcodes()
            recovered_clauses = 0
            if all(tag in ("equal", "delete") for tag, *_ in edits):
                for tag, a0, a1, b0, b1 in reversed(edits):
                    if tag != "delete" or a0 < 12 or len(source_compact) - a1 < 12 or a1 - a0 < 8 or b0 == 0 or b0 >= len(emitted_positions):
                        continue
                    start, end = emitted_positions[b0 - 1] + 1, emitted_positions[b0]
                    if block["text"][start:end].strip():
                        continue  # source text cannot silently replace existing punctuation
                    insertion = source_region[source_positions[a0 - 1] + 1:source_positions[a1]]
                    if not re.search(r"[A-Za-z]", insertion):
                        continue
                    block["text"] = block["text"][:start] + insertion + block["text"][end:]
                    delta = len(insertion) - (end - start)
                    for run in block["inline"]:
                        if run["start"] >= end:
                            run["start"] += delta
                            run["end"] += delta
                        elif run["end"] > start:
                            run["end"] += delta
                    recovered_clauses += 1
                if recovered_clauses:
                    self.report.lines_restored_from_text_layer += recovered_clauses
                    block["evidence"].setdefault("signals", []).append("source-inline-omissions-restored")
                    compact_block = re.sub(r"[^a-z0-9]", "", block["text"].lower())
                    self._absorb_inline_prose_fragments(block)
            inserted = 0
            for i, line in enumerate(lines):
                text = sanitize(line["text"].strip())
                compact = re.sub(r"[^a-z0-9]", "", text.lower())
                if len(compact) < 12 or compact[:24] in compact_block or compact[-24:] in compact_block:
                    continue
                if _line_words_present(text, compact_block) or any(_line_words_present(text, other) for other in page_compacts):
                    continue  # a line of mathematics whose symbols the text layer orders differently, already carried here or by a neighbour
                if any(re.sub(r"[^a-z0-9]", "", t.lower()) and re.sub(r"[^a-z0-9]", "", t.lower())[:24] in re.sub(r"[^a-z0-9]", "", other["text"].lower()) for other in self.blocks if other is not block and other["page"] == page_index for t in [text]):
                    continue  # the words live in another block (a caption, a note)
                # anchor: the tail of the line above, located in the block text
                position = len(block["text"])
                if i > 0:
                    anchor_words = re.findall(r"[A-Za-z0-9]+", lines[i - 1]["text"])[-3:]
                    if anchor_words:
                        match = None
                        for m in re.finditer(r"\s*".join(re.escape(w) for w in anchor_words), block["text"]):
                            match = m
                        if match:
                            position = match.end()
                else:
                    position = 0
                head, tail = block["text"][:position], block["text"][position:]
                joiner = "" if not head or head.endswith(" ") else " "
                insertion = joiner + text + ("" if not tail or tail.startswith(" ") else " ")
                block["text"] = head + insertion + tail
                shift = len(insertion)
                for run in block["inline"]:
                    if run["start"] >= position:
                        run["start"] += shift
                        run["end"] += shift
                    elif run["end"] > position:
                        run["end"] += shift
                compact_block = re.sub(r"[^a-z0-9]", "", block["text"].lower())
                inserted += 1
            if inserted:
                block["evidence"]["signals"] = list(dict.fromkeys((block["evidence"].get("signals") or []) + ["text-layer-lines-restored"]))
                self.report.lines_restored_from_text_layer += inserted
                self._diagnostic("info", "text", "Lines restored from the text layer", f"page {page_index}: {inserted} line(s) inside a paragraph's box that the layout model did not carry", None, page_index)

    def _recover_dropped_regions(self) -> None:
        """Text-layer lines the layout model returned no item for (an author
        line, a reference entry, a whole page) come back as paragraphs with
        their own boxes, in the position their geometry dictates. A line is
        recovered only when no layout item box covers it and no item on the
        page already carries its words."""
        if not self.page_layout:
            return
        covered: dict[int, list[tuple[float, float, float, float]]] = {}
        item_texts: dict[int, list[str]] = {}
        for item, _ in self.doc.iterate_items(included_content_layers={ContentLayer.BODY, ContentLayer.FURNITURE}):
            boxes = self._boxes(item)
            if not boxes:
                continue
            text = getattr(item, "text", None)
            compact_text = re.sub(r"[^a-z0-9]", "", text.lower()) if isinstance(text, str) and text.strip() else ""
            for box in boxes:
                covered.setdefault(box["page"], []).append((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
                if compact_text:
                    item_texts.setdefault(box["page"], []).append(compact_text)
        for block in self.blocks:
            if block["kind"] in ("figure", "table", "equation"):
                for box in block["evidence"]["boxes"]:
                    covered.setdefault(box["page"], []).append((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
        edge_counter: dict[str, set[int]] = {}
        for page_index, lines in enumerate(self.page_lines, start=1):
            for line in lines[:6] + lines[-6:]:
                key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", line.strip().lower()))
                if 6 <= len(key) <= 160:
                    edge_counter.setdefault(key, set()).add(page_index)
        running = {key for key, pages in edge_counter.items() if len(pages) >= 3}
        page_links: dict[int, list] = {}
        for link in self.links:
            if link.kind == "uri" and link.uri:
                page_links.setdefault(link.page, []).append(link)
        recovered_pages: set[int] = set()
        for page_index, layout in enumerate(self.page_layout, start=1):
            if page_index not in self.doc.pages or not layout.get("width") or not layout.get("height"):
                continue
            width, height = layout["width"], layout["height"]
            boxes = covered.get(page_index, [])
            texts = item_texts.get(page_index, [])
            page_text_joined = "\u0001".join(texts)
            page_text_joined = page_text_joined if texts else ""
            groups: list[list[dict]] = []
            for line in layout["lines"]:
                text = line["text"].strip()
                x0, y0, x1, y1 = line["xmin"] / width, line["ymin"] / height, line["xmax"] / width, line["ymax"] / height
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                if not text or cy < 0.05 or cy > 0.95:
                    continue
                key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower()))
                if key in running or PAGE_NUMBER_TEXT_RE.match(text):
                    continue
                if any(bx0 - 0.004 <= cx <= bx1 + 0.004 and by0 - 0.004 <= cy <= by1 + 0.004 for bx0, by0, bx1, by1 in boxes):
                    continue
                compact = re.sub(r"[^a-z0-9]", "", text.lower())
                # the words are already carried by a layout item (a line pdftotext
                # merged across two columns, a hyphenation the extractor undid)
                if compact and ((len(compact) >= 20 and (compact[:40] in page_text_joined or compact[-40:] in page_text_joined)) or (len(compact) < 20 and f"\u0001{compact}\u0001" in f"\u0001{page_text_joined}\u0001")):
                    continue
                entry = {"text": text, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
                last = groups[-1][-1] if groups else None
                if last is not None and 0 <= y0 - last["y1"] <= 1.6 * max(last["y1"] - last["y0"], 0.005) and min(x1, last["x1"]) - max(x0, last["x0"]) > 0:
                    groups[-1].append(entry)
                else:
                    groups.append([entry])
            new_blocks: list[tuple[float, float, dict]] = []
            for group in groups:
                text = sanitize(" ".join(entry["text"] for entry in group))
                if len(text) < 20 or len(WORD_RE_ADAPTER.findall(text)) < 3:
                    continue
                gx0, gy0 = min(e["x0"] for e in group), min(e["y0"] for e in group)
                gx1, gy1 = max(e["x1"] for e in group), max(e["y1"] for e in group)
                runs: list[dict] = []
                spans: list[tuple[int, int]] = []
                for link in page_links.get(page_index, []):
                    l, b, r, t = link.rect
                    lcx, lcy = (l + r) / 2 / width, 1 - (b + t) / 2 / height
                    if not (gx0 - 0.01 <= lcx <= gx1 + 0.01 and gy0 - 0.01 <= lcy <= gy1 + 0.01):
                        continue
                    uri = normalize_uri(link.uri)
                    visible = link_visible_text(text, uri, link.text, link.group_text)
                    span = first_free_span(visible, text, spans) if visible else None
                    if span is None:
                        continue
                    spans.append(span)
                    runs.append({"start": span[0], "end": span[1], "href": uri})
                    self.report.links_mapped += 1
                    self.report.links_unmapped = max(0, self.report.links_unmapped - 1)
                block = {
                    "id": self._id(f"b-p{page_index}-region-{len(new_blocks) + 1}"),
                    "kind": "paragraph",
                    "text": text,
                    "page": page_index,
                    "order": 0,
                    "column": "single",
                    "inline": runs,
                    "evidence": {
                        "confidence": 0.5,
                        "pages": [page_index],
                        "boxes": [{"page": page_index, "x": round(gx0, 5), "y": round(gy0, 5), "width": round(gx1 - gx0, 5), "height": round(gy1 - gy0, 5), "rotation": 0}],
                        "sourceIds": [f"pdftotext-page-{page_index}"],
                        "signals": ["text-layer-fallback", "layout-model-dropped-region"],
                    },
                }
                new_blocks.append((gy0, gx0, block))
            if not new_blocks:
                continue
            for gy0, gx0, block in new_blocks:
                position = None
                for i, existing in enumerate(self.blocks):
                    if existing["page"] != page_index or not existing["evidence"]["boxes"] or existing["kind"] == "furniture":
                        continue
                    ebox = existing["evidence"]["boxes"][0]
                    same_column = min(ebox["x"] + ebox["width"], block["evidence"]["boxes"][0]["x"] + block["evidence"]["boxes"][0]["width"]) - max(ebox["x"], gx0) > 0
                    if same_column and ebox["y"] >= gy0:
                        position = i
                        break
                if position is None:
                    position = next((i for i, b in enumerate(self.blocks) if b["page"] is not None and b["page"] > page_index), len(self.blocks))
                self.blocks.insert(position, block)
                self.report.paragraphs += 1
                self.report.regions_recovered_from_text_layer += 1
            layout_lines = sum(1 for line in layout["lines"] if line["text"].strip())
            if layout_lines and sum(len(g) for g in groups) >= 0.8 * layout_lines:
                recovered_pages.add(page_index)
            self._diagnostic("info", "layout", "Region recovered from text layer", f"page {page_index}: {len(new_blocks)} text-layer paragraph(s) the layout model returned no item for", None, page_index)
        self.report.pages_recovered_from_text_layer += len(recovered_pages)

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
                if self._rescue_caption_from_furniture(item):
                    continue
                if self._furniture_text_is_prose(item):
                    self._rescue_prose_from_furniture(item)
                    continue
                self._furniture_block(item, "explicit-paratext")
        self._flush()
        if self.page_layout:
            self._restore_missing_lines()
            self._recover_dropped_regions()
        else:
            self._recover_dropped_pages()
        self._drop_tick_label_runs()
        self._drop_numeric_fragments()
        self._demote_repeated_edge_text()
        self._demote_heading_running_heads()
        self._strip_glued_tails()
        self._place_table_notes()
        self._strip_glued_heads()
        self._split_cross_page_spans()
        self._join_split_paragraphs()
        self._link_notes()
        self._recover_link_icons()
        self._merge_subpanel_figures()
        self._read_captions_inside_figures()
        self._fix_caption_sides()
        self._adopt_orphan_captions()
        self._adopt_captions_by_geometry()
        self._adopt_captions_across_page_break()
        self._read_table_captions_from_source()
        self._fold_panels_into_captioned_figures()
        self._fold_panels_by_geometry()
        self._recover_ruled_boxes()
        self._complete_short_captions()
        self._recover_uncaptured_figures()
        self._recover_uncaptured_tables()
        self._fold_panels_by_geometry()
        self._join_split_paragraphs()  # captions adopted above may now claim their continuation
        self._merge_continued_tables()
        self._rejoin_split_listings()
        from note_bodies import recover_note_bodies
        recover_note_bodies(self)
        # Caption geometry is semantic provenance; raster assets keep their
        # final artwork-only crop boxes. Resolve source links against survivors.
        from figure_recovery import retain_caption_evidence
        from internal_links import recover_internal_links
        retain_caption_evidence(self)
        self.report.internal_link_coverage = recover_internal_links(self)
        self.report.internal_link_coverage["offsetEncoding"] = "unicode-code-points"
        self.report.internal_links_skipped = self.report.internal_link_coverage["unresolved"]
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
                    "sourceAnnotationCount": self.report.links_expected + self.report.internal_link_coverage["total"],
                    "accountedSourceAnnotationCount": self.report.links_mapped + self.report.internal_link_coverage["linked"],
                },
            },
        }
        self.report.blocks = len(self.blocks)
        self.report.orphan_figure_captions = sum(
            1 for b in self.blocks if b["kind"] == "caption" and FIGURE_CAPTION_RE.match(b["text"])
        )
        # Every recovery pass above addresses Python code-point offsets. The
        # Struct codec and renderers consume JavaScript UTF-16 offsets.
        from inline_offsets import convert_inline_offsets
        convert_inline_offsets(document["blocks"])
        return document, self.report


def to_struct_draft(doc: DoclingDocument, pdf_path: Path, source_sha256: str, links: list[SourceLink], word_boxes: list | None = None, page_lines: list | None = None, source_text: SourceText | None = None, page_layout: list | None = None, source_raster=None) -> tuple[dict, AdapterReport]:
    return StructAdapter(doc, pdf_path, source_sha256, links, word_boxes, page_lines, source_text, page_layout, source_raster).build()
