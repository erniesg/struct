"""Separate two tables the layout model read as one grid.

Two tables printed side by side are sometimes returned as a single grid whose
first row holds both captions, each spanning its half (`Table 1: …` over the
first four columns, `Table 2: …` over the last three). Everything downstream
then sees one table with two captions, and the second `Table N` label is
nowhere in the output.

Where the captions say so — two or more caption cells in the first row, each
spanning its own columns and together covering the grid — the grid is cut into
one table per caption before the walk, each with its own caption and the rows
of its own columns.
"""

from __future__ import annotations

import re

from docling_core.types.doc import BoundingBox, DocItemLabel, DoclingDocument, ProvenanceItem, TableData, TableItem

CAPTION_CELL_RE = re.compile(r"^\s*(?:Table|Figure|Fig\.?)\s*(?:[A-Z]\.?)?\d+(?:\.\d+)*\s*[.:]", re.IGNORECASE)


def _caption_cells(table: TableItem):
    """The first row's caption cells, left to right, or None when there are not two."""
    grid = table.data.table_cells if table.data else []
    heads = [cell for cell in grid if cell.start_row_offset_idx == 0 and cell.col_span >= 2 and CAPTION_CELL_RE.match(cell.text or "")]
    heads.sort(key=lambda cell: cell.start_col_offset_idx)
    if len(heads) < 2:
        return None
    columns = 0
    for head in heads:
        if head.start_col_offset_idx != columns:
            return None  # the caption cells do not tile the grid's columns
        columns = head.end_col_offset_idx
    if columns != (table.data.num_cols or 0):
        return None
    return heads


def lift_caption_rows(doc: DoclingDocument) -> int:
    """Give a grid whose first row is its caption that caption. Returns the count.

    A caption printed above a table inside the same ruled block is read as the
    grid's first row, spanning every column. The table then owns no caption:
    the reader sees `Table 1: …` as a cell of the table it names, and nothing
    downstream can resolve the label. The row is lifted out and attached to the
    table it captions, leaving the rows the table is made of.
    """
    lifted = 0
    for table in doc.tables:
        grid = table.data.table_cells if table.data else []
        first = [cell for cell in grid if cell.start_row_offset_idx == 0]
        columns = table.data.num_cols or 0
        if table.captions or len(first) != 1 or len(grid) < 4 or not columns:
            continue
        head = first[0]
        if head.col_span < columns or not CAPTION_CELL_RE.match(head.text or ""):
            continue
        text = (head.text or "").strip()
        provenance = table.prov[0] if table.prov else None
        if provenance is None:
            continue
        caption = doc.add_text(label=DocItemLabel.CAPTION, text=text, orig=text,
                               prov=ProvenanceItem(page_no=provenance.page_no, charspan=(0, len(text)),
                                                   bbox=head.bbox or provenance.bbox))
        table.captions.append(caption.get_ref())
        for cell in grid:
            cell.start_row_offset_idx -= 1
            cell.end_row_offset_idx -= 1
        table.data.table_cells = [cell for cell in grid if cell.end_row_offset_idx > 0]
        table.data.num_rows = max((cell.end_row_offset_idx for cell in table.data.table_cells), default=0)
        # the caption is `add_text`-ed to the end of the body: move it beside
        # its table, where the reader expects to meet it
        position = next((index for index, ref in enumerate(doc.body.children) if ref.cref == table.self_ref), None)
        reference = caption.get_ref()
        body = [child for child in doc.body.children if child.cref != reference.cref]
        if position is not None:
            body.insert(position + 1, reference)
            doc.body.children = body
        lifted += 1
    return lifted


def _bounds(cells, fallback: BoundingBox) -> BoundingBox:
    boxes = [cell.bbox for cell in cells if cell.bbox]
    if not boxes:
        return fallback
    return BoundingBox(l=min(b.l for b in boxes), r=max(b.r for b in boxes),
                       t=max(b.t for b in boxes), b=min(b.b for b in boxes), coord_origin=boxes[0].coord_origin)


def split_side_by_side_tables(doc: DoclingDocument) -> int:
    """Cut every grid whose first row holds two or more captions. Returns the count."""
    split = 0
    for table in list(doc.tables):
        heads = _caption_cells(table)
        if heads is None or not table.prov:
            continue
        provenance = table.prov[0]
        page = doc.pages.get(provenance.page_no)
        if page is None:
            continue
        parts = []
        for head in heads:
            first, last = head.start_col_offset_idx, head.end_col_offset_idx
            cells = []
            for cell in table.data.table_cells:
                if cell.start_row_offset_idx == 0 or not (first <= cell.start_col_offset_idx < last):
                    continue
                moved = cell.model_copy(deep=True)
                moved.start_row_offset_idx -= 1
                moved.end_row_offset_idx -= 1
                moved.start_col_offset_idx -= first
                moved.end_col_offset_idx = min(moved.end_col_offset_idx, last) - first
                moved.col_span = max(1, moved.end_col_offset_idx - moved.start_col_offset_idx)
                cells.append(moved)
            if len(cells) < 4:
                parts = []
                break
            parts.append((head, cells))
        if not parts:
            continue
        position = next((index for index, ref in enumerate(doc.body.children) if ref.cref == table.self_ref), len(doc.body.children))
        # remove the grid first: deleting an item renumbers the references of the
        # items after it, which would invalidate the ones added here
        doc.delete_items(node_items=[table])
        added = []
        for head, cells in parts:
            data = TableData(num_rows=max(cell.end_row_offset_idx for cell in cells), num_cols=last_column(cells), table_cells=cells)
            box = _bounds(cells, provenance.bbox)
            caption_box = head.bbox or box
            caption = doc.add_text(label=DocItemLabel.CAPTION, text=head.text.strip(), orig=head.text.strip(),
                                   prov=ProvenanceItem(page_no=provenance.page_no, charspan=(0, len(head.text.strip())), bbox=caption_box))
            part = doc.add_table(data=data, caption=caption,
                                 prov=ProvenanceItem(page_no=provenance.page_no, charspan=(0, 0), bbox=box))
            added.append(part)
        # `add_table`/`add_text` append to the body: move the new items, each
        # caption beside its own table, into the place the original grid held
        # (the caption stays in the body so nothing takes its words for a
        # dropped region)
        # the table comes first: the walk marks its caption consumed as it emits
        # the table, so the caption after it is not read again as an orphan
        order = [reference for item in added for reference in [item.get_ref()] + list(item.captions)]
        placed = {reference.cref for reference in order}
        body = [reference for reference in doc.body.children if reference.cref not in placed]
        position = min(position, len(body))
        doc.body.children = body[:position] + order + body[position:]
        split += 1
    return split


def last_column(cells) -> int:
    return max(cell.end_col_offset_idx for cell in cells)
