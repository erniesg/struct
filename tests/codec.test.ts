import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { runInNewContext } from 'node:vm'
import {
  decodeStructDocument,
  encodeStructDocument,
  migrateStructDocument,
  StructCodecError,
} from '../src/schema'
import { legacyStructDigest, structDigest } from '../src/core/ids'
import { sha256HexSync } from '../src/core/sha256'
import { buildStructEpub } from '../src/renderers/epub'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import {
  MAX_STRUCT_ASSET_BYTES,
  parseBytes,
  preflightBytes,
} from '../src/core/codec/bytes'
import { validateStructConsultationReceipt } from '../src/core/consultation-receipt'
import { MAX_STRUCT_STRING_BYTES, stringValue } from '../src/core/codec/primitives'
import { MAX_RENDERED_INLINE_SEGMENTS } from '../src/core/emitted-ids'

const hash = 'a'.repeat(64)
const assetBytesHash = sha256HexSync(new Uint8Array([0, 255, 128]))

function evidence() {
  return {
    confidence: 1,
    pages: [1],
    boxes: [
      {
        page: 1,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ],
    sourceIds: ['source-node'],
    signals: ['fixture'],
  }
}

function digestInput(document: any) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    ...(document.receipt.modelConsultations
      ? { modelConsultations: document.receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
  }
}

function seal<T extends Record<string, any>>(document: T): T {
  document.receipt.generatedSha256 =
    document.schemaVersion === '0.1.0'
      ? legacyStructDigest(digestInput(document))
      : structDigest(digestInput(document))
  return document
}

function validDocument() {
  const sharedEvidence = evidence()
  return seal({
    schemaVersion: '0.1.0',
    source: {
      format: 'docx',
      fileName: 'fixture.docx',
      sha256: hash,
      byteLength: 3,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'Fixture',
      subtitle: '',
      authors: ['Author'],
      abstract: 'Abstract',
      language: 'en',
      baseDirection: 'ltr',
      publicationDate: '2026-08-20',
      artifactModifiedAt: '2026-08-20T00:00:00Z',
      updated: '2026-08-20',
      affiliations: ['Example University'],
      authorAffiliations: [{ author: 'Author', label: '1' }],
      authorNotes: [
        {
          id: 'author-note-1',
          author: 'Author',
          label: '1',
          target: 'block-1',
        },
      ],
    },
    blocks: [
      {
        id: 'block-1',
        kind: 'paragraph',
        text: 'Hello',
        label: 'Body',
        page: 1,
        order: 0,
        column: 'single',
        inline: [
          {
            start: 0,
            end: 5,
            href: '#block-1',
            annotationId: 'annotation-1',
            relationshipId: 'relationship-1',
            targetIds: ['block-1'],
            bold: true,
            italic: false,
            verticalAlign: 'superscript',
            compactMathAtom: false,
            semanticRole: 'cross-reference',
          },
        ],
        evidence: sharedEvidence,
        sourceObservationAnchorIds: ['anchor-1'],
        table: {
          rows: 1,
          columns: 1,
          cells: [
            {
              id: 'cell-1',
              text: 'Cell',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence: sharedEvidence,
            },
          ],
          semantic: 'verified',
        },
        furniture: {
          classification: 'repeated-text',
          band: 'top',
          pages: [1],
          boxes: [],
          evidence: ['fixture-furniture'],
          normalizedText: 'Header',
          sequence: [1],
          sourceRunIndexes: [0],
        },
        furnitureReview: {
          reason: 'single-occurrence-margin',
          band: 'right',
          pages: [1],
          boxes: [],
          evidence: ['fixture-review'],
        },
        fallbackAssetIds: ['asset-1'],
        attributes: { level: 1, bibliographyEntry: false, objectType: 'body' },
      },
    ],
    assets: [
      {
        id: 'asset-1',
        kind: 'figure',
        href: 'assets/asset-1.bin',
        mediaType: 'application/octet-stream',
        sha256: assetBytesHash,
        width: 10,
        height: 10,
        bytes: 'AP+A',
        sourceObjectIds: ['source-asset'],
        evidence: sharedEvidence,
        fallback: 'asset',
      },
    ],
    relationships: [
      {
        id: 'relationship-1',
        kind: 'reading-order',
        from: 'block-1',
        to: ['block-1'],
        label: 'next',
        status: 'matched',
        confidence: 1,
        evidence: sharedEvidence,
        candidates: [
          { target: 'block-1', confidence: 1, evidence: sharedEvidence },
        ],
      },
    ],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['block-1'],
        columns: [{ id: 'column-1', side: 'single', blockIds: ['block-1'] }],
      },
    ],
    diagnostics: [
      {
        id: 'diagnostic-1',
        severity: 'info',
        category: 'source',
        title: 'Fixture',
        message: 'Fixture diagnostic',
        action: 'Continue',
        pages: [1],
        sourceIds: ['source-node'],
      },
    ],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'No recovery required',
      issues: [
        {
          category: 'source',
          title: 'None',
          count: 0,
          pages: [],
          action: 'None',
        },
      ],
      userAction: 'None',
    },
    receipt: {
      schemaVersion: '0.1.0',
      sourceSha256: hash,
      blockCount: 1,
      assetCount: 1,
      relationshipCount: 1,
      diagnosticCount: 1,
      textCharacterCount: 5,
      conservation: {
        sourceNodeCount: 1,
        accountedSourceNodeCount: 1,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 1,
        accountedSourceAnnotationCount: 1,
        sourceAssetCount: 1,
        accountedSourceAssetCount: 1,
        sourceRelationshipCount: 1,
        accountedSourceRelationshipCount: 1,
        sourceDiagnosticCount: 1,
        accountedSourceDiagnosticCount: 1,
        sourceTextCharacterCount: 5,
        structBlockCount: 1,
        structAssetCount: 1,
        structRelationshipCount: 1,
        structDiagnosticCount: 1,
        structTextCharacterCount: 5,
        sourceFurnitureBlockCount: 0,
        accountedFurnitureBlockCount: 0,
        sourceFurnitureTextCharacterCount: 0,
        structFurnitureBlockCount: 0,
        structFurnitureTextCharacterCount: 0,
        furnitureContaminationCount: 0,
      },
      generatedSha256: hash,
    },
  })
}

describe('STRUCT runtime codec', () => {
  it('rejects an oversized text field before copying it into the document', () => {
    expect(() =>
      stringValue('x'.repeat(MAX_STRUCT_STRING_BYTES + 1), '$.metadata.title'),
    ).toThrow(/textual resource bound/i)
  })

  it('bounds aggregate source-neutral receipt JSON text', () => {
    const receipt = {
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
      sourceSha256: hash,
      consultations: Array.from({ length: 9 }, (_, index) => ({
        [`field-${index}`]: 'x'.repeat(1024 * 1024),
      })),
      decisions: [],
      metrics: {},
    }

    expect(validateStructConsultationReceipt(receipt)).toBe(false)
  })

  it('rejects negative zero in a source-neutral consultation receipt', () => {
    expect(
      validateStructConsultationReceipt({
        schemaVersion: '1.0.0',
        documentId: 'fixture-document',
        sourceSha256: hash,
        consultations: [],
        decisions: [],
        metrics: { rate: -0 },
      }),
    ).toBe(false)
  })

  it('decodes a strict 0.1.0 document and restores JSON-safe asset bytes', () => {
    const decoded = decodeStructDocument(validDocument())

    expect(decoded.schemaVersion).toBe('0.1.0')
    expect(decoded.assets[0]?.bytes).toEqual(new Uint8Array([0, 255, 128]))
    expect(decoded.assets[0]?.bytes).not.toBe(
      (validDocument().assets[0] as { bytes: unknown }).bytes,
    )
    expect(decoded.blocks[0]?.attributes).toEqual({
      level: 1,
      bibliographyEntry: false,
      objectType: 'body',
    })
  })

  it('encodes asset bytes as canonical JSON-safe base64 and round-trips them', () => {
    const fixture = validDocument()
    const document = decodeStructDocument(fixture)
    const encoded = encodeStructDocument(document)

    expect(encoded.assets[0]).toMatchObject({ bytes: 'AP+A' })
    expect(encoded.receipt.generatedSha256).toBe(
      fixture.receipt.generatedSha256,
    )
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
    expect(decodeStructDocument(encoded).assets[0]?.bytes).toEqual(
      new Uint8Array([0, 255, 128]),
    )
  })

  it('accepts BCP-47 extension tags and the valid RFC-3339 year 0001', () => {
    const value = validDocument()
    value.metadata.language = 'en-US-u-ca-gregory'
    value.metadata.publicationDate = '0001-01-01'
    value.metadata.updated = '0001-12-31'
    seal(value)

    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it.each([
    [
      'calendar-normalized timestamp',
      (value: any) =>
        (value.metadata.artifactModifiedAt = '2026-02-30T00:00:00Z'),
    ],
    [
      'duplicate BCP-47 extension singleton',
      (value: any) => (value.metadata.language = 'en-a-foo-a-bar'),
    ],
    [
      'duplicate BCP-47 variant',
      (value: any) => (value.metadata.language = 'de-1901-1901'),
    ],
    ['MIME wildcard', (value: any) => (value.assets[0].mediaType = '*/*')],
  ])('rejects an invalid %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    seal(value)

    expect(() => decodeStructDocument(value)).toThrow()
  })

  it.each([
    'i-klingon',
    'de-1901',
    'sl-rozaj-biske-1994',
    'en-US-u-ca-gregory',
    'x-private-private',
    'en-x-a-a',
    'en-a-foo-x-a-a',
    'en-x-private-x-again',
  ])('accepts the BCP-47 language tag %s', (language) => {
    const value = validDocument()
    value.metadata.language = language
    seal(value)

    expect(() => decodeStructDocument(value)).not.toThrow()
  })

  it('rejects an unpadded base64 payload exceeding the asset bound before allocation', () => {
    const encoded = 'AAAA'.repeat(Math.ceil((MAX_STRUCT_ASSET_BYTES + 1) / 3))

    expect(() => parseBytes(encoded, '$.asset.bytes')).toThrow(
      /resource bound/i,
    )
  })

  it('accepts a base64 asset payload above the general text bound when its decoded size is bounded', () => {
    const encoded = 'AAAA'.repeat(Math.ceil((MAX_STRUCT_STRING_BYTES + 4) / 4))

    expect(preflightBytes(encoded, '$.asset.bytes')).toBe(
      (encoded.length / 4) * 3,
    )
  })

  it('rejects an oversized Uint8Array asset before copying it', () => {
    const bytes = new Uint8Array(MAX_STRUCT_ASSET_BYTES + 1)

    expect(() => parseBytes(bytes, '$.asset.bytes')).toThrow(/resource bound/i)
  })

  it('copies a large canonical Uint8Array without materializing numeric keys or descriptors', () => {
    const bytes = new Uint8Array(1024 * 1024)
    bytes[0] = 17
    bytes[bytes.length - 1] = 29
    const ownKeys = Reflect.ownKeys
    const descriptor = Object.getOwnPropertyDescriptor
    Reflect.ownKeys = ((value: object) => {
      if (value === bytes) throw new Error('numeric keys were materialized')
      return ownKeys(value)
    }) as typeof Reflect.ownKeys
    Object.getOwnPropertyDescriptor = ((value: object, key: PropertyKey) => {
      if (value === bytes && /^(?:0|[1-9]\d*)$/u.test(String(key)))
        throw new Error('numeric descriptor was inspected')
      return descriptor(value, key)
    }) as typeof Object.getOwnPropertyDescriptor

    try {
      const snapshot = parseBytes(bytes, '$.asset.bytes')
      expect(snapshot).not.toBe(bytes)
      expect(snapshot[0]).toBe(17)
      expect(snapshot[snapshot.length - 1]).toBe(29)
    } finally {
      Reflect.ownKeys = ownKeys
      Object.getOwnPropertyDescriptor = descriptor
    }
  })

  it('rejects aggregate asset bytes before decoding or hashing an earlier payload', () => {
    const value = validDocument() as any
    const sparseMaximum = new Array(MAX_STRUCT_ASSET_BYTES)
    let laterOwnKeys = 0
    value.assets = [
      { ...value.assets[0], bytes: sparseMaximum },
      {
        ...value.assets[0],
        id: 'asset-2',
        href: 'assets/asset-2.bin',
        bytes: [0],
      },
      new Proxy(
        {},
        {
          ownKeys() {
            laterOwnKeys += 1
            throw new Error('later asset was enumerated')
          },
        },
      ),
    ]

    try {
      decodeStructDocument(value)
      throw new Error('expected aggregate asset bound failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('ASSET_BOUNDS')
      expect((error as StructCodecError).path).toBe('$.assets')
    }
    expect(laterOwnKeys).toBe(0)
  })

  it.each([
    [
      'issues',
      10_001,
      (value: any, entries: unknown[]) => (value.recovery.issues = entries),
    ],
    [
      'pages',
      100_001,
      (value: any, entries: unknown[]) =>
        (value.recovery.issues[0].pages = entries),
    ],
  ])(
    'rejects oversized recovery %s before snapshotting its keys',
    (_label, length, assign) => {
      const value = validDocument() as any
      let ownKeyReads = 0
      const entries = new Proxy(new Array(length), {
        ownKeys() {
          ownKeyReads += 1
          throw new Error('oversized recovery keys were snapshotted')
        },
      })
      assign(value, entries)

      try {
        decodeStructDocument(value)
        throw new Error('expected recovery bound failure')
      } catch (error) {
        expect(error).toBeInstanceOf(StructCodecError)
        expect((error as StructCodecError).code).toBe('BUDGET')
        expect(ownKeyReads).toBe(0)
      }
    },
  )

  it('preserves JSON text whitespace without coercion', () => {
    const value = validDocument() as any
    value.metadata.abstract = 'Abstract\nwith\twhitespace'
    value.blocks[0].text = 'Hello\n'
    value.receipt.textCharacterCount = 6
    value.receipt.conservation.sourceTextCharacterCount = 6
    value.receipt.conservation.structTextCharacterCount = 6
    seal(value)

    const decoded = decodeStructDocument(value)

    expect(decoded.metadata.abstract).toBe('Abstract\nwith\twhitespace')
    expect(decoded.blocks[0]?.text).toBe('Hello\n')
  })

  it.each([
    ['document', (value: any) => (value.extra = true)],
    ['source', (value: any) => (value.source.extra = true)],
    ['metadata', (value: any) => (value.metadata.extra = true)],
    [
      'author affiliation',
      (value: any) => (value.metadata.authorAffiliations[0].extra = true),
    ],
    [
      'author note',
      (value: any) => (value.metadata.authorNotes[0].extra = true),
    ],
    ['block', (value: any) => (value.blocks[0].extra = true)],
    ['inline', (value: any) => (value.blocks[0].inline[0].extra = true)],
    ['evidence', (value: any) => (value.blocks[0].evidence.extra = true)],
    ['box', (value: any) => (value.blocks[0].evidence.boxes[0].extra = true)],
    ['table', (value: any) => (value.blocks[0].table.extra = true)],
    [
      'table cell',
      (value: any) => (value.blocks[0].table.cells[0].extra = true),
    ],
    ['furniture', (value: any) => (value.blocks[0].furniture.extra = true)],
    [
      'furniture review',
      (value: any) => (value.blocks[0].furnitureReview.extra = true),
    ],
    ['asset', (value: any) => (value.assets[0].extra = true)],
    ['relationship', (value: any) => (value.relationships[0].extra = true)],
    [
      'relationship candidate',
      (value: any) => (value.relationships[0].candidates[0].extra = true),
    ],
    ['page', (value: any) => (value.pages[0].extra = true)],
    ['page column', (value: any) => (value.pages[0].columns[0].extra = true)],
    ['diagnostic', (value: any) => (value.diagnostics[0].extra = true)],
    ['recovery', (value: any) => (value.recovery.extra = true)],
    ['recovery issue', (value: any) => (value.recovery.issues[0].extra = true)],
    ['receipt', (value: any) => (value.receipt.extra = true)],
    ['conservation', (value: any) => (value.receipt.conservation.extra = true)],
  ])('rejects an unknown field at the %s object layer', (_layer, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/unknown field/i)
  })

  it.each([
    ['schemaVersion', (value: any) => (value.schemaVersion = 1)],
    ['source', (value: any) => (value.source = 'source')],
    ['blocks', (value: any) => (value.blocks = {})],
    ['block kind', (value: any) => (value.blocks[0].kind = 1)],
    ['inline start', (value: any) => (value.blocks[0].inline[0].start = '0')],
    ['asset bytes', (value: any) => (value.assets[0].bytes = ['0'])],
    ['recovery status', (value: any) => (value.recovery.status = false)],
  ])('rejects a wrong primitive for %s', (_field, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow()
  })

  it('rejects non-finite numeric values without coercion', () => {
    const value = validDocument()
    value.blocks[0].evidence.confidence = Number.NaN
    expect(() => decodeStructDocument(value)).toThrow(/finite/i)
  })

  it('rejects inline ranges outside their owning text', () => {
    const value = validDocument()
    value.blocks[0].inline[0].end = 6
    expect(() => decodeStructDocument(value)).toThrow(/text length/i)
  })

  it.each([
    [
      'duplicate block id',
      (value: any) => value.blocks.push({ ...value.blocks[0] }),
    ],
    [
      'duplicate relationship target',
      (value: any) => (value.relationships[0].to = ['block-1', 'block-1']),
    ],
    [
      'duplicate inline target',
      (value: any) =>
        (value.blocks[0].inline[0].targetIds = ['block-1', 'block-1']),
    ],
    [
      'duplicate author note id',
      (value: any) =>
        value.metadata.authorNotes.push({
          ...value.metadata.authorNotes[0],
        }),
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate/i)
  })

  it.each([
    ['block id', (value: any) => (value.blocks[0].id = '../block')],
    ['asset id', (value: any) => (value.assets[0].id = 'asset id')],
    ['document id', (value: any) => (value.documentId = ' document')],
  ])('rejects a non-canonical %s', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/identifier|id/i)
  })

  it('rejects malformed bytes and preserves no binary object representation', () => {
    const value = validDocument()
    for (const bytes of ['not-base64', 'AB==']) {
      value.assets[0].bytes = bytes
      expect(() => decodeStructDocument(value)).toThrow(/base64/i)
    }

    const jsonValue = JSON.parse(JSON.stringify(validDocument()))
    jsonValue.assets[0].bytes = [0, 255, 128]
    expect(decodeStructDocument(jsonValue).assets[0]?.bytes).toEqual(
      new Uint8Array([0, 255, 128]),
    )
    jsonValue.assets[0].bytes = { 0: 0, 1: 255, 2: 128 }
    expect(() => decodeStructDocument(jsonValue)).toThrow()
  })

  it('copies only intrinsic bytes without invoking enumerable string expandos', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    let getterCalls = 0
    Object.defineProperty(bytes, 'extra', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('expando getter invoked')
      },
    })
    value.assets[0].bytes = bytes as any

    const snapshot = decodeStructDocument(value).assets[0]!.bytes!
    expect(snapshot).toEqual(new Uint8Array([0, 255, 128]))
    expect(Object.hasOwn(snapshot, 'extra')).toBe(false)
    expect(getterCalls).toBe(0)
  })

  it('copies only intrinsic bytes without reading symbol expandos', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    const extra = Symbol('extra')
    Object.defineProperty(bytes, extra, { value: 'not byte data' })
    value.assets[0].bytes = bytes as any

    const snapshot = decodeStructDocument(value).assets[0]!.bytes!
    expect(snapshot).toEqual(new Uint8Array([0, 255, 128]))
    expect(Object.hasOwn(snapshot, extra)).toBe(false)
  })

  it('rejects Uint8Array subclasses rather than discarding their prototype state', () => {
    const value = validDocument()
    class SubclassedBytes extends Uint8Array {}
    value.assets[0].bytes = new SubclassedBytes([0, 255, 128]) as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('rejects a spoofed Uint8Array brand after a mutating toStringTag getter', () => {
    const value = validDocument()
    const bytes = new Int8Array([0, -1, -128])
    Object.setPrototypeOf(bytes, Uint8Array.prototype)
    Object.defineProperty(bytes, Symbol.toStringTag, {
      configurable: true,
      get() {
        delete (bytes as any)[Symbol.toStringTag]
        return 'Uint8Array'
      },
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
  })

  it('copies intrinsic bytes without invoking a toStringTag expando', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    let getterCalls = 0
    Object.defineProperty(bytes, Symbol.toStringTag, {
      configurable: true,
      get() {
        getterCalls += 1
        delete (bytes as any)[Symbol.toStringTag]
        return 'Uint8Array'
      },
    })
    value.assets[0].bytes = bytes as any

    expect(decodeStructDocument(value).assets[0]!.bytes).toEqual(
      new Uint8Array([0, 255, 128]),
    )
    expect(getterCalls).toBe(0)
    expect(Object.hasOwn(bytes, Symbol.toStringTag)).toBe(true)
  })

  it('rejects an own length accessor without invoking or mutating through it', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    const before = [...bytes]
    let getterCalls = 0
    Object.defineProperty(bytes, 'length', {
      configurable: true,
      get() {
        getterCalls += 1
        bytes[0] = 17
        return before.length
      },
    })
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
    expect(getterCalls).toBe(0)
    expect([...bytes]).toEqual(before)
    expect(Object.getOwnPropertyDescriptor(bytes, 'length')?.get).toBeTypeOf(
      'function',
    )
  })

  it('rejects non-index bytes before touching a proxy prototype', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    Object.defineProperty(bytes, 'extra', { value: true })
    const traps = { get: 0, ownKeys: 0, descriptor: 0 }
    const prototype = new Proxy(Uint8Array.prototype, {
      get(target, property, receiver) {
        traps.get += 1
        return Reflect.get(target, property, receiver)
      },
      ownKeys(target) {
        traps.ownKeys += 1
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, property) {
        traps.descriptor += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    Object.setPrototypeOf(bytes, prototype)
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
    expect(traps).toEqual({ get: 0, ownKeys: 0, descriptor: 0 })
  })

  it('rejects proxy prototypes before reflective traps can mutate the input', () => {
    const value = validDocument()
    const bytes = new Uint8Array([0, 255, 128])
    const before = [...bytes]
    const traps = { ownKeys: 0, descriptor: 0, constructorGet: 0 }
    const constructor = new Proxy(Uint8Array, {
      get(target, property, receiver) {
        if (property === 'prototype') {
          traps.constructorGet += 1
          bytes[0] = 17
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const prototype = new Proxy(Uint8Array.prototype, {
      ownKeys(target) {
        traps.ownKeys += 1
        bytes[0] = 17
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, property) {
        traps.descriptor += 1
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        return property === 'constructor' && descriptor !== undefined
          ? { ...descriptor, value: constructor }
          : descriptor
      },
    })
    Object.setPrototypeOf(bytes, prototype)
    value.assets[0].bytes = bytes as any

    expect(() => decodeStructDocument(value)).toThrow(/asset|bytes/i)
    expect(traps).toEqual({ ownKeys: 0, descriptor: 0, constructorGet: 0 })
    expect([...bytes]).toEqual(before)
  })

  it('rejects cross-realm Uint8Array values in favor of JSON-safe byte forms', () => {
    const value = validDocument()
    value.assets[0].bytes = runInNewContext(
      'new Uint8Array([0, 255, 128])',
    ) as any

    expect(() => decodeStructDocument(value)).toThrow(
      /canonical Uint8Array|asset|bytes/i,
    )
  })

  it('verifies present asset bytes against the declared SHA-256 and permits absent bytes', () => {
    const tampered = validDocument()
    tampered.assets[0].bytes = 'AP+B'
    expect(() => decodeStructDocument(tampered)).toThrow(/asset|bytes|sha256/i)

    const absent = validDocument()
    delete (absent.assets[0] as any).bytes
    expect(() => decodeStructDocument(absent)).not.toThrow()
  })

  it('keeps a supported 0.1.0 document unchanged through migration', () => {
    const migrated = migrateStructDocument(validDocument())
    expect(migrated.schemaVersion).toBe('0.1.0')
    expect(migrated).not.toHaveProperty('documentId')
    expect(migrated.receipt).not.toHaveProperty('documentId')
  })

  it('canonically decodes the declared current 0.2.0 binding without migration', () => {
    const value = validDocument() as any
    value.schemaVersion = '0.2.0'
    value.documentId = 'fixture-document'
    value.receipt.schemaVersion = '0.2.0'
    value.receipt.documentId = 'fixture-document'
    seal(value)

    expect(migrateStructDocument(value)).toMatchObject({
      schemaVersion: '0.2.0',
      documentId: 'fixture-document',
      receipt: { schemaVersion: '0.2.0', documentId: 'fixture-document' },
    })
  })

  it('strictly decodes the optional model consultation receipt on 0.2.0', () => {
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

    const decoded = decodeStructDocument(value)
    expect(decoded.receipt.modelConsultations).toMatchObject({
      schemaVersion: '1.0.0',
      documentId: 'fixture-document',
    })

    value.receipt.modelConsultations.extra = true
    expect(() => decodeStructDocument(value)).toThrow()
  })

  it.each([
    { label: 'null', member: null },
    { label: 'scalar', member: 'malformed' },
    { label: 'number', member: 7 },
    { label: 'array', member: [] },
  ])(
    'rejects a non-record consultation or decision member after resealing ($label)',
    ({ member }) => {
      for (const field of ['consultations', 'decisions'] as const) {
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
        value.receipt.modelConsultations[field] = [member]
        seal(value)

        expect(() => decodeStructDocument(value)).toThrow(
          /model|receipt|consultation|decision/i,
        )
      }
    },
  )

  it('rejects a resealed consultation receipt with a noncanonical array prototype', () => {
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
    const customPrototype = Object.create(Array.prototype, {
      custom: { value: true, enumerable: false },
    })
    Object.setPrototypeOf(
      value.receipt.modelConsultations.consultations,
      customPrototype,
    )
    seal(value)

    expect(() => decodeStructDocument(value)).toThrow(
      /model|receipt|array|prototype/i,
    )
  })

  it.each(['0.3.0', '9.9.9', '', null, 1])(
    'fails closed on unknown schema version %s',
    (schemaVersion) => {
      const value = validDocument()
      value.schemaVersion = schemaVersion as never
      expect(() => migrateStructDocument(value)).toThrow(/schema version/i)
    },
  )

  it('contains cyclic and bigint schema versions as StructCodecError', () => {
    const cyclic = validDocument() as any
    const version: any = {}
    version.self = version
    cyclic.schemaVersion = version
    expect(() => decodeStructDocument(cyclic)).toThrow(StructCodecError)

    const bigint = validDocument() as any
    bigint.schemaVersion = 1n
    expect(() => decodeStructDocument(bigint)).toThrow(StructCodecError)
  })

  it('verifies the canonical generated digest for both supported versions', () => {
    expect(() => decodeStructDocument(validDocument())).not.toThrow()

    const legacy = validDocument()
    legacy.receipt.generatedSha256 = hash
    expect(() => decodeStructDocument(legacy)).toThrow(/digest|sha256/i)

    const current = validDocument() as any
    current.schemaVersion = '0.2.0'
    current.documentId = 'fixture-document'
    current.receipt.schemaVersion = '0.2.0'
    current.receipt.documentId = 'fixture-document'
    seal(current)
    expect(() => decodeStructDocument(current)).not.toThrow()
    current.receipt.generatedSha256 = hash
    expect(() => decodeStructDocument(current)).toThrow(/digest|sha256/i)
  })

  it.each([
    [
      'relationship from',
      (value: any) => (value.relationships[0].from = 'missing'),
    ],
    [
      'relationship to',
      (value: any) => (value.relationships[0].to = ['missing']),
    ],
    ['page block', (value: any) => (value.pages[0].blocks = ['missing'])],
    [
      'page column block',
      (value: any) => (value.pages[0].columns[0].blockIds = ['missing']),
    ],
    [
      'fallback asset',
      (value: any) => (value.blocks[0].fallbackAssetIds = ['missing']),
    ],
    [
      'inline target',
      (value: any) => (value.blocks[0].inline[0].targetIds = ['missing']),
    ],
    [
      'author note target',
      (value: any) => (value.metadata.authorNotes[0].target = 'missing'),
    ],
  ])('rejects a dangling %s reference', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(
      /reference|target|dangling/i,
    )
  })

  it.each([
    ['asset and block', (value: any) => (value.assets[0].id = 'block-1')],
    [
      'diagnostic and block',
      (value: any) => (value.diagnostics[0].id = 'block-1'),
    ],
    [
      'relationship and block',
      (value: any) => (value.relationships[0].id = 'block-1'),
    ],
  ])('rejects cross-category duplicate ids (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it.each([
    [
      'author notes within the namespace',
      (value: any) =>
        value.metadata.authorNotes.push({
          ...value.metadata.authorNotes[0],
        }),
    ],
    [
      'source observation anchors within the namespace',
      (value: any) =>
        (value.blocks[0].sourceObservationAnchorIds = ['anchor-1', 'anchor-1']),
    ],
    [
      'author note and block',
      (value: any) => (value.metadata.authorNotes[0].id = 'block-1'),
    ],
    [
      'author note and source observation anchor',
      (value: any) => (value.metadata.authorNotes[0].id = 'anchor-1'),
    ],
    [
      'source observation anchor and block',
      (value: any) =>
        (value.blocks[0].sourceObservationAnchorIds = ['block-1']),
    ],
    [
      'source observation anchors across blocks',
      (value: any) => {
        value.blocks.push({
          ...value.blocks[0],
          id: 'block-2',
          order: 1,
          page: null,
          text: '',
          inline: [],
          sourceObservationAnchorIds: ['anchor-1'],
        })
        value.receipt.blockCount = value.blocks.length
        value.receipt.conservation.structBlockCount = value.blocks.length
      },
    ],
  ])('rejects semantic ids reused across namespaces (%s)', (_label, mutate) => {
    const value = validDocument()
    mutate(value)
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/DUPLICATE_IDENTIFIER/i)
  })

  it('rejects emitted XHTML ids that collide after stable normalization', () => {
    const value = validDocument()
    value.metadata.authorNotes![0].id = '1'
    value.blocks[0].sourceObservationAnchorIds = ['n-1']
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => renderPublicationXhtml(value as any)).toThrow(
      /duplicate|identifier/i,
    )
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
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => renderPublicationXhtml(value)).toThrow(/duplicate|identifier/i)
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
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => renderPublicationXhtml(value)).toThrow(/duplicate|identifier/i)
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

  it('rejects nested inline ownership before rendering large markup', () => {
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
    try {
      decodeStructDocument(value)
      throw new Error('expected nested ownership budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StructCodecError)
      expect((error as StructCodecError).code).toBe('BUDGET')
      expect((error as StructCodecError).path).toBe('$.blocks[0].inline[0]')
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
  })

  it('reports semantic expansion as a path-bearing strict budget failure', async () => {
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
    expect(() => decodeStructDocument(value)).toThrow(StructCodecError)
    try {
      decodeStructDocument(value)
    } catch (error) {
      expect((error as StructCodecError).code).toBe('BUDGET')
      expect((error as StructCodecError).path).toMatch(/blocks\[0\]\.inline/)
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
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
    expect(() => renderPublicationXhtml(value)).not.toThrow()
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
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
    expect(() => renderPublicationXhtml(value)).not.toThrow()
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
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

    expect(() => renderPublicationXhtml(value)).toThrow(/citation.*budget/i)
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
    expect(() => renderPublicationXhtml(value)).toThrow(/budget/i)
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

  it('does not plan discarded inline runs on a real table block', () => {
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
    expect(xhtml).not.toContain('x'.repeat(runCount))
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
    expect(() => renderPublicationXhtml(value)).not.toThrow()
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
    expect(() => renderPublicationXhtml(value)).not.toThrow()
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

  it('rejects numeric asset ids before publication can diverge', () => {
    const value = validDocument() as any
    value.assets[0].id = '1'
    value.blocks[0].fallbackAssetIds = ['1']
    value.relationships[0].to = ['1']
    value.relationships[0].candidates[0].target = '1'
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/asset|identifier/i)
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

  it('rejects later-position source anchors through decode and migration', () => {
    const value = validDocument() as any
    value.blocks[0].sourceObservationAnchorIds = ['anchor-1', 'n-1']
    value.metadata.authorNotes[0].id = '1'
    seal(value)
    expect(() => decodeStructDocument(value)).toThrow(/duplicate|identifier/i)
    expect(() => migrateStructDocument(value)).toThrow(/duplicate|identifier/i)
  })

  it('maps later-position anchors from every block into migration validation', () => {
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
    expect(() => migrateStructDocument(value)).toThrow(/duplicate|identifier/i)
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
      value[field] = new Proxy(new Array(100_001), {
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
