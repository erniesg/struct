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
import hashlib
import statistics
import unicodedata
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
    # URW/Nimbus writes bold `Medi` (`NimbusRomNo9L-Medi`, `-MediItal`) and CM-super `SFBX`;
    # `Medium` is a weight of its own and is not bold
    r"bold|black|heavy|semibold|demibold|extrabold|ultrabold|CMBX|CMSSBX|CMBSY|SFBX|Demi|Medi(?!um)|"
    r"(?<![A-Za-z])CMB(?![A-Za-z])|-B(?![A-Za-z])|(?<![A-Za-z])Bd(?![A-Za-z])",
    re.IGNORECASE,
)
ITALIC_RE = re.compile(
    # `NimbusMonL-ReguObli`, `NimbusRomNo9L-Regu-Slant_167`, CM-super `SFTI`, bold italic `CMBXTI`
    r"italic|oblique|obli|slanted|slant_|-It(?![A-Za-z])|Ital|CM\w*TI|CMSL|CMSSI|SFTI|LMRomanSlant|(?<![A-Za-z])It(?![A-Za-z])",
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
class Rule:
    """A drawn line segment long enough to be a table rule or a box edge,
    in normalized top-left page coordinates."""

    x0: float
    y0: float
    x1: float
    y1: float
    width: float  # stroke width in points

    @property
    def horizontal(self) -> bool:
        return abs(self.y1 - self.y0) < 0.002

    @property
    def length(self) -> float:
        return max(self.x1 - self.x0, self.y1 - self.y0)


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
    def __init__(self, page_no: int, width: float, height: float, chars: list[Char], shapes: list | None = None) -> None:
        self.page_no = page_no
        self.width = width
        self.height = height
        self.chars = chars
        self.shapes = shapes or []
        self._lines: list[Line] | None = None
        self._gutters: list[tuple[float, float]] | None = None
        self._markers: list[Marker] | None = None
        self._rules: list[Rule] | None = None

    # ------------------------------------------------------------ rules
    @property
    def rules(self) -> list[Rule]:
        """Horizontal segments at least a tenth of the page wide and vertical
        segments at least a fiftieth of the page tall, from the page's vector
        paths (table rules, box frames). Segments are the consecutive point
        pairs of each path; a closed rectangle yields its four sides."""
        if self._rules is None:
            self._rules = self._find_rules()
        return self._rules

    def _find_rules(self) -> list[Rule]:
        rules: list[Rule] = []
        if not self.width or not self.height:
            return rules
        for shape in self.shapes:
            points = list(getattr(shape, "points", []) or [])
            stroke = float(getattr(shape, "line_width", 0.0) or 0.0)
            if len(points) >= 6:
                # a rounded or curved frame is flattened into many short
                # segments: its bounding box gives the frame's four edges
                xs = [float(pt.x) for pt in points]
                ys = [float(pt.y) for pt in points]
                bw, bh = max(xs) - min(xs), max(ys) - min(ys)
                closed = abs(xs[0] - xs[-1]) <= 2.0 and abs(ys[0] - ys[-1]) <= 2.0
                if closed and bw >= 0.10 * self.width and bh >= 0.02 * self.height:
                    x0, x1 = min(xs) / self.width, max(xs) / self.width
                    y0, y1 = 1 - max(ys) / self.height, 1 - min(ys) / self.height
                    rules.append(Rule(round(x0, 4), round(y0, 4), round(x1, 4), round(y0, 4), stroke))
                    rules.append(Rule(round(x0, 4), round(y1, 4), round(x1, 4), round(y1, 4), stroke))
                    rules.append(Rule(round(x0, 4), round(y0, 4), round(x0, 4), round(y1, 4), stroke))
                    rules.append(Rule(round(x1, 4), round(y0, 4), round(x1, 4), round(y1, 4), stroke))
                    continue
            for a, b in zip(points, points[1:]):
                ax, ay, bx, by = float(a.x), float(a.y), float(b.x), float(b.y)
                if abs(ay - by) <= 0.75 and abs(ax - bx) >= 0.10 * self.width:
                    x0, x1 = sorted((ax / self.width, bx / self.width))
                    y = 1 - (ay + by) / 2 / self.height
                    rules.append(Rule(round(x0, 4), round(y, 4), round(x1, 4), round(y, 4), stroke))
                elif abs(ax - bx) <= 0.75 and abs(ay - by) >= 0.02 * self.height:
                    y0, y1 = sorted((1 - ay / self.height, 1 - by / self.height))
                    x = (ax + bx) / 2 / self.width
                    rules.append(Rule(round(x, 4), round(y0, 4), round(x, 4), round(y1, 4), stroke))
        # rules drawn as thin filled rectangles come out as two parallel edges
        # a fraction of a point apart: keep one
        deduped: list[Rule] = []
        for rule in sorted(rules, key=lambda r: (not r.horizontal, r.y0, r.x0)):
            twin = next(
                (
                    d
                    for d in deduped
                    if d.horizontal == rule.horizontal
                    and (abs(d.y0 - rule.y0) <= 0.002 and abs(d.x0 - rule.x0) <= 0.01 and abs(d.x1 - rule.x1) <= 0.01 if rule.horizontal else abs(d.x0 - rule.x0) <= 0.003 and abs(d.y0 - rule.y0) <= 0.01 and abs(d.y1 - rule.y1) <= 0.01)
                ),
                None,
            )
            if twin is None:
                deduped.append(rule)
        return deduped

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

    @property
    def gutters(self) -> list[tuple[float, float]]:
        """The page's empty vertical corridors: the gap between two columns is
        narrower than the 2.5 line heights that separate two lines, so without
        them a line of the left column and one of the right at the same height
        read as a single line."""
        if self._gutters is None:
            self._gutters = self._find_gutters()
        return self._gutters

    def _find_gutters(self) -> list[tuple[float, float]]:
        chars = [c for c in self.chars if c.text.strip() and c.height > 0]
        if len(chars) < 50 or not self.width:
            return []
        bins = 200
        step = self.width / bins
        covered = [False] * bins
        for char in chars:
            first, last = int(max(0.0, char.l) / step), int(min(self.width - 1e-6, char.r) / step)
            for index in range(max(0, first), min(bins - 1, last) + 1):
                covered[index] = True
        gutters, start = [], None
        for index in range(bins):
            if not covered[index]:
                start = index if start is None else start
                continue
            if start is not None:
                gutters.append((start, index))
                start = None
        if start is not None:
            gutters.append((start, bins))
        found = []
        for first, last in gutters:
            left, right = first * step, last * step
            centre = (left + right) / 2 / self.width
            if right - left >= 0.012 * self.width and 0.15 <= centre <= 0.85:
                found.append((left, right))
        return found

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
                gutter = any(left >= current[-1].r - 1 and right <= char.l + 1 for left, right in self.gutters)
                if gutter or char.l - current[-1].r > 2.5 * max(current[-1].height, char.height):
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

        def line_ending_left_of(chars) -> str:
            """The text of the line this run trails, when the run is a line of
            its own.

            A note marker set hard against the end of its line (`CLASS
            v3.1.0`<sup>7</sup>) is raised far enough that it bands on its own.
            It then reads as a marker opening a line — an affiliation or a list
            number — and the note it belongs to is never linked. The line whose
            last glyph ends within a space of it, at its own height, is the
            line it trails, and that line's tail is its left context.
            """
            left, bottom = min(c.l for c in chars), min(c.b for c in chars)
            best = None
            for other in self.lines:
                if other is line or not other.chars:
                    continue
                end = max(c.r for c in other.chars)
                # the marker must touch the line's last glyph: a wider reach
                # would take the context of whatever ends near it, a row of a
                # table or the line beside it in the other column
                if not (0 <= left - end <= 0.006 * self.width):
                    continue
                # and sit on that line's own baseline, raised within its height
                base, cap = min(c.b for c in other.chars), max(c.t for c in other.chars)
                if not (base <= bottom < cap):
                    continue
                if best is None or end > best[0]:
                    best = (end, other.text)
            return best[1] if best else ""

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
                    if not left.strip():
                        left = line_ending_left_of(chars)
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
        return self._emphasis_runs(box, text) + self.script_runs(box, text)

    def _script_lines(self, box: dict) -> list[Line]:
        """Attach isolated lowered glyph runs in private copies of source lines.

        Ordinary line grouping intentionally does not absorb lowered runs.
        For math styling only, accept a short run when one and only one math
        base directly precedes it and every glyph overlaps that base vertically.
        The bounded baseline displacement excludes neighboring text lines.
        """
        lines = [Line([c for c in line.chars if self._inside(c, box)], line.b)
                 for line in self.lines_in(box)]
        absorbed: set[int] = set()
        attachments: list[tuple[int, int]] = []
        for index, line in enumerate(lines):
            if not line.chars or len(line.chars) > 8:
                continue
            candidates: set[tuple[int, int]] = set()
            for other_index, other in enumerate(lines):
                if other_index == index:
                    continue
                for base in other.chars:
                    if not classify_font(base.font)["math"] or not base.text.isalnum():
                        continue
                    previous = base
                    for char in line.chars:
                        if not (0.40 * base.height <= char.height <= 0.82 * base.height
                                and 0.065 * base.height <= base.b - char.b <= 0.45 * base.height
                                and base.b + 0.15 * base.height < char.t < base.t - 0.18 * base.height
                                and -0.2 * base.height <= char.l - previous.r <= 0.35 * base.height):
                            break
                        previous = char
                    else:
                        candidates.add((other_index, id(base)))
            if len(candidates) == 1:
                attachments.append((index, candidates.pop()[0]))
        # Reject chains: an attached script must not act as another run's base.
        children = {child for child, _ in attachments}
        for child, parent in attachments:
            if parent not in children:
                lines[parent].chars.extend(lines[child].chars)
                absorbed.add(child)
        result = []
        for index, line in enumerate(lines):
            if index not in absorbed:
                line.finalize()
                result.append(line)
        return result

    def script_runs(self, box: dict, text: str) -> list[dict]:
        """Retain small raised/lowered glyphs attached to a source math base.

        Match complete source lines before transferring offsets. Size alone is
        insufficient: a math font on the base, immediate horizontal adjacency,
        and a distinct vertical displacement are all required. Normal prose
        footnotes and same-baseline small capitals therefore remain untouched.
        """
        runs = self._aligned_script_runs(box, text, self.lines_in(box))
        for run in self._aligned_script_runs(box, text, self._script_lines(box)):
            if not any(run["start"] < prior["end"] and prior["start"] < run["end"] for prior in runs):
                runs.append(run)
        return sorted(runs, key=lambda run: (run["start"], run["end"]))

    def _aligned_script_runs(self, box: dict, text: str, lines: list[Line]) -> list[dict]:
        def normalized(value: str) -> str:
            return "".join(c for c in unicodedata.normalize("NFKC", value) if not c.isspace())

        target_parts: list[str] = []
        target_offsets: list[int] = []
        for index, char in enumerate(text):
            part = normalized(char)
            target_parts.append(part)
            target_offsets.extend([index] * len(part))
        target = "".join(target_parts)
        cursor = 0
        runs: list[dict] = []
        for line in lines:
            chars = [c for c in line.chars if self._inside(c, box)]
            needle = "".join(normalized(c.text) for c in chars)
            if not needle:
                continue
            start = target.find(needle, cursor)
            if start < 0:
                continue
            cursor = start + len(needle)
            position = start
            base: Char | None = None
            alignment: str | None = None
            previous: Char | None = None
            for char in chars:
                length = len(normalized(char.text))
                align = None
                if base is not None and previous is not None and length:
                    adjacent = -0.2 * base.height <= char.l - previous.r <= 0.35 * base.height
                    smaller = 0.40 * base.height <= char.height <= 0.82 * base.height
                    if adjacent and smaller:
                        if char.b <= base.b - 0.065 * base.height and char.t < base.t - 0.18 * base.height:
                            align = "subscript"
                        elif char.b >= base.b + 0.18 * base.height and char.cy > base.cy + 0.08 * base.height:
                            align = "superscript"
                    if alignment is not None and align != alignment:
                        align = None
                if align and length:
                    begin = target_offsets[position]
                    end = target_offsets[position + length - 1] + 1
                    last = runs[-1] if runs else None
                    if last and last["end"] == begin and last["verticalAlign"] == align:
                        last["end"] = end
                    else:
                        runs.append({"start": begin, "end": end, "verticalAlign": align})
                    alignment = align
                else:
                    base = char if classify_font(char.font)["math"] and char.text.isalnum() else None
                    alignment = None
                previous = char
                position += length
        return runs

    def _emphasis_runs(self, box: dict, text: str) -> list[dict]:
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
        self._glyph_recovery = _SourceGlyphRecovery(pdf_path)
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
                blank_chars = []
                for cell in page.char_cells:
                    box = cell.rect.to_bounding_box()
                    l, r = min(box.l, box.r), max(box.l, box.r)
                    b, t = min(box.b, box.t), max(box.b, box.t)
                    if r <= l or t <= b:
                        continue
                    char = Char(cell.text or "", l, b, r, t, cell.font_name or "")
                    (chars if char.text.strip() else blank_chars).append(char)
                self._glyph_recovery.supplement(page_no, chars, blank_chars)
                try:
                    shapes = list(page.shapes)
                except Exception:
                    shapes = []
                page_text = PageText(page_no, float(page.dimension.width), float(page.dimension.height), chars, shapes)
            except Exception:
                page_text = None
        self._pages[page_no] = page_text
        return page_text

    def close(self) -> None:
        self._glyph_recovery.close()
        if self._document is not None:
            try:
                self._document.unload()
            except Exception:
                pass


# bbding's published encoding (CTAN fonts/bbding/bbding.dtx) uses octal
# 041/042 for Checkmark/CheckmarkBold and 043/044/045 for XSolid variants.
# Some embedded Type1 subsets retain /enc-N glyph names but have an empty
# ToUnicode CMap. Docling returns spaces; PDFium retains the original byte.
# These mappings apply only when the embedded encoding proves that identity.
_BBDING_SYMBOLS = {33: "✓", 34: "✔", 35: "✗", 36: "✘", 37: "✘"}
# Canonical CTAN fonts/niceframe/type1/bbding10.pfb (001.000):
# SHA256 fd11709c57988d2b790b580e0e8d29dc026490f3b3f245468d615e517b5d4a7b.
# These decrypted CharStrings contain only self-contained outline operations,
# never callsubr/callothersubr/seac. Their meaning therefore cannot be changed
# by a subset's other glyphs or subroutines. Font program context is also pinned.
_BBDING_GLYPH_SHA256 = {
    33: "e6f950a090699aeb5675e6f3a1be8481cc7491da26ba1b7d90e99cf6562c03a3",
    34: "1987c2d3d680d0f33df30b7581fa267083d7e353779bfa1e0bc3c4ba7658bdee",
    35: "d52c724d19d466402c09bb1f605379670ea6c699f099f3f3983937e5e569acb0",
    36: "c4d33daeb98ccbe88b8f744c8a270ded6d27fecbf5cd18735348f4df35c551a3",
    37: "50b100dda8ebe01327d559056ebd7adcd663285aa9ca6ff9ad3a1dd32e5bd778",
}


def _type1_decrypt(data: bytes, seed: int) -> bytes:
    output = bytearray()
    for byte in data:
        output.append(byte ^ (seed >> 8))
        seed = ((byte + seed) * 52845 + 22719) & 65535
    return bytes(output)[4:]


def _type1_text_digest(data: bytes) -> str:
    # Preserve comment line boundaries: collapsing a newline after '%' could
    # conceal an effective-program change. UniqueID does not affect outlines.
    data = re.sub(rb"/UniqueID\s+\d+\s+def", b"", data)
    return hashlib.sha256(b"\n".join(b" ".join(line.split()) for line in data.splitlines() if line.strip())).hexdigest()


def _attested_bbding_encoding(stream) -> dict[int, str]:
    """Parse a restricted Type1 program; attest effective slots and outlines."""
    try:
        data = stream.get_data()
        length1, length2 = int(stream["/Length1"]), int(stream["/Length2"])
        if length1 <= 0 or length2 <= 4 or length1 + length2 > len(data):
            return {}
        trailer = data[length1 + length2:]
        if trailer and re.fullmatch(rb"\s*(?:0\s*){512}cleartomark\s*(?:\{restore\}if\s*)?", trailer) is None:
            return {}
        header = data[:length1]
        encoding = re.search(rb"/Encoding 256 array\s+0 1 255 \{\s*1 index exch /\.notdef put\} for\s+"
                             rb"((?:dup \d+\s*/[A-Za-z.\d-]+ put\s+)*)readonly def", header)
        if encoding is None:
            return {}
        slots: dict[int, bytes] = {}
        for code, glyph in re.findall(rb"dup (\d+)\s*/([A-Za-z.\d-]+) put", encoding[1]):
            index = int(code)
            if index in slots or not 0 <= index <= 255:
                return {}
            slots[index] = glyph
        normalized_header = header[:encoding.start()] + b"/Encoding KNOWN def" + header[encoding.end():]
        normalized_header = re.sub(rb"/FontName /(?:[A-Z]{6}\+)?bbding def", b"/FontName /bbding def", normalized_header)
        if _type1_text_digest(normalized_header) != "69e24307b2740c09c0f8df67eb848d0302743d58485897f605817472f92cbc12":
            return {}
        plain = _type1_decrypt(data[length1:length1 + length2], 55665)
        subrs = re.search(rb"/Subrs (\d+) array\s*", plain)
        if subrs is None or _type1_text_digest(plain[:subrs.start()]) != "ddc31105abb059f5a4944dd39e57bb66148b48b48d586ce4bbcb900f29c8a307":
            return {}
        position = subrs.end()
        seen_subrs: set[int] = set()
        for _ in range(int(subrs[1])):
            match = re.match(rb"dup (\d+) (\d+) RD ", plain[position:])
            if match is None or int(match[1]) in seen_subrs:
                return {}
            seen_subrs.add(int(match[1]))
            position += match.end() + int(match[2])
            end = re.match(rb" NP\s*", plain[position:])
            if end is None:
                return {}
            position += end.end()
        charstrings = re.match(rb"ND\s+2 index /CharStrings (\d+) dict dup begin\s*", plain[position:])
        if charstrings is None:
            return {}
        position += charstrings.end()
        programs: dict[bytes, bytes] = {}
        for _ in range(int(charstrings[1])):
            match = re.match(rb"/([A-Za-z.\d-]+) (\d+) RD ", plain[position:])
            if match is None or match[1] in programs:
                return {}
            position += match.end()
            size = int(match[2])
            programs[match[1]] = _type1_decrypt(plain[position:position + size], 4330)
            position += size
            end = re.match(rb" ND\s*", plain[position:])
            if end is None:
                return {}
            position += end.end()
        if b" ".join(plain[position:].split()) != b"end end readonly put put dup/FontName get exch definefont pop mark currentfile closefile":
            return {}
        return {code: _BBDING_SYMBOLS[code] for code, glyph in slots.items()
                if code in _BBDING_GLYPH_SHA256 and glyph == f"enc-{code}".encode()
                and hashlib.sha256(programs.get(glyph, b"")).hexdigest() == _BBDING_GLYPH_SHA256[code]}
    except (KeyError, AttributeError, TypeError, ValueError):
        return {}


def _font_family(name: str) -> str:
    return name.lstrip("/").split("+")[-1]


def _verified_symbol_encoding(font: dict) -> dict[int, str]:
    """Decode only a known embedded symbol encoding with a missing Unicode map.

    A font name alone is insufficient: custom PDF encodings, named Unicode
    mappings, absent font programs and unknown slots remain untouched.
    """
    if font.get("/Subtype") != "/Type1" or _font_family(str(font.get("/BaseFont", ""))) != "bbding":
        return {}
    if "/Encoding" in font:
        return {}
    try:
        cmap = font["/ToUnicode"].get_data().decode("latin1") if "/ToUnicode" in font else ""
        if any(int(count) for count in re.findall(r"\b(\d+)\s+beginbf(?:char|range)\b", cmap)) or re.search(r"\busecmap\b", cmap):
            return {}
        program = font["/FontDescriptor"]["/FontFile"]
    except (KeyError, AttributeError, TypeError):
        return {}
    return _attested_bbding_encoding(program)


def _merge_recovered_glyph(chars: list[Char], blanks: list[Char], recovered: Char) -> None:
    """Keep original layout geometry when replacing a missing or wrong glyph."""
    for pool in (chars, blanks):
        match = next((c for c in pool if _font_family(c.font) == _font_family(recovered.font)
                      and abs(c.cx - recovered.cx) < 0.75 and abs(c.cy - recovered.cy) < 0.75), None)
        if match is not None:
            match.text = recovered.text
            if pool is blanks:
                blanks.remove(match)
                chars.append(match)
            return
    chars.append(recovered)


class _SourceGlyphRecovery:
    """Optional source-font repair, preserving the public SourceText interface."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.reader = None
        self.pdfium = None
        self.unavailable = False

    def supplement(self, page_no: int, chars: list[Char], blanks: list[Char]) -> None:
        if self.unavailable:
            return
        try:
            if self.reader is None:
                from pypdf import PdfReader

                self.reader = PdfReader(self.path)
            resources = self.reader.pages[page_no - 1]["/Resources"]
            fonts = resources["/Font"] if "/Font" in resources else {}
            mappings: dict[str, dict[int, str]] = {}
            ambiguous: set[str] = set()
            for resource in fonts.values():
                font = resource.get_object()
                family = _font_family(str(font.get("/BaseFont", "")))
                mapping = _verified_symbol_encoding(font)
                if family in mappings and mappings[family] != mapping:
                    ambiguous.add(family)
                mappings[family] = mapping
            mappings = {family: mapping for family, mapping in mappings.items() if mapping and family not in ambiguous}
            if not mappings:
                return
            import ctypes
            import pypdfium2 as pdfium
            import pypdfium2.raw as raw

            if self.pdfium is None:
                self.pdfium = pdfium.PdfDocument(self.path)
            page = self.pdfium[page_no - 1]
            text = page.get_textpage()
            try:
                for index in range(text.count_chars()):
                    code = raw.FPDFText_GetUnicode(text, index)
                    if not any(code in mapping for mapping in mappings.values()):
                        continue
                    size = raw.FPDFText_GetFontInfo(text, index, None, 0, None)
                    if not size:
                        continue
                    buffer = ctypes.create_string_buffer(size)
                    raw.FPDFText_GetFontInfo(text, index, buffer, size, None)
                    family = _font_family(buffer.value.decode("utf-8", errors="replace"))
                    value = mappings.get(family, {}).get(code)
                    if value is None:
                        continue
                    l, b, r, t = text.get_charbox(index, loose=True)
                    if r > l and t > b:
                        _merge_recovered_glyph(chars, blanks, Char(value, l, b, r, t, family))
            finally:
                text.close()
                page.close()
        except ImportError:
            self.unavailable = True
        except Exception:
            # Supplementary decoding must not discard successfully parsed pages.
            return

    def close(self) -> None:
        if self.pdfium is not None:
            self.pdfium.close()
            self.pdfium = None
        if self.reader is not None:
            self.reader.close()
            self.reader = None
