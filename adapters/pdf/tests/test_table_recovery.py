"""Table regressions derived from PDF geometry, without corpus filenames in rules."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import AdapterReport, StructAdapter


def block(kind, text, page, y, height=.05, x=.12, width=.76):
    box = dict(page=page, x=x, y=y, width=width, height=height, rotation=0)
    return dict(id=f'{kind}-{page}-{y}', kind=kind, text=text, page=page, inline=[],
                evidence=dict(boxes=[box], pages=[page], sourceIds=[f's-{page}-{y}'], signals=[]))


def table(page, y, height=.3):
    b = block('table', '', page, y, height)
    b['table'] = dict(rows=2, columns=2, cells=[], semantic='verified')
    return b


def adapter(blocks):
    a = StructAdapter.__new__(StructAdapter)
    a.blocks = blocks
    a.report = AdapterReport()
    a.relationships = []
    a.assets = []
    a.diagnostics = []
    a._attached_caption_boxes = {}
    a._ids = set()
    a._captions_below_tables = []
    a._crop_asset = lambda *args, **kw: None
    return a


class CaptionOwnership(unittest.TestCase):
    def test_caption_on_previous_page_owns_first_table(self):
        # Holdout p4 caption / p5 comparison table, repeated for p7 / p8.
        c, t = block('caption', 'Table 1: Contributions relative to prior work.', 4, .718, .012), table(5, .103)
        a = adapter([c, t])
        a._recover_uncaptured_tables()
        self.assertEqual(t.get('label'), 'Table 1')
        self.assertNotIn(c, a.blocks)
        self.assertIn(4, t['evidence']['pages'])

    def test_caption_on_next_page_owns_last_table(self):
        # Tuning p31 table / p32 caption precedes next appendix.
        t, c = table(31, .55), block('paragraph', 'Table 11 Non-arbitrage dependency patterns detected by the LLM.', 32, .12, .105)
        a = adapter([t, c])
        a._recover_uncaptured_tables()
        self.assertEqual(t.get('label'), 'Table 11')
        self.assertNotIn(c, a.blocks)

    def test_intervening_prose_blocks_cross_page_adoption(self):
        c, t = block('caption', 'Table 1: Comparison.', 4, .718), table(5, .103)
        prose = block('paragraph', 'This intervening paragraph discusses another experiment.', 4, .8)
        a = adapter([c, prose, t])
        a._recover_uncaptured_tables()
        self.assertFalse(t.get('label'))
        self.assertIn(prose, a.blocks)

    def test_long_caption_can_own_adjacent_grid(self):
        c, t = block('paragraph', 'Table 3. Comparison of datasets. ' + 'Detailed caption. ' * 80, 15, .35, .135), table(15, .1, .23)
        a = adapter([t, c])
        a._recover_uncaptured_tables()
        self.assertEqual(t.get('label'), 'Table 3')


class SemanticGrid(unittest.TestCase):
    def test_two_column_prose_comparison_is_not_bibliography(self):
        grid = [[SimpleNamespace(text=t) for t in row] for row in [
            ('Established before this paper', 'This paper adds'),
            ('Previous instruments measured the same task under other conditions.' * 2, 'We compare bias and separation inside the same frozen task snapshot.' * 2),
            ('Reporting checklists and preregistration proposals ' * 3, 'The instrument status items they lack ' * 4),
            ('Judges and benchmarks framed as measurement instruments ' * 2, 'An executed instrument validation campaign ' * 4)]]
        self.assertFalse(StructAdapter._grid_is_entry_list(grid))

    def test_four_columns_are_preserved_and_missing_row_does_not_shift_cells(self):
        members = [block('paragraph', text, 1, y, .02, x, .1)
                   for y, x, text in [(.2,.1,'Name'),(.2,.3,'A'),(.2,.5,'B'),(.2,.7,'C'),
                                     (.25,.1,'First'),(.25,.3,'1'),(.25,.7,'3'),
                                     (.3,.1,'Second'),(.3,.3,'4'),(.3,.5,'5'),(.3,.7,'6')]]
        a=adapter(members)
        c=block('caption','Table 1: Scores.',1,.1)
        result=a._table_from_blocks(c,'Table 1',members,(.1,.19,.8,.33))['table']
        self.assertEqual((result['rows'],result['columns']), (3,4))
        cells={(c['row'],c['column']):c['text'] for c in result['cells']}
        self.assertEqual(cells[(2,2)],'5')
        self.assertNotIn((1,2), cells)


class NativeGlyphGrid(unittest.TestCase):
    @staticmethod
    def page(entries):
        from pdf_text import Char, PageText, Rule
        chars=[]
        for x, y, text in entries:
            for i, char in enumerate(text):
                if char != ' ':
                    chars.append(Char(char, x+i*5, 1000-y-10, x+i*5+4, 1000-y, 'Times'))
        page=PageText(1,1000,1000,chars)
        page._rules=[Rule(.1,.1,.9,.1,1),Rule(.1,.125,.9,.125,.5),Rule(.1,.4,.9,.4,1)]
        return page

    def test_compact_value_column_anchors_wrapped_records(self):
        from source_tables import grid_from_source
        page=self.page([(110,110,'Description'),(650,110,'Value'),
                        (110,140,'First record starts here'),(650,140,'1.5'),(110,155,'and continues here'),
                        (110,180,'Second record'),(650,180,'2.5'),
                        (110,210,'Third record'),(650,210,'3.5')])
        grid=grid_from_source(page,(.1,.1,.9,.4),require_anchors=True,cell_boxes=[(110,860,400,835),(110,820,400,810),(110,790,400,780)])
        self.assertEqual((grid['rows'],grid['columns']),(4,2))
        cells={(c['row'],c['column']):c['text'] for c in grid['cells']}
        self.assertEqual(cells[(1,0)],'First record starts here and continues here')
        self.assertEqual(cells[(2,1)],'2.5')

    def test_wrapped_bibliography_without_record_anchors_is_not_repaired(self):
        from source_tables import grid_from_source
        page=self.page([(110,140,'Reference one'),(650,140,'A long citation and URL'),
                        (650,155,'https://arxiv.org/abs/'),(650,170,'2012.08040'),
                        (110,200,'Reference two'),(650,200,'Another long citation')])
        # Two identifiers are insufficient to establish a record cadence;
        # visual lines must not split the hyperlink into different cells.
        self.assertIsNone(grid_from_source(page,(.1,.1,.9,.4),require_anchors=True))

    def test_conflicting_span_keeps_the_later_cell(self):
        from docling_core.types.doc import DoclingDocument, TableItem, TableData, TableCell, DocItemLabel
        cells=[TableCell(text='Group',start_row_offset_idx=0,end_row_offset_idx=2,start_col_offset_idx=0,end_col_offset_idx=1,row_span=2,col_span=1),
               TableCell(text='Value',start_row_offset_idx=0,end_row_offset_idx=1,start_col_offset_idx=1,end_col_offset_idx=2,row_span=1,col_span=1),
               TableCell(text='Retained record',start_row_offset_idx=1,end_row_offset_idx=2,start_col_offset_idx=0,end_col_offset_idx=1,row_span=1,col_span=1)]
        item=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(num_rows=2,num_cols=2,table_cells=cells))
        a=StructAdapter(DoclingDocument(name='Test'),Path(__file__),'0'*64,[])
        a._emit_table(item)
        self.assertIn('Retained record',[c['text'] for c in a.blocks[0]['table']['cells']])
        self.assertEqual(a.report.table_cells_dropped,0)


class FramedContinuation(unittest.TestCase):
    def test_three_line_tail_uses_content_extent_without_height_floor(self):
        from pdf_text import Rule
        caption=block('caption','Table 37: Generated story.',60,.1494,.033)
        tail=block('code','First line.\nSecond line.\nThird line.',60,.1023,.0321)
        a=adapter([tail,caption])
        a._page_text=lambda page: SimpleNamespace(rules=[Rule(.12,.14,.88,.14,.8)])
        region=a._rule_box(60,caption['evidence']['boxes'][0],'above',caption,open_ended=True)
        self.assertIsNotNone(region)
        self.assertLessEqual(region[1],.1023)
        self.assertGreaterEqual(region[3],.1344)

    def test_closed_heavy_frame_does_not_absorb_prose_above_it(self):
        from pdf_text import Rule
        caption=block('caption','Table 1: Example.',1,.64,.03)
        prose=block('paragraph','Unrelated introduction.',1,.1,.12)
        body=block('code','Table content.',1,.34,.24)
        a=adapter([prose,body,caption])
        a._page_text=lambda page: SimpleNamespace(rules=[Rule(.12,.29,.88,.29,.8),Rule(.12,.32,.88,.32,.4),Rule(.12,.61,.88,.61,.8)])
        region=a._rule_box(1,caption['evidence']['boxes'][0],'above',caption,open_ended=True)
        self.assertEqual(region[1],.29)

    def test_same_page_code_is_not_claimed_as_prior_page_continuation(self):
        previous=block('code','An independent code example.',5,.1,.8)
        current=table(5,.85,.08)
        current['text']='Table 1: A separate framed object.'
        current['label']='Table 1'
        current['evidence']['signals']=['rule-box']
        current['table']={'rows':1,'columns':1,'cells':[{'id':'c0-0','row':0,'column':0,'text':'Separate.'}]}
        a=adapter([previous,current]);a._merge_continued_tables()
        self.assertIn(previous,a.blocks)
        self.assertEqual(current['table']['rows'],1)

    def test_outer_frame_segments_join_across_spanning_row_boundary(self):
        from pdf_text import Rule
        caption=block('caption','Table 3: A grid and spanning prose rows.',1,.71,.05)
        a=adapter([caption])
        a._page_text=lambda page: SimpleNamespace(rules=[Rule(.12,.53,.88,.53,.5),Rule(.12,.606,.88,.606,.5),Rule(.12,.70,.88,.70,.5),Rule(.12,.53,.12,.606,.5),Rule(.12,.606,.12,.70,.5)])
        region=a._rule_box(1,caption['evidence']['boxes'][0],'above',caption)
        self.assertEqual(region,(.12,.53,.88,.70))

    def test_framed_text_table_retains_previous_page_code_as_cells(self):
        previous=block('code','Earlier story text remains intact.',5,.1,.8)
        current=table(6,.1,.3)
        current['text']='Table 1: A story.'
        current['label']='Table 1'
        current['evidence']['signals']=['rule-box']
        current['table']={'rows':1,'columns':1,'cells':[{'id':'c0-0','row':0,'column':0,'text':'Ending.'}]}
        a=adapter([previous,current]);a._merge_continued_tables()
        self.assertEqual([c['text'] for c in current['table']['cells']],['Earlier story text remains intact.','Ending.'])
        self.assertEqual(current['evidence']['pages'],[5,6])


class CaptionPrepass(unittest.TestCase):
    def test_embedded_note_caption_is_split_only_at_attested_source_line(self):
        from docling_core.types.doc import DoclingDocument, DocItemLabel, ProvenanceItem, BoundingBox, CoordOrigin, TableData, Size
        from source_tables import reconcile_table_captions
        def prov(top,bottom):
            return ProvenanceItem(page_no=1,bbox=BoundingBox(l=100,t=1000-top,r=900,b=1000-bottom,coord_origin=CoordOrigin.BOTTOMLEFT),charspan=(0,100))
        doc=DoclingDocument(name='Source')
        doc.add_page(page_no=1,size=Size(width=1000,height=1000))
        grid=doc.add_table(data=TableData(),prov=prov(100,250))
        note=doc.add_text(label=DocItemLabel.FOOTNOTE,text='* Some runs failed. Table 10: Summary of trajectories.',prov=prov(260,315),parent=grid)
        page=NativeGlyphGrid.page([(110,300,'Table 10: Summary of trajectories.')])
        a=StructAdapter(doc,Path(__file__),'0'*64,[],source_text=SimpleNamespace(available=True,page=lambda _:page))
        reconcile_table_captions(a)
        self.assertEqual(note.text,'* Some runs failed.')
        self.assertEqual(grid.captions[0].resolve(doc).text,'Table 10: Summary of trajectories.')


class ReviewRegressions(unittest.TestCase):
    def test_blank_value_record_cannot_merge_with_previous_record(self):
        from source_tables import grid_from_source
        page=NativeGlyphGrid.page([(110,110,'Record'),(650,110,'Value'),
                                  (110,140,'First independent record'),(650,140,'1.5'),
                                  (110,160,'Second independent record'),
                                  (110,180,'Third independent record'),(650,180,'3.5'),
                                  (110,200,'Fourth independent record'),(650,200,'4.5')])
        self.assertIsNone(grid_from_source(page,(.1,.1,.9,.4),require_anchors=True))
        grid=grid_from_source(page,(.1,.1,.9,.4))
        self.assertEqual(grid['rows'],5)

    def test_glyph_recovery_keeps_member_and_caption_links(self):
        page=NativeGlyphGrid.page([(110,110,'Record'),(650,110,'Value'),
                                  (110,140,'First row'),(650,140,'1.5'),
                                  (110,180,'Second row'),(650,180,'2.5'),
                                  (110,210,'Third row'),(650,210,'3.5')])
        member=block('paragraph','First row',1,.14,.01,.11,.06)
        member['inline']=[dict(start=0,end=9,href='https://example.org/row')]
        caption=block('caption','Table 1: Linked caption.',1,.41)
        caption['inline']=[dict(start=9,end=15,href='https://example.org/caption')]
        a=adapter([member]);a.source_text=SimpleNamespace(available=True,page=lambda _:page)
        result=a._table_from_blocks(caption,'Table 1',[member],(.1,.1,.9,.4))
        self.assertEqual(result['inline'],caption['inline'])
        row=next(c for c in result['table']['cells'] if c['text']=='First row')
        self.assertEqual(row['inline'],member['inline'])

    def test_unlabelled_grid_releases_attached_result_prose(self):
        from docling_core.types.doc import DoclingDocument, DocItemLabel, ProvenanceItem, BoundingBox, CoordOrigin, TableData, Size
        from source_tables import reconcile_table_captions
        doc=DoclingDocument(name='Source')
        doc.add_page(page_no=1,size=Size(width=1000,height=1000))
        grid=doc.add_table(data=TableData(),prov=ProvenanceItem(page_no=1,bbox=BoundingBox(l=100,t=800,r=900,b=500,coord_origin=CoordOrigin.BOTTOMLEFT),charspan=(0,0)))
        prose=doc.add_text(label=DocItemLabel.TEXT,text='Result. Coverage was complete in every run.',parent=grid,
                           prov=ProvenanceItem(page_no=1,bbox=BoundingBox(l=100,t=850,r=900,b=820,coord_origin=CoordOrigin.BOTTOMLEFT),charspan=(0,43)))
        grid.captions=[prose.get_ref()]
        a=StructAdapter(doc,Path(__file__),'0'*64,[])
        reconcile_table_captions(a)
        self.assertEqual(grid.captions,[])
        self.assertEqual(prose.parent.cref,doc.body.self_ref)
        self.assertIn(prose.get_ref(),doc.body.children)
        self.assertEqual(prose.text,'Result. Coverage was complete in every run.')


    def test_framed_prose_fields_follow_native_sentence_order(self):
        from source_tables import prose_grid_from_source
        page=NativeGlyphGrid.page([(110,110,'Prompt for role generation'),
                                  (110,140,'You are an experienced creative writing tutor skilled in creating roles.'),
                                  (110,155,'You should follow these source fields in the order that they are written.'),
                                  (110,175,'Character: {character}'),
                                  (110,190,'MBTI personality type: {MBTI}'),
                                  (110,205,'Speaking style: {style}'),
                                  (110,235,'You need to construct a new setting and retain all placeholders exactly.')])
        grid=prose_grid_from_source(page,(.1,.1,.9,.4))
        self.assertEqual(grid['columns'],1)
        text=' '.join(c['text'] for c in grid['cells'])
        self.assertIn('Character: {character} MBTI personality type: {MBTI} Speaking style: {style}',text)
        self.assertEqual(grid['cells'][0]['text'],'Prompt for role generation')

    def test_rule_delimited_group_label_spans_its_measurement_rows(self):
        from pdf_text import Rule
        from source_tables import grid_from_source
        page=NativeGlyphGrid.page([(110,110,'Story'),(500,110,'POS'),(650,110,'Value'),
                                  (110,140,'First story'),(500,140,'Noun'),(650,140,'18'),
                                  (500,160,'Verb'),(650,160,'3'),
                                  (110,200,'Second story'),(500,200,'Noun'),(650,200,'8'),
                                  (500,220,'Verb'),(650,220,'7')])
        page._rules.append(Rule(.1,.185,.9,.185,.5))
        grid=grid_from_source(page,(.1,.1,.9,.4))
        labels=[c for c in grid['cells'] if c['column']==0 and c['headerScope'] is None]
        self.assertEqual([(c['text'],c['row'],c['rowSpan'])for c in labels],[('First story',1,2),('Second story',3,2)])


    def test_appendix_table_caption_is_not_released_as_prose(self):
        from docling_core.types.doc import DoclingDocument, DocItemLabel, TableData
        from source_tables import reconcile_table_captions
        doc=DoclingDocument(name='Source')
        grid=doc.add_table(data=TableData())
        caption=doc.add_text(label=DocItemLabel.CAPTION,text='Table A.1: Appendix parameters.',parent=grid)
        grid.captions=[caption.get_ref()]
        a=StructAdapter(doc,Path(__file__),'0'*64,[])
        reconcile_table_captions(a)
        self.assertEqual(grid.captions,[caption.get_ref()])


class RecoveredInlineOccurrences(unittest.TestCase):
    def test_repeated_labels_keep_their_original_offsets_and_relationship_owner(self):
        from unittest.mock import patch
        member=block('paragraph','same same',1,.2,.02)
        member['inline']=[dict(start=0,end=4,href='https://example.org/one'),
                          dict(start=5,end=9,targetIds=['note'],relationshipId='rel')]
        caption=block('caption','Table 1: Caption.',1,.1)
        caption['inline']=[dict(start=9,end=16,targetIds=['note'],relationshipId='caption-rel')]
        cell=dict(id='c0-0',text='same same',row=0,column=0,rowSpan=1,columnSpan=1,headerScope=None,inline=[],evidence=member['evidence'])
        a=adapter([member,caption]);a.source_text=True;a._page_text=lambda _:None
        a.relationships=[dict(id='rel',kind='footnote',**{'from':member['id'],'to':['note']}),
                         dict(id='caption-rel',kind='footnote',**{'from':caption['id'],'to':['note']})]
        with patch('source_tables.grid_from_source',return_value=dict(rows=1,columns=1,cells=[cell])):
            recovered=a._table_from_blocks(caption,'Table 1',[member],(.1,.19,.9,.23))
        self.assertEqual([(r['start'],r['end'])for r in cell['inline']],[(0,4),(5,9)])
        self.assertEqual([r['from']for r in a.relationships],[recovered['id']]*2)
        a.blocks=[recovered,block('footnote','A note',1,.8)];a.blocks[1]['id']='note'
        a._prune_dangling_references()
        self.assertEqual(len(a.relationships),2)
        self.assertEqual(cell['inline'][1]['relationshipId'],'rel')

    def test_equal_labels_in_different_cells_use_source_geometry_once(self):
        from source_tables import migrate_cell_runs
        original=block('paragraph','same',1,.3,.02,.6,.1)
        original['inline']=[dict(start=0,end=4,href='https://example.org/only')]
        cells=[dict(text='same',inline=[],evidence=block('paragraph','same',1,.2,.02,.1,.1)['evidence']),
               dict(text='same',inline=[],evidence=original['evidence'])]
        self.assertEqual(migrate_cell_runs([original],cells),[])
        self.assertEqual(cells[0]['inline'],[])
        self.assertEqual(cells[1]['inline'],original['inline'])

    def test_equal_geometry_and_text_refuses_duplicate_link_placement(self):
        from source_tables import migrate_cell_runs
        original=block('paragraph','same',1,.3)
        original['inline']=[dict(start=0,end=4,href='https://example.org/only')]
        cells=[dict(text='same',inline=[],evidence=original['evidence'])for _ in range(2)]
        self.assertEqual(len(migrate_cell_runs([original],cells)),1)
        self.assertTrue(all(not c['inline']for c in cells))


class SplitCollapsedRowsTests(unittest.TestCase):
    @staticmethod
    def cells(rows):
        return [dict(id=f'c{r}-{c}', text=text, row=r, column=c, rowSpan=1, columnSpan=1, headerScope=None, inline=[], evidence={})
                for r, row in enumerate(rows) for c, text in enumerate(row) if text is not None]

    def test_collapsed_records_split_by_a_value_column(self):
        from source_tables import split_collapsed_rows
        extracted = self.cells([['Quantity', 'Value'], ['same-day pairs cross-day pairs', '0.805 0.800']])
        source = dict(rows=3, columns=2, cells=self.cells([['Quan', 'tity Value'], ['same-day pairs', '0.805'], ['cross-day pairs', '0.800']]))
        split = split_collapsed_rows(extracted, source)
        self.assertIsNotNone(split)
        self.assertEqual([c['text'] for c in split if c['row'] == 0], ['Quantity', 'Value'])  # extracted header kept
        self.assertEqual(sorted((c['row'], c['text']) for c in split if c['column'] == 1 and c['row']), [(1, '0.805'), (2, '0.800')])

    def test_wrapped_label_lines_are_not_records(self):
        from source_tables import split_collapsed_rows
        extracted = self.cells([['Model', 'Story'], ['MEGATRON- CNTRL-8B', 'she was driving. all of a sudden']])
        source = dict(rows=3, columns=2, cells=self.cells([['Model', 'Story'], ['MEGATRON-', 'she was driving. all'], ['CNTRL-8B', 'of a sudden']]))
        self.assertIsNone(split_collapsed_rows(extracted, source))

    def test_prose_rows_without_a_value_column_are_kept(self):
        from source_tables import split_collapsed_rows
        extracted = self.cells([['Domain', 'Task'], ['Creative writing', 'Content writing Polishing']])
        source = dict(rows=3, columns=2, cells=self.cells([['Domain', 'Task'], ['Creative', 'Content writing'], ['writing', 'Polishing']]))
        self.assertIsNone(split_collapsed_rows(extracted, source))

    def test_a_column_shift_is_refused(self):
        from source_tables import split_collapsed_rows
        extracted = self.cells([['M1', 'M2', 'cos'], ['gra. gtr', 'clip', '0.78 0.73']])
        source = dict(rows=3, columns=3, cells=self.cells([['M1', 'M2', 'cos'], ['gra.', '0.78', None], ['gtr', 'clip', '0.73']]))
        self.assertIsNone(split_collapsed_rows(extracted, source))
