"""UTF-16 boundary conversion for PDF adapter inline runs."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inline_offsets import convert_inline_offsets


def block(ident: str, text: str, inline: list[dict]) -> dict:
    return {"id": ident, "text": text, "inline": inline}


class InlineOffsets(unittest.TestCase):
    def test_bmp_offsets_are_unchanged(self):
        blocks = [block("p", "Read this note", [{"start": 5, "end": 9, "href": "https://example.test"}])]

        convert_inline_offsets(blocks)

        self.assertEqual(blocks[0]["inline"], [{"start": 5, "end": 9, "href": "https://example.test"}])

    def test_non_bmp_prefix_converts_block_inline_ranges_without_changing_semantics(self):
        text = "😀linked 𝒜2"
        blocks = [block("p", text, [
            {"start": 1, "end": 7, "href": "https://example.test"},
            {"start": 8, "end": 9, "relationshipId": "note-1", "targetIds": ["note"], "semanticRole": "note-reference"},
            {"start": 9, "end": 10, "verticalAlign": "superscript"},
            {"start": 8, "end": 9, "mathml": "<math><mi>𝒜</mi></math>", "compactMathAtom": True},
        ])]

        convert_inline_offsets(blocks)

        self.assertEqual([(run["start"], run["end"]) for run in blocks[0]["inline"]], [(2, 8), (9, 11), (11, 12), (9, 11)])
        self.assertEqual(blocks[0]["text"], text)
        self.assertEqual(blocks[0]["inline"][1]["relationshipId"], "note-1")
        self.assertEqual(blocks[0]["inline"][3]["mathml"], "<math><mi>𝒜</mi></math>")
        self.assertTrue(blocks[0]["inline"][3]["compactMathAtom"])

    def test_non_bmp_prefix_converts_table_cell_ranges(self):
        text = "😀value"
        cell = {"id": "c0", "text": text, "inline": [{"start": 1, "end": 6, "bold": True}]}
        blocks = [dict(block("table", "", []), table={"cells": [cell]})]

        convert_inline_offsets(blocks)

        self.assertEqual(cell["inline"], [{"start": 2, "end": 7, "bold": True}])
        self.assertEqual(cell["text"], text)

    def test_invalid_python_range_is_rejected_before_any_mutation(self):
        first = block("first", "😀link", [{"start": 1, "end": 5, "href": "https://example.test"}])
        second = block("second", "text", [{"start": 1, "end": 9, "italic": True}])

        with self.assertRaisesRegex(ValueError, r"blocks\[1\]\.inline\[0\].*end.*text length"):
            convert_inline_offsets([first, second])

        self.assertEqual(first["inline"][0]["start"], 1)
        self.assertEqual(first["inline"][0]["end"], 5)


if __name__ == "__main__":
    unittest.main()
