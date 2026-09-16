"""Recover native-text cell grids inside an independently established table box.

A caption and drawn frame establish the object boundary. Persistent whitespace
in its body establishes columns; glyph baselines establish rows. No page image
or document name supplies semantic content.
"""
from __future__ import annotations

import re
import statistics
from pdf_text import Line


def grid_from_source(page, region, source_ids=(), *, require_anchors=False, cell_boxes=()):
    if page is None:
        return None
    x0, y0, x1, y1 = region
    chars = [c for c in page.chars if x0 <= c.cx / page.width <= x1 and y0 <= 1 - c.cy / page.height <= y1]
    if len(chars) < 3:
        return None
    height = statistics.median(c.height for c in chars)
    rules = sorted(r.y0 for r in page.rules if r.horizontal and y0 + .003 < r.y0 < y1 - .003 and r.x1-r.x0 >= .8*(x1-x0))
    header_end = rules[0] if rules and rules[0] - y0 < .08 else y0
    body = [c for c in chars if 1-c.cy/page.height > header_end] or chars
    # Intersect blank space over all body lines. Unlike x-start clustering,
    # this keeps right-aligned numbers and centered labels in their column.
    intervals = []
    for c in sorted(body, key=lambda c:c.l):
        if intervals and c.l <= intervals[-1][1]:
            intervals[-1][1] = max(intervals[-1][1], c.r)
        else:
            intervals.append([c.l,c.r])
    boundaries = [(left[1]+right[0])/2 for left,right in zip(intervals,intervals[1:]) if right[0]-left[1] > .8*height]
    if not boundaries:
        return None  # boxed prose needs the block-based path
    edges = [x0*page.width] + boundaries + [x1*page.width]
    lines = []
    for c in sorted(chars,key=lambda c:(-c.b,c.l)):
        band = next((line for line in lines if abs(line[0].b-c.b) < .4*height),None)
        if band is None:lines.append([c])
        else:band.append(c)
    lines.sort(key=lambda line:-max(c.t for c in line))
    # A compact identifier/value column anchors logical records while prose
    # in neighbouring cells wraps over several glyph baselines. Choose only
    # a column with multiple short, separate entries; otherwise retain lines.
    compact = []
    for column, (left, right) in enumerate(zip(edges, edges[1:])):
        entries = []
        for line in lines:
            selected = [c for c in line if left <= c.cx < right and 1-c.cy/page.height > header_end]
            if selected:
                rendered = Line(selected, min(c.b for c in selected)); rendered.finalize()
                entries.append((max(c.t for c in selected), rendered.text))
        if len(entries) >= 3 and all(len(text) <= 40 and len(text.split()) <= 4 and '://' not in text for _, text in entries):
            compact.append((sum(len(text) for _, text in entries) / len(entries), entries))
    anchor_tops = [top for top, _ in min(compact, key=lambda pair: pair[0])[1]] if compact else []
    if require_anchors and not anchor_tops:
        return None
    if anchor_tops:
        # A short value column may contain a legitimate blank. A baseline
        # without its value is not automatically continuation of the prior
        # record. Existing cell geometry can attest wrapping; otherwise keep
        # physical rows (or refuse a speculative repair of an existing grid).
        unanchored = [max(c.t for c in line) for line in lines
                      if 1-statistics.mean(c.cy for c in line)/page.height > header_end
                      and not any(abs(max(c.t for c in line)-top) <= .5*height for top in anchor_tops)]
        if unanchored and not cell_boxes:
            if require_anchors:
                return None
            anchor_tops = sorted(set(anchor_tops + unanchored), reverse=True)
        else:
            for top in unanchored:
                # A source cell beginning here is a new independent record,
                # even if the compact value column is empty in that record.
                starting = [box for box in cell_boxes if abs(top - box[1]) <= .5*height]
                shares_anchored_row = any(len(start) > 4 and len(other) > 4 and start[4] == other[4] and any(abs(other[1]-anchor) <= .5*height for anchor in anchor_tops) for start in starting for other in cell_boxes)
                if starting and not shares_anchored_row:
                    anchor_tops.append(top)
            anchor_tops.sort(reverse=True)
    rows=[]
    for line in lines:
        is_header = header_end>y0 and 1-statistics.mean(c.cy for c in line)/page.height < header_end
        if is_header:
            if rows and rows[-1][0]: rows[-1][1].extend(line)
            else: rows.append([True,list(line)])
        elif anchor_tops:
            top = max(c.t for c in line)
            key = max(0, sum(top <= anchor + .5*height for anchor in anchor_tops) - 1)
            if rows and not rows[-1][0] and rows[-1][2] == key: rows[-1][1].extend(line)
            else: rows.append([False,list(line),key])
        else:
            rows.append([False,list(line)])
    cells=[]
    for row, entry in enumerate(rows):
        is_header, glyphs = entry[:2]
        for column,(left,right) in enumerate(zip(edges,edges[1:])):
            selected=[c for c in glyphs if left <= c.cx < right]
            if not selected:continue
            selected_ids = {id(c) for c in selected}
            text_lines=[]
            for baseline in lines:
                selected_line=[c for c in baseline if id(c) in selected_ids]
                if selected_line:
                    line=Line(selected_line,min(c.b for c in selected_line));line.finalize();text_lines.append(line.text)
            text=' '.join(text_lines)
            box=dict(page=page.page_no,x=min(c.l for c in selected)/page.width,y=1-max(c.t for c in selected)/page.height,
                     width=(max(c.r for c in selected)-min(c.l for c in selected))/page.width,
                     height=(max(c.t for c in selected)-min(c.b for c in selected))/page.height,rotation=0)
            cells.append(dict(id=f'c{row}-{column}',text=text,row=row,column=column,rowSpan=1,columnSpan=1,
                              headerScope='column' if is_header else None,inline=[],
                              evidence=dict(confidence=.8,pages=[page.page_no],boxes=[box],sourceIds=list(source_ids),signals=['source-glyph-grid'])))
    # Full-width rules delimit groups with a shared text label in the
    # first column (for example a story with noun and verb measurements).
    # Preserve that relationship as a row span rather than an unexplained
    # empty label cell on each subsequent measurement row.
    cuts = [header_end] + [r for r in rules if r > header_end + .003] + [y1]
    for top, bottom in zip(cuts, cuts[1:]):
        group = [cell for cell in cells if top <= cell["evidence"]["boxes"][0]["y"] + cell["evidence"]["boxes"][0]["height"]/2 <= bottom and cell["headerScope"] is None]
        row_ids = sorted({cell["row"] for cell in group})
        labels = [cell for cell in group if cell["column"] == 0]
        if len(row_ids) > 1 and len(labels) == 1 and any(ch.isalpha() for ch in labels[0]["text"]):
            label = labels[0]
            if any(cell is not label and cell["row"] == row_ids[0] and cell["column"] == 0 for cell in cells):
                continue  # the group's first row already has its own label cell
            label["row"] = row_ids[0]
            label["id"] = f"c{row_ids[0]}-0"
            label["rowSpan"] = row_ids[-1] - row_ids[0] + 1
    return dict(rows=len(rows),columns=len(edges)-1,cells=cells,semantic='source-preserved')


def _alnum(text):
    return "".join(ch.casefold() for ch in text if ch.isalnum())


def split_collapsed_rows(extracted_cells, source_grid):
    """Accept a glyph grid only as the extracted grid with collapsed rows split.

    The layout model sometimes puts several records in one row (`0.805 0.800`
    in one cell). A glyph grid can separate them, but the same glyph grid also
    cuts a wrapped label into one row per line. The split is accepted only when
    it conserves every column's text in order, keeps the header's words, never
    separates a hyphenated word, and a value column (a digit in every body
    row, at most four words) gives each new row its own record. The extracted
    header cells are kept, since column gaps measured on the body can cut a
    header word. Returns the cells to use, or None.
    """
    columns = source_grid["columns"]
    cells = source_grid["cells"]

    def column_texts(grid_cells):
        return [_alnum("".join(c["text"] for c in sorted(grid_cells, key=lambda c: c["row"]) if c["column"] == column and c["row"] > 0))
                for column in range(columns)]

    def header_text(grid_cells):
        return _alnum("".join(c["text"] for c in sorted(grid_cells, key=lambda c: c["column"]) if c["row"] == 0))

    if header_text(extracted_cells) != header_text(cells) or column_texts(extracted_cells) != column_texts(cells):
        return None
    origins = {(c["row"], c["column"]): c for c in cells}
    for (row, column), cell in origins.items():
        below = origins.get((row + cell["rowSpan"], column))
        if row > 0 and cell["text"].rstrip().endswith("-") and below is not None and below["text"].strip():
            return None
    body_rows = range(1, source_grid["rows"])

    def is_value(cell):
        return cell is not None and re.search(r"\d", cell["text"]) and len(cell["text"].split()) <= 4

    if not any(all(is_value(origins.get((row, column))) for row in body_rows) for column in range(columns)):
        return None
    header = [dict(c) for c in extracted_cells if c["row"] == 0]
    return header + [c for c in cells if c["row"] > 0]


def reconcile_table_captions(adapter):
    """Resolve caption ownership before the walk consumes attached refs.

    A caption attaches to the closest nonoverlapping grid in its own column.
    This also releases a page header or appendix heading mistakenly attached
    by the extractor, so that text is still walked in its original position.
    """
    from pdf2struct import TABLE_CAPTION_RE, FIGURE_CAPTION_RE
    from docling_core.types.doc import DocItemLabel
    # Footnote extraction can concatenate the table caption's next line.
    # Split only a caption label attested at the start of its own source line.
    import re
    from docling_core.types.doc import BoundingBox, CoordOrigin
    for note in list(adapter.doc.texts):
        if note.label not in (DocItemLabel.FOOTNOTE, DocItemLabel.TEXT, DocItemLabel.CODE) or not note.prov:
            continue
        embedded = re.search(r"\bTable\s+\d+(?:\.\d+)*[:.]\s+", note.text)
        if not embedded or embedded.start() == 0:
            continue
        page = adapter._page_text(note.prov[0].page_no)
        caption_text = note.text[embedded.start():].strip()
        normalized = lambda text: re.sub(r"[^\w]", "", text).casefold()
        line = next((line for line in page.lines if TABLE_CAPTION_RE.match(line.text) and normalized(caption_text).startswith(normalized(line.text))), None) if page else None
        if line is None:
            continue
        if note.label != DocItemLabel.FOOTNOTE and not any(r.horizontal and -.005 <= (1-line.t/page.height)-r.y0 <= .06 and r.x1-r.x0 >= .5*(line.r-line.l)/page.width for r in page.rules):
            continue
        box = BoundingBox(l=line.l, t=line.t, r=line.r, b=line.b, coord_origin=CoordOrigin.BOTTOMLEFT)
        provenance = note.prov[0].model_copy(update={"bbox": box, "charspan": (0, len(caption_text))})
        adapter.doc.add_text(label=DocItemLabel.CAPTION, text=caption_text, prov=provenance)
        note.text = note.text[:embedded.start()].rstrip()
        note.orig = note.text
        prefix_box = note.prov[0].bbox.to_bottom_left_origin(page.height)
        prefix_box = prefix_box.model_copy(update={"b": max(prefix_box.b, line.t + 1)})
        note.prov[0] = note.prov[0].model_copy(update={"bbox": prefix_box, "charspan": (0, len(note.text))})
    tables = [(item, adapter._box(item)) for item in adapter.doc.tables]
    old_captions = [(item, ref.resolve(adapter.doc)) for item, _ in tables for ref in item.captions]
    assignments = {}
    for caption in adapter.doc.texts:
        if not TABLE_CAPTION_RE.match(caption.text):
            continue
        cb = adapter._box(caption)
        if not cb:
            continue
        choices = []
        for item, tb in tables:
            if not tb or cb['page'] != tb['page']:
                continue
            overlap = min(cb['x']+cb['width'],tb['x']+tb['width'])-max(cb['x'],tb['x'])
            if overlap < .5*min(cb['width'],tb['width']):
                continue
            if cb['y'] >= tb['y']+tb['height']-.003:
                gap = cb['y']-(tb['y']+tb['height'])
            elif tb['y'] >= cb['y']+cb['height']-.003:
                gap = tb['y']-(cb['y']+cb['height'])
            else:
                continue
            if gap <= .1:
                choices.append((max(0,gap),item))
        if choices:
            gap,item = min(choices,key=lambda pair:pair[0])
            assignments.setdefault(item.self_ref,[]).append((gap,caption))
    assigned_refs = {min(candidates,key=lambda pair:pair[0])[1].self_ref for candidates in assignments.values()}
    for item,_ in tables:
        if item.self_ref in assignments:
            _,caption = min(assignments[item.self_ref],key=lambda pair:pair[0])
            caption.label = DocItemLabel.CAPTION
            item.captions = [caption.get_ref()]
        else:
            item.captions = [ref for ref in item.captions if ref.cref not in assigned_refs and (TABLE_CAPTION_RE.match(getattr(ref.resolve(adapter.doc), "text", "")) or re.match(r"^Table\s+[A-Z](?:\.)?\d+(?:\.\d+)*[:.]", getattr(ref.resolve(adapter.doc), "text", ""), re.I) or FIGURE_CAPTION_RE.match(getattr(ref.resolve(adapter.doc), "text", "")))]

    retained = {ref.cref for floating in list(adapter.doc.tables) + list(adapter.doc.pictures) for ref in floating.captions}
    for owner, displaced in old_captions:
        if displaced.self_ref in retained or not displaced.parent or displaced.parent.cref != owner.self_ref:
            continue
        owner.children = [ref for ref in owner.children if ref.cref != displaced.self_ref]
        anchor = owner
        while anchor.parent and anchor.parent.cref != adapter.doc.body.self_ref:
            anchor = anchor.parent.resolve(adapter.doc)
        siblings = adapter.doc.body.children
        at = next((i for i, ref in enumerate(siblings) if ref.cref == anchor.self_ref), len(siblings))
        old_box, displaced_box = adapter._box(owner), adapter._box(displaced)
        if old_box and displaced_box and displaced_box["y"] > old_box["y"]:
            at += 1
        if not any(ref.cref == displaced.self_ref for ref in siblings):
            siblings.insert(min(at,len(siblings)), displaced.get_ref())
        displaced.parent = adapter.doc.body.get_ref()


def prose_grid_from_source(page, region, source_ids=()):
    """Read a framed single-column prose table in source glyph order.

    Inline template fields often become separate Docling blocks; ordering
    those blocks by their left edge puts labels and placeholders out of order.
    Native baselines preserve the sentence and paragraph sequence instead.
    """
    if page is None:
        return None
    x0,y0,x1,y1=region
    chars=[c for c in page.chars if x0<=c.cx/page.width<=x1 and y0<=1-c.cy/page.height<=y1]
    if not chars:
        return None
    height=statistics.median(c.height for c in chars)
    bands=[]
    for char in sorted(chars,key=lambda c:(-c.b,c.l)):
        band=next((b for b in bands if abs(b[0].b-char.b)<=.4*height),None)
        if band is None:bands.append([char])
        else:band.append(char)
    lines=[]
    for band in bands:
        line=Line(band,min(c.b for c in band));line.finalize();lines.append(line)
    lines.sort(key=lambda line:-line.t)
    long_lines=sum(len(line.text.split())>=8 for line in lines)
    letters=sum(c.text.isalpha() for c in chars)
    digits=sum(c.text.isdigit() for c in chars)
    if long_lines < .35*len(lines) or letters < 4*digits:
        return None
    groups=[]
    previous=None
    for line in lines:
        bold=sum(any(token in c.font.lower() for token in ('bold','medi','demi')) for c in line.chars) >= .8*len(line.chars)
        gap=(previous.b-line.t) if previous else 0
        title_ended = previous is not None and previous is lines[0] and previous.r-previous.l < .6*(x1-x0)*page.width
        if previous is None or gap>.45*height or bold or title_ended:
            groups.append([line])
        else:
            groups[-1].append(line)
        previous=line
    cells=[]
    for row,group in enumerate(groups):
        glyphs=[c for line in group for c in line.chars]
        box=dict(page=page.page_no,x=min(c.l for c in glyphs)/page.width,y=1-max(c.t for c in glyphs)/page.height,
                 width=(max(c.r for c in glyphs)-min(c.l for c in glyphs))/page.width,
                 height=(max(c.t for c in glyphs)-min(c.b for c in glyphs))/page.height,rotation=0)
        cells.append(dict(id=f'c{row}-0',text=' '.join(line.text for line in group),row=row,column=0,rowSpan=1,columnSpan=1,
                          headerScope=None,inline=[],evidence=dict(confidence=.8,pages=[page.page_no],boxes=[box],sourceIds=list(source_ids),signals=['source-glyph-prose-table'])))
    return dict(rows=len(cells),columns=1,cells=cells,semantic='source-preserved')


def migrate_cell_runs(originals, cells):
    """Move each source run once, using unchanged text offsets or cell geometry.

    Ambiguous text matches are returned to the caller; they must not turn one
    source annotation into several links just because the label is repeated.
    """
    import re
    unresolved = []
    allocated = {}
    for original in originals:
        text = original.get('text', '')
        for run in sorted(original.get('inline', []), key=lambda r: (r['start'], r['end'])):
            visible = text[run['start']:run['end']]
            if not visible:
                continue
            candidates = []
            for cell in cells:
                target = cell['text']
                # An intact source fragment carries exact offsets, including
                # the second of two identically worded links in one fragment.
                whole = list(re.finditer(re.escape(text), target)) if text else []
                spans = [(m.start()+run['start'], m.start()+run['end']) for m in whole]
                exact = bool(spans)
                if not spans:
                    spans = [m.span() for m in re.finditer(re.escape(visible), target)]
                old_boxes = original.get('evidence', {}).get('boxes', [])
                new_boxes = cell.get('evidence', {}).get('boxes', [])
                distances = [(abs(a['x']-b['x'])+abs(a['y']-b['y'])) for a in old_boxes for b in new_boxes if a['page']==b['page']]
                distance = min(distances, default=1)
                for start, end in spans:
                    key = (id(cell), start, end)
                    existing = {**run, 'start': start, 'end': end}
                    if existing in cell.get('inline', []):
                        candidates.append((0 if exact else 1, distance, cell, (start,end), True))
                    elif key not in allocated:
                        candidates.append((0 if exact else 1, distance, cell, (start,end), False))
            if not candidates:
                unresolved.append((original,run))
                continue
            candidates.sort(key=lambda c:c[:2])
            best = candidates[0]
            if len(candidates)>1 and candidates[1][:2]==best[:2]:
                unresolved.append((original,run))
                continue
            _,_,cell,(start,end),already = best
            if not already:
                cell.setdefault('inline', []).append({**run,'start':start,'end':end})
            if run.get('href') or run.get('targetIds') or run.get('relationshipId'):
                allocated[(id(cell),start,end)] = run
    return unresolved


def rebind_table_relationships(relationships, absorbed_ids, table_id):
    """The retained table owns relationships of its absorbed source blocks."""
    for relationship in relationships:
        if relationship['from'] in absorbed_ids:
            relationship['from'] = table_id
        relationship['to'] = list(dict.fromkeys(table_id if target in absorbed_ids else target for target in relationship['to']))
