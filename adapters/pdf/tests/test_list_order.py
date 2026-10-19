"""List order is established by source evidence, never prose content."""
from __future__ import annotations

import itertools
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from docling_core.types.doc import BoundingBox, CoordOrigin, DoclingDocument, ProvenanceItem, Size
from pdf2struct import StructAdapter


def fixture(sequence=(0, 2, 1), *, ordered=False, origin=CoordOrigin.TOPLEFT):
    doc = DoclingDocument(name="Synthetic list")
    doc.add_page(1, Size(width=600, height=800))
    group = doc.add_list_group()
    # Deliberately non-alphabetical and unrelated to any research paper.
    texts = ["Zebras require careful observation.", "Apples provide useful examples.", "Middle passages describe the result."]
    items = []
    lines = []
    for index, text in enumerate(texts):
        top = 100 + index * 70
        box = BoundingBox(l=60, r=540, t=top, b=top+45, coord_origin=CoordOrigin.TOPLEFT)
        if origin == CoordOrigin.BOTTOMLEFT:
            box = box.to_bottom_left_origin(800)
        marker = f"{index+1}." if ordered else "•"
        items.append(doc.add_list_item(text, enumerated=ordered, marker=marker, parent=group,
            prov=ProvenanceItem(page_no=1, charspan=(0, len(text)), bbox=box)))
        lines.append({"text": marker+" "+text, "xmin":60, "xmax":540, "ymin":top+4, "ymax":top+16})
    group.children[:] = [items[index].get_ref() for index in sequence]
    layout = [{"width":600,"height":800,"lines":lines}]
    return doc, group, items, layout


def walk(doc, layout):
    adapter = StructAdapter(doc, Path("synthetic.pdf"), "0"*64, [], page_layout=layout)
    adapter._walk(adapter.doc.body)
    adapter._flush()
    return adapter


class SourceListOrderTests(unittest.TestCase):
    def test_every_permutation_restores_source_order_without_changing_content(self):
        for sequence in itertools.permutations(range(3)):
            for ordered in (False, True):
                with self.subTest(sequence=sequence, ordered=ordered):
                    doc, group, items, layout = fixture(sequence, ordered=ordered)
                    original_refs = [ref.cref for ref in group.children]
                    adapter = walk(doc, layout)
                    self.assertEqual([b["text"] for b in adapter.blocks], [item.text for item in items])
                    self.assertEqual([ref.cref for ref in group.children], original_refs)
                    self.assertEqual(adapter.report.accounted_items, 3)

    def test_bottom_left_coordinates_use_page_height(self):
        doc, _, items, layout = fixture(origin=CoordOrigin.BOTTOMLEFT)
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [item.text for item in items])

    def test_without_independent_text_lines_retains_extractor_order(self):
        doc, _, items, _ = fixture()
        self.assertEqual([b["text"] for b in walk(doc,[]).blocks], [items[i].text for i in (0,2,1)])

    def test_unknown_source_text_does_not_authorize_reordering(self):
        doc, _, items, layout = fixture()
        layout[0]["lines"][1]["text"] = "Other source text."
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_two_columns_retain_extractor_order(self):
        doc, _, items, layout = fixture()
        items[1].prov[0].bbox.l = 350
        items[1].prov[0].bbox.r = 550
        for item in (items[0], items[2]):
            item.prov[0].bbox.r = 250
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_overlapping_column_boxes_retain_extractor_order(self):
        doc, _, items, layout = fixture()
        for index, item in enumerate(items):
            left = 200 if index == 1 else 0
            item.prov[0].bbox.l = left
            item.prov[0].bbox.r = left + 400
            layout[0]["lines"][index]["xmin"] = left + 10
            layout[0]["lines"][index]["xmax"] = left + 190
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_malformed_source_lines_retain_extractor_order(self):
        for field in ("xmin", "xmax", "ymin", "ymax", "text"):
            for value in (None, "invalid", float("nan"), 10**1000):
                with self.subTest(field=field, value=value):
                    doc, _, items, layout = fixture()
                    layout[0]["lines"][1][field] = value
                    self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])
            doc, _, items, layout = fixture()
            del layout[0]["lines"][1][field]
            self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_missing_provenance_retains_extractor_order(self):
        doc, _, items, layout = fixture()
        items[1].prov.clear()
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_cross_page_list_retains_extractor_order(self):
        doc, _, items, layout = fixture()
        doc.add_page(2, Size(width=600,height=800))
        items[1].prov[0].page_no = 2
        layout.append({"width":600,"height":800,"lines":[]})
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_geometry_text_disagreement_retains_extractor_order(self):
        doc, _, items, layout = fixture()
        # All source boxes overlap, but their top order contradicts the text layer.
        for index,item in enumerate(items):
            item.prov[0].bbox.t = 80+(2-index)
            item.prov[0].bbox.b = 350
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_multi_box_item_retains_extractor_order(self):
        doc, _, items, layout = fixture()
        items[1].prov.append(items[1].prov[0].model_copy(deep=True))
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_duplicate_source_matches_are_ambiguous(self):
        doc, _, items, layout = fixture()
        layout[0]["lines"].append(dict(layout[0]["lines"][1]))
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_mismatched_page_frame_retains_extractor_order(self):
        doc, _, items, layout = fixture()
        layout[0]["height"] = 600
        self.assertEqual([b["text"] for b in walk(doc,layout).blocks], [items[i].text for i in (0,2,1)])

    def test_malformed_page_frames_retain_extractor_order(self):
        for page in (None, 42, "invalid", [], {}, {"width": None, "height": 800},
                     {"width": 600, "height": "800"}, {"width": float("nan"), "height": 800},
                     {"width": 600, "height": float("inf")}, {"width": 10**1000, "height": 800}):
            with self.subTest(page=page):
                doc, _, items, _ = fixture()
                self.assertEqual([b["text"] for b in walk(doc,[page]).blocks], [items[i].text for i in (0,2,1)])

    def test_repairs_are_reported_without_source_reference_loss(self):
        doc, _, items, layout = fixture()
        adapter = walk(doc,layout)
        self.assertEqual(adapter.report.lists_reordered_by_source, 1)
        refs = [source for b in adapter.blocks for source in b["evidence"]["sourceIds"]]
        self.assertEqual(set(refs), {item.self_ref.lstrip("#/").replace("/", "-") for item in items})

    def test_nested_list_does_not_flatten_or_reorder_parent_siblings(self):
        doc, _, items, layout = fixture()
        nested=doc.add_list_group(parent=items[1])
        doc.add_list_item("A nested point.",parent=nested)
        blocks=walk(doc,layout).blocks
        self.assertEqual([b["text"] for b in blocks], [items[0].text,items[2].text,items[1].text,"A nested point."])


if __name__ == "__main__":
    unittest.main()
