"""Recover additional note blocks from source-separated small-type regions.

The adapter's flat blocks remain intact. A marked note owns ordered child IDs;
source typography and a printed separator, rather than reading-order proximity,
establish the region. Cross-page continuations additionally require an open
sentence at the previous page foot and matching source typography/column.
"""
from __future__ import annotations

import re
from statistics import median
from pdf_text import Rule, classify_font


def _mask_rules(operations, width, height):
    """Thin painted inline-image masks are separators in some PDF producers."""
    matrix=(1.,0.,0.,1.,0.,0.); stack=[]; rules=[]
    for values, op in operations:
        if op == b'q': stack.append(matrix)
        elif op == b'Q': matrix=stack.pop() if stack else (1.,0.,0.,1.,0.,0.)
        elif op == b'cm' and len(values)==6:
            a,b,c,d,e,f=matrix; A,B,C,D,E,F=map(float,values)
            matrix=(a*A+c*B,b*A+d*B,a*C+c*D,b*C+d*D,a*E+c*F+e,b*E+d*F+f)
        elif op == b'INLINE IMAGE':
            settings=values.get('settings',{})
            if not settings.get('/IM') or settings.get('/W')!=1 or settings.get('/H')!=1 or values.get('data')!=b'\x00' or settings.get('/D',[0,1])!=[0,1]: continue
            a,b,c,d,e,f=matrix
            if abs(b)>.01 or abs(c)>.01 or not .08*width<=abs(a)<=.5*width or not 0<abs(d)<=1.5: continue
            rules.append(Rule(min(e,e+a)/width,1-max(f,f+d)/height,max(e,e+a)/width,1-max(f,f+d)/height,abs(d)))
    return rules


def _rules(adapter, page_no, page):
    result=list(page.rules)
    if not adapter.pdf_path.is_file(): return result
    if not hasattr(adapter,'_note_rule_reader'):
        try:
            from pypdf import PdfReader
            adapter._note_rule_reader=PdfReader(adapter.pdf_path)
        except Exception: adapter._note_rule_reader=None  # malformed/unreadable source: no inferred separator
    reader=adapter._note_rule_reader
    if reader is not None and 0<page_no<=len(reader.pages):
        content=reader.pages[page_no-1].get_contents()
        if content is not None: result.extend(_mask_rules(content.operations,page.width,page.height))
    return result


def _box(block,page_no):
    boxes=[b for b in block['evidence']['boxes'] if b['page']==page_no]
    if not boxes: return None
    return dict(page=page_no,x=min(b['x'] for b in boxes),y=min(b['y'] for b in boxes),width=max(b['x']+b['width'] for b in boxes)-min(b['x'] for b in boxes),height=max(b['y']+b['height'] for b in boxes)-min(b['y'] for b in boxes))


def _font(page,box):
    sizes=[c.height for c in page.chars if c.text.isalpha() and not classify_font(c.font)['math'] and box['x']-.002<=c.cx/page.width<=box['x']+box['width']+.002 and box['y']-.002<=1-c.cy/page.height<=box['y']+box['height']+.002]
    return median(sizes) if sizes else None


def _line_box(page,line,page_no):
    return dict(page=page_no,x=line.l/page.width,y=1-line.t/page.height,width=(line.r-line.l)/page.width,height=(line.t-line.b)/page.height,rotation=0)


def _same_column(box,left,right):
    return box['x']>=left-.025 and box['x']+box['width']<=right+.025


def _body_font(page,rule,left,right):
    heights=[line.height for line in page.lines if len(line.text.split())>=6 and .08<1-line.t/page.height<rule.y0-.015 and line.l/page.width>=left-.025 and line.r/page.width<=right+.025]
    return median(heights) if heights else None


def _compact(text): return re.sub(r'\W','',text).casefold()


def _merge_evidence(target,addition):
    for name in ('pages','sourceIds','signals'):
        target.setdefault(name,[])
        for value in addition.get(name,[]):
            if value not in target[name]: target[name].append(value)
    target['pages'].sort()
    target.setdefault('boxes',[]).extend(addition.get('boxes',[]))


def recover_note_bodies(adapter):
    """Populate noteBodyBlockIds; call after source/equation recovery and joins.

    Run before compact/prune/place_notes so surviving source blocks, including
    newly recovered lines, participate in the normal graph validation.
    """
    owners={child for b in adapter.blocks for child in b.get('noteBodyBlockIds',[])}
    linked={target for rel in adapter.relationships if rel['kind']=='footnote' for target in rel['to']}
    for note in list(adapter.blocks):
        if note['kind']!='footnote' or not note.get('label') or note['id'] not in linked or note.get('noteBodyBlockIds'): continue
        page_no=note['page']; page=adapter._page_text(page_no); start=_box(note,page_no)
        if page is None or start is None: continue
        note_font=_font(page,start)
        if not note_font: continue
        separators=[r for r in _rules(adapter,page_no,page) if r.horizontal and .08<=r.length<=.5 and -.003<=start['y']-r.y0<=.02 and r.x0-.005<=start['x']<=r.x0+.06]
        if not separators: continue
        rule=max(separators,key=lambda r:r.y0); left=rule.x0; right=start['x']+start['width']
        body_font=_body_font(page,rule,left,right)
        if not body_font or not .55*body_font<=note_font<=.9*body_font: continue
        children=[]; recovered=[]; stop=1.; current=page_no
        while True:
            page=adapter._page_text(current)
            ordered=[]
            for b in adapter.blocks:
                if b is note or b['id'] in owners or b['kind']=='furniture': continue
                bx=_box(b,current)
                if bx is None or not _same_column(bx,left,right) or bx['y']<rule.y0-.003: continue
                ordered.append((bx['y'],bx['x'],b,bx))
            ordered.sort(key=lambda x:(x[0],x[1]))
            stop=1.
            selected=[]
            for _,__,b,bx in ordered:
                font=_font(page,bx)
                if b.get('label') and b['kind'] in ('footnote','endnote') or b['kind']=='heading' or (b['kind']!='equation' and font and font>note_font*1.12):
                    stop=bx['y']; break
                if b['kind'] not in ('paragraph','list-item','equation','code','quote','footnote') or (b['kind']!='equation' and font and not .7*note_font<=font<=1.12*note_font): continue
                # A block straddling the separator has ordinary body content.
                if any(bx2['page']!=current or bx2['y']<rule.y0-.003 for bx2 in b['evidence']['boxes']): continue
                if b['kind']!='equation' and font is None: continue
                selected.append(b)
            if stop < 1.:
                selected=[b for b in selected if (bx:=_box(b,current))['y']+bx['height']<=stop+.003]
            existing_text=[_compact(b['text']) for b in adapter.blocks if current in b['evidence'].get('pages',[])]
            for index,line in enumerate(page.lines):
                bx=_line_box(page,line,current)
                if not rule.y0<=bx['y']<min(stop,.95) or not _same_column(bx,left,right) or len(line.text.split())<6 or len(re.findall(r'[A-Za-z]',line.text))<25 or not .93*note_font<=line.height<=1.1*note_font: continue
                if any(_compact(line.text) in text for text in existing_text): continue
                cx=bx['x']+bx['width']/2; cy=bx['y']+bx['height']/2
                if any(b['kind']!='equation' and (eb:=_box(b,current)) and eb['x']-.003<=cx<=eb['x']+eb['width']+.003 and eb['y']-.003<=cy<=eb['y']+eb['height']+.003 for b in adapter.blocks): continue
                ident=adapter._id(f'note-source-p{current}-line{index}')
                fresh=dict(id=ident,kind='paragraph',text=line.text.strip(),page=current,order=0,column='single',inline=[],evidence=dict(confidence=1.,pages=[current],boxes=[bx],sourceIds=[f'pdf-page-{current}-line-{index}'],signals=['source-note-body','source-text-line']))
                adapter.blocks.append(fresh);selected.append(fresh);recovered.append(fresh)
                if hasattr(adapter.report,'paragraphs'): adapter.report.paragraphs+=1
                if hasattr(adapter.report,'regions_recovered_from_text_layer'): adapter.report.regions_recovered_from_text_layer+=1
            selected.sort(key=lambda b:(_box(b,current)['y'],_box(b,current)['x']))
            children.extend(b for b in selected if b not in children)
            if stop<1. or not children: break
            tail=children[-1]; tail_box=_box(tail,current)
            if tail_box is None or tail_box['y']<.85 or re.search(r'[.!?][\"”’)]*$',tail['text'].rstrip()): break
            following=adapter._page_text(current+1)
            if following is None: break
            possible=[]
            for candidate in adapter.blocks:
                cb=_box(candidate,current+1)
                if candidate.get('label') or candidate['kind'] not in ('footnote','paragraph') or cb is None or cb['y']<.8 or not _same_column(cb,left,right) or not re.match(r'[a-z]',candidate['text'].lstrip()): continue
                font=_font(following,cb)
                if font is None or abs(font/note_font-1)>.1: continue
                separators=[r for r in _rules(adapter,current+1,following) if r.horizontal and .08<=r.length<=.5 and abs(r.x0-left)<.015 and -.003<=cb['y']-r.y0<=.02]
                if not separators: continue
                nr=max(separators,key=lambda r:r.y0)
                following_body=_body_font(following,nr,left,right)
                if following_body and font<=.9*following_body: possible.append((cb['y'],candidate,nr))
            if not possible: break
            _,continuation,rule=min(possible,key=lambda c:c[0])
            if continuation['kind']=='footnote':
                continuation['kind']='paragraph'
                if hasattr(adapter.report,'paragraphs'): adapter.report.paragraphs+=1
                source_ids=set(continuation['evidence']['sourceIds'])
                removed=[d for d in adapter.diagnostics if d.get('category')=='notes' and source_ids.intersection(d.get('sourceIds',[]))]
                adapter.diagnostics[:]=[d for d in adapter.diagnostics if d not in removed]
                adapter.report.footnotes=max(0,adapter.report.footnotes-1)
                adapter.report.footnotes_unlinked=max(0,adapter.report.footnotes_unlinked-len(removed))
                adapter._notes[:]=[(b,m,i) for b,m,i in adapter._notes if b is not continuation]
            continuation['evidence'].setdefault('signals',[]).append('source-note-continuation')
            if tail in recovered:
                prefix=tail['text'].rstrip()+' '
                continuation['text']=prefix+continuation['text'].lstrip()
                for run in continuation['inline']: run['start']+=len(prefix);run['end']+=len(prefix)
                _merge_evidence(continuation['evidence'],tail['evidence'])
                adapter.blocks.remove(tail);children.remove(tail);recovered.remove(tail)
                if hasattr(adapter.report,'paragraphs'): adapter.report.paragraphs-=1
                children.append(continuation)
            current+=1
        if children:
            # Footnote children are prohibited by the source-neutral contract.
            children=[b for b in children if b['kind'] not in ('footnote','endnote')]
            if children:
                note['noteBodyBlockIds']=[b['id'] for b in children]
                note['evidence'].setdefault('signals',[]).append('source-note-body')
                owners.update(note['noteBodyBlockIds'])
