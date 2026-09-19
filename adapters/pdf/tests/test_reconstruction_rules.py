"""Rules added while closing the 24 reader-gate failures: each test is the
source shape that failed, without corpus filenames in the rules."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import AdapterReport, StructAdapter  # noqa: E402
from ocr_region import short_word_share, undecodable_lines  # noqa: E402
import evaluate  # noqa: E402


def block(id, kind, text, x, y, width, height, page=1, **extra):
    return dict(id=id, kind=kind, text=text, page=page, inline=[], evidence=dict(
        boxes=[dict(page=page, x=x, y=y, width=width, height=height, rotation=0)], pages=[page], sourceIds=[id], signals=[]), **extra)


def adapter(blocks):
    a = StructAdapter.__new__(StructAdapter)
    a.blocks = blocks
    a.report = AdapterReport()
    a.relationships = []
    a.assets = []
    a.diagnostics = []
    a._attached_caption_boxes = {}
    a._ids = set()
    a.source_text = None
    a.doc = SimpleNamespace(pages={}, texts=[], pictures=[])
    a._page_text = lambda page: None
    return a


class RuledProseBoxes(unittest.TestCase):
    def test_formula_fragments_stay_one_column_of_rows(self):
        # a worked solution in a ruled box: prose lines and formula fragments at many x positions
        members = [block(f'm{i}', 'paragraph', text, x, y, .1, .012) for i, (x, y, text) in enumerate([
            (.1, .20, 'Using the numbers from the problem'), (.45, .23, 'u ='), (.55, .23, '100 W'), (.7, .23, '66400 cm'),
            (.1, .26, 'The volume of the sun is'), (.3, .29, 'P ='), (.4, .29, 'sigma T'), (.8, .29, '(1)'),
            (.1, .32, 'Solving for T, we get')])]
        a = adapter(list(members))
        caption = block('cap', 'caption', 'Table 10: A sample.', .1, .1, .8, .02)
        table = a._table_from_blocks(caption, 'Table 10', members, (.09, .19, .9, .34))['table']
        self.assertEqual(table['columns'], 1)
        self.assertEqual(len({c['id'] for c in table['cells']}), len(table['cells']))
        self.assertEqual(table['cells'][0]['text'], 'Using the numbers from the problem')


class FurnitureMerge(unittest.TestCase):
    def test_head_foot_and_stamp_are_not_united_into_one_page_box(self):
        blocks = [block(f'f{i}', 'furniture', f'furniture {i}', x, y, w, h) for i, (x, y, w, h) in enumerate([
            (.1, .03, .8, .02), (.04, .3, .03, .4), (.1, .95, .8, .02), (.1, .06, .3, .01), (.5, .96, .1, .01),
            (.1, .02, .1, .01), (.8, .02, .1, .01), (.2, .97, .1, .01), (.3, .97, .1, .01)])]
        a = adapter(blocks)
        a._compact_graph()
        merged = [b for b in a.blocks if b['kind'] == 'furniture']
        self.assertEqual(len(merged), 1)
        boxes = merged[0]['evidence']['boxes']
        self.assertTrue(all(box['y'] + box['height'] / 2 < 0.2 or box['y'] + box['height'] / 2 > 0.8 or box['x'] < 0.08 for box in boxes))


class FoldPanels(unittest.TestCase):
    def test_linked_words_beside_a_figure_stay_text(self):
        figure = block('fig', 'figure', 'Figure 1: Overview.', .2, .3, .6, .3, fallbackAssetIds=['a'])
        link = block('link', 'paragraph', 'Project page', .4, .6, .2, .01)
        link['inline'] = [dict(start=0, end=12, href='https://example.org/')]
        a = adapter([figure, link])
        a._crop_asset = Mock(return_value='new')
        a._gap_is_figure_like = Mock(return_value=True)
        a._caption_between = Mock(return_value=False)
        a.doc = SimpleNamespace(pages={}, texts=[], pictures=[])
        a._fold_panels_by_geometry()
        self.assertIn(link, a.blocks)
        a._crop_asset.assert_not_called()


class DuplicateCaptions(unittest.TestCase):
    def test_figure_takes_the_whole_caption_left_beside_it(self):
        figure = block('fig', 'figure', 'Figure 18 Here we explore the total', .2, .6, .6, .2, label='Figure 18')
        caption = block('cap', 'caption', 'Figure 18 Here we explore the total arbitrage possible.', .2, .82, .6, .02)
        a = adapter([figure, caption])
        a._drop_duplicate_captions()
        self.assertEqual(a.blocks, [figure])
        self.assertEqual(figure['text'], 'Figure 18 Here we explore the total arbitrage possible.')

    def test_a_different_caption_is_kept(self):
        figure = block('fig', 'figure', 'Figure 18 Here we explore', .2, .6, .6, .2, label='Figure 18')
        caption = block('cap', 'caption', 'Figure 19 Something else entirely.', .2, .82, .6, .02)
        a = adapter([figure, caption])
        a._drop_duplicate_captions()
        self.assertEqual(a.blocks, [figure, caption])


class ShortCaptions(unittest.TestCase):
    def test_label_only_figure_caption_reads_its_lines_and_absorbs_fragments(self):
        figure = block('fig', 'figure', 'Figure 5.', .1, .05, .8, .2, label='Figure 5')
        lead = block('lead', 'paragraph', 'The Capacity Hypothesis:', .15, .27, .2, .01)
        tail = block('tail', 'paragraph', 'different solutions (marked by outlined', .55, .27, .3, .01)
        star = block('star', 'paragraph', '⋆', .7, .285, .01, .007)
        body = block('body', 'paragraph', 'Recent work has demonstrated a power law.', .1, .4, .8, .1)
        a = adapter([figure, lead, tail, star, body])
        a._attached_caption_boxes['fig'] = dict(page=1, x=.1, y=.27, width=.04, height=.01)
        lines = [(.27, .28, 'Figure 5. The Capacity Hypothesis: If an optimal one exists, find', .9),
                 (.285, .295, 'different solutions (marked by outlined ⋆).', .9)]
        a._glyph_lines_in = Mock(return_value=lines)
        a._lines_in = Mock(return_value=[])
        a._absorb_block = lambda b: a.blocks.remove(b)
        a._complete_short_captions()
        self.assertEqual(a.blocks, [figure, body])
        self.assertTrue(figure['text'].startswith('Figure 5. The Capacity Hypothesis'))


class CropAssetEvidence(unittest.TestCase):
    def test_asset_evidence_does_not_share_the_blocks_box_list(self):
        from PIL import Image
        a = adapter([])
        evidence = dict(boxes=[dict(page=7, x=.1, y=.1, width=.5, height=.5)], pages=[7], sourceIds=['s'], signals=['x'])
        a._asset_from_image('figure', 'figure-x', Image.new('RGB', (20, 20), 'white'), evidence, ['s'])
        evidence['boxes'].append(dict(page=8, x=.1, y=.1, width=.5, height=.1))
        self.assertEqual(len(a.assets[0]['evidence']['boxes']), 1)


class UndecodableTextLayer(unittest.TestCase):
    def test_a_text_layer_missing_letters_reads_as_fragments(self):
        broken = ['Recen work has demons ra ed a power aw re a onsh p', 'be ween da a sca e and mode performance (Hes ness e a',
                  'of he en re n erne and a offl ne sc en fic measuremen s', 'one ough o converge o a very sma so u on se w h',
                  'wor d As more mode s are ra ned on n erne -sca e da a']
        prose = ['Recent work has demonstrated a power law relationship', 'between data scale and model performance (Hestness et al.,',
                 'of the entire internet and all offline scientific measurements', 'one ought to converge to a very small solution set with',
                 'world. As more models are trained on internet-scale data,']
        self.assertTrue(undecodable_lines(broken))
        self.assertFalse(undecodable_lines(prose))
        self.assertIsNone(short_word_share('two words'))

    def test_evaluator_excludes_only_runs_of_undecodable_lines(self):
        def line(y, text):
            return dict(xmin=10, xmax=90, ymin=y, ymax=y + 2, text=text)
        broken = [line(10 + 3 * i, 'Recen work has demons ra ed a power aw re a onsh p') for i in range(5)]
        regions = evaluate._undecodable_text_regions([dict(width=100.0, height=100.0, lines=broken), dict(width=100.0, height=100.0, lines=broken[:2])])
        self.assertEqual(sorted(regions), [1])
        self.assertEqual(len(regions[1]), 5)


class TableLabelledCharts(unittest.TestCase):
    def test_a_table_caption_on_a_region_without_text_rows_is_a_chart(self):
        draft = dict(blocks=[dict(kind='figure', text='Table 7: Accuracy on held-out set.', fallbackAssetIds=['a'],
                                  evidence=dict(boxes=[dict(page=1, x=.1, y=.1, width=.4, height=.3)])),
                             dict(kind='figure', text='Table 8: Scores.', fallbackAssetIds=['b'],
                                  evidence=dict(boxes=[dict(page=1, x=.5, y=.1, width=.4, height=.3)]))])
        grid = [(x, y, x + 20, y + 8, '1.0') for y in (100, 130, 160, 190) for x in (320, 380, 440)]
        with patch.object(evaluate, '_load_draft', return_value=draft), patch.object(evaluate, 'word_boxes', return_value=[grid]):
            found = evaluate._table_labels_without_text_rows(Path('x.pdf'), Path('d.json'), {'7', '8'}, {1: (600.0, 800.0)})
        self.assertEqual(found, {'7'})


if __name__ == '__main__':
    unittest.main()



class SideBySideTables(unittest.TestCase):
    @staticmethod
    def document(captions=("Table 1: Left.", "Table 2: Right.")):
        from docling_core.types.doc import BoundingBox, CoordOrigin, DoclingDocument, ProvenanceItem, Size, TableCell, TableData
        doc = DoclingDocument(name="synthetic")
        doc.add_page(1, Size(width=600.0, height=800.0))
        def cell(text, row, column, span=1):
            return TableCell(text=text, start_row_offset_idx=row, end_row_offset_idx=row + 1,
                             start_col_offset_idx=column, end_col_offset_idx=column + span, row_span=1, col_span=span,
                             bbox=BoundingBox(l=100 + 60 * column, t=700 - 20 * row, r=150 + 60 * column, b=680 - 20 * row, coord_origin=CoordOrigin.BOTTOMLEFT))
        cells = [cell(captions[0], 0, 0, 2), cell(captions[1], 0, 2, 2)]
        for row, values in enumerate([("Policy", "Score", "Policy", "Rate"), ("A", "1.0", "A", "2%"), ("B", "2.0", "B", "3%")], start=1):
            cells += [cell(value, row, column) for column, value in enumerate(values)]
        doc.add_table(data=TableData(num_rows=4, num_cols=4, table_cells=cells),
                      prov=ProvenanceItem(page_no=1, charspan=(0, 0), bbox=BoundingBox(l=100, t=700, r=390, b=620, coord_origin=CoordOrigin.BOTTOMLEFT)))
        return doc

    def test_one_grid_with_two_captions_becomes_two_tables(self):
        from table_split import split_side_by_side_tables
        doc = self.document()
        self.assertEqual(split_side_by_side_tables(doc), 1)
        self.assertEqual(len(doc.tables), 2)
        first, second = doc.tables
        self.assertEqual([reference.resolve(doc).text for table in doc.tables for reference in table.captions],
                         ["Table 1: Left.", "Table 2: Right."])
        self.assertEqual((first.data.num_rows, first.data.num_cols), (3, 2))
        self.assertEqual([cell.text for cell in second.data.table_cells if cell.start_row_offset_idx == 0], ["Policy", "Rate"])
        body = [reference.cref for reference in doc.body.children]
        self.assertEqual(body, [doc.tables[0].self_ref, doc.tables[0].captions[0].cref,
                                doc.tables[1].self_ref, doc.tables[1].captions[0].cref])

    def test_a_single_caption_grid_is_left_alone(self):
        from table_split import split_side_by_side_tables
        doc = self.document(captions=("Table 1: Left.", "Continued"))
        self.assertEqual(split_side_by_side_tables(doc), 0)
        self.assertEqual(len(doc.tables), 1)


class ColumnGutters(unittest.TestCase):
    @staticmethod
    def page(entries):
        from pdf_text import Char, PageText
        chars = []
        for x, y, text in entries:
            for index, value in enumerate(text):
                if value != " ":
                    chars.append(Char(value, x + index * 5, 1000 - y - 10, x + index * 5 + 4, 1000 - y, "Times"))
        return PageText(1, 1000, 1000, chars)

    def test_two_columns_at_one_height_are_two_lines(self):
        page = self.page([(100, 100, "left column words"), (600, 100, "right column words")])
        self.assertEqual([line.text for line in page.lines], ["left column words", "right column words"])

    def test_one_column_stays_one_line(self):
        page = self.page([(100, 100, "one continuous line of words")])
        self.assertEqual([line.text for line in page.lines], ["one continuous line of words"])


class RecoveredPageLinks(unittest.TestCase):
    """A page the layout model dropped is read from the text layer; its links
    must be written in the same normalized shape as every other href, or the
    EPUB carries an invalid one and EPUBCheck fails the whole reconstruction."""

    @staticmethod
    def recover(uri, line):
        from pdf_links import SourceLink
        a = StructAdapter.__new__(StructAdapter)
        a.blocks, a.diagnostics, a._ids = [], [], set()
        a.report = AdapterReport()
        a.doc = SimpleNamespace(pages={1: object()})
        a.page_lines = [[line + " " + "filler " * 60]]
        a.links = [SourceLink(page=1, rect=(0, 0, 1, 1), uri=uri, kind="uri", words=[uri])]
        a._recover_dropped_pages()
        return [run["href"] for block in a.blocks for run in block["inline"]]

    def test_a_bracketed_target_is_percent_encoded(self):
        self.assertEqual(self.recover("https://example.org/a[b]c", "Data at https://example.org/a[b]c."),
                         ["https://example.org/a%5Bb%5Dc"])

    def test_an_ordinary_target_is_unchanged(self):
        self.assertEqual(self.recover("https://example.org/paper", "Data at https://example.org/paper."),
                         ["https://example.org/paper"])


class EvidenceBindsTheCode(unittest.TestCase):
    def test_every_rule_module_is_hashed_by_the_verifier(self):
        """The rules live in a module each: a manifest naming only the entry
        points would bind the evidence to a fraction of the code that wrote it."""
        from verify_outputs import adapter_code
        here = Path(__file__).resolve().parents[1]
        bound = {path.name for path in adapter_code()}
        for module in here.glob("rules_*.py"):
            self.assertIn(module.name, bound)
        for module in ("pdf2struct.py", "pdf2epub.py", "evaluate.py", "render.mjs", "pdf_text.py", "table_split.py", "overlap_repair.py"):
            self.assertIn(module, bound)


class SentenceRunsOn(unittest.TestCase):
    """A bracket that closes an aside is not the end of the sentence."""

    @staticmethod
    def runs_on(text):
        from adapter_common import sentence_runs_on
        return sentence_runs_on(text)

    def test_an_aside_opened_mid_sentence_leaves_it_open(self):
        self.assertTrue(self.runs_on("along a path around the core the local configurations (the dyad in our spiral system)"))

    def test_an_aside_that_is_its_own_sentence_ends_the_text(self):
        self.assertFalse(self.runs_on("The proof follows the same lines. (It is given in Appendix B.)"))

    def test_an_aside_after_a_finished_sentence_ends_the_text(self):
        self.assertFalse(self.runs_on("The estimator is consistent. (see Appendix B)"))

    def test_an_ordinary_full_stop_still_ends_the_text(self):
        self.assertFalse(self.runs_on("The estimator is consistent for every sample size."))

    def test_an_unterminated_line_still_runs_on(self):
        self.assertTrue(self.runs_on("the local configurations of the order parameter"))


class CaptionRowInTheGrid(unittest.TestCase):
    def test_a_first_row_holding_the_caption_is_lifted_out(self):
        """A caption printed inside the table's ruled block is read as its
        first row: the table then owns no caption and the label resolves to
        nothing."""
        from docling_core.types.doc import BoundingBox, CoordOrigin, DoclingDocument, ProvenanceItem, TableCell, TableData
        from table_split import lift_caption_rows
        doc = DoclingDocument(name="t")
        doc.add_page(page_no=1, size=__import__("docling_core.types.doc", fromlist=["Size"]).Size(width=600, height=800))
        def cell(text, row, col, span=1):
            return TableCell(text=text, start_row_offset_idx=row, end_row_offset_idx=row + 1,
                             start_col_offset_idx=col, end_col_offset_idx=col + span, col_span=span, row_span=1,
                             bbox=BoundingBox(l=10 + col * 100, r=10 + (col + span) * 100, t=700 - row * 20, b=690 - row * 20, coord_origin=CoordOrigin.BOTTOMLEFT))
        cells = [cell("Table 1: Structural forms surveyed.", 0, 0, 2),
                 cell("Structure", 1, 0), cell("Section", 1, 1),
                 cell("Weighted sum", 2, 0), cell("Sec. 3.1", 2, 1)]
        table = doc.add_table(data=TableData(num_rows=3, num_cols=2, table_cells=cells),
                              prov=ProvenanceItem(page_no=1, charspan=(0, 0), bbox=BoundingBox(l=10, r=210, t=700, b=650, coord_origin=CoordOrigin.BOTTOMLEFT)))
        self.assertEqual(lift_caption_rows(doc), 1)
        self.assertEqual(len(table.captions), 1)
        self.assertEqual(table.captions[0].resolve(doc).text, "Table 1: Structural forms surveyed.")
        self.assertEqual(table.data.num_rows, 2)
        self.assertNotIn("Table 1: Structural forms surveyed.", [c.text for c in table.data.table_cells])


class TableCaptionSides(unittest.TestCase):
    """Two tables stacked on a page, captions above: the upper grid can be
    given the caption printed below it, which belongs to the lower grid."""

    def build(self, settled_count):
        """`settled_count` tables captioned the way the paper sets them (above),
        plus one grid carrying the caption printed below it and the captionless
        grid that caption stands over."""
        blocks, boxes = [], {}
        for index in range(settled_count):
            name = f"t0{index}"
            blocks.append(block(name, "table", f"Table {index + 1}: An earlier table.", .1, .60, .8, .09, page=2 + index))
            boxes[name] = dict(page=2 + index, x=.1, y=.55, width=.8, height=.04, rotation=0)
        upper = block("t1", "table", "Table 5: The second table.", .1, .21, .8, .09)
        lower = block("t2", "table", "", .1, .39, .8, .05)
        boxes["t1"] = dict(page=1, x=.1, y=.32, width=.8, height=.05, rotation=0)
        blocks += [upper, lower]
        for entry in blocks:
            entry["table"] = {"rows": 2, "columns": 2, "cells": []}
        a = adapter(blocks)
        a._attached_caption_boxes = boxes
        a._fix_table_caption_sides()
        return upper, lower

    def test_the_caption_below_goes_to_the_table_it_stands_over(self):
        upper, lower = self.build(settled_count=2)
        self.assertEqual(upper["text"], "")
        self.assertEqual(lower["text"], "Table 5: The second table.")

    def test_a_split_vote_moves_nothing(self):
        """One caption above and one below says nothing about the convention:
        moving either would invent one and strip a correct caption."""
        upper, lower = self.build(settled_count=1)
        self.assertEqual(upper["text"], "Table 5: The second table.")
        self.assertEqual(lower["text"], "")

    def test_a_single_caption_moves_nothing(self):
        upper, lower = self.build(settled_count=0)
        self.assertEqual(upper["text"], "Table 5: The second table.")
        self.assertEqual(lower["text"], "")

    def test_the_nearest_grid_under_the_caption_takes_it(self):
        """Two captionless grids in tolerance: the caption belongs to the one it
        stands closest over, not the one the walk emitted first."""
        settled = [block(f"s{i}", "table", f"Table {i}: Earlier.", .1, .60, .8, .09, page=3 + i) for i in range(2)]
        upper = block("t1", "table", "Table 5: The second table.", .1, .21, .8, .09)
        far = block("far", "table", "", .1, .43, .8, .05)
        near = block("near", "table", "", .1, .375, .8, .05)
        for entry in settled + [upper, far, near]:
            entry["table"] = {"rows": 2, "columns": 2, "cells": []}
        a = adapter(settled + [upper, far, near])   # `far` is emitted before `near`
        a._attached_caption_boxes = {f"s{i}": dict(page=3 + i, x=.1, y=.55, width=.8, height=.04, rotation=0) for i in range(2)}
        a._attached_caption_boxes["t1"] = dict(page=1, x=.1, y=.32, width=.8, height=.05, rotation=0)
        a._fix_table_caption_sides()
        self.assertEqual(near["text"], "Table 5: The second table.")
        self.assertEqual(far["text"], "")

    def test_a_caption_above_its_own_table_is_left_alone(self):
        table = block("t1", "table", "Table 5: The only table.", .1, .21, .8, .09)
        table["table"] = {"rows": 2, "columns": 2, "cells": []}
        a = adapter([table])
        a._attached_caption_boxes = {"t1": dict(page=1, x=.1, y=.15, width=.8, height=.04, rotation=0)}
        a._fix_table_caption_sides()
        self.assertEqual(table["text"], "Table 5: The only table.")


class TrailingNoteMarker(unittest.TestCase):
    """A note marker set hard against the end of its line is raised far enough
    to band on its own; read as a line-opening marker it links nothing."""

    @staticmethod
    def markers(entries):
        from pdf_text import Char, PageText
        chars = []
        for x, y, text, raised in entries:
            for index, value in enumerate(text):
                if value == " ":
                    continue
                top = 1000 - y
                bottom = top - (6 if raised else 10)
                chars.append(Char(value, x + index * 5, bottom, x + index * 5 + 4, top, "Times"))
        return PageText(1, 1000, 1000, chars).markers

    def test_a_marker_after_a_line_takes_that_line_as_its_context(self):
        found = [m for m in self.markers([(100, 100, "CLASS v3.1.0", False), (163, 97, "7", True)]) if m.text == "7"]
        self.assertEqual(len(found), 1)
        self.assertFalse(found[0].at_line_start)
        self.assertTrue(found[0].left_context.endswith("v3.1.0"))

    def test_a_marker_opening_its_own_line_still_reads_as_one(self):
        found = [m for m in self.markers([(100, 100, "Some line of words", False), (100, 130, "7", True)]) if m.text == "7"]
        self.assertTrue(all(m.at_line_start for m in found))


class RuledFrontMatter(unittest.TestCase):
    """A journal's first page sets its article info and abstract in a band
    between two full-width rules. The layout model can walk the left cell, fall
    through to the body below the band and come back for the right cell."""

    @staticmethod
    def page_with_band(rules):
        from pdf_text import Rule
        return SimpleNamespace(rules=[Rule(x0=x0, y0=y, x1=x1, y1=y, width=w) for x0, y, x1, w in rules])

    def build(self, rules):
        info = block("b5", "heading", "ARTICLE INFO", .07, .214, .21, .01)
        keywords = block("b6", "paragraph", "Keywords: Network inference", .07, .242, .21, .08)
        heading = block("b7", "heading", "1. Introduction", .07, .572, .16, .01)
        intro = block("b8", "paragraph", "Networks provide a natural way to capture", .07, .588, .86, .10)
        label = block("b14", "heading", "ABSTRACT", .37, .215, .21, .01)
        abstract = block("b15", "paragraph", "Likelihood-based network models are often", .37, .242, .56, .27)
        a = adapter([info, keywords, heading, intro, label, abstract])
        a._page_text = lambda page: self.page_with_band(rules)
        a._hoist_ruled_front_matter()
        return [b["id"] for b in a.blocks]

    def test_the_band_is_printed_before_what_is_under_it(self):
        order = self.build([(.0714, .2127, .9286, .4), (.0714, .5366, .9286, .4)])
        self.assertEqual(order, ["b5", "b6", "b14", "b15", "b7", "b8"])

    def test_a_page_without_a_ruled_band_is_left_in_its_own_order(self):
        order = self.build([(.0714, .9434, .9286, .2)])
        self.assertEqual(order, ["b5", "b6", "b7", "b8", "b14", "b15"])


def docling_table(cells, columns, rows, captioned=False):
    from docling_core.types.doc import BoundingBox, CoordOrigin, DoclingDocument, ProvenanceItem, Size, TableCell, TableData
    doc = DoclingDocument(name="t")
    doc.add_page(page_no=1, size=Size(width=600, height=800))
    built = [TableCell(text=text, start_row_offset_idx=r0, end_row_offset_idx=r1,
                       start_col_offset_idx=c0, end_col_offset_idx=c1, col_span=c1 - c0, row_span=r1 - r0,
                       bbox=BoundingBox(l=10 + c0 * 100, r=10 + c1 * 100, t=700 - r0 * 20, b=700 - r1 * 20, coord_origin=CoordOrigin.BOTTOMLEFT))
              for text, r0, r1, c0, c1 in cells]
    box = BoundingBox(l=10, r=10 + columns * 100, t=700, b=700 - rows * 20, coord_origin=CoordOrigin.BOTTOMLEFT)
    table = doc.add_table(data=TableData(num_rows=rows, num_cols=columns, table_cells=built),
                          prov=ProvenanceItem(page_no=1, charspan=(0, 0), bbox=box))
    if captioned:
        caption = doc.add_text(label=__import__("docling_core.types.doc", fromlist=["DocItemLabel"]).DocItemLabel.CAPTION,
                               text="Table 9: The author's own caption.", orig="Table 9: The author's own caption.",
                               prov=ProvenanceItem(page_no=1, charspan=(0, 34), bbox=box))
        table.captions.append(caption.get_ref())
    return doc, table


class SideBySideSplitGuards(unittest.TestCase):
    def test_a_cell_reaching_across_both_halves_stops_the_split(self):
        """A row spanning both captions joins the halves: whatever the grid is,
        it is not two tables printed side by side, and clipping that cell would
        drop it from one half without a trace."""
        from table_split import split_side_by_side_tables
        # enough rows either side that the `len(cells) < 4` safety net cannot
        # abort the split for us: the boundary guard has to be what stops it
        cells = [("Table 1: Left.", 0, 1, 0, 2), ("Table 2: Right.", 0, 1, 2, 4),
                 ("a", 1, 2, 0, 1), ("b", 1, 2, 1, 2), ("c", 1, 2, 2, 3), ("d", 1, 2, 3, 4),
                 ("e", 2, 3, 0, 1), ("f", 2, 3, 1, 2), ("g", 2, 3, 2, 3), ("h", 2, 3, 3, 4),
                 ("i", 3, 4, 0, 1), ("j", 3, 4, 1, 2), ("k", 3, 4, 2, 3), ("l", 3, 4, 3, 4),
                 ("spans the boundary", 4, 5, 1, 3)]
        doc, _ = docling_table(cells, columns=4, rows=5)
        self.assertEqual(split_side_by_side_tables(doc), 0)
        self.assertEqual(len(doc.tables), 1)

    def test_a_grid_that_already_has_its_caption_is_left_alone(self):
        from table_split import split_side_by_side_tables
        cells = [("Table 1: Left.", 0, 1, 0, 2), ("Table 2: Right.", 0, 1, 2, 4),
                 ("a", 1, 2, 0, 1), ("b", 1, 2, 1, 2), ("c", 1, 2, 2, 3), ("d", 1, 2, 3, 4),
                 ("e", 2, 3, 0, 1), ("f", 2, 3, 1, 2), ("g", 2, 3, 2, 3), ("h", 2, 3, 3, 4),
                 ("i", 3, 4, 0, 1), ("j", 3, 4, 1, 2), ("k", 3, 4, 2, 3), ("l", 3, 4, 3, 4)]
        doc, table = docling_table(cells, columns=4, rows=4, captioned=True)
        self.assertEqual(split_side_by_side_tables(doc), 0)
        self.assertEqual(len(table.captions), 1)

    def test_a_grid_of_two_captions_still_splits(self):
        from table_split import split_side_by_side_tables
        cells = [("Table 1: Left.", 0, 1, 0, 2), ("Table 2: Right.", 0, 1, 2, 4),
                 ("a", 1, 2, 0, 1), ("b", 1, 2, 1, 2), ("c", 1, 2, 2, 3), ("d", 1, 2, 3, 4),
                 ("e", 2, 3, 0, 1), ("f", 2, 3, 1, 2), ("g", 2, 3, 2, 3), ("h", 2, 3, 3, 4)]
        doc, _ = docling_table(cells, columns=4, rows=3)
        self.assertEqual(split_side_by_side_tables(doc), 1)
        self.assertEqual(len(doc.tables), 2)


class CaptionRowGuards(unittest.TestCase):
    def test_a_caption_that_spans_into_the_row_below_is_not_lifted(self):
        """Shifting the grid up would leave that cell at row -1."""
        from table_split import lift_caption_rows
        cells = [("Table 1: Spans two rows.", 0, 2, 0, 2),
                 ("a", 1, 2, 0, 1), ("b", 1, 2, 1, 2), ("c", 2, 3, 0, 1), ("d", 2, 3, 1, 2)]
        doc, table = docling_table(cells, columns=2, rows=3)
        self.assertEqual(lift_caption_rows(doc), 0)
        self.assertTrue(all(cell.start_row_offset_idx >= 0 for cell in table.data.table_cells))

    def test_every_lifted_grid_keeps_valid_row_indices(self):
        from table_split import lift_caption_rows
        cells = [("Table 1: A caption row.", 0, 1, 0, 2),
                 ("Structure", 1, 2, 0, 1), ("Section", 1, 2, 1, 2),
                 ("Weighted sum", 2, 3, 0, 1), ("Sec. 3.1", 2, 3, 1, 2)]
        doc, table = docling_table(cells, columns=2, rows=3)
        self.assertEqual(lift_caption_rows(doc), 1)
        self.assertTrue(all(cell.start_row_offset_idx >= 0 for cell in table.data.table_cells))
        self.assertEqual(table.data.num_rows, 2)


class FrontMatterFullyDeferred(unittest.TestCase):
    def test_a_band_emitted_entirely_after_the_body_is_still_hoisted(self):
        """The same fault as the interleaved case, further gone."""
        from pdf_text import Rule
        heading = block("b7", "heading", "1. Introduction", .07, .572, .16, .01)
        intro = block("b8", "paragraph", "Networks provide a natural way", .07, .588, .86, .10)
        label = block("b14", "heading", "ABSTRACT", .37, .215, .21, .01)
        abstract = block("b15", "paragraph", "Likelihood-based network models", .37, .242, .56, .27)
        a = adapter([heading, intro, label, abstract])
        a._page_text = lambda page: SimpleNamespace(rules=[
            Rule(x0=.0714, y0=.2127, x1=.9286, y1=.2127, width=.4),
            Rule(x0=.0714, y0=.5366, x1=.9286, y1=.5366, width=.4)])
        a._hoist_ruled_front_matter()
        self.assertEqual([b["id"] for b in a.blocks], ["b14", "b15", "b7", "b8"])


class FurnitureExemptionIsCapped(unittest.TestCase):
    def test_a_running_head_cannot_excuse_every_copy_of_itself(self):
        """The byline exemption credits a line once. A head that leaked onto
        eight pages must still be reported, or the criterion cannot see the
        very fault it exists to catch."""
        draft = {"blocks": [dict(id=f"b{i}", kind="paragraph", text="The Journal of Results",
                                 page=i, evidence=dict(boxes=[dict(page=i, x=.1, y=.4, width=.8, height=.01)]))
                            for i in range(1, 9)]}
        import json, tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(draft, handle)
            path = Path(handle.name)
        self.assertEqual(evaluate._repeated_lines_set_in_body(path)["the journal of results"], 8)
        exemptions = evaluate._furniture_exemptions(path)
        self.assertEqual(exemptions["the journal of results"], 1, "only one occurrence may be excused")
        self.assertEqual(sum(exemptions.values()), 1)


class FigureCaptionSides(unittest.TestCase):
    """The figure-side twin of `TableCaptionSides`. Both ask the same question —
    which side does this paper print captions on — and both must refuse to
    answer it from a tied vote, or a correct caption is taken off the float
    that owns it."""

    @staticmethod
    def scene(votes):
        owns = block("fX", "figure", "Figure 1: a below-caption figure.", .1, .50, .8, .10)
        elsewhere = block("fY", "figure", "Figure 2: an above-caption figure.", .1, .80, .8, .10)
        bare = block("fZ", "figure", "", .1, .66, .8, .10)
        a = adapter([owns, elsewhere, bare])
        a._page_image = lambda page: None
        a._figure_caption_below = votes
        a._attached_caption_boxes = {"fX": dict(page=1, x=.1, y=.61, width=.8, height=.04, rotation=0),
                                     "fY": dict(page=1, x=.1, y=.74, width=.8, height=.04, rotation=0)}
        a._fix_caption_sides()
        return owns, bare

    def test_a_tied_vote_moves_nothing(self):
        owns, bare = self.scene([True, False])
        self.assertEqual(owns["text"], "Figure 1: a below-caption figure.")
        self.assertEqual(bare["text"], "")

    def test_a_single_measured_caption_moves_nothing(self):
        owns, bare = self.scene([True])
        self.assertEqual(owns["text"], "Figure 1: a below-caption figure.")
        self.assertEqual(bare["text"], "")

    def test_a_clear_captions_above_paper_still_moves_the_wrong_side_caption(self):
        owns, bare = self.scene([False, False, True])
        self.assertEqual(owns["text"], "")
        self.assertEqual(bare["text"], "Figure 1: a below-caption figure.")


class CaptionSideVote(unittest.TestCase):
    def test_the_convention_is_read_only_from_a_clear_majority(self):
        from adapter_common import caption_side_is_below
        self.assertIsNone(caption_side_is_below([]))
        self.assertIsNone(caption_side_is_below([True]))
        self.assertIsNone(caption_side_is_below([True, False]))          # a tie says nothing
        self.assertIsNone(caption_side_is_below([True, False, True, False]))
        self.assertTrue(caption_side_is_below([True, True, False]))
        self.assertFalse(caption_side_is_below([False, False, True]))


class SmallCapitals(unittest.TestCase):
    """`\\textsc{Fuzzing}` reaches the text layer as `FUZZING`. The glyphs keep
    the distinction: the letters that were lowercase are drawn at about four
    fifths the height of the ones that were not."""

    @staticmethod
    def page(entries):
        """entries: (x, text, height) laid out on one line at y=100."""
        from pdf_text import Char, PageText
        # small capitals share the baseline and stop short of cap height
        chars, x, baseline = [], 0, 900.0
        for text, height in entries:
            for value in text:
                if value != " ":
                    chars.append(Char(value, x, baseline, x + 4, baseline + height, "NimbusRomNo9L-Regu"))
                x += 5
        return PageText(1, 1000, 1000, chars)

    BOX = dict(page=1, x=0.0, y=0.0, width=1.0, height=1.0, rotation=0)

    def restore(self, entries, text):
        from small_caps import restore_case
        return restore_case(self.page(entries), self.BOX, text)

    def test_reduced_capitals_were_lowercase(self):
        self.assertEqual(self.restore([("F", 8.55), ("UZZING", 6.84)], "FUZZING"), "Fuzzing")

    def test_a_heading_set_in_full_capitals_is_left_alone(self):
        """`\\MakeUppercase` draws every letter at one height: there is nothing
        to restore, and guessing would corrupt a real all-caps heading."""
        self.assertIsNone(self.restore([("FUZZING", 8.55)], "FUZZING"))

    def test_an_acronym_inside_a_small_caps_run_keeps_its_capitals(self):
        """The capitals the author typed stay capitals: only the reduced
        letters were lowercase."""
        self.assertEqual(self.restore([("SAE E", 8.55), ("VALUATION", 6.84)], "SAE EVALUATION"), "SAE Evaluation")

    def test_ordinary_mixed_case_text_is_untouched(self):
        """Lowercase heights say nothing: an `x` is shorter than an `h` in
        every font, and counting them makes ordinary prose look like small
        capitals. Only capitals are measured."""
        self.assertIsNone(self.restore([("The", 8.55), ("quick", 6.0)], "The quick"))

    def test_a_subscripted_capital_is_never_recased(self):
        """`P_X` is reduced but sits below the baseline. Lowercasing it would
        rewrite the paper's notation."""
        from pdf_text import Char, PageText
        from small_caps import restore_case
        chars = [Char("P", 0, 900.0, 4, 908.55, "F"), Char("X", 5, 896.0, 9, 902.0, "F")]
        page = PageText(1, 1000, 1000, chars)
        self.assertIsNone(restore_case(page, self.BOX, "PX"))

    def test_a_block_the_glyphs_do_not_cover_is_refused(self):
        """Half a word re-cased (`FuzzING`) is worse than the capitals it
        started from, so a block the glyphs run out on is left alone."""
        self.assertIsNone(self.restore([("F", 8.55), ("UZZ", 6.84)], "FUZZING AND MORE"))

    def test_a_block_never_opens_on_a_small_capital(self):
        """The first letter is the one the author capitalised; lowercasing it
        invents a paragraph that starts midway through a sentence."""
        self.assertEqual(self.restore([("F", 8.55), ("UZZING", 6.84)], "FUZZING")[0], "F")

    def test_text_that_does_not_match_the_glyphs_is_refused(self):
        """A block the layout model rewrote must not be re-cased on a guess."""
        self.assertIsNone(self.restore([("F", 8.55), ("UZZING", 6.84)], "DETECTION"))

    def test_restoring_case_keeps_the_length_so_inline_offsets_stay_valid(self):
        restored = self.restore([("F", 8.55), ("UZZING", 6.84)], "FUZZING")
        self.assertEqual(len(restored), len("FUZZING"))
