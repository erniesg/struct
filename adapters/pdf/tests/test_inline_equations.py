"""Atomic inline absorption must preserve source ownership and graph meaning."""
import copy
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from inline_equations import recover_inline_equations
from pdf_text import Char,PageText


def fixture_adapter():
    item=json.loads((Path(__file__).parent/'fixtures/inline_equation_glyphs.json').read_text())
    page=PageText(item['page'],item['width'],item['height'],[Char(**c) for c in item['chars']])
    host=dict(id='host',kind='paragraph',text=item['text'],page=item['page'],inline=[],
              evidence=dict(pages=[item['page']],boxes=[item['paragraph_box']],sourceIds=['source-host'],signals=['docling-layout']))
    fragment=dict(id='fragment',kind='equation',text='=E{XX⊤/(H⊤jX)',page=item['page'],inline=[],fallbackAssetIds=['crop'],
                  evidence=dict(pages=[item['page']],boxes=[item['fragment_box']],sourceIds=['source-fragment'],signals=['source-glyph-equation-transcript']))
    adapter=SimpleNamespace(blocks=[fragment,host],assets=[dict(id='crop',evidence={})],relationships=[],
                            diagnostics=[dict(id='diagnostic',severity='warning',category='text',title='Equation structure unavailable',message='missing operand',sourceIds=['source-fragment'])],
                            report=SimpleNamespace(formulas_mathml=0,formulas_image=1,formulas_text=0),_page_text=lambda number:page if number==item['page'] else None)
    return adapter,host,fragment


class InlineEquationIntegrationTests(unittest.TestCase):
    def test_actual_source_fragment_becomes_one_atomic_run_with_conserved_provenance(self):
        adapter,host,fragment=fixture_adapter();text=host['text']
        enclosing=dict(start=0,end=len(text),italic=True)
        outside=dict(start=0,end=2,href='https://example.com/')
        host['inline']=[enclosing,outside,dict(start=17,end=18,verticalAlign='subscript'),dict(start=22,end=25,bold=True,compactMathAtom=True)]
        self.assertEqual(recover_inline_equations(adapter),1)
        self.assertEqual(adapter.blocks,[host]);self.assertEqual(host['text'],text)
        atoms=[run for run in host['inline'] if 'mathml' in run]
        self.assertEqual(len(atoms),1);self.assertEqual(set(atoms[0]),{'start','end','mathml'})
        self.assertEqual((atoms[0]['start'],atoms[0]['end']),(16,40))
        self.assertIn('<mo>=</mo>',atoms[0]['mathml'])
        self.assertIn(enclosing,host['inline']);self.assertIn(outside,host['inline'])
        self.assertEqual(len(host['inline']),3)
        self.assertEqual(host['evidence']['sourceIds'],['source-host','source-fragment'])
        self.assertIn(fragment['evidence']['boxes'][0],host['evidence']['boxes'])
        self.assertIn('source-inline-equation-reconstruction',host['evidence']['signals'])
        self.assertEqual(adapter.assets,[])
        self.assertEqual(adapter.diagnostics[0]['id'],'diagnostic')
        self.assertEqual(adapter.diagnostics[0]['title'],'Equation recovered inline')
        self.assertEqual(adapter.diagnostics[0]['sourceIds'],['source-fragment'])
        self.assertEqual((adapter.report.formulas_mathml,adapter.report.formulas_image),(1,0))
        saved=copy.deepcopy((adapter.blocks,adapter.assets,adapter.diagnostics))
        self.assertEqual(recover_inline_equations(adapter),0)
        self.assertEqual((adapter.blocks,adapter.assets,adapter.diagnostics),saved)

    def test_ambiguous_matching_paragraphs_are_unchanged(self):
        adapter,host,_=fixture_adapter();other=copy.deepcopy(host);other['id']='other';adapter.blocks.append(other)
        saved=copy.deepcopy((adapter.blocks,adapter.assets,adapter.diagnostics))
        self.assertEqual(recover_inline_equations(adapter),0)
        self.assertEqual((adapter.blocks,adapter.assets,adapter.diagnostics),saved)

    def test_interior_or_crossed_link_and_semantic_runs_refuse_absorption(self):
        for run in [dict(start=20,end=24,href='https://example.com/'),
                    dict(start=35,end=45,href='https://example.com/'),
                    dict(start=0,end=60,semanticRole='footnote-reference'),
                    dict(start=17,end=18,relationshipId='note'),
                    dict(start=20,end=24,targetIds=['note']),
                    dict(start=20,end=24,annotationId='annotation'),
                    dict(start=0,end=20,italic=True)]:
            with self.subTest(run=run):
                adapter,host,_=fixture_adapter();host['inline']=[run]
                saved=copy.deepcopy((adapter.blocks,adapter.assets,adapter.diagnostics))
                self.assertEqual(recover_inline_equations(adapter),0)
                self.assertEqual((adapter.blocks,adapter.assets,adapter.diagnostics),saved)

    def test_wholly_enclosing_link_is_preserved(self):
        adapter,host,_=fixture_adapter();link=dict(start=0,end=len(host['text']),href='https://example.com/',annotationId='source-link')
        host['inline']=[link]
        self.assertEqual(recover_inline_equations(adapter),1)
        self.assertIn(link,host['inline'])

    def test_referenced_fragment_and_relationship_are_not_deleted(self):
        adapter,_,_=fixture_adapter()
        relationship=dict(id='equation-ref',kind='cross-reference',**{'from':'host'},to=['fragment'])
        adapter.relationships=[relationship]
        saved=copy.deepcopy((adapter.blocks,adapter.assets,adapter.relationships))
        self.assertEqual(recover_inline_equations(adapter),0)
        self.assertEqual((adapter.blocks,adapter.assets,adapter.relationships),saved)

    def test_fragment_link_target_blocks_absorption_even_without_relationship(self):
        adapter,host,_=fixture_adapter();host['inline']=[dict(start=0,end=2,href='#fragment')]
        self.assertEqual(recover_inline_equations(adapter),0)
        self.assertEqual(len(adapter.blocks),2)

    def test_shared_asset_and_unrelated_relationship_remain(self):
        adapter,_,_=fixture_adapter()
        other=dict(id='other',kind='figure',text='',inline=[],fallbackAssetIds=['crop'],evidence={})
        adapter.blocks.append(other)
        relationship=dict(id='unrelated',kind='figure',**{'from':'host'},to=['other'])
        adapter.relationships=[relationship]
        self.assertEqual(recover_inline_equations(adapter),1)
        self.assertEqual(adapter.assets,[dict(id='crop',evidence={})])
        self.assertEqual(adapter.relationships,[relationship])

    def test_multibox_fragment_or_noninterior_geometry_is_unchanged(self):
        for mode in ('multibox','outside','missing-page'):
            adapter,host,fragment=fixture_adapter()
            if mode=='multibox':fragment['evidence']['boxes'].append(dict(fragment['evidence']['boxes'][0]))
            elif mode=='outside':fragment['evidence']['boxes'][0]['y']=.1
            else:adapter._page_text=lambda _:None
            saved=copy.deepcopy(adapter.blocks)
            self.assertEqual(recover_inline_equations(adapter),0)
            self.assertEqual(adapter.blocks,saved)

if __name__=='__main__':unittest.main()
