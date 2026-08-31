import { describe, expect, it } from 'vitest'
import {
  assertArchiveCanonicalOrder,
  assertArchiveCompression,
  assertArchiveFirstEntry,
  assertArchiveTimestamps,
  assertAccessibilityLinks,
  assertNoArchiveDuplicates,
  assertOpfManifestLinks,
  assertTableLinks,
} from './helpers/assertions'
import { buildStructEpub } from '../../src/renderers/epub'
import { renderPublicationXhtml } from '../../src/renderers/xhtml'
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
  syntheticBlock,
  syntheticRelationship,
  syntheticSvgAsset,
  syntheticTableCell,
} from './fixture-builder'

async function expectPublicationRefusal(
  document: ReturnType<typeof buildSealedSyntheticFixture>,
  code: string,
): Promise<void> {
  let directError: unknown
  try {
    renderPublicationXhtml(document)
  } catch (error) {
    directError = error
  }
  expect(directError).toBeInstanceOf(Error)
  expect((directError as Error).message).toBe(code)
  await expect(buildStructEpub(document)).rejects.toMatchObject({
    message: code,
  })
}

describe('Stage 4 table accessibility contract (TABLE-01/TABLE-02)', () => {
  it('names verified tables from neutral content', async () => {
    const publication = await characterizeRenderedCase('tables-positive')
    const xhtml = inspectXhtml(publication.xhtml)
    const tableBlock = publication.decoded.blocks[0]!

    expect(publication.normalized.blocks[0]!.table).toEqual(
      tableBlock.table,
    )
    expect(xhtml.tables).toHaveLength(1)
    expect(xhtml.tables[0]!.ariaLabel).toBeUndefined()
    expect(publication.xhtml).toContain(
      `<div id="${tableBlock.id}" data-struct-id="${tableBlock.id}"><table>`,
    )
    expect(publication.xhtml).not.toContain(`<figure id="${tableBlock.id}"`)
    expect(xhtml.tables[0]).toMatchObject({
      ariaLabelledBy: [],
      captions: [{ text: tableBlock.label }],
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
    assertTableLinks('tables-positive', xhtml)
    assertAccessibilityLinks('tables-positive', xhtml)
  })

  it('preserves every declared table header scope', async () => {
    const document = buildSealedSyntheticFixture('tables-positive')
    document.blocks[0]!.table!.rows = 1
    document.blocks[0]!.table!.columns = 4
    document.blocks[0]!.table!.cells = [
      syntheticTableCell('tables-positive', {
        role: 'column-header',
        column: 0,
        headerScope: 'column',
      }),
      syntheticTableCell('tables-positive', {
        role: 'row-header',
        column: 1,
        headerScope: 'row',
      }),
      syntheticTableCell('tables-positive', {
        role: 'column-group-header',
        column: 2,
        headerScope: 'colgroup',
      }),
      syntheticTableCell('tables-positive', {
        role: 'row-group-header',
        column: 3,
        headerScope: 'rowgroup',
      }),
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)

    expect(xhtml.tables[0]!.cells.map(({ kind, scope }) => ({ kind, scope }))).toEqual(
      [
        { kind: 'th', scope: 'col' },
        { kind: 'th', scope: 'row' },
        { kind: 'th', scope: 'colgroup' },
        { kind: 'th', scope: 'rowgroup' },
      ],
    )
    assertTableLinks('tables-positive', xhtml)
  })

  it.each(['block-label', 'block-text'] as const)(
    'renders a complete source-preserved %s fallback without table semantics',
    async (accessibleNameSource) => {
      const document = buildSealedSyntheticFixture('tables-positive')
      const block = document.blocks[0]!
      block.table!.semantic = 'source-preserved'
      block.table!.accessibleFallback = {
        kind: 'block-text',
        completeness: 'complete',
        accessibleNameSource,
      }
      resealSyntheticDocument(document)

      const publication = await characterizeSealedDocument(document)
      const xhtml = inspectXhtml(publication.xhtml)
      const fallback = xmlElements(xhtml.document.root).find(
        (element) =>
          element.namespaceUri === XML_NAMESPACES.xhtml &&
          element.localName === 'div' &&
          xmlAttribute(element, 'data-table-fallback') === 'source-preserved',
      )!
      const accessibleName =
        accessibleNameSource === 'block-label' ? block.label : block.text

      expect(xhtml.tables).toEqual([])
      expect(fallback).toBeDefined()
      expect(xmlAttribute(fallback, 'role')).toBe('group')
      expect(xmlAttribute(fallback, 'aria-label')).toBe(accessibleName)
      expect(xmlElementText(fallback)).toBe(block.text)
      expect(publication.xhtml).not.toContain(block.table!.cells[0]!.text)
      assertAccessibilityLinks('tables-positive', xhtml)
    },
  )

  it.each(['source-preserved', 'unresolved'] as const)(
    'refuses a %s table without a declared complete fallback',
    async (semantic) => {
      const document = buildSealedSyntheticFixture('tables-positive')
      document.blocks[0]!.table!.semantic = semantic
      delete document.blocks[0]!.table!.accessibleFallback
      resealSyntheticDocument(document)

      await expectPublicationRefusal(
        document,
        'STRUCT_PUBLICATION_TABLE_FALLBACK_REQUIRED',
      )
    },
  )

  it('refuses a verified table without nonempty neutral naming content', async () => {
    const document = buildSealedSyntheticFixture('tables-positive')
    document.blocks[0]!.text = '\u2003'
    document.blocks[0]!.label = '\uFEFF'
    resealSyntheticDocument(document)

    await expectPublicationRefusal(
      document,
      'STRUCT_PUBLICATION_TABLE_NAME_EMPTY',
    )
  })

  it('rejects overlapping cells consistently at all four boundaries', async () => {
    await characterizeCodecRejection('tables-negative', 'TABLE_OVERLAP')
  })
})

describe('Stage 4 figure/caption contract (FIG-01/FIG-02)', () => {
  it('keeps a matched caption with its figure', async () => {
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
    const xhtml = inspectXhtml(publication.xhtml)
    const elements = xmlElements(xhtml.document.root)
    const renderedFigure = elements.find(
      (element) => xmlAttribute(element, 'id') === figure!.id,
    )!
    const nestedCaption = xmlElements(renderedFigure).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'figcaption' &&
        xmlAttribute(element, 'id') === caption!.id,
    )
    const separateCaption = elements.find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'p' &&
        xmlAttribute(element, 'id') === caption!.id,
    )

    expect(publication.normalized.relationships).toEqual(document.relationships)
    expect(nestedCaption).toBeDefined()
    expect(xmlElementText(nestedCaption!)).toBe(caption!.text)
    expect(xmlElementText(renderedFigure)).toContain(figure!.text)
    expect(separateCaption).toBeUndefined()
    expect(publication.xhtml).not.toContain('Invented caption association')
    expect(xhtml.ids.filter((id) => id === caption!.id)).toHaveLength(1)
    assertAccessibilityLinks('figures-positive', xhtml)
  })

  it('keeps a nonadjacent matched caption in canonical order with an explicit association', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const [figure, caption] = document.blocks
    const intervening = syntheticBlock('figures-positive', {
      role: 'intervening-paragraph',
      text: 'Invented intervening text.',
    })
    document.blocks.splice(1, 0, intervening)
    document.blocks.forEach((block, index) => {
      block.order = index
    })
    document.pages[0]!.blocks = document.blocks.map(({ id }) => id)
    document.pages[0]!.columns[0]!.blockIds = document.blocks.map(
      ({ id }) => id,
    )
    document.relationships = [
      syntheticRelationship('figures-positive', {
        role: 'nonadjacent-caption-association',
        kind: 'caption',
        from: caption!.id,
        to: [figure!.id],
      }),
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const elements = xmlElements(xhtml.document.root)
    const renderedFigure = elements.find(
      (element) => xmlAttribute(element, 'id') === figure!.id,
    )!
    const renderedCaption = elements.find(
      (element) => xmlAttribute(element, 'id') === caption!.id,
    )!
    const visibleText = xhtml.visibleTextSegments.join('')

    expect(xmlAttribute(renderedFigure, 'aria-describedby')).toBe(caption!.id)
    expect(renderedCaption.localName).toBe('p')
    expect(visibleText.indexOf(figure!.text)).toBeLessThan(
      visibleText.indexOf(intervening.text),
    )
    expect(visibleText.indexOf(intervening.text)).toBeLessThan(
      visibleText.indexOf(caption!.text),
    )
    assertAccessibilityLinks('figures-positive', xhtml)
  })

  it('does not convert an ambiguous caption candidate into a figure association', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const [figure, caption] = document.blocks
    document.relationships = [
      syntheticRelationship('figures-positive', {
        role: 'ambiguous-caption-association',
        kind: 'caption',
        from: caption!.id,
        to: [figure!.id],
        label: 'Tempting invented caption candidate',
        status: 'ambiguous',
        confidence: 0.5,
      }),
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const elements = xmlElements(xhtml.document.root)
    const renderedFigure = elements.find(
      (element) => xmlAttribute(element, 'id') === figure!.id,
    )!
    const separateCaption = elements.find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'p' &&
        xmlAttribute(element, 'id') === caption!.id,
    )

    expect(separateCaption).toBeDefined()
    expect(xmlAttribute(renderedFigure, 'aria-describedby')).toBeUndefined()
    expect(publication.xhtml).not.toContain(
      'Tempting invented caption candidate',
    )
  })

  it('refuses an unlabeled figure image', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const [figure, caption] = document.blocks
    const asset = syntheticSvgAsset('figures-positive', 'unlabelled-asset')
    document.assets = [asset]
    figure!.text = '\u2003'
    figure!.label = '\uFEFF'
    figure!.fallbackAssetIds = [asset.id]
    document.relationships = [
      syntheticRelationship('figures-positive', {
        role: 'caption-does-not-supply-alt',
        kind: 'caption',
        from: caption!.id,
        to: [figure!.id],
        label: 'Caption relationship is not image alternative text',
      }),
    ]
    resealSyntheticDocument(document)

    await expectPublicationRefusal(
      document,
      'STRUCT_PUBLICATION_IMAGE_ALT_EMPTY',
    )
  })

  it('uses exact neutral figure text when an empty label cannot name the image', async () => {
    const document = buildSealedSyntheticFixture('assets-positive')
    const block = document.blocks[0]!
    block.label = '\u2003'
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const image = xmlElements(inspectXhtml(publication.xhtml).document.root).find(
      (element) => element.localName === 'img',
    )!

    expect(xmlAttribute(image, 'alt')).toBe(block.text)
    expect(xmlAttribute(image, 'alt')).not.toContain(
      publication.decoded.assets[0]!.href,
    )
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

describe('Stage 4 explicit asset safety', () => {
  it('renders only explicitly attached image assets in declared order', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const unused = syntheticSvgAsset('figures-positive', 'unused-image')
    const first = syntheticSvgAsset('figures-positive', 'first-image')
    const second = syntheticSvgAsset('figures-positive', 'second-image')
    document.assets = [unused, first, second]
    document.blocks[0]!.fallbackAssetIds = [second.id, first.id]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)

    expect(xhtml.srcs.map(({ value }) => value)).toEqual([
      second.href,
      first.href,
    ])
    expect(xhtml.srcs.map(({ value }) => value)).not.toContain(unused.href)
    expect(
      publication.epub.entries.filter((entry) =>
        entry.startsWith('EPUB/assets/'),
      ),
    ).toEqual(
      [unused, first, second].map((asset) => `EPUB/${asset.href}`),
    )
  })

  it('rejects a non-image asset explicitly attached as figure artwork', async () => {
    const document = buildSealedSyntheticFixture('figures-positive')
    const asset = syntheticAsset('figures-positive', {
      role: 'non-image-artwork',
    })
    document.assets = [asset]
    document.blocks[0]!.fallbackAssetIds = [asset.id]
    resealSyntheticDocument(document)

    await expectPublicationRefusal(
      document,
      'STRUCT_PUBLICATION_IMAGE_MEDIA_TYPE_UNSUPPORTED',
    )
  })

  it('refuses missing packaged image bytes with a content-free error', async () => {
    const document = buildSealedSyntheticFixture('assets-positive')
    const asset = document.assets[0]!
    delete asset.bytes
    resealSyntheticDocument(document)

    expect(renderPublicationXhtml(document)).toContain(
      `<img src="${asset.href}"`,
    )
    await expect(buildStructEpub(document)).rejects.toMatchObject({
      message: 'STRUCT_EPUB_ASSET_BYTES_MISSING',
    })
  })
})
