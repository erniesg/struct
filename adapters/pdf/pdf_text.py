"""Character-level source signals read straight from the PDF with docling-parse.

Docling's layout output carries text and boxes but no typography. The PDF
itself still knows the font of every glyph and where each glyph sits on its
line, which is enough to decide deterministically:

- which small raised glyph runs are superscript markers (footnote and
  affiliation references) and which body word they follow,
- which words are bold or italic,
- whether a region is set in a monospace face (code) or a math face
  (a display formula the layout model mislabelled), and
- where the source line breaks fall inside a region (code listings).

Coordinates: docling-parse reports glyph boxes in PDF points with a
bottom-left origin. Callers pass regions as normalized top-left boxes
(`x`, `y`, `width`, `height` in page fractions), the same shape the
StructDocument draft uses, and get text offsets back.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path

MONO_RE = re.compile(
    r"mono|courier|CMTT|CMITT|typewriter|consolas|menlo|inconsolata|LMMono|DejaVuSansMono|SourceCodePro|"
    r"FiraMono|FiraCode|LucidaConsole|Verbatim|CodeText|Letter ?Gothic|NimbusMonL|TeXGyreCursor|cmtt|(?<![A-Za-z])TT(?![A-Za-z])",
    re.IGNORECASE,
)
MATH_RE = re.compile(
    r"CMSY|CMMI|CMEX|CMBSY|MathMI|MathSy|MathEx|txsy|txmia|txex|MSAM|MSBM|rsfs|eufm|eufb|wasy|stmary|esint|"
    r"LMMathItalic|LMMathSymbols|LMMathExtension|XCharterMath|STIX\w*Math|CambriaMath|(?<![A-Za-z])Symbol(?![A-Za-z])|Math(?!ematic)",
    re.IGNORECASE,
)
BOLD_RE = re.compile(
    r"bold|black|heavy|semibold|demibold|extrabold|ultrabold|CMBX|CMSSBX|CMBSY|(?<![A-Za-z])CMB(?![A-Za-z])|-B(?![A-Za-z])|(?<![A-Za-z])Bd(?![A-Za-z])",
    re.IGNORECASE,
)
ITALIC_RE = re.compile(
    r"italic|oblique|slanted|-It(?![A-Za-z])|Ital|CMTI|CMSL|CMSSI|CMITT|LMRomanSlant|(?<![A-Za-z])It(?![A-Za-z])",
    re.IGNORECASE,
)
MARKER_CHAR_RE = re.compile(r"[0-9*†‡§¶‖#,a-z]")
SYMBOL_ALIASES = str.maketrans({"∗": "*", "⋆": "*", "★": "*", "✱": "*", "＊": "*", "⁎": "*"})


def normalize_marker(text: str) -> str:
    return (text or "").translate(SYMBOL_ALIASES)


def classify_font(font_name: str) -> dict[str, bool]:
    name = (font_name or "").split("+")[-1]
    mono = bool(MONO_RE.search(name))
    math = not mono and bool(MATH_RE.search(name))
    return {
        "mono": mono,
        "math": math,
        "bold": bool(BOLD_RE.search(name)),
        "italic": not math and bool(ITALIC_RE.search(name)),
    }


@dataclass
class Char:
    text: str
    l: float
    b: float
    r: float
    t: float
    font: str
    superscript: bool = False

    @property
    def height(self) -> float:
        return self.t - self.b

    @property
    def cx(self) -> float:
        return (self.l + self.r) / 2

    @property
    def cy(self) -> float:
        return (self.b + self.t) / 2


@dataclass
class Line:
    chars: list[Char]
    b: float
    text: str = ""
    offsets: list[int] = field(default_factory=list)  # char index -> offset in text

    @property
    def l(self) -> float:
        return min(c.l for c in self.chars)

    @property
    def r(self) -> float:
        return max(c.r for c in self.chars)

    @property
    def t(self) -> float:
        return max(c.t for c in self.chars)

    @property
    def height(self) -> float:
        body = [c.height for c in self.chars if not c.superscript] or [c.height for c in self.chars]
        return statistics.median(body)

    def finalize(self) -> None:
        self.chars.sort(key=lambda c: c.l)
        parts: list[str] = []
        offsets: list[int] = []
        position = 0
        previous: Char | None = None
        for char in self.chars:
            if previous is not None:
                gap = char.l - previous.r
                threshold = 0.18 * min(previous.height, char.height) if not char.superscript else 0.5 * char.height
                if gap > threshold:
                    parts.append(" ")
                    position += 1
            offsets.append(position)
            parts.append(char.text)
            position += len(char.text)
            previous = char
        self.text = "".join(parts)
        self.offsets = offsets


@dataclass
class Marker:
    """A superscript glyph run and the body text it follows."""

    text: str
    page: int
    x: float  # normalized top-left box of the run
    y: float
    width: float
    height: float
    left_context: str  # up to 24 preceding non-space characters on the same line
    right_context: str
    at_line_start: bool

    @property
    def labels(self) -> list[str]:
        return [part for part in re.split(r"[,\s]+", self.text) if part]

    @property
    def parts(self) -> set[str]:
        """Every label the run can carry: comma-separated parts, digit runs
        and single symbols inside them (`1*†` carries 1, * and †)."""
        found: set[str] = set()
        for part in self.labels:
            found.add(part)
            found.update(re.findall(r"\d+|[^\d]", part))
        return found

    def has_label(self, label: str, loose: bool = False) -> bool:
        wanted = normalize_marker(label)
        if wanted in self.parts:
            return True
        if loose and wanted.isdigit() and len(wanted) == 1:
            # `12` on an author is affiliations 1 and 2 when no exact run matches
            return any(wanted in run and len(run) <= 3 for run in self.parts if run.isdigit())
        return False


class PageText:
    def __init__(self, page_no: int, width: float, height: float, chars: list[Char]) -> None:
        self.page_no = page_no
        self.width = width
        self.height = height
        self.chars = chars
        self._lines: list[Line] | None = None
        self._markers: list[Marker] | None = None

    # ------------------------------------------------------------ geometry
    def _normalized(self, l: float, b: float, r: float, t: float) -> tuple[float, float, float, float]:
        return (l / self.width, 1 - t / self.height, r / self.width, 1 - b / self.height)

    def _inside(self, char: Char, box: dict, margin: float = 0.004) -> bool:
        x0, y0, x1, y1 = self._normalized(char.l, char.b, char.r, char.t)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        return (
            box["x"] - margin <= cx <= box["x"] + box["width"] + margin
            and box["y"] - margin <= cy <= box["y"] + box["height"] + margin
        )

    @property
    def lines(self) -> list[Line]:
        if self._lines is None:
            self._lines = self._build_lines()
        return self._lines

    def _build_lines(self) -> list[Line]:
        chars = [c for c in self.chars if c.text.strip() and c.height > 0]
        if not chars:
            return []
        chars.sort(key=lambda c: (-c.b, c.l))
        groups: list[list[Char]] = []
        for char in chars:
            group = groups[-1] if groups else None
            if group is not None and abs(group[0].b - char.b) <= 0.22 * min(group[0].height, char.height):
                group.append(char)
            else:
                groups.append([char])
        lines: list[Line] = []
        for group in groups:
            group.sort(key=lambda c: c.l)
            current: list[Char] = [group[0]]
            for char in group[1:]:
                if char.l - current[-1].r > 2.5 * max(current[-1].height, char.height):
                    lines.append(Line(current, current[0].b))
                    current = [char]
                else:
                    current.append(char)
            lines.append(Line(current, current[0].b))
        # raised small lines merge into the body line they sit on
        body = [line for line in lines]
        merged: list[Line] = []
        absorbed: set[int] = set()
        by_height = sorted(range(len(body)), key=lambda i: -statistics.median(c.height for c in body[i].chars))
        for index in range(len(body)):
            if index in absorbed:
                continue
            line = body[index]
            line_height = statistics.median(c.height for c in line.chars)
            for other_index in range(len(body)):
                if other_index == index or other_index in absorbed:
                    continue
                other = body[other_index]
                other_height = statistics.median(c.height for c in other.chars)
                if other_height >= 0.82 * line_height or other_height < 0.35 * line_height:
                    continue
                raised = other.b - line.b
                if not (0.12 * line_height <= raised <= 0.85 * line_height):
                    continue
                if other.l > line.r + 2.5 * line_height or other.r < line.l - 1.5 * line_height:
                    continue
                for char in other.chars:
                    char.superscript = True
                    line.chars.append(char)
                absorbed.add(other_index)
        for index, line in enumerate(body):
            if index in absorbed:
                continue
            line.finalize()
            merged.append(line)
        merged.sort(key=lambda line: (-line.b, line.l))
        return merged

    # ------------------------------------------------------------ signals
    @property
    def markers(self) -> list[Marker]:
        if self._markers is None:
            self._markers = self._find_markers()
        return self._markers

    def _find_markers(self) -> list[Marker]:
        markers: list[Marker] = []
        for line in self.lines:
            run: list[int] = []

            def flush() -> None:
                if not run:
                    return
                chars = [line.chars[i] for i in run]
                text = normalize_marker("".join(c.text for c in chars)).strip(",")
                if text and all(MARKER_CHAR_RE.match(ch) for ch in text) and len(text) <= 6:
                    first, last = run[0], run[-1]
                    left = "".join(c.text for c in line.chars[:first] if not c.superscript)
                    right = "".join(c.text for c in line.chars[last + 1 :] if not c.superscript)
                    l = min(c.l for c in chars)
                    r = max(c.r for c in chars)
                    b = min(c.b for c in chars)
                    t = max(c.t for c in chars)
                    x0, y0, x1, y1 = self._normalized(l, b, r, t)
                    markers.append(
                        Marker(
                            text=text,
                            page=self.page_no,
                            x=round(x0, 5),
                            y=round(y0, 5),
                            width=round(x1 - x0, 5),
                            height=round(y1 - y0, 5),
                            left_context=left.replace(" ", "")[-24:],
                            right_context=right.replace(" ", "")[:12],
                            at_line_start=not left.strip(),
                        )
                    )
                run.clear()

            for index, char in enumerate(line.chars):
                if char.superscript:
                    if run and index != run[-1] + 1:
                        flush()
                    run.append(index)
                else:
                    flush()
            flush()
        return markers

    def markers_in(self, box: dict) -> list[Marker]:
        found = []
        for marker in self.markers:
            cx, cy = marker.x + marker.width / 2, marker.y + marker.height / 2
            if box["x"] - 0.004 <= cx <= box["x"] + box["width"] + 0.004 and box["y"] - 0.004 <= cy <= box["y"] + box["height"] + 0.004:
                found.append(marker)
        return found

    def font_share(self, box: dict) -> dict[str, float]:
        counts = {"mono": 0, "math": 0, "bold": 0, "italic": 0, "total": 0}
        for char in self.chars:
            if not char.text.strip() or not self._inside(char, box):
                continue
            counts["total"] += 1
            for key, flag in classify_font(char.font).items():
                if flag:
                    counts[key] += 1
        total = counts["total"] or 1
        return {key: (value / total if key != "total" else value) for key, value in counts.items()}

    def lines_in(self, box: dict) -> list[Line]:
        found = []
        for line in self.lines:
            inside = sum(1 for c in line.chars if self._inside(c, box))
            if inside and inside >= 0.6 * len(line.chars):
                found.append(line)
        return found

    def region_text(self, box: dict) -> str:
        """Source text of a region with its own line breaks (code listings)."""
        return "\n".join(line.text for line in self.lines_in(box))

    def style_runs(self, box: dict, text: str) -> list[dict]:
        """Bold/italic inline runs for `text`, a block whose glyphs lie in
        `box`: words are read in source order with their dominant face and
        aligned to the block text left to right; a word that does not align
        is skipped rather than guessed."""
        words: list[tuple[str, bool, bool]] = []
        for line in self.lines_in(box):
            current: list[Char] = []

            def flush_word() -> None:
                if not current:
                    return
                body = [c for c in current if not c.superscript] or current
                styles = [classify_font(c.font) for c in body]
                bold = sum(1 for s in styles if s["bold"]) >= 0.6 * len(styles)
                italic = sum(1 for s in styles if s["italic"]) >= 0.6 * len(styles)
                words.append(("".join(c.text for c in current), bold, italic))

            previous: Char | None = None
            for char in line.chars:
                if previous is not None and char.l - previous.r > 0.18 * min(previous.height, char.height):
                    flush_word()
                    current = []
                current.append(char)
                previous = char
            flush_word()
        if not words:
            return []
        runs: list[dict] = []
        cursor = 0
        lowered = text
        for word, bold, italic in words:
            needle = word.strip()
            if len(needle) < 2:
                continue
            start = lowered.find(needle, cursor)
            if start < 0 or start - cursor > 80:
                continue
            end = start + len(needle)
            cursor = end
            if not (bold or italic):
                continue
            last = runs[-1] if runs else None
            if last and last["bold"] == bold and last["italic"] == italic and not text[last["end"] : start].strip():
                last["end"] = end
            else:
                runs.append({"start": start, "end": end, "bold": bold, "italic": italic})
        # a face that covers (almost) the whole block is block styling, not an inline run
        total = sum(run["end"] - run["start"] for run in runs)
        if total >= 0.9 * len(text.strip()):
            return []
        return [
            {"start": r["start"], "end": r["end"], **({"bold": True} if r["bold"] else {}), **({"italic": True} if r["italic"] else {})}
            for r in runs
            if r["end"] > r["start"]
        ]


class SourceText:
    """All pages of a PDF as glyph lines, loaded lazily per page."""

    def __init__(self, pdf_path: Path) -> None:
        self.pdf_path = pdf_path
        self._document = None
        self._pages: dict[int, PageText | None] = {}
        self.available = False
        try:
            from docling_parse.pdf_parser import DoclingPdfParser

            self._document = DoclingPdfParser().load(path_or_stream=str(pdf_path))
            self.available = True
        except Exception:
            self._document = None

    def page(self, page_no: int) -> PageText | None:
        if page_no in self._pages:
            return self._pages[page_no]
        page_text: PageText | None = None
        if self._document is not None:
            try:
                page = self._document.get_page(page_no)
                chars = []
                for cell in page.char_cells:
                    if not cell.text or not cell.text.strip():
                        continue
                    box = cell.rect.to_bounding_box()
                    l, r = min(box.l, box.r), max(box.l, box.r)
                    b, t = min(box.b, box.t), max(box.b, box.t)
                    if r <= l or t <= b:
                        continue
                    chars.append(Char(cell.text, l, b, r, t, cell.font_name or ""))
                page_text = PageText(page_no, float(page.dimension.width), float(page.dimension.height), chars)
            except Exception:
                page_text = None
        self._pages[page_no] = page_text
        return page_text

    def close(self) -> None:
        if self._document is not None:
            try:
                self._document.unload()
            except Exception:
                pass
