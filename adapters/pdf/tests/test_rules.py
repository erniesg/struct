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
