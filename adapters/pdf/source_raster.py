"""Trusted page rasters rendered directly from an input PDF.

Docling page images can contain masking artefacts.  Region-recovery crops must
therefore come from Poppler rendering the original PDF, never from the
extraction document's cached page image.
"""

from __future__ import annotations

from collections import OrderedDict
import hashlib
from pathlib import Path
import subprocess
import tempfile

from PIL import Image


class SourceRasterError(RuntimeError):
    """The original PDF could not be rendered for a recovery crop."""


class SourceRaster:
    """Lazy, bounded cache of Poppler page rasters for one original PDF.

    Poppler applies PDF page rotation while rendering, so its image dimensions
    match the visual page coordinate system used by normalized crop boxes.
    """

    def __init__(
        self,
        pdf_path: Path,
        *,
        dpi: int = 144,
        renderer: str = "pdftoppm",
        max_cached_pages: int = 8,
        expected_sha256: str | None = None,
    ) -> None:
        if dpi != 144:
            raise ValueError("source raster DPI is fixed at 144")
        if max_cached_pages < 1:
            raise ValueError("max_cached_pages must be at least 1")
        self.pdf_path = Path(pdf_path)
        self.dpi = dpi
        # page number -> the resolution it had to fall back to
        self.degraded_pages: dict[int, int] = {}
        self.renderer = renderer
        self.max_cached_pages = max_cached_pages
        self._images: OrderedDict[int, Image.Image] = OrderedDict()
        self._closed = False
        self._snapshot_path: Path | None = None
        self._snapshot_directory = None
        self.source_sha256 = self._snapshot_original(expected_sha256)

    def _snapshot_original(self, expected_sha256: str | None) -> str:
        """Copy the input once so later pages cannot come from a replacement.

        The snapshot is deliberately outside the project and is removed by
        :meth:`close`.  Hashing the bytes while they are copied means a caller
        which already knows its input digest can fail before any crop renders.
        """
        if not self.pdf_path.is_file():
            raise SourceRasterError(f"cannot snapshot original PDF: file does not exist: {self.pdf_path}")
        snapshot_directory = tempfile.TemporaryDirectory(prefix="struct-source-raster-")
        snapshot_path = Path(snapshot_directory.name) / self.pdf_path.name
        digest = hashlib.sha256()
        try:
            with self.pdf_path.open("rb") as source, snapshot_path.open("xb") as temporary:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    temporary.write(chunk)
            actual_sha256 = digest.hexdigest()
            if expected_sha256 is not None and actual_sha256 != expected_sha256.lower():
                raise SourceRasterError("source SHA-256 mismatch while snapshotting original PDF")
        except Exception:
            snapshot_directory.cleanup()
            raise
        self._snapshot_directory = snapshot_directory
        self._snapshot_path = snapshot_path
        return actual_sha256

    @property
    def snapshot_path(self) -> Path:
        """The immutable input snapshot used by every PDF-reading consumer."""
        if self._closed or self._snapshot_path is None:
            raise SourceRasterError("source raster is closed")
        return self._snapshot_path

    def close(self) -> None:
        """Release cached page images and remove the private PDF snapshot."""
        if self._closed:
            return
        self._closed = True
        for image in self._images.values():
            image.close()
        self._images.clear()
        if self._snapshot_directory is not None:
            self._snapshot_directory.cleanup()
            self._snapshot_directory = None
        self._snapshot_path = None

    def __enter__(self) -> "SourceRaster":
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()

    def __del__(self) -> None:
        if hasattr(self, "_closed"):
            self.close()

    def page_image(self, page_number: int) -> Image.Image:
        """Return a copy of a visual PDF page raster for a one-based page number.

        Returning a copy keeps consumers that annotate or mutate an image from
        contaminating later crops.  Rendering failures deliberately propagate:
        silently substituting a Docling image would reintroduce masked content.
        """
        if not isinstance(page_number, int) or isinstance(page_number, bool) or page_number < 1:
            raise ValueError("page_number must be a positive, one-based integer")
        if self._closed:
            raise SourceRasterError("source raster is closed")
        cached = self._images.get(page_number)
        if cached is not None:
            self._images.move_to_end(page_number)
            return cached.copy()

        image = self._render_page(page_number)
        self._images[page_number] = image
        self._images.move_to_end(page_number)
        while len(self._images) > self.max_cached_pages:
            _, evicted = self._images.popitem(last=False)
            evicted.close()
        return image.copy()

    def _render_page(self, page_number: int) -> Image.Image:
        """The page as an image, at the coarsest resolution that renders in time.

        A page of dense vector artwork can take longer to raster than the
        budget allows, and a document is not worth losing over one slow page:
        a crop taken at half resolution is a far better answer than refusing
        the whole reconstruction. Resolution is halved and retried, twice,
        before giving up.
        """
        for dpi in (self.dpi, self.dpi // 2, self.dpi // 4):
            try:
                return self._render_page_at(page_number, dpi)
            except SourceRasterError as error:
                if "timed out" not in str(error) or dpi <= self.dpi // 4:
                    raise
                self.degraded_pages[page_number] = dpi // 2
        raise SourceRasterError(f"cannot render original PDF with {self.renderer}: timed out on page {page_number}")

    def _render_page_at(self, page_number: int, dpi: int) -> Image.Image:
        if self._snapshot_path is None:
            raise SourceRasterError("source raster has no PDF snapshot")
        with tempfile.TemporaryDirectory(prefix="struct-source-raster-") as directory:
            output = Path(directory) / "page"
            command = [
                self.renderer,
                "-f",
                str(page_number),
                "-l",
                str(page_number),
                "-r",
                str(dpi),
                "-png",
                "-singlefile",
                str(self._snapshot_path),
                str(output),
            ]
            try:
                completed = subprocess.run(command, capture_output=True, text=True, timeout=60)
            except FileNotFoundError as error:
                raise SourceRasterError(
                    f"cannot render original PDF with {self.renderer}: renderer is unavailable"
                ) from error
            except subprocess.TimeoutExpired as error:
                raise SourceRasterError(
                    f"cannot render original PDF with {self.renderer}: timed out on page {page_number}"
                ) from error
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "unknown renderer error").strip().splitlines()[-1]
                raise SourceRasterError(
                    f"cannot render original PDF with {self.renderer} on page {page_number}: {detail}"
                )
            image_path = output.with_suffix(".png")
            if not image_path.is_file():
                raise SourceRasterError(
                    f"cannot render original PDF with {self.renderer} on page {page_number}: no PNG produced"
                )
            with Image.open(image_path) as source:
                source.load()
                return source.copy()
