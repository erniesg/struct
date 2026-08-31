import { describe, expect, it } from 'vitest'
import {
  decodeStructDocument,
  StructCodecError,
  type StructDocument,
} from '../../src/document'
import { MAX_TABLE_DIMENSION } from '../../src/document/codec/parsers'
import { MAX_STRUCT_STRING_BYTES } from '../../src/document/codec/primitives'
import {
  assertStructEpubArchiveByteLength,
  buildStructEpub,
} from '../../src/renderers/epub'
import { normalizeStructDocumentForRenderer } from '../../src/renderers/ingress'
import { renderPublicationXhtml } from '../../src/renderers/xhtml'
import { MAX_RENDERED_INLINE_SEGMENTS } from '../../src/renderers/xhtml-plan'
import { sha256HexSync } from '../../src/sha256'
import { inspectXhtml } from './helpers/xml'
import {
  characterizeCodecRejection,
  characterizeRenderedCase,
  characterizeSealedDocument,
} from './baseline-characterization'
import {
  buildSealedSyntheticFixture,
  getSyntheticBoundsProbe,
  resealSyntheticDocument,
  syntheticAsset,
} from './fixture-builder'

const textEncoder = new TextEncoder()
const MAX_SYNTHETIC_XHTML_DEPTH = 128
const CANONICAL_XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8"?>'

function capture(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected synthetic publication rejection')
}

async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected synthetic publication rejection')
}

async function expectCodecFailureAtPublicationBoundaries(
  document: StructDocument,
  code: string,
  options: {
    epubMessage?: string
    forbiddenValue?: string
    path?: string
  } = {},
): Promise<void> {
  const errors = [
    capture(() => decodeStructDocument(document)),
    capture(() => normalizeStructDocumentForRenderer(document)),
    capture(() => renderPublicationXhtml(document)),
  ]
  for (const error of errors) {
    expect(error).toBeInstanceOf(StructCodecError)
    expect(error).toMatchObject({ code })
    if (options.path !== undefined)
      expect(error).toMatchObject({ path: options.path })
    if (options.forbiddenValue !== undefined)
      expect((error as Error).message).not.toContain(options.forbiddenValue)
  }

  let epubError: unknown
  try {
    await buildStructEpub(document)
  } catch (error) {
    epubError = error
  }
  expect(epubError).toBeInstanceOf(Error)
  if (options.epubMessage === undefined) {
    expect(epubError).toMatchObject({ name: 'StructCodecError', code })
    if (options.path !== undefined)
      expect(epubError).toMatchObject({ path: options.path })
  } else {
    expect((epubError as Error).message).toBe(options.epubMessage)
  }
  if (options.forbiddenValue !== undefined)
    expect((epubError as Error).message).not.toContain(options.forbiddenValue)
}

function withPackagedXhtml(
  document: StructDocument,
  href: string,
  bytes: Uint8Array,
): StructDocument {
  const asset = syntheticAsset('malformed-positive', {
    role: 'packaged-xhtml',
    href,
    mediaType: 'application/xhtml+xml',
    includeBytes: false,
    fallback: 'asset',
  })
  asset.bytes = bytes
  asset.sha256 = sha256HexSync(bytes)
  document.assets = [asset]
  resealSyntheticDocument(document)
  return document
}

function boundedPackagedXhtml(byteLength: number): Uint8Array {
  const prefix =
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><!--'
  const suffix = '--></body></html>'
  if (byteLength < prefix.length + suffix.length)
    throw new RangeError('synthetic XHTML bound is too small')
  return textEncoder.encode(
    `${prefix}${'x'.repeat(byteLength - prefix.length - suffix.length)}${suffix}`,
  )
}

function elementBoundPackagedXhtml(elementCount: number): Uint8Array {
  if (elementCount < 2)
    throw new RangeError('synthetic XHTML element bound is too small')
  return textEncoder.encode(
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${'<i/>'.repeat(elementCount - 2)}</body></html>`,
  )
}

function depthBoundPackagedXhtml(depth: number): Uint8Array {
  if (depth < 1)
    throw new RangeError('synthetic XHTML depth bound is too small')
  return textEncoder.encode(
    `<html xmlns="http://www.w3.org/1999/xhtml">${'<i>'.repeat(depth - 1)}${'</i>'.repeat(depth - 1)}</html>`,
  )
}

describe('Stage 2.1 malformed-input baseline characterization', () => {
  it('accepts the sealed malformed-control case without rendering diagnostic copy', async () => {
    const publication = await characterizeRenderedCase('malformed-positive')

    expect(publication.normalized.diagnostics).toEqual(
      publication.decoded.diagnostics,
    )
    expect(publication.normalized.diagnostics).toHaveLength(1)
    expect(publication.xhtml).not.toContain(
      publication.decoded.diagnostics[0]!.message,
    )
  })

  it('rejects an unknown block field consistently at all four boundaries', async () => {
    await characterizeCodecRejection('malformed-negative', 'UNKNOWN_FIELD')
  })
})

describe('Stage 6 malformed renderer and validation enforcement', () => {
  it.each([
    {
      code: 'LANGUAGE',
      label: 'invalid BCP-47 language',
      mutate(document: StructDocument) {
        document.metadata.language = 'invented_language'
      },
      path: '$.metadata.language',
    },
    {
      code: 'STRING',
      label: 'forbidden XML scalar',
      mutate(document: StructDocument) {
        document.metadata.abstract = 'invented\uD800value'
      },
      path: '$.metadata.abstract',
    },
    {
      code: 'NON_FINITE_NUMBER',
      label: 'non-finite structural number',
      mutate(document: StructDocument) {
        document.blocks[0]!.order = Number.POSITIVE_INFINITY
      },
      path: '$.blocks[0].order',
    },
    {
      code: 'NUMBER',
      label: 'negative zero',
      mutate(document: StructDocument) {
        document.blocks[0]!.order = -0
      },
      path: '$.blocks[0].order',
    },
  ])(
    'rejects a receipt-sealed $label with one stable codec category at every boundary',
    async ({ code, mutate, path }) => {
      const document = buildSealedSyntheticFixture('paragraph-positive')
      mutate(document)
      resealSyntheticDocument(document)
      await expectCodecFailureAtPublicationBoundaries(document, code, { path })
    },
  )

  it('rejects a dangling target without copying its value into any failure', async () => {
    const forbiddenValue = 'invented-sensitive-target'
    const document = buildSealedSyntheticFixture('paragraph-positive')
    document.blocks[0]!.inline = [
      { start: 0, end: 8, href: `#${forbiddenValue}` },
    ]
    resealSyntheticDocument(document)

    await expectCodecFailureAtPublicationBoundaries(document, 'REFERENCE', {
      epubMessage: 'STRUCT_EPUB_DANGLING_INTERNAL_REFERENCE',
      forbiddenValue,
      path: '$.blocks[0].inline[0].href',
    })
  })

  it('maps inconsistent receipt binding and digest failures to fixed EPUB errors', async () => {
    const binding = buildSealedSyntheticFixture('malformed-positive')
    binding.receipt.documentId = 'invented-mismatched-document'
    await expectCodecFailureAtPublicationBoundaries(binding, 'BINDING', {
      epubMessage: 'STRUCT_RECEIPT_BINDING_MISMATCH',
      forbiddenValue: 'invented-mismatched-document',
    })

    const digest = buildSealedSyntheticFixture('malformed-positive')
    digest.receipt.generatedSha256 = 'f'.repeat(64)
    await expectCodecFailureAtPublicationBoundaries(digest, 'DIGEST', {
      epubMessage: 'STRUCT_RECEIPT_DIGEST_MISMATCH',
    })
  })

  it('rejects an asset ID that shadows a fixed OPF metadata identifier', async () => {
    const document = buildSealedSyntheticFixture('assets-positive')
    document.assets[0]!.id = 'publication-title'
    document.blocks[0]!.fallbackAssetIds = ['publication-title']
    resealSyntheticDocument(document)

    await expect(buildStructEpub(document)).rejects.toThrow(
      'STRUCT_EPUB_ASSET_ID_INVALID',
    )
  })

  it('rejects malformed and entity-bearing packaged XHTML with fixed content-free errors', async () => {
    const malformedHref = 'assets/invented-sensitive-fragment.xhtml'
    const malformed = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      malformedHref,
      textEncoder.encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p></body></html>',
      ),
    )
    await expect(buildStructEpub(malformed)).rejects.toMatchObject({
      message: 'STRUCT_EPUB_XHTML_NOT_WELL_FORMED',
    })
    await expect(buildStructEpub(malformed)).rejects.not.toThrow(malformedHref)

    const entity = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      'assets/invented-entity.xhtml',
      textEncoder.encode(
        '<!DOCTYPE html [<!ENTITY invented "value">]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>&invented;</p></body></html>',
      ),
    )
    await expect(buildStructEpub(entity)).rejects.toMatchObject({
      message: 'STRUCT_EPUB_XHTML_FORBIDDEN_DECLARATION',
    })

    const externalDeclaration = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      'assets/invented-external-declaration.xhtml',
      textEncoder.encode(
        '<!DOCTYPE html SYSTEM "https://example.test/invented.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Invented.</p></body></html>',
      ),
    )
    await expect(buildStructEpub(externalDeclaration)).rejects.toMatchObject({
      message: 'STRUCT_EPUB_XHTML_FORBIDDEN_DECLARATION',
    })
  })

  it.each([
    [
      'external stylesheet',
      '<?xml-stylesheet type="text/css" href="https://example.test/invented-private.css"?>',
    ],
    [
      'external stylesheet after the XML declaration',
      `${CANONICAL_XML_DECLARATION}<?xml-stylesheet type="text/css" href="https://example.test/invented-private.css"?>`,
    ],
    ['generic instruction', '<?invented processing="instruction"?>'],
    ['noncanonical XML declaration', '<?xml version="1.0"?>'],
  ])(
    'rejects a packaged XHTML %s processing instruction before returning an archive',
    async (_label, instruction) => {
      const document = withPackagedXhtml(
        buildSealedSyntheticFixture('malformed-positive'),
        'assets/invented-processing-instruction.xhtml',
        textEncoder.encode(
          `${instruction}<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Invented.</p></body></html>`,
        ),
      )
      let archive: unknown
      const error = await captureRejection(async () => {
        archive = await buildStructEpub(document)
      })

      expect(archive).toBeUndefined()
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'STRUCT_EPUB_XHTML_FORBIDDEN_DECLARATION',
      )
    },
  )

  it('accepts the exact canonical XML declaration in packaged XHTML', async () => {
    const document = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      'assets/invented-canonical-declaration.xhtml',
      textEncoder.encode(
        `${CANONICAL_XML_DECLARATION}<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Invented.</p></body></html>`,
      ),
    )

    await expect(buildStructEpub(document)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it.each([
    ['query', '../content.xhtml?invented=1'],
    ['percent ambiguity', '../content%2exhtml'],
    ['Unicode whitespace', '../content\u2003.xhtml'],
    ['external credentials', 'https://reader:invented@example.test/item'],
    ['noncanonical external URL', 'https://example.test'],
    ['external scheme', 'javascript:invented'],
  ])(
    'rejects an unsafe packaged XHTML %s without echoing it',
    async (_label, reference) => {
      const document = withPackagedXhtml(
        buildSealedSyntheticFixture('malformed-positive'),
        'assets/invented-unsafe-reference.xhtml',
        textEncoder.encode(
          `<html xmlns="http://www.w3.org/1999/xhtml"><body><a href="${reference}">Invented.</a></body></html>`,
        ),
      )
      const error = await captureRejection(() => buildStructEpub(document))
      expect(error).toMatchObject({
        message: 'STRUCT_EPUB_XHTML_UNSAFE_HREF',
      })
      expect((error as Error).message).not.toContain(reference)
    },
  )

  it('rejects malformed direct-XHTML options without invoking accessors', () => {
    const document = buildSealedSyntheticFixture('malformed-positive')
    let accessorReads = 0
    const options = Object.defineProperty({}, 'styles', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'body {}'
      },
    })

    expect(() =>
      renderPublicationXhtml(document, options as never),
    ).toThrow('STRUCT_XHTML_OPTIONS_INVALID')
    expect(accessorReads).toBe(0)
  })

  it('rejects malformed EPUB profiles without invoking accessors or accepting unknown fields', async () => {
    const document = buildSealedSyntheticFixture('malformed-positive')
    let accessorReads = 0
    const profile = Object.defineProperty(
      {
        id: 'synthetic-profile',
        version: '1.0.0',
        fileName: 'synthetic.epub',
        pageProgressionDirection: 'ltr',
        renditionFlow: 'paginated',
        configurationSha256: 'c'.repeat(64),
      },
      'css',
      {
        enumerable: true,
        get() {
          accessorReads += 1
          return 'body {}'
        },
      },
    )
    await expect(
      buildStructEpub(document, { profile: profile as never }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_INVALID')
    expect(accessorReads).toBe(0)

    await expect(
      buildStructEpub(document, {
        profile: {
          id: 'synthetic-profile',
          version: '1.0.0',
          fileName: 'synthetic.epub',
          pageProgressionDirection: 'ltr',
          renditionFlow: 'paginated',
          configurationSha256: 'c'.repeat(64),
          css: 'body {}',
          inventedUnknownField: true,
        } as never,
      }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_INVALID')

    await expect(
      buildStructEpub(document, {
        profile: {
          id: 'synthetic-profile',
          version: '1.0.0',
          fileName: 'synthetic.epub',
          pageProgressionDirection: 'ltr',
          renditionFlow: 'paginated',
          configurationSha256: 'c'.repeat(64),
          css: 'body { content: "\uD800"; }',
        },
      }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_INVALID')
  })
})

describe('Stage 6 exact renderer and archive bounds', () => {
  it('renders the bounded sparse table without truncating its declared dimensions', async () => {
    const publication = await characterizeRenderedCase('bounds-positive')
    const table = publication.normalized.blocks[0]!.table!
    const xhtml = inspectXhtml(publication.xhtml)

    expect(table).toMatchObject({ rows: 8, columns: 8 })
    expect(table.cells).toHaveLength(2)
    expect(xhtml.tables).toHaveLength(1)
    expect(xhtml.tables[0]!.cells).toHaveLength(64)
    expect(xhtml.tables[0]!.cells.at(-1)!.text).toBe(
      'Invented cell value.',
    )
  })

  it('rejects an oversized dimension at all four boundaries before reading proxy cell storage', async () => {
    const invalid = await characterizeCodecRejection(
      'bounds-negative',
      'TABLE_BOUNDS',
    )

    expect(getSyntheticBoundsProbe(invalid).cellStorageReads).toBe(0)
  })

  it.each([MAX_TABLE_DIMENSION - 1, MAX_TABLE_DIMENSION])(
    'does not reject the valid table dimension boundary %s',
    async (rows) => {
      const document = buildSealedSyntheticFixture('bounds-positive')
      document.blocks[0]!.table = {
        rows,
        columns: 1,
        cells: [],
        semantic: 'verified',
      }
      resealSyntheticDocument(document)

      const publication = await characterizeSealedDocument(document)
      expect(publication.normalized.blocks[0]!.table?.rows).toBe(rows)
      expect(publication.xhtml.match(/<tr>/gu)).toHaveLength(rows)
    },
    15_000,
  )

  it.each([MAX_STRUCT_STRING_BYTES - 1, MAX_STRUCT_STRING_BYTES])(
    'accepts a direct embedded stylesheet at the shared text boundary %s',
    (length) => {
      const document = buildSealedSyntheticFixture('malformed-positive')
      expect(() =>
        renderPublicationXhtml(document, {
          embedStyles: true,
          styles: 'x'.repeat(length),
        }),
      ).not.toThrow()
    },
  )

  it('rejects a direct embedded stylesheet at N+1 before returning XHTML', () => {
    const document = buildSealedSyntheticFixture('malformed-positive')
    expect(() =>
      renderPublicationXhtml(document, {
        embedStyles: true,
        styles: 'x'.repeat(MAX_STRUCT_STRING_BYTES + 1),
      }),
    ).toThrow('STRUCT_XHTML_STYLES_RESOURCE_LIMIT')
  })

  it('enforces N-1, N, and N+1 at the EPUB profile stylesheet boundary', async () => {
    const document = buildSealedSyntheticFixture('malformed-positive')
    const profile = {
      id: 'synthetic-profile',
      version: '1.0.0',
      fileName: 'synthetic.epub',
      pageProgressionDirection: 'ltr' as const,
      renditionFlow: 'paginated' as const,
      configurationSha256: 'c'.repeat(64),
    }
    for (const length of [
      MAX_STRUCT_STRING_BYTES - 1,
      MAX_STRUCT_STRING_BYTES,
    ])
      await expect(
        buildStructEpub(document, {
          profile: { ...profile, css: 'x'.repeat(length) },
        }),
      ).resolves.toMatchObject({ mediaType: 'application/epub+zip' })

    await expect(
      buildStructEpub(document, {
        profile: {
          ...profile,
          css: 'x'.repeat(MAX_STRUCT_STRING_BYTES + 1),
        },
      }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_INVALID')
  }, 15_000)

  it('accepts packaged XHTML at N-1/N and rejects N+1 before archiving', async () => {
    for (const length of [
      MAX_STRUCT_STRING_BYTES - 1,
      MAX_STRUCT_STRING_BYTES,
    ]) {
      const accepted = withPackagedXhtml(
        buildSealedSyntheticFixture('malformed-positive'),
        `assets/invented-bound-${length}.xhtml`,
        boundedPackagedXhtml(length),
      )
      await expect(buildStructEpub(accepted)).resolves.toMatchObject({
        mediaType: 'application/epub+zip',
      })
    }

    const overBound = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      'assets/invented-over-bound.xhtml',
      boundedPackagedXhtml(MAX_STRUCT_STRING_BYTES + 1),
    )
    await expect(buildStructEpub(overBound)).rejects.toThrow(
      'STRUCT_EPUB_XHTML_RESOURCE_LIMIT',
    )
  }, 15_000)

  it('enforces N-1, N, and N+1 at the packaged XHTML element bound', async () => {
    for (const elementCount of [
      MAX_RENDERED_INLINE_SEGMENTS - 1,
      MAX_RENDERED_INLINE_SEGMENTS,
    ]) {
      const accepted = withPackagedXhtml(
        buildSealedSyntheticFixture('malformed-positive'),
        `assets/invented-elements-${elementCount}.xhtml`,
        elementBoundPackagedXhtml(elementCount),
      )
      await expect(buildStructEpub(accepted)).resolves.toMatchObject({
        mediaType: 'application/epub+zip',
      })
    }

    const rejected = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      'assets/invented-elements-over-bound.xhtml',
      elementBoundPackagedXhtml(MAX_RENDERED_INLINE_SEGMENTS + 1),
    )
    expect(
      await captureRejection(() => buildStructEpub(rejected)),
    ).toMatchObject({ message: 'STRUCT_EPUB_XHTML_RESOURCE_LIMIT' })
  }, 15_000)

  it('enforces N-1, N, and N+1 at the packaged XHTML depth bound', async () => {
    for (const depth of [
      MAX_SYNTHETIC_XHTML_DEPTH - 1,
      MAX_SYNTHETIC_XHTML_DEPTH,
    ]) {
      const accepted = withPackagedXhtml(
        buildSealedSyntheticFixture('malformed-positive'),
        `assets/invented-depth-${depth}.xhtml`,
        depthBoundPackagedXhtml(depth),
      )
      await expect(buildStructEpub(accepted)).resolves.toMatchObject({
        mediaType: 'application/epub+zip',
      })
    }

    const rejected = withPackagedXhtml(
      buildSealedSyntheticFixture('malformed-positive'),
      'assets/invented-depth-over-bound.xhtml',
      depthBoundPackagedXhtml(MAX_SYNTHETIC_XHTML_DEPTH + 1),
    )
    expect(
      await captureRejection(() => buildStructEpub(rejected)),
    ).toMatchObject({ message: 'STRUCT_EPUB_XHTML_RESOURCE_LIMIT' })
  })

  it('enforces N-1, N, and N+1 at the final archive byte boundary', () => {
    const maximum = 32
    expect(() =>
      assertStructEpubArchiveByteLength(new Uint8Array(maximum - 1), maximum),
    ).not.toThrow()
    expect(() =>
      assertStructEpubArchiveByteLength(new Uint8Array(maximum), maximum),
    ).not.toThrow()
    expect(() =>
      assertStructEpubArchiveByteLength(new Uint8Array(maximum + 1), maximum),
    ).toThrow('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
  })
})
