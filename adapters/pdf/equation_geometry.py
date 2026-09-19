"""Geometry primitives for deterministic PDF equation reconstruction."""
from dataclasses import dataclass
from html import escape
import re
import statistics
import unicodedata


@dataclass
class Atom:
    text: str
    l: float
    b: float
    r: float
    t: float
    font: str
    em: float | None = None
    xml: str | None = None
    anchor: float | None = None
    count: int = 1
    extension: bool = False

    @property
    def cy(self): return self.anchor if self.anchor is not None else (self.b+self.t)/2
    @property
    def cx(self): return (self.l+self.r)/2
    @property
    def height(self): return self.t-self.b


def family(font):
    return font.split('+')[-1]


def nominal(char):
    match=re.search(r'(?:Roman|Italic|Symbols|CMMI[B]?|CMBX|CMSY|CMR|MSAM|MSBM)(\d+)',family(char.font),re.I)
    return float(match.group(1)) if match else None


# A face must be measured this many times, by this many separate neighbouring
# faces, and agree with itself this closely, before its heights read as sizes.
SCALE_SAMPLES=8
SCALE_NEIGHBOURS=1
SCALE_TOLERANCE=.02
# Two faces set at one size have comparable box heights; a script is 70% or
# 50% of its base. The band separates the two without assuming either ratio.
SCALE_HEIGHT_BAND=.8


def font_scales(page_text):
    """Points per unit of glyph-box height, for faces that do not name a size.

    docling-parse reports one box height per face and size, so inside one face
    the height is exactly proportional to the point size; only the constant
    differs, and it belongs to the font program, not to the page. Two glyphs
    set side by side on one baseline are set at one size, so a neighbour whose
    name does state its size (`CMR10`) measures the face beside it.

    A `mathptmx` or `newtx` document sets an equation's upright text, and its
    tag, in the document text face, whose name carries no size at all. Without
    a size for those glyphs no script in the expression can be separated from
    its base, and the whole equation falls back to a picture.

    Only a face several independent neighbours agree on is calibrated. One
    measured rarely, or inconsistently, stays unsized and keeps its equations'
    honest fallback rather than receiving a guessed scale.
    """
    cached=getattr(page_text,'_equation_font_scales',None)
    if cached is None:
        cached=_measure_font_scales(page_text)
        try:page_text._equation_font_scales=cached
        except AttributeError:pass
    return cached


def _measure_font_scales(page_text):
    samples={}
    for line in getattr(page_text,'lines',None) or []:
        chars=sorted([c for c in line.chars if c.text.strip()],key=lambda c:c.l)
        for left,right in zip(chars,chars[1:]):
            heights=(left.t-left.b,right.t-right.b)
            if min(heights)<=0:continue
            near=min(heights)
            # Side by side, and on one baseline. A raised or lowered glyph is
            # a script set at another size and measures nothing.
            if right.l-left.r>.5*near or abs(left.b-right.b)>.08*near:continue
            # A box bottom sits a face's own descender below the baseline, so
            # a subscript of a shallow face can share a box bottom with the
            # base beside it. Comparable box heights separate the two.
            if near<SCALE_HEIGHT_BAND*max(heights):continue
            for char,other,height in ((left,right,heights[0]),(right,left,heights[1])):
                size=nominal(other)
                if size is None or nominal(char) is not None:continue
                if family(char.font)==family(other.font):continue
                samples.setdefault(family(char.font),[]).append((size/height,family(other.font)))
    scales={}
    for name,measured in samples.items():
        values=[value for value,_ in measured]
        if len(values)<SCALE_SAMPLES or len({neighbour for _,neighbour in measured})<SCALE_NEIGHBOURS:continue
        scale=statistics.median(values)
        if scale<=0:continue
        # One face at one size has one height: a real measurement repeats.
        if sum(1 for value in values if abs(value-scale)<=SCALE_TOLERANCE*scale)<.9*len(values):continue
        scales[name]=scale
    return scales


def atom(char,scales=None):
    em=nominal(char)
    if em is None and scales:
        scale=scales.get(family(char.font))
        if scale:em=scale*(char.t-char.b)
    return Atom(char.text,char.l,char.b,char.r,char.t,char.font,em,
                extension=bool(re.search(r'Extension|CMEX',char.font,re.I)))


def composite(members, text, xml, *, anchor=None, em=None, extension=False):
    return Atom(text,min(c.l for c in members),min(c.b for c in members),
                max(c.r for c in members),max(c.t for c in members),'',em,
                xml,anchor,sum(c.count for c in members),extension)


ACCENTS={'˜':'~','̂':'^','̃':'~','̄':'¯','̇':'˙','̈':'¨'}
# TeX sets an accent by overprinting: `\bar{a}` kerns back and puts the bar
# glyph in the same advance slot as the `a` beneath it, so the two boxes very
# nearly coincide. These accent characters are ordinary spacing glyphs that
# also stand on their own -- a circumflex, a tilde between two operands -- and
# only that overprint tells the two apart. Without it the accent reads as a
# base of its own and takes the scripts of the letter it sits on, which
# silently rewrites `\bar{a}_s` as `¯_s a`.
OVERPRINTED={'¯':'¯','ˉ':'¯','ˆ':'^','^':'^','~':'~','˙':'˙','¨':'¨'}
OVERPRINT_SHARE=.6
ACCENT_RISE=.45


def accent_atoms(atoms, token):
    atoms=list(atoms)
    for mark in list(atoms):
        overprint=mark.text not in ACCENTS and mark.text in OVERPRINTED
        label=ACCENTS.get(mark.text) or (OVERPRINTED[mark.text] if overprint else None)
        if label is None:continue
        candidates=[c for c in atoms if c is not mark and not any(unicodedata.combining(k) for k in c.text)
                    and c.l-1 <= mark.cx <= c.r+1 and abs(c.cy-mark.cy)<max(c.em or 12,12)]
        if overprint:
            # TeX lifts an accent clear of a tall base (`J̄` above `ā`), so the
            # mark sits at or above its base's box and never below it, at the
            # base's own size: a script beneath one is neither.
            candidates=[c for c in candidates if c.text not in ACCENTS and c.text not in OVERPRINTED
                        and min(c.r,mark.r)-max(c.l,mark.l) > OVERPRINT_SHARE*min(c.r-c.l,mark.r-mark.l)
                        and -.06*(c.t-c.b) <= mark.b-c.b <= ACCENT_RISE*(c.t-c.b)
                        and min(c.t-c.b,mark.t-mark.b) >= .8*max(c.t-c.b,mark.t-mark.b)]
            # a spacing accent printed on nothing of its own size is an operator
            if not candidates:continue
        elif not candidates: raise ValueError('accent has no source-supported base')
        base=min(candidates,key=lambda c:abs(c.cx-mark.cx))
        xml='<mover accent="true">'+token(base)+'<mo>'+escape(label)+'</mo></mover>'
        node=composite([base,mark],'\\'+{'^':'hat','~':'tilde','¯':'bar','˙':'dot','¨':'ddot'}[label]+'{'+base.text+'}',xml,anchor=base.cy,em=base.em)
        atoms.remove(mark);atoms[atoms.index(base)]=node
    return atoms


# Adobe Symbol extension glyphs, as emitted by docling-parse. Piece identities
# are retained in count; only a complete vertical assembly becomes a delimiter.
PIECES={
    '\uf8eb':('(', 'top'),'\uf8ec':('(', 'middle'),'\uf8ed':('(', 'bottom'),
    '\uf8f6':(')', 'top'),'\uf8f7':(')', 'middle'),'\uf8f8':(')', 'bottom'),
    '\uf8ee':('[', 'top'),'\uf8ef':('[', 'middle'),'\uf8f0':('[', 'bottom'),
    '\uf8f9':(']', 'top'),'\uf8fa':(']', 'middle'),'\uf8fb':(']', 'bottom'),
    '\uf8f1':('{', 'top'),'\uf8f2':('{', 'middle'),'\uf8f3':('{', 'bottom'),
    '\uf8fc':('}', 'top'),'\uf8fd':('}', 'middle'),'\uf8fe':('}', 'bottom'),
}


def delimiter_atoms(atoms):
    atoms=list(atoms)
    for char in list(atoms):
        if char not in atoms or char.text not in PIECES:continue
        delim=PIECES[char.text][0]
        members=[c for c in atoms if c.text in PIECES and PIECES[c.text][0]==delim and abs(c.l-char.l)<1.5]
        roles={PIECES[c.text][1] for c in members}
        if not {'top','bottom'} <= roles:raise ValueError('incomplete assembled source delimiter')
        node=composite(members,delim,'<mo stretchy="true">'+delim+'</mo>',extension=True)
        atoms=[c for c in atoms if c not in members]+[node]
    # Extensible brace middle bars use U+F8F4, shared between left/right.
    for char in list(atoms):
        if char.text=='\uf8f4':
            candidates=[c for c in atoms if c.extension and c.text in '{}' and abs(c.l-char.l)<2]
            if len(candidates)!=1: raise ValueError('brace extender has no complete delimiter')
            base=candidates[0];base.count+=char.count;base.b=min(base.b,char.b);base.t=max(base.t,char.t);atoms.remove(char)
    for symbol in ('∥','∣','|'):
        for char in list(atoms):
            if char not in atoms or char.text!=symbol or not char.extension:continue
            column=sorted([c for c in atoms if c.extension and c.text==symbol
                           and c.font==char.font and abs(c.l-char.l)<.5],key=lambda c:c.b)
            groups=[]
            for member in column:
                if (not groups or member.b-max(c.t for c in groups[-1])
                        >max(.6,.12*min(member.height,min(c.height for c in groups[-1])))):
                    groups.append([member])
                else:groups[-1].append(member)
            members=next(group for group in groups if char in group)
            if len(members)>1:
                node=composite(members,symbol,'<mo stretchy="true">'+symbol+'</mo>',extension=True)
                atoms=[c for c in atoms if c not in members]+[node]
    return atoms


def fraction_atoms(atoms,bars,sequence):
    """Collapse nested fractions from shortest rule to containing rule."""
    atoms=list(atoms)
    for left,right,y in sorted(bars,key=lambda b:b[1]-b[0]):
        lower,upper=-float('inf'),float('inf')
        for l,r,other_y in bars:
            if l<=left+.5 and r>=right-.5 and r-l>right-left+.5:
                if other_y>y:upper=min(upper,other_y)
                elif other_y<y:lower=max(lower,other_y)
        members=[c for c in atoms if left-.75<=c.cx<=right+.75 and lower<c.cy<upper
                 and c.l>=left-1.5 and c.r<=right+1.5]
        def nearest_band(side):
            ordered=sorted(side,key=lambda c:abs(c.cy-y))
            kept=[];last=y
            scale=max(c.em or 0 for c in side) if side else 12
            for c in ordered:
                if kept and abs(c.cy-last)>.8*scale:break
                kept.append(c);last=c.cy
            return kept
        numerator=nearest_band([c for c in members if c.cy>y])
        denominator=nearest_band([c for c in members if c.cy<y])
        members=numerator+denominator
        if not numerator or not denominator:raise ValueError('fraction rule has no complete numerator and denominator')
        n,nt=sequence(numerator);d,dt=sequence(denominator)
        em=max(c.em or 0 for c in members) or None
        node=composite(members,'\\frac{'+nt+'}{'+dt+'}','<mfrac>'+n+d+'</mfrac>',anchor=y,em=em)
        node.l=min(node.l,left);node.r=max(node.r,right)
        atoms=[c for c in atoms if c not in members]+[node]
    return atoms


def radical_atoms(atoms,bars,sequence):
    atoms=list(atoms);bars=list(bars)
    for root in [c for c in atoms if c.text=='√']:
        matches=[b for b in bars if abs(b[0]-root.r)<1.5 and root.b-1<=b[2]<=root.t+1]
        if len(matches)!=1:raise ValueError('radical has no unambiguous source vinculum')
        bar=matches[0];left,right,y=bar
        # The vinculum bounds the radicand horizontally. Other enclosing
        # fraction bars supply its vertical boundary when present.
        lower=max([b[2] for b in bars if b[0]<=left and b[1]>=right and b[2]<y] or [-float('inf')])
        members=[c for c in atoms if c is not root and left-.75<=c.cx<=right+.75 and lower<c.cy<y]
        if not members:raise ValueError('radical has no complete radicand')
        xml,text=sequence(members)
        node=composite([root]+members,'\\sqrt{'+text+'}','<msqrt>'+xml+'</msqrt>',
                       anchor=statistics.median(c.cy for c in members),em=max(c.em or 0 for c in members) or None)
        atoms=[c for c in atoms if c not in members and c is not root]+[node];bars.remove(bar)
    return atoms,bars


def operator_atoms(atoms,sequence,token):
    """Join upright function names and attach centered source limits."""
    atoms=list(atoms)
    main=max(c.em or 0 for c in atoms)
    body=[c for c in atoms if not c.extension and (c.em or 0)>=.8*main]
    if not body:return atoms
    baseline=statistics.median(c.cy for c in body)
    names={'argmin','argmax','sup','lim','min','max','log','logit','Cov','in','where','Model','val'}
    chars=sorted([c for c in atoms if len(c.text)==1 and c.text.isalpha()
                  and ('Roman' in c.font or re.search(r'CMR\d', c.font)) and 'Bold' not in c.font],key=lambda c:c.l)
    for i,start in enumerate(chars):
        if start not in atoms:continue
        members=[];word='';best=None
        for char in chars[i:]:
            if char not in atoms or (members and (char.l-members[-1].r>.45*main or abs(char.cy-start.cy)>.2*main)):break
            members.append(char);word+=char.text
            if word in names:best=(list(members),word)
            if not any(name.startswith(word) for name in names):break
        if best:
            members,word=best
            label='arg min' if word=='argmin' else 'arg max' if word=='argmax' else word
            if word in {'where','Model','in'}:
                text=word+' ';xml='<mtext>'+text+'</mtext>'
            else:
                text=word;xml='<mo movablelimits="true">'+label+'</mo>'
            node=composite(members,text,xml,anchor=start.cy,em=start.em)
            atoms=[c for c in atoms if c not in members]+[node]
    operators=[c for c in atoms if c.text in {'∑','∏','∫','sup','lim','min','max','argmin','argmax','→','⇝','⟶','⟵'}]
    for op in operators:
        if op not in atoms:continue
        groups={}
        for direction in ('under','over'):
            candidates=[c for c in atoms if c is not op and (c.em or main)<.8*main
                        and ((c.cy<baseline-.45*main) if direction=='under' else (c.cy>baseline+.40*main))]
            candidates.sort(key=lambda c:c.l)
            clusters=[]
            for char in candidates:
                if (not clusters or char.l-max(c.r for c in clusters[-1])>.55*main
                        or abs(char.cy-statistics.median(c.cy for c in clusters[-1]))>.6*main):
                    clusters.append([char])
                else:clusters[-1].append(char)
            matching=[g for g in clusters if min(c.l for c in g)<=op.cx<=max(c.r for c in g)]
            if len(matching)>1:raise ValueError('operator has ambiguous source limit rows')
            if matching:groups[direction]=matching[0]
        # Upright ordinary operators without centered limits remain ordinary.
        if not groups:
            if op.text in {'∑','∏','∫'}:
                op.xml='<mo largeop="true">'+op.text+'</mo>';op.em=main;op.anchor=baseline;op.extension=False
            continue
        under=sequence(groups['under']) if 'under' in groups else None
        over=sequence(groups['over']) if 'over' in groups else None
        xml=token(op)
        if under and over:xml='<munderover>'+xml+under[0]+over[0]+'</munderover>'
        elif under:xml='<munder>'+xml+under[0]+'</munder>'
        else:xml='<mover>'+xml+over[0]+'</mover>'
        text=op.text+('_{'+under[1]+'}' if under else '')+('^{'+over[1]+'}' if over else '')
        members=[op]+sum(groups.values(),[])
        node=composite(members,text,xml,anchor=baseline,em=main)
        atoms=[c for c in atoms if c not in members]+[node]
    return atoms


def display_rows(atoms):
    """Split separated full expression baselines after fractions collapse."""
    main=max(c.em or 0 for c in atoms)
    body=sorted([c for c in atoms if not c.extension and (c.em or 0)>=.8*main],key=lambda c:c.cy,reverse=True)
    groups=[]
    for char in body:
        if not groups or groups[-1][-1].cy-char.cy>.8*main:groups.append([char])
        else:groups[-1].append(char)
    if len(groups)<=1:return [atoms]
    # A pair of isolated glyphs could be an unparsed fraction. Separate rows
    # require independently meaningful source expressions on both baselines.
    if any(len(g)<4 for g in groups):raise ValueError('multiple expression baselines require structural recovery')
    centers=[statistics.median(c.cy for c in g) for g in groups]
    rows=[[]for _ in groups]
    for char in atoms:
        rows[min(range(len(centers)),key=lambda n:abs(char.cy-centers[n]))].append(char)
    return rows


def arrow_atoms(atoms):
    """Join overlapping TeX dash/arrow glyphs into one long-arrow operator."""
    result=list(atoms)
    for arrow in list(result):
        if arrow not in result or arrow.text not in {'→','←'}:continue
        # TeX extends a long arrow by overprinting a same-font minus and
        # arrow at one baseline. A real preceding minus has disjoint boxes;
        # an overlap must exceed coordinate-rounding noise and lie along the
        # arrow's shaft, with matching font/size and vertical metrics.
        stems=[c for c in result if c is not arrow and c.text in {'-','−'}
               and c.font==arrow.font and c.em==arrow.em
               and min(c.r,arrow.r)-max(c.l,arrow.l)>.75
               and (c.l<arrow.l<c.r<arrow.r if arrow.text=='→' else arrow.l<c.l<arrow.r<c.r)
               and abs(c.b-arrow.b)<.35 and abs(c.t-arrow.t)<.35]
        if len(stems)!=1:continue
        stem=stems[0];symbol='⟶'if arrow.text=='→'else'⟵'
        node=composite([stem,arrow],symbol,'<mo>'+symbol+'</mo>',anchor=arrow.cy,em=arrow.em or stem.em)
        result=[c for c in result if c is not stem and c is not arrow]+[node]
    return result
