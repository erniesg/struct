"""Source-separated, small-type multi-block note bodies."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pdf_text import Char, Line, Rule
from note_bodies import recover_note_bodies, _mask_rules


def line(text,y,size=10):
    chars=[Char(c,100+i*5,1000-y*1000-size,104+i*5,1000-y*1000,'CMR') for i,c in enumerate(text)]
    ln=Line(chars,chars[0].b);ln.finalize();return ln


def block(ident,text,y,page=1,kind='paragraph',label=None):
    out=dict(id=ident,text=text,page=page,kind=kind,inline=[],evidence=dict(pages=[page],boxes=[dict(page=page,x=.1,y=y,width=.75,height=.025,rotation=0)],sourceIds=[ident],signals=[]))
    if label:out['label']=label
    return out


def example():
    main=block('main','Ordinary body prose is larger than the note below.',.1)
    note=block('note','A detailed explanation follows.',.55,kind='footnote',label='4')
    eq=block('equation','',.61,kind='equation');eq['fallbackAssetIds']=['formula-image']
    before=block('before','The first source paragraph comes before the next.',.70)
    after=block('after','The next source paragraph completes this argument.',.75)
    continuation=block('continuation','the final parameter update on the surface.',.89,page=2,kind='footnote')
    body2=block('main2','The second page resumes the larger ordinary body.',.2,page=2)
    pages={1:SimpleNamespace(width=1000,height=1000,lines=[line(main['text'],.1,12),line(note['text'],.55),line('a = b',.61,4),line(before['text'],.70),line(after['text'],.75),line('The last note sentence continues with the direction of',.89)],rules=[Rule(.1,.54,.4,.54,.5)]),2:SimpleNamespace(width=1000,height=1000,lines=[line(body2['text'],.2,12),line(continuation['text'],.89)],rules=[Rule(.1,.88,.4,.88,.5)])}
    for p in pages.values():p.chars=[c for l in p.lines for c in l.chars]
    a=SimpleNamespace(blocks=[main,note,eq,after,before,body2,continuation],relationships=[dict(kind='footnote',to=['note'],**{'from':'main'})],_page_text=lambda n:pages.get(n),doc=SimpleNamespace(pages={1:None,2:None}),pdf_path=Path('/nonexistent.pdf'),diagnostics=[dict(category='notes',sourceIds=['continuation'])],report=SimpleNamespace(footnotes=2,footnotes_unlinked=1),_notes=[])
    a._id=lambda ident:ident
    return a,pages


class NoteBodies(unittest.TestCase):
    def test_equations_source_order_and_missing_cross_page_sentence(self):
        a,_=example();original_ids={b['id'] for b in a.blocks}
        recover_note_bodies(a)
        note=next(b for b in a.blocks if b['id']=='note')
        self.assertEqual(note['noteBodyBlockIds'],['equation','before','after','continuation'])
        self.assertTrue(original_ids.issubset({b['id'] for b in a.blocks}))
        tail=next(b for b in a.blocks if b['id']=='continuation')
        self.assertEqual(tail['kind'],'paragraph')
        self.assertEqual(tail['text'],'The last note sentence continues with the direction of the final parameter update on the surface.')
        self.assertEqual(tail['evidence']['pages'],[1,2])
        self.assertIn('source-note-continuation',tail['evidence']['signals'])
        self.assertEqual(a.report.footnotes,1)
        self.assertEqual(a.report.footnotes_unlinked,0)
        self.assertEqual(a.diagnostics,[])
        self.assertEqual(next(b for b in a.blocks if b['id']=='equation')['fallbackAssetIds'],['formula-image'])
        recover_note_bodies(a)
        self.assertEqual(tail['text'].count('The last'),1)

    def test_no_separator_does_not_group_small_appendix(self):
        a,pages=example();pages[1].rules=[]
        recover_note_bodies(a)
        self.assertNotIn('noteBodyBlockIds',a.blocks[1])

    def test_adjacent_large_body_is_a_boundary(self):
        a,pages=example()
        stop=block('body-resumes','Ordinary body resumes here in its larger font.',.67)
        a.blocks.append(stop);pages[1].lines.append(line(stop['text'],.67,12));pages[1].chars.extend(pages[1].lines[-1].chars)
        recover_note_bodies(a)
        self.assertEqual(a.blocks[1].get('noteBodyBlockIds'),['equation'])
        self.assertEqual(next(b for b in a.blocks if b['id']=='continuation')['kind'],'footnote')

    def test_new_marked_note_is_a_boundary(self):
        a,pages=example();other=block('other-note','Another note begins here.',.73,kind='footnote',label='5')
        a.blocks.append(other);pages[1].lines.append(line(other['text'],.73));pages[1].chars.extend(pages[1].lines[-1].chars)
        recover_note_bodies(a)
        self.assertEqual(a.blocks[1].get('noteBodyBlockIds'),['equation','before'])
        self.assertNotIn('other-note',a.blocks[1].get('noteBodyBlockIds',[]))

    def test_same_size_body_without_type_boundary_is_not_a_note_band(self):
        a,pages=example();pages[1].lines[0]=line(a.blocks[0]['text'],.1,10);pages[1].chars=[c for l in pages[1].lines for c in l.chars]
        recover_note_bodies(a)
        self.assertNotIn('noteBodyBlockIds',a.blocks[1])

    def test_smaller_appendix_heading_stops_the_note_body(self):
        a,pages=example()
        heading=block('appendix','Appendix A',.68,kind='heading')
        a.blocks.append(heading);pages[1].lines.append(line(heading['text'],.68));pages[1].chars.extend(pages[1].lines[-1].chars)
        recover_note_bodies(a)
        self.assertEqual(a.blocks[1].get('noteBodyBlockIds'),['equation'])

    def test_inline_mask_separator_respects_graphics_stack_and_transform(self):
        operations=[([.1,0,0,.1,0,0],b'cm'),([],b'q'),([1700,0,0,-5,1000,4500],b'cm'),({'settings':{'/IM':True,'/W':1,'/H':1},'data':b'\0'},b'INLINE IMAGE'),([],b'Q'),([],b'q'),([10,0,0,10,0,0],b'cm'),([],b'Q')]
        rules=_mask_rules(operations,1000,1000)
        self.assertEqual(len(rules),1)
        self.assertAlmostEqual(rules[0].x0,.1)
        self.assertAlmostEqual(rules[0].y0,.55)
        self.assertAlmostEqual(rules[0].x1,.27)
