import { strFromU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { assertStructEpubArchiveByteLength, buildStructEpub } from '../src/renderers/epub'
import { MAX_STRUCT_STRING_BYTES } from '../src/core/codec/primitives'
import { legacyStructDigest, structDigest } from '../src/core/ids'
import { sha256HexSync } from '../src/core/sha256'
import type { StructDocument } from '../src/core/types'

function refreshReceipt(document: StructDocument) {
  document.receipt.documentId = document.documentId
  document.receipt.sourceSha256 = document.source.sha256
  document.receipt.blockCount = document.blocks.length
  document.receipt.assetCount = document.assets.length
  document.receipt.relationshipCount = document.relationships.length
  document.receipt.diagnosticCount = document.diagnostics.length
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    ...(receipt.modelConsultations
      ? { modelConsultations: receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  return document
}

function documentWithHref(href: string): StructDocument {
  const evidence = {
    confidence: 1,
    pages: [1],
    boxes: [],
    sourceIds: ['fixture-source'],
  }
  return refreshReceipt({
    schemaVersion: '0.2.0',
    documentId: 'epub-integrity-document',
    source: {
      format: 'unknown',
      fileName: 'epub-integrity.fixture',
      sha256: 'a'.repeat(64),
      byteLength: 1,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'EPUB integrity fixture',
      subtitle: '',
      authors: [],
      abstract: '',
      updated: '1970-01-01',
    },
    blocks: [
      {
        id: 'source',
        kind: 'paragraph',
        text: 'link',
        page: 1,
        order: 0,
        column: 'single',
        inline: [{ start: 0, end: 4, href }],
        evidence,
      },
      {
        id: 'target',
        kind: 'heading',
        text: 'Target',
        page: 1,
        order: 1,
        column: 'single',
        inline: [],
        evidence,
        attributes: { level: 2 },
      },
    ],
    assets: [],
    relationships: [],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['source', 'target'],
        columns: [
          {
            id: 'page-1',
            side: 'single',
            blockIds: ['source', 'target'],
          },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'Ready',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: 'epub-integrity-document',
      sourceSha256: 'a'.repeat(64),
      blockCount: 2,
      assetCount: 0,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount: 10,
      conservation: {
        sourceNodeCount: 2,
        accountedSourceNodeCount: 2,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 1,
        accountedSourceAnnotationCount: 1,
        sourceAssetCount: 0,
        accountedSourceAssetCount: 0,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 10,
        structBlockCount: 2,
        structAssetCount: 0,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: 10,
      },
      generatedSha256: 'b'.repeat(64),
    },
  })
}

function legacyDocumentWithHref(href: string, locale?: string): StructDocument {
  const current = documentWithHref(href)
  if (locale) {
    current.blocks[0]!.evidence.boxes = [
      { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, rotation: 0 },
    ]
  }
  const {
    documentId: _documentId,
    receipt: currentReceipt,
    ...documentFields
  } = current
  const { documentId: _receiptDocumentId, ...legacyReceipt } = currentReceipt
  const legacy: StructDocument = {
    ...documentFields,
    schemaVersion: '0.1.0',
    receipt: { ...legacyReceipt, schemaVersion: '0.1.0' },
  }
  const { receipt, ...withoutReceipt } = legacy
  receipt.generatedSha256 = legacyStructDigest(
    {
      ...withoutReceipt,
      conservation: receipt.conservation,
      assets: legacy.assets.map(({ bytes: _bytes, ...asset }) => asset),
    },
    locale,
  )
  return legacy
}

describe('STRUCT EPUB href integrity', () => {
  it('rejects an oversized title through the direct EPUB boundary', async () => {
    const document = documentWithHref('#target')
    document.metadata.title = 'x'.repeat(MAX_STRUCT_STRING_BYTES + 1)

    await expect(buildStructEpub(document)).rejects.toThrow(
      /textual resource bound/i,
    )
  })

  it.each([NaN, Infinity, -Infinity, -0])(
    'rejects non-canonical number %s through the direct EPUB boundary',
    async (number) => {
      const document = documentWithHref('#target')
      document.blocks[0]!.evidence.confidence = number

      await expect(buildStructEpub(document)).rejects.toThrow(
        /number|finite|negative zero/i,
      )
    },
  )

  it('rejects oversized generic receipt JSON before direct EPUB snapshotting', async () => {
    const document = documentWithHref('#target')
    document.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: document.documentId!,
      sourceSha256: document.source.sha256,
      consultations: [{ adapterNote: 'x'.repeat(1024 * 1024 + 1) }],
      decisions: [],
      metrics: {},
    }

    await expect(buildStructEpub(document)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('bounds a stateful generic receipt proxy during direct EPUB snapshotting', async () => {
    const document = documentWithHref('#target')
    let descriptorReads = 0
    document.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: document.documentId!,
      sourceSha256: document.source.sha256,
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
                descriptorReads < 3 ? 'small' : 'x'.repeat(10 * 1024 * 1024),
            }
          },
        },
      ),
    }

    await expect(buildStructEpub(document)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
    expect(descriptorReads).toBe(3)
  })

  it('rejects aggregate recovery text before direct EPUB parsing', async () => {
    const document = documentWithHref('#target')
    const large = 'x'.repeat(4 * 1024 * 1024 - 1)
    document.recovery = {
      status: 'ready',
      title: large,
      summary: large,
      issues: [
        {
          category: 'source',
          title: large,
          count: 1,
          pages: [1],
          action: large,
        },
      ],
      userAction: large,
    }

    await expect(buildStructEpub(document)).rejects.toThrow(
      /aggregate resource bound/i,
    )
  })

  it('enforces the post-compression boundary for an incompressible archive', () => {
    const payload = new Uint8Array(16 * 1024)
    for (let index = 0; index < payload.length; index += 1)
      payload[index] = (index * 73 + 19) % 256
    const archive = zipSync({ 'payload.bin': payload })

    expect(() =>
      assertStructEpubArchiveByteLength(archive, archive.byteLength - 1),
    ).toThrow('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
    expect(() =>
      assertStructEpubArchiveByteLength(archive, archive.byteLength),
    ).not.toThrow()
  })

  it('packages a closed source-neutral consultation receipt without app receipt semantics', async () => {
    const document = documentWithHref('#target')
    document.receipt.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: document.documentId!,
      sourceSha256: document.source.sha256,
      consultations: [{ adapterDecision: 'defer', status: 'pending' }],
      decisions: [],
      metrics: { adapter: 'source-neutral', pendingCount: 1 },
    }

    await expect(
      buildStructEpub(refreshReceipt(document)),
    ).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('reopens an exact profiled stylesheet and immutable profile receipt', async () => {
    const profile = {
      id: 'mobile',
      version: '1.1.0',
      fileName: 'publication-mobile.epub',
      pageProgressionDirection: 'ltr' as const,
      renditionFlow: 'scrolled-continuous' as const,
      configurationSha256: 'c'.repeat(64),
      css: 'body { font-size: 15px; }',
    }
    const epub = await buildStructEpub(documentWithHref('#target'), {
      profile,
    })
    const files = unzipSync(epub.bytes)

    expect(epub.fileName).toBe(profile.fileName)
    expect(epub.profile).toMatchObject({
      id: profile.id,
      version: profile.version,
      configurationSha256: profile.configurationSha256,
    })
    expect(strFromU8(files['EPUB/styles.css']!)).toBe(profile.css)
    expect(JSON.parse(strFromU8(files['EPUB/profile.json']!))).toEqual(
      epub.profile,
    )
    expect(strFromU8(files['EPUB/package.opf']!)).toContain(
      '<meta property="rendition:flow">scrolled-continuous</meta>',
    )
  })

  it('rejects a self-authored or malformed profile before packaging', async () => {
    await expect(
      buildStructEpub(documentWithHref('#target'), {
        profile: {
          id: '../mobile',
          version: '1.1.0',
          fileName: 'publication-mobile.epub',
          pageProgressionDirection: 'ltr',
          renditionFlow: 'scrolled-continuous',
          configurationSha256: 'c'.repeat(64),
          css: 'body {}',
        },
      }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_INVALID')
  })

  it('snapshots a valid profile before EPUB packaging reads it again', async () => {
    const css = 'body { color: black; }'
    let cssReads = 0
    const profile = new Proxy(
      {
        id: 'mobile',
        version: '1.0.0',
        fileName: 'publication-mobile.epub',
        pageProgressionDirection: 'ltr' as const,
        renditionFlow: 'paginated' as const,
        configurationSha256: 'c'.repeat(64),
        css,
      },
      {
        get(target, property, receiver) {
          if (property === 'css') cssReads += 1
          return Reflect.get(target, property, receiver)
        },
      },
    )

    const epub = await buildStructEpub(documentWithHref('#target'), { profile })

    expect(strFromU8(unzipSync(epub.bytes)['EPUB/styles.css']!)).toBe(css)
    expect(cssReads).toBe(1)
  })

  it.each([
    ['same-document fragment', '#target'],
    ['packaged XHTML fragment', 'content.xhtml#target'],
    ['packaged document', 'nav.xhtml'],
    ['HTTP URL', 'http://example.test/reference'],
    ['HTTPS URL', 'https://example.test/reference?q=one&part=two'],
    ['email URL', 'mailto:reader@example.test'],
  ])('permits a valid %s', async (_label, href) => {
    await expect(
      buildStructEpub(documentWithHref(href)),
    ).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('accepts serialized legacy 0.1.0 documents without document bindings', async () => {
    await expect(
      buildStructEpub(legacyDocumentWithHref('#target')),
    ).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('accepts a legacy digest created under a different ICU collation', async () => {
    const lithuanian = legacyDocumentWithHref('#target', 'lt')
    const english = legacyDocumentWithHref('#target', 'en')
    expect(lithuanian.receipt.generatedSha256).not.toBe(
      english.receipt.generatedSha256,
    )
    await expect(buildStructEpub(lithuanian)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
      mode: 'publication',
    })
  })

  it('requires document bindings on current 0.2.0 documents', async () => {
    const document = documentWithHref('#target')
    delete document.documentId
    delete document.receipt.documentId

    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      'STRUCT_RECEIPT_BINDING_MISMATCH',
    )
  })

  it('rejects partial or invalid document bindings', async () => {
    const invalidBindings: Array<[string, (document: StructDocument) => void]> =
      [
        [
          'document only',
          (document) => {
            delete document.receipt.documentId
          },
        ],
        [
          'receipt only',
          (document) => {
            delete document.documentId
          },
        ],
        [
          'empty',
          (document) => {
            document.documentId = ''
            document.receipt.documentId = ''
          },
        ],
        [
          'null',
          (document) => {
            Object.assign(document, { documentId: null })
            Object.assign(document.receipt, { documentId: null })
          },
        ],
        [
          'mismatched',
          (document) => {
            document.receipt.documentId = 'another-document'
          },
        ],
      ]
    for (const [label, mutate] of invalidBindings) {
      const document = documentWithHref('#target')
      mutate(document)
      await expect(
        buildStructEpub(document),
        `${label} bindings must fail closed`,
      ).rejects.toThrow('STRUCT_RECEIPT_BINDING_MISMATCH')
    }
  })

  it('rejects matching unsupported STRUCT versions', async () => {
    const document = documentWithHref('#target')
    Object.assign(document, { schemaVersion: '9.9.9' })
    Object.assign(document.receipt, { schemaVersion: '9.9.9' })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      'STRUCT_RECEIPT_BINDING_MISMATCH',
    )
  })

  it('packages the hidden-link rule used by expanded semantic groups', async () => {
    const epub = await buildStructEpub(documentWithHref('#target'))
    const files = unzipSync(epub.bytes)
    expect(strFromU8(files['EPUB/styles.css'])).toContain(
      '.additional-semantic-reference',
    )
  })

  it.each([
    ['missing fragment', '#missing'],
    ['missing packaged document', 'missing.xhtml'],
    ['missing fragment in a packaged document', 'content.xhtml#missing'],
  ])('rejects a %s', async (_label, href) => {
    await expect(buildStructEpub(documentWithHref(href))).rejects.toThrow(
      /dangling internal reference/i,
    )
  })

  it.each([
    ['trailing slash', 'supplement.xhtml/', 'supplement.xhtml'],
    [
      'empty path segment',
      'chapters//supplement.xhtml',
      'chapters/supplement.xhtml',
    ],
  ])(
    'does not alias a %s href to a different packaged document',
    async (_label, href, packagedHref) => {
      const document = documentWithHref(href)
      const assetBytes = new TextEncoder().encode(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Different exact path</p></body></html>',
      )
      document.assets.push({
        id: `supplement-${document.assets.length}`,
        kind: 'figure',
        href: packagedHref,
        mediaType: 'application/xhtml+xml',
        sha256: sha256HexSync(assetBytes),
        width: 1,
        height: 1,
        bytes: assetBytes,
        sourceObjectIds: ['fixture-supplement'],
        evidence: {
          confidence: 1,
          pages: [1],
          boxes: [],
          sourceIds: ['fixture-supplement'],
        },
        fallback: 'asset',
      })

      await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
        /dangling internal reference/i,
      )
    },
  )

  it.each([
    ['script URL', 'javascript:alert(1)'],
    ['embedded data URL', 'data:text/html,unsafe'],
    ['protocol-relative URL', '//example.test/reference'],
  ])('rejects an unsafe %s', async (_label, href) => {
    await expect(buildStructEpub(documentWithHref(href))).rejects.toThrow(
      /unsafe href/i,
    )
  })

  it('rejects reserved asset href collisions before packaging', async () => {
    const document = documentWithHref('#target')
    document.assets.push({
      id: 'replacement-content',
      kind: 'figure',
      href: 'content.xhtml',
      mediaType: 'image/png',
      sha256: 'c'.repeat(64),
      width: 1,
      height: 1,
      bytes: new Uint8Array([0]),
      sourceObjectIds: ['fixture-asset'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['fixture-asset'],
      },
      fallback: 'asset',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      /reserved/i,
    )
  })

  it('rejects malformed packaged XHTML assets', async () => {
    const document = documentWithHref('#target')
    const assetBytes = new TextEncoder().encode(
      '<html><body><a href="#missing"></body>',
    )
    document.assets.push({
      id: 'supplement',
      kind: 'figure',
      href: 'supplement.xhtml',
      mediaType: 'application/xhtml+xml',
      sha256: sha256HexSync(assetBytes),
      width: 1,
      height: 1,
      bytes: assetBytes,
      sourceObjectIds: ['fixture-supplement'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['fixture-supplement'],
      },
      fallback: 'asset',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      /well-formed XHTML/i,
    )
  })

  it('rejects dangling namespaced hrefs in packaged XHTML assets', async () => {
    const document = documentWithHref('#target')
    const assetBytes = new TextEncoder().encode(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><body><a xlink:href="#missing">Missing</a></body></html>',
    )
    document.assets.push({
      id: 'namespaced-supplement',
      kind: 'figure',
      href: 'namespaced-supplement.xhtml',
      mediaType: 'application/xhtml+xml',
      sha256: sha256HexSync(assetBytes),
      width: 1,
      height: 1,
      bytes: assetBytes,
      sourceObjectIds: ['fixture-namespaced-supplement'],
      evidence: {
        confidence: 1,
        pages: [1],
        boxes: [],
        sourceIds: ['fixture-namespaced-supplement'],
      },
      fallback: 'asset',
    })
    await expect(buildStructEpub(refreshReceipt(document))).rejects.toThrow(
      /dangling internal reference/i,
    )
  })
})
