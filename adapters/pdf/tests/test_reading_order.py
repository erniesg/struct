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

    def test_a_float_keeps_its_place_and_the_prose_moves_around_it(self):
        """A float the prose does not have to pass keeps its slot in the block
        list while the prose is permuted among the slots it already held."""
        blocks, page_layout = two_column_page()
        figure = block("fig", "figure", "Figure 1. A picture.", LEFT, 0.70, 0.8, 0.15)
        emitted = [figure, blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["fig", "l1", "l2", "l3", "r1", "r2", "r3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 1)

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

    def test_nothing_moves_around_a_paragraph_carried_onto_the_next_page(self):
        """A block belonging to two pages is held in place by the page this one
        has no evidence about. Leaving it where it is while the prose flows
        around it puts blocks between it and its continuation, which is the
        join this pass exists to make possible."""
        blocks, page_layout = two_column_page()
        blocks[5]["evidence"]["pages"] = [1, 2]  # the last paragraph runs on
        emitted = [blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertIn("a block would move across a heading, a float or a page-spanning paragraph",
                      result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["l1", "r1", "r2", "r3", "l2", "l3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_one_column_page_is_never_read_as_two(self):
        """Proof marks in the two margins are not two columns. This page is
        genuinely out of order, so only the two-column test stands between it
        and a repair."""
        blocks = [
            block("p1", "paragraph", "body one", LEFT, 0.10, 0.82, 0.10),
            block("qedl1", "paragraph", "\u25a1", 0.16, 0.22, 0.01, 0.01),
            block("qedl2", "paragraph", "\u25a1", 0.16, 0.42, 0.01, 0.01),
            block("p2", "paragraph", "body two", LEFT, 0.30, 0.82, 0.10),
            block("qedr1", "paragraph", "\u25a1", 0.86, 0.24, 0.01, 0.01),
            block("qedr2", "paragraph", "\u25a1", 0.86, 0.44, 0.01, 0.01),
        ]
        lines = [line("a", LEFT, 0.11, 0.82), line("q", 0.16, 0.22, 0.01),
                 line("q", 0.86, 0.24, 0.01), line("b", LEFT, 0.30, 0.82),
                 line("q", 0.16, 0.42, 0.01), line("q", 0.86, 0.44, 0.01)]
        emitted = [blocks[0], blocks[1], blocks[3], blocks[4], blocks[2], blocks[5]]
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertIn("the two sides are not one measure", result["faults"])
        self.assertGreater(result["inversions"], 0)
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks],
                         ["p1", "qedl1", "p2", "qedr1", "qedl2", "qedr2"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_margin_notes_beside_a_wide_body_are_not_a_column(self):
        """Notes in a narrow left margin, body in the right two thirds. Both
        arbiters read columns column-major, which hoists every note out of the
        text it annotates."""
        notes = [block(f"n{n}", "paragraph", f"note {n}", 0.06, y, 0.20, 0.06)
                 for n, y in enumerate((0.12, 0.42))]
        body = [block(f"b{n}", "paragraph", f"body {n}", 0.46, y, 0.46, 0.20)
                for n, y in enumerate((0.10, 0.34, 0.60))]
        lines = []
        for n, y in enumerate((0.10, 0.34, 0.60)):
            if n < 2:
                lines.append(line(f"note {n}", 0.06, (0.12, 0.42)[n], 0.20))
            lines += [line(f"body {n}", 0.46, y + 0.02 * k, 0.46) for k in range(3)]
        emitted = [body[0], notes[0], body[1], notes[1], body[2]]
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertIn("the two sides are not one measure", result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["b0", "n0", "b1", "n1", "b2"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_nothing_moves_across_a_heading(self):
        """A full-width section heading whose glyph box is short and left
        aligned reads as a left-column block, so neither arbiter sees the band
        it opens. Both can then agree on reading the page column-major straight
        through it, and the layout model, which had it right, loses."""
        above = [block("La", "paragraph", "left above", LEFT, 0.08, COLUMN, 0.12),
                 block("Ra", "paragraph", "right above", RIGHT, 0.08, COLUMN, 0.12)]
        head = block("head", "heading", "3 Method", LEFT, 0.24, 0.22, 0.02)
        below = [block("Lb", "paragraph", "left below", LEFT, 0.30, COLUMN, 0.30),
                 block("Rb", "paragraph", "right below", RIGHT, 0.30, COLUMN, 0.30)]
        lines = ([line("la", LEFT, 0.08 + 0.02 * n) for n in range(3)]
                 + [line("head", LEFT, 0.24, 0.22)]
                 + [line("lb", LEFT, 0.30 + 0.02 * n) for n in range(3)]
                 + [line("ra", RIGHT, 0.08 + 0.02 * n) for n in range(3)]
                 + [line("rb", RIGHT, 0.30 + 0.02 * n) for n in range(3)])
        emitted = [above[0], above[1], head, below[0], below[1]]  # the correct order
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertTrue(result["geometryAgrees"])  # both arbiters, and both wrong
        self.assertIn("a block would move across a heading, a float or a page-spanning paragraph",
                      result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["La", "Ra", "head", "Lb", "Rb"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_right_to_left_page_is_left_alone(self):
        """`geometric_order` reads the left column first. On a page set in an
        RTL script that is the wrong column, and poppler may agree with it."""
        blocks, page_layout = two_column_page()
        for entry in page_layout[0]["lines"]:
            entry["text"] = "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"
        emitted = [blocks[3], blocks[4], blocks[5], blocks[0], blocks[1], blocks[2]]
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertIn("the page is not left-to-right", result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["r1", "r2", "r3", "l1", "l2", "l3"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_heading_that_abuts_the_paragraph_under_it_is_not_a_merged_span(self):
        """The band check is for a box over both columns. A full-width heading
        whose box runs a point or two into the paragraph below it is an
        ordinary heading, and must not disqualify the page."""
        head = block("head", "heading", "References", 0.30, 0.20, 0.40, 0.02)
        blocks = [
            block("l1", "paragraph", "left one", LEFT, 0.2185, COLUMN, 0.15),
            block("l2", "paragraph", "left two", LEFT, 0.40, COLUMN, 0.15),
            block("r1", "paragraph", "right one", RIGHT, 0.2185, COLUMN, 0.15),
            block("r2", "paragraph", "right two", RIGHT, 0.40, COLUMN, 0.15),
        ]
        lines = [line("References", 0.30, 0.20, 0.40)]
        for x in (LEFT, RIGHT):
            for y in (0.2185, 0.40):
                lines += [line("t", x, y + 0.02 * n) for n in range(3)]
        page_layout = layout(lines)
        box = head["evidence"]["boxes"][0]
        overlap = (box["y"] + box["height"] - blocks[0]["evidence"]["boxes"][0]["y"]) * HEIGHT
        self.assertGreater(overlap, 1.0)
        self.assertLess(overlap, 4.0)
        emitted = [head, blocks[0], blocks[2], blocks[3], blocks[1]]
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertNotIn("full-width block overlaps a column block", result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["head", "l1", "l2", "r1", "r2"])
        self.assertEqual(a.report.reading_order_pages_repaired, 1)


    def test_a_full_width_float_bounds_the_prose_around_it(self):
        """A figure spanning both columns splits the page into two stacks. It
        carries no text, so poppler sees two uninterrupted columns and reads
        them straight through; it is not prose, so the band model never sees it
        either. Both arbiters then agree on an order that walks the whole left
        column past the figure."""
        above = [block("L1", "paragraph", "left above", LEFT, 0.08, COLUMN, 0.12),
                 block("L2", "paragraph", "left above two", LEFT, 0.21, COLUMN, 0.12),
                 block("R1", "paragraph", "right above", RIGHT, 0.08, COLUMN, 0.12),
                 block("R2", "paragraph", "right above two", RIGHT, 0.21, COLUMN, 0.12)]
        figure = block("FIG", "figure", "Figure 1. Spanning both columns.", LEFT, 0.37, 0.83, 0.16)
        below = [block("L3", "paragraph", "left below", LEFT, 0.57, COLUMN, 0.12),
                 block("L4", "paragraph", "left below two", LEFT, 0.70, COLUMN, 0.12),
                 block("R3", "paragraph", "right below", RIGHT, 0.57, COLUMN, 0.12),
                 block("R4", "paragraph", "right below two", RIGHT, 0.70, COLUMN, 0.12)]
        lines = []
        for x in (LEFT, RIGHT):
            for y in (0.08, 0.21, 0.57, 0.70):
                lines += [line("t", x, y + 0.02 * n) for n in range(3)]
        emitted = above[:2] + above[2:] + [figure] + below[:2] + below[2:]  # the correct order
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertTrue(result["geometryAgrees"])  # both arbiters, and both wrong
        self.assertIn("a block would move across a heading, a float or a page-spanning paragraph",
                      result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks],
                         ["L1", "L2", "R1", "R2", "FIG", "L3", "L4", "R3", "R4"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_wide_block_reaching_into_the_margin_leaves_it_a_margin(self):
        """The measure of a side is its median block, not its widest: one wide
        block that happens to start in the margin must not turn the margin into
        a column."""
        wide = block("cap", "paragraph", "a standfirst across the measure", 0.06, 0.03, 0.38, 0.04)
        notes = [block(f"n{n}", "paragraph", f"note {n}", 0.06, y, 0.20, 0.06)
                 for n, y in enumerate((0.12, 0.42))]
        body = [block(f"b{n}", "paragraph", f"body {n}", 0.46, y, 0.46, 0.20)
                for n, y in enumerate((0.10, 0.34, 0.60))]
        lines = [line("standfirst", 0.06, 0.03, 0.38)]
        for n, y in enumerate((0.10, 0.34, 0.60)):
            if n < 2:
                lines.append(line(f"note {n}", 0.06, (0.12, 0.42)[n], 0.20))
            lines += [line(f"body {n}", 0.46, y + 0.02 * k, 0.46) for k in range(3)]
        emitted = [wide, body[0], notes[0], body[1], notes[1], body[2]]
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertIn("the two sides are not one measure", result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["cap", "b0", "n0", "b1", "n1", "b2"])
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_a_full_width_heading_opens_a_band(self):
        """The columns above a full-width heading and the columns below it are
        two bands, read one after the other. Without that the page is one pair
        of columns and the order is wrong on both sides of the heading."""
        blocks = [
            block("L1", "paragraph", "left above", LEFT, 0.08, COLUMN, 0.30),
            block("R1", "paragraph", "right above", RIGHT, 0.08, COLUMN, 0.30),
            block("H", "heading", "4 Results", 0.30, 0.45, 0.40, 0.02),
            block("L2", "paragraph", "left below", LEFT, 0.50, COLUMN, 0.30),
            block("R2", "paragraph", "right below", RIGHT, 0.50, COLUMN, 0.30),
        ]
        lines = ([line("la", LEFT, 0.08 + 0.02 * n) for n in range(3)]
                 + [line("ra", RIGHT, 0.08 + 0.02 * n) for n in range(3)]
                 + [line("4 Results", 0.30, 0.45, 0.40)]
                 + [line("lb", LEFT, 0.50 + 0.02 * n) for n in range(3)]
                 + [line("rb", RIGHT, 0.50 + 0.02 * n) for n in range(3)])
        emitted = [blocks[0], blocks[1], blocks[2], blocks[4], blocks[3]]  # R2 before L2
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertEqual(result["faults"], [])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["L1", "R1", "H", "L2", "R2"])
        self.assertEqual(a.report.reading_order_pages_repaired, 1)

    def test_the_heading_guard_is_a_partition_not_a_count(self):
        """Blocks may not be exchanged across a heading even when the number
        before it is unchanged. The right column above the heading and the left
        column below it is a shape where the counts match and the sets do not,
        and the two-column model has no way to be sure which band is which."""
        above = [block("B1", "paragraph", "right above", RIGHT, 0.10, COLUMN, 0.12),
                 block("B2", "paragraph", "right above two", RIGHT, 0.24, COLUMN, 0.12)]
        head = block("H", "heading", "5 Discussion", 0.30, 0.45, 0.40, 0.02)
        below = [block("A1", "paragraph", "left below", LEFT, 0.52, COLUMN, 0.12),
                 block("A2", "paragraph", "left below two", LEFT, 0.66, COLUMN, 0.12)]
        lines = ([line("b", RIGHT, 0.10 + 0.02 * n) for n in range(3)]
                 + [line("b", RIGHT, 0.24 + 0.02 * n) for n in range(3)]
                 + [line("5 Discussion", 0.30, 0.45, 0.40)]
                 + [line("a", LEFT, 0.52 + 0.02 * n) for n in range(3)]
                 + [line("a", LEFT, 0.66 + 0.02 * n) for n in range(3)])
        emitted = [below[0], below[1], head, above[0], above[1]]
        page_layout = layout(lines)
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertEqual(result["doclingOrder"].index(2), result["textOrder"].index(2))
        self.assertIn("a block would move across a heading, a float or a page-spanning paragraph",
                      result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["A1", "A2", "H", "B1", "B2"])

    def test_a_two_column_bibliography_is_put_back_in_order(self):
        """The shape the layout model fails on most often, and the one the
        join counter cannot see: list items, not paragraphs."""
        heading = block("H", "heading", "References", 0.30, 0.06, 0.40, 0.02)
        left = [block(f"l{n}", "list-item", f"[{n}] left entry", LEFT, y, width, 0.05)
                # one short entry: the measure of a side is its median block,
                # not its narrowest one either
                for n, (y, width) in enumerate(((0.12, COLUMN), (0.20, 0.18), (0.28, COLUMN)))]
        right = [block(f"r{n}", "list-item", f"[{n}] right entry", RIGHT, y, COLUMN, 0.05)
                 for n, y in enumerate((0.12, 0.20, 0.28))]
        lines = [line("References", 0.30, 0.06, 0.40)]
        for column in (left, right):
            for entry in column:
                box = entry["evidence"]["boxes"][0]
                lines += [line("e", box["x"], box["y"] + 0.015 * n, box["width"])
                          for n in range(2)]
        emitted = [heading, left[1], left[0], left[2], right[0], right[1], right[2]]
        page_layout = layout(lines)
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual([b["id"] for b in a.blocks], ["H", "l0", "l1", "l2", "r0", "r1", "r2"])
        self.assertEqual(a.report.reading_order_pages_repaired, 1)


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
        self.assertTrue(reading_order.split_lines({"lines": [0, 1, 2, 30, 31]}))
        self.assertFalse(reading_order.split_lines({"lines": [4, 5, 6, 7]}))
        # a box over two columns holds every other line of a long span
        self.assertTrue(reading_order.split_lines({"lines": list(range(0, 40, 2))}))
        # a paragraph with a footnote rule and a margin number inside it does not
        self.assertFalse(reading_order.split_lines({"lines": [0, 1, 2, 4, 6, 8, 9, 10]}))

    def test_a_scattered_block_stops_the_page_being_repaired(self):
        blocks, page_layout = two_column_page()
        # l3's box is stretched down the left column and picks up nothing else,
        # but the text layer gives it lines from both ends of the page
        blocks[2]["evidence"]["boxes"] = [dict(page=1, x=LEFT, y=0.50, width=COLUMN, height=0.45)]
        page_layout[0]["lines"].append(line("stray", LEFT, 0.92))
        emitted = [blocks[0], blocks[3], blocks[4], blocks[5], blocks[1], blocks[2]]
        result = reading_order.compare_page(emitted, 1, page_layout[0])
        self.assertIn("a block's text-layer lines are not one run", result["faults"])
        a = adapter(emitted, page_layout)
        a._repair_column_order()
        self.assertEqual(a.report.reading_order_pages_repaired, 0)

    def test_one_block_on_a_side_is_not_a_column(self):
        def entry(position, x, width):
            return {"position": position, "boxes": [dict(page=1, x=x, y=0.1 * position,
                                                         width=width, height=0.05)]}
        both = [entry(0, LEFT, COLUMN), entry(1, LEFT, COLUMN),
                entry(2, RIGHT, COLUMN), entry(3, RIGHT, COLUMN)]
        self.assertIsNotNone(reading_order.geometric_order(both))
        self.assertIsNone(reading_order.geometric_order(both[:3]))
        self.assertIsNone(reading_order.geometric_order(both[1:]))

    def test_a_side_narrower_than_the_measure_minimum_is_not_a_column(self):
        def entry(x, width):
            return {"position": 0, "boxes": [dict(page=1, x=x, y=0.1, width=width, height=0.05)]}
        self.assertFalse(reading_order.measure_fault(
            [entry(LEFT, COLUMN), entry(LEFT, COLUMN), entry(RIGHT, COLUMN), entry(RIGHT, COLUMN)]))
        narrow = [entry(0.20, 0.12), entry(0.20, 0.12), entry(0.60, 0.12), entry(0.60, 0.12)]
        self.assertTrue(reading_order.measure_fault(narrow))

    def test_a_span_over_a_single_line_is_still_a_span(self):
        """The floor that lets a heading abut the paragraph under it must not
        blind the check to a box standing over one 8 pt line."""
        def entry(x, y, width, height):
            return {"position": 0, "boxes": [dict(page=1, x=x, y=y, width=width, height=height)]}
        one_line = entry(LEFT, 0.300, COLUMN, 0.008)     # 6.3 pt, under BAND_FLOOR
        span = entry(LEFT, 0.28, 0.83, 0.05)             # covers all of it
        self.assertTrue(reading_order.band_faults([span, one_line]))

    def test_a_page_carrying_a_right_to_left_quotation_is_left_alone(self):
        latin = "abcdefghijklmnopqrstuvwxyz"
        arabic = "\u0645\u0631\u062d\u0628\u0627"
        share = len(arabic) / (len(latin) + len(arabic))
        self.assertGreater(share, reading_order.RTL_SHARE)
        self.assertLess(share, 0.5)
        self.assertTrue(reading_order.rtl_fault([{"text": latin + " " + arabic}]))
        self.assertFalse(reading_order.rtl_fault([{"text": latin}]))

    def test_a_block_carried_over_the_column_break_owns_lines_in_both_columns(self):
        entry = {"position": 0, "lines": [], "boxes": [
            dict(page=1, x=LEFT, y=0.80, width=COLUMN, height=0.10),
            dict(page=1, x=RIGHT, y=0.08, width=COLUMN, height=0.10)]}
        page = dict(width=WIDTH, height=HEIGHT,
                    lines=[line("tail", LEFT, 0.82), line("head", RIGHT, 0.10)])
        lines, aspect = reading_order._normalized_lines(page)
        reading_order._assign([entry], lines, aspect)
        self.assertEqual(entry["lines"], [0, 1])

    def test_only_this_page_s_boxes_are_this_page_s_evidence(self):
        carried = block("p", "paragraph", "over the break", LEFT, 0.80, COLUMN, 0.10, pages=[1, 2])
        carried["evidence"]["boxes"].append(
            dict(page=2, x=LEFT, y=0.08, width=COLUMN, height=0.10, rotation=0))
        self.assertEqual([b["page"] for b in reading_order._page_boxes(carried, 1)], [1])
        self.assertEqual([b["page"] for b in reading_order._page_boxes(carried, 2)], [2])

    def test_a_block_is_full_width_only_when_it_crosses_the_whole_gutter(self):
        """The gutter is the middle tenth, and a full-width block crosses all
        of it. A block that merely straddles the midline is too narrow to be a
        band; nothing rests on that call, because a heading is a barrier
        whichever side it lands on."""
        self.assertEqual(reading_order._side(dict(x=0.44, y=0, width=0.12, height=0.01)), "full")
        self.assertEqual(reading_order._side(dict(x=0.47, y=0, width=0.06, height=0.01)), "left")
        self.assertEqual(reading_order._side(dict(x=0.44, y=0, width=0.06, height=0.01)), "left")
        self.assertEqual(reading_order._side(dict(x=0.50, y=0, width=0.06, height=0.01)), "right")

    def test_the_band_check_measures_against_the_column_block_and_a_floor(self):
        """A band that covers half a column block is a span over it. A heading
        four points into a single line under it is not — the ratio alone would
        call it one, which is why there is a floor as well."""
        def entry(x, y, width, height):
            return {"position": 0, "boxes": [dict(page=1, x=x, y=y, width=width, height=height)]}
        column = entry(LEFT, 0.30, COLUMN, 0.20)
        half = entry(LEFT, 0.20, 0.83, 0.20)          # covers 0.10 of a 0.20 block
        self.assertTrue(reading_order.band_faults([half, column]))
        line_block = entry(LEFT, 0.300, COLUMN, 0.015)
        heading = entry(LEFT, 0.28, 0.83, 0.026)      # 0.006 of the page, 40 % of one line
        self.assertGreater(0.006, reading_order.BAND_OVERLAP * 0.015)
        self.assertLess(0.006, reading_order.BAND_FLOOR)
        self.assertFalse(reading_order.band_faults([heading, line_block]))
        # a fifteen-thousandth of the page is over the floor and under twice it
        short = entry(LEFT, 0.300, COLUMN, 0.05)
        band = entry(LEFT, 0.27, 0.83, 0.045)         # 0.015 of the page, 30 % of the block
        self.assertTrue(reading_order.band_faults([band, short]))
        # and every column block is checked, not just the first
        far = entry(LEFT, 0.05, COLUMN, 0.05)
        self.assertTrue(reading_order.band_faults([band, far, short]))

    def test_the_line_tolerance_is_a_distance_not_a_fraction_of_the_width(self):
        """A tenth of a line's height is a physical distance. Applied to x
        without converting, it is a tenth narrower on a portrait page, and a
        line that overhangs its box by a hair stops belonging to it."""
        lines, aspect = reading_order._normalized_lines(
            dict(width=WIDTH, height=HEIGHT, lines=[line("x", LEFT, 0.10)]))
        self.assertAlmostEqual(aspect, HEIGHT / WIDTH)
        # 0.0017 of the page width is 1.04 pt: more than a tenth of a line
        # height read as a fraction of the width, less than it as a distance
        overhang = 0.0017
        page = dict(width=WIDTH, height=HEIGHT,
                    lines=[line("tail", LEFT + COLUMN + overhang - 0.001, 0.105, 0.002)])
        lines, aspect = reading_order._normalized_lines(page)
        entry = {"position": 0, "boxes": [dict(page=1, x=LEFT, y=0.10, width=COLUMN, height=0.05)],
                 "lines": []}
        reading_order._assign([entry], lines, aspect)
        self.assertEqual(entry["lines"], [0])

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
