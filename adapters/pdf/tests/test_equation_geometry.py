"""Original glyph/rule regressions for compound display and inline notation."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree as ET
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from equation_recovery import recover_equation
from inline_equations import recover_inline_equation
from pdf_text import Char,PageText

FIXTURES=Path(__file__).parent/'fixtures'


def page_and_box(item):
    b=item['box']
    shapes=[SimpleNamespace(points=[SimpleNamespace(x=l,y=y),SimpleNamespace(x=r,y=y)])for l,r,y in item['bars']]
    page=PageText(item['page'],612,792,[Char(**c)for c in item['chars']],shapes)
    box=dict(page=item['page'],x=b['l']/612,y=1-b['t']/792,width=(b['r']-b['l'])/612,height=(b['t']-b['b'])/792)
    return page,box


class SourceEquationGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.items=json.loads((FIXTURES/'equation_geometry_glyphs.json').read_text())['items']
        cls.results={item['id']:recover_equation(*page_and_box(item))for item in cls.items}

    def test_all_complete_source_displays_have_parseable_mathml(self):
        for item in self.items:
            if item['id']=='#/texts/111':continue
            with self.subTest(source=item['id']):
                result=self.results[item['id']]
                self.assertIsNotNone(result.mathml,result.limitation)
                self.assertEqual(result.glyph_count,len(item['chars']))
                self.assertEqual(ET.fromstring(result.mathml).tag,'{http://www.w3.org/1998/Math/MathML}math')
        self.assertIsNone(self.results['#/texts/111'].mathml)

    def test_theorem_two_retains_nested_denominator_limits_and_matrix_inverse(self):
        result=self.results['#/texts/110'];root=ET.fromstring(result.mathml)
        self.assertEqual(len(root.findall('.//{*}mfrac')),5)
        self.assertEqual(len(root.findall('.//{*}msqrt')),1)
        self.assertIn(r'\sqrt{k_{n}}Q_{Y(j)}(1-\frac{i_{n}}{n})',result.text)
        self.assertIn(r'M_{j}^{-1}V_{n,j}',result.text)
        self.assertIn('sup_{m_{n}≤i_{n}≤k_{n}}',result.text)
        self.assertIn('→^{p}0',result.text)

    def test_nested_tail_condition_keeps_quotient_inside_outer_fraction(self):
        result=self.results['#/texts/104'];root=ET.fromstring(result.mathml)
        self.assertGreaterEqual(len(root.findall('.//{*}mfrac')),5)
        self.assertTrue(any(f.find('.//{*}mfrac')is not None for f in root.findall('.//{*}mfrac')))
        self.assertIn('A_{Y(j)|x}(v)',result.text)
        self.assertIn('sup_{x∈D_{X},1/2≤y≤2}',result.text)

    def test_normal_distribution_has_vector_and_covariance_tables(self):
        root=ET.fromstring(self.results['#/texts/125'].mathml)
        self.assertEqual(len(root.findall('.//{*}mtable')),3)
        self.assertEqual(len(root.findall('.//{*}mtr')),6)
        self.assertIn('⟶^{D}',self.results['#/texts/125'].text)
        self.assertNotIn('-→',self.results['#/texts/125'].text)

    def test_source_remark_four_convergence_arrow_is_one_operator(self):
        result=self.results['#/texts/122']
        self.assertNotIn('-→',result.text)
        self.assertIn('⟶λ_{j}∈R',result.text)
        self.assertNotIn('<mo>−</mo><mo>→</mo>',result.mathml)

    def test_cases_preserve_three_rows_and_nested_tail_index(self):
        for ref in ('#/texts/130','#/texts/132','#/texts/134'):
            result=self.results[ref];root=ET.fromstring(result.mathml)
            self.assertEqual(len(root.findall('.//{*}mtr')),3)
            self.assertEqual(sum(n.text == '=' for n in root.findall('.//{*}mtable/{*}mtr/{*}mtd/{*}mrow/{*}mo')),3)
        self.assertIn('Q_{t_{3}}(U)',self.results['#/texts/130'].text)
        self.assertIn('>logit</mo>',self.results['#/texts/130'].mathml)
        self.assertIn('<mtext>Model </mtext>',self.results['#/texts/130'].mathml)

    def test_classic_tex_policy_loss_keeps_min_limit_and_expectation_measure(self):
        item=json.loads((FIXTURES/'equation_policy_glyphs.json').read_text())
        page=PageText(item['page'],item['width'],item['height'],[Char(**c)for c in item['chars']])
        b=item['box'];box=dict(page=item['page'],x=b['l']/page.width,y=1-b['t']/page.height,width=(b['r']-b['l'])/page.width,height=(b['t']-b['b'])/page.height)
        result=recover_equation(page,box)
        self.assertIsNotNone(result.mathml,result.limitation)
        self.assertIn('min_{π}',result.text)
        self.assertIn('E_{(s,a)∼D_{r}⊙D_{d}⊙D_{c}}',result.text)
        self.assertIn('mathvariant="double-struck"',result.mathml)
        self.assertIn('<munder>',result.mathml)

    def test_model_inline_fragment_is_expanded_without_swallowing_prose(self):
        item=json.loads((FIXTURES/'inline_equation_glyphs.json').read_text())
        page=PageText(item['page'],item['width'],item['height'],[Char(**c)for c in item['chars']])
        result=recover_inline_equation(page,item['paragraph_box'],item['fragment_box'],item['text'])
        self.assertEqual((result['start'],result['end']),(16,40))
        self.assertEqual(result['sourceText'],'M_{j}=E{XX^{⊤}/(H_{j}^{⊤}X)}')
        self.assertIn('display="inline"',result['mathml'])
        self.assertNotIn('where',item['text'][result['start']:result['end']])
        self.assertNotIn('and',item['text'][result['start']:result['end']])
        self.assertIsNone(recover_inline_equation(page,item['paragraph_box'],item['fragment_box'],'unrelated prose'))

    def test_separate_where_line_is_retained_after_display(self):
        result=self.results['#/texts/120'];root=ET.fromstring(result.mathml)
        self.assertEqual(len(root.findall('./{*}mtable/{*}mtr')),2)
        self.assertIn('\nwhere',result.text)
        self.assertIn('σ_{0}^{2}(x_{0})min{1,ϖ^{2}}+σ_{1}^{2}(x_{0})min{1,ϖ^{-2}}',result.text)

if __name__=='__main__':unittest.main()
