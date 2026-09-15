"""Reconstruct local annotation occurrences after the output graph has settled.

Only surviving source regions may supply an anchor or destination. Repeated
anchor strings require local PDF word context; ambiguous evidence stays visible
in the occurrence ledger and diagnostics instead of choosing the first match.
"""
from __future__ import annotations

import re
import unicodedata


def _compact(text):
    chars, offsets = [], []
    for i, char in enumerate(text):
        for c in unicodedata.normalize('NFKC', char).casefold():
            if not c.isspace() and c not in '\u00ad\u200b':
                chars.append(c.translate(str.maketrans({'“':'"', '”':'"', '‘':"'", '’':"'", '–':'-', '−':'-'})))
                offsets.append(i)
    return ''.join(chars), offsets


def _boxes(obj, page):
    return [b for b in obj.get('evidence', {}).get('boxes', []) if b.get('page') == page]


def _size(adapter, page):
    item = adapter.doc.pages.get(page)
    return (float(item.size.width), float(item.size.height)) if item else (0, 0)


def _overlap(box, rect):
    l, t, r, b = rect
    return max(0, min(box['x'] + box['width'], r) - max(box['x'], l)) * max(0, min(box['y'] + box['height'], b) - max(box['y'], t))


def _containers(adapter):
    for block in adapter.blocks:
        if block.get('kind') == 'furniture':
            continue
        if block.get('table'):
            for cell in block['table'].get('cells', []):
                yield block, cell
        elif block.get('text'):
            yield block, block


def _source_context(adapter, link, boxes):
    """Word context belongs to this source region, not the whole document."""
    width, height = _size(adapter, link.page)
    pages = getattr(adapter, 'word_boxes', [])
    words = pages[link.page - 1] if link.page <= len(pages) else []
    chosen, marked = [], []
    l, b, r, t = link.rect
    for x0, y0, x1, y1, text in words:
        cx, cy = (x0+x1)/2, (y0+y1)/2
        if not any(bb['x']*width-1 <= cx <= (bb['x']+bb['width'])*width+1 and bb['y']*height-1 <= cy <= (bb['y']+bb['height'])*height+1 for bb in boxes):
            continue
        selected = l-1 <= cx <= r+1 and height-t-1 <= cy <= height-b+1
        chosen.append(_compact(text)[0])
        if selected:
            marked.append(len(chosen)-1)
    if not marked:
        return None
    start, end = marked[0], marked[-1]
    # A disjoint word selection cannot prove one contiguous output anchor.
    if marked != list(range(start, end+1)):
        return None
    return ''.join(chosen[:start])[-80:], ''.join(chosen[start:end+1]), ''.join(chosen[end+1:])[:80]


def _anchor(adapter, obj, link, boxes):
    output, offsets = _compact(obj.get('text', ''))
    needle = _compact(link.text)[0]
    context = _source_context(adapter, link, boxes)
    if context:
        left, needle, right = context
    if not needle:
        return None, 'empty-anchor'
    split_end = bool(context and needle.endswith('-') and right and right[0].isalpha() and needle not in output)
    split_start = bool(context and left.endswith('-') and needle[0].isalpha())
    if split_end:
        needle = needle[:-1]
    hits = [m.start() for m in re.finditer(re.escape(needle), output)]
    hits = [pos for pos in hits if not (not split_start and needle[0].isalnum() and offsets[pos] > 0 and obj['text'][offsets[pos]-1].isalnum()) and not (not split_end and needle[-1].isalnum() and offsets[pos+len(needle)-1]+1 < len(obj['text']) and obj['text'][offsets[pos+len(needle)-1]+1].isalnum())]
    if not hits:
        return None, 'anchor-text-unaligned'
    if len(hits) > 1:
        if not context:
            return None, 'ambiguous-anchor-occurrence'
        scores = []
        for pos in hits:
            before, after = output[:pos], output[pos+len(needle):]
            nleft = next((n for n in range(min(len(left),len(before)), -1, -1) if before.endswith(left[-n:]) or n == 0), 0)
            nright = next((n for n in range(min(len(right),len(after)), -1, -1) if after.startswith(right[:n])), 0)
            scores.append(nleft+nright)
        best = max(scores)
        if best < 3 or scores.count(best) != 1:
            return None, 'ambiguous-anchor-occurrence'
        pos = hits[scores.index(best)]
    else:
        pos = hits[0]
    return (offsets[pos], offsets[pos+len(needle)-1]+1), None


def _label_target(adapter, link):
    """A corrupt source viewport may still name an exactly attested caption.

    Both original source text and a single surviving block on the destination
    page must carry its explicit figure/table label. No label-free fallback.
    """
    match = re.match(r'(?i)(figure|table)[.:]', link.destination_name or '')
    anchor = re.fullmatch(r'\s*(?:[([])?(\d+[a-z]?)(?:[).,;:\]])?\s*', link.text)
    if not match or not anchor:
        return None
    kind, label = match.group(1).lower(), anchor.group(1)
    pattern = re.compile(r'(?i)^\s*' + (r'(?:Figure|Fig\.?)' if kind == 'figure' else 'Table') + r'\s*' + re.escape(label) + r'(?![\w.])')
    pages = getattr(adapter, 'word_boxes', [])
    words = pages[link.destination_page-1] if link.destination_page <= len(pages) else []
    # PDF word extraction supplies source reading order; require a visible
    # caption prefix, not a destination-name-derived invented label.
    source = ' '.join(w[4] for w in words)
    if not re.search(pattern.pattern.replace('^', '', 1), source):
        return None
    matches = [b for b in adapter.blocks if _boxes(b, link.destination_page) and b.get('kind') in {kind, 'caption'} and pattern.match(b.get('text', ''))]
    return matches[0]['id'] if len(matches) == 1 else None


def _target(adapter, link):
    if link.unresolved_reason:
        return None, link.unresolved_reason
    width, height = _size(adapter, link.destination_page)
    if not width or not height:
        return None, 'missing-destination-page'
    x, y = link.destination_x, link.destination_y
    if y is None:
        return None, 'destination-without-vertical-position'
    y = height-y
    if not -1 <= y <= height+1:
        target = _label_target(adapter, link)
        return (target, None) if target else (None, 'destination-coordinate-out-of-bounds')
    candidates = {}
    for block in adapter.blocks:
        if block.get('kind') == 'furniture':
            continue
        for box in _boxes(block, link.destination_page):
            left, right = box['x']*width, (box['x']+box['width'])*width
            top, bottom = box['y']*height, (box['y']+box['height'])*height
            # PDF destinations conventionally sit just above their heading or
            # first baseline. Restrict to its horizontal column and a short gap.
            if x is not None and not left-36 <= x <= right+2:
                continue
            if top-48 <= y <= bottom+1:
                distance = max(top-y, y-bottom, 0)
                candidates[block['id']] = min(candidates.get(block['id'], float('inf')), distance)
    if not candidates:
        target = _label_target(adapter, link)
        return (target, None) if target else (None, 'destination-region-unmapped')
    if re.match(r'(?i)H?footnote[.:]', link.destination_name or ''):
        label = re.sub(r'[^0-9a-zA-Z*†‡]', '', link.text)
        labelled = [b['id'] for b in adapter.blocks if b['id'] in candidates and b.get('kind') == 'footnote' and str(b.get('label', '')) == label]
        if len(labelled) == 1:
            return labelled[0], None
    best = min(candidates.values())
    winners = [ident for ident, distance in candidates.items() if abs(distance-best) <= 1]
    if len(winners) != 1:
        return None, 'ambiguous-destination-region'
    return winners[0], None


def recover_internal_links(adapter):
    """Mutate surviving inline arrays; return auditable per-annotation coverage."""
    records = []
    for index, link in enumerate(adapter.links):
        if link.kind != 'internal':
            continue
        record = dict(sourceId=link.source_id or f'pdf-link-{index}', page=link.page,
                      rect=list(link.rect), text=link.text, destinationName=link.destination_name,
                      destinationPage=link.destination_page, destinationX=link.destination_x,
                      destinationY=link.destination_y, destinationMode=link.destination_mode, status='unresolved')
        target, reason = _target(adapter, link)
        if target:
            width, height = _size(adapter, link.page)
            candidates = []
            if width and height:
                l,b,r,t = link.rect
                rect = l/width, (height-t)/height, r/width, (height-b)/height
                for block, obj in _containers(adapter):
                    boxes = [box for box in _boxes(obj, link.page) if _overlap(box, rect) > 0]
                    if not boxes:
                        continue
                    span, why = _anchor(adapter, obj, link, boxes)
                    if span:
                        candidates.append((block, obj, span))
                    else:
                        reason = why
            if len(candidates) != 1:
                reason = 'ambiguous-anchor-region' if candidates else reason or 'anchor-region-unmapped'
            else:
                block, obj, (start, end) = candidates[0]
                overlaps = [run for run in obj.setdefault('inline', []) if (run.get('href') or run.get('targetIds')) and start < run['end'] and end > run['start']]
                covered = len(overlaps) == 1 and start <= overlaps[0]['start'] < overlaps[0]['end'] <= end and (overlaps[0].get('targetIds') == [target] or overlaps[0].get('href') == '#'+target) and not any(c.isalnum() for c in obj['text'][start:overlaps[0]['start']] + obj['text'][overlaps[0]['end']:end])
                if overlaps and not covered:
                    reason = 'anchor-overlaps-existing-link'
                else:
                    if not overlaps:
                        name = link.destination_name or ''
                        role = 'citation' if re.match(r'(?i)(?:cite|bib)[.:_-]', name) else 'cross-reference'
                        obj['inline'].append(dict(start=start, end=end, href='#'+target, targetIds=[target], semanticRole=role))
                    if overlaps:
                        start, end = overlaps[0]['start'], overlaps[0]['end']
                    record.update(status='linked', blockId=block['id'], containerId=obj['id'], start=start, end=end, targetId=target)
                    _, destination_height = _size(adapter, link.destination_page)
                    if link.destination_y is not None and not -1 <= link.destination_y <= destination_height+1:
                        record['sourceDestinationIssue'] = 'destination-coordinate-out-of-bounds'
                        record['targetResolution'] = 'source-caption-label-on-destination-page'
                    reason = None
        if reason:
            record['reason'] = reason
            if hasattr(adapter, '_diagnostic'):
                adapter._diagnostic('warning', 'links', 'Unresolved internal PDF link', f"{record['sourceId']}: {reason}", None, link.page)
        records.append(record)
    result = dict(total=len(records), linked=sum(r['status']=='linked' for r in records), occurrences=records)
    result['unresolved'] = result['total']-result['linked']
    adapter.internal_link_coverage = result
    return result
