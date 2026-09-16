import { describe, expect, it } from 'vitest'
import {
  assertArchiveCanonicalOrder,
  assertArchiveCompression,
  assertArchiveFirstEntry,
  assertArchiveTimestamps,
  assertNoArchiveDuplicates,
  assertOpfManifestLinks,
  assertTableLinks,
  LayoutAssertionError,
} from './helpers/assertions'
import { inspectZipArchive } from './helpers/archive'
import {
  inspectOpf,
  inspectXhtml,
  XML_NAMESPACES,
  xmlAttribute,
  xmlElements,
  xmlElementText,
} from './helpers/xml'
import {
  characterizeCodecRejection,
  characterizeRenderedCase,
  characterizeReviewRefusal,
  characterizeSealedDocument,
  reopenedText,
} from './baseline-characterization'
import {
  buildSealedSyntheticFixture,
  resealSyntheticDocument,
  syntheticAsset,
  syntheticRelationship,
} from './fixture-builder'

describe('Stage 2.1 table baseline characterization', () => {
  it('preserves sparse coordinates and scopes while exposing the current missing accessible name', async () => {
    const publication = await characterizeRenderedCase('tables-positive')
    const xhtml = inspectXhtml(publication.xhtml)

    expect(publication.normalized.blocks[0]!.table).toEqual(
      publication.decoded.blocks[0]!.table,
    )
    expect(xhtml.tables).toHaveLength(1)
    expect(xhtml.tables[0]!.ariaLabel).toBeUndefined()
    expect(xhtml.tables[0]).toMatchObject({
      ariaLabelledBy: [],
      captions: [],
    })
    expect(
      xhtml.tables[0]!.cells.map(({ kind, scope, text }) => ({
        kind,
        scope,
        text,
      })),
    ).toEqual([
      { kind: 'th', scope: 'col', text: 'Invented heading' },
      { kind: 'td', scope: undefined, text: '' },
      { kind: 'td', scope: undefined, text: '' },
      { kind: 'td', scope: undefined, text: '' },
      { kind: 'td', scope: undefined, text: 'Invented value' },
    ])
    expect(() => assertTableLinks('tables-positive', xhtml)).toThrow(
      new LayoutAssertionError('tables-positive', 'table-links'),
    )
  })

  it('currently renders a source-preserved table identically to a verified table', async () => {
    const verified = await characterizeRenderedCase('tables-positive')
    const sourcePreserved = buildSealedSyntheticFixture('tables-positive')
    sourcePreserved.blocks[0]!.table!.semantic = 'source-preserved'
    resealSyntheticDocument(sourcePreserved)

    const characterized = await characterizeSealedDocument(sourcePreserved)

    expect(characterized.normalized.blocks[0]!.table!.semantic).toBe(
      'source-preserved',
    )
    expect(characterized.xhtml).toBe(verified.xhtml)
    expect(characterized.xhtml).not.toContain('source-preserved')
  })

  it('rejects overlapping cells consistently at all four boundaries', async () => {
    await characterizeCodecRejection('tables-negative', 'TABLE_OVERLAP')
  })
})

describe('Stage 2.1 figure baseline characterization', () => {
  it('renders figure text and a following caption as separate current structures', async () => {
    const publication = await characterizeRenderedCase('figures-positive')
    const document = inspectXhtml(publication.xhtml).document
    const elements = xmlElements(document.root)
    const figure = elements.find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'figure',
    )!
    const figureCaption = xmlElements(figure).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'figcaption',
    )!
    const separateCaption = elements.find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'p' &&
        xmlAttribute(element, 'class') === 'caption',
    )!

    expect(xmlElementText(figureCaption)).toBe(
      publication.decoded.blocks[0]!.text,
    )
    expect(xmlElementText(separateCaption)).toBe(
      publication.decoded.blocks[1]!.text,
    )
    expect(publication.decoded.relationships).toEqual([])
  })

  it('preserves a matched caption relationship in the graph but does not express it in current markup', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const [figure, caption] = document.blocks
    document.relationships = [
      syntheticRelationship('figures-positive', {
        role: 'caption-association',
        kind: 'caption',
        from: caption!.id,
        to: [figure!.id],
        label: 'Invented caption association',
      }),
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)

    expect(publication.normalized.relationships).toEqual(document.relationships)
    expect(publication.xhtml).not.toContain(
      publication.normalized.relationships[0]!.id,
    )
    expect(publication.xhtml).toContain(
      `<p id="${caption!.id}" data-struct-id="${caption!.id}" class="caption">`,
    )
  })

  it('currently publishes an image with empty alternative text when neutral figure labeling is empty', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const asset = syntheticAsset('figures-positive', {
      role: 'unlabelled-asset',
    })
    document.assets = [asset]
    document.blocks[0]!.text = ''
    document.blocks[0]!.label = ''
    document.blocks[0]!.fallbackAssetIds = [asset.id]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const image = xmlElements(xhtml.document.root).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'img',
    )!

    expect(xmlAttribute(image, 'alt')).toBe('')
  })

  it('allows XHTML inspection but refuses EPUB publication when review is required', async () => {
    const refusal = await characterizeReviewRefusal('figures-negative')

    expect(refusal.decoded.recovery.status).toBe('review-required')
    expect(refusal.xhtml).toContain('Invented figure placeholder.')
  })
})

describe('Stage 2.1 asset baseline characterization', () => {
  it('conserves declared bytes, img src, OPF manifest entries, and ZIP order', async () => {
    const publication = await characterizeRenderedCase('assets-positive')
    const asset = publication.decoded.assets[0]!
    const assetEntry = `EPUB/${asset.href}`
    const expectedOrder = [
      'mimetype',
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/nav.xhtml',
      'EPUB/content.xhtml',
      'EPUB/styles.css',
      'EPUB/struct.json',
      assetEntry,
    ]
    const xhtml = inspectXhtml(publication.xhtml)
    const archive = inspectZipArchive(publication.epub.bytes)

    expect(xhtml.srcs.map(({ value }) => value)).toEqual([asset.href])
    expect(publication.reopened[assetEntry]).toEqual(asset.bytes)
    expect(publication.epub.entries).toEqual(expectedOrder)
    assertArchiveFirstEntry('assets-positive', archive, 'mimetype', 0)
    assertArchiveCanonicalOrder('assets-positive', archive, expectedOrder)
    assertNoArchiveDuplicates('assets-positive', archive)
    assertArchiveCompression(
      'assets-positive',
      archive,
      new Map([['mimetype', 0]]),
    )
    assertArchiveTimestamps('assets-positive', archive, 33, 0)

    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))
    assertOpfManifestLinks(
      'assets-positive',
      opf,
      'EPUB/package.opf',
      new Set(
        expectedOrder.filter(
          (path) => path.startsWith('EPUB/') && path !== 'EPUB/package.opf',
        ),
      ),
    )
  })

  it('rejects a byte digest mismatch consistently at all four boundaries', async () => {
    await characterizeCodecRejection('assets-negative', 'BYTES_HASH')
  })
})

// LOCAL RED CHECKPOINT: keep uncommitted until TABLE-01/FIG-01/FIG-02 land.
describe('Stage 2.1 table and figure contract red checkpoint', () => {
  it('names verified tables from neutral content', async () => {
    const publication = await characterizeRenderedCase('tables-positive')
    assertTableLinks('tables-positive', inspectXhtml(publication.xhtml))
  })

  it('keeps a matched caption with its figure', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const [figureBlock, captionBlock] = document.blocks
    document.relationships = [
      syntheticRelationship('figures-positive', {
        role: 'caption-association',
        kind: 'caption',
        from: captionBlock!.id,
        to: [figureBlock!.id],
        label: 'Invented caption association',
      }),
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const parsed = inspectXhtml(publication.xhtml)
    const figure = xmlElements(parsed.document.root).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'figure' &&
        xmlAttribute(element, 'id') === figureBlock!.id,
    )!

    expect(
      xmlElementText(figure).includes(captionBlock!.text),
      'figures-positive:caption-association',
    ).toBe(true)
  })

  it('refuses an unlabeled figure image', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const asset = syntheticAsset('figures-positive', {
      role: 'unlabelled-asset',
    })
    document.assets = [asset]
    document.blocks[0]!.text = ''
    document.blocks[0]!.label = ''
    document.blocks[0]!.fallbackAssetIds = [asset.id]
    resealSyntheticDocument(document)

    let refused = false
    try {
      await characterizeSealedDocument(document)
    } catch {
      refused = true
    }
    expect(refused, 'figures-positive:unlabeled-image-refusal').toBe(true)
  })
})
