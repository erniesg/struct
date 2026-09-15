"""Source-aligned reconstruction of extensible-delimiter matrices."""
import json
import sys
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from equation_geometry import Atom, accent_atoms, atom, delimiter_atoms
from equation_matrix import matrix_atoms
from equation_recovery import _sequence, _token
from pdf_text import Char


def glyph(text, x, y, *, width=6, height=12, extension=False):
    font = 'LMMathExtension12-Regular' if extension else 'LMRoman12-Regular'
    return Atom(text, x, y, x + width, y + height, font, 12, extension=extension)


class MatrixAtomsTests(unittest.TestCase):
    def test_source_125_reconstructs_nested_vector_and_covariance_tables(self):
        fixture = Path(__file__).parent / 'fixtures/equation_matrix_glyphs.json'
        item = json.loads(fixture.read_text())
        atoms = accent_atoms([atom(Char(**char)) for char in item['chars']], _token)
        result = matrix_atoms(delimiter_atoms(atoms), _sequence)

        self.assertEqual(sum(a.count for a in result), len(item['chars']))
        mathml = ''.join(a.xml or '' for a in result)
        self.assertEqual(mathml.count('<mtable>'), 3)
        self.assertIn('<mtr><mtd>', mathml)
        self.assertIn('<mo stretchy="true">(</mo><mtable>', mathml)
        expression, _ = _sequence(result)
        ET.fromstring('<math>' + expression + '</math>')

    def test_regular_single_row_parentheses_are_preserved(self):
        atoms = [glyph('(', 10, 45), glyph('x', 16, 45), glyph(')', 23, 45)]
        result = matrix_atoms(atoms, _sequence)

        self.assertEqual(result, atoms)

    def test_extensible_delimiters_without_aligned_columns_are_preserved(self):
        atoms = [
            glyph('(', 10, 30, height=40, extension=True),
            glyph('a', 18, 58), glyph('b', 25, 38), glyph('c', 45, 38),
            glyph(')', 54, 30, height=40, extension=True),
        ]
        result = matrix_atoms(atoms, _sequence)

        self.assertEqual(result, atoms)


if __name__ == '__main__':
    unittest.main()
