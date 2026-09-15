"""Read a page region with Tesseract when the PDF's text layer there cannot be decoded.

Some PDFs set glyphs whose fonts carry no usable Unicode map: the text layer
reads `Recen work has demons ra ed a power aw` where the page shows `Recent
work has demonstrated a power law`, and a layout model that finds no text there
calls the column a picture. The page image is still the source; Tesseract reads
what a reader sees. Nothing here runs unless the text layer is shown to be
undecodable, and a missing `tesseract` binary means no OCR, not an error.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

WORD_RE = re.compile(r"[A-Za-z]+")


def short_word_share(text: str) -> float | None:
    """Share of alphabetic tokens of one or two letters, or None without five tokens."""
    words = WORD_RE.findall(text)
    if len(words) < 5:
        return None
    return sum(len(word) <= 2 for word in words) / len(words)


def undecodable_lines(lines: list[str], threshold: float = 0.45) -> bool:
    """True when at least five lines of five or more words read as fragments.

    Ordinary prose sets a word of one or two letters about one time in five;
    a text layer missing `l`, `t`, `i` and `f` sets them one time in two.
    """
    shares = [share for share in (short_word_share(line) for line in lines) if share is not None]
    return len(shares) >= 5 and sum(share > threshold for share in shares) >= 0.6 * len(shares)


def ocr_paragraphs(pdf: Path, page: int, box: dict, page_width: float, page_height: float, dpi: int = 300) -> list[list[str]] | None:
    """The lines of each paragraph Tesseract reads in a normalized page region
    (None when OCR is unavailable or fails)."""
    if not shutil.which("tesseract") or not shutil.which("pdftoppm"):
        return None
    scale = dpi / 72
    x, y = int(box["x"] * page_width * scale), int(box["y"] * page_height * scale)
    width, height = int(box["width"] * page_width * scale), int(box["height"] * page_height * scale)
    if width < 20 or height < 20:
        return None
    with tempfile.TemporaryDirectory(prefix="struct-ocr-") as directory:
        stem = Path(directory) / "region"
        try:
            subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), "-x", str(x), "-y", str(y),
                            "-W", str(width), "-H", str(height), "-singlefile", "-png", str(pdf), str(stem)],
                           check=True, capture_output=True, timeout=120)
            result = subprocess.run(["tesseract", f"{stem}.png", "stdout", "--psm", "4", "-l", "eng"],
                                    check=True, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            return None
    paragraphs = []
    for chunk in re.split(r"\n\s*\n", result.stdout):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if lines:
            paragraphs.append(lines)
    return paragraphs or None
