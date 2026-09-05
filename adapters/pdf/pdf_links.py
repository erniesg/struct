"""Source link evidence: URI annotations and word boxes from the PDF itself.

Docling only records a hyperlink when a whole layout item is one link. Papers
link citations, URLs and cross-references inline, so the annotation rectangles
in the PDF are the ground truth. Word boxes from pdftotext let us recover the
exact visible text under each rectangle so the STRUCT inline run covers the
same words.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


UNSAFE_URI_CHARS = re.compile(r"[{}|\\^`\"<>\u0000-\u001f\u007f]|[^\x00-\x7f]")
HOST_LIKE_RE = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$)", re.IGNORECASE)
QUOTE_CHARS = "\"'“”‘’«»"


def normalize_uri(uri: str) -> str:
    """The comparable, renderable form of a link target: whitespace and
    wrapping quotes removed, a doubled scheme collapsed, a bare host given
    `http://`, characters a WHATWG parser would reject percent-encoded, then
    the parser's own canonical shape (lowercase scheme and host, `/` for an
    empty path). The adapter emits this form and the evaluator compares it,
    so an annotation and the rendered href agree by construction."""
    value = re.sub(r"\s|\u200b|\u00ad", "", uri or "")
    value = value.strip(QUOTE_CHARS)
    value = re.sub(r"^(https?://)(?:https?://)+", r"\1", value, flags=re.IGNORECASE)
    if value and not re.match(r"^[a-z][a-z0-9+.-]*:", value, re.IGNORECASE) and HOST_LIKE_RE.match(value):
        value = "http://" + value
    value = UNSAFE_URI_CHARS.sub(lambda m: "".join(f"%{b:02X}" for b in m.group(0).encode("utf-8")), value)
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    if not parts.scheme or not parts.netloc:
        return value
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", parts.query, parts.fragment))


@dataclass
class SourceLink:
    page: int  # 1-based
    rect: tuple[float, float, float, float]  # l, b, r, t in PDF points (bottom-left origin)
    uri: str | None  # external target, None for internal destinations
    kind: str  # 'uri' | 'internal'
    words: list[str] = field(default_factory=list)
    group_words: list[str] | None = None  # words of every line of a wrapped link, in reading order

    @property
    def text(self) -> str:
        return " ".join(self.words).strip()

    @property
    def group_text(self) -> str:
        """Visible text of the whole link when it wraps over several lines
        (one annotation per line, the same target)."""
        return " ".join(self.group_words or self.words).strip()


def _rect_of(annotation) -> tuple[float, float, float, float] | None:
    rect = annotation.get("/Rect")
    if not rect or len(rect) != 4:
        return None
    x0, y0, x1, y1 = (float(v) for v in rect)
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def extract_links(pdf_path: Path) -> tuple[list[SourceLink], dict[int, tuple[float, float]]]:
    """Return every link annotation with its rectangle plus page sizes."""
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    links: list[SourceLink] = []
    sizes: dict[int, tuple[float, float]] = {}
    for index, page in enumerate(reader.pages, start=1):
        box = page.mediabox
        sizes[index] = (float(box.width), float(box.height))
        annotations = page.get("/Annots") or []
        for reference in annotations:
            try:
                annotation = reference.get_object()
            except Exception:  # pragma: no cover - malformed annotation
                continue
            if annotation.get("/Subtype") != "/Link":
                continue
            rect = _rect_of(annotation)
            if rect is None:
                continue
            action = annotation.get("/A")
            uri = None
            kind = "internal"
            if action is not None:
                try:
                    action = action.get_object()
                except Exception:  # pragma: no cover
                    action = None
            if action is not None and action.get("/S") == "/URI":
                uri = str(action.get("/URI"))
                kind = "uri"
            elif action is None and annotation.get("/Dest") is None:
                continue
            links.append(SourceLink(page=index, rect=rect, uri=uri, kind=kind))
    return links, sizes


class _BBoxParser(HTMLParser):
    """Parse `pdftotext -bbox` output into per-page word boxes (top-left origin)."""

    def __init__(self) -> None:
        super().__init__()
        self.pages: list[list[tuple[float, float, float, float, str]]] = []
        self._current_word: dict | None = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "page":
            self.pages.append([])
        elif tag == "word" and self.pages:
            self._current_word = {
                "box": (
                    float(attributes["xmin"]),
                    float(attributes["ymin"]),
                    float(attributes["xmax"]),
                    float(attributes["ymax"]),
                ),
                "text": "",
            }

    def handle_data(self, data):
        if self._current_word is not None:
            self._current_word["text"] += data

    def handle_endtag(self, tag):
        if tag == "word" and self._current_word is not None and self.pages:
            box = self._current_word["box"]
            self.pages[-1].append((*box, self._current_word["text"]))
            self._current_word = None


def word_boxes(pdf_path: Path) -> list[list[tuple[float, float, float, float, str]]]:
    """Word boxes per page from pdftotext (x0, y0, x1, y1, text), top-left origin."""
    try:
        result = subprocess.run(
            ["pdftotext", "-bbox", str(pdf_path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    parser = _BBoxParser()
    parser.feed(result.stdout)
    return parser.pages


def attach_words(
    links: list[SourceLink],
    boxes: list[list[tuple[float, float, float, float, str]]],
    sizes: dict[int, tuple[float, float]],
) -> None:
    """Fill each link's visible words from the word boxes under its rectangle."""
    for link in links:
        if link.page - 1 >= len(boxes):
            continue
        _, page_height = sizes.get(link.page, (0.0, 0.0))
        l, b, r, t = link.rect
        top = page_height - t
        bottom = page_height - b
        words = []
        for x0, y0, x1, y1, text in boxes[link.page - 1]:
            cx = (x0 + x1) / 2
            cy = (y0 + y1) / 2
            if l - 1 <= cx <= r + 1 and top - 1 <= cy <= bottom + 1:
                words.append(text)
        link.words = words


def group_wrapped_links(links: list[SourceLink]) -> None:
    """Annotations on one page with the same target whose rectangles sit on
    consecutive lines (each starts near the line below the previous one) are
    one link that wrapped; every member learns the words of the whole group."""
    by_key: dict[tuple[int, str], list[SourceLink]] = {}
    for link in links:
        if link.kind == "uri" and link.uri:
            by_key.setdefault((link.page, link.uri), []).append(link)
    for members in by_key.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda link: (-link.rect[3], link.rect[0]))
        group: list[SourceLink] = [members[0]]
        for previous, link in zip(members, members[1:]):
            height = max(previous.rect[3] - previous.rect[1], 1.0)
            gap = previous.rect[1] - link.rect[3]
            if -0.5 * height <= gap <= 1.6 * height:
                group.append(link)
            else:
                if len(group) > 1:
                    words = [w for member in group for w in member.words]
                    for member in group:
                        member.group_words = words
                group = [link]
        if len(group) > 1:
            words = [w for member in group for w in member.words]
            for member in group:
                member.group_words = words


def page_text_lines(pdf_path: Path) -> list[list[str]]:
    """Plain text lines per page (reading-order heuristic of pdftotext)."""
    try:
        result = subprocess.run(
            ["pdftotext", str(pdf_path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    pages = result.stdout.split("\f")
    return [[line.rstrip() for line in page.split("\n")] for page in pages if page.strip()]


class _LayoutParser(HTMLParser):
    """Parse `pdftotext -bbox-layout` into per-page lines with geometry."""

    def __init__(self) -> None:
        super().__init__()
        self.pages: list[dict] = []
        self._line: dict | None = None
        self._word: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "page":
            self.pages.append({"width": float(attributes.get("width", 0) or 0), "height": float(attributes.get("height", 0) or 0), "lines": []})
        elif tag == "line" and self.pages:
            self._line = {"ymin": float(attributes["ymin"]), "ymax": float(attributes["ymax"]), "xmin": float(attributes["xmin"]), "xmax": float(attributes["xmax"]), "words": []}
        elif tag == "word" and self._line is not None:
            self._word = []

    def handle_data(self, data):
        if self._word is not None:
            self._word.append(data)

    def handle_endtag(self, tag):
        if tag == "word" and self._word is not None and self._line is not None:
            self._line["words"].append("".join(self._word))
            self._word = None
        elif tag == "line" and self._line is not None and self.pages:
            self._line["text"] = " ".join(self._line["words"])
            del self._line["words"]
            self.pages[-1]["lines"].append(self._line)
            self._line = None


def page_layout_lines(pdf_path: Path) -> list[dict]:
    """Per page: width, height and text lines with their boxes (top-left
    origin, PDF points), from `pdftotext -bbox-layout`."""
    try:
        result = subprocess.run(
            ["pdftotext", "-bbox-layout", str(pdf_path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    parser = _LayoutParser()
    parser.feed(result.stdout)
    return parser.pages


WORD_RE = re.compile(r"[\w][\w'’\-]*", re.UNICODE)
