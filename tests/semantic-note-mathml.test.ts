import { strFromU8, unzipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { decodeStructDocument, encodeStructDocument } from '../src/document/index'
import { buildStructEpub } from '../src/renderers/epub'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import { evidence, seal, validDocument } from './codec-fixtures'

const ns = 'http://www.w3.org/1998/Math/MathML'
const fraction = `<math xmlns="${ns}"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>`
const radical = `<math xmlns="${ns}"><msqrt><mi>x</mi></msqrt></math>`

function block(id: string, kind: string, text: string, page = 1): any {
  return { id, kind, text, page, order: 0, column: 'single', inline: [], evidence: { ...evidence(), pages: [page], boxes: [] } }
}

function documentWith(blocks: any[], relationships: any[] = []): any {
  const document: any = validDocument()
  document.schemaVersion = '0.2.0'
  document.documentId = 'semantic-extension-fixture'
  document.receipt.schemaVersion = '0.2.0'
  document.receipt.documentId = document.documentId
  document.metadata.authorNotes = []
  document.blocks = blocks.map((entry, order) => ({ ...entry, order }))
  document.assets = []
  document.relationships = relationships
  const pages = [...new Set(blocks.map(entry => entry.page))].sort((a, b) => a - b)
  document.source.pageCount = pages.length
  document.pages = pages.map(page => {
    const ids = blocks.filter(entry => entry.page === page).map(entry => entry.id)
    return { page, width: 600, height: 800, rotation: 0, blocks: ids, columns: [{ id: `column-${page}`, side: 'single', blockIds: ids }] }
  })
  const count = blocks.reduce((sum, entry) => sum + entry.text.length, 0)
  Object.assign(document.receipt, { blockCount: blocks.length, assetCount: 0, relationshipCount: relationships.length, textCharacterCount: count })
  Object.assign(document.receipt.conservation, {
    sourceNodeCount: blocks.length, accountedSourceNodeCount: blocks.length,
    sourceAssetCount: 0, accountedSourceAssetCount: 0, structAssetCount: 0,
    sourceRelationshipCount: relationships.length, accountedSourceRelationshipCount: relationships.length, structRelationshipCount: relationships.length,
    sourceTextCharacterCount: count, structTextCharacterCount: count, structBlockCount: blocks.length,
  })
  return seal(document)
}

function mathDocument(mathml = fraction, inline: any[] = []): any {
  return documentWith([{ ...block('prose', 'paragraph', 'Before a/b after.'), inline: [{ start: 7, end: 10, mathml }, ...inline] }])
}

function relationship(id: string, from: string, to: string, kind = 'footnote'): any {
  return { id, kind, from, to: [to], status: 'matched', confidence: 1, evidence: evidence() }
}

function mixedNote(): any {
  return documentWith([
    { ...block('main', 'paragraph', 'See note 1 and equation.'), inline: [
      { start: 9, end: 10, relationshipId: 'note-reference', semanticRole: 'note-reference' },
      { start: 15, end: 23, relationshipId: 'equation-reference', semanticRole: 'cross-reference' },
    ] },
    { ...block('note', 'footnote', 'Opening note prose.'), label: '1', noteBodyBlockIds: ['note-heading', 'early-prose', 'equation', 'list-a', 'list-b', 'table', 'code', 'late-prose'] },
    block('late-prose', 'paragraph', 'Final continuation.', 2),
    { ...block('equation', 'equation', 'a/b'), attributes: { mathml: fraction } },
    { ...block('note-heading', 'heading', 'Note-only heading'), attributes: { level: 2 } },
    { ...block('list-a', 'list-item', 'First list item'), attributes: { ordered: true, listId: 'note-list' } },
    { ...block('list-b', 'list-item', 'Second list item'), attributes: { ordered: true, listId: 'note-list' } },
    { ...block('table', 'table', 'sqrt(x)'), table: { rows: 1, columns: 1, semantic: 'verified', cells: [{ id: 'math-cell', text: 'sqrt(x)', row: 0, column: 0, rowSpan: 1, columnSpan: 1, headerScope: null, inline: [{ start: 0, end: 7, mathml: radical }], evidence: evidence() }] } },
    block('code', 'code', 'const value = 1;'),
    { ...block('early-prose', 'paragraph', 'Earlier explanation.'), sourceObservationAnchorIds: ['note-child-source-anchor'] },
    { ...block('main-heading', 'heading', 'Main heading', 2), attributes: { level: 2 } },
  ], [relationship('note-reference', 'main', 'note'), relationship('equation-reference', 'main', 'equation', 'cross-reference')])
}

function expectRejected(document: any) {
  seal(document)
  expect(() => decodeStructDocument(document)).toThrow()
}

describe('source-neutral semantic extension compatibility', () => {
  it('does not insert absent fields or change the receipt during a current-document round trip', () => {
    const document = documentWith([block('plain', 'paragraph', 'Unchanged plain prose.')])
    const decoded = decodeStructDocument(document)
    expect(encodeStructDocument(decoded)).toEqual(document)
    expect(decoded.blocks[0]).not.toHaveProperty('noteBodyBlockIds')
    expect(decoded.receipt.generatedSha256).toBe(document.receipt.generatedSha256)
  })

  it('round trips note ownership and literal MathML while conserving original text once', () => {
    const document = mixedNote()
    const decoded = decodeStructDocument(document)
    expect(encodeStructDocument(decoded)).toEqual(document)
    expect(decoded.receipt.textCharacterCount).toBe(document.blocks.reduce((sum: number, entry: any) => sum + entry.text.length, 0))
    expect(decoded.blocks.find(entry => entry.id === 'table')!.table!.cells[0]!.text).toBe('sqrt(x)')
  })

  it.each(['mathml', 'child order', 'owner'])('binds %s changes into the existing receipt', mode => {
    const document = mixedNote()
    const digest = document.receipt.generatedSha256
    if (mode === 'mathml') document.blocks.find((entry: any) => entry.id === 'table').table.cells[0].inline[0].mathml = fraction
    if (mode === 'child order') document.blocks[1].noteBodyBlockIds.reverse()
    if (mode === 'owner') {
      document.blocks[1].noteBodyBlockIds.pop()
      document.blocks.find((entry: any) => entry.id === 'main-heading').kind = 'endnote'
      document.blocks.find((entry: any) => entry.id === 'main-heading').noteBodyBlockIds = ['late-prose']
    }
    expect(() => decodeStructDocument(document)).toThrow()
    seal(document)
    expect(document.receipt.generatedSha256).not.toBe(digest)
    expect(() => decodeStructDocument(document)).not.toThrow()
  })

  it.each(['mathml', 'noteBodyBlockIds'])('rejects %s in frozen 0.1.0 documents', field => {
    const document = field === 'mathml' ? mathDocument() : documentWith([{ ...block('note', 'footnote', 'Note'), noteBodyBlockIds: ['child'] }, block('child', 'paragraph', 'Child')])
    document.schemaVersion = document.receipt.schemaVersion = '0.1.0'
    delete document.documentId
    delete document.receipt.documentId
    expectRejected(document)
  })
})

describe('ordered multipart note rendering', () => {
  it('emits all mixed children once inside one note in declared order, followed by the backlink', async () => {
    const document = mixedNote()
    const xhtml = renderPublicationXhtml(document)
    const note = xhtml.match(/<aside\b[^>]*id="note"[\s\S]*?<\/aside>/)?.[0]
    expect(note).toBeDefined()
    expect(xhtml.match(/<aside\b/g)).toHaveLength(1)
    let previous = note!.indexOf('Opening note prose.')
    for (const id of document.blocks[1].noteBodyBlockIds) {
      expect(xhtml.match(new RegExp(`\\sid="${id}"`, 'g'))).toHaveLength(1)
      const position = note!.indexOf(`id="${id}"`)
      expect(position).toBeGreaterThan(previous)
      previous = position
    }
    expect(note!.indexOf('class="note-backlink"')).toBeGreaterThan(previous)
    expect(note).toContain('href="#note-reference"')
    expect(note).toContain('<ol>')
    expect(note!.match(/<ol>/g)).toHaveLength(1)
    expect(note).toContain(radical)
    const cell = note!.match(/<td\b[^>]*>[\s\S]*?<\/td>/)![0]
    expect(cell).toContain(radical)
    expect(cell).not.toContain('sqrt(x)')
    expect(note).toContain('<figcaption>sqrt(x)</figcaption>')
    expect(note).toContain('id="note-child-source-anchor" class="visually-hidden source-observation-anchor"')
    expect(xhtml).toContain('href="#equation"')
    const ids = [...xhtml.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const match of xhtml.matchAll(/href="#([^"]+)"/g)) expect(ids).toContain(match[1])
    const entries = unzipSync((await buildStructEpub(document)).bytes)
    const content = strFromU8(entries['EPUB/content.xhtml']!)
    const navigation = strFromU8(entries['EPUB/nav.xhtml']!)
    expect(XMLValidator.validate(content)).toBe(true)
    expect(navigation).toContain('Main heading')
    expect(navigation).not.toContain('Note-only heading')
    expect(strFromU8(entries['EPUB/package.opf']!)).toContain('properties="mathml"')
  })

  it('allows an empty note opening and note-body references to another standalone note', () => {
    const document = documentWith([
      { ...block('first-note', 'footnote', ''), label: '1', noteBodyBlockIds: ['child'] },
      { ...block('child', 'paragraph', 'See 2'), inline: [{ start: 4, end: 5, relationshipId: 'nested-reference', semanticRole: 'note-reference' }] },
      { ...block('second-note', 'endnote', 'Second note.'), label: '2' },
    ], [relationship('nested-reference', 'child', 'second-note')])
    const xhtml = renderPublicationXhtml(document)
    expect(xhtml).toContain('id="nested-reference"')
    expect(xhtml).toContain('href="#nested-reference" class="note-backlink"')
    expect(xhtml.match(/<aside\b/g)).toHaveLength(2)
  })

  it('emits child references in declared order and preserves relationship order for backlinks', () => {
    const child = (id: string, referenceId: string) => ({ ...block(id, 'paragraph', 'See 2'), inline: [{ start: 4, end: 5, relationshipId: referenceId, semanticRole: 'note-reference' }] })
    const document = documentWith([
      { ...block('first-note', 'footnote', 'Opening'), noteBodyBlockIds: ['first-child', 'second-child'] },
      child('second-child', 'second-reference'),
      child('first-child', 'first-reference'),
      block('target-note', 'endnote', 'Target.'),
    ], [relationship('second-reference', 'second-child', 'target-note'), relationship('first-reference', 'first-child', 'target-note')])
    const xhtml = renderPublicationXhtml(document)
    const target = xhtml.match(/<aside\b[^>]*id="target-note"[\s\S]*?<\/aside>/)![0]
    expect(target.indexOf('href="#first-reference"')).toBeGreaterThan(-1)
    expect(target.indexOf('href="#second-reference"')).toBeGreaterThan(-1)
    expect(target.indexOf('href="#second-reference"')).toBeLessThan(target.indexOf('href="#first-reference"'))
    expect(xhtml.indexOf('id="first-reference"')).toBeLessThan(xhtml.indexOf('id="second-reference"'))
  })

  it.each(['empty', 'missing', 'duplicate', 'self', 'two owners', 'footnote child', 'endnote child', 'furniture child', 'non-note owner'])('rejects %s ownership', mode => {
    const document = documentWith([{ ...block('note', 'footnote', 'Note'), noteBodyBlockIds: ['child'] }, block('child', 'paragraph', 'Child'), block('second', 'endnote', 'Second')])
    if (mode === 'empty') document.blocks[0].noteBodyBlockIds = []
    if (mode === 'missing') document.blocks[0].noteBodyBlockIds = ['missing']
    if (mode === 'duplicate') document.blocks[0].noteBodyBlockIds = ['child', 'child']
    if (mode === 'self') document.blocks[0].noteBodyBlockIds = ['note']
    if (mode === 'two owners') document.blocks[2].noteBodyBlockIds = ['child']
    if (mode.endsWith(' child')) document.blocks[1].kind = mode.split(' ')[0]
    if (mode === 'non-note owner') document.blocks[0].kind = 'paragraph'
    expectRejected(document)
  })
})

describe('atomic inline presentation MathML', () => {
  it('replaces only fallback characters and preserves enclosing style and hyperlinks', () => {
    const document = mathDocument(fraction, [{ start: 0, end: 17, bold: true }, { start: 7, end: 10, href: 'https://example.test/math' }])
    const xhtml = renderPublicationXhtml(document)
    expect(xhtml).toContain(fraction)
    expect(xhtml.match(/<math\b/g)).toHaveLength(1)
    expect(xhtml.slice(xhtml.indexOf('<body>'))).not.toContain('a/b')
    expect(xhtml).toContain('Before ')
    expect(xhtml).toContain(' after.')
    expect(xhtml).toMatch(/<strong>[\s\S]*<math/)
    expect(xhtml).toMatch(/<a[^>]*href="https:\/\/example.test\/math"[^>]*>[\s\S]*<math/)
    expect(document.blocks[0].text).toBe('Before a/b after.')
    expect(document.receipt.textCharacterCount).toBe(17)
  })

  it('renders adjacent fraction and radical atoms without duplicating either fallback', () => {
    const document = documentWith([{ ...block('prose', 'paragraph', 'a/bsqrt(x)'), inline: [{ start: 0, end: 3, mathml: fraction }, { start: 3, end: 10, mathml: radical }] }])
    const xhtml = renderPublicationXhtml(document)
    expect(xhtml).toContain(`${fraction}${radical}`)
    expect(xhtml.match(/<math\b/g)).toHaveLength(2)
    expect(xhtml.slice(xhtml.indexOf('<body>'))).not.toContain('a/b')
    expect(xhtml.slice(xhtml.indexOf('<body>'))).not.toContain('sqrt(x)')
  })

  it('rejects a valid relationship owner that intersects a math atom', () => {
    const document = mathDocument(fraction, [{ start: 0, end: 17, relationshipId: 'reference', semanticRole: 'cross-reference' }])
    document.relationships = [relationship('reference', 'prose', 'prose', 'cross-reference')]
    document.receipt.relationshipCount = 1
    Object.assign(document.receipt.conservation, { sourceRelationshipCount: 1, accountedSourceRelationshipCount: 1, structRelationshipCount: 1 })
    expectRejected(document)
  })

  it.each([
    ['zero width', { start: 7, end: 7, mathml: fraction }],
    ['outside text', { start: 7, end: 40, mathml: fraction }],
    ['overlapping atom', { start: 9, end: 12, mathml: radical }],
    ['internal style boundary', { start: 8, end: 10, italic: true }],
    ['internal hyperlink boundary', { start: 0, end: 8, href: 'https://example.test' }],
    ['semantic intersection', { start: 7, end: 10, semanticRole: 'cross-reference', targetIds: ['prose'] }],
  ])('rejects %s', (_label, span) => expectRejected(mathDocument(fraction, [span])))

  it.each([[2, 3], [1, 2]])('rejects a math range %s..%s splitting a surrogate pair', (start, end) => {
    expectRejected(documentWith([{ ...block('prose', 'paragraph', 'a😀b'), inline: [{ start, end, mathml: fraction }] }]))
  })

  it('replaces an entire surrogate pair using UTF-16 offsets', () => {
    const document = documentWith([{ ...block('prose', 'paragraph', 'a😀b'), inline: [{ start: 1, end: 3, mathml: fraction }] }])
    const xhtml = renderPublicationXhtml(document)
    expect(xhtml).toContain(`a${fraction}b`)
    expect(xhtml).not.toContain('😀')
    expect(document.receipt.textCharacterCount).toBe(4)
  })

  it('enforces the MathML-specific byte budget below the generic string limit', () => {
    const document = mathDocument(`<math xmlns="${ns}"><mtext>${'x'.repeat(300 * 1024)}</mtext></math>`)
    expect(() => decodeStructDocument(document)).toThrow(/MathML.*byte bound/i)
  })

  it.each([
    ['missing namespace', '<math><mi>x</mi></math>'],
    ['foreign namespace', '<math xmlns="urn:foreign"><mi>x</mi></math>'],
    ['nested namespace change', `<math xmlns="${ns}"><mi xmlns="urn:foreign">x</mi></math>`],
    ['prefixed element', `<math xmlns="${ns}" xmlns:m="${ns}"><m:mi>x</m:mi></math>`],
    ['active element', `<math xmlns="${ns}"><script>alert(1)</script></math>`],
    ['event handler', `<math xmlns="${ns}" onload="alert(1)"><mi>x</mi></math>`],
    ['style attribute', `<math xmlns="${ns}"><mi style="color:red">x</mi></math>`],
    ['link attribute', `<math xmlns="${ns}"><mi href="https://example.test">x</mi></math>`],
    ['ID attribute', `<math xmlns="${ns}" id="injected"><mi>x</mi></math>`],
    ['foreign annotation', `<math xmlns="${ns}"><annotation-xml><p>unsafe</p></annotation-xml></math>`],
    ['doctype entity', `<!DOCTYPE math [<!ENTITY x "test">]><math xmlns="${ns}"><mi>&x;</mi></math>`],
    ['processing instruction', `<?xml-stylesheet href="https://example.test"?><math xmlns="${ns}"><mi>x</mi></math>`],
    ['malformed XML', `<math xmlns="${ns}"><mi>x</math>`],
    ['extra root', `${fraction}${radical}`],
    ['display block', `<math xmlns="${ns}" display="block"><mi>x</mi></math>`],
    ['excessive nesting', `<math xmlns="${ns}">${'<mrow>'.repeat(300)}<mi>x</mi>${'</mrow>'.repeat(300)}</math>`],
    ['oversized payload', `<math xmlns="${ns}"><mtext>${'x'.repeat(4 * 1024 * 1024 + 1)}</mtext></math>`],
  ])('rejects unsafe or unsupported %s', (_label, mathml) => expectRejected(mathDocument(mathml)))
})
