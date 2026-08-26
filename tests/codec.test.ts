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
import { hash, seal, validDocument } from './codec-fixtures'

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
})
