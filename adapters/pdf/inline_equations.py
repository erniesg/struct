"""Recover a complete inline expression from an overlapping formula fragment.

The layout fragment identifies an expression; source glyph faces and delimiters
supply only immediately adjacent missing mathematical content. Alignment must
anchor both ends in the paragraph before any replacement run is returned.
"""
from dataclasses import dataclass
from difflib import SequenceMatcher
import re
from equation_recovery import recover_equation
from pdf_text import classify_font


def _chars_in(page,box):
    l=box['x']*page.width;r=(box['x']+box['width'])*page.width
    b=(1-box['y']-box['height'])*page.height;t=(1-box['y'])*page.height
    return [c for c in page.chars if l-.75<=c.cx<=r+.75 and b-.75<=c.cy<=t+.75]


def _math_neighbor(char):
    faces=classify_font(char.font)
    return (faces['math'] or faces['bold'] or char.text in '=+-−×÷/()[]{}⊤|∣∥.,:;'
            or char.text.isdecimal() or (len(char.text)==1 and char.text.isupper()))


def inline_formula_region(page, paragraph_box, fragment_box):
    chars=_chars_in(page,paragraph_box)
    fragment=_chars_in(page,fragment_box)
    if not chars or not fragment:return None
    l=min(c.l for c in fragment);r=max(c.r for c in fragment)
    center=(min(c.b for c in fragment)+max(c.t for c in fragment))/2
    scale=max(c.height for c in fragment)
    line=[c for c in chars if abs(c.cy-center)<scale]
    for c in sorted([c for c in line if c.r<=l+.75],key=lambda c:c.r,reverse=True):
        if not _math_neighbor(c) or l-c.r>scale*.65:break
        l=min(l,c.l)
    for c in sorted([c for c in line if c.l>=r-.75],key=lambda c:c.l):
        if not _math_neighbor(c) or c.l-r>scale*.65:break
        r=max(r,c.r)
    members=[c for c in line if l-.75<=c.cx<=r+.75]
    if not members:return None
    b=min(c.b for c in members);t=max(c.t for c in members)
    return dict(paragraph_box,x=l/page.width,y=1-t/page.height,width=(r-l)/page.width,height=(t-b)/page.height)


def _compact(text):
    values=[];offsets=[]
    for i,c in enumerate(text):
        if c.isspace():continue
        values.append({'−':'-','∣':'|'}.get(c,c));offsets.append(i)
    return ''.join(values),offsets


def recover_inline_equation(page, paragraph_box, fragment_box, text):
    """Return an atomic ``start/end/mathml`` run plus recovery evidence."""
    box=inline_formula_region(page,paragraph_box,fragment_box)
    if box is None:return None
    recovered=recover_equation(page,box)
    if recovered is None or recovered.mathml is None:return None
    # Source extraction order retains scripts beside their base. Match the
    # complete source paragraph for unambiguous context, allowing model-omitted
    # operators inside the expression without extending into adjacent prose.
    source_chars=_chars_in(page,paragraph_box)
    source=''.join(c.text for c in source_chars)
    compact,offsets=_compact(text)
    source_compact,source_offsets=_compact(source)
    mapping={}
    for match in SequenceMatcher(None,source_compact,compact,autojunk=False).get_matching_blocks():
        mapping.update((match.a+i,match.b+i)for i in range(match.size))
    selected=[];position=0
    for c in source_chars:
        inside=box['x']*page.width-.75<=c.cx<=(box['x']+box['width'])*page.width+.75 and (1-box['y']-box['height'])*page.height-.75<=c.cy<=(1-box['y'])*page.height+.75
        for k in c.text:
            if not k.isspace():
                if inside:selected.append(position)
                position+=1
    if not selected or selected[0] not in mapping or selected[-1] not in mapping:return None
    matches=[mapping[i]for i in selected if i in mapping]
    if len(matches)<.75*len(selected):return None
    start=offsets[min(matches)];end=offsets[max(matches)]+1
    if start>=end:return None
    return dict(start=start,end=end,mathml=recovered.mathml.replace('display="block"','display="inline"'),
                sourceBox=box,sourceText=recovered.text,sourceGlyphCount=recovered.glyph_count)


def _interior_fragment(paragraph_box, fragment_box):
    if paragraph_box.get('page') != fragment_box.get('page'):
        return False
    center=fragment_box['y']+fragment_box['height']/2
    return (paragraph_box['x']<fragment_box['x']
            and fragment_box['x']+fragment_box['width']<paragraph_box['x']+paragraph_box['width']
            and paragraph_box['y']<=center<=paragraph_box['y']+paragraph_box['height']
            and 0<fragment_box['height']<=2*paragraph_box['height']
            and 0<fragment_box['width']<.8*paragraph_box['width'])


def _atomic_runs(runs, recovered):
    """Keep enclosing annotations and discard only interior style fragments."""
    start,end=recovered['start'],recovered['end']
    kept=[];exists=False
    style_keys={'start','end','bold','italic','verticalAlign','compactMathAtom'}
    for run in runs:
        left,right=run.get('start',-1),run.get('end',-1)
        if not isinstance(left,int) or not isinstance(right,int) or left<0 or right<left:
            return None
        if right<=start or left>=end:
            kept.append(run);continue
        if any(run.get(key) for key in ('semanticRole','relationshipId','targetIds')):
            return None
        if run.get('mathml'):
            if left==start and right==end and run['mathml']==recovered['mathml']:
                exists=True;kept.append(run);continue
            return None
        if left<=start and right>=end:
            kept.append(run);continue
        # Link/annotation spans cannot be clipped or deleted to make room.
        if run.get('href') or run.get('annotationId'):
            return None
        if start<=left and right<=end and set(run)<=style_keys:
            continue
        return None
    if not exists:
        kept.append({key:recovered[key] for key in ('start','end','mathml')})
    return sorted(kept,key=lambda run:(run['start'],run['end'])),not exists


def _references(value, identifier):
    """Conservative graph references, excluding source provenance and own IDs."""
    if isinstance(value,dict):
        return any(_references(child,identifier) for key,child in value.items()
                   if key not in {'id','evidence','sourceObjectIds','sourceIds'})
    if isinstance(value,(list,tuple)):
        return any(_references(child,identifier) for child in value)
    return value==identifier or value=='#'+identifier if isinstance(value,str) else False


def _fragment_referenced(adapter, fragment):
    identifier=fragment['id']
    # Relationships carry meaning even when no inline run currently uses them.
    # Refuse absorption rather than erase or invent a replacement endpoint.
    if any(_references(relation,identifier) for relation in getattr(adapter,'relationships',[])):
        return True
    return any(block is not fragment and _references(block,identifier) for block in adapter.blocks)


def recover_inline_equations(adapter):
    """Absorb uniquely proved interior equation fragments into paragraph atoms.

    Run before UTF-16 offset conversion and graph compaction. The paragraph's
    text is unchanged; only its atomic MathML run replaces the source span at
    render time. Referenced fragments, ambiguous hosts and crossed annotations
    remain untouched. Returns the number of successfully absorbed fragments.
    """
    count=0
    for fragment in list(adapter.blocks):
        if fragment.get('kind')!='equation' or fragment not in adapter.blocks:
            continue
        boxes=fragment.get('evidence',{}).get('boxes',[])
        if len(boxes)!=1 or fragment.get('inline') or _fragment_referenced(adapter,fragment):
            continue
        box=boxes[0];page=adapter._page_text(box.get('page'))
        if page is None:
            continue
        candidates={}
        for paragraph in adapter.blocks:
            if paragraph.get('kind')!='paragraph':
                continue
            text=paragraph.get('text','')
            for paragraph_box in paragraph.get('evidence',{}).get('boxes',[]):
                if not _interior_fragment(paragraph_box,box):
                    continue
                recovered=recover_inline_equation(page,paragraph_box,box,text)
                if recovered is None or not 0<recovered['start']<recovered['end']<len(text):
                    continue
                signature=(paragraph['id'],recovered['start'],recovered['end'],recovered['mathml'])
                candidates[signature]=(paragraph,recovered)
        # Do not pick the first matching paragraph when source ownership is
        # duplicated or two different text spans are equally plausible.
        if len(candidates)!=1:
            continue
        paragraph,recovered=next(iter(candidates.values()))
        prepared=_atomic_runs(paragraph.get('inline',[]),recovered)
        if prepared is None:
            continue
        runs,inserted=prepared
        evidence=paragraph.setdefault('evidence',{})
        source_evidence=fragment.get('evidence',{})
        for key in ('pages','sourceIds','signals'):
            evidence[key]=list(dict.fromkeys(evidence.get(key,[])+source_evidence.get(key,[])))
        evidence['signals']=list(dict.fromkeys(evidence.get('signals',[])+['source-inline-equation-reconstruction']))
        evidence['boxes']=list(evidence.get('boxes',[]))
        for source_box in source_evidence.get('boxes',[])+[recovered['sourceBox']]:
            if source_box not in evidence['boxes']:
                evidence['boxes'].append(dict(source_box))
        paragraph['inline']=runs
        adapter.blocks.remove(fragment)
        # Only fragment-owned assets with no surviving graph references can
        # disappear. Shared assets and all relationships remain intact.
        candidate_assets=set(fragment.get('fallbackAssetIds',[]))
        if candidate_assets and hasattr(adapter,'assets'):
            adapter.assets=[asset for asset in adapter.assets
                            if asset['id'] not in candidate_assets
                            or any(_references(block,asset['id']) for block in adapter.blocks)
                            or any(_references(relation,asset['id']) for relation in getattr(adapter,'relationships',[]))
                            or any(other is not asset and _references(other,asset['id']) for other in adapter.assets)]
        # Retain the diagnostic ID and source attribution while recording that
        # the formerly incomplete standalone fragment now has a proved owner.
        source_ids=set(source_evidence.get('sourceIds',[]))
        for diagnostic in getattr(adapter,'diagnostics',[]):
            diagnostic_sources=set(diagnostic.get('sourceIds',[]))
            if (diagnostic.get('title')=='Equation structure unavailable'
                    and diagnostic_sources and diagnostic_sources<=source_ids):
                diagnostic.update(severity='info',title='Equation recovered inline',
                                  message=f"Source formula fragment reconstructed from {recovered['sourceGlyphCount']} glyphs in paragraph {paragraph['id']}; the original paragraph text is retained.")
        report=getattr(adapter,'report',None)
        old_field=('formulas_mathml' if fragment.get('attributes',{}).get('mathml')
                   else 'formulas_image' if fragment.get('fallbackAssetIds') else 'formulas_text')
        if report is not None and hasattr(report,old_field):
            setattr(report,old_field,max(0,getattr(report,old_field)-1))
        if inserted and report is not None and hasattr(report,'formulas_mathml'):
            report.formulas_mathml+=1
        count+=1
    return count
