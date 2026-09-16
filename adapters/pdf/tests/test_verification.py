"""Contract tests for the independent PDF replay verifier."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pdf2epub  # noqa: E402
from verify_outputs import COUNT_METRICS, COVERAGE_METRICS, UNRESOLVED_METRICS, run_epubcheck, verify  # noqa: E402


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_document(pdf: Path) -> dict:
    completeness = {key: 0 for key in COUNT_METRICS}
    completeness.update({key: 1 for key in COVERAGE_METRICS})
    completeness["unresolvedObjects"] = {key: 0 for key in UNRESOLVED_METRICS}
    completeness["ocrRequiredPages"] = []
    return {"basename": pdf.name, "sha256": digest(pdf), "byteLength": pdf.stat().st_size,
            "completeness": completeness,
            "readiness": {"status": "ready", "ready": True, "policy": "docling-epub-reader-criteria-v1",
                          "blockingDiagnosticCodes": []},
            "diagnosticCounts": {}}


class OutputVerification(unittest.TestCase):
    def make_fixture(self) -> tuple[Path, Path, Path, Path]:
        root = Path(tempfile.mkdtemp())
        run, baseline, output = root / "run", root / "baseline", root / "verification"
        pdf = root / "paper.pdf"
        pdf.write_bytes(b"source pdf")
        stem, document = "paper", valid_document(pdf)
        for directory in (run, baseline):
            (directory / stem).mkdir(parents=True)
            for report, schema in (("corpus-report.json", "docling-struct-report-1.0.0"),
                                   ("source-report.json", "pdf-source-report-1")):
                (directory / report).write_text(json.dumps({"schemaVersion": schema, "documents": [copy.deepcopy(document)]}))
            cache = directory / stem / f"{stem}.docling.json"
            assets = directory / stem / f"{stem}.docling_artifacts"
            assets.mkdir()
            image = assets / "image.png"
            Image.new("RGB", (1, 1), "white").save(image)
            cache.write_text(json.dumps({"pictures": [{"image": {"uri": str(image)}}]}))
            (directory / "cache-manifest.json").write_text(json.dumps({
                "schemaVersion": "pdf-cache-manifest-1",
                "documents": [{"basename": pdf.name, "sha256": digest(pdf), "byteLength": pdf.stat().st_size,
                    "sourcePath": str(pdf), "cache": {"path": f"{stem}/{stem}.docling.json",
                    "originalSha256": digest(cache), "relocatedSha256": digest(cache)},
                    "assets": [{"path": str(image), "sha256": digest(image)}]}],
            }))
        folder = run / stem
        for name, data in (("struct.json", b"struct"), ("content.xhtml", b"xhtml"),
                           ("paper-paperpro.epub", b"epub one"), ("paper-papermove.epub", b"epub two")):
            (folder / name).write_bytes(data)
        profiles = [{"id": "paperPro", "fileName": "paper-paperpro.epub", "bytes": 8,
                     "sha256": digest(folder / "paper-paperpro.epub")},
                    {"id": "paperProMove", "fileName": "paper-papermove.epub", "bytes": 8,
                     "sha256": digest(folder / "paper-papermove.epub")}]
        (folder / "render-report.json").write_text(json.dumps({"returncode": 0, "errors": [], "profiles": profiles}))
        return run, baseline, output, pdf

    def result(self, run: Path, baseline: Path, output: Path):
        return verify({"tuning": run}, {"tuning": baseline}, output, "epubcheck")

    @staticmethod
    def load(path: Path) -> dict:
        return json.loads(path.read_text())

    @staticmethod
    def save(path: Path, value: dict) -> None:
        path.write_text(json.dumps(value))

    def test_valid_fixture_accepts_empty_diagnostic_counts(self):
        run, baseline, output, _ = self.make_fixture()
        check = {"file": "fixture.epub", "available": True, "returncode": 0, "output": ""}
        with patch("verify_outputs.run_epubcheck", return_value=check):
            result = self.result(run, baseline, output)
        self.assertTrue(result["artifactValid"])
        self.assertEqual(result["problems"], [])

    def test_rejects_duplicate_profile_evidence_before_checker_runs(self):
        run, baseline, output, _ = self.make_fixture()
        report = self.load(run / "paper" / "render-report.json")
        report["profiles"].append(report["profiles"][0])
        self.save(run / "paper" / "render-report.json", report)
        with patch("verify_outputs.run_epubcheck") as checker:
            result = self.result(run, baseline, output)
        self.assertIn("tuning/paper: duplicate profile ids", result["problems"])
        checker.assert_not_called()

    def test_rejects_missing_or_inconsistent_source_binding_fields(self):
        cases = (("corpus-report.json", "byteLength", None), ("source-report.json", "byteLength", 1),
                 ("cache-manifest.json", "byteLength", None), ("cache-manifest.json", "sourcePath", ""))
        for target, field, value in cases:
            with self.subTest(target=target, field=field):
                run, baseline, output, _ = self.make_fixture()
                report = self.load(run / target)
                report["documents"][0][field] = value
                self.save(run / target, report)
                result = self.result(run, baseline, output)
                if field == "sourcePath":
                    # the hash and length still agree: only the missing path is a problem
                    self.assertIn("tuning/paper: sourcePath is missing or invalid", result["problems"])
                else:
                    self.assertIn("tuning/paper: source hash or byteLength is missing or not bound across reports", result["problems"])

    def test_allows_declared_source_and_image_symlinks(self):
        run, baseline, output, pdf = self.make_fixture()
        source_link = pdf.parent / "source-link.pdf"
        source_link.symlink_to(pdf)
        image = run / "paper" / "paper.docling_artifacts" / "image.png"
        image_link = image.with_name("image-link.png")
        image_link.symlink_to(image)
        cache = run / "paper" / "paper.docling.json"
        self.save(cache, {"pictures": [{"image": {"uri": str(image_link)}}]})
        manifest = self.load(run / "cache-manifest.json")
        manifest["documents"][0]["sourcePath"] = str(source_link)
        manifest["documents"][0]["cache"].update(originalSha256=digest(cache), relocatedSha256=digest(cache))
        manifest["documents"][0]["assets"] = [{"path": str(image_link), "sha256": digest(image_link)}]
        self.save(run / "cache-manifest.json", manifest)
        check = {"file": "fixture.epub", "available": True, "returncode": 0, "output": ""}
        with patch("verify_outputs.run_epubcheck", return_value=check):
            self.assertTrue(self.result(run, baseline, output)["artifactValid"])

    def test_rejects_original_cache_digest_when_relocated_digest_is_missing(self):
        run, baseline, output, _ = self.make_fixture()
        manifest = self.load(run / "cache-manifest.json")
        manifest["documents"][0]["cache"].pop("relocatedSha256")
        self.save(run / "cache-manifest.json", manifest)
        self.assertIn("tuning/paper: cache digest does not match manifest", self.result(run, baseline, output)["problems"])

    def test_rejects_noncanonical_or_symlink_escaping_cache_path(self):
        for path in ("/tmp/paper.docling.json", "paper/../paper.docling.json", "paper/alternate.docling.json"):
            with self.subTest(path=path):
                run, baseline, output, _ = self.make_fixture()
                manifest = self.load(run / "cache-manifest.json")
                manifest["documents"][0]["cache"]["path"] = path
                self.save(run / "cache-manifest.json", manifest)
                self.assertIn("tuning/paper: cache path is not canonical or escapes run directory", self.result(run, baseline, output)["problems"])
        run, baseline, output, _ = self.make_fixture()
        cache, outside = run / "paper" / "paper.docling.json", run.parent / "outside.json"
        outside.write_bytes(cache.read_bytes())
        cache.unlink()
        cache.symlink_to(outside)
        self.assertIn("tuning/paper: cache path is not canonical or escapes run directory", self.result(run, baseline, output)["problems"])

    def test_rejects_malformed_data_uri_and_unreadable_images(self):
        for uri in ("data:", "data:image/png;base64,%%%"):
            with self.subTest(uri=uri):
                run, baseline, output, _ = self.make_fixture()
                cache = run / "paper" / "paper.docling.json"
                self.save(cache, {"pictures": [{"image": {"uri": uri}}]})
                manifest = self.load(run / "cache-manifest.json")
                manifest["documents"][0]["cache"]["relocatedSha256"] = digest(cache)
                self.save(run / "cache-manifest.json", manifest)
                self.assertIn("tuning/paper: cache URI uses unsupported data scheme", self.result(run, baseline, output)["problems"])
        for damaged in ("invalid-zlib", "truncated"):
            with self.subTest(damaged=damaged):
                run, baseline, output, _ = self.make_fixture()
                image = run / "paper" / "paper.docling_artifacts" / "image.png"
                raw = image.read_bytes()
                if damaged == "truncated":
                    image.write_bytes(raw[:-8])
                else:
                    start = raw.index(b"IDAT") - 4
                    length = int.from_bytes(raw[start:start + 4], "big")
                    payload = bytearray(raw[start + 8:start + 8 + length])
                    payload[-1] ^= 1
                    image.write_bytes(raw[:start + 8] + payload + zlib.crc32(b"IDAT" + payload).to_bytes(4, "big") + raw[start + 12 + length:])
                manifest = self.load(run / "cache-manifest.json")
                manifest["documents"][0]["assets"][0]["sha256"] = digest(image)
                self.save(run / "cache-manifest.json", manifest)
                self.assertIn("tuning/paper: declared cache asset is not a readable image", self.result(run, baseline, output)["problems"])

    def test_rejects_profile_hardlink_aliases(self):
        run, baseline, output, _ = self.make_fixture()
        first, second = run / "paper" / "paper-paperpro.epub", run / "paper" / "paper-papermove.epub"
        second.unlink()
        os.link(first, second)
        report = self.load(run / "paper" / "render-report.json")
        report["profiles"][1].update(bytes=first.stat().st_size, sha256=digest(first))
        self.save(run / "paper" / "render-report.json", report)
        self.assertIn("tuning/paper: profile EPUB paths or inodes are not distinct", self.result(run, baseline, output)["problems"])

    def test_rejects_invalid_metrics_without_baseline_comparison_noise(self):
        run, baseline, output, _ = self.make_fixture()
        report = self.load(run / "corpus-report.json")
        report["documents"][0]["completeness"]["textCoverage"] = "garbage"
        self.save(run / "corpus-report.json", report)
        result = self.result(run, baseline, output)
        self.assertEqual(sum("current report: completeness metric schema is invalid" in item for item in result["problems"]), 1)
        self.assertEqual(result["documents"][0]["metricDiffs"], {})

    def test_fresh_manifest_refusal_removes_stale_reusable_pair(self):
        run, _, _, pdf = self.make_fixture()
        stale_source, stale_manifest = run / "source-report.json", run / "cache-manifest.json"
        (run / "paper" / "paper.docling_artifacts" / "image.png").write_bytes(b"not a PNG")
        with self.assertRaises(ValueError):
            pdf2epub.write_reuse_manifests(run, [pdf], [valid_document(pdf)])
        self.assertFalse(stale_source.exists())
        self.assertFalse(stale_manifest.exists())

    def test_process_uses_snapshot_and_refuses_replaced_original_before_publish(self):
        run, _, _, pdf = self.make_fixture()
        snapshot = run.parent / "snapshot.pdf"
        snapshot.write_bytes(pdf.read_bytes())
        sha = digest(snapshot)

        class Raster:
            source_sha256 = sha
            snapshot_path = snapshot
            def __enter__(self): return self
            def __exit__(self, *_): return None

        def consume(path, *_):
            self.assertEqual(path, snapshot)
            pdf.write_bytes(b"replacement")
            return {"basename": pdf.name, "sha256": sha, "byteLength": snapshot.stat().st_size}

        with patch("pdf2epub.SourceRaster", return_value=Raster()), patch("pdf2epub._process_snapshot", side_effect=consume):
            result = pdf2epub.process(pdf, run, ["paperPro"], False, False, False, None)
        self.assertEqual(result["code"], "SOURCE_CHANGED")

    def test_epubcheck_timeout_and_os_error_are_terminal_results(self):
        for failure in (subprocess.TimeoutExpired(["epubcheck"], 1), OSError("broken executable")):
            with self.subTest(failure=type(failure).__name__), patch("verify_outputs.shutil.which", return_value="epubcheck"), patch("verify_outputs.subprocess.run", side_effect=failure):
                result = run_epubcheck(Path("fixture.epub"), "epubcheck")
            self.assertTrue(result["available"])
            self.assertIsNone(result["returncode"])
            self.assertEqual(result["output"], type(failure).__name__)

    def test_adapter_cli_rejects_an_empty_profile_request(self):
        script = Path(__file__).resolve().parents[1] / "pdf2epub.py"
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run([sys.executable, str(script), directory, "--out", directory, "--profiles", ","], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("at least one profile", completed.stderr)
