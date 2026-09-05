"""Source-derived evaluation of a built EPUB against the reader criteria.

Expectations come from the PDF itself (caption labels in the text layer,
URI annotations, lines repeated across pages), never from the converter's
own output. The result is emitted in the same document shape the corpus
audit produces, so `tools/pdf-success-scorecard.mjs` can score this path
and the deterministic reconstruction side by side.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import zipfile
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from pdf_links import WORD_RE, attach_words, extract_links, page_layout_lines, page_text_lines, word_boxes

CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.|Table)\s*(\d+)\s*(?:[.:|\-–—]|(?=\s+[A-Z]))", re.IGNORECASE)
OUTPUT_CAPTION_RE = re.compile(r"^\W*(?:\d{1,3}\s+)?(Figure|Fig\.?|Table)\s*(\d+)\b", re.IGNORECASE)
LOWER_START = re.compile(r"^[a-z]")
PAGE_NUMBER_RE = re.compile(r"^\s*\d{1,4}\s*$")


def _canonical_uri(uri: str) -> str:
    """The comparable form of a link target: whitespace removed, scheme and
    host lowercased, an empty path made `/` (what a WHATWG URL parser emits),
    so an annotation's raw string and the rendered href compare equal."""
    value = re.sub(r"\s+", "", uri or "")
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    if not parts.scheme or not parts.netloc:
        return value
    path = parts.path or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, parts.fragment))


def _normalize(text: str) -> str:
    return (
        text.lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("ﬁ", "fi")
        .replace("ﬂ", "fl")
        .replace("­", "")
        .replace("–", "-")
        .replace("—", "-")
    )


def _tokens(text: str) -> list[str]:
    """Comparable word tokens: normalized quotes, trailing hyphens stripped, ≥3 chars."""
    words = []
    for word in WORD_RE.findall(_normalize(text)):
        for piece in word.split("-"):
            piece = piece.strip("'")
            if len(piece) >= 3:
                words.append(piece)
    return words


REFERENCES_HEADING_RE = re.compile(r"<h[1-6][^>]*>\s*(references|bibliography|works cited)\b", re.IGNORECASE)


def _lowercase_starts(body_html: str) -> int:
    """Prose paragraphs that begin lowercase, ignoring bibliography entries
    (authors such as `nostalgebraist`) and the `where …` sentence that
    conventionally follows a display equation."""
    cut = REFERENCES_HEADING_RE.search(body_html)
    scope = body_html[: cut.start()] if cut else body_html
    count = 0
    previous_text = ""
    for match in re.finditer(r"(<figure[^>]*>(?:(?!</figure>).)*?(?:class=\"equation\"|alt=\"Equation)(?:(?!</figure>).)*?</figure>\s*)?<p(?:\s[^>]*)?>(.*?)</p>", scope, re.S):
        text = _strip(match.group(2)).strip()
        before, previous_text = previous_text, text
        if len(text) <= 40 or not LOWER_START.match(text):
            continue
        if match.group(1) or text.startswith("where ") or re.match(r"^(?:https?:|www\.)", text):
            continue
        if before.rstrip().endswith(":"):
            continue  # an item under a colon-terminated lead-in, not a broken join
        if re.match(r"^[a-z](?:\s?[a-z0-9]){0,2}\s+(?:[a-z]|\d|[=<>≤≥∈∼∈])", text):
            continue  # inline math symbol such as "s t represents" or "a = b"
        count += 1
    return count


def _epub_texts(epub: Path) -> dict[str, str]:
    with zipfile.ZipFile(epub) as zf:
        return {name: zf.read(name).decode("utf-8") for name in zf.namelist() if name.endswith(".xhtml")}


def _strip(html: str) -> str:
    # a tag boundary separates words (table cells, list items, sup markers)
    return re.sub(r"\s{2,}", " ", re.sub(r"<[^>]+>", " ", html))


def _caption_labels(lines: list[str]) -> dict[str, set[str]]:
    labels = {"figure": set(), "table": set()}
    for line in lines:
        match = CAPTION_RE.match(line)
        if not match:
            continue
        kind = "table" if match.group(1).lower().startswith("t") else "figure"
        labels[kind].add(match.group(2))
    return labels


def _line_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.strip().lower()))


def _running_lines(pages: list[list[str]], layout: list[dict] | None = None) -> set[str]:
    """Running heads and feet: short lines that recur in the top or bottom
    tenth of the page on at least three pages (spec 042: geometry and
    repetition, never wording). Without layout geometry the first and last
    six text lines of each page stand in for the edge bands."""
    counter: Counter[str] = Counter()
    if layout:
        for page in layout:
            height = page.get("height") or 0
            seen = set()
            for line in page["lines"]:
                if not height:
                    continue
                center = (line["ymin"] + line["ymax"]) / 2 / height
                if not (center <= 0.10 or center >= 0.90):
                    continue
                key = _line_key(line["text"])
                if 6 <= len(key) <= 90 and key not in seen:
                    seen.add(key)
                    counter[key] += 1
        return {key for key, count in counter.items() if count >= 3}
    for page in pages:
        edge = [line for line in page[:6] + page[-6:] if line.strip()]
        seen = set()
        for line in edge:
            key = _line_key(line)
            if 6 <= len(key) <= 90 and key not in seen:
                seen.add(key)
                counter[key] += 1
    return {key for key, count in counter.items() if count >= 3}


def _figure_boxes(struct_draft: Path | None) -> dict[int, list[tuple[float, float, float, float]]]:
    """Normalized (x0, y0, x1, y1) boxes of figure blocks per page, from the draft."""
    boxes: dict[int, list] = {}
    if not struct_draft or not struct_draft.exists():
        return boxes
    try:
        draft = json.loads(struct_draft.read_text())
    except json.JSONDecodeError:
        return boxes
    for block in draft.get("blocks", []):
        if block.get("kind") not in ("figure", "equation") or not (block.get("fallbackAssetIds") or block.get("kind") == "equation"):
            continue
        for box in block.get("evidence", {}).get("boxes", []):
            boxes.setdefault(box["page"], []).append((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
    return boxes


def _words_outside_figures(pdf: Path, figure_boxes: dict[int, list], sizes: dict[int, tuple[float, float]]) -> Counter | None:
    """Source word tokens whose boxes lie outside every detected figure region.
    Text inside a figure belongs to the figure asset, not to the prose."""
    if not figure_boxes:
        return None
    pages = word_boxes(pdf)
    if not pages:
        return None
    counter: Counter = Counter()
    for page_index, words in enumerate(pages, start=1):
        width, height = sizes.get(page_index, (0.0, 0.0))
        regions = figure_boxes.get(page_index, [])
        for x0, y0, x1, y1, text in words:
            if width and height and regions:
                cx, cy = (x0 + x1) / 2 / width, (y0 + y1) / 2 / height
                if any(rx0 - 0.005 <= cx <= rx1 + 0.005 and ry0 - 0.005 <= cy <= ry1 + 0.005 for rx0, ry0, rx1, ry1 in regions):
                    continue
            for token in _tokens(text):
                counter[token] += 1
    return counter


def evaluate(pdf: Path, epub: Path, build_report: dict, struct_draft: Path | None = None) -> dict:
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    pages = page_text_lines(pdf)
    all_lines = [line for page in pages for line in page]
    labels = _caption_labels(all_lines)
    running = _running_lines(pages, page_layout_lines(pdf))
    links, sizes = extract_links(pdf)
    attach_words(links, word_boxes(pdf), sizes)
    icon_links = 0
    expected_uris = set()
    for link in links:
        if link.kind != "uri" or not link.uri:
            continue
        visible = link.text.strip()
        if not visible:
            icon_links += 1
            continue
        key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", visible.lower()))
        if key in running or re.fullmatch(r"[\d\s.,]+", visible):
            continue
        width, height = sizes.get(link.page, (0.0, 0.0))
        if height and width:
            l, b, r, t = link.rect
            if t / height >= 0.92 or b / height <= 0.08:
                continue  # header/footer band belongs to the furniture criterion
            if r / width <= 0.07 or l / width >= 0.93:
                continue  # margin stamp (arXiv banner) belongs to the furniture criterion
        expected_uris.add(_canonical_uri(link.uri))
    internal_links = sum(1 for link in links if link.kind == "internal")

    texts = _epub_texts(epub)
    body_html = "\n".join(html for name, html in sorted(texts.items()) if not name.endswith("nav.xhtml"))
    # struct renders footnotes as <aside role="doc-footnote">; their text counts
    # for coverage but stays out of the prose-continuity sample
    body_text = _strip(body_html)
    # hyperlinks inside footnotes count: read hrefs before the asides go
    out_hrefs = {_canonical_uri(href.replace("&amp;", "&")) for href in re.findall(r'<a[^>]*\shref="([^"]+)"', body_html)}
    body_html = re.sub(r"<aside[^>]*>.*?</aside>", "", body_html, flags=re.S)

    out_labels = {"figure": set(), "table": set()}
    # a figure label counts only when its <figure> carries an image; a table
    # label counts from a <caption> or the caption paragraph that follows a
    # rendered <table> (struct renders table captions as separate blocks)
    for match in re.finditer(r"<figure[^>]*>(.*?)</figure>(\s*<p[^>]*class=\"caption\"[^>]*>(.*?)</p>)?", body_html, re.S):
        inner, trailing = match.group(1), match.group(3)
        caption = re.search(r"<figcaption>(.*?)</figcaption>", inner, re.S)
        if "<img" in inner and caption:
            label = OUTPUT_CAPTION_RE.match(_strip(caption.group(1)))
            if label and not label.group(1).lower().startswith("t"):
                out_labels["figure"].add(label.group(2))
        if "<table" in inner:
            for text in re.findall(r"<caption>(.*?)</caption>", inner, re.S) + re.findall(r"<figcaption>(.*?)</figcaption>", inner, re.S) + ([trailing] if trailing else []):
                label = OUTPUT_CAPTION_RE.match(_strip(text))
                if label and label.group(1).lower().startswith("t"):
                    out_labels["table"].add(label.group(2))
    mapped_uris = {uri for uri in expected_uris if uri in out_hrefs}

    paragraphs = [_strip(p).strip() for p in re.findall(r"<p(?:\s[^>]*)?>(.*?)</p>", body_html, re.S)]
    prose = [p for p in paragraphs if len(p) > 40]
    lowercase_starts = _lowercase_starts(body_html)
    edge_numbers = set()
    for page in pages:
        for line in page[:6] + page[-6:]:
            if PAGE_NUMBER_RE.match(line):
                edge_numbers.add(line.strip())
    furniture_hits = 0
    for p in paragraphs:
        key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", p.strip().lower()))
        if key in running or (PAGE_NUMBER_RE.match(p) and p.strip() in edge_numbers):
            furniture_hits += 1

    # text coverage: share of source word tokens (outside running lines) present in the EPUB
    source_words = Counter()
    for page in pages:
        edge = set(id(line) for line in page[:6] + page[-6:])
        for line in page:
            key = re.sub(r"\s+", " ", re.sub(r"\d+", "#", line.strip().lower()))
            if key in running or (id(line) in edge and PAGE_NUMBER_RE.match(line)):
                continue
            for word in _tokens(line):
                source_words[word] += 1
    epub_words = Counter(_tokens(body_text))
    # pdftotext splits small-caps and drop-cap initials ("D ilemmas"); rejoin a
    # single letter with the following word only when the joined word exists
    # in the rendition, so the source side is compared on equal terms
    rejoined: Counter = Counter()
    for page in pages:
        for line in page:
            for match in re.finditer(r"(?<![\w])([A-Za-z])[\s\u00ad\u200b\u2009\u202f]+([a-z]{2,})\b", line):
                fused = (match.group(1) + match.group(2)).lower()
                if fused in epub_words:
                    rejoined[fused] += 1
                    tail = match.group(2).lower()
                    if source_words.get(tail):
                        source_words[tail] -= 1
    source_words.update(rejoined)
    outside = _words_outside_figures(pdf, _figure_boxes(struct_draft), sizes)
    if outside is not None:
        # keep the running-line/page-number exclusions, but cap each token by its out-of-figure count
        source_words = Counter({word: min(count, outside.get(word, 0)) for word, count in source_words.items()})
    covered = sum(min(count, epub_words.get(word, 0)) for word, count in source_words.items())
    total = sum(source_words.values())
    text_coverage = covered / total if total else 1.0

    figures_expected = len(labels["figure"])
    figures_found = len(labels["figure"] & out_labels["figure"])
    tables_expected = len(labels["table"])
    tables_found = len(labels["table"] & out_labels["table"])
    tables_semantic = build_report.get("tables_semantic", 0)
    tables_fallback = build_report.get("tables_fallback_image", 0)
    footnotes = build_report.get("footnotes", 0)
    footnotes_linked = build_report.get("footnotes_linked", 0)
    footnotes_markered = build_report.get("footnotes_with_marker", footnotes)
    formulas = build_report.get("formulas_mathml", 0) + build_report.get("formulas_image", 0) + build_report.get("formulas_text", 0)

    diagnostics: Counter[str] = Counter()
    if figures_expected and figures_found < figures_expected:
        diagnostics["INCOMPLETE_ASSET_COVERAGE"] = figures_expected - figures_found
    if build_report.get("figures_without_image", 0):
        diagnostics["UNRESOLVED_VISUAL_OBJECT"] = build_report["figures_without_image"]
    if build_report.get("figures", 0) > build_report.get("figures_with_caption", 0):
        diagnostics["UNREFERENCED_VISUAL_ASSET"] = build_report["figures"] - build_report["figures_with_caption"]
    if tables_expected and tables_found < tables_expected:
        diagnostics["INCOMPLETE_SEMANTIC_TABLE_COVERAGE"] = tables_expected - tables_found
    if tables_fallback:
        diagnostics["BOUNDED_TABLE_FALLBACK"] = tables_fallback
    if footnotes_markered:
        diagnostics["CLASSIFIED_NOTE_MARKER"] = footnotes_markered  # applicability evidence for the notes criterion
    if footnotes_linked < footnotes_markered:
        diagnostics["UNRESOLVED_NOTE_REFERENCE"] = footnotes_markered - footnotes_linked
    if expected_uris and len(mapped_uris) < len(expected_uris):
        diagnostics["UNRESOLVED_HYPERLINK"] = len(expected_uris) - len(mapped_uris)
    if furniture_hits:
        diagnostics["FURNITURE_CONTAMINATION"] = furniture_hits
    if running:
        diagnostics["REPEATED_MARGIN_TEXT"] = len(running)
    if text_coverage < 0.98:
        diagnostics["INCOMPLETE_TEXT_COVERAGE"] = 1
    if prose and lowercase_starts / len(prose) > 0.02:
        diagnostics["UNRESOLVED_CORRUPTING_JOIN"] = lowercase_starts
    if build_report.get("formulas_text", 0):
        diagnostics["UNRESOLVED_EQUATION_TRANSCRIPT"] = build_report["formulas_text"]
    if build_report.get("epubcheck_errors", 0):
        diagnostics["EPUB_INVALID"] = build_report["epubcheck_errors"]
    ocr_pages = build_report.get("ocr_pages", 0)
    scanned = total < 50 * max(len(pages), 1)
    if scanned and not build_report.get("epub_text_characters", len(body_text)):
        diagnostics["OCR_REQUIRED"] = 1

    blocking = sorted(code for code in diagnostics if code not in {"REPEATED_MARGIN_TEXT", "BOUNDED_TABLE_FALLBACK", "CLASSIFIED_NOTE_MARKER"})
    ready = not blocking and build_report.get("epubcheck_errors", 0) == 0

    completeness = {
        "sourceTextCharacters": sum(len(line) for line in all_lines),
        "outputTextCharacters": len(body_text),
        "textCoverage": round(text_coverage, 5),
        "missingSourceRegionCount": 0,
        "unresolvedCorruptingJoinCount": lowercase_starts,
        "readingOrderDiagnostics": 0,
        "expectedInlineSpanCount": 0,
        "inlineSpanCoverage": 1,
        "expectedHyperlinkCount": len(expected_uris),
        "mappedHyperlinkCount": len(mapped_uris),
        "hyperlinkCoverage": round(len(mapped_uris) / len(expected_uris), 5) if expected_uris else 1,
        "expectedRelationshipCount": len(expected_uris) + footnotes_markered,
        "resolvedRelationshipCount": len(mapped_uris) + footnotes_linked,
        "relationshipCoverage": round((len(mapped_uris) + footnotes_linked) / (len(expected_uris) + footnotes_markered), 5) if (len(expected_uris) + footnotes_markered) else 1,
        "sourceAssetCount": figures_expected,
        "exportedAssetCount": figures_found,
        "assetCoverage": round(figures_found / figures_expected, 5) if figures_expected else 1,
        "expectedSemanticTableCount": tables_expected,
        "resolvedSemanticTableCount": tables_found if tables_expected else tables_semantic,
        "semanticTableCoverage": round(tables_found / tables_expected, 5) if tables_expected else 1,
        "unresolvedObjects": {
            "assets": max(figures_expected - figures_found, 0),
            "captions": build_report.get("orphan_figure_captions", 0),
            "tables": max(tables_expected - tables_found, 0),
            "equations": build_report.get("formulas_text", 0),
            "citations": 0,
            "footnoteReferences": max(footnotes_markered - footnotes_linked, 0),
            "footnotes": 0,
        },
        "ocrRequiredPages": [1] if diagnostics.get("OCR_REQUIRED") else [],
        "furnitureExcludedRunCount": len(running) + build_report.get("furniture_blocks", 0),
        "furnitureContaminationCount": furniture_hits,
        "equationCount": formulas,
        "internalLinkAnnotations": internal_links,
    }
    document = {
        "basename": pdf.name,
        "sha256": sha,
        "byteLength": pdf.stat().st_size,
        "pageCount": len(pages),
        "pipeline": "docling-epub-v1",
        "completeness": completeness,
        "readiness": {
            "status": "ready" if ready else "review-required",
            "ready": ready,
            "policy": "docling-epub-reader-criteria-v1",
            "blockingDiagnosticCodes": blocking,
        },
        "diagnosticCounts": dict(diagnostics),
        "build": build_report,
        "expectations": {
            "figureLabels": sorted(labels["figure"], key=int),
            "figureLabelsFound": sorted(labels["figure"] & out_labels["figure"], key=int),
            "tableLabels": sorted(labels["table"], key=int),
            "tableLabelsFound": sorted(labels["table"] & out_labels["table"], key=int),
            "runningLineCount": len(running),
            "externalLinkCount": len(expected_uris),
        "iconLinkCount": icon_links,
        },
    }
    return document


def epubcheck(epub: Path) -> dict:
    try:
        result = subprocess.run(["epubcheck", str(epub)], capture_output=True, text=True)
    except FileNotFoundError:
        return {"available": False, "errors": None, "warnings": None}
    errors = len(re.findall(r"^ERROR", result.stdout + result.stderr, re.M))
    fatal = len(re.findall(r"^FATAL", result.stdout + result.stderr, re.M))
    warnings = len(re.findall(r"^WARNING", result.stdout + result.stderr, re.M))
    messages = [line for line in (result.stdout + result.stderr).splitlines() if line.startswith(("ERROR", "FATAL", "WARNING"))][:20]
    return {"available": True, "errors": errors + fatal, "warnings": warnings, "messages": messages}


if __name__ == "__main__":  # pragma: no cover
    import sys

    pdf, epub, report = Path(sys.argv[1]), Path(sys.argv[2]), json.loads(Path(sys.argv[3]).read_text())
    print(json.dumps(evaluate(pdf, epub, report), indent=1))
