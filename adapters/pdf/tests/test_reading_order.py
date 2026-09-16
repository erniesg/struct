"""The reading-order arbiter: when the text layer and the page geometry may
overrule the layout model's block order, and when they may not.

Each case is the page shape that motivated the guard, not a corpus filename.
"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import AdapterReport, StructAdapter  # noqa: E402
import reading_order  # noqa: E402

WIDTH, HEIGHT = 612.0, 792.0
LEFT, RIGHT = 0.09, 0.52
COLUMN = 0.39


def block(id, kind, text, x, y, width, height, page=1, pages=None):
    return dict(id=id, kind=kind, text=text, page=page, inline=[], order=0, evidence=dict(
        boxes=[dict(page=page, x=x, y=y, width=width, height=height, rotation=0)],
        pages=pages or [page], sourceIds=[id], signals=[]))


def line(text, x, y, width=COLUMN, height=0.015):
    """One text-layer line, in the points `pdftotext -bbox-layout` reports."""
    return dict(xmin=x * WIDTH, xmax=(x + width) * WIDTH,
                ymin=y * HEIGHT, ymax=(y + height) * HEIGHT, text=text)


def layout(lines):
    return [dict(width=WIDTH, height=HEIGHT, lines=lines)]


def adapter(blocks, page_layout):
    a = StructAdapter.__new__(StructAdapter)
    a.blocks = blocks
    a.report = AdapterReport()
    a.relationships = []
    a.assets = []
    a.diagnostics = []
    a._ids = set()
    a.page_layout = page_layout
    a.doc = SimpleNamespace(pages={}, texts=[], pictures=[])
    return a


def two_column_page():
    """A plain two-column page: three paragraphs down the left, three down the
    right, and a text layer that reads them in that order."""
    blocks = [
        block("l1", "paragraph", "left one", LEFT, 0.10, COLUMN, 0.15),
        block("l2", "paragraph", "left two", LEFT, 0.30, COLUMN, 0.15),
        block("l3", "paragraph", "left three", LEFT, 0.50, COLUMN, 0.15),
        block("r1", "paragraph", "right one", RIGHT, 0.10, COLUMN, 0.15),
        block("r2", "paragraph", "right two", RIGHT, 0.30, COLUMN, 0.15),
        block("r3", "paragraph", "right three", RIGHT, 0.50, COLUMN, 0.15),
    ]
    lines = []
    for x in (LEFT, RIGHT):
        for y in (0.10, 0.30, 0.50):
            lines += [line(f"{x}{y}-{n}", x, y + 0.02 * n) for n in range(3)]
    return blocks, layout(lines)


class ColumnOrderRepair(unittest.TestCase):
    def test_a_left_paragraph_printed_after_the_right_column_is_brought_back(self):
        blocks, page_layout = two_column_page()
        # `L R R R L`: the shape the layout model returns on a page with no
        # drawn rules to key off
        emitted = [blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "l2", "l3", "r1", "r2", "r3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 1)

    def test_a_page_the_layout_model_has_right_is_left_alone(self):
        blocks, page_layout = two_column_page()
        a = adapter(list(blocks), page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "l2", "l3", "r1", "r2", "r3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_floats_keep_their_places_while_the_prose_moves(self):
        blocks, page_layout = two_column_page()
        figure = block("fig", "figure", "Figure 1. A picture.", LEFT, 0.70, 0.8, 0.15)
        emitted = [blocks[0], blocks[3], figure, blocks[4], blocks[5], blocks[1], blocks[2]]
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "l2", "fig", "l3", "r1", "r2", "r3"])

    def test_the_text_layer_alone_does_not_move_a_page(self):
        """Poppler reading the columns in one order and the geometry in another
        is one tool's heuristic, not evidence."""
        blocks, page_layout = two_column_page()
        # the text layer reads across the page, line by line, as it does on a
        # page whose gutter it failed to find
        rows = []
        for y in (0.10, 0.30, 0.50):
            for n in range(3):
                rows += [line("l", LEFT, y + 0.02 * n), line("r", RIGHT, y + 0.02 * n)]
        emitted = [blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        a = adapter(emitted, layout(rows))
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "r1", "r2", "r3", "l2", "l3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_box_spanning_both_columns_makes_the_page_undecidable(self):
        """A paragraph the model gave one box over both columns is a merged
        span. Both arbiters place it first, agreeing with each other, and both
        are reading a box that stands over the whole page: a band that overlaps
        the columns beside it is not a band."""
        span = block("span", "paragraph", "a box over both columns", LEFT, 0.08, 0.83, 0.85)
        blocks = [
            block("l1", "paragraph", "left one", LEFT, 0.10, COLUMN, 0.15),
            block("l2", "paragraph", "left two", LEFT, 0.30, COLUMN, 0.15),
            block("r1", "paragraph", "right one", RIGHT, 0.10, COLUMN, 0.15),
            block("r2", "paragraph", "right two", RIGHT, 0.30, COLUMN, 0.15),
        ]
        lines = [line("banner", LEFT, 0.083, 0.83)]
        for x in (LEFT, RIGHT):
            for y in (0.10, 0.30):
                lines += [line("t", x, y + 0.02 * n) for n in range(3)]
        page_layout = layout(lines)
        result = reading_order.compare_page([span] + blocks, 1, page_layout[0])
        self.assertEqual(result["coverage"], 1.0)
        self.assertTrue(result["geometryAgrees"])  # both arbiters, and both wrong
        self.assertIn("full-width block overlaps a column block", result["faults"])
        emitted = [blocks[0], blocks[2], blocks[3], blocks[1], span]
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "r1", "r2", "l2", "span"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_paragraph_carried_onto_the_next_page_is_not_moved_by_this_one(self):
        blocks, page_layout = two_column_page()
        blocks[2]["evidence"]["pages"] = [1, 2]
        emitted = [blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "l2", "r1", "r2", "r3", "l3"])

    def test_a_one_column_page_is_never_read_as_two(self):
        """Two proof marks in the two margins are not two columns."""
        blocks = [
            block("p1", "paragraph", "body one", LEFT, 0.10, 0.82, 0.10),
            block("qedl", "paragraph", "□", 0.16, 0.22, 0.01, 0.01),
            block("p2", "paragraph", "body two", LEFT, 0.30, 0.82, 0.10),
            block("qedr", "paragraph", "□", 0.86, 0.45, 0.01, 0.01),
            block("p3", "paragraph", "body three", LEFT, 0.50, 0.82, 0.10),
        ]
        lines = [line("a", LEFT, 0.11, 0.82), line("q", 0.16, 0.22, 0.01),
                 line("b", LEFT, 0.31, 0.82), line("q", 0.86, 0.45, 0.01),
                 line("c", LEFT, 0.51, 0.82)]
        a = adapter(list(blocks), layout(lines))
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["p1", "qedl", "p2", "qedr", "p3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)


class ReadingOrderDiagnostic(unittest.TestCase):
    def test_an_order_both_arbiters_contradict_is_reported(self):
        """`evaluate.py` hardcoded this counter to zero, so the scorecard's
        AMBIGUOUS_READING_ORDER could never fire. It can now."""
        blocks, page_layout = two_column_page()
        emitted = [blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        a = adapter(emitted, page_layout)
        a._report_reading_order()
        self.assertEqual(a.report.reading_order_unrepaired, 1)
        self.assertEqual(a.report.reading_order_pages_disagree, 1)
        # the categories the struct codec accepts (src/document/codec/parsers.ts);
        # a category outside them is refused at render, not here
        self.assertEqual([d["category"] for d in a.diagnostics], ["layout"])
        self.assertIn(a.diagnostics[0]["severity"], ("info", "warning", "error"))
        self.assertEqual(a.diagnostics[0]["pages"], [1])

    def test_a_page_in_the_agreed_order_reports_nothing(self):
        blocks, page_layout = two_column_page()
        a = adapter(list(blocks), page_layout)
        a._report_reading_order()
        self.assertEqual(a.report.reading_order_unrepaired, 0)
        self.assertEqual(a.report.reading_order_pages_compared, 1)
        self.assertEqual(a.diagnostics, [])


class SensorVocabulary(unittest.TestCase):
    def test_a_block_whose_lines_are_a_scatter_is_a_fault_not_a_rank(self):
        entry = {"lines": [0, 1, 2, 30, 31]}
        self.assertTrue(reading_order.split_lines(entry))
        self.assertFalse(reading_order.split_lines({"lines": [4, 5, 6, 7]}))

    def test_coverage_counts_the_body_blocks_the_text_layer_reached(self):
        blocks, page_layout = two_column_page()
        blocks.append(block("ghost", "paragraph", "under a picture", LEFT, 0.85, COLUMN, 0.05))
        result = reading_order.compare_page(blocks, 1, page_layout[0])
        self.assertEqual(result["matched"], 6)
        self.assertEqual(result["blocks"], 7)
        self.assertLess(result["coverage"], 1.0)
        self.assertIn("a body block matched no text-layer line", result["faults"])


if __name__ == "__main__":
    unittest.main()
