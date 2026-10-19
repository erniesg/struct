// S04 document compatibility matrix: legacy (`0.1.0`), current (`0.2.0`), and
// unsupported schema versions.
//
// Scope note: this lane owns the *document* compatibility matrix only. The
// Bundle negative matrix requires the `./bundle` export, which is still
// unavailable pending S-03, so it is explicitly not claimed here. See
// docs/s04-release-matrix-2026-10-20.md for the remaining S04 gaps.
//
// The matrix is keyed by the published version constants so that a future
// Bundle schema axis can reuse the same expectations without rewriting them.

import { describe, expect, it } from 'vitest'
import {
  decodeCompatibleStructDocument,
  decodeStructDocument,
  migrateStructDocument,
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
  StructCodecError,
} from '../src/document/index'
import * as rootFacade from '../src/index'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import { buildStructEpub } from '../src/renderers/epub'
import {
  buildS04Document,
  finalizeS04Document,
  legacyDocument,
  currentDocument,
  unsupportedDocument,
} from './fixtures/s04/documents'

const SUPPORTED_VERSIONS = [
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
] as const

const UNSUPPORTED_VERSIONS: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ['next minor 0.3.0', '0.3.0'],
  ['next major 1.0.0', '1.0.0'],
  ['patch drift 0.2.1', '0.2.1'],
  ['truncated 0.2', 0.2],
  ['null', null],
  ['padded 0.2.0', ' 0.2.0'],
]

describe('S04 document compatibility matrix', () => {
  it('publishes exactly the legacy and current schema versions', () => {
    expect(LEGACY_STRUCT_SCHEMA_VERSION).toBe('0.1.0')
    expect(STRUCT_SCHEMA_VERSION).toBe('0.2.0')
    expect(rootFacade.LEGACY_STRUCT_SCHEMA_VERSION).toBe('0.1.0')
    expect(rootFacade.STRUCT_SCHEMA_VERSION).toBe('0.2.0')
    expect(typeof rootFacade.decodeCompatibleStructDocument).toBe('function')
    expect(typeof rootFacade.decodeStructDocument).toBe('function')
    expect(typeof rootFacade.encodeStructDocument).toBe('function')
  })

  it.each(SUPPORTED_VERSIONS)(
    'decodes a supported document at its declared version %s without transforming it',
    (version) => {
      const document =
        version === LEGACY_STRUCT_SCHEMA_VERSION
          ? legacyDocument()
          : currentDocument()
      const decoded = decodeStructDocument(document)
      expect(decoded.schemaVersion).toBe(version)
      expect(decoded.receipt.schemaVersion).toBe(version)
      expect(decoded.blocks.length).toBeGreaterThan(0)

      const compatible = decodeCompatibleStructDocument(document)
      expect(compatible.schemaVersion).toBe(version)
      expect(compatible.receipt.generatedSha256).toBe(
        decoded.receipt.generatedSha256,
      )

      // The deprecated prerelease alias keeps the same decode-compatibility
      // behavior and must not migrate the declared version either.
      const aliased = migrateStructDocument(document)
      expect(aliased.schemaVersion).toBe(version)
      expect(aliased.receipt.generatedSha256).toBe(
        decoded.receipt.generatedSha256,
      )
    },
  )

  it.each(SUPPORTED_VERSIONS)(
    'renders a supported document through the public XHTML and EPUB boundaries (%s)',
    async (version) => {
      const document =
        version === LEGACY_STRUCT_SCHEMA_VERSION
          ? legacyDocument()
          : currentDocument()
      const xhtml = renderPublicationXhtml(document)
      expect(xhtml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
        true,
      )
      expect(xhtml).toContain('<h1 id="s04-title"')
      const epub = await buildStructEpub(document)
      expect(epub.mediaType).toBe('application/epub+zip')
      expect(epub.entries).toContain('EPUB/content.xhtml')
      expect(epub.entries).toContain('EPUB/package.opf')
      expect(epub.identifier.startsWith('urn:sha256:')).toBe(true)
    },
  )

  it('keeps the legacy and current renderings byte-identical for equal semantics', async () => {
    const legacy = finalizeS04Document(
      buildS04Document('typography'),
      LEGACY_STRUCT_SCHEMA_VERSION,
    )
    const current = finalizeS04Document(
      buildS04Document('typography'),
      STRUCT_SCHEMA_VERSION,
    )
    const legacyXhtml = renderPublicationXhtml(legacy)
    const currentXhtml = renderPublicationXhtml(current)
    expect(legacyXhtml).toBe(currentXhtml)

    const legacyEpub = await buildStructEpub(legacy)
    const currentEpub = await buildStructEpub(current)
    // The packaged artifact differs because the EPUB identifier and
    // `EPUB/struct.json` bind the declared schema version and receipt.
    expect(legacyEpub.sha256).not.toBe(currentEpub.sha256)
    expect(legacyEpub.identifier).not.toBe(currentEpub.identifier)
  })

  it.each(UNSUPPORTED_VERSIONS)(
    'rejects an unsupported declared version (%s) fail-closed',
    (_label, value) => {
      const document = unsupportedDocument(value)
      for (const decode of [
        decodeStructDocument,
        decodeCompatibleStructDocument,
        migrateStructDocument,
      ]) {
        let thrown: unknown
        try {
          decode(document)
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(StructCodecError)
        expect((thrown as StructCodecError).code).toBe('SCHEMA_VERSION')
        expect((thrown as StructCodecError).path).toBe('$.schemaVersion')
      }
    },
  )

  it('rejects an unsupported declared version through both renderer boundaries', async () => {
    const document = unsupportedDocument('0.3.0')
    expect(() => renderPublicationXhtml(document)).toThrow(StructCodecError)
    await expect(buildStructEpub(document)).rejects.toThrow(
      /STRUCT_RECEIPT_BINDING_MISMATCH/,
    )
  })

  it('rejects a legacy document that carries a current-version receipt binding', () => {
    const document: any = JSON.parse(JSON.stringify(legacyDocument()))
    document.receipt.schemaVersion = STRUCT_SCHEMA_VERSION
    expect(() => decodeStructDocument(document)).toThrow(StructCodecError)
  })

  it('rejects a current document whose receipt digest does not match its content', () => {
    const document: any = JSON.parse(JSON.stringify(currentDocument()))
    document.receipt.generatedSha256 = 'f'.repeat(64)
    expect(() => decodeStructDocument(document)).toThrow(StructCodecError)
  })
})
