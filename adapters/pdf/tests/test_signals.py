"""Unit tests for the adapter's pure rules (run: `python -m unittest discover adapters/pdf/tests`)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evaluate import _canonical_uri, _furniture_candidate_lines, _lowercase_starts, _running_lines, _strip  # noqa: E402
from pdf2struct import LIST_LIKE_NOTE_RE, PARATEXT_NOTE_RE, StructAdapter, clean_caption, footnote_parts, heading_level  # noqa: E402
from pdf_text import Char, Marker, PageText, classify_font  # noqa: E402


class FootnoteMarkers(unittest.TestCase):
    def test_marker_needs_a_word_boundary(self):
        self.assertEqual(footnote_parts("1 Equal contribution."), ("1", "Equal contribution."))
        self.assertEqual(footnote_parts("0360-0300/2022/10-ART1"), (None, "0360-0300/2022/10-ART1"))
        self.assertEqual(footnote_parts("∗ daedalus@example.org"), ("*", "daedalus@example.org"))
        self.assertEqual(footnote_parts("†Corresponding author"), ("†", "Corresponding author"))

    def test_list_like_notes_are_list_items(self):
        self.assertTrue(LIST_LIKE_NOTE_RE.match("1. Preserve the core inquiry"))
        self.assertTrue(LIST_LIKE_NOTE_RE.match("- Valid values for the key"))
        self.assertFalse(LIST_LIKE_NOTE_RE.match("1 https://example.org"))

    def test_paratext_notes(self):
        self.assertTrue(PARATEXT_NOTE_RE.match("Permission to make digital or hard copies"))
        self.assertTrue(PARATEXT_NOTE_RE.match("© 2022 Copyright held by the owner/author(s)."))
        self.assertFalse(PARATEXT_NOTE_RE.match("Equal contribution."))

    def test_locate_marker_by_left_context(self):
        text = "Yijia Xiao1,3, Edward Sun1,3, Di Luo1,2"
        self.assertEqual(StructAdapter._locate_marker(text, "YijiaXiao", "1,3", "3"), (12, 13))
        self.assertEqual(StructAdapter._locate_marker(text, "DiLuo", "1,2", "1"), (36, 37))
        self.assertIsNone(StructAdapter._locate_marker(text, "Nobody", "9", "9"))

    def test_glyph_marker_labels(self):
        marker = Marker("1*†", 1, 0.1, 0.1, 0.01, 0.01, "HaitaoLi", "", False)
        self.assertTrue(marker.has_label("1"))
        self.assertTrue(marker.has_label("*"))
        self.assertTrue(marker.has_label("∗"))
        self.assertTrue(marker.has_label("†"))
        self.assertFalse(marker.has_label("2"))
        affiliations = Marker("12", 1, 0.1, 0.1, 0.01, 0.01, "QianyueWang", "", False)
        self.assertFalse(affiliations.has_label("2"))
        self.assertTrue(affiliations.has_label("2", loose=True))


def _listing(lines, font="ABCDEF+LMMono10-Regular", cell=5.0, leading=14.0):
    """Glyph lines of a fixed-pitch listing, each indented by whole characters."""
    chars = []
    for index, (indent, text) in enumerate(lines):
        bottom = 150.0 - index * leading
        for position, letter in enumerate(text):
            left = 20.0 + (indent + position) * cell
            chars.append(Char(letter, left, bottom, left + cell, bottom + 9.0, font))
    return chars


class GlyphLines(unittest.TestCase):
    def test_superscript_run_becomes_a_marker(self):
        chars = []
        x = 10.0
        for letter in "word":
            chars.append(Char(letter, x, 100.0, x + 5, 110.0, "CMR10"))
            x += 5
        chars.append(Char("1", x + 0.5, 104.0, x + 3.5, 110.0, "CMR7"))
        x += 8
        for letter in "next":
            chars.append(Char(letter, x, 100.0, x + 5, 110.0, "CMR10"))
            x += 5
        page = PageText(1, 200.0, 200.0, chars)
        self.assertEqual(len(page.lines), 1)
        self.assertEqual([m.text for m in page.markers], ["1"])
        self.assertEqual(page.markers[0].left_context, "word")
        self.assertFalse(page.markers[0].at_line_start)

    def test_listing_indents_are_read_from_the_source_line_starts(self):
        """A listing's leading whitespace is not in the text layer: the source
        sets an indent by starting the line further right. Measured against
        the listing's own character width, those starts restore it."""
        page = PageText(1, 200.0, 200.0, _listing([(0, "def f(n):"), (4, "while n:"), (8, "n -= 1"), (4, "return n")]))
        box = dict(page=1, x=0.0, y=0.0, width=1.0, height=1.0)
        self.assertEqual(page.region_text(box).split("\n"), ["def f(n):", "while n:", "n -= 1", "return n"])
        self.assertEqual(page.listing_text(box).split("\n"), ["def f(n):", "    while n:", "        n -= 1", "    return n"])

    def test_a_listing_off_the_character_grid_keeps_its_lines_as_they_are(self):
        """Two listings side by side, or a region a neighbouring column leaks
        into, have left edges that are no whole number of characters apart.
        A guessed indent would misstate the code's structure, so none is made."""
        chars = _listing([(0, "def f(n):"), (4, "while n:")])
        for char in chars:  # the second line starts half a character further right
            if char.b < 145.0:
                char.l += 2.5
                char.r += 2.5
        page = PageText(1, 200.0, 200.0, chars)
        box = dict(page=1, x=0.0, y=0.0, width=1.0, height=1.0)
        self.assertEqual(page.listing_text(box), page.region_text(box))

    def test_a_region_whose_glyphs_disagree_on_one_body_is_not_a_character_grid(self):
        """Only a face whose glyphs agree on one body width is fixed pitch;
        where they disagree the left edges measure nothing, whatever the
        font name claims."""
        chars = _listing([(0, "def f(n):"), (4, "while n:")])
        for index, char in enumerate(chars):
            char.r = char.l + 2.0 + (index % 4)
        page = PageText(1, 200.0, 200.0, chars)
        box = dict(page=1, x=0.0, y=0.0, width=1.0, height=1.0)
        self.assertEqual(page.listing_text(box), page.region_text(box))

    def test_font_classes(self):
        self.assertEqual(classify_font("/ABCDEF+LMMono10-Regular")["mono"], True)
        self.assertEqual(classify_font("/ABCDEF+CMMI10")["math"], True)
        self.assertEqual(classify_font("/ABCDEF+CMBX10")["bold"], True)
        self.assertEqual(classify_font("/ABCDEF+CMTI10")["italic"], True)
        self.assertEqual(classify_font("/ABCDEF+NimbusSanL-Regu")["bold"], False)


class CaptionRules(unittest.TestCase):
    def test_leading_page_numbers_are_dropped(self):
        self.assertEqual(clean_caption("13 13 Fig. 16. Transference"), "Fig. 16. Transference")
        self.assertEqual(clean_caption("7 Figure 2: Overview"), "Figure 2: Overview")
        self.assertEqual(clean_caption("Figure 3. Plain"), "Figure 3. Plain")


class HeadingRules(unittest.TestCase):
    def test_levels_from_numbering(self):
        self.assertEqual(heading_level("3.1 Setup", 1, None), 2)
        self.assertEqual(heading_level("References", 1, 2), 1)
        self.assertEqual(heading_level("Appendix B.2 Details", 1, None), 2)


class Evaluator(unittest.TestCase):
    def test_canonical_uri_matches_whatwg_href(self):
        self.assertEqual(_canonical_uri("https://leandojo.org"), "https://leandojo.org/")
        self.assertEqual(_canonical_uri("https://balancer.finance/whitepaper/ "), "https://balancer.finance/whitepaper/")
        self.assertEqual(_canonical_uri("HTTPS://Example.ORG/Path?q=1"), "https://example.org/Path?q=1")

    def test_tags_separate_words(self):
        self.assertEqual(_strip("<td>Seedance</td><td>2.0</td>").split(), ["Seedance", "2.0"])

    def test_running_lines_need_edge_geometry(self):
        layout = [
            {"height": 100.0, "lines": [{"ymin": 2, "ymax": 6, "text": "Journal of Things 12"}, {"ymin": 40, "ymax": 44, "text": "The input list contains quadruples"}]}
            for _ in range(3)
        ]
        running = _running_lines([], layout)
        self.assertIn("journal of things #", running)
        self.assertNotIn("the input list contains quadruples", running)

    def test_furniture_candidates_are_lines_in_the_outer_bands(self):
        def line(y, x, text):
            return {"ymin": y, "ymax": y + 2, "xmin": x, "xmax": x + 20, "text": text}
        body = [line(30, 20, "Body text of the paper"), line(70, 20, "More body text")]
        self.assertEqual(_furniture_candidate_lines([{"height": 100.0, "width": 100.0, "lines": body}]), 0)
        self.assertEqual(_furniture_candidate_lines([{"height": 100.0, "width": 100.0, "lines": body + [line(95, 45, "Journal 12")]}]), 1)
        self.assertEqual(_furniture_candidate_lines([{"height": 100.0, "width": 100.0, "lines": body + [line(91, 45, "7")]}]), 1)
        self.assertIsNone(_furniture_candidate_lines([]))

    def test_lowercase_after_colon_is_not_a_broken_join(self):
        html = "<p>The server maintains:</p><p>runtime state that is observed by the agent while it works on the task</p>"
        self.assertEqual(_lowercase_starts(html), 0)
        html = "<p>Some complete sentence about things.</p><p>continuation that starts lowercase and runs long enough to count</p>"
        self.assertEqual(_lowercase_starts(html), 1)


if __name__ == "__main__":
    unittest.main()
