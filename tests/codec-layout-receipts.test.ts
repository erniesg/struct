import { MAX_STRUCT_DOCUMENT_ITEMS } from '../src/document/codec/parsers'
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
import { MAX_RENDERED_INLINE_SEGMENTS } from '../src/renderers/xhtml-plan'
import { hash, seal, validDocument } from './codec-fixtures'

describe('STRUCT page and receipt integrity', () => {
  it('accepts one single and one left column on a page', () => {
    const value = validDocument()
    value.pages[0].columns.push({
      id: 'column-2',
      side: 'left',
      blockIds: [],
    })
    seal(value)
    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it.each([
    [
      'single block in left column',
      (value: any) => (value.pages[0].columns[0].side = 'left'),
    ],
    [
      'left block in single column',
      (value: any) => (value.blocks[0].column = 'left'),
    ],
    [
      'duplicate single column side',
      (value: any) =>
        value.pages[0].columns.push({
          id: 'column-2',
          side: 'single',
          blockIds: [],
        }),
    ],
    [
      'duplicate left column side',
      (value: any) =>
        value.pages[0].columns.push(
          { id: 'column-2', side: 'left', blockIds: [] },
          { id: 'column-3', side: 'left', blockIds: [] },
        ),
    ],
  ])('rejects incoherent column semantics (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/column|page/i)
  })

  it('requires a paged block to list its page in block evidence', () => {
    const value = validDocument()
    value.blocks[0].evidence.pages = []
    value.blocks[0].evidence.boxes = []
    expect(() => decodeStructDocument(value)).toThrow(/page|evidence/i)
  })

  it.each([
    ['row bound', (value: any) => (value.blocks[0].table.cells[0].row = 1)],
    [
      'column bound',
      (value: any) => (value.blocks[0].table.cells[0].column = 1),
    ],
    [
      'row span bound',
      (value: any) => (value.blocks[0].table.cells[0].rowSpan = 2),
    ],
    [
      'column span bound',
      (value: any) => (value.blocks[0].table.cells[0].columnSpan = 2),
    ],
  ])('rejects table cell outside table bounds (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/table|bound|span/i)
  })

  it.each([
    [
      'direct cell intersection',
      (value: any) => {
        value.blocks[0].table.cells.push({
          ...value.blocks[0].table.cells[0],
          id: 'cell-2',
        })
      },
    ],
    [
      'row span intersection',
      (value: any) => {
        value.blocks[0].table.rows = 2
        value.blocks[0].table.cells[0].rowSpan = 2
        value.blocks[0].table.cells.push({
          ...value.blocks[0].table.cells[0],
          id: 'cell-2',
          row: 1,
          rowSpan: 1,
        })
      },
    ],
    [
      'column span intersection',
      (value: any) => {
        value.blocks[0].table.columns = 2
        value.blocks[0].table.cells[0].columnSpan = 2
        value.blocks[0].table.cells.push({
          ...value.blocks[0].table.cells[0],
          id: 'cell-2',
          column: 1,
          columnSpan: 1,
        })
      },
    ],
  ])('rejects table %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/table|occup|overlap/i)
  })

  it.each([
    'content.xhtml',
    'assets/figure.bin?query',
    'assets/figure.bin#part',
    'assets/a b.bin',
  ])('rejects a non-canonical EPUB asset path %s', (href) => {
    const value = validDocument()
    value.assets[0].href = href
    expect(() => decodeStructDocument(value)).toThrow(/href|path/i)
  })

  it('rejects incoherent conservation receipts and page bindings', () => {
    const accounted = validDocument()
    accounted.receipt.conservation.accountedSourceAssetCount = 2
    expect(() => decodeStructDocument(accounted)).toThrow(
      /conservation|source/i,
    )

    const furniture = validDocument()
    furniture.blocks[0].kind = 'furniture'
    expect(() => decodeStructDocument(furniture)).toThrow(
      /furniture|conservation/i,
    )

    const pages = validDocument()
    pages.source.pageCount = 0
    expect(() => decodeStructDocument(pages)).toThrow(/page/i)
  })

  it('contains hostile descriptors, revoked proxies, and model receipt cycles as StructCodecError', () => {
    const accessor = validDocument()
    Object.defineProperty(accessor.blocks[0], 'hostile', {
      enumerable: true,
      get() {
        throw new Error('getter executed')
      },
    })
    expect(() => decodeStructDocument(accessor)).toThrow(StructCodecError)

    const proxied = validDocument() as any
    const revoked = Proxy.revocable(proxied.blocks, {})
    revoked.revoke()
    proxied.blocks = revoked.proxy
    expect(() => decodeStructDocument(proxied)).toThrow(StructCodecError)

    const hostileBytes = validDocument() as any
    const bytes = Proxy.revocable(new Uint8Array([0, 255, 128]), {})
    bytes.revoke()
    hostileBytes.assets[0].bytes = bytes.proxy
    expect(() => decodeStructDocument(hostileBytes)).toThrow(StructCodecError)

    const cycle = validDocument() as any
    cycle.schemaVersion = '0.2.0'
    cycle.documentId = 'fixture-document'
    cycle.receipt.schemaVersion = '0.2.0'
    cycle.receipt.documentId = 'fixture-document'
    cycle.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    cycle.receipt.modelConsultations.inputs = cycle.receipt.modelConsultations
    expect(() => decodeStructDocument(cycle)).toThrow(StructCodecError)
  })

  it.each(['blocks', 'relationships', 'pages', 'diagnostics'] as const)(
    'rejects an oversized top-level %s array before materializing its keys',
    (field) => {
      const value = validDocument() as any
      let ownKeyReads = 0
      value[field] = new Proxy(new Array(MAX_STRUCT_DOCUMENT_ITEMS + 1), {
        ownKeys() {
          ownKeyReads += 1
          throw new Error('oversized array keys were materialized')
        },
      })

      try {
        decodeStructDocument(value)
        throw new Error('expected document collection budget failure')
      } catch (error) {
        expect(error).toBeInstanceOf(StructCodecError)
        expect((error as StructCodecError).code).toBe('BUDGET')
      }
      expect(ownKeyReads).toBe(0)
    },
  )

  it('rejects an oversized model receipt array before materializing its keys', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    seal(value)
    let ownKeyReads = 0
    value.receipt.modelConsultations.consultations = new Proxy(
      new Array(100_001),
      {
        ownKeys() {
          ownKeyReads += 1
          throw new Error('oversized receipt keys were materialized')
        },
      },
    )

    try {
      decodeStructDocument(value)
      throw new Error('expected model receipt node budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('BUDGET')
    }
    expect(ownKeyReads).toBe(0)
  })

  it('rejects a wide model receipt object before reading its descriptors', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: {},
    }
    seal(value)
    const keys = Array.from({ length: 100_001 }, (_, index) => `field${index}`)
    let descriptorReads = 0
    value.receipt.modelConsultations.metrics = new Proxy(
      {},
      {
        ownKeys() {
          return keys
        },
        getOwnPropertyDescriptor() {
          descriptorReads += 1
          return { configurable: true, enumerable: true, value: 0 }
        },
      },
    )

    try {
      decodeStructDocument(value)
      throw new Error('expected model receipt field budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('BUDGET')
    }
    expect(descriptorReads).toBe(0)
  })

  it('rejects aggregate generic receipt text before canonical receipt copying', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    const keys = Array.from({ length: 9 }, (_, index) => `field${index}`)
    let descriptorReads = 0
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: new Proxy(
        {},
        {
          ownKeys() {
            return keys
          },
          getOwnPropertyDescriptor(_target, key) {
            descriptorReads += 1
            if (descriptorReads > keys.length)
              throw new Error('receipt was copied after aggregate rejection')
            return {
              configurable: true,
              enumerable: true,
              value: 'x'.repeat(1024 * 1024),
            }
          },
        },
      ),
    }

    try {
      decodeStructDocument(value)
      throw new Error('expected generic receipt aggregate budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('BUDGET')
    }
    expect(descriptorReads).toBe(keys.length - 1)
  })

  it('bounds a stateful receipt proxy during canonical copying', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    let descriptorReads = 0
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: new Proxy(
        {},
        {
          ownKeys() {
            return ['field']
          },
          getOwnPropertyDescriptor() {
            descriptorReads += 1
            if (descriptorReads > 3)
              throw new Error('receipt was traversed after copy rejection')
            return {
              configurable: true,
              enumerable: true,
              value:
                descriptorReads < 3 ? 'small' : 'x'.repeat(1024 * 1024 + 1),
            }
          },
        },
      ),
    }

    try {
      decodeStructDocument(value)
      throw new Error('expected stateful receipt budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('BUDGET')
    }
    expect(descriptorReads).toBe(3)
  })

  it('bounds direct consultation receipt validation before array key reads', () => {
    let ownKeyReads = 0
    const consultations = new Proxy(new Array(100_001), {
      ownKeys() {
        ownKeyReads += 1
        throw new Error('oversized receipt keys were materialized')
      },
    })
    const receipt = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations,
      decisions: [],
      metrics: {},
    }

    expect(validateStructConsultationReceipt(receipt)).toBe(false)
    expect(ownKeyReads).toBe(0)
  })

  it('binds model consultation receipts to the enclosing document and source', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    value.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: 'other-document',
      sourceSha256: 'b'.repeat(64),
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    expect(() => decodeStructDocument(value)).toThrow(/model|document|source/i)
  })

  it.each([
    ['BCP-47 language', (value: any) => (value.metadata.language = 'en_US')],
    [
      'RFC-3339 publication date',
      (value: any) => (value.metadata.publicationDate = '2026-02-30'),
    ],
    [
      'RFC-3339 artifact timestamp',
      (value: any) =>
        (value.metadata.artifactModifiedAt = '2026-08-20 00:00:00Z'),
    ],
    ['strict MIME type', (value: any) => (value.assets[0].mediaType = 'image')],
    [
      'percent-encoded asset traversal',
      (value: any) => (value.assets[0].href = 'assets/%2e%2e/secret.bin'),
    ],
  ])('rejects invalid %s at the codec boundary', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(StructCodecError)
  })

  it('rejects zero-width inline runs that carry semantics', () => {
    const value = validDocument()
    value.blocks[0].inline[0] = {
      ...value.blocks[0].inline[0],
      start: 0,
      end: 0,
      href: '#block-1',
    }
    expect(() => decodeStructDocument(value)).toThrow(/zero-width|inline/i)
  })

  it('rejects negative zero before it can alias a canonical digest value', () => {
    const value = validDocument()
    value.blocks[0].evidence.confidence = -0
    expect(() => decodeStructDocument(value)).toThrow(/negative zero|number/i)
  })

  it('does not rethrow attacker-forged StructCodecError instances', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    const forged = Object.create(StructCodecError.prototype)
    Object.assign(forged, { code: 'FORGED', path: '$', message: 'forged' })
    const receipt = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: [],
      decisions: [],
      metrics: {},
    }
    value.receipt.modelConsultations = new Proxy(receipt, {
      getPrototypeOf() {
        throw forged
      },
    })

    try {
      decodeStructDocument(value)
      throw new Error('expected codec rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect(error).not.toBe(forged)
      expect((error as StructCodecError).code).not.toBe('FORGED')
    }
  })
})
