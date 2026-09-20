"""Source-glyph equations: scripts must survive; unsupported trees stay honest."""
import sys
import json
import unicodedata
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from equation_recovery import recover_equation
from pdf_text import Char, PageText


def glyph(text, x, y=50, size=12, bold=False):
    return Char(text, x, y, x+6, y+size, f'LMRoman{size}-' + ('Bold' if bold else 'Regular'))


def recover(chars, shapes=None):
    return recover_equation(PageText(1, 100, 100, chars, shapes),
                            dict(page=1, x=.05, y=.2, width=.9, height=.5))


class EquationRecoveryTests(unittest.TestCase):
    def test_subscript_and_transpose_have_explicit_mathml_structure(self):
        r = recover([glyph('β', 10, bold=True), glyph('j', 16, 47, 8),
                     glyph('=', 25), glyph('x', 37, bold=True), glyph('⊤', 43, 59, 8)])
        self.assertIsNone(r.limitation)
        self.assertEqual(r.text, 'β_{j}=x^{⊤}')
        root = ET.fromstring(r.mathml)
        self.assertEqual(len(root.findall('.//{*}msub')), 1)
        self.assertEqual(len(root.findall('.//{*}msup')), 1)
        self.assertIn('mathvariant="bold"', r.mathml)
        self.assertEqual(r.glyph_count, 5)

    def test_source_math_alphabets_survive_engines_without_mathvariant_support(self):
        from equation_geometry import Atom
        from equation_recovery import _token
        for value,font,expected in [('N','LMMathSymbols10-Regular','𝒩'),('x','LMRoman12-Bold','𝐱'),('β','CMMIB10','𝜷'),('R','MSBM10','ℝ')]:
            xml=_token(Atom(value,10,50,16,62,font,12))
            self.assertIn(expected,xml)
            self.assertEqual(unicodedata.normalize('NFKC',expected),value)
        self.assertIn('stretchy="false"',_token(glyph('(',10)))

    def test_multichar_subscript_retains_delimiters_and_inner_index(self):
        r = recover([glyph('Q', 10), glyph('Y',16,47,8),glyph('(',22,47,8),
                     glyph('j',28,47,8),glyph(')',34,47,8),glyph('|',40,47,8),
                     glyph('x',46,47,8),glyph('0',52,45,6),glyph('=',61),glyph('1',73)])
        self.assertIsNone(r.limitation)
        self.assertEqual(r.text,'Q_{Y(j)|x_{0}}=1')
        self.assertEqual(len(ET.fromstring(r.mathml).findall('.//{*}msub')),2)

    def test_missing_left_operand_is_not_claimed_as_a_complete_equation(self):
        r = recover([glyph('=',10),glyph('E',22),glyph('(',28),glyph('X',34),glyph(')',40)])
        self.assertIsNone(r.mathml)
        self.assertIn('left operand',r.limitation)

    def test_missing_closing_delimiter_retains_source_transcript(self):
        r = recover([glyph('E',10),glyph('{',16),glyph('X',22)])
        self.assertIsNone(r.mathml)
        self.assertEqual(r.text,'E{X')
        self.assertIn('unbalanced',r.limitation)

    def test_fraction_rule_produces_a_fraction_instead_of_multiplication(self):
        shape=SimpleNamespace(points=[SimpleNamespace(x=20,y=49),SimpleNamespace(x=38,y=49)])
        r = recover([glyph('a',22,52),glyph('b',22,34)], [shape])
        self.assertIsNotNone(r.mathml)
        self.assertIn('<mfrac>',r.mathml)
        self.assertEqual(r.text,r'\frac{a}{b}')

    def test_multiple_baselines_are_not_flattened_without_a_rule(self):
        r = recover([glyph('a',22,52),glyph('b',22,34)])
        self.assertIsNone(r.mathml)
        self.assertIn('baselines',r.limitation)

    def test_source_accent_is_attached_and_unmapped_glyph_is_refused(self):
        r = recover([glyph('\u0302',10,59),glyph('β',10),glyph('=',25),glyph('x',37)])
        self.assertIsNotNone(r.mathml)
        self.assertIn('<mover accent="true">',r.mathml)
        r = recover([glyph('\uf8eb',10,59),glyph('β',10),glyph('=',25),glyph('x',37)])
        self.assertIsNone(r.mathml)
        self.assertTrue(r.limitation)

    def test_crop_includes_whole_glyph_ink_beyond_layout_edge(self):
        p = PageText(1,100,100,[glyph('x',8,50)])
        r = recover_equation(p,dict(page=1,x=.10,y=.4,width=.1,height=.1))
        self.assertLessEqual(r.box['x'],.06)
        self.assertLessEqual(r.box['y'],.36)

    def test_original_assumption_displays_and_incomplete_inline_fragment(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/equation_glyphs.json').read_text())
        results=[]
        for item in fixture['items']:
            page=PageText(item['page'],item['width'],item['height'],[Char(**c) for c in item['chars']])
            results.append(recover_equation(page,item['box']))
        self.assertEqual(results[0].text,'β_{j}(τ)=(β_{j,0}(τ),β_{j,1}(τ),...,β_{j,d-1}(τ))^{⊤}')
        self.assertEqual(results[1].text,'Q_{Y(j)|x}(τ)=x^{⊤}β_{j}(τ), j=0,1. (1)')
        for result in results[:2]:
            self.assertIsNotNone(result.mathml)
            self.assertEqual(unicodedata.normalize('NFKC', ''.join(ET.fromstring(result.mathml).itertext())).replace('−','-'),
                             unicodedata.normalize('NFKC', ''.join(c['text'] for c in fixture['items'][results.index(result)]['chars'])))
        self.assertIsNone(results[2].mathml)
        self.assertIn('left operand',results[2].limitation)

    def test_separate_absolute_value_rows_keep_both_pairs_of_bars(self):
        chars=[]
        for y,variable in [(50,'x'),(20,'y')]:
            for x,token in zip((10,18,26,34,42,50,58),('|',variable,'+','1','|','=','a')):
                chars.append(glyph(token,x,y))
        page=PageText(1,100,100,chars)
        result=recover_equation(page,dict(page=1,x=.05,y=.2,width=.8,height=.65))
        self.assertIsNotNone(result.mathml,result.limitation)
        self.assertEqual(result.text.count('|'),4)
        self.assertEqual(result.text,'|x+1|=a\n|y+1|=a')

    def test_native_refusal_cannot_be_overridden_by_unverified_model_latex(self):
        from pdf2struct import StructAdapter
        a=StructAdapter.__new__(StructAdapter)
        a._flush=Mock();a._page_of=Mock(return_value=1)
        a._box=Mock(return_value=dict(page=1,x=.05,y=.2,width=.9,height=.5))
        a._page_text=Mock(return_value=PageText(1,100,100,[glyph('=',10),glyph('x',22)]))
        a._new_block=Mock(return_value=dict(text='x=1',evidence=dict(sourceIds=['eq'],signals=[])))
        a._crop_asset=Mock(return_value='asset-original');a._diagnostic=Mock();a.blocks=[]
        a.report=SimpleNamespace(formulas_mathml=0,formulas_image=0,formulas_text=0)
        a._emit_formula(SimpleNamespace(text='x=1'))
        self.assertNotIn('mathml',a.blocks[0].get('attributes',{}))
        self.assertEqual(a.blocks[0]['fallbackAssetIds'],['asset-original'])
        # the crop is the formula: the transcript is data, not a visible caption
        self.assertEqual((a.blocks[0]['text'],a.blocks[0]['attributes']['transcript']),('','x=1'))
        self.assertIn('left operand',a._diagnostic.call_args.args[3])

    def test_an_overprinted_accent_does_not_take_its_base_letter_s_scripts(self):
        """TeX sets `\\bar{a}` by kerning back and printing the bar glyph in
        the `a`'s own advance slot. Read as an ordinary glyph the bar becomes
        a base of its own, collects the subscript belonging to the `a`, and
        `ā_s` is published as `¯_s a` — a silent rewrite of the notation."""
        chars=[Char('v',10,95,16.2,104.5,'ABCDEF+CMBX10'),
               Char('=',20,95,28,104.5,'ABCDEF+CMR10'),
               Char('¯',31.0,95,37.2,104.5,'ABCDEF+CMBX10'),
               Char('a',31.1,95,37.1,104.5,'ABCDEF+CMBX10'),
               Char('s',37.2,91,40.6,97.6,'ABCDEF+CMMI8')]
        result=recover_equation(PageText(1,100,200,chars),dict(page=1,x=.05,y=.4,width=.6,height=.15))
        self.assertIsNone(result.limitation)
        self.assertEqual(result.text,'v=\\bar{a}_{s}')
        self.assertEqual(len(ET.fromstring(result.mathml).findall('.//{*}mover')),1)

    def test_an_accent_lifted_clear_of_a_tall_base_is_still_its_accent(self):
        """TeX raises the accent over a tall letter, so `J̄` sets its bar a
        third of the box higher than `ā` does. Source geometry from
        2609.15891v1 (15), where the bar is CMR12 over a CMMI12 `J`."""
        chars=[Char('t',250,200.44,254,210.89,'ABCDEF+CMMI12'),
               Char('=',258,200.44,266,210.89,'ABCDEF+CMR12'),
               Char('β',270.75,200.44,277.36,210.89,'ABCDEF+CMMI12'),
               Char('¯',280.83,203.46,286.69,213.91,'ABCDEF+CMR12'),
               Char('J',278.02,200.44,284.49,210.89,'ABCDEF+CMMI12')]
        result=recover_equation(PageText(1,600,400,chars),dict(page=1,x=.4,y=.45,width=.1,height=.05))
        self.assertIsNone(result.limitation)
        self.assertEqual(result.text,'t=β\\bar{J}')

    def test_a_circumflex_standing_on_its_own_stays_an_ordinary_operator(self):
        """The same characters set maths on their own. Only the overprint
        makes one an accent, so a circumflex in its own advance slot is left
        exactly as the source set it."""
        chars=[Char('a',10,95,16,104.5,'ABCDEF+CMR10'),
               Char('^',20,95,26,104.5,'ABCDEF+CMR10'),
               Char('b',30,95,36,104.5,'ABCDEF+CMR10')]
        result=recover_equation(PageText(1,100,200,chars),dict(page=1,x=.05,y=.4,width=.6,height=.15))
        self.assertEqual(result.text,'a^b')
        self.assertNotIn('mover',result.mathml)

    def test_a_relation_set_in_a_symbol_face_is_never_absorbed_as_an_accent(self):
        """`a ∼ b` reaches the text layer as a tilde between two operands, and
        a sloppy `ToUnicode` map gives it the accent's own codepoint. Read as
        an accent the relation is deleted outright and `b` is left orphaned —
        `a ∼ b` published as `ã b`. The family decides: TeX sets accents out
        of the roman family and relations out of the symbol family."""
        from equation_geometry import Atom, accent_atoms
        from equation_recovery import _token
        marked=[Atom('a',10,95,16,104.5,'ABCDEF+CMMI10',em=10),
                Atom('~',12,95.5,18,103.5,'ABCDEF+CMSY10',em=10),
                Atom('b',22,95,28,104.5,'ABCDEF+CMMI10',em=10)]
        self.assertEqual([a.text for a in accent_atoms(marked,_token)],['a','~','b'])
        chars=[Char('a',10,95,16,104.5,'ABCDEF+CMMI10'),
               Char('~',12,95.5,18,103.5,'ABCDEF+CMSY10'),
               Char('b',22,95,28,104.5,'ABCDEF+CMMI10')]
        result=recover_equation(PageText(1,100,200,chars),dict(page=1,x=.05,y=.4,width=.6,height=.15))
        self.assertEqual(result.text,'a~b')
        self.assertNotIn('mover',result.mathml or '')

    def test_a_face_that_omits_its_size_is_measured_against_one_that_states_it(self):
        """`mathptmx` sets an equation's upright text, and its tag, in the
        document text face, whose name carries no size. A run of body text
        where that face sits on one baseline beside a face that does name its
        size measures it, and the expression's scripts separate from their
        bases instead of the whole equation becoming a picture."""
        chars=[]
        for index,letter in enumerate('thebodyoftheparagraphsetsthemeasure'):
            x=10+index*9
            chars.append(Char(letter,x,20,x+4.3,28.552,'ABCDEF+TimesLike-Roman'))
            chars.append(Char('.',x+4.5,20,x+5,29.963,'ABCDEF+CMR10'))
        # x_i = y, with the subscript in the face the body text measured
        chars += [Char('x',10,95,16,104.963,'ABCDEF+CMR10'),
                  Char('i',16.5,92.5,19.5,98.486,'ABCDEF+TimesLike-Roman'),
                  Char('=',25,95,31,104.963,'ABCDEF+CMR10'),
                  Char('y',37,95,43,104.963,'ABCDEF+CMR10')]
        page=PageText(1,400,200,chars)
        result=recover_equation(page,dict(page=1,x=.01,y=.4,width=.9,height=.2))
        self.assertIsNone(result.limitation)
        self.assertEqual(result.text,'x_{i}=y')
        self.assertEqual(len(ET.fromstring(result.mathml).findall('.//{*}msub')),1)

    def test_digits_that_are_part_of_a_face_s_name_are_not_read_as_its_size(self):
        """`HardingText-RegularItalic2` is in this corpus and is not a
        two-point face. Believed, it measures every unsized face beside it at
        a fifth of its real size, for the whole page — so the face beside it
        would have its full-sized glyphs read as scripts."""
        from equation_geometry import nominal, font_scales
        from types import SimpleNamespace as NS
        self.assertEqual(nominal(NS(font='ABCDEF+CMR10')),10.)
        self.assertEqual(nominal(NS(font='ABCDEF+LMRoman8-Regular')),8.)
        self.assertIsNone(nominal(NS(font='ABCDEF+HardingText-RegularItalic2')))
        chars=[]
        for index,letter in enumerate('measuredagainstonlythatoneneighbour'):
            x=10+index*9
            chars.append(Char(letter,x,20,x+4.3,28.552,'ABCDEF+TimesLike-Roman'))
            chars.append(Char('.',x+4.5,20,x+5,29.963,'ABCDEF+HardingText-RegularItalic2'))
        self.assertNotIn('TimesLike-Roman',font_scales(PageText(1,400,200,chars)))

    def test_a_script_is_not_measured_as_if_it_were_its_own_base(self):
        """A box bottom sits a face's own descender below the baseline, so a
        subscript of a shallow face can share a box bottom with the base it
        follows. Measuring the face there would call the subscript full size
        and flatten it into the expression; the equation stays a picture."""
        from equation_geometry import font_scales
        chars=[]
        for index in range(30):
            x=10+index*11
            chars.append(Char('K',x,150,x+5,159.963,'ABCDEF+CMR10'))
            # a subscript: two thirds the size, lowered, but its shallow box
            # bottom lands within a twelfth of a character of the base's
            chars.append(Char('s',x+5.2,150.4,x+9,156.6,'ABCDEF+TimesLike-Roman'))
        page=PageText(1,400,300,chars)
        self.assertNotIn('TimesLike-Roman',font_scales(page))

    def test_a_defect_is_never_reported_to_the_reader_as_a_refusal(self):
        """Refusals and bugs both raised `ValueError`, and the one handler
        caught both: an empty `max()` reached the reader as `max() iterable
        argument is empty`, an ordinary limitation of the mathematics. Only a
        deliberate refusal is a limitation; anything else must surface."""
        from unittest.mock import patch
        import equation_geometry
        from equation_geometry import EquationRefused
        self.assertTrue(issubclass(EquationRefused, ValueError))
        page, box = PageText(1,100,100,[glyph('x',10),glyph('=',22),glyph('1',34)]), dict(page=1,x=.05,y=.2,width=.9,height=.5)
        self.assertIsNotNone(recover_equation(page,box).mathml)
        with patch.object(equation_geometry,'arrow_atoms',side_effect=ValueError('not a refusal')):
            with self.assertRaises(ValueError) as caught:
                recover_equation(PageText(1,100,100,[glyph('x',10),glyph('=',22),glyph('1',34)]),box)
            self.assertNotIsInstance(caught.exception, EquationRefused)
        with patch.object(equation_geometry,'arrow_atoms',side_effect=EquationRefused('a stated refusal')):
            result=recover_equation(PageText(1,100,100,[glyph('x',10),glyph('=',22),glyph('1',34)]),box)
            self.assertEqual(result.limitation,'a stated refusal')

    def test_an_expression_of_extensible_pieces_alone_states_its_own_reason(self):
        """`operator_atoms` and `display_rows` took the largest size of no
        atoms at all, and the empty `max()` was published as the reason the
        equation could not be rebuilt. A region carrying only extensible
        delimiter pieces has no glyph set at the expression's own size."""
        from equation_geometry import operator_atoms, display_rows
        self.assertEqual(operator_atoms([],None,None),[])
        self.assertEqual(display_rows([]),[[]])
        pieces=[Char('',10,60,16,72,'ABCDEF+CMEX10'),Char('',10,40,16,52,'ABCDEF+CMEX10'),
                Char('',30,60,36,72,'ABCDEF+CMEX10'),Char('',30,40,36,52,'ABCDEF+CMEX10')]
        result=recover_equation(PageText(1,100,100,pieces),dict(page=1,x=.05,y=.2,width=.9,height=.5))
        self.assertIsNone(result.mathml)
        self.assertEqual(result.limitation,'no stable expression baseline')

    def test_emitter_uses_original_page_crop_and_reports_unresolved_structure(self):
        from pdf2struct import StructAdapter
        a=StructAdapter.__new__(StructAdapter)
        a._flush=Mock();a._page_of=Mock(return_value=1)
        a._box=Mock(return_value=dict(page=1,x=.05,y=.2,width=.9,height=.5))
        a._page_text=Mock(return_value=PageText(1,100,100,[glyph('=',10),glyph('x',22)]))
        a._new_block=Mock(return_value=dict(text='',evidence=dict(sourceIds=['eq'],signals=[])))
        a._crop_asset=Mock(return_value='asset-original');a._diagnostic=Mock();a.blocks=[]
        a.report=SimpleNamespace(formulas_mathml=0,formulas_image=0,formulas_text=0)
        item=SimpleNamespace(text='',get_image=Mock(side_effect=AssertionError('masked image accessed')))
        a._emit_formula(item)
        item.get_image.assert_not_called()
        self.assertEqual(a.blocks[0]['fallbackAssetIds'],['asset-original'])
        self.assertNotIn('mathml',a.blocks[0].get('attributes',{}))
        self.assertIn('left operand',a._diagnostic.call_args.args[3])
        self.assertEqual(a.report.formulas_image,1)

if __name__=='__main__':unittest.main()
