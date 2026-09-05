"""Unit tests for the adapter's deterministic rules added for the reader
criteria (spec 052): link targets, joins, captions, coverage tokens."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evaluate import (  # noqa: E402
    _caption_labels,
    _label_key,
    _number_paragraphs_in_body,
    _tokens,
    lowercase_start_paragraphs,
)
from pdf2struct import (  # noqa: E402
    AdapterReport,
    CAPTION_LIKE_RE,
    FIGURE_CAPTION_RE,
    TABLE_CAPTION_RE,
    StructAdapter,
    _line_words_present,
    clean_caption,
    first_free_span,
    is_terminated,
    link_visible_text,
    marker_candidates,
)
from pdf_links import SourceLink, group_wrapped_links, normalize_uri  # noqa: E402
from pdf_text import Char, PageText, Rule  # noqa: E402


class LinkTargets(unittest.TestCase):
    def test_normalize_uri_agrees_with_whatwg_shape(self):
        self.assertEqual(normalize_uri("https://aave . com/docs"), "https://aave.com/docs")
        self.assertEqual(normalize_uri("www.wawawriter.com"), "http://www.wawawriter.com/")
        self.assertEqual(normalize_uri("https://https://makerdao.com"), "https://makerdao.com/")
        self.assertEqual(normalize_uri('"https://developers.googleblog.com/x'), "https://developers.googleblog.com/x")
        self.assertEqual(normalize_uri("mailto:{yfwu, zhuokai}@meta.com"), "mailto:%7Byfwu,zhuokai%7D@meta.com")
        self.assertEqual(normalize_uri("http://​www.​gutenberg.org/​files"), "http://www.gutenberg.org/files")
        self.assertEqual(normalize_uri("10.2139/ssrn.5240330"), "10.2139/ssrn.5240330")

    def test_visible_text_tolerates_hyphens_and_quotes(self):
        text = "Below is an example for ' init/control/functor.lean ', which imports ' init/core.lean '."
        self.assertEqual(link_visible_text(text, "https://x.org/tree/y", "“init/con-", "“init/con- trol/functor.lean”,"), "init/control/functor.lean")
        self.assertEqual(link_visible_text(text, "https://x.org/tree/y", "“init/core.lean”,", "“init/core.lean”,"), "init/core.lean")
        self.assertIsNone(link_visible_text("nothing here", "https://x.org/", "", ""))

    def test_second_link_with_the_same_words_takes_the_next_occurrence(self):
        text = "code is available here, and interpretations are available here."
        first = first_free_span("here", text, [])
        second = first_free_span("here", text, [first])
        self.assertEqual(text[first[0] : first[1]], "here")
        self.assertNotEqual(first, second)
        self.assertEqual(text[second[0] : second[1]], "here")

    def test_wrapped_links_share_their_words(self):
        top = SourceLink(1, (100.0, 500.0, 300.0, 510.0), "https://x.org/a", "uri", ["https://x.org/", "a-long"])
        bottom = SourceLink(1, (100.0, 488.0, 200.0, 498.0), "https://x.org/a", "uri", ["path"])
        group_wrapped_links([top, bottom])
        self.assertEqual(bottom.group_text, "https://x.org/ a-long path")


class Joins(unittest.TestCase):
    def test_citation_bracket_is_not_terminal(self):
        self.assertFalse(is_terminated("paired [43, 107] and unpaired [85]"))
        self.assertFalse(is_terminated("as shown by recent work (Smith et al., 2020)"))
        self.assertFalse(is_terminated("as verified by Abdou et al. (2021)"))
        self.assertFalse(is_terminated("two types of evaluation: stock market (U.S."))
        self.assertTrue(is_terminated("as shown in prior work [85]."))
        self.assertTrue(is_terminated("the result holds.3"))
        self.assertTrue(is_terminated("we conclude:"))

    def test_spaced_mathematics_does_not_end_a_sentence(self):
        # the layout model writes `0 . 946` for a decimal: not a full stop and a note marker
        self.assertFalse(is_terminated("reaches 0.977 accuracy and Cohen's κ = 0 . 946"))
        # `( j )` closes a bracket in a formula, not a sentence
        self.assertFalse(is_terminated("that the marginal extreme quantile Q Y ( j )"))
        # prose parentheses and real note markers are unchanged
        self.assertTrue(is_terminated("as shown in prior work (see Section 3)."))
        self.assertTrue(is_terminated("the extreme quantile (Section 3)"))
        self.assertTrue(is_terminated("was published recently. 3"))
        self.assertTrue(is_terminated("with a value of 0.946."))
        # a spaced bracket around a word is prose, not a formula
        self.assertTrue(is_terminated("was observed across both conditions ( Fig.2 )"))
        self.assertTrue(is_terminated("as reported before ( Smith et al. 2020 )"))

    def test_caption_like_blocks_are_floats(self):
        self.assertTrue(CAPTION_LIKE_RE.match("Listing 2 Supply of atomic token types"))
        self.assertTrue(CAPTION_LIKE_RE.match("Algorithm 1: Search"))
        self.assertFalse(CAPTION_LIKE_RE.match("Transactions"))


class Captions(unittest.TestCase):
    def test_sentence_starting_with_a_label_is_not_a_caption(self):
        self.assertIsNone(FIGURE_CAPTION_RE.match("Figure 15 shows examples from single-paper tasks."))
        self.assertIsNotNone(FIGURE_CAPTION_RE.match("Figure 15: An example"))
        self.assertIsNotNone(FIGURE_CAPTION_RE.match("Fig. 4 Directed weighted graph"))
        self.assertIsNone(TABLE_CAPTION_RE.match("Table 22 shows an example"))

    def test_sentence_tail_label_is_not_expected(self):
        labels = _caption_labels(["We provide example generations of s1-32B in", "Figure 5.", "", "Figure 6: Real caption."])
        self.assertEqual(labels["figure"], {"6"})
        labels = _caption_labels(["", "Figure 5.", "Example outputs on the next line."])
        self.assertEqual(labels["figure"], {"5"})

    def test_chapter_numbered_labels_keep_their_dots(self):
        self.assertEqual(FIGURE_CAPTION_RE.match("Fig. 2.3: A scaling law").group(2), "2.3")
        self.assertEqual(FIGURE_CAPTION_RE.match("Figure 4.1: Comparing").group(2), "4.1")
        self.assertEqual(_caption_labels(["Fig. 2.3: A scaling law of test error", "Figure 4: Plain"])["figure"], {"2.3", "4"})
        self.assertEqual(sorted(["10", "2.3", "2.10", "4"], key=_label_key), ["2.3", "2.10", "4", "10"])
        self.assertIsNone(TABLE_CAPTION_RE.match("Table 1.1 illustrates these methods"))
        self.assertIsNone(TABLE_CAPTION_RE.match("Table 4.4 reports the results."))
        self.assertEqual(TABLE_CAPTION_RE.match("Table 4.4: Our latent token").group(2), "4.4")
        self.assertEqual(_caption_labels(["Table 2.2 shows the model sizes.", "Table 2.2: Model sizes"])["table"], {"2.2"})

    def test_figure_internal_words_before_the_label_are_dropped(self):
        self.assertEqual(clean_caption("Continuous warping Modality segmentation Fig. 10. Discrete alignment identifies connections."), "Fig. 10. Discrete alignment identifies connections.")
        self.assertEqual(clean_caption("Sentence one. Then Fig. 3: nope"), "Sentence one. Then Fig. 3: nope")


class Notes(unittest.TestCase):
    def test_symbol_aliases_match_the_body(self):
        text = "Kaiyu Yang 1 , Saad Godil ∗ , Ryan Prenger 2"
        self.assertEqual(StructAdapter._locate_marker(text, "SaadGodil", "*", "*"), (26, 27))
        self.assertEqual([text[s:e] for s, e, _ in marker_candidates("*", text)], ["∗"])


class Rules(unittest.TestCase):
    def test_rule_lines_from_paths(self):
        class Point:
            def __init__(self, x, y):
                self.x, self.y = x, y

        class Shape:
            def __init__(self, points, width=0.8):
                self.points = points
                self.line_width = width

        page = PageText(1, 600.0, 800.0, [Char("a", 10, 700, 15, 710, "CMR10")], shapes=[Shape([Point(60, 720), Point(550, 720)]), Shape([Point(60, 700), Point(60, 500)], 0.4)])
        horizontal = [r for r in page.rules if r.horizontal]
        vertical = [r for r in page.rules if not r.horizontal]
        self.assertEqual(len(horizontal), 1)
        self.assertAlmostEqual(horizontal[0].y0, 1 - 720 / 800, places=3)
        self.assertEqual(len(vertical), 1)
        self.assertTrue(isinstance(page.rules[0], Rule))


class Evaluator(unittest.TestCase):
    def test_lowercase_starts_skip_headings_and_names(self):
        html = "<h2>Keywords</h2><p>large language model, automatic program repair, autonomous software engineering agents</p>"
        self.assertEqual(lowercase_start_paragraphs(html), [])
        html = "<p>Some complete sentence about things here.</p><p>vec2vec is the first method to translate embeddings between spaces</p>"
        self.assertEqual(lowercase_start_paragraphs(html), [])
        html = "<p>Some complete sentence about things here.</p><p>continuation that starts lowercase and runs long enough to count</p>"
        self.assertEqual(len(lowercase_start_paragraphs(html)), 1)
        html = "<p>Some complete sentence about things here.</p><p>message = {* *} ... {* *} c 1 c k input: {* x *} output: the template</p>"
        self.assertEqual(lowercase_start_paragraphs(html), [])

    def test_cjk_tokens_compare_per_character(self):
        self.assertEqual(_tokens("你瞧你瞧 gpt"), ["你", "瞧", "你", "瞧", "gpt"])

    def test_body_numbers_come_from_the_draft(self):
        self.assertEqual(_number_paragraphs_in_body(None), {})


class ContinuationAcrossEntries(unittest.TestCase):
    """`_continuation_predecessor`: a reference list between the halves of a
    hyphenated word is a run the eye skips, not another column's prose flow."""

    @staticmethod
    def _block(kind, text, page=9):
        return {"kind": kind, "page": page, "text": text, "inline": [],
                "evidence": {"boxes": [{"page": page, "x": 0.1, "y": 0.5, "width": 0.4,
                                        "height": 0.05, "rotation": 0}], "pages": [page]}}

    def _find(self, blocks):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.blocks = blocks
        return adapter._continuation_predecessor(len(blocks) - 1)

    def test_join_reaches_across_a_reference_list(self):
        blocks = [self._block("paragraph", "We also find that the dif-")]
        blocks += [self._block("list-item", f"A. Author, A title of paper {n}, Journal 3, 023222 (2021).")
                   for n in range(10)]
        blocks.append(self._block("paragraph", "ference between the PAECS and PAOCS performances decreases."))
        found, how = self._find(blocks)
        self.assertIs(found, blocks[0])
        self.assertEqual(how, "paragraph")

    def test_a_reference_list_longer_than_the_budget_stops_the_search(self):
        blocks = [self._block("paragraph", "We also find that the dif-")]
        blocks += [self._block("list-item", f"A. Author, A title of paper {n}, Journal 3, 023222 (2021).")
                   for n in range(40)]
        blocks.append(self._block("paragraph", "ference between the PAECS and PAOCS performances decreases."))
        self.assertIsNone(self._find(blocks)[0])

    def test_complete_prose_between_the_halves_still_stops_at_three(self):
        blocks = [self._block("paragraph", "We also find that the dif-")]
        blocks += [self._block("paragraph", f"A complete sentence of another column {n}.") for n in range(4)]
        blocks.append(self._block("paragraph", "ference between the PAECS and PAOCS performances decreases."))
        self.assertIsNone(self._find(blocks)[0])


class GluedMarginStamps(unittest.TestCase):
    """`_strip_glued_heads`: a margin stamp the layout model put in front of a
    paragraph is cut, and anything that is not one is left alone."""

    @staticmethod
    def _paragraph(text, boxes, inline=None):
        return {
            "kind": "paragraph",
            "page": 7,
            "text": text,
            "inline": inline or [],
            "evidence": {"boxes": boxes},
        }

    @staticmethod
    def _run(adapter_blocks):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.blocks = adapter_blocks
        adapter.report = AdapterReport()
        adapter._strip_glued_heads()
        return adapter

    STAMP = {"page": 7, "x": 0.905, "y": 0.169, "width": 0.015, "height": 0.011, "rotation": 0}
    PROSE = {"page": 7, "x": 0.080, "y": 0.585, "width": 0.410, "height": 0.060, "rotation": 0}
    TEXT = "63 lower revenue bound, this algorithm first attempts to solve, given multiples of ten."

    def test_edge_stamp_in_front_of_a_paragraph_is_cut(self):
        block = self._paragraph(self.TEXT, [self.STAMP, self.PROSE],
                                inline=[{"start": 3, "end": 8, "style": "italic"}])
        adapter = self._run([block])
        self.assertTrue(block["text"].startswith("lower revenue bound"))
        self.assertEqual(block["evidence"]["boxes"], [self.PROSE])
        self.assertEqual(adapter.report.glued_heads_stripped, 1)
        self.assertEqual(block["inline"], [{"start": 0, "end": 5, "style": "italic"}])

    def test_a_number_the_paragraph_owns_is_kept(self):
        block = self._paragraph(self.TEXT, [dict(self.PROSE, x=0.080, y=0.585), self.PROSE])
        self._run([block])
        self.assertTrue(block["text"].startswith("63 lower"))

    def test_a_stamp_beside_the_prose_is_kept(self):
        beside = dict(self.STAMP, x=0.080, y=0.585)
        block = self._paragraph(self.TEXT, [beside, self.PROSE])
        self._run([block])
        self.assertTrue(block["text"].startswith("63 lower"))

    def test_a_paragraph_starting_with_a_word_is_kept(self):
        block = self._paragraph("Sixty-three lower revenue bounds, this algorithm first attempts to solve them.",
                                [self.STAMP, self.PROSE])
        self._run([block])
        self.assertTrue(block["text"].startswith("Sixty-three"))


if __name__ == "__main__":
    unittest.main()


class RestoredLines(unittest.TestCase):
    """`_restore_missing_lines`: a text-layer line the layout model did not
    carry goes back into its paragraph; a line of mathematics whose symbols
    the text layer merely orders differently is already there and stays out."""

    WIDTH, HEIGHT = 600.0, 800.0

    @staticmethod
    def _line(text, top):
        return {"xmin": 60.0, "xmax": 290.0, "ymin": top, "ymax": top + 10.0, "text": text}

    def _run(self, block_text, lines, before=None):
        adapter = StructAdapter.__new__(StructAdapter)
        block = {"kind": "paragraph", "page": 4, "text": block_text, "inline": [],
                 "evidence": {"boxes": [{"page": 4, "x": 0.09, "y": 0.30, "width": 0.40, "height": 0.10, "rotation": 0}],
                              "pages": [4], "signals": ["docling-layout"]}}
        adapter.blocks = [block]
        if before is not None:
            # the neighbour above, whose box the layout model let overlap the first line
            adapter.blocks.insert(0, {"kind": "paragraph", "page": 4, "text": before, "inline": [],
                                      "evidence": {"boxes": [{"page": 4, "x": 0.09, "y": 0.20, "width": 0.40, "height": 0.105, "rotation": 0}],
                                                   "pages": [4], "signals": ["docling-layout"]}})
        adapter.report = AdapterReport()
        adapter._diagnostic = lambda *args, **kwargs: None
        adapter.page_layout = [{"width": self.WIDTH, "height": self.HEIGHT, "lines": []} for _ in range(3)]
        adapter.page_layout.append({"width": self.WIDTH, "height": self.HEIGHT, "lines": lines})
        adapter._restore_missing_lines()
        return block, adapter

    def test_words_present_reads_words_not_characters(self):
        block = "production rate E µ [Σ K t ] = ⟨ Σ loc K h z ⟩ µ ≡ Σ K ≤ Σ U . Here Σ K is the coarse-grained"
        compact = "".join(ch for ch in block.lower() if ch.isalnum() and ch.isascii())
        self.assertTrue(_line_words_present("tion rate Eµ [Σt ] = ⟨Σloc Kzh ⟩µ ≡ ΣK ≤ ΣU .", compact))
        self.assertFalse(_line_words_present("On the Origin of Species by Means of Natural Selection", compact))
        self.assertFalse(_line_words_present("E µ [Σ t ] ≡ Σ K", compact))

    def test_a_mathematical_line_already_carried_is_not_restored(self):
        block_text = ("Here Σ K is the coarse-grained and Σ U is the full mean entropy production rate of the probed region. "
                      "The two coincide in the limit K h z → 1 supp( U Σ ) . In analogy to coarse-grained density estimators")
        lines = [self._line("tion rate Eµ [Σt ] = ⟨Σloc Kzh ⟩µ ≡ ΣK ≤ ΣU .", 242.0),
                 self._line("Here ΣK is the coarse-grained and ΣU is the full mean", 254.0),
                 self._line("entropy production rate of the probed region. The two", 266.0),
                 self._line("coincide in the limit Kzh → 1supp(UΣ ) . In analogy to", 278.0)]
        before = ("Dissipation concentration inequalities.- For suitable U , J t realizes generalized currents, i.e., a trajectory "
                  "estimator of the coarse-grained regional entropy production rate E µ [Σ K t ] = ⟨ Σ loc K h z ⟩ µ ≡ Σ K ≤ Σ U .")
        block, adapter = self._run(block_text, lines, before=before)
        self.assertTrue(block["text"].startswith("Here Σ K is"))
        self.assertEqual(adapter.report.lines_restored_from_text_layer, 0)

    def test_an_italic_title_the_layout_model_dropped_is_restored(self):
        block_text = "The book that started it all was published in 1859 and it is still read today by many."
        lines = [self._line("The book that started it all was published in 1859", 254.0),
                 self._line("On the Origin of Species by Means of Natural Selection", 266.0),
                 self._line("and it is still read today by many.", 278.0)]
        block, adapter = self._run(block_text, lines)
        self.assertIn("in 1859 On the Origin of Species by Means of Natural Selection and it", block["text"])
        self.assertEqual(adapter.report.lines_restored_from_text_layer, 1)


class StrayLeads(unittest.TestCase):
    """`_split_stray_lead`: a stray word on one page glued by the layout model
    to the paragraph that opens the next page is split off; a paragraph that
    genuinely runs over a page break is left whole."""

    @staticmethod
    def _item(ref, text, prov):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TextItem
        return TextItem(self_ref=ref, label=DocItemLabel.TEXT, orig=text, text=text,
                        prov=[ProvenanceItem(page_no=page, charspan=span,
                                             bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT))
                              for page, span, (l, t, r, b) in prov])

    def _adapter(self, items):
        from types import SimpleNamespace
        adapter = StructAdapter.__new__(StructAdapter)
        size = SimpleNamespace(width=612.0, height=792.0)
        adapter.doc = SimpleNamespace(pages={61: SimpleNamespace(size=size), 62: SimpleNamespace(size=size)},
                                      iterate_items=lambda **kwargs: [(item, 0) for item in items])
        adapter.blocks, adapter._pending, adapter._ids = [], None, set()
        adapter.report = AdapterReport()
        adapter._runs_for = lambda item, text: []
        return adapter

    TEXT = "and Corollary 4.35 (Learning complexity from contraction complexity). Let G be a connected graph with n vertices."

    def test_a_stray_word_before_the_next_page_is_split_off(self):
        glued = self._item("#/texts/1369", self.TEXT, [(61, (0, 3), (90, 561, 107, 552)), (62, (4, len(self.TEXT)), (90, 748, 505, 725))])
        below = self._item("#/texts/1362", "Moreover, the sequence can be constructed in polynomial time.", [(61, (0, 61), (90, 500, 430, 490))])
        adapter = self._adapter([glued, below])
        self.assertTrue(adapter._split_stray_lead(glued))
        adapter._flush()
        self.assertEqual([b["text"] for b in adapter.blocks], ["and", self.TEXT[4:]])
        self.assertEqual(adapter.blocks[0]["evidence"]["boxes"][0]["page"], 61)
        self.assertEqual(adapter.blocks[1]["page"], 62)
        self.assertEqual(adapter.blocks[1]["evidence"]["pages"], [62])
        self.assertEqual(adapter.report.stray_leads_split, 1)

    def test_a_last_line_at_the_page_foot_stays_with_its_paragraph(self):
        # the same shape, but nothing lies below the short first box: a paragraph running over the page break
        glued = self._item("#/texts/1369", self.TEXT, [(61, (0, 3), (90, 61, 107, 52)), (62, (4, len(self.TEXT)), (90, 748, 505, 725))])
        above = self._item("#/texts/1362", "Moreover, the sequence can be constructed in polynomial time.", [(61, (0, 61), (90, 500, 430, 490))])
        adapter = self._adapter([glued, above])
        self.assertFalse(adapter._split_stray_lead(glued))
        self.assertEqual(adapter.blocks, [])

    def test_a_long_first_box_is_not_a_stray_word(self):
        text = "The tomography theorem for a fixed learning sequence " + self.TEXT
        glued = self._item("#/texts/1369", text, [(61, (0, 52), (90, 561, 400, 552)), (62, (53, len(text)), (90, 748, 505, 725))])
        below = self._item("#/texts/1362", "Moreover, the sequence can be constructed in polynomial time.", [(61, (0, 61), (90, 500, 430, 490))])
        adapter = self._adapter([glued, below])
        self.assertFalse(adapter._split_stray_lead(glued))


class EntriesAcrossHeadings(unittest.TestCase):
    """`_continuation_predecessor` for a paragraph standing inside a run of
    reference entries: the layout model reads the acknowledgments between
    the two columns of one bibliography, and the entry's tail must still
    find its hyphen-ended head across those headings."""

    @staticmethod
    def _block(kind, text, page=9):
        return {"kind": kind, "page": page, "text": text, "inline": [],
                "evidence": {"boxes": [{"page": page, "x": 0.1, "y": 0.5, "width": 0.4, "height": 0.05, "rotation": 0}], "pages": [page]}}

    def _blocks(self, tail_followed_by_entry=True, head_hyphenated=True):
        blocks = [self._block("list-item", f"A. Author, A title of paper {n}, Journal 3, 23 (2021).") for n in range(3)]
        blocks.append(self._block("list-item", "T. Varley and O. Sporns, Partial entropy decomposition reveals higher-" if head_hyphenated else "T. Varley and O. Sporns, Partial entropy decomposition (2023)."))
        for title in ("Acknowledgments", "Author contributions", "Declaration of interests"):
            blocks.append(self._block("heading", title))
            blocks.append(self._block("paragraph", f"A complete sentence about the {title.lower()} of this work."))
        blocks.append(self._block("paragraph", "order information structures in human brain activity, PNAS 120, e2300888120 (2023)."))
        if tail_followed_by_entry:
            blocks.append(self._block("list-item", "Q. Li and J. Malo, Functional connectivity via total correlation, Neurocomputing 571 (2023)."))
        return blocks

    def _find(self, blocks, index):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.blocks = blocks
        return adapter._continuation_predecessor(index)

    def test_an_entry_tail_finds_its_head_across_the_acknowledgments(self):
        blocks = self._blocks()
        found, how = self._find(blocks, len(blocks) - 2)
        self.assertIs(found, blocks[3])
        self.assertEqual(how, "list-item")

    def test_a_paragraph_outside_the_list_still_stops_at_a_heading(self):
        blocks = self._blocks(tail_followed_by_entry=False)
        self.assertIsNone(self._find(blocks, len(blocks) - 1)[0])

    def test_only_a_hyphen_ended_entry_is_reached_past_the_headings(self):
        blocks = self._blocks(head_hyphenated=False)
        self.assertIsNone(self._find(blocks, len(blocks) - 2)[0])


class AttestedHalfWins(unittest.TestCase):
    """`_join_split_paragraphs`: when the nearest hyphen-ended block does not
    fuse into a word the paper uses and an earlier one does, the earlier one
    is the sentence's first half."""

    @staticmethod
    def _block(kind, text, page=9):
        return {"id": f"b-{kind}-{abs(hash(text)) % 10000}", "kind": kind, "page": page, "text": text, "inline": [],
                "evidence": {"boxes": [{"page": page, "x": 0.1, "y": 0.5, "width": 0.4, "height": 0.05, "rotation": 0}],
                             "pages": [page], "sourceIds": []}}

    def _run(self, blocks, words):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.blocks = blocks
        adapter.relationships = []
        adapter.report = AdapterReport()
        adapter._corpus_words = set(words)
        adapter._join_split_paragraphs()
        return adapter

    def test_the_attested_fusion_wins_over_the_nearer_hyphen(self):
        blocks = [self._block("paragraph", "provides a powerful framework for understanding com-")]
        blocks += [self._block("list-item", f"A. Author, A title of paper {n}, Journal 3, 23 (2021).") for n in range(7)]
        blocks.append(self._block("list-item", "T. Varley and O. Sporns, Partial entropy decomposition reveals higher-"))
        blocks.append(self._block("paragraph", "plex brain function, where the two are both crucial and meaningful."))
        adapter = self._run(blocks, {"complex", "brain", "function", "higher", "order"})
        self.assertEqual(blocks[0]["text"], "provides a powerful framework for understanding complex brain function, where the two are both crucial and meaningful.")
        self.assertTrue(blocks[-1]["text"].endswith("higher-"))
        self.assertEqual(adapter.report.joins_attested_over_nearer, 1)

    def test_the_nearer_hyphen_keeps_the_join_when_it_is_attested(self):
        blocks = [self._block("paragraph", "provides a powerful framework for understanding com-")]
        blocks += [self._block("list-item", f"A. Author, A title of paper {n}, Journal 3, 23 (2021).") for n in range(7)]
        blocks.append(self._block("list-item", "T. Varley and O. Sporns, Partial entropy decomposition reveals higher-"))
        blocks.append(self._block("paragraph", "order information structures in human brain activity, PNAS 120 (2023)."))
        adapter = self._run(blocks, {"complex", "higherorder"})
        self.assertTrue(blocks[-1]["text"].startswith("T. Varley") and blocks[-1]["text"].endswith("(2023)."))
        self.assertTrue(blocks[0]["text"].endswith("com-"))
        self.assertEqual(adapter.report.joins_attested_over_nearer, 0)


class SideColumns(unittest.TestCase):
    """A journal's first-page metadata sidebar is a narrow column beside the
    article: text the layout model continued into it is cut off, and its
    paragraphs do not spend the continuation search's prose budget. An
    ordinary two-column flow is disjoint but equally wide, and is untouched."""

    BODY = {"page": 1, "x": 0.324, "y": 0.673, "width": 0.616, "height": 0.206, "rotation": 0}
    ASIDE = {"page": 2, "x": 0.059, "y": 0.123, "width": 0.247, "height": 0.023, "rotation": 0}
    COLUMN_LEFT = {"page": 1, "x": 0.090, "y": 0.100, "width": 0.400, "height": 0.200, "rotation": 0}
    COLUMN_RIGHT = {"page": 1, "x": 0.520, "y": 0.100, "width": 0.406, "height": 0.200, "rotation": 0}

    def test_a_second_body_column_is_not_a_side_column(self):
        self.assertTrue(StructAdapter._is_side_column(self.ASIDE, self.BODY))
        self.assertFalse(StructAdapter._is_side_column(self.COLUMN_RIGHT, self.COLUMN_LEFT))
        # narrow but overlapping the body horizontally: a short last line of the same column
        self.assertFalse(StructAdapter._is_side_column({"page": 2, "x": 0.324, "y": 0.12, "width": 0.20, "height": 0.02}, self.BODY))

    HEAD = ("Y. pestis is the etiological agent responsible for plague. Healthcare providers at the primary "
            "care level frequently encounter difficulties due to inadequate professional knowledge and")
    TAIL = "design, data collection and analysis, decision to publish, or preparation of the manuscript."

    def _item(self, prov):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TextItem
        text = self.HEAD + " " + self.TAIL
        return TextItem(self_ref="#/texts/22", label=DocItemLabel.TEXT, orig=text, text=text,
                        prov=[ProvenanceItem(page_no=page, charspan=span,
                                             bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT))
                              for page, span, (l, t, r, b) in prov])

    def _adapter(self):
        from types import SimpleNamespace
        adapter = StructAdapter.__new__(StructAdapter)
        size = SimpleNamespace(width=612.0, height=792.0)
        adapter.doc = SimpleNamespace(pages={1: SimpleNamespace(size=size), 2: SimpleNamespace(size=size)})
        adapter.blocks, adapter._pending, adapter._ids = [], None, set()
        adapter.report = AdapterReport()
        adapter._runs_for = lambda item, text: []
        return adapter

    def test_the_cut_text_rejoins_the_open_entry_in_its_own_column(self):
        split = len(self.HEAD) + 1
        item = self._item([(1, (0, split - 1), (198, 792 * 0.327, 575, 792 * 0.12)),
                           (2, (split, split + len(self.TAIL)), (36, 792 * 0.877, 187, 792 * 0.854))])
        adapter = self._adapter()
        funding = {"id": "b-0", "kind": "paragraph", "page": 1,
                   "text": "Funding: This study was supported by a grant. The funders had no role in study", "inline": [],
                   "evidence": {"boxes": [{"page": 1, "x": 0.059, "y": 0.85, "width": 0.25, "height": 0.05, "rotation": 0}],
                                "pages": [1], "sourceIds": [], "signals": []}}
        adapter.blocks = [funding]
        self.assertTrue(adapter._split_side_column_tail(item))
        self.assertTrue(funding["text"].endswith("no role in study " + self.TAIL))
        self.assertEqual([b["text"] for b in adapter.blocks], [funding["text"], self.HEAD])

    def test_a_closed_entry_in_the_column_does_not_take_the_text(self):
        split = len(self.HEAD) + 1
        item = self._item([(1, (0, split - 1), (198, 792 * 0.327, 575, 792 * 0.12)),
                           (2, (split, split + len(self.TAIL)), (36, 792 * 0.877, 187, 792 * 0.854))])
        adapter = self._adapter()
        adapter.blocks = [{"id": "b-0", "kind": "paragraph", "page": 1, "text": "Copyright: an open access article.",
                           "inline": [], "evidence": {"boxes": [{"page": 1, "x": 0.059, "y": 0.71, "width": 0.24, "height": 0.05, "rotation": 0}],
                                                      "pages": [1], "sourceIds": [], "signals": []}}]
        self.assertTrue(adapter._split_side_column_tail(item))
        self.assertEqual([b["text"] for b in adapter.blocks][1:], [self.HEAD, self.TAIL])

    def test_a_paragraph_continued_into_the_sidebar_is_cut(self):
        split = len(self.HEAD) + 1
        item = self._item([(1, (0, split - 1), (198, 792 * 0.327, 575, 792 * 0.12)),
                           (2, (split, split + len(self.TAIL)), (36, 792 * 0.877, 187, 792 * 0.854))])
        adapter = self._adapter()
        self.assertTrue(adapter._split_side_column_tail(item))
        self.assertEqual([b["text"] for b in adapter.blocks], [self.HEAD, self.TAIL])
        self.assertEqual(adapter.blocks[1]["page"], 2)
        self.assertEqual(adapter.report.side_column_tails_split, 1)
        self.assertIn("side-column-aside", adapter.blocks[1]["evidence"]["signals"])

    def test_the_cut_sidebar_text_is_not_rejoined_to_the_body(self):
        # the sidebar's words start lowercase and the body's tail is unterminated:
        # without the mark the post-pass join would put them straight back together
        head = {"id": "b-1", "kind": "paragraph", "page": 1, "text": self.HEAD, "inline": [],
                "evidence": {"boxes": [self.BODY], "pages": [1], "sourceIds": [], "signals": []}}
        aside = {"id": "b-2", "kind": "paragraph", "page": 2, "text": self.TAIL, "inline": [],
                 "evidence": {"boxes": [self.ASIDE], "pages": [2], "sourceIds": [], "signals": ["side-column-aside"]}}
        adapter = self._adapter()
        adapter.blocks = [head, aside]
        adapter.relationships = []
        adapter._corpus_words = set()
        adapter._join_split_paragraphs()
        self.assertEqual([b["text"] for b in adapter.blocks], [self.HEAD, self.TAIL])

    def test_a_paragraph_crossing_to_the_next_column_is_kept_whole(self):
        split = len(self.HEAD) + 1
        item = self._item([(1, (0, split - 1), (55, 792 * 0.90, 300, 792 * 0.70)),
                           (1, (split, split + len(self.TAIL)), (318, 792 * 0.90, 563, 792 * 0.86))])
        adapter = self._adapter()
        self.assertFalse(adapter._split_side_column_tail(item))
        self.assertEqual(adapter.blocks, [])


class SideColumnBudget(unittest.TestCase):
    """`_continuation_predecessor`: the four sidebar entries of a PLOS first
    page lie between the halves of one sentence and must not exhaust the
    three-paragraph budget meant for another column's prose flow."""

    @staticmethod
    def _block(text, box, page):
        return {"kind": "paragraph", "page": page, "text": text, "inline": [],
                "evidence": {"boxes": [dict(box, page=page)], "pages": [page]}}

    def _find(self, aside_width):
        body = {"x": 0.324, "y": 0.49, "width": 0.616, "height": 0.20, "rotation": 0}
        aside = {"x": 0.059, "y": 0.12, "width": aside_width, "height": 0.05, "rotation": 0}
        blocks = [self._block("Real-time monitoring with portable gamma detectors was applied without workflow "
                              "disruption. Feasibility analyses indicated that, for diagnostic procedures, a", body, 1)]
        for label in ("Data availability statement", "Funding", "Competing interests", "Abbreviations"):
            blocks.append(self._block(f"{label}: a complete sentence of the journal's own matter.", aside, 2))
        blocks.append(self._block("single detector can be sufficient for reliable extravasation identification.",
                                  dict(body, y=0.12), 2))
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.blocks = blocks
        return blocks, adapter._continuation_predecessor(len(blocks) - 1)

    def test_sidebar_entries_do_not_spend_the_prose_budget(self):
        blocks, (found, how) = self._find(0.247)
        self.assertIs(found, blocks[0])
        self.assertEqual(how, "paragraph")

    def test_four_body_width_paragraphs_still_stop_the_search(self):
        _, (found, _) = self._find(0.616)
        self.assertIsNone(found)


class TableNoteTails(unittest.TestCase):
    """`_split_table_note_tail`: a table's note the layout model glued to the
    paragraph before it (`… leaving room for op` at the foot of one column,
    `a A complex neural network …` directly under the table heading the next)
    is cut off where the note's box begins and becomes an unlabelled footnote
    placed after its table; the exposed halves of the word then fuse."""

    HEAD = ("Despite these advancements, the focus remains predominantly on linear models, leaving room for op")
    NOTE = ("A complex neural network with intensive operator parallelism and interdependencies, unlike simpler "
            "linear networks like MobileNet and ResNet50.")
    HEAD_BOX = (49, 150, 300, 48)  # left column, foot of page 12
    TABLE_BOX = (314, 703, 561, 655)  # right column, top of page 12
    NOTE_BOX = (313, 657, 562, 631)  # directly under the table

    @staticmethod
    def _text(ref, text, prov):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TextItem
        return TextItem(self_ref=ref, label=DocItemLabel.TEXT, orig=text, text=text,
                        prov=[ProvenanceItem(page_no=page, charspan=span,
                                             bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT))
                              for page, span, (l, t, r, b) in prov])

    @staticmethod
    def _table(box):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TableData, TableItem
        l, t, r, b = box
        return TableItem(self_ref="#/tables/4", label=DocItemLabel.TABLE, data=TableData(),
                         prov=[ProvenanceItem(page_no=12, charspan=(0, 0),
                                              bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT))])

    def _adapter(self, items, markers=()):
        from types import SimpleNamespace
        adapter = StructAdapter.__new__(StructAdapter)
        size = SimpleNamespace(width=612.0, height=792.0)
        adapter.doc = SimpleNamespace(pages={12: SimpleNamespace(size=size)},
                                      iterate_items=lambda **kwargs: [(item, 0) for item in items])
        adapter.blocks, adapter._pending, adapter._ids = [], None, set()
        adapter.report = AdapterReport()
        adapter._runs_for = lambda item, text: []
        adapter._page_text = lambda page: SimpleNamespace(markers=list(markers)) if markers else None
        return adapter

    def test_a_marker_between_the_spans_opens_the_note(self):
        text = self.HEAD + " a " + self.NOTE
        glued = self._text("#/texts/774", text, [(12, (0, len(self.HEAD)), self.HEAD_BOX), (12, (len(self.HEAD) + 3, len(text)), self.NOTE_BOX)])
        adapter = self._adapter([glued, self._table(self.TABLE_BOX)])
        self.assertTrue(adapter._split_table_note_tail(glued))
        self.assertEqual([(b["kind"], b["text"]) for b in adapter.blocks], [("paragraph", self.HEAD), ("footnote", "a " + self.NOTE)])
        note = adapter.blocks[1]
        self.assertEqual(note["page"], 12)
        self.assertIn("table-note", note["evidence"]["signals"])
        self.assertNotIn("label", note)
        self.assertEqual(adapter.report.table_notes_split, 1)
        self.assertEqual(adapter.report.notes_without_reference, 1)

    def test_a_marker_glued_to_the_head_is_named_by_the_raised_glyph(self):
        from pdf_text import Marker
        text = self.HEAD + "a " + self.NOTE  # `… for opa`: the raised `a` read as the head's last letter
        glued = self._text("#/texts/774", text, [(12, (0, len(self.HEAD) + 1), self.HEAD_BOX), (12, (len(self.HEAD) + 2, len(text) + 2), self.NOTE_BOX)])
        raised = Marker(text="a", page=12, x=0.5117, y=0.1710, width=0.0055, height=0.0055, left_context="", right_context="Acomplexneur", at_line_start=True)
        adapter = self._adapter([glued, self._table(self.TABLE_BOX)], markers=[raised])
        self.assertTrue(adapter._split_table_note_tail(glued))
        self.assertEqual([(b["kind"], b["text"]) for b in adapter.blocks], [("paragraph", self.HEAD), ("footnote", "a " + self.NOTE)])

    def test_without_a_raised_glyph_the_glued_letter_stays_a_letter(self):
        text = self.HEAD + "a " + self.NOTE
        glued = self._text("#/texts/774", text, [(12, (0, len(self.HEAD) + 1), self.HEAD_BOX), (12, (len(self.HEAD) + 2, len(text)), self.NOTE_BOX)])
        adapter = self._adapter([glued, self._table(self.TABLE_BOX)])
        self.assertFalse(adapter._split_table_note_tail(glued))
        self.assertEqual(adapter.blocks, [])

    def test_a_box_that_is_not_under_a_table_is_a_column_break(self):
        text = self.HEAD + " a " + self.NOTE
        glued = self._text("#/texts/774", text, [(12, (0, len(self.HEAD)), self.HEAD_BOX), (12, (len(self.HEAD) + 3, len(text)), self.NOTE_BOX)])
        adapter = self._adapter([glued])  # no table on the page
        self.assertFalse(adapter._split_table_note_tail(glued))
        far = self._table((314, 760, 561, 720))  # a table well above the box, prose between
        adapter = self._adapter([glued, far])
        self.assertFalse(adapter._split_table_note_tail(glued))

    def test_a_paragraph_that_continues_under_a_table_is_left_whole(self):
        tail = "timization in more complex and irregular model architectures."
        text = self.HEAD + " " + tail
        glued = self._text("#/texts/774", text, [(12, (0, len(self.HEAD)), self.HEAD_BOX), (12, (len(self.HEAD) + 1, len(text)), self.NOTE_BOX)])
        adapter = self._adapter([glued, self._table(self.TABLE_BOX)])
        self.assertFalse(adapter._split_table_note_tail(glued))

    def test_the_note_moves_after_its_table_and_caption(self):
        adapter = self._adapter([])
        note_box = {"page": 12, "x": 0.5117, "y": 0.1710, "width": 0.4064, "height": 0.0325, "rotation": 0}
        table_box = {"page": 12, "x": 0.5128, "y": 0.1127, "width": 0.4040, "height": 0.0601, "rotation": 0}
        head = {"id": "h", "kind": "paragraph", "page": 12, "text": self.HEAD, "evidence": {"boxes": [], "signals": []}}
        note = {"id": "n", "kind": "footnote", "page": 12, "text": "a " + self.NOTE, "evidence": {"boxes": [note_box], "signals": ["table-note"]}}
        table = {"id": "t", "kind": "table", "page": 12, "text": "TABLE IV", "evidence": {"boxes": [table_box], "signals": []}}
        caption = {"id": "c", "kind": "caption", "page": 12, "text": "TABLE IV Comparing frameworks", "evidence": {"boxes": [], "signals": []}}
        after = {"id": "a", "kind": "paragraph", "page": 12, "text": "Our work innovatively addresses irregular graphs.", "evidence": {"boxes": [], "signals": []}}
        adapter.blocks = [head, note, table, caption, after]
        adapter._place_table_notes()
        self.assertEqual([b["id"] for b in adapter.blocks], ["h", "t", "c", "n", "a"])

    def test_spans_that_overshoot_the_text_by_a_character_or_two_still_split(self):
        text = self.HEAD + " a " + self.NOTE
        item = self._text("#/texts/774", text, [(12, (0, len(self.HEAD)), self.HEAD_BOX), (12, (len(self.HEAD) + 3, len(text) + 2), self.NOTE_BOX)])
        adapter = self._adapter([item])
        self.assertEqual(len(adapter._prov_segments(item)), 2)
        item = self._text("#/texts/774", text, [(12, (0, len(self.HEAD)), self.HEAD_BOX), (12, (len(self.HEAD) + 3, len(text) + 8), self.NOTE_BOX)])
        self.assertEqual(len(adapter._prov_segments(item)), 1)

    def test_the_walk_join_fuses_the_attested_word(self):
        # the head left open by the cut and the paragraph after the table meet in the walk, not the post-pass
        adapter = self._adapter([])
        adapter._corpus_forms = {"optimization", "linear", "models"}
        for name in ("_split_merged_caption", "_split_stray_lead", "_split_side_column_tail", "_split_table_note_tail", "_is_edge_page_number"):
            setattr(adapter, name, lambda item: False)
        adapter._is_description_item = lambda item, text: False
        adapter._emit_monospace_code = lambda item, text: False
        adapter._source_id = lambda item: item.self_ref
        adapter._in_abstract = False
        head = {"id": "h", "kind": "paragraph", "page": 12, "text": self.HEAD, "inline": [], "evidence": {"boxes": [], "pages": [12], "sourceIds": [], "signals": []}}
        adapter._pending = head
        tail = self._text("#/texts/776", "timization in more complex and irregular model architectures.", [(12, (0, 61), (313, 620, 562, 610))])
        adapter._emit_paragraph(tail)
        self.assertEqual(head["text"], self.HEAD[:-2] + "optimization in more complex and irregular model architectures.")
        self.assertEqual(adapter.report.joins_fused_words, 1)


class FigureFootLines(unittest.TestCase):
    """`_figure_foot_line`: one line of text standing on the foot of a
    caption-less picture with the figure's `Figure N` caption directly under
    it is the figure's own text and leaves the flow."""

    LEGEND = "Prototypes: cortical L5 · hippocampal CA1 · cerebellar Purkinje"
    CAPTION = "Figure 1: The delay-signature principle and the integrator neuron. a, Neurons A and B project to a common target P."
    PICTURE_BOX = (99, 719, 514, 330)   # page 8, bottom-left coords: y 0.09 .. 0.58
    LEGEND_BOX = (103, 337, 302, 329)   # one line, its lower fifth below the picture's foot
    CAPTION_BOX = (97, 315, 516, 115)   # directly under the legend

    @staticmethod
    def _text(ref, text, box, label=None):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TextItem
        l, t, r, b = box
        return TextItem(self_ref=ref, label=label or DocItemLabel.TEXT, orig=text, text=text,
                        prov=[ProvenanceItem(page_no=8, charspan=(0, len(text)),
                                             bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT))])

    @staticmethod
    def _picture(box):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, PictureItem, ProvenanceItem
        l, t, r, b = box
        return PictureItem(self_ref="#/pictures/0", label=DocItemLabel.PICTURE,
                           prov=[ProvenanceItem(page_no=8, charspan=(0, 0),
                                                bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT))])

    def _adapter(self, items):
        from types import SimpleNamespace
        adapter = StructAdapter.__new__(StructAdapter)
        size = SimpleNamespace(width=612.0, height=792.0)
        adapter.doc = SimpleNamespace(pages={8: SimpleNamespace(size=size)},
                                      iterate_items=lambda **kwargs: [(item, 0) for item in items])
        adapter.blocks, adapter._pending, adapter._ids = [], None, set()
        adapter.report = AdapterReport()
        return adapter

    def test_the_legend_on_the_picture_foot_is_figure_text(self):
        legend = self._text("#/texts/172", self.LEGEND, self.LEGEND_BOX)
        caption = self._text("#/texts/173", self.CAPTION, self.CAPTION_BOX)
        adapter = self._adapter([self._picture(self.PICTURE_BOX), legend, caption])
        self.assertTrue(adapter._figure_foot_line(legend))
        self.assertEqual(adapter.report.figure_foot_lines_absorbed, 1)

    def test_a_line_below_the_picture_is_a_paragraph(self):
        legend = self._text("#/texts/172", self.LEGEND, (103, 326, 302, 318))  # wholly under the picture's foot
        caption = self._text("#/texts/173", self.CAPTION, (97, 305, 516, 115))
        adapter = self._adapter([self._picture(self.PICTURE_BOX), legend, caption])
        self.assertFalse(adapter._figure_foot_line(legend))

    def test_without_a_caption_under_it_the_line_stays(self):
        legend = self._text("#/texts/172", self.LEGEND, self.LEGEND_BOX)
        prose = self._text("#/texts/173", "The transition is monotonic in dispersion, as the next section shows.", self.CAPTION_BOX)
        adapter = self._adapter([self._picture(self.PICTURE_BOX), legend, prose])
        self.assertFalse(adapter._figure_foot_line(legend))

    def test_a_captioned_picture_keeps_its_neighbours(self):
        from docling_core.types.doc import RefItem
        picture = self._picture(self.PICTURE_BOX)
        picture.captions = [RefItem(cref="#/texts/170")]
        legend = self._text("#/texts/172", self.LEGEND, self.LEGEND_BOX)
        caption = self._text("#/texts/173", self.CAPTION, self.CAPTION_BOX)
        adapter = self._adapter([picture, legend, caption])
        self.assertFalse(adapter._figure_foot_line(legend))

    def test_a_caption_or_page_number_on_the_foot_is_not_absorbed(self):
        caption = self._text("#/texts/173", self.CAPTION, self.CAPTION_BOX)
        for text in ("Table 9: Performance of the instruct models", "30", "Prototypes: cortical"):
            line = self._text("#/texts/172", text, self.LEGEND_BOX)
            adapter = self._adapter([self._picture(self.PICTURE_BOX), line, caption])
            self.assertFalse(adapter._figure_foot_line(line), text)


class CaptionCrossReferences(unittest.TestCase):
    """A `Figure N.` that closes a caption's last sentence with nothing after
    it is a cross-reference (`… The families are drawn in Figure 3.`), not a
    second caption to cut off; a `Figure N` with a body after it still is."""

    TABLE = ("Table 1: Scaling of graph parameters on example families. A family is listed as small if the "
             "parameter is constant or logarithmic in the number of vertices, and as large otherwise. "
             "The families are drawn in Figure 3.")

    @staticmethod
    def _caption(text):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TextItem
        return TextItem(self_ref="#/texts/263", label=DocItemLabel.CAPTION, orig=text, text=text,
                        prov=[ProvenanceItem(page_no=17, charspan=(0, len(text)),
                                             bbox=BoundingBox(l=92, t=530, r=520, b=500, coord_origin=CoordOrigin.BOTTOMLEFT))])

    def _adapter(self):
        from types import SimpleNamespace
        adapter = StructAdapter.__new__(StructAdapter)
        size = SimpleNamespace(width=612.0, height=792.0)
        adapter.doc = SimpleNamespace(pages={17: SimpleNamespace(size=size)}, iterate_items=lambda **kwargs: [])
        adapter.blocks, adapter._pending, adapter._ids, adapter._caption_refs = [], None, set(), set()
        adapter.report = AdapterReport()
        adapter._runs_for = lambda item, text: []
        return adapter

    def test_a_closing_cross_reference_stays_in_the_caption(self):
        adapter = self._adapter()
        adapter._emit(self._caption(self.TABLE), None)
        self.assertEqual([(b["kind"], b["text"]) for b in adapter.blocks], [("caption", self.TABLE)])
        self.assertEqual(adapter.report.caption_cross_references_kept, 1)

    def test_an_embedded_caption_with_a_body_is_still_cut(self):
        adapter = self._adapter()
        text = "Continuous warping Modality segmentation Fig. 10. Overview of the pipeline on two modalities."
        adapter._emit(self._caption(text), None)
        self.assertEqual([(b["kind"], b["text"]) for b in adapter.blocks],
                         [("paragraph", "Continuous warping Modality segmentation"), ("caption", "Fig. 10. Overview of the pipeline on two modalities.")])


class LongOrphanCaptions(unittest.TestCase):
    """`_adopt_orphan_captions`: a caption-less figure adopts the adjacent
    block the layout model labelled a caption whatever its length; a
    paragraph opening `Figure N` is only taken when it is short."""

    LONG = "Figure 1: The delay-signature principle and the integrator neuron. " + "a, Neurons A and B project to a common target P; A takes the longer path. " * 24

    def _adapter(self, neighbour_kind):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.report = AdapterReport()
        adapter.relationships, adapter._attached_caption_boxes = [], {}
        figure = {"id": "f", "kind": "figure", "page": 8, "text": "", "inline": [], "evidence": {"boxes": [{"page": 8, "x": 0.16, "y": 0.09, "width": 0.68, "height": 0.49, "rotation": 0}], "signals": []}}
        caption = {"id": "c", "kind": neighbour_kind, "page": 8, "text": self.LONG, "inline": [], "evidence": {"boxes": [{"page": 8, "x": 0.16, "y": 0.60, "width": 0.69, "height": 0.25, "rotation": 0}], "signals": []}}
        adapter.blocks = [figure, caption]
        return adapter

    def test_a_long_labelled_caption_is_adopted(self):
        self.assertGreater(len(self.LONG), 1200)
        adapter = self._adapter("caption")
        adapter._adopt_orphan_captions()
        self.assertEqual([b["kind"] for b in adapter.blocks], ["figure"])
        self.assertEqual(adapter.blocks[0]["label"], "Figure 1")
        self.assertEqual(adapter.report.captions_adopted, 1)

    def test_a_long_paragraph_opening_figure_n_is_not(self):
        adapter = self._adapter("paragraph")
        adapter._adopt_orphan_captions()
        self.assertEqual([b["kind"] for b in adapter.blocks], ["figure", "paragraph"])


class CaptionsAcrossPageBreaks(unittest.TestCase):
    """`_adopt_captions_across_page_break`: in a captions-below paper, an
    orphan `Figure N` caption standing first on its page adopts the
    caption-less pictures that close the previous page, merged as one figure."""

    CAPTION = "FIG. 3: Functional connectomics of the human brain. (Upper panel) Multi-scale fMRI neuromark template. (Lower panel) Large-scale resting-state networks."

    @staticmethod
    def _block(kind, page, box, text="", label=None, ident=None):
        x, y, w, h = box
        block = {"id": ident or f"{kind}-{page}-{y}", "kind": kind, "page": page, "text": text, "inline": [], "order": 0,
                 "evidence": {"boxes": [{"page": page, "x": x, "y": y, "width": w, "height": h, "rotation": 0}], "sourceIds": [f"#/{kind}/{page}"], "signals": []}}
        if label:
            block["label"] = label
        return block

    def _adapter(self, blocks, caption_below=(True, True)):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.report = AdapterReport()
        adapter.relationships, adapter._attached_caption_boxes, adapter._ids, adapter.diagnostics, adapter.assets = [], {}, set(), [], []
        adapter._figure_caption_below = list(caption_below)
        adapter._crop_asset = lambda *args, **kwargs: "asset-union"
        adapter.blocks = blocks
        return adapter

    def _page_seven_and_eight(self):
        upper = self._block("figure", 7, (0.154, 0.064, 0.699, 0.402), ident="upper")
        lower = self._block("figure", 7, (0.088, 0.48, 0.83, 0.413), ident="lower")
        header = self._block("furniture", 8, (0.91, 0.037, 0.008, 0.011), text="8")
        fig4 = self._block("figure", 8, (0.088, 0.241, 0.831, 0.321), text="FIG. 4: High-order interactions.", label="Figure 4")
        orphan = self._block("caption", 8, (0.088, 0.07, 0.831, 0.141), text=self.CAPTION, ident="orphan")
        return [upper, lower, header, fig4, orphan]

    def test_the_page_head_caption_adopts_the_panels_closing_the_previous_page(self):
        adapter = self._adapter(self._page_seven_and_eight())
        adapter._adopt_captions_across_page_break()
        self.assertEqual([b["kind"] for b in adapter.blocks], ["figure", "furniture", "figure"])
        figure = adapter.blocks[0]
        self.assertEqual(figure["label"], "Figure 3")
        self.assertTrue(figure["text"].startswith("FIG. 3: Functional connectomics"))
        box = figure["evidence"]["boxes"][0]
        self.assertAlmostEqual(box["y"], 0.064, places=3)
        self.assertAlmostEqual(box["y"] + box["height"], 0.893, places=3)  # both panels, taller than the 0.8 union cap
        self.assertEqual(figure["fallbackAssetIds"], ["asset-union"])
        self.assertEqual(adapter.report.captions_adopted_across_pages, 1)
        self.assertEqual(adapter.report.subpanel_figures_merged, 1)
        self.assertEqual(adapter.report.orphan_captions, -1)

    def test_a_captions_above_paper_keeps_the_page_head_caption_for_the_next_figure(self):
        adapter = self._adapter(self._page_seven_and_eight(), caption_below=(False, False))
        adapter._adopt_captions_across_page_break()
        self.assertEqual([b["kind"] for b in adapter.blocks], ["figure", "figure", "furniture", "figure", "caption"])

    def test_text_under_the_pictures_keeps_the_caption_where_it_is(self):
        blocks = self._page_seven_and_eight()
        blocks[1]["evidence"]["boxes"][0]["height"] = 0.3
        blocks.insert(2, self._block("paragraph", 7, (0.088, 0.8, 0.83, 0.09), text="The figure is discussed here."))
        adapter = self._adapter(blocks)
        adapter._adopt_captions_across_page_break()
        self.assertEqual(adapter.report.captions_adopted_across_pages, 0)
        self.assertEqual(adapter.blocks[-1]["kind"], "caption")

    def test_a_caption_that_is_not_first_on_its_page_stays(self):
        blocks = self._page_seven_and_eight()
        blocks.insert(2, self._block("paragraph", 8, (0.088, 0.04, 0.83, 0.02), text="Text above the caption."))
        adapter = self._adapter(blocks)
        adapter._adopt_captions_across_page_break()
        self.assertEqual(adapter.report.captions_adopted_across_pages, 0)

    def test_a_label_a_figure_already_holds_is_not_adopted(self):
        blocks = self._page_seven_and_eight()
        blocks[3]["label"] = "Figure 3"
        adapter = self._adapter(blocks)
        adapter._adopt_captions_across_page_break()
        self.assertEqual(adapter.report.captions_adopted_across_pages, 0)


class HeadingLinks(unittest.TestCase):
    """`_emit_heading`: a heading keeps the hyperlink annotation under it
    (`S1 Data.` in a journal's supporting-information list) as a link run,
    and takes no style runs."""

    URI = "http://journals.plos.org/plosone/article/asset?unique&id=info:doi/10.1371/journal.pone.0349408.s001"

    def _adapter(self):
        from types import SimpleNamespace
        adapter = StructAdapter.__new__(StructAdapter)
        size = SimpleNamespace(width=612.0, height=792.0)
        adapter.doc = SimpleNamespace(pages={12: SimpleNamespace(size=size)}, iterate_items=lambda **kwargs: [])
        adapter.blocks, adapter._pending, adapter._ids, adapter.diagnostics = [], None, set(), []
        adapter.report = AdapterReport()
        adapter.title_seen, adapter._has_title_item, adapter._title_candidate = True, True, None
        adapter._in_abstract, adapter._last_numbered_level = False, 0
        adapter._item_links = {"#/texts/300": [("S1 Data.", self.URI)]}
        adapter._style_runs = lambda item, text: [{"start": 0, "end": len(text), "style": "bold"}]
        return adapter

    def _heading(self, text):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, SectionHeaderItem
        return SectionHeaderItem(self_ref="#/texts/300", label=DocItemLabel.SECTION_HEADER, orig=text, text=text, level=1,
                                 prov=[ProvenanceItem(page_no=12, charspan=(0, len(text)),
                                                      bbox=BoundingBox(l=37, t=493, r=105, b=482, coord_origin=CoordOrigin.BOTTOMLEFT))])

    def test_the_heading_keeps_its_link_and_no_style_run(self):
        adapter = self._adapter()
        adapter._emit_heading(self._heading("S1 Data. Data."))
        self.assertEqual([b["kind"] for b in adapter.blocks], ["heading"])
        runs = adapter.blocks[0]["inline"]
        self.assertEqual([(r["start"], r["end"], r["href"]) for r in runs if "href" in r], [(0, 8, self.URI)])
        self.assertFalse([r for r in runs if "style" in r])

    def test_a_heading_without_an_annotation_has_no_runs(self):
        adapter = self._adapter()
        adapter._item_links = {}
        adapter._emit_heading(self._heading("Author contributions"))
        self.assertEqual(adapter.blocks[0]["inline"], [])


class FusedWordAttestation(unittest.TestCase):
    """`_fuse_words`: the fused word must occur in the paper letter for
    letter. `LLMAgents` (a heading the layout model ran together) does not
    attest `LLM` + `agents`; `optimization` attests `op` + `timization`."""

    def _adapter(self, forms):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter._corpus_forms = set(forms)
        return adapter

    def test_a_case_variant_does_not_attest_the_fusion(self):
        adapter = self._adapter({"LLMAgents", "agents", "LLM"})
        self.assertIsNone(adapter._fuse_words("qualities that LLM", "agents cannot fully replace."))

    def test_the_exact_form_does(self):
        adapter = self._adapter({"optimization"})
        self.assertEqual(adapter._fuse_words("leaving room for op", "timization in more"), "leaving room for optimization in more")
        self.assertIsNone(self._adapter({"Optimization"})._fuse_words("leaving room for op", "timization in more"))
