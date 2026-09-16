"""Source-grounded regressions for annotation anchors and note references."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import StructAdapter, AdapterReport, link_visible_text, marker_candidates
from pdf_text import Marker


def block(ident, text, page=1, kind='paragraph', label=None, y=.2):
    b = dict(id=ident, text=text, page=page, kind=kind, inline=[], evidence=dict(pages=[page], boxes=[dict(page=page,x=.1,y=y,width=.8,height=.05)],sourceIds=[]))
    if label: b['label']=label
    return b


def adapter(blocks):
    a=StructAdapter.__new__(StructAdapter)
    a.blocks=blocks; a.report=AdapterReport(); a.relationships=[]; a._ids=set()
    a._page_of=lambda item: item.page
    a._evidence=lambda item: dict(pages=[item.page],boxes=[],sourceIds=[])
    return a


class AnnotationAnchors(unittest.TestCase):
    def test_icon_glyph_names_are_existing_visible_anchors(self):
        text='Alice Smith envelope orcid Example University'
        self.assertEqual(link_visible_text(text,'mailto:alice@example.org','#'), 'envelope')
        self.assertEqual(link_visible_text(text,'https://orcid.org/0000-0000-0000-0001','\x1a'), 'orcid')
        self.assertIsNone(link_visible_text('This envelope is red.','https://example.org','#'))

    def test_quote_and_dash_extractor_variants_keep_original_offsets(self):
        self.assertEqual(link_visible_text("the 'un-copyrighted' Pile,",'https://example.org','“un-copyrighted” Pile,'), "'un-copyrighted' Pile")
        self.assertEqual(link_visible_text('J. Funct. Anal. 196 , 40-60 (2002).','https://doi.org/10.1/example','J. Funct. Anal. 196, 40–60 (2002).'), 'J. Funct. Anal. 196 , 40-60 (2002)')

    def test_normalized_visible_phrase_precedes_destination_url(self):
        text='Read the “Source” book and https://example.org.'
        self.assertEqual(link_visible_text(text,'https://example.org','the "Source" book'),'the “Source” book')

    def test_correspondence_symbol_is_not_an_orcid_anchor(self):
        self.assertIsNone(link_visible_text('Alice * and Bob †','https://orcid.org/0000-0000-0000-0001','†'))


class NestedNotes(unittest.TestCase):
    def test_affiliation_note_can_reference_another_note(self):
        host=block('affiliation','Tauric Research *',kind='footnote',label='3')
        note=block('details','Organization details',kind='footnote',label='*',y=.85)
        a=adapter([host,note])
        marker=Marker('*',1,.35,.21,.01,.01,'TauricResearch','',False)
        a._page_text=lambda page: SimpleNamespace(markers=[marker])
        item=SimpleNamespace(page=1,self_ref='#/texts/2')
        boxes=[(1,b) for h in a.blocks for b in h['evidence']['boxes']]
        self.assertTrue(a._link_marker_by_glyphs('*',note,item,boxes))
        self.assertEqual(host['inline'][0]['targetIds'],['details'])
        self.assertEqual(a.relationships[0]['from'],'affiliation')

    def test_self_marker_does_not_prove_symbol_is_referenced(self):
        a=adapter([])
        own=Marker('*',1,.1,.85,.01,.01,'','',True)
        a._page_text=lambda page: SimpleNamespace(markers=[own],lines=[SimpleNamespace(text='* Author mail@example.org')])
        a._boxes=lambda item: [dict(page=1,x=.1,y=.85,width=.8,height=.05)]
        self.assertFalse(a._symbol_referenced_on_page('*',SimpleNamespace(page=1,text='* Author mail@example.org')))

    def test_fallback_uses_provenance_page_of_merged_paragraph(self):
        host=block('host','The template g ( · ) 14 , resulting in an input',page=2)
        host['evidence']['pages']=[2,3]
        note=block('note','Example template',page=3,kind='footnote',label='14')
        a=adapter([host,block('other','Some unrelated text.',page=3),note])
        self.assertTrue(a._link_marker('14',note,SimpleNamespace(page=3)))
        self.assertEqual(host['inline'][0]['targetIds'],['note'])

    def test_note_after_set_notation_is_not_a_number(self):
        text='Previous tokens { x0, ..., xi-1 } 2 . In this era'
        self.assertEqual([(text[s:e],strong) for s,e,strong in marker_candidates('2',text)],[('2',True)])
        self.assertEqual(marker_candidates('2','Table 2 shows the results.'),[])

class BibliographyNotes(unittest.TestCase):
    def test_baseline_number_below_references_is_an_entry(self):
        a=adapter([block('refs','References',kind='heading')])
        a._flush=lambda: None
        a._page_text=lambda page: SimpleNamespace(markers=[])
        a._runs_for=lambda item,text: []
        a._new_block=lambda kind,item,text,**extra: dict(block('entry',text,kind=kind),**extra)
        a._notes=[]
        a._emit_footnote(SimpleNamespace(page=1,text='1 Example model. https://example.org'))
        self.assertEqual(a.blocks[-1]['kind'],'paragraph')
        self.assertEqual(a.blocks[-1]['text'],'1 Example model. https://example.org')
        self.assertEqual(a.report.footnotes_with_marker,0)

class LinkItemSelection(unittest.TestCase):
    def test_matching_words_choose_between_overlapping_items(self):
        from docling_core.types.doc import TextItem, DocItemLabel, ProvenanceItem, BoundingBox, CoordOrigin
        from pdf_links import SourceLink
        def item(i,text,rect):
            l,b,r,t=rect
            return TextItem(self_ref=f'#/texts/{i}',label=DocItemLabel.TEXT,text=text,orig=text,prov=[ProvenanceItem(page_no=1,charspan=(0,len(text)),bbox=BoundingBox(l=l,b=b,r=r,t=t,coord_origin=CoordOrigin.BOTTOMLEFT))])
        wrong=item(0,'An empty citation.',(0,0,100,20))
        right=item(1,'The Source Book',(0,1,99,20))
        a=adapter([])
        a.doc=SimpleNamespace(iterate_items=lambda: [(wrong,0),(right,0)])
        a.links=[SourceLink(1,(0,0,100,20),'https://example.org','uri',['The','Source','Book'])]
        self.assertEqual(a._index_links(),{'#/texts/1':[('The Source Book','https://example.org/')]})

class SourceIconRecovery(unittest.TestCase):
    def test_missing_icon_gets_label_beside_its_author_and_shifts_runs(self):
        from pdf_links import SourceLink
        host=block('authors','ALICE SMITH a , BOB JONES b',y=.2)
        host['inline']=[dict(start=16,end=25,bold=True)]
        a=adapter([host]);a.doc=SimpleNamespace(pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=[SourceLink(1,(36,75,39,80),'https://orcid.org/0000-0000-0000-0001','uri')]
        a.word_boxes=[[(10,20,20,25,'ALICE'),(21,20,32,25,'SMITH'),(33,20,35,25,'a'),(45,20,55,25,'BOB'),(56,20,66,25,'JONES')]]
        a._recover_link_icons()
        self.assertEqual(host['text'],'ALICE SMITH a [ORCID] , BOB JONES b')
        link=next(r for r in host['inline'] if r.get('href'))
        self.assertEqual(host['text'][link['start']:link['end']],'[ORCID]')
        self.assertEqual(host['inline'][0]['start'],24)
        self.assertIn('source-icon',host['evidence']['signals'])
        self.assertEqual(host['evidence']['boxes'][-1]['x'],.36)
        a._recover_link_icons()
        self.assertEqual(host['text'].count('[ORCID]'),1)

    def test_icon_without_source_word_context_is_not_guessed(self):
        from pdf_links import SourceLink
        host=block('authors','Some text',y=.2)
        a=adapter([host]);a.doc=SimpleNamespace(pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=[SourceLink(1,(36,75,39,80),'https://orcid.org/0000-0000-0000-0001','uri')];a.word_boxes=[[]]
        a._recover_link_icons()
        self.assertEqual(host['text'],'Some text')
        self.assertEqual(host['inline'],[])

class IconLinkLabels(unittest.TestCase):
    """An author icon keeps its link and reads as a bracketed label, never as
    the icon font's glyph name (2508.03474v1: `Oriol Saguillo envelope orcid`)."""

    @staticmethod
    def _adapter(host, links, words):
        a=adapter([host]);a.doc=SimpleNamespace(pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=links;a.word_boxes=words
        return a

    def test_glyph_name_anchors_become_labels_and_shift_later_runs(self):
        from pdf_links import SourceLink
        text='Alice Smith envelope orcid Example University'
        host=block('authors',text,y=.2)
        host['inline']=[dict(start=12,end=20,href='mailto:alice@example.org'),
                        dict(start=21,end=26,href='https://orcid.org/0000-0000-0000-0001'),
                        dict(start=27,end=45,italic=True)]
        a=self._adapter(host,[SourceLink(1,(33,75,36,80),'mailto:alice@example.org','uri'),
                              SourceLink(1,(37,75,40,80),'https://orcid.org/0000-0000-0000-0001','uri')],
                        [[(10,20,20,25,'Alice'),(21,20,32,25,'Smith')]])
        a._recover_link_icons()
        self.assertEqual(host['text'],'Alice Smith [email] [ORCID] Example University')
        by_href={r.get('href'):host['text'][r['start']:r['end']] for r in host['inline']}
        self.assertEqual(by_href['mailto:alice@example.org'],'[email]')
        self.assertEqual(by_href['https://orcid.org/0000-0000-0000-0001'],'[ORCID]')
        self.assertEqual(by_href[None],'Example University')
        a._recover_link_icons()
        self.assertEqual(host['text'],'Alice Smith [email] [ORCID] Example University')

    def test_glyph_name_anchor_is_labelled_without_word_context(self):
        # the icon's annotation found no source words to anchor on, so the
        # recovery never claimed the run; the glyph name must still not show
        host=block('authors','Alice Smith envelope',y=.2)
        host['inline']=[dict(start=12,end=20,href='mailto:alice@example.org')]
        a=self._adapter(host,[],[[]])
        a._recover_link_icons()
        self.assertEqual(host['text'],'Alice Smith [email]')
        self.assertEqual(host['text'][host['inline'][0]['start']:host['inline'][0]['end']],'[email]')

    def test_a_linked_word_in_prose_is_not_an_icon(self):
        host=block('contact','Please email us or see ORCID for details',y=.2)
        host['inline']=[dict(start=7,end=12,href='mailto:team@example.org'),
                        dict(start=23,end=28,href='https://orcid.org/0000-0000-0000-0001')]
        a=self._adapter(host,[],[[]])
        a._recover_link_icons()
        self.assertEqual(host['text'],'Please email us or see ORCID for details')

class UnlinkedIconLabels(unittest.TestCase):
    """An icon with no annotation still reads as a label when what follows it
    says what it is (2609.04172v1: `envelope hebx24@mails.tsinghua.edu.cn`)."""

    @staticmethod
    def _run(host):
        a=adapter([host]);a.doc=SimpleNamespace(pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=[];a.word_boxes=[[]]
        a._recover_link_icons()
        return host

    def test_envelope_before_an_address_is_the_email_icon(self):
        host=block('contact','envelope hebx24@mails.tsinghua.edu.cn, {dingning,xcj}@tsinghua.edu.cn',kind='list-item',y=.2)
        host['inline']=[dict(start=9,end=37,href='mailto:hebx24@mails.tsinghua.edu.cn')]
        self._run(host)
        self.assertEqual(host['text'],'[email] hebx24@mails.tsinghua.edu.cn, {dingning,xcj}@tsinghua.edu.cn')
        run=host['inline'][0]
        self.assertEqual(host['text'][run['start']:run['end']],'hebx24@mails.tsinghua.edu.cn')

    def test_orcid_before_an_identifier_is_the_orcid_icon(self):
        host=block('author','Alice Smith orcid 0000-0002-1825-0097',y=.2)
        self._run(host)
        self.assertEqual(host['text'],'Alice Smith [ORCID] 0000-0002-1825-0097')

    def test_the_word_envelope_in_prose_stays(self):
        for text in ('Consider the envelope of the family of lines.',
                     'a slowly varying envelope, which would otherwise dominate',
                     'the signal envelope @ 5 kHz'):
            self.assertEqual(self._run(block('prose',text,y=.2))['text'],text)

class TableLinkGeometry(unittest.TestCase):
    def test_literal_uri_in_cell_recovers_bad_cell_box_inside_table(self):
        from docling_core.types.doc import TableItem,TableData,TableCell,DocItemLabel,ProvenanceItem,BoundingBox,CoordOrigin
        from pdf_links import SourceLink
        def bbox(l,b,r,t):return BoundingBox(l=l,b=b,r=r,t=t,coord_origin=CoordOrigin.BOTTOMLEFT)
        cell=TableCell(text='Source https://example.org/resource .',start_row_offset_idx=0,end_row_offset_idx=1,start_col_offset_idx=0,end_col_offset_idx=1,bbox=bbox(10,10,90,40))
        table=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(num_rows=1,num_cols=1,table_cells=[cell]),prov=[ProvenanceItem(page_no=1,charspan=(0,0),bbox=bbox(0,0,100,100))])
        a=adapter([]);a.doc=SimpleNamespace(iterate_items=lambda:[(table,0)],pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=[SourceLink(1,(10,50,90,60),'https://example.org/resource','uri',['https://example.org/resource'])]
        self.assertEqual(a._index_links(),{'#/tables/0#c0-0':[('https://example.org/resource','https://example.org/resource')]})
        a.links=[SourceLink(1,(10,101,90,110),'https://example.org/resource','uri',['https://example.org/resource'])]
        self.assertEqual(a._index_links(),{})

class NoteStyleOwnership(unittest.TestCase):
    def test_note_owns_superscript_without_removing_math_or_italic(self):
        host=block('host','x2 refers3')
        host['inline']=[dict(start=1,end=2,verticalAlign='superscript'),dict(start=9,end=10,verticalAlign='superscript',italic=True)]
        note=block('note','Explanation',kind='footnote',label='3')
        a=adapter([host,note])
        self.assertTrue(a._add_note_reference(host,9,10,note,'3',1,{}))
        self.assertEqual(host['inline'][0]['verticalAlign'],'superscript')
        self.assertEqual(host['inline'][1],dict(start=9,end=10,italic=True))
        self.assertEqual(sum(r.get('verticalAlign')=='superscript' for r in host['inline'] if r['start']==9),1)

class SourceIconReviewRegressions(unittest.TestCase):
    def test_two_icons_with_same_preceding_words_keep_source_order(self):
        from pdf_links import SourceLink
        host=block('authors','ALICE SMITH',y=.2)
        a=adapter([host]);a.doc=SimpleNamespace(pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=[SourceLink(1,(33,75,36,80),'https://orcid.org/0000-0000-0000-0001','uri'),SourceLink(1,(37,75,40,82),'mailto:alice@example.org','uri')]
        a.word_boxes=[[(10,20,20,25,'ALICE'),(21,20,32,25,'SMITH')]]
        a._recover_link_icons()
        self.assertEqual(host['text'],'ALICE SMITH [ORCID] [email]')
        runs=sorted(host['inline'],key=lambda r:r['start'])
        self.assertEqual([host['text'][r['start']:r['end']] for r in runs],['[ORCID]','[email]'])
        self.assertEqual([r['href'] for r in runs],[a.links[0].uri,a.links[1].uri])

    def test_build_keeps_heading_author_note_reference_beside_icon(self):
        import tempfile
        from docling_core.types.doc import DoclingDocument, Size, DocItemLabel, ProvenanceItem, BoundingBox, CoordOrigin
        from pdf_links import SourceLink
        from pdf_text import PageText
        def prov(text,y):
            return ProvenanceItem(page_no=1,charspan=(0,len(text)),bbox=BoundingBox(l=10,r=90,t=100-y,b=95-y,coord_origin=CoordOrigin.BOTTOMLEFT))
        doc=DoclingDocument(name='Example')
        doc.add_page(page_no=1,size=Size(width=100,height=100))
        doc.add_title('Paper title',prov=prov('Paper title',10))
        doc.add_heading('ALICE SMITH *',prov=prov('ALICE SMITH *',20))
        doc.add_text(label=DocItemLabel.FOOTNOTE,text='* Author details.',prov=prov('* Author details.',85))
        page=PageText(1,100,100,[])
        page._markers=[Marker('*',1,.4,.20,.01,.01,'ALICESMITH','',False),Marker('*',1,.1,.85,.01,.01,'','',True)]
        source=SimpleNamespace(available=True,page=lambda n:page if n==1 else None)
        links=[SourceLink(1,(33,75,36,80),'https://orcid.org/0000-0000-0000-0001','uri'), SourceLink(1,(37,75,39,82),'mailto:alice@example.org','uri')]
        words=[[(10,20,20,25,'ALICE'),(21,20,32,25,'SMITH')]]
        with tempfile.NamedTemporaryFile(suffix='.pdf') as pdf:
            draft,report=StructAdapter(doc,Path(pdf.name),'a'*64,links,words,source_text=source).build()
        host=next(b for b in draft['blocks'] if 'ALICE' in b['text'])
        notes=[r for r in host['inline'] if r.get('semanticRole')=='note-reference']
        self.assertEqual(len(notes),1)
        self.assertEqual(host['text'][notes[0]['start']:notes[0]['end']],'*')
        self.assertEqual(host['text'],'ALICE SMITH [ORCID] [email] *')
        self.assertEqual(report.footnotes_linked,1)
        self.assertEqual(next(r for r in draft['relationships'] if r['kind']=='footnote')['from'],host['id'])

class FurtherReviewRegressions(unittest.TestCase):
    def test_same_mailbox_two_author_icons_keeps_both_occurrences(self):
        from pdf_links import SourceLink
        host=block('authors','ALICE SMITH and BOB JONES',y=.2)
        a=adapter([host]);a.doc=SimpleNamespace(pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100))})
        a.links=[SourceLink(1,(33,75,36,80),'mailto:team@example.org','uri'),SourceLink(1,(70,75,73,80),'mailto:team@example.org','uri')]
        a.word_boxes=[[(10,20,20,25,'ALICE'),(21,20,32,25,'SMITH'),(42,20,48,25,'and'),(50,20,58,25,'BOB'),(59,20,69,25,'JONES')]]
        a._recover_link_icons()
        self.assertEqual(host['text'],'ALICE SMITH [email] and BOB JONES [email]')
        self.assertEqual(len([r for r in host['inline'] if r.get('href')]),2)
        a._recover_link_icons()
        self.assertEqual(host['text'].count('[email]'),2)

    def test_twelve_is_not_two_implicitly_concatenated_note_labels(self):
        host=block('author','ALICE SMITH12',kind='heading')
        note=block('note','An affiliation',kind='footnote',label='1',y=.85)
        a=adapter([host,note]);a._page_text=lambda page:SimpleNamespace(markers=[Marker('12',1,.4,.21,.01,.01,'ALICESMITH','',False)])
        item=SimpleNamespace(page=1,self_ref='#/texts/2')
        self.assertFalse(a._link_marker_by_glyphs('1',note,item,[]))
        self.assertEqual(a.relationships,[])

    def test_table_parent_top_left_coordinates_match_bottom_left(self):
        from docling_core.types.doc import TableItem,TableData,TableCell,DocItemLabel,ProvenanceItem,BoundingBox,CoordOrigin
        from pdf_links import SourceLink
        cell=TableCell(text='https://example.org/resource',start_row_offset_idx=0,end_row_offset_idx=1,start_col_offset_idx=0,end_col_offset_idx=1,bbox=BoundingBox(l=10,t=30,r=90,b=40,coord_origin=CoordOrigin.TOPLEFT))
        table=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(num_rows=1,num_cols=1,table_cells=[cell]),prov=[ProvenanceItem(page_no=1,charspan=(0,0),bbox=BoundingBox(l=0,t=20,r=100,b=80,coord_origin=CoordOrigin.TOPLEFT))])
        a=adapter([]);a.doc=SimpleNamespace(iterate_items=lambda:[(table,0)],pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=200))})
        a.links=[SourceLink(1,(10,130,90,140),'https://example.org/resource','uri',['https://example.org/resource'])]
        self.assertEqual(a._index_links(),{'#/tables/0#c0-0':[('https://example.org/resource','https://example.org/resource')]})

class AnnotationOccurrenceReview(unittest.TestCase):
    def test_same_uri_on_two_here_occurrences_keeps_two_runs(self):
        from docling_core.types.doc import TextItem,DocItemLabel,ProvenanceItem,BoundingBox,CoordOrigin
        from pdf_links import SourceLink
        text='Read here and here.'
        item=TextItem(self_ref='#/texts/1',label=DocItemLabel.TEXT,text=text,orig=text,prov=[ProvenanceItem(page_no=1,charspan=(0,len(text)),bbox=BoundingBox(l=0,b=0,r=100,t=20,coord_origin=CoordOrigin.BOTTOMLEFT))])
        a=adapter([]);a.doc=SimpleNamespace(iterate_items=lambda:[(item,0)])
        a.links=[SourceLink(1,(20,5,40,15),'https://example.org','uri',['here']),SourceLink(1,(60,5,80,15),'https://example.org','uri',['here'])]
        a._item_links=a._index_links()
        runs=a._runs_for(item,text,styles=False)
        self.assertEqual([(r['start'],r['end']) for r in runs],[(5,9),(14,18)])
        self.assertEqual(a.report.links_mapped,2)

    def test_later_table_page_recovers_unique_visible_phrase(self):
        from docling_core.types.doc import TableItem,TableData,TableCell,DocItemLabel,ProvenanceItem,BoundingBox,CoordOrigin
        from pdf_links import SourceLink
        def cell(row):return TableCell(text='Visible title',start_row_offset_idx=row,end_row_offset_idx=row+1,start_col_offset_idx=0,end_col_offset_idx=1,bbox=BoundingBox(l=10,t=10,r=90,b=20,coord_origin=CoordOrigin.TOPLEFT))
        def prov(page):return ProvenanceItem(page_no=page,charspan=(0,0),bbox=BoundingBox(l=0,t=20,r=100,b=80,coord_origin=CoordOrigin.TOPLEFT))
        table=TableItem(self_ref='#/tables/0',label=DocItemLabel.TABLE,data=TableData(num_rows=1,num_cols=1,table_cells=[cell(0)]),prov=[prov(1),prov(2)])
        a=adapter([]);a.doc=SimpleNamespace(iterate_items=lambda:[(table,0)],pages={1:SimpleNamespace(size=SimpleNamespace(width=100,height=100)),2:SimpleNamespace(size=SimpleNamespace(width=100,height=200))})
        a.links=[SourceLink(2,(10,130,90,140),'https://example.org/resource','uri',['Visible','title'])]
        self.assertEqual(a._index_links(),{'#/tables/0#c0-0':[('Visible title','https://example.org/resource')]})
        table.data=TableData(num_rows=2,num_cols=1,table_cells=[cell(0),cell(1)])
        self.assertEqual(a._index_links(),{})
        # Two later-page cells with identical geometry/text cannot be
        # disambiguated by treating their first-page glyph boxes as new facts.
        a.links=[SourceLink(2,(10,182,90,188),'https://example.org/resource','uri',['Visible','title'])]
        self.assertEqual(a._index_links(),{})

    def test_complete_source_wrapped_phrase_shares_one_output_anchor(self):
        from docling_core.types.doc import TextItem,DocItemLabel,ProvenanceItem,BoundingBox,CoordOrigin
        from pdf_links import SourceLink
        text='Read the source title now.'
        item=TextItem(self_ref='#/texts/1',label=DocItemLabel.TEXT,text=text,orig=text,prov=[ProvenanceItem(page_no=1,charspan=(0,len(text)),bbox=BoundingBox(l=0,b=0,r=100,t=100,coord_origin=CoordOrigin.BOTTOMLEFT))])
        a=adapter([]);a.doc=SimpleNamespace(iterate_items=lambda:[(item,0)])
        a.links=[SourceLink(1,(20,50,70,60),'https://example.org','uri',['the','source']),SourceLink(1,(20,30,50,40),'https://example.org','uri',['title'])]
        a._item_links=a._index_links()
        runs=a._runs_for(item,text,styles=False)
        self.assertEqual([text[r['start']:r['end']] for r in runs],['the source title'])
        self.assertEqual(a.report.links_mapped,2)
