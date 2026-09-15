"""Regression coverage for source-provenance normalization before recovery."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
    TableData,
)

from layout_normalization import normalize_provenance


def prov(page, start, end, left, top, width, height):
    return ProvenanceItem(
        page_no=page,
        charspan=(start, end),
        bbox=BoundingBox(
            l=left,
            t=top,
            r=left + width,
            b=top + height,
            coord_origin=CoordOrigin.TOPLEFT,
        ),
    )


class ProvenanceNormalizationTests(unittest.TestCase):
    def document_with_cross_page_caption(self):
        doc = DoclingDocument(name="synthetic")
        doc.add_page(25, Size(width=600, height=800))
        doc.add_page(26, Size(width=600, height=800))
        caption = "Figure 7. A rotated caption that identifies the adjacent visualization."
        note = "The reported k n values are the values used for Table 2."
        text = caption + " " + note
        merged = doc.add_text(
            label=DocItemLabel.TEXT,
            text=text,
            orig=text,
            prov=prov(25, 0, len(caption), 40, 60, 18, 670),
        )
        merged.prov.append(prov(26, len(caption) + 1, len(text), 80, 500, 461, 52))
        table = doc.add_table(
            data=TableData(),
            prov=prov(26, 0, 0, 60, 180, 480, 280),
        )
        later = doc.add_text(
            label=DocItemLabel.TEXT,
            text="The next source paragraph remains after the note.",
            prov=prov(26, 0, 48, 80, 650, 440, 40),
        )
        # The layout reader placed the merged text at the old page-25 position.
        body = doc.body.children
        body[:] = [merged.get_ref(), table.get_ref(), later.get_ref()]
        return doc, merged, table, later, caption, note, text

    def test_splits_losslessly_and_places_tail_after_later_page_table(self):
        doc, merged, table, later, caption, note, text = self.document_with_cross_page_caption()

        normalized, original_refs = normalize_provenance(doc)

        self.assertIsNot(normalized, doc)
        initial = normalized.texts[0]
        tail = normalized.texts[-1]
        self.assertEqual(initial.self_ref, merged.self_ref)
        self.assertEqual(initial.label, DocItemLabel.CAPTION)
        self.assertEqual(tail.label, DocItemLabel.TEXT)
        self.assertEqual(initial.text + tail.text, text)
        self.assertEqual(initial.prov[0].charspan, (0, len(caption)))
        self.assertEqual(tail.prov[0].charspan, (len(caption) + 1, len(text)))
        self.assertEqual(tail.prov[0].page_no, 26)
        self.assertEqual(original_refs, {tail.self_ref: initial.self_ref})
        self.assertEqual(
            [ref.cref for ref in normalized.body.children],
            [initial.self_ref, table.self_ref, tail.self_ref, later.self_ref],
        )
        self.assertEqual(tail.text, note)

    def test_preserves_a_distinct_but_span_aligned_original_text(self):
        doc, merged, _, _, caption, note, text = self.document_with_cross_page_caption()
        source_origin = (caption + " " + note).replace("reported", "recorded")
        self.assertEqual(len(source_origin), len(text))
        merged.orig = source_origin

        normalized, _ = normalize_provenance(doc)

        initial, tail = normalized.texts[0], normalized.texts[-1]
        self.assertEqual(initial.orig + tail.orig, source_origin)
        self.assertEqual(initial.orig, source_origin[: len(caption) + 1])
        self.assertEqual(tail.orig, source_origin[len(caption) + 1 :])

    def test_refuses_an_original_text_that_cannot_share_text_charspans(self):
        doc, merged, _, _, _, _, text = self.document_with_cross_page_caption()
        merged.orig = text + " source-only suffix"

        normalized, original_refs = normalize_provenance(doc)

        self.assertIs(normalized, doc)
        self.assertEqual(original_refs, {})
        self.assertEqual(merged.orig, text + " source-only suffix")

    def test_leaves_same_orientation_prose_in_the_original_document(self):
        doc = DoclingDocument(name="same-orientation")
        doc.add_page(1, Size(width=600, height=800))
        doc.add_page(2, Size(width=600, height=800))
        text = "Figure 8 is mentioned in ordinary prose on the next page."
        item = doc.add_text(label=DocItemLabel.TEXT, text=text, prov=prov(1, 0, 18, 80, 100, 420, 50))
        item.prov.append(prov(2, 18, len(text), 80, 160, 430, 50))

        normalized, original_refs = normalize_provenance(doc)

        self.assertIs(normalized, doc)
        self.assertEqual(original_refs, {})
        self.assertEqual([entry.text for entry in doc.texts], [text])

    def test_refuses_meaningful_provenance_gaps(self):
        doc, merged, _, _, _, _, text = self.document_with_cross_page_caption()
        merged.prov[1].charspan = (len(text) - 5, len(text))

        normalized, original_refs = normalize_provenance(doc)

        self.assertIs(normalized, doc)
        self.assertEqual(original_refs, {})
        self.assertEqual(merged.text, text)

    def test_refuses_a_distant_or_horizontally_disjoint_table_anchor(self):
        doc, merged, table, _, _, _, text = self.document_with_cross_page_caption()
        table.prov[0].bbox = BoundingBox(
            l=540,
            t=10,
            r=580,
            b=20,
            coord_origin=CoordOrigin.TOPLEFT,
        )

        normalized, original_refs = normalize_provenance(doc)

        self.assertIs(normalized, doc)
        self.assertEqual(original_refs, {})
        self.assertEqual(merged.text, text)

    def test_is_idempotent_after_the_split(self):
        doc, *_ = self.document_with_cross_page_caption()
        normalized, original_refs = normalize_provenance(doc)

        repeated, repeated_refs = normalize_provenance(normalized)

        self.assertIsNot(normalized, doc)
        self.assertTrue(original_refs)
        self.assertIs(repeated, normalized)
        self.assertEqual(repeated_refs, {})

    def test_multiple_tails_after_one_table_keep_source_top_to_bottom_order(self):
        doc, merged, table, later, _, first_note, _ = self.document_with_cross_page_caption()
        second_caption = "Figure 8. A second rotated caption beside the same visualization band."
        second_note = "The second table note follows below the first note."
        second_text = second_caption + " " + second_note
        second = doc.add_text(
            label=DocItemLabel.TEXT,
            text=second_text,
            orig=second_text,
            prov=prov(25, 0, len(second_caption), 65, 60, 18, 670),
        )
        second.prov.append(prov(26, len(second_caption) + 1, len(second_text), 80, 565, 461, 52))
        doc.body.children[:] = [merged.get_ref(), second.get_ref(), table.get_ref(), later.get_ref()]

        normalized, original_refs = normalize_provenance(doc)

        tails = {item.self_ref: item for item in normalized.texts if item.self_ref in original_refs}
        order = [ref.cref for ref in normalized.body.children]
        table_index = order.index(table.self_ref)
        self.assertEqual(
            [tails[ref].text for ref in order[table_index + 1 : table_index + 3]],
            [first_note, second_note],
        )


if __name__ == "__main__":
    unittest.main()
