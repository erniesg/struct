"""Native PDF destination and final-graph occurrence regressions."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from internal_links import recover_internal_links
from pdf_links import SourceLink, extract_links
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject, NullObject


def block(ident, text, page=1, x=.1, y=.2, width=.8):
    return dict(id=ident, text=text, kind='paragraph', page=page, inline=[], evidence=dict(boxes=[dict(page=page,x=x,y=y,width=width,height=.08)]))


def adapter(blocks, links, words=None):
    return SimpleNamespace(blocks=blocks, links=links, word_boxes=words or [], doc=SimpleNamespace(pages={n:SimpleNamespace(size=SimpleNamespace(width=100,height=100)) for n in [1,2]}))


def link(words=None, **kwargs):
    return SourceLink(1,(10,72,30,80),None,'internal',words or ['2'],destination_page=2,destination_x=10,destination_y=80,**kwargs)


class DestinationExtraction(unittest.TestCase):
    def test_direct_named_goto_and_unsupported_actions(self):
        writer=PdfWriter(); writer.add_blank_page(100,100); writer.add_blank_page(100,100)
        dest=ArrayObject([writer.pages[1].indirect_reference,NameObject('/XYZ'),NumberObject(10),NumberObject(80),NullObject()])
        writer.add_named_destination_array(TextStringObject('cite.example'),dest)
        annotations=[]
        for extra in [dict(Dest=dest),dict(Dest=TextStringObject('cite.example')),dict(A=DictionaryObject({NameObject('/S'):NameObject('/GoTo'),NameObject('/D'):TextStringObject('cite.example')})),dict(A=DictionaryObject({NameObject('/S'):NameObject('/Launch')})),dict(Dest=TextStringObject('missing'))]:
            a=DictionaryObject({NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(x) for x in [10,70,20,80]])})
            a.update({NameObject('/'+k):v for k,v in extra.items()});annotations.append(writer._add_object(a))
        writer.pages[0][NameObject('/Annots')]=ArrayObject(annotations)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'links.pdf'; writer.write(path)
            links,sizes=extract_links(path)
        self.assertEqual(len(links),5)
        for got in links[:3]:
            self.assertEqual((got.destination_page,got.destination_x,got.destination_y),(2,10,80))
        self.assertEqual(links[1].destination_name,'cite.example')
        self.assertEqual(links[3].unresolved_reason,'unsupported-action:/Launch')
        self.assertEqual(links[4].unresolved_reason,'unknown-named-destination')
        self.assertEqual(len({l.source_id for l in links}),5)
        self.assertEqual(sizes[2],(100,100))

    def test_malformed_action_preserves_source_annotation_occurrence(self):
        writer=PdfWriter();writer.add_blank_page(100,100)
        annotation=DictionaryObject({NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(x) for x in [10,70,20,80]]),NameObject('/A'):NumberObject(7)})
        writer.pages[0][NameObject('/Annots')]=ArrayObject([writer._add_object(annotation)])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'malformed.pdf';writer.write(path);links,_=extract_links(path)
        self.assertEqual(len(links),1)
        self.assertEqual(links[0].rect,(10,70,20,80))
        self.assertEqual(links[0].source_id,'pdf-annotation-p1-0')
        self.assertEqual(links[0].kind,'internal')
        self.assertEqual(links[0].unresolved_reason,'malformed-action')
        result=recover_internal_links(adapter([],links))
        self.assertEqual((result['total'],result['linked'],result['unresolved']),(1,0,1))
        self.assertEqual(result['occurrences'][0]['reason'],'malformed-action')

    def test_fit_modes_and_unsupported_file_actions_remain_explicit(self):
        writer=PdfWriter();writer.add_blank_page(100,100);writer.add_blank_page(100,100)
        annotations=[]
        modes=[('/FitH',[NumberObject(75)]),('/XYZ',[NullObject(),NumberObject(70),NullObject()]),('/FitR',[NumberObject(10),NumberObject(20),NumberObject(80),NumberObject(90)]),('/Fit',[])]
        for mode,coords in modes:
            annotation=DictionaryObject({NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(x) for x in [10,70,20,80]]),NameObject('/Dest'):ArrayObject([writer.pages[1].indirect_reference,NameObject(mode),*coords])})
            annotations.append(writer._add_object(annotation))
        for kind in ['/GoToR','/JavaScript']:
            annotations.append(writer._add_object(DictionaryObject({NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(x) for x in [10,70,20,80]]),NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject(kind)})})))
        writer.pages[0][NameObject('/Annots')]=ArrayObject(annotations)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'fits.pdf';writer.write(path);links,_=extract_links(path)
        self.assertEqual(links[0].destination_y,75)
        self.assertEqual((links[1].destination_x,links[1].destination_y),(None,70))
        self.assertEqual((links[2].destination_x,links[2].destination_y),(10,90))
        self.assertEqual(links[3].destination_page,2)
        self.assertIsNone(links[3].destination_y)
        self.assertEqual([l.unresolved_reason for l in links[4:]],['unsupported-action:/GoToR','unsupported-action:/JavaScript'])


class OccurrenceRecovery(unittest.TestCase):
    def test_final_merged_block_target_and_styles_survive(self):
        host=block('host','See 2 for details.');host['inline']=[dict(start=0,end=3,bold=True)]
        target=block('survivor','References',page=2)
        a=adapter([host,target],[link(destination_name='cite.ref')])
        result=recover_internal_links(a)
        self.assertEqual(result['linked'],1)
        self.assertEqual(host['inline'][0],dict(start=0,end=3,bold=True))
        self.assertEqual(host['inline'][1]['targetIds'],['survivor'])
        self.assertEqual(host['inline'][1]['semanticRole'],'citation')
        recover_internal_links(a)
        self.assertEqual(len(host['inline']),2)

    def test_repeated_anchor_uses_annotation_word_context(self):
        host=block('host','First 2 then second 2 end.');target=block('target','Section',page=2)
        words=[[(10,20,20,27,'First'),(21,20,25,27,'2'),(26,20,38,27,'then'),(40,20,55,27,'second'),(57,20,60,27,'2'),(63,20,73,27,'end.')]]
        annotation=link();annotation.rect=(56,72,61,80)
        a=adapter([host,target],[annotation],words)
        result=recover_internal_links(a)
        self.assertEqual(result['linked'],1)
        self.assertEqual(host['inline'][0]['start'],20)

    def test_duplicate_words_without_context_are_unresolved(self):
        host=block('host','2 and 2');a=adapter([host,block('target','Target',page=2)],[link()])
        result=recover_internal_links(a)
        self.assertEqual(result['linked'],0)
        self.assertEqual(result['occurrences'][0]['reason'],'ambiguous-anchor-occurrence')

    def test_no_whole_document_fallback(self):
        host=block('host','See 2',x=.6,width=.3)
        result=recover_internal_links(adapter([host,block('target','Target',page=2)],[link()]))
        self.assertEqual(result['linked'],0)
        self.assertEqual(host['inline'],[])

    def test_ambiguous_target_and_existing_link_never_overwritten(self):
        host=block('host','See 2');target=block('target','Target',page=2)
        a=adapter([host,target,block('other','Other',page=2)],[link()])
        self.assertEqual(recover_internal_links(a)['occurrences'][0]['reason'],'ambiguous-destination-region')
        a.blocks.pop();host['inline']=[dict(start=4,end=5,href='https://example.org')]
        self.assertEqual(recover_internal_links(a)['occurrences'][0]['reason'],'anchor-overlaps-existing-link')
        self.assertEqual(host['inline'][0]['href'],'https://example.org')

    def test_cell_and_wrapped_occurrences(self):
        cell=block('c0-0','See Figure 2')
        table=block('table','');table['kind']='table';table['table']=dict(cells=[cell])
        a=adapter([table,block('target','Figure 2',page=2)],[link(['See']),link(['Figure','2'])])
        result=recover_internal_links(a)
        self.assertEqual(result['linked'],2)
        self.assertEqual([r['containerId'] for r in result['occurrences']],['c0-0','c0-0'])
        self.assertEqual(len(cell['inline']),2)

    def test_empty_anchor_and_page_only_dest_are_diagnosed(self):
        empty=link();empty.words=[]
        a=adapter([block('host','See 2'),block('target','Target',page=2)],[empty])
        self.assertEqual(recover_internal_links(a)['occurrences'][0]['reason'],'empty-anchor')
        empty.destination_y=None
        self.assertEqual(recover_internal_links(a)['occurrences'][0]['reason'],'destination-without-vertical-position')


class SourceReviewRegressions(unittest.TestCase):
    def test_bad_viewport_recovers_only_source_attested_unique_caption(self):
        host=block('host','See 2');target=block('target','Figure 2: Measured result',page=2);target['kind']='figure'
        annotation=link(destination_name='figure.caption.7');annotation.destination_y=4150
        a=adapter([host,target],[annotation],[[],[(10,20,20,27,'Figure'),(21,20,24,27,'2:'),(25,20,70,27,'Measured result')]])
        result=recover_internal_links(a)
        self.assertEqual(result['linked'],1)
        self.assertEqual(result['occurrences'][0]['sourceDestinationIssue'],'destination-coordinate-out-of-bounds')
        host['inline']=[];a.word_boxes=[]
        self.assertEqual(recover_internal_links(a)['linked'],0)
        self.assertEqual(host['inline'],[])

    def test_note_label_disambiguates_adjacent_source_footnotes(self):
        host=block('host','See 2,')
        first=block('first','First note',page=2,y=.19);first.update(kind='footnote',label='1')
        second=block('second','Second note',page=2,y=.22);second.update(kind='footnote',label='2')
        host['inline']=[dict(start=4,end=5,targetIds=['second'],semanticRole='note-reference')]
        annotation=link(['2,'],destination_name='Hfootnote.2')
        a=adapter([host,first,second],[annotation])
        result=recover_internal_links(a)
        self.assertEqual(result['linked'],1)
        self.assertEqual(result['occurrences'][0]['targetId'],'second')
        self.assertEqual(result['occurrences'][0]['end'],5)
        self.assertEqual(len(host['inline']),1)

    def test_source_line_end_hyphen_maps_two_original_occurrences(self):
        host=block('host','See Action Group');target=block('target','Reference',page=2)
        words=[[(10,20,20,24,'See'),(22,20,30,24,'Ac-'),(10,25,22,28,'tion'),(24,25,36,28,'Group')]]
        first=link(['Ac-']);first.rect=(21,75,31,80)
        second=link(['tion','Group']);second.rect=(9,71,37,75)
        result=recover_internal_links(adapter([host,target],[first,second],words))
        self.assertEqual(result['linked'],2)
        self.assertEqual([host['text'][run['start']:run['end']] for run in host['inline']],['Ac','tion Group'])

    def test_numeric_annotation_never_links_inside_a_different_number(self):
        host=block('host','See 20');target=block('target','Target',page=2)
        self.assertEqual(recover_internal_links(adapter([host,target],[link()]))['linked'],0)

if __name__=='__main__':unittest.main()
