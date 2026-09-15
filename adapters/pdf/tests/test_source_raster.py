"""Direct-PDF rasters used for source-region recovery."""

from __future__ import annotations

import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from source_raster import SourceRaster, SourceRasterError  # noqa: E402
from pdf2struct import StructAdapter  # noqa: E402


def vector_pdf(path: Path, pages: int = 1, x: int = 72) -> None:
    """Create a small public fixture with a black rectangle, without a corpus PDF."""
    writer = PdfWriter()
    for page_number in range(pages):
        page = writer.add_blank_page(width=612, height=792)
        stream = DecodedStreamObject()
        stream.set_data(f"0 g {x + page_number * 18} 648 180 72 re f\n".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    with path.open("wb") as output:
        writer.write(output)


def rotated_vector_pdf(path: Path) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    stream = DecodedStreamObject()
    stream.set_data(b"0 g 72 648 180 72 re f\n")
    page[NameObject("/Contents")] = writer._add_object(stream)
    page.rotate(90)
    with path.open("wb") as output:
        writer.write(output)


def pixel_digest(image) -> str:
    data = io.BytesIO()
    image.save(data, format="PNG")
    return hashlib.sha256(data.getvalue()).hexdigest()


class SourceRasterTests(unittest.TestCase):
    def test_renders_the_original_pdf_at_fixed_144_dpi(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf)

            image = SourceRaster(pdf).page_image(1)

        self.assertEqual(image.size, (1224, 1584))
        self.assertLess(image.convert("L").getextrema()[0], 8)

    def test_same_page_uses_the_in_memory_source_render(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf)
            raster = SourceRaster(pdf)
            first = raster.page_image(1)
            with mock.patch("source_raster.subprocess.run", side_effect=AssertionError("rendered twice")):
                second = raster.page_image(1)

        self.assertEqual(pixel_digest(first), pixel_digest(second))
        self.assertIsNot(first, second)

    def test_independent_144_dpi_renders_have_identical_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf)
            first = SourceRaster(pdf).page_image(1)
            second = SourceRaster(pdf).page_image(1)

        self.assertEqual(pixel_digest(first), pixel_digest(second))

    def test_snapshot_prevents_replaced_input_from_mixing_cached_and_new_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf, pages=2, x=72)
            raster = SourceRaster(pdf, max_cached_pages=1)
            expected = SourceRaster(pdf).page_image(2)
            first = raster.page_image(1)
            vector_pdf(pdf, pages=2, x=300)

            second = raster.page_image(2)
            replacement = SourceRaster(pdf).page_image(2)

            raster.close()

        self.assertNotEqual(pixel_digest(first), pixel_digest(second))
        self.assertEqual(pixel_digest(second), pixel_digest(expected))
        self.assertNotEqual(pixel_digest(second), pixel_digest(replacement))

    def test_expected_input_hash_rejects_a_different_pdf_before_rendering(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf)

            with self.assertRaisesRegex(SourceRasterError, "source SHA-256 mismatch"):
                SourceRaster(pdf, expected_sha256="0" * 64)

    def test_close_removes_the_private_input_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf)
            raster = SourceRaster(pdf)
            snapshot = raster.snapshot_path
            self.assertTrue(snapshot and snapshot.is_file())
            self.assertEqual(snapshot.name, pdf.name)

            raster.close()

            self.assertFalse(snapshot.exists())
            with self.assertRaisesRegex(SourceRasterError, "closed"):
                _ = raster.snapshot_path

    def test_pdf_rotation_is_preserved_in_visual_page_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "rotated-vector.pdf"
            rotated_vector_pdf(pdf)

            image = SourceRaster(pdf).page_image(1)

        self.assertEqual(image.size, (1584, 1224))
        self.assertLess(image.convert("L").getextrema()[0], 8)

    def test_cache_is_bounded_and_evicted_page_is_rendered_again(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf, pages=2)
            raster = SourceRaster(pdf, max_cached_pages=1)
            raster.page_image(1)
            raster.page_image(2)
            self.assertEqual(tuple(raster._images), (2,))
            raster.page_image(1)

        self.assertEqual(tuple(raster._images), (1,))

    def test_renderer_failure_is_clear_and_never_falls_back_to_another_image(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "vector.pdf"
            vector_pdf(pdf)

            with self.assertRaisesRegex(SourceRasterError, "original PDF.*missing-pdftoppm"):
                SourceRaster(pdf, renderer="missing-pdftoppm").page_image(1)

    def test_adapter_prefers_source_raster_over_masked_docling_page_image(self):
        adapter = StructAdapter.__new__(StructAdapter)
        masked = Image.new("RGB", (20, 20), "white")
        source = Image.new("RGB", (20, 20), "black")
        adapter.doc = SimpleNamespace(pages={1: SimpleNamespace(image=SimpleNamespace(pil_image=masked))})
        adapter.source_raster = SimpleNamespace(page_image=mock.Mock(return_value=source))

        image = adapter._page_image(1)

        adapter.source_raster.page_image.assert_called_once_with(1)
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 0))

    def test_adapter_does_not_fall_back_when_source_raster_fails(self):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.doc = SimpleNamespace(pages={1: SimpleNamespace(image=SimpleNamespace(pil_image=Image.new("RGB", (20, 20), "white")))})
        adapter.source_raster = SimpleNamespace(page_image=mock.Mock(side_effect=SourceRasterError("render failed")))

        with self.assertRaisesRegex(SourceRasterError, "render failed"):
            adapter._page_image(1)

    def test_adapter_refuses_a_docling_page_image_without_source_raster(self):
        adapter = StructAdapter.__new__(StructAdapter)
        adapter.doc = SimpleNamespace(pages=SimpleNamespace(get=mock.Mock(return_value=SimpleNamespace(image=Image.new("RGB", (20, 20), "white")))))
        adapter.source_raster = None

        with self.assertRaisesRegex(SourceRasterError, "source raster is required"):
            adapter._page_image(1)

        adapter.doc.pages.get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
