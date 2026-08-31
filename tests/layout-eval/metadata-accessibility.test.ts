import { describe, expect, it } from 'vitest'
import {
  assertAccessibilityLinks,
  assertOpfMetadataLinks,
} from './helpers/assertions'
import {
  inspectOpf,
  inspectXhtml,
  XML_NAMESPACES,
  xmlAttribute,
  xmlElements,
} from './helpers/xml'
import {
  characterizeCodecRejection,
  characterizeRenderedCase,
  characterizeSealedDocument,
  reopenedText,
} from './baseline-characterization'
import {
  buildSealedSyntheticFixture,
  resealSyntheticDocument,
} from './fixture-builder'

describe('Stage 2.1 metadata baseline characterization', () => {
  it('preserves current XHTML metadata and the smaller current OPF metadata set', async () => {
    const publication = await characterizeRenderedCase('metadata-positive')
    const content = inspectXhtml(publication.xhtml)
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))
    const metadata = publication.decoded.metadata

    expect(publication.xhtml).toContain(
      '<p>Invented &amp; Escaped &lt;Edition&gt;</p>',
    )
    expect(content.visibleTextSegments.join('')).toContain(metadata.title)
    expect(content.visibleTextSegments.join('')).toContain(metadata.subtitle)
    expect(content.visibleTextSegments.join('')).toContain(metadata.authors[0])
    expect(content.visibleTextSegments.join('')).not.toContain(
      metadata.abstract,
    )
    expect(content.visibleTextSegments.join('')).not.toContain(
      metadata.affiliations![0]!,
    )

    expect(
      opf.metadata.map(({ localName, property, value }) => ({
        localName,
        property,
        value,
      })),
    ).toEqual([
      {
        localName: 'identifier',
        property: undefined,
        value: publication.epub.identifier,
      },
      {
        localName: 'title',
        property: undefined,
        value: metadata.title,
      },
      {
        localName: 'language',
        property: undefined,
        value: metadata.language,
      },
      {
        localName: 'creator',
        property: undefined,
        value: metadata.authors[0],
      },
      {
        localName: 'meta',
        property: 'dcterms:modified',
        value: metadata.artifactModifiedAt,
      },
    ])
    expect(reopenedText(publication, 'EPUB/package.opf')).not.toContain(
      metadata.subtitle,
    )
    expect(reopenedText(publication, 'EPUB/package.opf')).not.toContain(
      metadata.abstract,
    )
    assertOpfMetadataLinks('metadata-positive', opf)
  })

  it('currently binds EPUB identifiers, names, and packaged struct metadata to the synthetic source file name', async () => {
    const left = buildSealedSyntheticFixture('metadata-positive')
    const right = buildSealedSyntheticFixture('metadata-positive')
    left.source.fileName = 'invented-left.struct'
    right.source.fileName = 'invented-right.struct'
    resealSyntheticDocument(left)
    resealSyntheticDocument(right)

    const [leftPublication, rightPublication] = await Promise.all([
      characterizeSealedDocument(left),
      characterizeSealedDocument(right),
    ])
    const leftArtifact = JSON.parse(
      reopenedText(leftPublication, 'EPUB/struct.json'),
    ) as { source: { fileName: string } }
    const rightArtifact = JSON.parse(
      reopenedText(rightPublication, 'EPUB/struct.json'),
    ) as { source: { fileName: string } }

    expect(leftArtifact.source.fileName).toBe('invented-left.struct')
    expect(rightArtifact.source.fileName).toBe('invented-right.struct')
    expect(leftPublication.epub.identifier).not.toBe(
      rightPublication.epub.identifier,
    )
    expect(leftPublication.epub.fileName).not.toBe(
      rightPublication.epub.fileName,
    )
    expect(leftPublication.epub.bytes).not.toEqual(rightPublication.epub.bytes)
  })

  it('rejects an invalid publication date consistently at all four boundaries', async () => {
    await characterizeCodecRejection('metadata-negative', 'DATE')
  })
})

describe('Stage 2.1 structural accessibility baseline characterization', () => {
  it('keeps content language, unique IDs, resolved ARIA references, and nonempty synthetic image alt text', async () => {
    const [metadataPublication, assetPublication] = await Promise.all([
      characterizeRenderedCase('metadata-positive'),
      characterizeRenderedCase('assets-positive'),
    ])
    const metadataXhtml = inspectXhtml(metadataPublication.xhtml)
    const assetXhtml = inspectXhtml(assetPublication.xhtml)
    const image = xmlElements(assetXhtml.document.root).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'img',
    )!

    assertAccessibilityLinks('metadata-positive', metadataXhtml)
    assertAccessibilityLinks('assets-positive', assetXhtml)
    expect(metadataXhtml.rootLanguage).toEqual({ xml: 'en', html: 'en' })
    expect(metadataXhtml.duplicateIds).toEqual([])
    expect(xmlAttribute(image, 'alt')).toBe('Invented asset label')
  })
})
