"""Shared regexes and pure text helpers for the PDF adapter.

What belongs here: module-level patterns and functions that more than one rule
module uses and that hold no adapter state (sentence termination, caption
labels, footnote markers, link visible-text matching). Anything that reads or
writes `self` belongs in a `rules_*.py` mixin instead. `pdf2struct` re-exports
every name defined here.
"""

from __future__ import annotations

import re

from pdf_text import normalize_marker


TERMINAL_RE = re.compile(r"[.!?:;\"”’)\]…]$")
# a trailing citation (`[85]`, `(Smith et al., 2020)`) is not sentence punctuation
CITATION_TAIL_RE = re.compile(r"(?:\s*(?:\[[\d,\s–\-;]+\]|\([A-Z][^()]{0,80}?\d{4}[a-z]?\)|\(\d{4}[a-z]?\)))+$")
ABBREVIATION_END_RE = re.compile(r"(?:\bet al|\be\.g|\bi\.e|\bcf|\bvs|\bFig|\bEq|\bNo|\bSec|\bTab|\bref)\.$", re.IGNORECASE)
FLOAT_KINDS = {"figure", "table", "caption", "equation", "footnote", "furniture"}
# appendix floats carry a letter before the number (`Figure A2`, `Table B.1`)
CAPTION_LIKE_RE = re.compile(r"^(?:(?:Extended\s+Data\s+)?(?:Figure|Fig\.?)|Table|Listing|Algorithm|Program|Example|Box)\s*(?:[A-Z]\.?)?\d+[A-Za-z]?\b", re.IGNORECASE)
FIGURE_OWNER_RE = re.compile(r"^(?:Extended\s+Data\s+)?(?:Figure|Fig\.?)\s*(?:[A-Z]\.?)?\d+", re.IGNORECASE)
SUBCAPTION_RE = re.compile(r"^\(?[a-z]\)\s*\S", re.IGNORECASE)
TRAILING_MARKER_RE = re.compile(r"(?:(?<!\d)\.|[!?:;\"”’)\]])\s?(?:\d{1,3}|[*†‡§¶]{1,3})$")
LOWER_START_RE = re.compile(r"^[a-zß-ÿ]")
# the layout model spaces out mathematics: `κ = 0 . 946` is a decimal, not a full
# stop and a note marker, and `Q Y ( j )` closes a bracket in a formula, not a
# sentence — a paragraph ending that way is still open; `( Fig.2 )`, a spaced
# bracket around a word, is prose and still ends the sentence
SPACED_MATH_TAIL_RE = re.compile(r"(?:\d\s\.\s\d{1,3}|\(\s(?![^()]*[A-Za-z]{3,})[^()]*\S\s\))$")
NUMBERED_HEADING_RE = re.compile(r"^(\d+)(?:\.\d+)*\.?\s+\S")
APPENDIX_HEADING_RE = re.compile(r"^(?:Appendix\s+)?([A-Z])(?:\.\d+)*\.?\s+\S")
TOP_LEVEL_HEADING_RE = re.compile(
    r"^(abstract|introduction|background|related work|methods?|materials and methods|results|discussion|"
    r"conclusions?|limitations|ethics statement|ethical considerations|acknowledg\w*|references|bibliography|"
    r"appendix|appendices|supplementary\b.*|declarations|funding|author contributions|data availability\b.*|"
    r"code availability\b.*|competing interests|conflicts? of interest|keywords|impact statement|broader impacts?)\b",
    re.IGNORECASE,
)
DATE_AFTER_RE = re.compile(
    r"\s+(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b|\d{4}\b|of\s+\d|\(\d{4}\))"
)
# `a A complex neural network …`: a table's lettered (or symbol, or numbered) note
TABLE_NOTE_LEAD_RE = re.compile(r"^\s*(?:[a-z]|\d{1,2}|[*∗⋆★✱†‡§¶‖]{1,3})\s+[A-Z]")
FOOTNOTE_MARKER_RE = re.compile(r"^\s*(?:(\d{1,3})(?=\s|[A-Za-z(\[“\"'])|([*∗⋆★✱†‡§¶‖]{1,3}))\s*")
LIST_LIKE_NOTE_RE = re.compile(r"^\s*(?:\d{1,3}[.)]|[-•–—▪◦])\s+\S")
PAGE_NUMBER_TEXT_RE = re.compile(
    r"^\s*(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|/)\s*\d{1,4})?\s*$", re.IGNORECASE
)
REFERENCE_WORD_RE = re.compile(
    r"(figure|fig\.?|table|section|sec\.?|appendix|equation|eq\.?|chapter|page|step|algorithm|theorem|lemma|"
    r"of|and|or|to|the|by|in|at|than|from|with|level|version|layer|model|gpt|llama|top|type|class|round)$",
    re.IGNORECASE,
)
XML_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
WORD_RE_ADAPTER = re.compile(r"[A-Za-z\u00c0-\u024f]{2,}")
SAFE_HREF_RE = re.compile(r"^(https?|mailto|ftp):", re.IGNORECASE)
VISIBLE_RE = re.compile(r"[^\s\u0300-\u036f\u00ad]")
TICK_LABEL_RE = re.compile(r"^\s*[-+]?\d{1,4}(?:[.,]\d+)?%?\s*$")
# an axis's row of tick values (`9 10 11 12 … 64`)
TICK_ROW_RE = re.compile(r"^\s*(?:[-+]?\d{1,4}(?:[.,]\d+)?%?\s+){2,}[-+]?\d{1,4}(?:[.,]\d+)?%?\s*$")
PARATEXT_NOTE_RE = re.compile(
    r"^(?:Permission to make digital|©|\(c\)\s*\d{4}|Copyright|ISSN|ISBN|ACM ISBN|https?://doi\.org|DOI:|arXiv:|Preprint,|"
    r"Proceedings of|\d{4}-\d{4}/\d{4}|This work is licensed|Licensed under|Received:|Accepted:|Published:|Manuscript submitted|"
    r"Authors?['’] address|Publication rights|Journal of |Vol\. \d)",
    re.IGNORECASE,
)
PARATEXT_NOTE_ANY_RE = re.compile(r"copyright held by|all rights reserved|creative commons|rights licensed to", re.IGNORECASE)
JOURNAL_LINE_RE = re.compile(r"\b(?:vol\.?|volume|issue|journal|proceedings|conference|workshop|preprint|arxiv|issn|isbn|doi|©|pp\.|published|under review|accepted)\b", re.IGNORECASE)
PROSE_LIKE_RE = re.compile(r"[a-z]{3,}[.!?]\s+[A-Z]|[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}")
# `Figure 15 shows …` / `Table 22 shows …` are sentences, not captions: the
# word after the label must be capitalised
# the label may be chapter-numbered (`Fig. 2.3`); the separator dot is never a digit's
FIGURE_CAPTION_RE = re.compile(r"^((?:Extended\s+Data\s+)?(?:Figure|Fig\.?))\s*((?-i:[A-Z])\.?\d+(?:\.\d+)*|\d+(?:\.\d+)*)(?!\d)\s*(?:\.(?!\d)|[:|\-–—]|(?=\s+(?-i:[A-Z])))", re.IGNORECASE)
TABLE_CAPTION_RE = re.compile(r"^(Table)\s*((?-i:[A-Z])\.?\d+(?:\.\d+)*|\d+(?:\.\d+)*)(?!\d)\s*(?:\.(?!\d)|[:|\-–—]|(?=\s+(?-i:[A-Z])))", re.IGNORECASE)
EMBEDDED_CAPTION_RE = re.compile(r"(?<![A-Za-z])((?:Extended\s+Data\s+)?(?:Figure|Fig\.))\s*((?-i:[A-Z])\.?\d+(?:\.\d+)*|\d+(?:\.\d+)*)(?!\d)\s*(?:\.(?!\d)|[:|\-–—]|(?=\s+(?-i:[A-Z])))", re.IGNORECASE)


def sanitize(value: str) -> str:
    return XML_ILLEGAL_RE.sub("", value or "").replace("­", "")


def is_terminated(text: str) -> bool:
    """Whether a paragraph ends a sentence: terminal punctuation after any
    trailing citation brackets, or a trailing note marker. A parenthesis
    opened in the last words and never closed keeps the sentence open, and
    so does a spaced-out formula tail (`0 . 946`, `Q Y ( j )`)."""
    stripped = text.rstrip()
    if SPACED_MATH_TAIL_RE.search(stripped):
        return False
    if TRAILING_MARKER_RE.search(stripped):
        return True
    tail = stripped[-60:]
    if tail.count("(") > tail.count(")") and re.search(r"\([^()]*$", tail):
        return False
    core = CITATION_TAIL_RE.sub("", stripped).rstrip()
    if core != stripped and core and (not TERMINAL_RE.search(core) or ABBREVIATION_END_RE.search(core)):
        return False
    return bool(TERMINAL_RE.search(stripped))


def heading_level(text: str, docling_level: int | None, last_numbered_level: int | None) -> int:
    stripped = text.strip()
    if NUMBERED_HEADING_RE.match(stripped):
        return min(len(re.findall(r"\d+", stripped.split()[0])), 4)
    appendix = re.match(r"^(?:Appendix\s+)?([A-Z](?:\.\d+)*)\.?\s+\S", stripped)
    if appendix and len(stripped.split()) > 1:
        return min(1 + appendix.group(1).count("."), 4)
    if TOP_LEVEL_HEADING_RE.match(stripped):
        return 1
    if last_numbered_level:
        return min(last_numbered_level + 1, 3)
    if docling_level and docling_level > 1:
        return min(docling_level, 4)
    return 1


CAPTION_NOISE_RE = re.compile(r"^\s*(?:(?:\d{1,3}|[ivx]{1,5})\s+)+(?=(?:(?:Extended\s+Data\s+)?(?:Figure|Fig\.?)|Table)\s*\d)", re.IGNORECASE)


def clean_caption(text: str) -> str:
    """Drop stray page-number or axis tokens glued in front of `Figure N`, and
    figure-internal labels (`Continuous warping Modality segmentation Fig. 10.`)
    the layout model merged into the caption item: the caption starts at the
    first `Figure N` when nothing before it reads as a sentence."""
    cleaned = CAPTION_NOISE_RE.sub("", text, count=1).strip()
    if not FIGURE_CAPTION_RE.match(cleaned):
        embedded = EMBEDDED_CAPTION_RE.search(cleaned)
        if embedded and 0 < embedded.start() <= 80 and not re.search(r"[.!?:;]", cleaned[: embedded.start()]):
            cleaned = cleaned[embedded.start() :].strip()
    return cleaned


def canonical_figure_label(value: str | re.Match) -> str | None:
    """Canonical identity retaining the source's main/extended-data namespace."""
    match = FIGURE_CAPTION_RE.match(clean_caption(value)) if isinstance(value, str) else value
    if match is None:
        return None
    namespace = "Extended Data Figure" if re.match(r"Extended\s+Data", match.group(1), re.IGNORECASE) else "Figure"
    return f"{namespace} {match.group(2)}"


def footnote_parts(text: str) -> tuple[str | None, str]:
    match = FOOTNOTE_MARKER_RE.match(text)
    if not match:
        return None, text.strip()
    return normalize_marker(match.group(1) or match.group(2)), text[match.end() :].strip()


def loose_pattern(needle: str) -> re.Pattern:
    """`needle` with any whitespace, soft hyphen or zero-width space allowed
    between its characters (line-wrapped URLs, `http://\u200bwww.\u200b…`)."""
    return re.compile(r"[\s\u00ad\u200b]*".join(re.escape(ch) for ch in needle if not ch.isspace() and ch not in "\u00ad\u200b"))


QUOTE_VARIANTS = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})


def link_visible_text(item_text: str, uri: str, visible: str, group_text: str = "") -> str | None:
    """The words of `item_text` an annotation covers: the target itself in
    any of its spellings, else the visible words (of the whole wrapped link
    first), tolerant of a line-end hyphen and of curly quotes."""
    candidates: list[str] = []
    # Symbol fonts expose glyph names to Docling while pdftotext emits a
    # control character. Use the existing semantic token, never a guessed name.
    if not any(ch.isalnum() for ch in visible):
        icon = "envelope" if uri.lower().startswith("mailto:") else "orcid" if re.match(r"https?://orcid\.org/", uri, re.I) else None
        if icon:
            match = re.search(rf"\b{icon}\b", item_text, re.I)
            if match:
                return match.group()
    # Quote style and dash encoding can differ between the two PDF readers.
    punctuation = str.maketrans({"“": "'", "”": "'", "‘": "'", "’": "'", '"': "'", "–": "-", "−": "-"})
    for text in (group_text, visible):
        text = (text or "").strip().rstrip(".,;")
        if not text:
            continue
        candidates.append(text)
        dewrapped = re.sub(r"-\s+", "", text)  # `init/con- trol` wrapped at a hyphen
        candidates.append(dewrapped)
        for variant in (text, dewrapped):
            if variant.endswith("-"):
                candidates.append(variant[:-1])
            candidates.append(variant.translate(QUOTE_VARIANTS))
            # the extractor may map the quote glyphs to other characters: match the words alone
            bare = variant.strip("\"'“”‘’«»").rstrip(".,;:")
            if bare and bare != variant:
                candidates.append(bare)
                if bare.endswith("-"):
                    candidates.append(bare[:-1])
    # the target's own spellings come last: `www.x.org/` (the canonical form of a
    # bare host) would otherwise land on a later `www.x.org/en` in the same text
    target_candidates = [uri, uri.rstrip("/"), re.sub(r"^https?://", "", uri), re.sub(r"^https?://", "", uri).rstrip("/"), re.sub(r"^https?://(www\.)?", "", uri).rstrip("/")]
    # Preserve the annotation's visible phrase before trying the target's
    # spelling, including when only punctuation normalization can match it.
    for group in (candidates, target_candidates):
        for normalized in (False, True):
            haystack = item_text.translate(punctuation) if normalized else item_text
            for candidate in group:
                if not candidate or len(candidate) < 3 or (len(candidate) < 4 and not candidate[0].isupper()):
                    continue
                needle = candidate.translate(punctuation) if normalized else candidate
                match = loose_pattern(needle).search(haystack)
                if match and match.end() > match.start():
                    return item_text[match.start() : match.end()]
    return None


def first_free_span(visible: str, text: str, taken: list[tuple[int, int]]) -> tuple[int, int] | None:
    """The first occurrence of `visible` in `text` that overlaps none of the
    spans already claimed (two `here` links in one paragraph)."""
    if not visible:
        return None
    for match in loose_pattern(visible).finditer(text):
        start, end = match.span()
        if end <= start:
            continue
        if any(not (end <= s or start >= e) for s, e in taken):
            continue
        return start, end
    return None


def marker_candidates(marker: str, text: str) -> list[tuple[int, int, bool]]:
    """(start, end, strong) occurrences of a footnote marker in plain text."""
    results = []
    text = normalize_marker(text)  # `∗` in the body is the `*` of the note; offsets are preserved
    if marker.isdigit():
        pattern = re.compile(rf"(\s?)({re.escape(marker)})(?![\d.,]\d)(?=[\s.,;:)\]]|$)")
    else:
        pattern = re.compile(rf"(\s?)({re.escape(marker)})(?=[\s.,;:)\]]|$)")
    for match in pattern.finditer(text):
        start = match.start(2)
        before = text[: match.start(1) if match.group(1) else start]
        if not before:
            continue
        prev_char = before[-1]
        if marker.isdigit() and not match.group(1) and prev_char in "0123456789.,:":
            continue  # part of a number such as 1.2 or 3,2
        if marker.isdigit() and DATE_AFTER_RE.match(text, match.end(2)):
            continue  # "2 December 2021", "3 of 10", "2 (2021)"
        if match.group(1):
            prev_word = re.search(r"(\S+)$", before)
            word = prev_word.group(1) if prev_word else ""
            reference_word = bool(REFERENCE_WORD_RE.search(word)) or bool(re.fullmatch(r"\d+[.,]?", word))
            if prev_char in ".,;:)]}\"”’'" and not reference_word:
                results.append((start, match.end(2), True))
            elif prev_word and not reference_word and prev_char.isalpha():
                results.append((start, match.end(2), False))
            elif prev_word and not marker.isdigit() and not prev_char.isspace():
                results.append((start, match.end(2), False))
        elif prev_char.isalpha() or prev_char in ")]}\"”’'" or (not marker.isdigit() and not prev_char.isspace()):
            results.append((start, match.end(2), True))
    return results


def _line_words_present(line: str, compact_block: str) -> bool:
    """Whether a text-layer line's words are already in a block: the block
    holds at least two thirds of the line's words of three or more letters
    (three words at least). A line of mathematics reads `E µ [Σ t ]` in the
    text layer and `E µ [Σ K t ]` from the layout model, so a character
    comparison sees a missing line where the words say otherwise."""
    words = [w.lower() for w in re.findall(r"[A-Za-z]{3,}", line)]
    if len(words) < 3:
        return False
    present = sum(1 for w in words if w in compact_block)
    return present * 3 >= len(words) * 2
