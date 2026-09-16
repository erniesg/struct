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

`StructAdapter` below holds the adapter's state, walks the Docling tree and
runs the recovery passes in order (`build`); the rules themselves live in the
`rules_*.py` mixins it is composed of, one module per concern (see the
"Where rules live" section of README.md). Shared regexes and text helpers are
in `adapter_common.py`; every name they define is re-exported here.
"""

from __future__ import annotations

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

from pdf_links import SourceLink, group_wrapped_links, normalize_uri  # noqa: F401  (re-exported)
from pdf_text import SourceText, normalize_marker  # noqa: F401  (re-exported)
from source_raster import SourceRasterError  # noqa: F401  (re-exported)
from layout_normalization import normalize_provenance
from figure_recovery import normalize_sideways_captions
from overlap_repair import repair_overlapping_items
from table_split import lift_caption_rows, split_side_by_side_tables
from adapter_common import (  # noqa: F401  (re-exported: tests and sibling modules import these names from pdf2struct)
    TERMINAL_RE,
    CITATION_TAIL_RE,
    ABBREVIATION_END_RE,
    FLOAT_KINDS,
    CAPTION_LIKE_RE,
    FIGURE_OWNER_RE,
    SUBCAPTION_RE,
    TRAILING_MARKER_RE,
    LOWER_START_RE,
    SPACED_MATH_TAIL_RE,
    NUMBERED_HEADING_RE,
    APPENDIX_HEADING_RE,
    TOP_LEVEL_HEADING_RE,
    DATE_AFTER_RE,
    TABLE_NOTE_LEAD_RE,
    FOOTNOTE_MARKER_RE,
    LIST_LIKE_NOTE_RE,
    PAGE_NUMBER_TEXT_RE,
    REFERENCE_WORD_RE,
    XML_ILLEGAL_RE,
    WORD_RE_ADAPTER,
    SAFE_HREF_RE,
    VISIBLE_RE,
    TICK_LABEL_RE,
    TICK_ROW_RE,
    PARATEXT_NOTE_RE,
    PARATEXT_NOTE_ANY_RE,
    JOURNAL_LINE_RE,
    PROSE_LIKE_RE,
    FIGURE_CAPTION_RE,
    TABLE_CAPTION_RE,
    EMBEDDED_CAPTION_RE,
    sanitize,
    is_terminated,
    heading_level,
    CAPTION_NOISE_RE,
    clean_caption,
    canonical_figure_label,
    footnote_parts,
    loose_pattern,
    QUOTE_VARIANTS,
    link_visible_text,
    first_free_span,
    marker_candidates,
    _line_words_present,
)
from rules_assets import AssetRules
from rules_captions import CaptionRules
from rules_code_equations import CodeEquationRules
from rules_figures import FigureRules
from rules_furniture import FurnitureRules
from rules_graph import GraphRules
from rules_links import LinkRules
from rules_notes import NoteRules
from rules_prose import ProseRules
from rules_ruled_boxes import RuledBoxRules
from rules_tables import TableRules
from rules_text_layer import TextLayerRules


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
    ocr_text_regions: int = 0
    overlapping_items_rebuilt: int = 0
    tables_split_side_by_side: int = 0
    tables_caption_row_lifted: int = 0
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


class StructAdapter(
    ProseRules,
    NoteRules,
    LinkRules,
    FurnitureRules,
    CaptionRules,
    FigureRules,
    TableRules,
    RuledBoxRules,
    CodeEquationRules,
    TextLayerRules,
    AssetRules,
    GraphRules,
):
    """The adapter's state, the walk over the Docling tree, and `build`, which runs
    the recovery passes in order. Each rule is a method of the mixin for its concern
    (`rules_*.py`); a new rule goes into that module, and only its call into `build`."""

    def __init__(self, doc: DoclingDocument, pdf_path: Path, source_sha256: str, links: list[SourceLink], word_boxes: list | None = None, page_lines: list | None = None, source_text: SourceText | None = None, page_layout: list | None = None, source_raster=None) -> None:
        doc, self._original_source_ids = normalize_provenance(doc)
        normalize_sideways_captions(doc)
        self.report = AdapterReport()
        self.report.overlapping_items_rebuilt = repair_overlapping_items(doc, page_layout or [])
        self.report.tables_split_side_by_side = split_side_by_side_tables(doc)
        self.report.tables_caption_row_lifted = lift_caption_rows(doc)
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
        self._fix_table_caption_sides()
        self._adopt_orphan_captions()
        self._adopt_captions_by_geometry()
        self._adopt_captions_across_page_break()
        self._read_table_captions_from_source()
        self._fold_panels_into_captioned_figures()
        self._fold_panels_by_geometry()
        self._recover_ruled_boxes()
        self._complete_short_captions()
        self._recover_uncaptured_figures()
        self._recover_subcaption_panels()
        self._recover_uncaptured_tables()
        self._fold_panels_by_geometry()
        self._join_split_paragraphs()  # captions adopted above may now claim their continuation
        self._merge_continued_tables()
        self._drop_duplicate_captions()
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
