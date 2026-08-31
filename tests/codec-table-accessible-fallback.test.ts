import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  decodeCompatibleStructDocument,
  decodeStructDocument,
  encodeStructDocument,
  STRUCT_SCHEMA_VERSION,
  StructCodecError,
  type StructSchemaVersion,
  type StructTable,
  type StructTableAccessibleFallback,
} from '../src/document/index'
import { seal, validDocument } from './codec-fixtures'

type FixtureDocument = any

const completeFallback = {
  kind: 'block-text',
  completeness: 'complete',
  accessibleNameSource: 'block-label',
} as const

function bindVersion(
  document: FixtureDocument,
  schemaVersion: '0.1.0' | '0.2.0' | '0.3.0',
) {
  document.schemaVersion = schemaVersion
  document.receipt.schemaVersion = schemaVersion
  if (schemaVersion === '0.1.0') {
    delete document.documentId
    delete document.receipt.documentId
    delete document.receipt.modelConsultations
  } else {
    document.documentId = 'fixture-document'
    document.receipt.documentId = 'fixture-document'
  }
  return document
}

function setBlockText(document: FixtureDocument, text: string) {
  document.blocks[0].text = text
  document.blocks[0].inline = []
  document.receipt.textCharacterCount = text.length
  document.receipt.conservation.sourceTextCharacterCount = text.length
  document.receipt.conservation.structTextCharacterCount = text.length
  return document
}

function tableDocument(
  schemaVersion: '0.1.0' | '0.2.0' | '0.3.0' = '0.3.0',
) {
  const document = bindVersion(validDocument() as FixtureDocument, schemaVersion)
  document.blocks[0].kind = 'table'
  document.blocks[0].table.semantic = 'source-preserved'
  document.blocks[0].table.accessibleFallback = { ...completeFallback }
  return seal(document)
}

function expectCodecError(
  document: FixtureDocument,
  code: string,
  path: string,
) {
  seal(document)
  try {
    decodeStructDocument(document)
    throw new Error('expected decodeStructDocument to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(StructCodecError)
    expect(error).toMatchObject({ code, path })
  }
}

describe('Struct table accessible fallback schema 0.3.0', () => {
  it('publishes the new schema and closed accessible-fallback types', () => {
    STRUCT_SCHEMA_VERSION satisfies '0.3.0'
    expect(STRUCT_SCHEMA_VERSION).toBe('0.3.0')
    expectTypeOf<'0.1.0'>().toMatchTypeOf<StructSchemaVersion>()
    expectTypeOf<'0.2.0'>().toMatchTypeOf<StructSchemaVersion>()
    expectTypeOf<'0.3.0'>().toMatchTypeOf<StructSchemaVersion>()
    expectTypeOf<StructTable['accessibleFallback']>().toEqualTypeOf<
      StructTableAccessibleFallback | undefined
    >()

    const fallback: StructTableAccessibleFallback = completeFallback
    expect(fallback).toEqual(completeFallback)
  })

  it.each(['block-label', 'block-text'] as const)(
    'strictly decodes and canonically round-trips a complete %s declaration',
    (accessibleNameSource) => {
      const value = tableDocument()
      value.blocks[0].table.accessibleFallback.accessibleNameSource =
        accessibleNameSource
      if (accessibleNameSource === 'block-text') delete value.blocks[0].label
      seal(value)

      const decoded = decodeStructDocument(value)
      const encoded = encodeStructDocument(decoded)

      expect(decoded).toMatchObject({
        schemaVersion: '0.3.0',
        blocks: [
          {
            table: {
              semantic: 'source-preserved',
              accessibleFallback: {
                kind: 'block-text',
                completeness: 'complete',
                accessibleNameSource,
              },
            },
          },
        ],
      })
      expect(encoded.blocks[0]?.table?.accessibleFallback).toEqual(
        decoded.blocks[0]?.table?.accessibleFallback,
      )
      expect(decodeStructDocument(encoded)).toEqual(decoded)
    },
  )

  it('keeps an absent declaration absent instead of inferring completeness', () => {
    const value = tableDocument()
    delete value.blocks[0].table.accessibleFallback
    seal(value)

    const decoded = decodeCompatibleStructDocument(value)

    expect(decoded.schemaVersion).toBe('0.3.0')
    expect(decoded.blocks[0]?.table).not.toHaveProperty('accessibleFallback')
  })

  it.each(['0.1.0', '0.2.0'] as const)(
    'retains strict %s decoding without adding or inferring the declaration',
    (schemaVersion) => {
      const value = tableDocument(schemaVersion)
      delete value.blocks[0].table.accessibleFallback
      seal(value)

      const decoded = decodeCompatibleStructDocument(value)

      expect(decoded.schemaVersion).toBe(schemaVersion)
      expect(decoded.blocks[0]?.table).not.toHaveProperty('accessibleFallback')
      expect(encodeStructDocument(decoded)).not.toHaveProperty(
        'blocks.0.table.accessibleFallback',
      )
    },
  )

  it.each(['0.1.0', '0.2.0'] as const)(
    'rejects the 0.3.0 field as unknown on schema %s',
    (schemaVersion) => {
      expectCodecError(
        tableDocument(schemaVersion),
        'UNKNOWN_FIELD',
        '$.blocks[0].table.accessibleFallback',
      )
    },
  )

  it.each([
    ['verified', 'verified'],
    ['unresolved', 'unresolved'],
  ] as const)(
    'prohibits the declaration for %s table semantics',
    (_label, semantic) => {
      const value = tableDocument()
      value.blocks[0].table.semantic = semantic
      expectCodecError(
        value,
        'TABLE_ACCESSIBLE_FALLBACK',
        '$.blocks[0].table.accessibleFallback',
      )
    },
  )

  it('requires the declaration to belong to a source-preserved table block', () => {
    const value = tableDocument()
    value.blocks[0].kind = 'paragraph'
    expectCodecError(
      value,
      'TABLE_ACCESSIBLE_FALLBACK',
      '$.blocks[0].table.accessibleFallback',
    )
  })

  it('requires document recovery to be ready', () => {
    const value = tableDocument()
    value.recovery.status = 'review-required'
    expectCodecError(
      value,
      'TABLE_ACCESSIBLE_FALLBACK',
      '$.recovery.status',
    )
  })

  it('requires nonempty retained block text even when the label supplies the name', () => {
    const value = setBlockText(tableDocument(), '')
    expectCodecError(
      value,
      'TABLE_ACCESSIBLE_FALLBACK',
      '$.blocks[0].text',
    )
  })

  it.each(['missing', 'empty'] as const)(
    'requires a nonempty selected block label when it is %s',
    (condition) => {
      const value = tableDocument()
      if (condition === 'missing') delete value.blocks[0].label
      else value.blocks[0].label = ''
      expectCodecError(
        value,
        'TABLE_ACCESSIBLE_FALLBACK',
        '$.blocks[0].label',
      )
    },
  )

  it.each([
    ['kind', 'retained-text'],
    ['completeness', 'partial'],
    ['accessibleNameSource', 'asset'],
  ] as const)('closes the %s enum', (field, invalidValue) => {
    const value = tableDocument()
    value.blocks[0].table.accessibleFallback[field] = invalidValue
    expectCodecError(
      value,
      'ENUM',
      `$.blocks[0].table.accessibleFallback.${field}`,
    )
  })

  it('rejects unknown declaration fields', () => {
    const value = tableDocument()
    value.blocks[0].table.accessibleFallback.note = 'not declared'
    expectCodecError(
      value,
      'UNKNOWN_FIELD',
      '$.blocks[0].table.accessibleFallback.note',
    )
  })
})
