"""Geometry rules for figures whose text is set sideways on portrait pages."""
from __future__ import annotations

import re
from docling_core.types.doc import DocItemLabel

FIGURE_START = re.compile(r"^(?:Extended\s+Data\s+)?(?:Figure|Fig\.?)\s*\d+", re.I)


def sideways_box(box: dict) -> bool:
    """A line rotated on the page has a tall, narrow bounding box."""
    return box['width'] < .07 and box['height'] > max(.15, 4 * box['width'])


def normalize_sideways_captions(doc) -> None:
    """Recover caption labels lost to footnote classification using adjacent
    rotated text lines, before footnote markers or links are constructed.
    Text and provenance are retained verbatim; ownership is resolved later.
    """
    for start in doc.texts:
        if not FIGURE_START.match(start.text.strip()) or len(start.prov) != 1:
            continue
        p = start.prov[0]
        size = doc.pages[p.page_no].size
        b = p.bbox.to_top_left_origin(size.height)
        previous = {'x': b.l / size.width, 'y': b.t / size.height,
                    'width': (b.r-b.l)/size.width, 'height': (b.b-b.t)/size.height}
        if not sideways_box(previous):
            continue
        start.label = DocItemLabel.CAPTION
        candidates=[]
        for item in doc.texts:
            if item is start or len(item.prov)!=1 or item.prov[0].page_no != p.page_no:
                continue
            ib=item.prov[0].bbox.to_top_left_origin(size.height)
            box={'x':ib.l/size.width,'y':ib.t/size.height,'width':(ib.r-ib.l)/size.width,'height':(ib.b-ib.t)/size.height}
            if sideways_box(box) and box['x'] > previous['x']:
                candidates.append((box['x'],item,box))
        for _,item,box in sorted(candidates,key=lambda entry:entry[0]):
            gap=box['x']-(previous['x']+previous['width'])
            overlap=min(box['y']+box['height'],previous['y']+previous['height'])-max(box['y'],previous['y'])
            if gap > .025 or overlap < .65 * min(box['height'],previous['height']) or FIGURE_START.match(item.text.strip()):
                break
            item.label=DocItemLabel.CAPTION
            previous=box


def adopt_sideways_captions(adapter) -> None:
    """Join the physical columns of a rotated caption and attach it across
    its legend band. Ordinary sideways prose and other pages are untouched.
    """
    for caption in list(adapter.blocks):
        if caption not in adapter.blocks or caption['kind'] not in ('caption','paragraph') or not FIGURE_START.match(caption['text']):
            continue
        boxes=caption['evidence']['boxes']
        if len(boxes)!=1 or not sideways_box(boxes[0]):
            continue
        cb=boxes[0];page=caption['page']
        pictures=[]
        for figure in adapter.blocks:
            if figure['kind']!='figure' or figure['page']!=page or FIGURE_START.match(figure['text']) or not figure['evidence']['boxes']:
                continue
            fb=figure['evidence']['boxes'][0]
            gap=cb['x']-(fb['x']+fb['width'])
            overlap=min(cb['y']+cb['height'],fb['y']+fb['height'])-max(cb['y'],fb['y'])
            if -.01 <= gap <= .13 and overlap >= .7*fb['height']:
                pictures.append((gap,figure))
        if not pictures:
            continue
        figure=min(pictures,key=lambda entry:entry[0])[1]
        parts=[caption];previous=cb
        candidates=[]
        for b in adapter.blocks:
            if b is caption or b['page']!=page or b['kind'] not in ('caption','paragraph') or len(b['evidence']['boxes'])!=1:
                continue
            bb=b['evidence']['boxes'][0]
            if sideways_box(bb) and bb['x']>cb['x']:
                candidates.append((bb['x'],b,bb))
        for _,b,bb in sorted(candidates,key=lambda entry:entry[0]):
            gap=bb['x']-(previous['x']+previous['width'])
            overlap=min(bb['y']+bb['height'],previous['y']+previous['height'])-max(bb['y'],previous['y'])
            if gap > .025 or overlap < .65 * min(bb['height'],previous['height']) or FIGURE_START.match(b['text']):
                break
            parts.append(b);previous=bb
        fb=figure['evidence']['boxes'][0]
        # Include the legend between plot and caption, with a small margin.
        adapter._recrop_figure(figure,fb['x'],fb['y'],max(fb['x']+fb['width'],cb['x']-.015),fb['y']+fb['height'])
        assembled=[];runs=[];offset=0
        for part in parts:
            value=part['text'].strip()
            leading=len(part['text'])-len(part['text'].lstrip())
            for run in part.get('inline',[]):
                start=max(0,run['start']-leading);end=min(len(value),run['end']-leading)
                if end>start:
                    runs.append({**run,'start':offset+start,'end':offset+end})
            assembled.append(value)
            offset+=len(value)+1
        figure['text']=' '.join(assembled)
        figure['inline']=runs
        from pdf2struct import canonical_figure_label
        figure['label']=canonical_figure_label(figure['text'])
        figure['evidence']['sourceIds']=list(dict.fromkeys(figure['evidence']['sourceIds']+[sid for b in parts for sid in b['evidence']['sourceIds']]))
        figure['evidence']['signals']=list(dict.fromkeys(figure['evidence'].get('signals',[])+['sideways-caption']))
        adapter._attached_caption_boxes[figure['id']]=cb
        additional=getattr(adapter,'_additional_caption_boxes',{})
        additional[figure['id']]=[dict(b['evidence']['boxes'][0]) for b in parts[1:]]
        adapter._additional_caption_boxes=additional
        for b in parts:
            adapter.blocks.remove(b)
            if b['kind']=='caption': adapter.report.orphan_captions-=1
            else: adapter.report.paragraphs-=1
        adapter.report.figures_with_caption+=1
        adapter.report.captions_adopted_by_geometry+=1


def recover_picture_galleries(adapter) -> None:
    """Reunite a dense gallery that the detector split into many photographs.

    The source must have one numbered figure caption on the page, at least
    six picture regions, and no intervening table. Individual picture
    captions bound the gallery, retaining instructions printed above panels.
    """
    for owner in list(adapter.blocks):
        if owner['kind']!='figure' or not FIGURE_START.match(owner['text']) or 'picture-gallery' in owner['evidence'].get('signals',[]):
            continue
        page=owner['page'];cap=adapter._attached_caption_boxes.get(owner['id'])
        if not cap or cap['page']!=page or cap['width']<.3 or sideways_box(cap):
            continue
        labels={t.text.split(':',1)[0] for t in adapter.doc.texts if FIGURE_START.match(t.text.strip()) and t.prov and t.prov[0].page_no==page}
        if len(labels)!=1:
            continue
        pictures=[];regions=[]
        for pic in adapter.doc.pictures:
            pb=adapter._box(pic)
            if not pb or pb['page']!=page or pb['y']+pb['height']>cap['y']+.01:
                continue
            pictures.append(pic);regions.append(pb)
            for ref in pic.captions:
                item=ref.resolve(adapter.doc)
                box=adapter._box(item)
                if box and box['page']==page and not FIGURE_START.match(item.text.strip()):
                    regions.append(box)
        if len(pictures)<6:
            continue
        # Captions describing each photo may have been emitted as ordinary
        # text rather than associated with the PictureItem. Include short
        # text regions directly beside a source photo in the same row.
        photo_boxes=[adapter._box(pic) for pic in pictures]
        for candidate in adapter.blocks:
            if candidate is owner or candidate['page']!=page or candidate['kind'] not in ('paragraph','caption','heading','list-item') or FIGURE_START.match(candidate['text']):
                continue
            boxes=candidate['evidence']['boxes']
            if not boxes or any(bb['page']!=page or bb['height']>.12 or bb['y']+bb['height']>cap['y'] for bb in boxes):
                continue
            adjacent=True
            for bb in boxes:
                if not any(min(bb['y']+bb['height'],pb['y']+pb['height'])-max(bb['y'],pb['y']) >= .6*bb['height'] and
                           -.01 <= max(bb['x']-(pb['x']+pb['width']),pb['x']-(bb['x']+bb['width'])) <= .035 for pb in photo_boxes):
                    adjacent=False;break
            if adjacent:
                regions.extend(boxes)
        x0=min(r['x'] for r in regions);x1=max(r['x']+r['width'] for r in regions)
        y0=min(r['y'] for r in regions);y1=cap['y']-.003
        if y1-y0<.2 or x1-x0<.4 or sum(r['width']*r['height'] for r in regions)<.04:
            continue
        members=[];blocked=False
        for b in adapter.blocks:
            if b is owner or b['page']!=page or b['kind']=='furniture':
                continue
            boxes=[bb for bb in b['evidence']['boxes'] if bb['page']==page]
            if not boxes:
                continue
            inside=all(bb['x']>=x0-.015 and bb['x']+bb['width']<=x1+.015 and bb['y']>=y0-.015 and bb['y']+bb['height']<=y1+.003 for bb in boxes)
            if inside:
                if b['kind'] in ('table','equation') or FIGURE_START.match(b['text']):
                    blocked=True;break
                if 'figure-linked-label' not in b['evidence'].get('signals',[]):
                    members.append(b)
        if blocked:
            continue
        old_assets=list(owner.get('fallbackAssetIds',[]))
        adapter._recrop_figure(owner,max(0,x0-.003),max(0,y0-.003),min(1,x1+.003),y1)
        if owner.get('fallbackAssetIds',[])==old_assets:
            continue
        owner['evidence']['signals'].append('picture-gallery')
        owner['evidence']['sourceIds']=list(dict.fromkeys(owner['evidence']['sourceIds']+[sid for b in members for sid in b['evidence']['sourceIds']]+[adapter._source_id(pic) for pic in pictures]))
        discarded={aid for b in members for aid in b.get('fallbackAssetIds',[])}
        adapter.assets=[a for a in adapter.assets if a['id'] not in discarded]
        for b in members:
            adapter.blocks.remove(b)
            if b['kind']=='figure':
                adapter.report.figures-=1
                adapter.report.subpanel_figures_merged+=1


def join_caption_columns(adapter, owner: dict, members: list[dict]) -> None:
    """Retain a figure caption continued in a second physical text column.

    Layout detectors sometimes attach that continuation to the right-hand
    subplot. Its text must join the main caption before that subplot is
    absorbed and both caption columns are excluded from the artwork crop.
    """
    first=adapter._attached_caption_boxes.get(owner['id'])
    if not first or first['height']<.025 or first['width']<.2:
        return
    for member in sorted(members,key=lambda b:adapter._attached_caption_boxes.get(b['id'],{}).get('x',0)):
        if member is owner or not member['text'] or FIGURE_START.match(member['text']):
            continue
        second=adapter._attached_caption_boxes.get(member['id'])
        if not second or second['page']!=first['page'] or second['width']<.2 or second['height']<.025:
            continue
        gap=second['x']-(first['x']+first['width'])
        if not -.01<=gap<=.06 or abs(second['y']-first['y'])>.008 or first['width']+second['width']<.65:
            continue
        value=member['text'].strip();leading=len(member['text'])-len(member['text'].lstrip());offset=len(owner['text'])+1
        owner['text']+=' '+value
        for run in member.get('inline',[]):
            lo=max(0,run['start']-leading);hi=min(len(value),run['end']-leading)
            if hi>lo:
                owner.setdefault('inline',[]).append({**run,'start':offset+lo,'end':offset+hi})
        owner['evidence'].setdefault('signals',[]).append('caption-columns-joined')
        additional=getattr(adapter,'_additional_caption_boxes',{})
        additional.setdefault(owner['id'],[]).append(dict(second))
        adapter._additional_caption_boxes=additional
        first=second


def retain_caption_evidence(adapter) -> None:
    """Expose caption destinations after crop geometry has finished changing.

    The first block box remains its artwork region. Asset evidence continues
    to describe only the actual raster crop; caption geometry belongs to the
    semantic block for source-link destinations and ownership accounting.
    """
    for figure in adapter.blocks:
        if figure['kind']!='figure':
            continue
        caption=adapter._attached_caption_boxes.get(figure['id'])
        if caption is None:
            continue
        evidence=figure['evidence']
        caption_boxes=[caption]+getattr(adapter,'_additional_caption_boxes',{}).get(figure['id'],[])
        for box in caption_boxes:
            if box not in evidence['boxes']:
                evidence['boxes'].append(dict(box))
        evidence['pages']=sorted(set(evidence.get('pages',[])+[box['page'] for box in evidence['boxes']]))
        evidence['signals']=list(dict.fromkeys(evidence.get('signals',[])+['caption-geometry-retained']))
