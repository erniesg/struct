"""Conservative reconstruction of source-aligned extensible-delimiter arrays."""
from __future__ import annotations

import statistics

from equation_geometry import EquationRefused, composite


_CLOSING = {'(': ')', '[': ']', '{': '}'}


def _pairs(atoms):
    """Return balanced pairs from preassembled extensible delimiters only."""
    delimiters = [a for a in atoms if a.extension and a.text in '()[]{}']
    stack, pairs = [], []
    for delimiter in sorted(delimiters, key=lambda a: (a.l, a.r)):
        if delimiter.text in _CLOSING:
            stack.append(delimiter)
        elif stack and _CLOSING[stack[-1].text] == delimiter.text:
            pairs.append((stack.pop(), delimiter))
        else:
            # A crossing or incomplete delimiter assembly is not evidence for
            # an array, so leave it to the caller's visual fallback.
            stack.clear()
    return pairs


def _rows(members):
    scale = statistics.median([a.em or a.height for a in members])
    tolerance = max(4.0, .85 * scale)
    rows = []
    for member in sorted(members, key=lambda a: a.cy, reverse=True):
        if not rows or abs(member.cy - statistics.median(a.cy for a in rows[-1])) > tolerance:
            rows.append([member])
        else:
            rows[-1].append(member)
    return rows


def _cells(row):
    scale = statistics.median([a.em or a.height for a in row])
    gap = max(4.0, .95 * scale)
    cells = []
    for member in sorted(row, key=lambda a: a.l):
        if not cells or member.l - max(a.r for a in cells[-1]) > gap:
            cells.append([member])
        else:
            cells[-1].append(member)
    return cells


def matrix_atoms(atoms, sequence):
    """Collapse unambiguous multi-row extension-delimited arrays into MathML.

    ``delimiter_atoms`` must run first: ordinary one-line parentheses are never
    candidates.  Each recognized row must have the same source-separated cell
    count; anything else remains untouched for the normal recovery fallback.
    """
    result = list(atoms)
    for opening, closing in sorted(_pairs(result), key=lambda p: p[1].l - p[0].l):
        if opening not in result or closing not in result:
            continue
        members = [a for a in result if a is not opening and a is not closing
                   and opening.r - .75 <= a.cx <= closing.l + .75]
        if not members:
            continue
        rows = _rows(members)
        if len(rows) < 2:
            continue
        cells = [_cells(row) for row in rows]
        if not cells[0] or any(len(row) != len(cells[0]) for row in cells):
            continue
        try:
            rendered = [[sequence(cell) for cell in row] for row in cells]
        except EquationRefused:
            continue
        table = '<mtable>' + ''.join(
            '<mtr>' + ''.join('<mtd>' + xml + '</mtd>' for xml, _ in row) + '</mtr>'
            for row in rendered) + '</mtable>'
        text = '\\begin{matrix}' + '\\\\'.join('&'.join(value for _, value in row) for row in rendered) + '\\end{matrix}'
        xml = '<mrow>' + (opening.xml or '<mo>' + opening.text + '</mo>') + table + (closing.xml or '<mo>' + closing.text + '</mo>') + '</mrow>'
        node = composite([opening, *members, closing], opening.text + text + closing.text, xml,
                         anchor=statistics.median(a.cy for row in rows for a in row),
                         em=max(a.em or 0 for a in members) or None,
                         extension=True)
        result = [a for a in result if a not in [opening, *members, closing]] + [node]
    return result


def cases_atoms(atoms, sequence, operator_atoms, token):
    """Recover a source-bounded, one-sided brace containing relation rows.

    The complete assembled brace supplies the vertical boundary; the caller's
    formula region supplies the right boundary. Every row must contain an
    explicit relation. This cannot invent a missing case or a closing brace.
    """
    from equation_geometry import display_rows
    result=list(atoms)
    for brace in list(result):
        if brace not in result or not brace.extension or brace.text!='{':continue
        if any(c.extension and c.text=='}' and c.l>brace.r and abs(c.cy-brace.cy)<brace.height*.4 for c in result):continue
        members=[c for c in result if c is not brace and c.l>=brace.r-.75 and brace.b<=c.cy<=brace.t]
        if not members:continue
        try:
            rows=display_rows(members)
            if len(rows)<2 or any(not any(c.text in {'=','≤','≥','<','>'} for c in row) for row in rows):continue
            rendered=[sequence(operator_atoms(row,sequence,token)) for row in rows]
        except EquationRefused:continue
        table='<mtable columnalign="left">'+''.join('<mtr><mtd>'+xml+'</mtd></mtr>'for xml,_ in rendered)+'</mtable>'
        text='\\begin{cases}'+'\\\\'.join(text for _,text in rendered)+'\\end{cases}'
        node=composite([brace]+members,text,'<mrow>'+brace.xml+table+'</mrow>',anchor=brace.cy,
                       em=max(c.em or 0 for c in members)or None,extension=True)
        result=[c for c in result if c not in members and c is not brace]+[node]
    return result
