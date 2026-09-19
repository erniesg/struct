"""Restore the letters a small-capitals run threw away.

`\\textsc{Fuzzing}` sets the lowercase letters as reduced capitals. The PDF
text layer encodes those glyphs as ordinary capitals, so the heading arrives
as `FUZZING`, indistinguishable from one the author really set in full
capitals.

The glyphs still carry it. On one baseline, in one font, the letters that were
typed lowercase are drawn at about four fifths the height of the ones that
were not:

    'F' 8.55  'U' 6.84  'Z' 6.84  'Z' 6.84  'I' 6.84  'N' 6.84  'G' 6.84

so `F` was typed as a capital and `uzzing` was not.

Two things this must never do, both found by running it over a corpus rather
than by reasoning about it:

- **Measure lowercase letters.** An `x` is shorter than an `h` in every font,
  so counting them makes ordinary prose look like two tiers. Only capitals are
  measured.
- **Measure a glyph off the baseline.** A subscripted capital (`P_X`) is
  reduced and would be lowercased, rewriting the paper's notation. A small
  capital sits on the line's baseline; a subscript does not.

A block never opens on a small capital either: the first letter is the one the
author capitalised, and lowercasing it invents a sentence that starts midway.

Case is restored in place, so the text keeps its length and the inline runs
that index into it — links, note references, emphasis — stay valid.
"""

from __future__ import annotations

# a small capital is drawn well below cap height
REDUCED_LOW = 0.55
REDUCED_HIGH = 0.92
# below this the two tiers are not separable from ordinary rounding
TIER_GAP = 0.04
# a small capital shares the line's baseline; a subscript sits below it
BASELINE_TOLERANCE = 0.08


def _capitals_in_reading_order(page_text, box: dict):
    """Every uppercase glyph under `box` that sits on its line's baseline, in
    source order, with its height as a fraction of the tallest capital there."""
    found = []
    for line in page_text.lines_in(box):
        capitals = [c for c in line.chars if c.text.isalpha() and c.text.isupper() and not c.superscript]
        if len(capitals) < 2:
            continue
        baseline = min(c.b for c in capitals)
        cap = max(c.t - c.b for c in capitals)
        if cap <= 0:
            continue
        found.extend((c, (c.t - c.b) / cap) for c in capitals if abs(c.b - baseline) <= BASELINE_TOLERANCE * cap)
    return found


def restore_case(page_text, box: dict, text: str) -> str | None:
    """`text` with the small capitals put back, reading one box."""
    if page_text is None:
        return None
    return restore_from_capitals(_capitals_in_reading_order(page_text, box), text)


def restore_from_capitals(glyphs, text: str) -> str | None:
    """`text` with the small capitals put back into lowercase, or None when
    the glyphs do not say that any were.

    Returns None rather than a guess whenever the capitals and the text do not
    line up — including when the glyphs run out first. Restoring the part that
    matched would leave a word half re-cased (`FuzzING`), which is worse than
    the all-capitals text it started from.
    """
    if not text or not any(c.isupper() for c in text) or not glyphs:
        return None
    tall = [ratio for _, ratio in glyphs if ratio > REDUCED_HIGH]
    reduced = [ratio for _, ratio in glyphs if REDUCED_LOW <= ratio <= REDUCED_HIGH]
    # both tiers have to be present and separated: capitals at a single height
    # are a heading set in full capitals, which this must not touch
    if not tall or not reduced or min(tall) - max(reduced) < TIER_GAP:
        return None

    restored = list(text)
    first_letter = next((i for i, c in enumerate(restored) if c.isalpha()), None)
    index = 0
    for char, ratio in glyphs:
        while index < len(restored) and not restored[index].isupper():
            index += 1
        if index >= len(restored) or restored[index] != char.text:
            return None  # the text is not this run of capitals; do not touch it
        if ratio <= REDUCED_HIGH and index != first_letter:
            restored[index] = restored[index].lower()
        index += 1
    # every capital in the text must be accounted for by a glyph
    if any(c.isupper() for c in restored[index:]):
        return None
    rebuilt = "".join(restored)
    return rebuilt if rebuilt != text else None


def restore_small_capitals(blocks, page_text_for) -> int:
    """Put the case back into every block whose glyphs show small capitals.
    Returns the number of blocks changed."""
    changed = 0
    for block in blocks:
        text = block.get("text") or ""
        boxes = (block.get("evidence") or {}).get("boxes") or []
        if len(text) < 2 or not boxes or block.get("kind") in ("equation", "code", "furniture"):
            continue
        # every box of the block: an item read across a column or page break
        # has one per part, and reading only the first leaves the rest unmatched
        glyphs = []
        for box in boxes:
            page_text = page_text_for(box["page"])
            if page_text is not None:
                glyphs.extend(_capitals_in_reading_order(page_text, box))
        restored = restore_from_capitals(glyphs, text)
        if restored is not None:
            block["text"] = restored
            block["evidence"].setdefault("signals", []).append("small-capitals-restored")
            changed += 1
    return changed
