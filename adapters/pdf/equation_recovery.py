"""Conservative source-glyph MathML recovery with explicit geometry ownership.

PDF character identities, source rules, font faces and positions reconstruct
scripts, fractions, radicals, limits, accents, matrices and relation systems.
Every source glyph must retain an owner. Incomplete or ambiguous layout
fragments remain explicitly unsupported rather than receiving guessed trees.
"""
from __future__ import annotations

from dataclasses import dataclass
from html import escape
import re
import statistics
import unicodedata


@dataclass
class EquationRecovery:
    text: str
    mathml: str | None
    box: dict
    limitation: str | None = None
    glyph_count: int = 0


def _size(char):
    if hasattr(char, "em"):
        return char.em
    name = char.font.split('+')[-1]
    match = re.search(r'(?:Roman|Italic|Symbols|CMMI[B]?|CMBX|CMSY|CMR)(\d+)', name, re.I)
    return float(match.group(1)) if match else None


def _extension(char):
    if hasattr(char, "extension"):
        return char.extension
    return bool(re.search(r'Extension|CMEX', char.font, re.I))


def _styled_letter(value, variant):
    """Encode source math alphabets for engines that ignore mathvariant.

    The ordinary source transcript remains unchanged. Unicode compatibility
    normalization maps these presentation characters back to the same letters.
    """
    if len(value) != 1 or not value.isalpha():
        return value
    name = unicodedata.name(value, '')
    if 'LATIN ' in name:
        letter = name.rsplit(' ', 1)[-1]
    elif 'GREEK ' in name and ' LETTER ' in name:
        letter = name.split(' LETTER ', 1)[-1]
    else:
        return value
    case = 'CAPITAL' if value.isupper() else 'SMALL'
    alphabet = variant.upper()
    for prefix in ('MATHEMATICAL ', ''):
        try:
            return unicodedata.lookup(f'{prefix}{alphabet} {case} {letter}')
        except KeyError:
            pass
    return value


def _token(char):
    if getattr(char, "xml", None):
        return char.xml
    value = "−" if char.text == "-" else char.text
    if value.isdecimal():
        tag = 'mn'
    elif all(unicodedata.category(c).startswith('L') for c in value):
        tag = 'mi'
    else:
        tag = 'mo'
    bold = bool(re.search(r'Bold|CMMIB|CMBX', char.font, re.I))
    alphabet = 'bold' if bold else None
    if re.search(r'CMMIB', char.font, re.I):
        alphabet = 'bold-italic'
    elif re.search(r'MSBM', char.font, re.I):
        alphabet = 'double-struck'
    elif re.search(r'LMMathSymbols|CMSY', char.font, re.I) and value.isupper() and value.isalpha():
        alphabet = 'script'
    attributes = f' mathvariant="{alphabet}"' if alphabet else ''
    if not alphabet and tag == 'mi' and re.search(r'LMRoman|CMR\d', char.font) and not re.search(r'Italic|Slant', char.font, re.I):
        attributes = ' mathvariant="normal"'
    if alphabet:
        value = _styled_letter(value, alphabet.replace('-', ' ') if alphabet != 'double-struck' else alphabet)
    if tag == 'mo' and value in '()[]{}':
        attributes += ' stretchy="true"' if _extension(char) else ' stretchy="false"'
    return f'<{tag}{attributes}>{escape(value)}</{tag}>'



def _row(parts):
    return '<mrow>' + ''.join(parts) + '</mrow>'


def _sequence(chars, depth=0):
    """Return expression/text only when every glyph has a supported owner."""
    if depth > 3 or not chars:
        raise ValueError('unsupported nested script geometry')
    sizes = [_size(c) for c in chars if not _extension(c)]
    if any(s is None for s in sizes):
        raise ValueError('font size unavailable for script reconstruction')
    # TeX can retain full-sized parentheses around a script-style fraction
    # numerator. Delimiter font names do not determine its text style.
    body_sizes = [_size(c) for c in chars if not _extension(c) and c.text not in '()[]{}']
    main_size = max(body_sizes or sizes)
    # strictly larger than 0.8: an 8 pt glyph beside 10 pt glyphs is a script
    base = [c for c in chars if _extension(c) or _size(c) > .8 * main_size]
    if not base:
        raise ValueError('no stable expression baseline')
    body = [c for c in base if not _extension(c)]
    baseline = statistics.median(c.cy for c in body)
    # Text-style fractions may use smaller glyphs while the fraction itself
    # occupies the surrounding expression's main baseline.
    base += [c for c in chars if c not in base and getattr(c, 'xml', None)
             and c.xml.startswith('<mfrac>') and abs(c.cy-baseline)<.3*main_size]
    # Distinct full-sized lines indicate fractions, limits or a matrix.
    if max(c.cy for c in body) - min(c.cy for c in body) > .48 * main_size:
        raise ValueError('multiple expression baselines require structural recovery')
    # a base glyph well above or below the main baseline is a script the sizes
    # did not reveal: no MathML is better than a flattened superscript
    for char in body:
        if not getattr(char, 'xml', None) and char.text not in '()[]{}|' and abs(char.cy - baseline) > .3 * main_size:
            raise ValueError('raised or lowered glyph not recognised as a script')
    base.sort(key=lambda c: c.l)
    scripts = [c for c in chars if c not in base]
    attached = {id(c): {'sub': [], 'sup': []} for c in base}
    script_owner = {}
    for char in sorted(scripts, key=lambda c: (-_size(c), c.l)):
        # A nested script follows the outer script's owner even when its
        # vertical position happens to cross the surrounding main baseline.
        parents = [c for c in scripts if id(c) in script_owner and _size(c) > _size(char)
                   and c.l < char.l and abs(c.r-char.l) < .3*main_size
                   and abs(c.cy-char.cy) < .65*_size(c)]
        if parents:
            parent = max(parents, key=lambda c: c.r)
            owner, direction = script_owner[id(parent)]
        else:
            owners = [c for c in base if c.l < char.l and c.r <= char.l + .20 * main_size]
            if not owners:
                raise ValueError('script has no unambiguous preceding base')
            owner = max(owners, key=lambda c: c.r)
            delta = char.cy - baseline
            if abs(delta) < .08 * main_size:
                raise ValueError('small glyph does not form a clear script')
            direction = 'sup' if delta > 0 else 'sub'
        attached[id(owner)][direction].append(char)
        script_owner[id(char)] = (owner, direction)
    parts, texts = [], []
    previous_right = None
    for char in base:
        if previous_right is not None and char.l - previous_right > 1.2 * main_size:
            parts.append('<mspace width="1em"/>')
            texts.append(' ')
        node, text = _token(char), char.text
        groups = attached[id(char)]
        sub = _sequence(groups['sub'], depth + 1) if groups['sub'] else None
        sup = _sequence(groups['sup'], depth + 1) if groups['sup'] else None
        if sub and sup:
            node = f'<msubsup>{node}{sub[0]}{sup[0]}</msubsup>'
        elif sub:
            node = f'<msub>{node}{sub[0]}</msub>'
        elif sup:
            node = f'<msup>{node}{sup[0]}</msup>'
        if sub:
            text += '_{' + sub[1] + '}'
        if sup:
            text += '^{' + sup[1] + '}'
        parts.append(node)
        texts.append(text)
        previous_right = max([char.r] + [c.r for c in groups["sub"] + groups["sup"]])
    return _row(parts), ''.join(texts)


def _merge_numbers(mathml: str) -> str:
    """One `<mn>` per number: `4.160` is set glyph by glyph (`<mn>4</mn><mo>.</mo>
    <mn>1</mn>…`), which renders with operator spacing inside an equation number.
    Only consecutive children of one row merge, so script and fraction arities hold."""
    from xml.etree import ElementTree as ET
    namespace = "http://www.w3.org/1998/Math/MathML"
    ET.register_namespace("", namespace)
    try:
        root = ET.fromstring(mathml)
    except ET.ParseError:
        return mathml
    tag = lambda element, name: element.tag == f"{{{namespace}}}{name}"
    for row in root.iter(f"{{{namespace}}}mrow"):
        children = list(row)
        merged = []
        for child in children:
            previous = merged[-1] if merged else None
            before = merged[-2] if len(merged) > 1 else None
            if tag(child, "mn") and not child.attrib and previous is not None and tag(previous, "mn") and not previous.attrib:
                previous.text = (previous.text or "") + (child.text or "")
                continue
            if (tag(child, "mn") and not child.attrib and previous is not None and tag(previous, "mo") and (previous.text or "") == "."
                    and not previous.attrib and before is not None and tag(before, "mn") and not before.attrib):
                before.text = (before.text or "") + "." + (child.text or "")
                merged.pop()
                continue
            merged.append(child)
        if len(merged) != len(children):
            for child in children:
                row.remove(child)
            row.extend(merged)
    return ET.tostring(root, encoding="unicode")


def recover_equation(page_text, box):
    """Recover a complete simple expression, or an honest source-only result."""
    if page_text is None or box is None:
        return None
    left = box['x'] * page_text.width
    right = (box['x'] + box['width']) * page_text.width
    bottom = (1 - box['y'] - box['height']) * page_text.height
    top = (1 - box['y']) * page_text.height
    chars = [c for c in page_text.chars if left - .75 <= c.cx <= right + .75
             and bottom - .75 <= c.cy <= top + .75 and c.text.strip()]
    if not chars:
        return None
    source_text = ''.join(c.text for c in chars)
    # Keep the full source glyph boxes, including glyph ink beyond the model
    # box. Crop padding is in PDF points, independent of raster resolution.
    crop = dict(box)
    x0, x1 = max(0, min(left, *(c.l for c in chars)) - 2), min(page_text.width, max(right, *(c.r for c in chars)) + 2)
    y0, y1 = max(0, min(bottom, *(c.b for c in chars)) - 2), min(page_text.height, max(top, *(c.t for c in chars)) + 2)
    crop.update(x=x0 / page_text.width, y=1 - y1 / page_text.height,
                width=(x1 - x0) / page_text.width, height=(y1 - y0) / page_text.height)
    reason = None
    try:
        from equation_geometry import atom, accent_atoms, delimiter_atoms, fraction_atoms, radical_atoms, operator_atoms, display_rows, arrow_atoms, font_scales
        atoms = accent_atoms([atom(c, font_scales(page_text)) for c in chars], _token)
        atoms = arrow_atoms(atoms)
        atoms = delimiter_atoms(atoms)
        bars = []
        for shape in getattr(page_text, 'shapes', []):
            points = list(getattr(shape, 'points', []) or [])
            for a, b in zip(points, points[1:]):
                if (abs(a.y-b.y) < .25 and abs(a.x-b.x) > 2
                    and bottom < a.y < top and left < (a.x+b.x)/2 < right):
                    bars.append((min(a.x,b.x), max(a.x,b.x), a.y))
        atoms, bars = radical_atoms(atoms, bars, _sequence)
        atoms = fraction_atoms(atoms, bars, _sequence)
        from equation_matrix import matrix_atoms, cases_atoms
        atoms = matrix_atoms(atoms, _sequence)
        atoms = cases_atoms(atoms, _sequence, operator_atoms, _token)
        rows = [operator_atoms(row, _sequence, _token) for row in display_rows(atoms)]
        atoms = [a for row in rows for a in row]
        if any(unicodedata.category(c).startswith('C') for a in atoms for c in a.text):
            raise ValueError('unmapped source glyphs')
        if any(unicodedata.combining(c) or c in '√∑∫∏' for a in atoms if not a.xml for c in a.text):
            raise ValueError('large operators or unsupported accents require structural recovery')
        ordered = sorted(atoms, key=lambda c: c.l)
        if ordered[0].text in '=≈≤≥':
            raise ValueError('layout fragment begins with a relation and omits its left operand')
        stack = []
        pairs = {')': '(', ']': '[', '}': '{'}
        for c in ordered:
            if c.text in '([{': stack.append(c.text)
            elif c.text in pairs:
                if not stack or (stack[-1] != pairs[c.text] and {stack[-1], pairs[c.text]} != {'(', '['}):
                    raise ValueError('unbalanced source delimiters in layout fragment')
                stack.pop()
        if stack:
            raise ValueError('unbalanced source delimiters in layout fragment')
        rendered = [_sequence(row) for row in rows]
        if len(rendered) == 1:
            node, text = rendered[0]
        else:
            node = '<mtable columnalign="left">' + ''.join('<mtr><mtd>'+xml+'</mtd></mtr>' for xml, _ in rendered) + '</mtable>'
            text = '\n'.join(value for _, value in rendered)
        if sum(c.count for c in atoms) != len(chars):
            raise ValueError('source glyph ownership changed during reconstruction')
        return EquationRecovery(text, _merge_numbers('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' + node + '</math>'), crop, glyph_count=len(chars))
    except ValueError as exc:
        reason = str(exc)
    return EquationRecovery(source_text, None, crop, reason, len(chars))
