import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { runInNewContext } from 'node:vm'
import {
  decodeStructDocument,
  encodeStructDocument,
  migrateStructDocument,
  StructCodecError,
} from '../src/document/index'
import { structDigest } from '../src/identity'
import { legacyStructDigest } from '../src/legacy-digest'
import { sha256HexSync } from '../src/sha256'
import { buildStructEpub } from '../src/renderers/epub'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import {
  MAX_STRUCT_ASSET_BYTES,
  parseBytes,
  preflightBytes,
} from '../src/document/codec/bytes'
import { validateStructConsultationReceipt } from '../src/receipt'
import {
  MAX_STRUCT_STRING_BYTES,
  stringValue,
} from '../src/document/codec/primitives'
import {
  buildRenderedPublicationPlan,
  MAX_RENDERED_INLINE_SEGMENTS,
  RenderedPublicationPlanError,
} from '../src/renderers/xhtml-plan'
import { hash, seal, validDocument } from './codec-fixtures'

type InvalidSemanticDocumentCase = [
  label: string,
  mutate: (value: any) => void,
  code: string,
  path: string,
]

const invalidXhtmlSemanticDocuments: InvalidSemanticDocumentCase[] = [
  [
    'unknown root field',
    (value) => {
      value.unexpected = 'sealed-but-undeclared'
    },
    'UNKNOWN_FIELD',
    '$.unexpected',
  ],
  [
    'invalid base direction',
    (value) => {
      value.metadata.baseDirection = 'sideways'
    },
    'ENUM',
    '$.metadata.baseDirection',
  ],
  [
    'invalid BCP-47 language',
    (value) => {
      value.metadata.language = 'not a language'
    },
    'LANGUAGE',
    '$.metadata.language',
  ],
  [
    'invalid block kind',
    (value) => {
      value.blocks[0].kind = 'unsupported-kind'
    },
    'ENUM',
    '$.blocks[0].kind',
  ],
]

describe('STRUCT publication rendering', () => {
  it('rejects an invalid semantic receipt through the direct XHTML boundary', () => {
    const value = validDocument() as any
    value.receipt.generatedSha256 = '0'.repeat(64)

    expect(() => renderPublicationXhtml(value)).toThrow(/receipt/i)
  })

  it('rejects over-budget text through the direct XHTML boundary', () => {
    const value = validDocument() as any
    value.metadata.title = 'x'.repeat(MAX_STRUCT_STRING_BYTES + 1)
    seal(value)

    expect(() => renderPublicationXhtml(value)).toThrow(/resource bound/i)
  })

  it('rejects live accessor input through the direct XHTML boundary', () => {
    const value = validDocument() as any
    const title = value.metadata.title
    Object.defineProperty(value.metadata, 'title', {
      enumerable: true,
      get: () => title,
    })

    expect(() => renderPublicationXhtml(value)).toThrow(/accessor|data value/i)
  })

  it.each(invalidXhtmlSemanticDocuments)(
    'rejects a receipt-sealed %s through the direct XHTML boundary',
    (_label, mutate, code, path) => {
      const value = validDocument() as any
      mutate(value)
      seal(value)

      try {
        renderPublicationXhtml(value)
        throw new Error('expected strict semantic ingress rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(StructCodecError)
        expect((error as StructCodecError).code).toBe(code)
        expect((error as StructCodecError).path).toBe(path)
      }
    },
  )

  it.each(invalidXhtmlSemanticDocuments)(
    'rejects a receipt-sealed %s through the direct EPUB boundary',
    async (_label, mutate, code, path) => {
      const value = validDocument() as any
      mutate(value)
      seal(value)
      value.assets[0].bytes = new Uint8Array([0, 255, 128])

      await expect(buildStructEpub(value)).rejects.toMatchObject({ code, path })
    },
  )

  it('defers normalized emitted-id collisions to the XHTML boundary', () => {
    const value = validDocument()
    value.metadata.authorNotes![0].id = '1'
    value.blocks[0].sourceObservationAnchorIds = ['n-1']
    seal(value)
    const decoded = decodeStructDocument(value)
    try {
      renderPublicationXhtml(decoded)
      throw new Error('expected XHTML emitted-id collision')
    } catch (error) {
      expect(error).toBeInstanceOf(RenderedPublicationPlanError)
      expect((error as RenderedPublicationPlanError).code).toBe(
        'DUPLICATE_IDENTIFIER',
      )
      expect((error as RenderedPublicationPlanError).path).toBe(
        '$.metadata.authorNotes[0].id',
      )
    }
  })

  it('rejects a normalized relationship id colliding with a block id', () => {
    const value = validDocument() as any
    value.blocks[0].id = 'n-1'
    value.metadata.authorNotes[0].target = 'n-1'
    value.blocks[0].inline[0].href = '#n-1'
    value.blocks[0].inline[0].targetIds = ['n-1']
    value.blocks[0].inline[0].relationshipId = '1'
    value.relationships[0].id = '1'
    value.relationships[0].from = 'n-1'
    value.relationships[0].to = ['n-1']
    value.relationships[0].candidates[0].target = 'n-1'
    value.pages[0].blocks = ['n-1']
    value.pages[0].columns[0].blockIds = ['n-1']
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(() => renderPublicationXhtml(decoded)).toThrow(
      /duplicate|identifier/i,
    )
  })

  it('emits a relationship id only once when used in two blocks', async () => {
    const value = validDocument() as any
    const second = { ...value.blocks[0], id: 'block-2', order: 1, page: null }
    delete second.table
    delete second.furniture
    delete second.furnitureReview
    delete second.fallbackAssetIds
    delete second.sourceObservationAnchorIds
    second.inline = [{ ...value.blocks[0].inline[0] }]
    value.blocks.push(second)
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.sourceTextCharacterCount = 10
    value.receipt.conservation.structTextCharacterCount = 10
    value.receipt.textCharacterCount = 10
    value.blocks[0].text = 'Hello'
    value.blocks[1].text = 'World'
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml.match(/<a id="relationship-1"/g)).toHaveLength(1)
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('rejects a composed table-cell id colliding with a block id', () => {
    const value = validDocument() as any
    value.blocks[0].id = 'table'
    value.blocks[0].kind = 'table'
    value.blocks[0].table.cells[0].id = 'cell'
    value.metadata.authorNotes[0].target = 'table'
    value.blocks[0].inline[0].href = '#table'
    value.blocks[0].inline[0].targetIds = ['table']
    value.relationships[0].from = 'table'
    value.relationships[0].to = ['table']
    value.relationships[0].candidates[0].target = 'table'
    value.pages[0].blocks = ['table']
    value.pages[0].columns[0].blockIds = ['table']
    const second = {
      ...value.blocks[0],
      id: 'table-cell',
      order: 1,
      page: null,
    }
    delete second.table
    delete second.furniture
    delete second.furnitureReview
    delete second.fallbackAssetIds
    delete second.sourceObservationAnchorIds
    second.inline = []
    second.text = ''
    value.blocks.push(second)
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(() => renderPublicationXhtml(decoded)).toThrow(
      /duplicate|identifier/i,
    )
  })

  it.each([
    ['asset id', ['asset-1'], 'assets/asset-1.bin'],
    [
      'external URL',
      ['https://example.test/reference'],
      'https://example.test/reference',
    ],
  ])(
    'renders a relationship %s using its target kind',
    async (_label, targets, expectedHref) => {
      const value = validDocument() as any
      value.relationships[0].to = targets
      seal(value)
      const decoded = decodeStructDocument(value)
      expect(renderPublicationXhtml(decoded)).toContain(
        `href="${expectedHref}"`,
      )
      await expect(buildStructEpub(decoded)).resolves.toMatchObject({
        mediaType: 'application/epub+zip',
      })
    },
  )

  it('keeps a numeric block author-note target on its exact raw fragment', async () => {
    const value = validDocument() as any
    value.blocks[0].id = '1'
    value.metadata.authorNotes[0].target = '1'
    value.relationships[0].from = '1'
    value.relationships[0].to = ['1']
    value.relationships[0].candidates[0].target = '1'
    value.blocks[0].inline[0].href = '#1'
    value.blocks[0].inline[0].targetIds = ['1']
    value.pages[0].blocks = ['1']
    value.pages[0].columns[0].blockIds = ['1']
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('href="#1"')
    expect(xhtml).toContain('id="1"')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('uses an asset href for an author-note target', async () => {
    const value = validDocument() as any
    value.metadata.authorNotes[0].target = 'asset-1'
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('href="assets/asset-1.bin"')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('uses an asset href for a plain inline target', async () => {
    const value = validDocument() as any
    value.blocks[0].inline[0] = {
      start: 0,
      end: 5,
      href: '#asset-1',
      targetIds: ['asset-1'],
    }
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('href="assets/asset-1.bin"')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('resolves local scheme-looking ids before external URL classification', async () => {
    const value = validDocument() as any
    value.blocks[0].id = 'mailto:note'
    value.metadata.authorNotes[0].target = 'mailto:note'
    value.relationships[0].from = 'mailto:note'
    value.relationships[0].to = ['mailto:note']
    value.relationships[0].candidates[0].target = 'mailto:note'
    value.blocks[0].inline[0] = {
      start: 0,
      end: 5,
      href: 'mailto:note',
      targetIds: ['mailto:note'],
      relationshipId: 'relationship-1',
      semanticRole: 'cross-reference',
    }
    value.pages[0].blocks = ['mailto:note']
    value.pages[0].columns[0].blockIds = ['mailto:note']
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('href="#mailto:note"')
    expect(xhtml).not.toContain('href="mailto:note"')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('resolves a scheme-looking local id for a plain inline target', async () => {
    const value = validDocument() as any
    const target = {
      ...value.blocks[0],
      id: 'mailto:note',
      text: 'Target',
      inline: [],
      order: 1,
    }
    delete target.table
    delete target.furniture
    delete target.furnitureReview
    delete target.fallbackAssetIds
    delete target.sourceObservationAnchorIds
    delete target.attributes
    value.blocks[0].inline = [{ start: 0, end: 5, href: 'mailto:note' }]
    value.blocks.push(target)
    value.pages[0].blocks.push('mailto:note')
    value.pages[0].columns[0].blockIds.push('mailto:note')
    value.receipt.blockCount = 2
    value.receipt.textCharacterCount = 11
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.sourceTextCharacterCount = 11
    value.receipt.conservation.structTextCharacterCount = 11
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('href="#mailto:note"')
    expect(xhtml).not.toContain('href="mailto:note"')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it.each(['https://example.test/path ', ' https://example.test/path'])(
    'rejects a non-canonical external URL before digest acceptance (%s)',
    (href) => {
      const value = validDocument() as any
      value.relationships[0].to = [href]
      seal(value)
      expect(() => decodeStructDocument(value)).toThrow(
        /reference|canonical|url/i,
      )
    },
  )

  it.each(['https://example.test/path ', ' https://example.test/path'])(
    'rejects a non-canonical plain inline URL before digest acceptance (%s)',
    (href) => {
      const value = validDocument() as any
      value.blocks[0].inline[0] = { start: 0, end: 5, href }
      seal(value)
      expect(() => decodeStructDocument(value)).toThrow(/url|canonical/i)
    },
  )

  it('renders table cells in coordinate order without rewriting the document', () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'table'
    value.blocks[0].text = ''
    value.blocks[0].inline = []
    value.blocks[0].table = {
      rows: 1,
      columns: 2,
      cells: [
        {
          ...value.blocks[0].table.cells[0],
          id: 'right',
          text: 'RIGHT',
          column: 1,
        },
        {
          ...value.blocks[0].table.cells[0],
          id: 'left',
          text: 'LEFT',
          column: 0,
        },
      ],
      semantic: 'verified',
    }
    value.receipt.textCharacterCount = 0
    value.receipt.conservation.sourceTextCharacterCount = 0
    value.receipt.conservation.structTextCharacterCount = 0
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(decoded.blocks[0]!.table!.cells.map((cell) => cell.id)).toEqual([
      'right',
      'left',
    ])
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml.indexOf('>LEFT</td>')).toBeLessThan(
      xhtml.indexOf('>RIGHT</td>'),
    )
  })

  it('renders an anonymous cell for a leading sparse table coordinate', async () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'table'
    value.blocks[0].text = ''
    value.blocks[0].inline = []
    value.blocks[0].table = {
      rows: 1,
      columns: 2,
      cells: [
        {
          ...value.blocks[0].table.cells[0],
          id: 'right',
          text: 'RIGHT',
          column: 1,
        },
      ],
      semantic: 'verified',
    }
    value.receipt.textCharacterCount = 0
    value.receipt.conservation.sourceTextCharacterCount = 0
    value.receipt.conservation.structTextCharacterCount = 0
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain(
      '<tr><td></td><td id="block-1-right">RIGHT</td></tr>',
    )
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('does not add a placeholder for a coordinate occupied by a row span', () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'table'
    value.blocks[0].text = ''
    value.blocks[0].inline = []
    value.blocks[0].table = {
      rows: 2,
      columns: 2,
      cells: [
        {
          ...value.blocks[0].table.cells[0],
          id: 'top',
          text: 'TOP',
          row: 0,
          column: 0,
          rowSpan: 2,
        },
        {
          ...value.blocks[0].table.cells[0],
          id: 'bottom',
          text: 'BOTTOM',
          row: 1,
          column: 1,
        },
      ],
      semantic: 'verified',
    }
    value.receipt.textCharacterCount = 0
    value.receipt.conservation.sourceTextCharacterCount = 0
    value.receipt.conservation.structTextCharacterCount = 0
    seal(value)
    const xhtml = renderPublicationXhtml(decodeStructDocument(value))
    expect(xhtml).toContain(
      '<tr><td id="block-1-top" rowspan="2">TOP</td><td></td></tr><tr><td id="block-1-bottom">BOTTOM</td></tr>',
    )
    expect(xhtml).not.toContain('<tr><td></td><td id="block-1-bottom">')
  })

  it('does not add a placeholder between cells separated by a column span', () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'table'
    value.blocks[0].text = ''
    value.blocks[0].inline = []
    value.blocks[0].table = {
      rows: 1,
      columns: 3,
      cells: [
        {
          ...value.blocks[0].table.cells[0],
          id: 'wide',
          text: 'WIDE',
          column: 0,
          columnSpan: 2,
        },
        {
          ...value.blocks[0].table.cells[0],
          id: 'last',
          text: 'LAST',
          column: 2,
        },
      ],
      semantic: 'verified',
    }
    value.receipt.textCharacterCount = 0
    value.receipt.conservation.sourceTextCharacterCount = 0
    value.receipt.conservation.structTextCharacterCount = 0
    seal(value)
    const xhtml = renderPublicationXhtml(decodeStructDocument(value))
    expect(xhtml).toContain(
      '<tr><td id="block-1-wide" colspan="2">WIDE</td><td id="block-1-last">LAST</td></tr>',
    )
  })

  it('preserves multiple sparse table holes and EPUB table markup', async () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'table'
    value.blocks[0].text = ''
    value.blocks[0].inline = []
    value.blocks[0].table = {
      rows: 2,
      columns: 3,
      cells: [
        {
          ...value.blocks[0].table.cells[0],
          id: 'a',
          text: 'A',
          row: 0,
          column: 2,
        },
        {
          ...value.blocks[0].table.cells[0],
          id: 'b',
          text: 'B',
          row: 1,
          column: 1,
        },
      ],
      semantic: 'verified',
    }
    value.receipt.textCharacterCount = 0
    value.receipt.conservation.sourceTextCharacterCount = 0
    value.receipt.conservation.structTextCharacterCount = 0
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    const epub = await buildStructEpub(decoded)
    const epubXhtml = strFromU8(unzipSync(epub.bytes)['EPUB/content.xhtml']!)
    expect(xhtml).toContain(
      '<tr><td></td><td></td><td id="block-1-a">A</td></tr><tr><td></td><td id="block-1-b">B</td><td></td></tr>',
    )
    expect(epubXhtml).toContain(
      '<tr><td></td><td></td><td id="block-1-a">A</td></tr><tr><td></td><td id="block-1-b">B</td><td></td></tr>',
    )
  })

  it.each([
    [
      'rows',
      (value: any) => {
        value.blocks[0].table.rows = 100_001
        value.blocks[0].table.cells = []
      },
    ],
    [
      'columns',
      (value: any) => {
        value.blocks[0].table.columns = 100_001
        value.blocks[0].table.cells = []
      },
    ],
    [
      'area',
      (value: any) => {
        value.blocks[0].table.rows = 317
        value.blocks[0].table.columns = 316
        value.blocks[0].table.cells = []
      },
    ],
  ])(
    'rejects table dimensions beyond the bounded publication domain (%s)',
    (_label, mutate) => {
      const value = validDocument() as any
      mutate(value)
      seal(value)
      expect(() => decodeStructDocument(value)).toThrow(/table|bound|area/i)
    },
  )

  it('accepts the explicit maximum table area without allocating beyond it', () => {
    const value = validDocument() as any
    value.blocks[0].table.rows = 100_000
    value.blocks[0].table.columns = 1
    value.blocks[0].table.cells = []
    seal(value)
    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it('rejects table bounds before inspecting a cell array proxy', () => {
    const value = validDocument() as any
    const traps = { ownKeys: 0, descriptor: 0 }
    value.blocks[0].table.rows = 100_001
    value.blocks[0].table.cells = new Proxy([], {
      ownKeys() {
        traps.ownKeys += 1
        throw new Error('cell array inspected')
      },
      getOwnPropertyDescriptor() {
        traps.descriptor += 1
        throw new Error('cell array inspected')
      },
    })
    expect(() => decodeStructDocument(value)).toThrow(/table|bound/i)
    expect(traps).toEqual({ ownKeys: 0, descriptor: 0 })
  })

  it('rejects a cell list over the table area before parsing cell payloads', () => {
    const value = validDocument() as any
    const traps = { ownKeys: 0, descriptor: 0 }
    value.blocks[0].table.rows = 1
    value.blocks[0].table.columns = 1
    const hostileCell = new Proxy(
      {},
      {
        ownKeys() {
          traps.ownKeys += 1
          throw new Error('cell payload inspected')
        },
        getOwnPropertyDescriptor() {
          traps.descriptor += 1
          throw new Error('cell payload inspected')
        },
      },
    )
    value.blocks[0].table.cells = [hostileCell, hostileCell]
    expect(() => decodeStructDocument(value)).toThrow(/table|bound/i)
    expect(traps).toEqual({ ownKeys: 0, descriptor: 0 })
  })

  it('allows an author note to alias its matched relationship occurrence', async () => {
    const value = validDocument() as any
    const note = {
      ...value.blocks[0],
      id: 'note',
      kind: 'footnote',
      text: 'Note',
      inline: [],
      order: 1,
    }
    delete note.table
    delete note.furniture
    delete note.furnitureReview
    delete note.fallbackAssetIds
    delete note.sourceObservationAnchorIds
    delete note.attributes
    value.blocks.push(note)
    value.metadata.authorNotes[0].id = 'author-note-1'
    value.metadata.authorNotes[0].target = 'note'
    value.blocks[0].inline[0] = {
      start: 0,
      end: 5,
      relationshipId: 'author-note-1',
      semanticRole: 'note-reference',
    }
    value.relationships[0] = {
      ...value.relationships[0],
      id: 'author-note-1',
      kind: 'footnote',
      from: 'block-1',
      to: ['note'],
      status: 'matched',
    }
    delete value.relationships[0].candidates
    value.pages[0].blocks.push('note')
    value.pages[0].columns[0].blockIds.push('note')
    value.receipt.blockCount = 2
    value.receipt.textCharacterCount = 9
    value.receipt.relationshipCount = 1
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.structTextCharacterCount = 9
    value.receipt.conservation.sourceTextCharacterCount = 9
    value.receipt.conservation.structRelationshipCount = 1
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml.match(/<a id="author-note-1"/g)).toHaveLength(1)
    expect(xhtml).toContain('href="#author-note-1" class="note-backlink"')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('rejects an author-note identifier reused by an unrelated relationship', () => {
    const value = validDocument() as any
    value.metadata.authorNotes[0].id = value.relationships[0].id
    value.relationships[0].kind = 'reading-order'
    value.relationships[0].to = ['block-1']
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it('accepts benign disjoint inline ownership above the historical cap', () => {
    const value = validDocument() as any
    const runCount = 4_097
    value.blocks[0].text = 'x'.repeat(runCount)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: index,
      end: index + 1,
    }))
    value.receipt.textCharacterCount = runCount
    value.receipt.conservation.sourceTextCharacterCount = runCount
    value.receipt.conservation.structTextCharacterCount = runCount
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(renderPublicationXhtml(decoded)).toContain('x'.repeat(runCount))
  })

  it('defers nested inline ownership budgets to the XHTML boundary', () => {
    const value = validDocument() as any
    const runCount = 2_000
    const textLength = runCount * 2
    value.blocks[0].text = 'x'.repeat(textLength)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: index,
      end: textLength - index,
      bold: true,
    }))
    value.receipt.textCharacterCount = textLength
    value.receipt.conservation.sourceTextCharacterCount = textLength
    value.receipt.conservation.structTextCharacterCount = textLength
    seal(value)
    const decoded = decodeStructDocument(value)
    try {
      renderPublicationXhtml(decoded)
      throw new Error('expected nested ownership budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RenderedPublicationPlanError)
      expect((error as RenderedPublicationPlanError).code).toBe('BUDGET')
      expect((error as RenderedPublicationPlanError).path).toBe(
        '$.blocks[0].inline[0]',
      )
    }
  })

  it('rejects semantic target expansion before materializing the cross-product', () => {
    const value = validDocument() as any
    const targetCount = 800
    const segmentCount = 800
    const targetIds = Array.from(
      { length: targetCount },
      (_, index) => `https://example.test/target-${index}`,
    )
    value.relationships[0] = {
      ...value.relationships[0],
      to: targetIds,
      status: 'matched',
      label: targetIds.map((_, index) => `Author:${2000 + index}`).join(', '),
    }
    value.blocks[0].text = 'x'.repeat(segmentCount)
    value.blocks[0].inline = [
      {
        start: 0,
        end: segmentCount,
        relationshipId: value.relationships[0].id,
        semanticRole: 'citation',
      },
      ...Array.from({ length: segmentCount }, (_, index) => ({
        start: index,
        end: index + 1,
        bold: true,
      })),
    ]
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('defers semantic expansion budgets to renderer ingress', async () => {
    const value = validDocument() as any
    const targetIds = Array.from(
      { length: 800 },
      (_, index) => `https://example.test/target-${index}`,
    )
    value.relationships[0] = {
      ...value.relationships[0],
      to: targetIds,
      status: 'matched',
    }
    value.blocks[0].text = 'x'.repeat(800)
    value.blocks[0].inline = [
      {
        start: 0,
        end: 800,
        relationshipId: value.relationships[0].id,
        semanticRole: 'cross-reference',
      },
      ...Array.from({ length: 800 }, (_, index) => ({
        start: index,
        end: index + 1,
        bold: true,
      })),
    ]
    value.receipt.textCharacterCount = 800
    value.receipt.conservation.sourceTextCharacterCount = 800
    value.receipt.conservation.structTextCharacterCount = 800
    seal(value)
    const decoded = decodeStructDocument(value)
    try {
      renderPublicationXhtml(decoded)
      throw new Error('expected semantic expansion budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RenderedPublicationPlanError)
      expect((error as RenderedPublicationPlanError).code).toBe('BUDGET')
      expect((error as RenderedPublicationPlanError).path).toMatch(
        /blocks\[0\]\.inline/,
      )
    }
    value.assets[0].bytes = new Uint8Array([0, 255, 128])
    await expect(buildStructEpub(value as any)).rejects.toThrow(/budget/i)
  })

  it('rejects repeated long hyperlink markup within the aggregate output budget', () => {
    const value = validDocument() as any
    const segmentCount = 800
    value.blocks[0].text = 'x'.repeat(segmentCount)
    value.blocks[0].inline = [
      {
        start: 0,
        end: segmentCount,
        href: `https://example.test/${'x'.repeat(30_000)}`,
      },
      ...Array.from({ length: segmentCount }, (_, index) => ({
        start: index,
        end: index + 1,
        bold: true,
      })),
    ]
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('does not expand shadowed semantic owners before selecting the rendered owner', () => {
    const value = validDocument() as any
    const runCount = 800
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships = Array.from({ length: runCount }, (_, index) =>
      index === 0
        ? { ...value.relationships[0], id: 'shadowed-0', to: ['block-1'] }
        : {
            ...value.relationships[0],
            id: `shadowed-${index}`,
            get to() {
              throw new Error('SHADOWED_TARGET_EXPANSION')
            },
          },
    )
    value.blocks[0].text = 'x'.repeat(runCount)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: 0,
      end: runCount,
      relationshipId: `shadowed-${index}`,
      semanticRole: 'cross-reference',
    }))
    expect(() => buildRenderedPublicationPlan(value)).not.toThrow()
  })

  it('refuses same-year citation matching before touching a later hostile source', () => {
    const value = validDocument() as any
    const occurrenceCount = 800
    const labels = Array.from(
      { length: occurrenceCount },
      (_, index) => `Author${index}:2000`,
    )
    const targetIds = labels.map(
      (_, index) => `https://example.test/citation-${index}`,
    )
    value.relationships[0] = {
      ...value.relationships[0],
      to: targetIds,
      label: labels.join(', '),
      status: 'matched',
    }
    const citationText = labels
      .map((label) => `${label.split(':')[0]} 2000`)
      .join(' ')
    value.blocks[0].text = citationText
    value.blocks[0].inline = [
      {
        start: 0,
        end: citationText.length,
        relationshipId: value.relationships[0].id,
        semanticRole: 'citation',
      },
    ]
    const later = new Proxy(
      {
        id: 'later-citation',
        kind: 'paragraph',
        text: 'later',
        inline: [],
        page: 1,
        order: 1,
        column: 'single',
      },
      {
        get(_target, property) {
          if (property === 'inline') throw new Error('LATE_CITATION_TRAP')
          return Reflect.get(_target, property)
        },
      },
    )
    value.blocks.push(later)
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('uses the planning target index instead of scanning document nodes per target', () => {
    const value = validDocument() as any
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      to: ['block-1'],
      status: 'matched',
    }
    value.blocks[0].inline = [
      {
        start: 0,
        end: 5,
        relationshipId: value.relationships[0].id,
        semanticRole: 'cross-reference',
      },
    ]
    Object.defineProperty(value.blocks, 'find', {
      value: () => {
        throw new Error('block find must not be used during planning')
      },
    })
    Object.defineProperty(value.assets, 'find', {
      value: () => {
        throw new Error('asset find must not be used during planning')
      },
    })
    expect(() => buildRenderedPublicationPlan(value)).not.toThrow()
  })

  it('does not inspect later node ids before refusing external semantic output', () => {
    const value = validDocument() as any
    const targetIds = Array.from(
      { length: 800 },
      (_, index) => `https://example.test/external-${index}`,
    )
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      to: targetIds,
      status: 'matched',
    }
    value.blocks[0].text = 'x'.repeat(800)
    value.blocks[0].inline = [
      {
        start: 0,
        end: 800,
        relationshipId: value.relationships[0].id,
        semanticRole: 'cross-reference',
      },
      ...Array.from({ length: 800 }, (_, index) => ({
        start: index,
        end: index + 1,
        bold: true,
      })),
    ]
    const later = new Proxy(
      {
        id: 'later-id-trap',
        kind: 'paragraph',
        text: 'later',
        inline: [],
      },
      {
        get(target, property) {
          if (property === 'id' || property === 'kind')
            throw new Error('LATE_ID_TRAP')
          return Reflect.get(target, property)
        },
      },
    )
    value.blocks.push(later)
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('refuses a target-list tail before reading beyond the output budget', () => {
    const value = validDocument() as any
    const targetIds = Array.from(
      { length: 800 },
      (_, index) => `https://example.test/${'x'.repeat(30_000)}-${index}`,
    )
    Object.defineProperty(targetIds, 700, {
      get() {
        throw new Error('TARGET_TAIL_TRAP')
      },
    })
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      to: targetIds,
      status: 'matched',
    }
    value.blocks[0].text = 'x'.repeat(800)
    value.blocks[0].inline = [
      {
        start: 0,
        end: 800,
        relationshipId: value.relationships[0].id,
        semanticRole: 'cross-reference',
      },
      ...Array.from({ length: 800 }, (_, index) => ({
        start: index,
        end: index + 1,
        bold: true,
      })),
    ]
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('charges short semantic targets only across segments owned by that run', () => {
    const value = validDocument() as any
    const targetIds = Array.from(
      { length: 800 },
      (_, index) => `https://example.test/short-${index}`,
    )
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      to: targetIds,
      status: 'matched',
    }
    value.blocks[0].text = 'x'.repeat(800)
    value.blocks[0].inline = [
      {
        start: 0,
        end: 1,
        relationshipId: value.relationships[0].id,
        semanticRole: 'cross-reference',
      },
      ...Array.from({ length: 800 }, (_, index) => ({
        start: index,
        end: index + 1,
        bold: true,
      })),
    ]
    value.receipt.textCharacterCount = 800
    value.receipt.conservation.sourceTextCharacterCount = 800
    value.receipt.conservation.structTextCharacterCount = 800
    seal(value)
    expect(() => renderPublicationXhtml(value)).not.toThrow()
  })

  it('charges citation matching work across selected owners and sources', () => {
    const value = validDocument() as any
    const ownerCount = 7
    const occurrenceCount = 200
    const labels = Array.from(
      { length: occurrenceCount },
      (_, index) => `Author${index}:2000`,
    )
    const targetIds = labels.map(
      (_, index) => `https://example.test/aggregate-${index}`,
    )
    const citationText = labels
      .map((label) => `${label.split(':')[0]} 2000`)
      .join(' ')
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.blocks = Array.from({ length: ownerCount }, (_, index) => ({
      id: `citation-block-${index}`,
      kind: 'paragraph',
      text: citationText,
      inline: [
        {
          start: 0,
          end: citationText.length,
          relationshipId: `citation-relationship-${index}`,
          semanticRole: 'citation',
        },
      ],
    }))
    value.relationships = Array.from({ length: ownerCount }, (_, index) => ({
      ...value.relationships[0],
      id: `citation-relationship-${index}`,
      to: targetIds,
      label: labels.join(', '),
      from: `citation-block-${index}`,
      status: 'matched',
    }))
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('bounds numeric citation matching before materializing every token range', () => {
    const value = validDocument() as any
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      kind: 'citation',
      label: '1',
      to: ['https://example.test/reference-1'],
      status: 'matched',
    }
    value.blocks[0].text = '1 '.repeat(MAX_RENDERED_INLINE_SEGMENTS + 1)
    value.blocks[0].inline = [
      {
        start: 0,
        end: value.blocks[0].text.length,
        relationshipId: value.relationships[0].id,
        semanticRole: 'citation',
      },
    ]

    expect(() => buildRenderedPublicationPlan(value)).toThrow(
      /citation.*budget/i,
    )
  })

  it('skips an oversized comma-only citation label without tokenizing it', () => {
    const value = validDocument() as any
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      kind: 'citation',
      label: ','.repeat(3 * 1024 * 1024),
      to: [],
      status: 'matched',
    }
    value.blocks[0].inline = [
      {
        start: 0,
        end: value.blocks[0].text.length,
        relationshipId: value.relationships[0].id,
        semanticRole: 'citation',
      },
    ]

    seal(value)
    expect(() => renderPublicationXhtml(value)).not.toThrow()
  })

  it('preserves bounded mismatched citation labels', () => {
    const value = validDocument() as any
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      kind: 'citation',
      label: 'Smith, 2020',
      to: ['https://example.test/smith-2020'],
      status: 'matched',
    }
    value.blocks[0].inline = [
      {
        start: 0,
        end: value.blocks[0].text.length,
        relationshipId: value.relationships[0].id,
        semanticRole: 'citation',
      },
    ]

    seal(value)
    expect(renderPublicationXhtml(value)).toContain(
      'href="https://example.test/smith-2020"',
    )
  })

  it('skips an oversized cross-reference label before tokenizing it', () => {
    const value = validDocument() as any
    value.metadata.authors = []
    value.metadata.authorNotes = []
    value.relationships[0] = {
      ...value.relationships[0],
      kind: 'cross-reference',
      label: 'a,'.repeat(1_500_000),
      to: [
        'https://example.test/reference-1',
        'https://example.test/reference-2',
      ],
      status: 'matched',
    }
    value.blocks[0].inline = [
      {
        start: 0,
        end: value.blocks[0].text.length,
        relationshipId: value.relationships[0].id,
        semanticRole: 'cross-reference',
      },
    ]

    seal(value)
    expect(renderPublicationXhtml(value)).toContain(
      'Additional cross-reference target 1',
    )
  })

  it('rejects an early source budget before inspecting a later hostile source', () => {
    const value = validDocument() as any
    const runCount = 2_000
    value.blocks[0].text = 'x'.repeat(runCount * 2)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: index,
      end: runCount * 2 - index,
      bold: true,
    }))
    const later = new Proxy(
      {
        id: 'later',
        kind: 'paragraph',
        text: 'later',
        inline: [],
        page: 1,
        order: 1,
        column: 'single',
      },
      {
        get(_target, property) {
          if (property === 'inline') throw new Error('LATE_SOURCE_TRAP')
          return Reflect.get(_target, property)
        },
      },
    )
    value.blocks.push(later)
    expect(() => buildRenderedPublicationPlan(value)).toThrow(/budget/i)
  })

  it('accepts the exact active-owner and wrapper budget boundary', () => {
    const value = validDocument() as any
    const runCount = 500
    const textLength = runCount * 2
    value.blocks[0].text = 'x'.repeat(textLength)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: index,
      end: textLength - index,
      bold: true,
    }))
    value.receipt.textCharacterCount = textLength
    value.receipt.conservation.sourceTextCharacterCount = textLength
    value.receipt.conservation.structTextCharacterCount = textLength
    seal(value)
    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it('accepts inline ownership work exactly at the documented cap', () => {
    const value = validDocument() as any
    const runCount = 4_096
    value.blocks[0].text = 'x'.repeat(runCount)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: index,
      end: index + 1,
    }))
    value.receipt.textCharacterCount = runCount
    value.receipt.conservation.sourceTextCharacterCount = runCount
    value.receipt.conservation.structTextCharacterCount = runCount
    seal(value)
    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it('plans a table block\'s inline runs as its caption within budget', () => {
    const value = validDocument() as any
    const runCount = 5_000
    value.blocks[0].kind = 'table'
    value.blocks[0].text = 'x'.repeat(runCount)
    value.blocks[0].inline = Array.from({ length: runCount }, (_, index) => ({
      start: index,
      end: index + 1,
    }))
    value.blocks[0].table.cells[0].text = 'Cell'
    value.blocks[0].table.cells[0].inline = []
    value.receipt.textCharacterCount = runCount
    value.receipt.conservation.sourceTextCharacterCount = runCount
    value.receipt.conservation.structTextCharacterCount = runCount
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('<table>')
    expect(xhtml).toContain(`<figcaption>${'x'.repeat(runCount)}</figcaption><table>`)
  })

  it('rejects duplicate metadata authors at strict, direct, and EPUB boundaries', async () => {
    const value = validDocument() as any
    value.metadata.authors = ['Author', 'Author']
    seal(value)
    expect(() => renderPublicationXhtml(value)).toThrow(
      /metadata\.authors|duplicate/i,
    )
    for (const decode of [decodeStructDocument, migrateStructDocument]) {
      expect(() => decode(value)).toThrow(StructCodecError)
      expect(() => decode(value)).toThrow(/metadata\.authors|duplicate/i)
    }
    expect(() => encodeStructDocument(value as any)).toThrow(StructCodecError)
    value.assets[0].bytes = new Uint8Array([0, 255, 128])
    await expect(buildStructEpub(value as any)).rejects.toThrow(
      /duplicate|author/i,
    )
  })

  it('uses constant-time author membership for distinct author-note collections', () => {
    const value = validDocument() as any
    value.metadata.authors = ['Author', 'Second Author']
    Object.defineProperty(value.metadata.authors, 'includes', {
      value: () => {
        throw new Error('authors.includes must not be used')
      },
    })
    value.metadata.authorNotes = [
      {
        id: 'author-note-1',
        author: 'Author',
        label: '1',
        target: 'block-1',
      },
      {
        id: 'author-note-2',
        author: 'Second Author',
        label: '2',
        target: 'block-1',
      },
    ]
    expect(() => buildRenderedPublicationPlan(value)).not.toThrow()
  })

  it('recovers semantic occurrence paths without searching the source run array', () => {
    const value = validDocument() as any
    value.relationships[0] = {
      ...value.relationships[0],
      id: 'semantic-relationship',
      kind: 'reading-order',
      to: ['block-1'],
    }
    value.blocks[0].inline = [
      {
        start: 0,
        end: 5,
        relationshipId: 'semantic-relationship',
        semanticRole: 'cross-reference',
      },
    ]
    Object.defineProperty(value.blocks[0].inline, 'indexOf', {
      value: () => {
        throw new Error('source.runs.indexOf must not be used')
      },
    })
    expect(() => buildRenderedPublicationPlan(value)).not.toThrow()
  })

  it('does not create a footnote backlink for a non-table block table payload', async () => {
    const value = validDocument() as any
    const note = {
      ...value.blocks[0],
      id: 'note',
      kind: 'footnote',
      text: 'Note',
      inline: [],
      order: 1,
    } as any
    delete note.table
    delete note.furniture
    delete note.furnitureReview
    delete note.fallbackAssetIds
    delete note.sourceObservationAnchorIds
    delete note.attributes
    value.blocks.push(note)
    value.blocks[0].table.cells[0].inline = [
      {
        start: 0,
        end: 4,
        relationshipId: 'note-relationship',
        semanticRole: 'note-reference',
      },
    ]
    const noteRelationship = {
      ...value.relationships[0],
      id: 'note-relationship',
      kind: 'footnote',
      from: 'block-1',
      to: ['note'],
    }
    delete noteRelationship.candidates
    value.relationships.push(noteRelationship)
    value.pages[0].blocks.push('note')
    value.pages[0].columns[0].blockIds.push('note')
    value.receipt.blockCount = 2
    value.receipt.relationshipCount = 2
    value.receipt.textCharacterCount = 9
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.structRelationshipCount = 2
    value.receipt.conservation.sourceTextCharacterCount = 9
    value.receipt.conservation.sourceRelationshipCount = 2
    value.receipt.conservation.accountedSourceRelationshipCount = 2
    value.receipt.conservation.structTextCharacterCount = 9
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).not.toContain('note-backlink')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('does not create a footnote backlink for an overlapping unselected inline run', async () => {
    const value = validDocument() as any
    const note = {
      ...value.blocks[0],
      id: 'note',
      kind: 'footnote',
      text: 'Note',
      inline: [],
      order: 1,
    } as any
    delete note.table
    delete note.furniture
    delete note.furnitureReview
    delete note.fallbackAssetIds
    delete note.sourceObservationAnchorIds
    delete note.attributes
    value.blocks.push(note)
    value.blocks[0].inline.push({
      start: 0,
      end: 5,
      relationshipId: 'note-relationship',
      semanticRole: 'note-reference',
    })
    const noteRelationship = {
      ...value.relationships[0],
      id: 'note-relationship',
      kind: 'footnote',
      from: 'block-1',
      to: ['note'],
    }
    delete noteRelationship.candidates
    value.relationships.push(noteRelationship)
    value.pages[0].blocks.push('note')
    value.pages[0].columns[0].blockIds.push('note')
    value.receipt.blockCount = 2
    value.receipt.relationshipCount = 2
    value.receipt.textCharacterCount = 9
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.structRelationshipCount = 2
    value.receipt.conservation.sourceTextCharacterCount = 9
    value.receipt.conservation.sourceRelationshipCount = 2
    value.receipt.conservation.accountedSourceRelationshipCount = 2
    value.receipt.conservation.structTextCharacterCount = 9
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).not.toContain('note-backlink')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('does not create a footnote backlink for a furniture table payload', async () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'furniture'
    value.metadata.authorNotes = []
    value.blocks[0].table.cells[0].inline = [
      {
        start: 0,
        end: 4,
        relationshipId: 'note-relationship',
        semanticRole: 'note-reference',
      },
    ]
    const note = {
      ...value.blocks[0],
      id: 'note',
      kind: 'footnote',
      text: 'Note',
      inline: [],
      order: 1,
    } as any
    delete note.table
    delete note.furniture
    delete note.furnitureReview
    delete note.fallbackAssetIds
    delete note.sourceObservationAnchorIds
    delete note.attributes
    value.blocks.push(note)
    const noteRelationship = {
      ...value.relationships[0],
      id: 'note-relationship',
      kind: 'footnote',
      from: 'block-1',
      to: ['note'],
    }
    delete noteRelationship.candidates
    value.relationships.push(noteRelationship)
    value.pages[0].blocks.push('note')
    value.pages[0].columns[0].blockIds.push('note')
    value.receipt.blockCount = 2
    value.receipt.relationshipCount = 2
    value.receipt.textCharacterCount = 9
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.structRelationshipCount = 2
    value.receipt.conservation.sourceTextCharacterCount = 9
    value.receipt.conservation.sourceRelationshipCount = 2
    value.receipt.conservation.accountedSourceRelationshipCount = 2
    value.receipt.conservation.structTextCharacterCount = 9
    value.receipt.conservation.sourceFurnitureBlockCount = 1
    value.receipt.conservation.accountedFurnitureBlockCount = 1
    value.receipt.conservation.structFurnitureBlockCount = 1
    value.receipt.conservation.sourceFurnitureTextCharacterCount = 5
    value.receipt.conservation.structFurnitureTextCharacterCount = 5
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).not.toContain('note-backlink')
    await expect(buildStructEpub(decoded)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('renders a validated heading level as conforming XHTML through EPUB reopen', async () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'heading'
    value.blocks[0].inline = []
    value.blocks[0].attributes.level = 6
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(renderPublicationXhtml(decoded)).toContain('<h6 id="block-1"')
    const epub = await buildStructEpub(decoded)
    expect(strFromU8(unzipSync(epub.bytes)['EPUB/content.xhtml']!)).toContain(
      '<h6 id="block-1"',
    )
  })

  it.each([1.5, 0, 7, '3', true])(
    'rejects invalid heading renderer level %p at strict decode',
    (level) => {
      const value = validDocument() as any
      value.blocks[0].kind = 'heading'
      value.blocks[0].attributes.level = level
      seal(value)
      expect(() => decodeStructDocument(value)).toThrow(
        /level|heading|attribute|number/i,
      )
    },
  )

  it('defers numeric emitted asset ids to renderer validation', async () => {
    const value = validDocument() as any
    value.assets[0].id = '1'
    value.blocks[0].fallbackAssetIds = ['1']
    value.relationships[0].to = ['1']
    value.relationships[0].candidates[0].target = '1'
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(() => renderPublicationXhtml(decoded)).toThrow(/asset|package/i)
    await expect(buildStructEpub(decoded)).rejects.toThrow(/asset|reserved/i)
  })

  it('fails closed when an author note targets non-rendered furniture', () => {
    const value = validDocument() as any
    value.blocks[0].kind = 'furniture'
    value.receipt.conservation.sourceFurnitureBlockCount = 1
    value.receipt.conservation.accountedFurnitureBlockCount = 1
    value.receipt.conservation.structFurnitureBlockCount = 1
    value.receipt.conservation.sourceFurnitureTextCharacterCount = 5
    value.receipt.conservation.structFurnitureTextCharacterCount = 5
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(() => renderPublicationXhtml(decoded)).toThrow(/not rendered/i)
  })

  it('checks later-position anchors on non-rendered furniture through decode and migration', () => {
    const value = validDocument() as any
    value.metadata.authorNotes[0].id = '1'
    value.blocks.push({
      ...value.blocks[0],
      id: 'furniture-1',
      kind: 'furniture',
      text: '',
      page: null,
      order: 1,
      column: null,
      inline: [],
      sourceObservationAnchorIds: ['furniture-anchor', '1'],
    })
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    value.receipt.conservation.sourceFurnitureBlockCount = 1
    value.receipt.conservation.accountedFurnitureBlockCount = 1
    value.receipt.conservation.structFurnitureBlockCount = 1
    value.receipt.conservation.sourceFurnitureTextCharacterCount = 0
    value.receipt.conservation.structFurnitureTextCharacterCount = 0
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => migrateStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it('defers normalized source-anchor collisions to XHTML', () => {
    const value = validDocument() as any
    value.blocks[0].sourceObservationAnchorIds = ['anchor-1', 'n-1']
    value.metadata.authorNotes[0].id = '1'
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(() => renderPublicationXhtml(decoded)).toThrow(
      /duplicate|identifier/i,
    )
  })

  it('maps later-position anchors from every block into XHTML validation', () => {
    const value = validDocument() as any
    delete value.blocks[0].sourceObservationAnchorIds
    const second = { ...value.blocks[0], id: 'block-2', order: 1, page: null }
    delete second.table
    delete second.furniture
    delete second.furnitureReview
    delete second.fallbackAssetIds
    second.inline = []
    second.text = ''
    second.sourceObservationAnchorIds = ['anchor-1', 'n-1']
    value.blocks.push(second)
    value.metadata.authorNotes[0].id = '1'
    value.receipt.blockCount = 2
    value.receipt.conservation.structBlockCount = 2
    seal(value)
    const decoded = decodeStructDocument(value)
    expect(() => renderPublicationXhtml(decoded)).toThrow(
      /duplicate|identifier/i,
    )
  })

  it('rejects a forbidden XML 1.0 string before digest sealing', () => {
    const value = validDocument() as any
    value.metadata.title = 'bad-\uD800'
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/string|unicode|xml/i)
  })

  it('preserves valid Unicode through decode, XHTML, and EPUB reopen', async () => {
    const value = validDocument() as any
    value.metadata.title = 'Valid 🌟 — текст'
    seal(value)
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)
    expect(xhtml).toContain('Valid 🌟 — текст')
    const epub = await buildStructEpub(decoded)
    expect(strFromU8(unzipSync(epub.bytes)['EPUB/content.xhtml']!)).toContain(
      'Valid 🌟 — текст',
    )
  })

  it.each([
    [
      'box width',
      (value: any) => (value.blocks[0].evidence.boxes[0].width = -1),
    ],
    ['asset width', (value: any) => (value.assets[0].width = -1)],
    ['page height', (value: any) => (value.pages[0].height = -1)],
    [
      'box rotation',
      (value: any) => (value.blocks[0].evidence.boxes[0].rotation = 0.5),
    ],
    ['page rotation', (value: any) => (value.pages[0].rotation = 360)],
  ])(
    'rejects invalid nonnegative dimension or rotation (%s)',
    (_label, mutate) => {
      const value = validDocument()
      mutate(value)
      expect(() => decodeStructDocument(value)).toThrow(
        /number|rotation|range/i,
      )
    },
  )

  it.each([
    ['box page', (value: any) => (value.blocks[0].evidence.boxes[0].page = 0)],
    ['evidence page', (value: any) => (value.blocks[0].evidence.pages[0] = 0)],
    ['block page', (value: any) => (value.blocks[0].page = 0)],
    ['page layout page', (value: any) => (value.pages[0].page = 0)],
    ['diagnostic page', (value: any) => (value.diagnostics[0].pages[0] = 0)],
    [
      'recovery issue page',
      (value: any) => (value.recovery.issues[0].pages = [0]),
    ],
    [
      'furniture page',
      (value: any) => (value.blocks[0].furniture.pages[0] = 0),
    ],
  ])('rejects a non-positive %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/page|number|range/i)
  })

  it.each([
    [
      'box width',
      (value: any) => (value.blocks[0].evidence.boxes[0].width = 0),
    ],
    [
      'box height',
      (value: any) => (value.blocks[0].evidence.boxes[0].height = 0),
    ],
    ['asset width', (value: any) => (value.assets[0].width = 0)],
    ['asset height', (value: any) => (value.assets[0].height = 0)],
    ['page width', (value: any) => (value.pages[0].width = 0)],
    ['page height', (value: any) => (value.pages[0].height = 0)],
  ])('rejects non-positive materialized geometry (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/positive|range|number/i)
  })

  it.each([
    [
      'missing page layout for block',
      (value: any) => {
        value.blocks[0].page = null
        value.pages = []
      },
    ],
    ['page block membership', (value: any) => (value.pages[0].blocks = [])],
    [
      'column membership',
      (value: any) => (value.pages[0].columns[0].blockIds = []),
    ],
    [
      'evidence page membership',
      (value: any) => {
        value.blocks[0].page = null
        value.blocks[0].evidence.pages = []
      },
    ],
    [
      'evidence box page agreement',
      (value: any) => (value.blocks[0].evidence.pages = []),
    ],
  ])('rejects incoherent page topology (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(
      /page|membership|evidence/i,
    )
  })

  it.each(['single', null] as const)(
    'accepts a %s block column mapped to a single page column',
    (column) => {
      const value = validDocument()
      const mutable = value as any
      mutable.blocks[0].column = column
      seal(value)
      expect(() => decodeStructDocument(value)).not.toThrow()
    },
  )
})
