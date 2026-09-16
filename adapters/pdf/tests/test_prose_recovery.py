"""Source-backed recovery of prose incorrectly merged with a float's text."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import AdapterReport, StructAdapter
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, ProvenanceItem, TextItem


def item(text, parts):
    return TextItem(self_ref='#/texts/0', label=DocItemLabel.TEXT, orig=text, text=text,
                    prov=[ProvenanceItem(page_no=p, charspan=span, bbox=BoundingBox(l=x, t=y, r=x+w, b=y+h, coord_origin=CoordOrigin.TOPLEFT))
                          for p, span, (x,y,w,h) in parts])


def adapter(items=()):
    a = StructAdapter.__new__(StructAdapter)
    a.doc = SimpleNamespace(pages={p: SimpleNamespace(size=SimpleNamespace(width=1000,height=1000)) for p in (1,2)}, iterate_items=lambda **kw: [(i,0) for i in items])
    a.blocks=[];a._pending=None;a._ids=set();a.report=AdapterReport();a.relationships=[];a.diagnostics=[]
    a._runs_for=lambda i,t: []
    a._corpus_words=set();a._corpus_forms=set()
    return a


class ProseRecovery(unittest.TestCase):
    def test_listing_caption_split_preserves_continuation_and_link(self):
        head='Sentence generation can be performed by isolating relevant'
        caption='Listing 2: Repetition in the generated story.'
        text=head+' '+caption
        src=item(text, [(1,(0,len(head)),(520,860,390,25)),(2,(len(head)+1,len(text)),(90,290,390,65))])
        a=adapter([src]);self.assertTrue(a._split_merged_caption(src))
        tail=a._new_block('paragraph',src,'actions and objects.');tail['page']=2
        tail['inline']=[{'start':0,'end':7,'href':'https://example.org','kind':'link'}]
        a.blocks.append(tail);a.report.paragraphs+=1
        a._join_split_paragraphs()
        self.assertEqual(a.blocks[0]['text'],head+' actions and objects.')
        self.assertEqual(a.blocks[1]['text'],caption)
        self.assertEqual(a.blocks[1]['kind'],'caption')
        run=a.blocks[0]['inline'][0];self.assertEqual(a.blocks[0]['text'][run['start']:run['end']],'actions')

    def test_reference_to_listing_is_not_split(self):
        head='The comparison describes the data in the following section.'
        tail='Listing 2 shows the generation results.'
        src=item(head+' '+tail,[(1,(0,len(head)),(80,700,400,100)),(2,(len(head)+1,len(head)+1+len(tail)),(80,100,400,100))])
        self.assertFalse(adapter([src])._split_merged_caption(src))

    def test_unmarked_small_type_table_note_is_separated(self):
        from docling_core.types.doc import TableItem, TableData
        head='The datasets span many participants and hours of recordings. We'
        tail='The model used the same recordings for fine-tuning. Dashes indicate absent data.'
        src=item(head+' '+tail,[(1,(0,len(head)),(70,800,430,130)),(1,(len(head)+1,len(head)+1+len(tail)),(520,205,430,60))])
        table=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(),prov=[ProvenanceItem(page_no=1,charspan=(0,0),bbox=BoundingBox(l=520,t=90,r=950,b=200,coord_origin=CoordOrigin.TOPLEFT))])
        a=adapter([src,table]);a._raised_lead_marker=lambda box:None
        a._page_text=lambda page:SimpleNamespace(lines_in=lambda box:[SimpleNamespace(height=7 if box['y']<0.5 else 10)])
        self.assertTrue(a._split_table_note_tail(src))
        self.assertEqual([(b['kind'],b['text']) for b in a.blocks],[('paragraph',head),('footnote',tail)])

    def test_same_type_paragraph_below_table_is_not_a_note(self):
        from docling_core.types.doc import TableItem, TableData
        head='The datasets span many participants and hours of recordings. We'
        tail='Also evaluated another collection of recordings for the final comparison.'
        src=item(head+' '+tail,[(1,(0,len(head)),(70,800,430,130)),(1,(len(head)+1,len(head)+1+len(tail)),(520,205,430,60))])
        table=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(),prov=[ProvenanceItem(page_no=1,charspan=(0,0),bbox=BoundingBox(l=520,t=90,r=950,b=200,coord_origin=CoordOrigin.TOPLEFT))])
        a=adapter([src,table]);a._raised_lead_marker=lambda box:None
        a._page_text=lambda page:SimpleNamespace(lines_in=lambda box:[SimpleNamespace(height=10)])
        self.assertFalse(a._split_table_note_tail(src))

    def test_tail_inside_visual_is_removed_only_with_crop(self):
        head='The benchmark contains human identities and animals, with samples for each'
        tail='kitten in a forest.'
        src=item(head+' '+tail,[(1,(0,len(head)),(170,850,650,65)),(2,(len(head)+1,len(head)+1+len(tail)),(205,555,57,7))])
        for has_crop in (False,True):
            a=adapter([src]);a._lines_in=lambda *args:[]
            prose=a._new_block('paragraph',src,src.text)
            figure={'id':'fig','kind':'figure','page':2,'text':'Figure 2: Comparison.','inline':[], 'fallbackAssetIds':['crop'] if has_crop else [],'evidence':{'boxes':[{'page':2,'x':.18,'y':.25,'width':.65,'height':.315}], 'pages':[2],'sourceIds':[],'signals':[]}}
            a.blocks=[prose,figure];a._strip_glued_tails()
            self.assertEqual(prose['text'],head if has_crop else src.text)
            if has_crop:self.assertEqual(prose['evidence']['pages'],[1])

    def test_suspended_compound_restored_from_same_source_line(self):
        text='c) Intraand Inter-Operator Parallelism: execution uses CPUs and GPUs.'
        src=item(text,[(1,(0,len(text)),(100,100,600,50))]);a=adapter([src])
        a.blocks=[a._new_block('paragraph',src,text)]
        a.blocks[0]['inline']=[{'start':text.index('execution'),'end':len(text),'kind':'italic'}]
        a.page_layout=[{'width':1000,'height':1000,'lines':[
            {'text':'c) Intra- and Inter-Operator Parallelism:', 'xmin':100,'xmax':700,'ymin':100,'ymax':120},
            {'text':'execution uses CPUs and GPUs.','xmin':100,'xmax':600,'ymin':125,'ymax':145}]}]
        a._restore_missing_lines()
        b=a.blocks[0];self.assertIn('Intra- and Inter-Operator',b['text'])
        r=b['inline'][0];self.assertEqual(b['text'][r['start']:r['end']],'execution uses CPUs and GPUs.')

    def test_numeric_fragments_survive_without_source_crop(self):
        a=adapter();a._diagnostic=lambda *args:None
        src=item('7',[(1,(0,1),(450,450,8,8))])
        a.blocks=[a._new_block('paragraph',src,str(n)) for n in (7,8,9)]
        a._drop_tick_label_runs();a._drop_numeric_fragments()
        self.assertEqual([b['text'] for b in a.blocks],['7','8','9'])

    def test_numeric_fragments_inside_retained_crop_leave_prose(self):
        a=adapter();a._diagnostic=lambda *args:None
        src=item('7',[(1,(0,1),(450,450,8,8))])
        labels=[a._new_block('paragraph',src,str(n)) for n in (7,8,9)]
        visual=a._new_block('figure',src,'Figure 2: Scores.')
        visual['evidence']['boxes']=[{'page':1,'x':.4,'y':.4,'width':.2,'height':.2}]
        visual['fallbackAssetIds']=['crop'];a.blocks=labels+[visual]
        a._drop_tick_label_runs()
        self.assertEqual(a.blocks,[visual])

    def test_prose_line_above_picture_is_not_a_glued_label(self):
        head='The results show that the new method performs better. The code can be'
        tail='found at the project page: https://example.org/'
        src=item(head+' '+tail,[(1,(0,len(head)+1+len(tail)),(100,230,790,180))]);a=adapter([src])
        prose=a._new_block('paragraph',src,src.text)
        visual=a._new_block('figure',src,'Figure 1: Preview.')
        visual['fallbackAssetIds']=['crop'];visual['evidence']['boxes']=[{'page':1,'x':.1,'y':.42,'width':.8,'height':.25}]
        a._lines_in=lambda page,x0,y0,x1,y1:[(.4,.41,tail)] if y0 <= .405 <= y1 else []
        a.blocks=[prose,visual];a._strip_glued_tails()
        self.assertEqual(prose['text'],src.text)

    def test_partial_source_line_omissions_restore_without_duplicating_present_words(self):
        text='The training has two significant role profile constraints and inconsistencies tween the dialogue and profile.'
        src=item(text,[(1,(0,len(text)),(100,100,700,80))]);a=adapter([src]);b=a._new_block('paragraph',src,text)
        b['inline']=[{'start':text.index('dialogue'),'end':text.index('dialogue')+8,'kind':'link','href':'https://example.org'}]
        a.blocks=[b];a.page_layout=[{'width':1000,'height':1000,'lines':[
            {'text':'The training has two significant issues: (I) Using a predefined','xmin':100,'xmax':800,'ymin':100,'ymax':120},
            {'text':'role profile constraints and inconsistencies and even conflicts be-','xmin':100,'xmax':800,'ymin':125,'ymax':145},
            {'text':'tween the dialogue and profile.','xmin':100,'xmax':800,'ymin':150,'ymax':170}]}]
        a._restore_missing_lines()
        self.assertEqual(b['text'],'The training has two significant issues: (I) Using a predefined role profile constraints and inconsistencies and even conflicts between the dialogue and profile.')
        r=b['inline'][0];self.assertEqual(b['text'][r['start']:r['end']],'dialogue')

    def test_prose_after_complete_listing_caption_keeps_its_role(self):
        head='Sentence generation can be performed by isolating relevant'
        caption='Listing 2: Repetition in the generated story.'
        body='Another paragraph describes the later experiment.'
        text=head+' '+caption+' '+body
        c0=len(head)+1;b0=c0+len(caption)+1
        src=item(text,[(1,(0,len(head)),(520,860,390,25)),(2,(c0,b0-1),(90,290,390,65)),(2,(b0,len(text)),(90,600,390,70))])
        a=adapter([src]);a._split_merged_caption(src)
        self.assertEqual([(b['kind'],b['text']) for b in a.blocks],[('paragraph',head),('caption',caption),('paragraph',body)])

    def test_small_uppercase_body_below_table_needs_legend_evidence(self):
        from docling_core.types.doc import TableItem, TableData
        head='The datasets span many participants and hours of recordings. We'
        tail='Appendix material begins with an independent discussion of these measurements.'
        src=item(head+' '+tail,[(1,(0,len(head)),(70,800,430,130)),(1,(len(head)+1,len(head)+1+len(tail)),(520,205,430,60))])
        table=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(),prov=[ProvenanceItem(page_no=1,charspan=(0,0),bbox=BoundingBox(l=520,t=90,r=950,b=200,coord_origin=CoordOrigin.TOPLEFT))])
        a=adapter([src,table]);a._raised_lead_marker=lambda box:None
        a._page_text=lambda page:SimpleNamespace(lines_in=lambda box:[SimpleNamespace(height=7 if box['y']<0.5 else 10)])
        self.assertFalse(a._split_table_note_tail(src))

    def test_display_equation_keeps_prose_on_both_sides_in_order(self):
        a=adapter();src=item('There exists',[(1,(0,12),(100,100,600,20))])
        head=a._new_block('paragraph',src,'There exists')
        equation=a._new_block('equation',src,'x = y')
        tail=a._new_block('paragraph',src,'such that the asserted result holds.')
        a.blocks=[head,equation,tail];a.report.paragraphs=2
        a._join_split_paragraphs()
        self.assertEqual(a.blocks,[head,equation,tail])
        self.assertEqual(head['text'],'There exists')

    def test_recovered_inline_fragment_consumes_mixed_donor_but_keeps_heading(self):
        title=item('Abstract',[(1,(0,8),(150,50,100,20))]);title.self_ref='#/texts/7'
        fragment=item('missing clause',[(1,(0,14),(300,110,150,15))]);fragment.self_ref='#/texts/8'
        src=item('This source has the in the paragraph.',[(1,(0,37),(100,100,700,100))]);src.self_ref='#/texts/9'
        a=adapter([title,fragment,src]);a._runs_for=lambda i,t:[{'start':0,'end':len(t),'href':'https://example.org'}] if i is fragment else []
        donor=a._new_block('paragraph',title,'Abstract missing clause')
        donor['evidence']['sourceIds'].append(a._source_id(fragment));donor['evidence']['boxes'].extend(a._boxes(fragment))
        body=a._new_block('paragraph',src,'This source has the missing clause in the paragraph.')
        a.blocks=[donor,body];a.report.paragraphs=2
        a._absorb_inline_prose_fragments(body)
        self.assertEqual(donor['text'],'Abstract');self.assertEqual(donor['kind'],'heading')
        self.assertEqual(donor['evidence']['sourceIds'],['texts-7'])
        self.assertIn('texts-8',body['evidence']['sourceIds'])
        self.assertEqual(body['text'][body['inline'][0]['start']:body['inline'][0]['end']],'missing clause')
        self.assertNotIn(a._box(fragment),donor['evidence']['boxes'])

    def test_one_line_source_omission_is_restored(self):
        text='A careful review needs verification before publication.'
        src=item(text,[(1,(0,len(text)),(100,100,700,20))]);a=adapter([src]);a.blocks=[a._new_block('paragraph',src,text)]
        a.page_layout=[{'width':1000,'height':1000,'lines':[{'text':'A careful review needs source-grounded verification before publication.','xmin':100,'xmax':800,'ymin':100,'ymax':120}]}]
        a._restore_missing_lines();self.assertIn('source-grounded verification',a.blocks[0]['text'])

    def test_contiguous_same_type_caption_sentences_remain_caption(self):
        head='The method is illustrated in the following figure'
        first='Figure 3. Accuracy by group.';second='Error bars show uncertainty.'
        text=head+' '+first+' '+second;c0=len(head)+1;n0=c0+len(first)+1
        src=item(text,[(1,(0,len(head)),(100,800,700,20)),(2,(c0,n0-1),(100,300,700,10)),(2,(n0,len(text)),(100,312,700,10))]);a=adapter([src])
        a.source_text=SimpleNamespace(available=True);a._page_text=lambda page:SimpleNamespace(lines_in=lambda box:[SimpleNamespace(height=10)])
        a._split_merged_caption(src)
        self.assertEqual([(b['kind'],b['text']) for b in a.blocks],[('paragraph',head),('caption',first+' '+second)])

    def test_caption_in_first_provenance_flushes_pending_prose_first(self):
        text='Listing 2: A complete caption.'
        src=item(text+' Later body paragraph.',[(1,(0,len(text)),(100,300,700,20)),(1,(len(text)+1,len(text)+22),(100,500,700,20))]);a=adapter([src])
        a._pending=a._new_block('paragraph',src,'The preceding paragraph.')
        a._split_merged_caption(src)
        self.assertEqual(a.blocks[0]['text'],'The preceding paragraph.')
        self.assertEqual(a.blocks[1]['kind'],'caption')

    def test_omission_recovery_excludes_a_retained_display_equation(self):
        text='The source starts with a statement and continues after the display.'
        src=item(text,[(1,(0,len(text)),(100,100,700,100))]);a=adapter([src]);prose=a._new_block('paragraph',src,text)
        formula=item('alpha plus beta equals gamma',[(1,(0,28),(250,130,350,20))]);formula.self_ref='#/texts/1'
        equation=a._new_block('equation',formula,formula.text);a.blocks=[prose,equation]
        a.page_layout=[{'width':1000,'height':1000,'lines':[
            {'text':'The source starts with a statement','xmin':100,'xmax':800,'ymin':100,'ymax':120},
            {'text':formula.text,'xmin':250,'xmax':600,'ymin':130,'ymax':150},
            {'text':'and continues after the display.','xmin':100,'xmax':800,'ymin':160,'ymax':180}]}]
        a._restore_missing_lines()
        self.assertEqual(prose['text'],text);self.assertIn(equation,a.blocks)

    def test_no_glyph_identical_caption_and_body_geometry_stays_uncertain(self):
        head='The method is illustrated in the following figure'
        first='Figure 3. Accuracy by group.'
        for second in ('Error bars show uncertainty.', 'The results differ for the control cohort.', 'error bars show uncertainty.'):
            with self.subTest(second=second):
                text=head+' '+first+' '+second;c0=len(head)+1;n0=c0+len(first)+1
                src=item(text,[(1,(0,len(head)),(100,800,700,20)),(2,(c0,n0-1),(100,300,700,10)),(2,(n0,len(text)),(100,312,700,10))]);a=adapter([src])
                a._split_merged_caption(src)
                self.assertEqual([b['text'] for b in a.blocks],[head,first,second])
                self.assertIn('caption-or-body-role-uncertain',a.blocks[-1]['evidence']['signals'])
                self.assertEqual(a.diagnostics[0]['severity'],'error')
                self.assertEqual(a.diagnostics[0]['pages'],[2])
                a._join_split_paragraphs()
                self.assertEqual([b['text'] for b in a.blocks],[head,first,second])
                following=a._new_block('paragraph',src,'another independent explanation follows.')
                following['page']=2;a.blocks.append(following);a._join_split_paragraphs()
                self.assertEqual(a.blocks[-1],following)
                self.assertEqual(a.blocks[0]['text'],head)

    def test_explicit_caption_source_label_survives_missing_glyphs(self):
        first='Figure 3. Accuracy by group.';second='Error bars show uncertainty.'
        text=first+' '+second;cut=len(first)+1
        src=item(text,[(1,(0,len(first)),(100,300,700,10)),(1,(cut,len(text)),(100,312,700,10))]);src.label=DocItemLabel.CAPTION
        a=adapter([src]);a._split_merged_caption(src)
        self.assertEqual([(b['kind'],b['text']) for b in a.blocks],[('caption',text)])
        self.assertEqual(a.diagnostics,[])

    def test_normalized_donor_disambiguates_shared_original_source_id(self):
        original=item('Figure 2: Original caption.',[(1,(0,27),(100,500,700,20))]);original.self_ref='#/texts/7'
        fragment=item('missing clause',[(2,(0,14),(300,110,150,15))]);fragment.self_ref='#/texts/8'
        src=item('This source has the in the paragraph.',[(2,(0,37),(100,100,700,100))]);src.self_ref='#/texts/9'
        a=adapter([original,fragment,src]);a._original_source_ids={'#/texts/8':'#/texts/7'}
        a._runs_for=lambda i,t:[{'start':0,'end':len(t),'href':'https://example.org'}] if i is fragment else []
        donor=a._new_block('paragraph',fragment,fragment.text)
        body=a._new_block('paragraph',src,'This source has the missing clause in the paragraph.')
        a.blocks=[donor,body];a.report.paragraphs=2;a._absorb_inline_prose_fragments(body)
        self.assertEqual(a.blocks,[body]);self.assertIn('texts-7',body['evidence']['sourceIds'])
        self.assertEqual(body['text'][body['inline'][0]['start']:body['inline'][0]['end']],'missing clause')

    def test_walk_join_preserves_all_normalized_provenance(self):
        head=item('The next sentence introduces',[(1,(0,28),(100,100,700,20))]);head.self_ref='#/texts/1'
        tail=item('and further source words',[(1,(0,11),(100,130,300,20)),(2,(12,24),(100,100,400,20))]);tail.self_ref='#/texts/8'
        a=adapter([head,tail]);a._original_source_ids={'#/texts/8':'#/texts/7'}
        a._pending=a._new_block('paragraph',head,head.text);a._in_abstract=False
        for name in ('_figure_foot_line','_split_merged_caption','_split_stray_lead','_split_side_column_tail','_split_table_note_tail','_is_edge_page_number'):
            setattr(a,name,lambda i:False)
        a._is_description_item=lambda i,t:False;a._emit_monospace_code=lambda i,t:False
        a._emit_paragraph(tail)
        self.assertEqual(a._pending['evidence']['pages'],[1,2])
        self.assertEqual(a._pending['evidence']['boxes'],a._boxes(head)+a._boxes(tail))
        self.assertEqual(a._pending['evidence']['sourceIds'],['texts-1','texts-7'])

if __name__=='__main__': unittest.main()
