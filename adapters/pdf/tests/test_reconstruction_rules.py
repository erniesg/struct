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
