"""Regression tests for source evidence failing closed on known fidelity losses."""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fidelity import build_packet, digest, compare_text, image_comparison, line_ledger, table_census, tokens, visual_tasks, epub_inventory  # noqa: E402


def box(y=.1, height=.02):
    return {"page": 1, "x": .1, "y": y, "width": .8, "height": height}


def line(text, index, y):
    return {"id": f"line-{index}", "text": text, "box": box(y), "sourceSequence": index}


def block(text, kind="paragraph", rectangle=None):
    return {"id": "b1", "kind": kind, "text": text, "evidence": {"boxes": [rectangle or box(.1, .5)]}}


class LocalSourceMatchingTests(unittest.TestCase):
    def test_short_tokens_numbers_punctuation_and_math_operators_survive(self):
        self.assertEqual(tokens("x ≤ 2; p=0.05, ﬁle!"), ["x", "≤", "2", ";", "p", "=", "0", ".", "05", ",", "file", "!"])
        self.assertFalse(compare_text("x ≤ 2", "x < 2")["exactLocalSequence"])
        self.assertFalse(compare_text("p=0.05", "p=0.5")["exactLocalSequence"])

    def test_partial_line_drop_cannot_count_as_represented(self):
        source = [line("training has two significant issues: (I) Using a predefined role profile", 1, .1)]
        document = {"blocks": [block("training has two significant role profile")]}
        ledger, _ = line_ledger(source, document)
        self.assertEqual(ledger[0]["status"], "unresolved")
        self.assertTrue(ledger[0]["candidates"][0]["differences"])

    def test_same_text_elsewhere_in_paper_cannot_cover_a_missing_local_line(self):
        source = [line("The key result is 3.", 1, .1)]
        wrong_location = block("The key result is 3.", rectangle=box(.7, .2))
        ledger, _ = line_ledger(source, {"blocks": [wrong_location]})
        self.assertEqual(ledger[0]["status"], "unresolved")
        self.assertFalse(ledger[0]["candidates"])

    def test_wrong_source_line_order_is_pending_even_if_all_words_present(self):
        source = [line("There exists beta.", 1, .1), line("Such that x is defined.", 2, .2)]
        ledger, warnings = line_ledger(source, {"blocks": [block("Such that x is defined. There exists beta.")]})
        self.assertEqual({r["status"] for r in ledger}, {"unreviewed"})
        self.assertEqual(warnings[0]["code"], "SOURCE_LINE_ORDER_INVERSION")

    def test_two_source_occurrences_cannot_share_one_output_occurrence(self):
        source = [line("Again.", 1, .1), line("Again.", 2, .2)]
        ledger, warnings = line_ledger(source, {"blocks": [block("Again.")]})
        self.assertEqual({r["status"] for r in ledger}, {"unreviewed"})
        self.assertEqual(warnings[0]["code"], "SOURCE_LINE_OUTPUT_REUSED")

    def test_exact_local_text_is_evidence_without_claiming_full_fidelity(self):
        ledger, warnings = line_ledger([line("There exists beta.", 1, .1)], {"blocks": [block("There exists beta.")]})
        self.assertEqual(ledger[0]["status"], "represented")
        self.assertIn("not certified", ledger[0]["reason"])
        self.assertFalse(warnings)

    def test_image_box_does_not_exclude_or_satisfy_source_text(self):
        ledger, _ = line_ledger([line("Important missing result", 1, .1)], {"blocks": [block("", "figure")]})
        self.assertEqual(ledger[0]["status"], "unreviewed")
        self.assertIn("do not establish coverage", ledger[0]["reason"])

    def test_furniture_claim_cannot_hide_meaningful_text(self):
        ledger, _ = line_ledger([line("Copyright ownership and usage terms", 1, .1)], {"blocks": [block("", "furniture")]})
        self.assertEqual(ledger[0]["status"], "unreviewed")

    def test_edge_numeral_is_not_justified_by_empty_converter_furniture(self):
        source = [line("1", 1, .02)]
        ledger, _ = line_ledger(source, {"blocks": [block("", "furniture", box(.01, .05))]})
        self.assertEqual(ledger[0]["status"], "unreviewed")
        self.assertFalse(ledger[0]["candidates"][0]["exactLocalSequence"])
        self.assertTrue(ledger[0]["candidates"][0]["differences"])

    def test_matching_edge_numeral_still_requires_source_furniture_justification(self):
        ledger, _ = line_ledger([line("1", 1, .02)], {"blocks": [block("1", "furniture", box(.01, .05))]})
        self.assertEqual(ledger[0]["status"], "unreviewed")

    def test_duplicate_visible_text_is_not_silent_success(self):
        a, b = block("The result is 3."), block("The result is 3.")
        b["id"] = "b2"
        ledger, warnings = line_ledger([line("The result is 3.", 1, .1)], {"blocks": [a, b]})
        self.assertEqual(ledger[0]["status"], "unreviewed")
        self.assertEqual(warnings[0]["code"], "DUPLICATE_SOURCE_LINE_CANDIDATE")


class TableEvidenceTests(unittest.TestCase):
    def test_wrong_cell_value_is_not_satisfied_by_value_in_another_row(self):
        table = block("", "table")
        table["table"] = {"rows": 2, "columns": 1, "cells": [
            {"id": "c0", "row": 0, "column": 0, "text": "7", "evidence": {"boxes": [box(.1)]}},
            {"id": "c1", "row": 1, "column": 0, "text": "7", "evidence": {"boxes": [box(.2)]}},
        ]}
        result = table_census(table, [line("8", 1, .1), line("7", 2, .2)])
        self.assertIn("CELL_VALUE_NOT_EXACT_IN_CLAIMED_REGION", result["cells"][0]["flags"])
        self.assertEqual(result["status"], "unreviewed")

    def test_whole_table_boxes_cannot_prove_individual_cell_meaning(self):
        table = block("", "table")
        table["table"] = {"rows": 2, "columns": 1, "cells": [
            {"id": "c0", "row": 0, "column": 0, "text": "18 2", "evidence": table["evidence"]},
            {"id": "c1", "row": 1, "column": 0, "text": "8 6", "evidence": table["evidence"]},
        ]}
        result = table_census(table, [line("18 2", 1, .1), line("8 6", 2, .2)])
        self.assertTrue(all("CELL_BOX_EQUALS_WHOLE_TABLE" in c["flags"] for c in result["cells"]))

    def test_row_geometry_disagrees_with_declared_order(self):
        table = block("", "table")
        table["table"] = {"rows": 2, "columns": 1, "cells": [
            {"id": "c0", "row": 0, "column": 0, "text": "7", "evidence": {"boxes": [box(.2)]}},
            {"id": "c1", "row": 1, "column": 0, "text": "8", "evidence": {"boxes": [box(.1)]}},
        ]}
        result = table_census(table, [line("8", 1, .1), line("7", 2, .2)])
        self.assertEqual(result["flags"][0]["code"], "CELL_ROW_ORDER_GEOMETRY_CONFLICT")


class VisualEvidenceTests(unittest.TestCase):
    def test_blank_raster_cannot_satisfy_nonblank_source_crop(self):
        result = image_comparison(Image.new("RGB", (50, 50), "black"), Image.new("RGB", (50, 50), "white"))
        self.assertEqual(result["status"], "unreviewed")
        self.assertIn("BLANK_OUTPUT_IMAGE", result["flags"])
        self.assertIn("SOURCE_INK_MISSING_CANDIDATE", result["flags"])

    def test_identical_crop_is_still_pending_extent_review(self):
        image = Image.new("RGB", (50, 50), "black")
        result = image_comparison(image, image)
        self.assertEqual(result["meanAbsolutePixelDifference"], 0)
        self.assertEqual(result["status"], "unreviewed")
        self.assertIn("omit", result["limitation"])

    def test_missing_image_asset_generates_unresolved_task(self):
        obj = block("Figure 3", "figure")
        obj["fallbackAssetIds"] = ["missing"]
        class Raster:
            def page_image(self, _):
                return Image.new("RGB", (100, 100), "black")
        with tempfile.TemporaryDirectory() as directory:
            result = visual_tasks({"blocks": [obj]}, Raster(), Path(directory))
        image = result[0]["comparisons"][0]["outputs"][0]
        self.assertEqual(image["status"], "unresolved")
        self.assertIn("INVALID_OUTPUT_IMAGE", image["flags"])

    def test_packaged_output_inventory_does_not_certify_layout(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            epub = Path(directory) / "test.epub"
            with zipfile.ZipFile(epub, "w") as archive:
                archive.writestr("EPUB/content.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="b1">Text</p></body></html>')
            result = epub_inventory(epub)
        self.assertEqual(result["status"], "unreviewed")
        self.assertEqual(result["documents"][0]["ids"], ["b1"])
        self.assertIn("does not simulate pagination", result["requiredReview"])


class OutputCollisionTests(unittest.TestCase):
    def assert_rejected_without_writes(self, pdf, struct, out, **kwargs):
        preserved = {path: path.read_bytes() for path in (pdf, struct, *kwargs.get("epub_paths", ()), *kwargs.get("cache_paths", ()))}
        before = sorted(str(p.relative_to(out)) for p in out.rglob("*")) if out.exists() else []
        with patch("fidelity.source_census") as census:
            with self.assertRaisesRegex(ValueError, "input|symlink"):
                build_packet(pdf, struct, out, **kwargs)
            census.assert_not_called()
        self.assertEqual({path: path.read_bytes() for path in preserved}, preserved)
        self.assertEqual(sorted(str(p.relative_to(out)) for p in out.rglob("*")) if out.exists() else [], before)

    def fixture(self, root):
        pdf, struct, out = root / "source.pdf", root / "struct.json", root / "packet"
        pdf.write_bytes(b"private source")
        struct.write_text(json.dumps({"blocks": [], "source": {"sha256": digest(pdf.read_bytes())}}))
        out.mkdir()
        return pdf, struct, out

    def test_struct_input_at_generated_page_path_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct, out = self.fixture(Path(directory))
            (out / "source-pages").mkdir()
            target = out / "source-pages" / "page-0001.png"
            struct.rename(target)
            self.assert_rejected_without_writes(pdf, target, out)

    def test_cache_input_in_visual_subtree_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct, out = self.fixture(Path(directory))
            (out / "visual-tasks").mkdir()
            cache = out / "visual-tasks" / "object-00000-000-source.png"
            cache.write_bytes(b"cache evidence")
            self.assert_rejected_without_writes(pdf, struct, out, cache_paths=[cache])

    def test_generated_page_symlink_to_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct, out = self.fixture(Path(directory))
            (out / "source-pages").mkdir()
            (out / "source-pages" / "page-0001.png").symlink_to(struct)
            self.assert_rejected_without_writes(pdf, struct, out)

    def test_generated_subtree_symlink_alias_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct, out = self.fixture(Path(directory))
            (out / "visual-tasks").symlink_to(struct.parent, target_is_directory=True)
            self.assert_rejected_without_writes(pdf, struct, out)

    def test_metadata_symlink_alias_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct, out = self.fixture(Path(directory))
            (out / "evidence.json").symlink_to(struct)
            self.assert_rejected_without_writes(pdf, struct, out)

    def test_generated_hardlink_to_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct, out = self.fixture(Path(directory))
            (out / "evidence.md").hardlink_to(struct)
            self.assert_rejected_without_writes(pdf, struct, out)


class RasterLifecycleTests(unittest.TestCase):
    def run_builder(self, directory, visual_error=None, render_error=None):
        from source_raster import SourceRaster
        pdf, struct = Path(directory) / "source.pdf", Path(directory) / "struct.json"
        pdf.write_bytes(b"immutable private source fixture")
        expected = digest(pdf.read_bytes())
        struct.write_text(json.dumps({"blocks": [], "source": {"sha256": expected}}))
        snapshots, providers = [], []
        def provider(*args, **kwargs):
            self.assertEqual(kwargs.get("expected_sha256"), expected)
            instance = SourceRaster(*args, **kwargs)
            snapshots.append(instance._snapshot_path)
            providers.append(instance)
            return instance
        try:
            with patch("fidelity.SourceRaster", side_effect=provider), \
                 patch("source_raster.SourceRaster._render_page", side_effect=render_error, return_value=Image.new("RGB", (10, 10), "white")), \
                 patch("fidelity.source_census", return_value=([{"page": 1, "lines": [], "glyphs": []}], [])), \
                 patch("fidelity.annotation_census", return_value=[]), \
                 patch("fidelity.code_identity", return_value={}), \
                 patch("fidelity.tool_versions", return_value={}), \
                 patch("fidelity.visual_tasks", side_effect=visual_error, return_value=[]):
                return build_packet(pdf, struct, Path(directory) / "packet")
        finally:
            self.assertEqual(len(providers), 1)
            self.assertTrue(providers[0]._closed)
            self.assertTrue(all(not path.exists() for path in snapshots))

    def test_private_snapshot_closed_after_success(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = self.run_builder(directory)
        self.assertEqual(packet["status"], "review-required")

    def test_private_snapshot_closed_when_visual_comparison_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "comparison failed"):
                self.run_builder(directory, visual_error=RuntimeError("comparison failed"))

    def test_private_snapshot_closed_when_page_render_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "render failed"):
                self.run_builder(directory, render_error=RuntimeError("render failed"))

    def test_changed_input_fails_expected_hash_before_raster_use(self):
        from source_raster import SourceRasterError
        with tempfile.TemporaryDirectory() as directory:
            pdf, struct = Path(directory) / "source.pdf", Path(directory) / "struct.json"
            pdf.write_bytes(b"original")
            struct.write_text(json.dumps({"blocks": [], "source": {"sha256": digest(b"original")}}))
            def census(path):
                path.write_bytes(b"replacement")
                return [], []
            with patch("fidelity.source_census", side_effect=census), \
                 patch("fidelity.code_identity", return_value={}), \
                 patch("fidelity.visual_tasks") as visuals:
                with self.assertRaisesRegex(SourceRasterError, "SHA-256 mismatch"):
                    build_packet(pdf, struct, Path(directory) / "packet")
                visuals.assert_not_called()


if __name__ == "__main__":
    unittest.main()
