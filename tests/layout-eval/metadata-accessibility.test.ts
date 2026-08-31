import { describe, expect, it } from 'vitest'
import { verifyStructReceipt } from '../../src/receipt'
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

describe('Stage 6 publication metadata contract (META-01/META-02)', () => {
  it('packages optional publication metadata in one exact neutral order', async () => {
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
      opf.metadata.map(({ id, localName, property, refines, value }) => ({
        id,
        localName,
        property,
        refines,
        value,
      })),
    ).toEqual([
      {
        id: 'publication-id',
        localName: 'identifier',
        property: undefined,
        refines: undefined,
        value: publication.epub.identifier,
      },
      {
        id: 'publication-title',
        localName: 'title',
        property: undefined,
        refines: undefined,
        value: metadata.title,
      },
      {
        id: undefined,
        localName: 'meta',
        property: 'title-type',
        refines: '#publication-title',
        value: 'main',
      },
      {
        id: 'publication-subtitle',
        localName: 'title',
        property: undefined,
        refines: undefined,
        value: metadata.subtitle,
      },
      {
        id: undefined,
        localName: 'meta',
        property: 'title-type',
        refines: '#publication-subtitle',
        value: 'subtitle',
      },
      {
        id: undefined,
        localName: 'language',
        property: undefined,
        refines: undefined,
        value: metadata.language,
      },
      {
        id: undefined,
        localName: 'creator',
        property: undefined,
        refines: undefined,
        value: metadata.authors[0],
      },
      {
        id: undefined,
        localName: 'description',
        property: undefined,
        refines: undefined,
        value: metadata.abstract,
      },
      {
        id: undefined,
        localName: 'date',
        property: undefined,
        refines: undefined,
        value: metadata.publicationDate,
      },
      {
        id: undefined,
        localName: 'meta',
        property: 'dcterms:modified',
        refines: undefined,
        value: metadata.artifactModifiedAt,
      },
    ])
    expect(reopenedText(publication, 'EPUB/package.opf')).toContain(
      'Invented &amp; Escaped &lt;Edition&gt;',
    )
    assertOpfMetadataLinks('metadata-positive', opf)
  })

  it('preserves multiple authors and canonicalizes modified time to UTC seconds', async () => {
    const document = buildSealedSyntheticFixture('metadata-positive')
    document.metadata.authors = [
      document.metadata.authors[0]!,
      'Second & <Writer>',
    ]
    document.metadata.artifactModifiedAt = '2000-01-01T05:30:15.987+05:30'
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))

    expect(
      opf.metadata
        .filter((entry) => entry.localName === 'creator')
        .map((entry) => entry.value),
    ).toEqual(document.metadata.authors)
    expect(
      opf.metadata.find(
        (entry) => entry.property === 'dcterms:modified',
      )?.value,
    ).toBe('2000-01-01T00:00:15Z')
    expect(reopenedText(publication, 'EPUB/package.opf')).toContain(
      'Second &amp; &lt;Writer&gt;',
    )
  })

  it('omits empty optional metadata and uses the neutral updated-date fallback', async () => {
    const document = buildSealedSyntheticFixture('metadata-positive')
    document.metadata.subtitle = ''
    document.metadata.abstract = ''
    document.metadata.authors = []
    delete document.metadata.authorAffiliations
    delete document.metadata.publicationDate
    delete document.metadata.artifactModifiedAt
    document.metadata.updated = '2001-02-03'
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))

    expect(
      opf.metadata.filter((entry) => entry.localName === 'title'),
    ).toHaveLength(1)
    expect(
      opf.metadata.some(
        (entry) =>
          entry.localName === 'description' ||
          entry.localName === 'date' ||
          entry.localName === 'creator' ||
          entry.refines === '#publication-subtitle',
      ),
    ).toBe(false)
    expect(
      opf.metadata.find(
        (entry) => entry.property === 'dcterms:modified',
      )?.value,
    ).toBe('2001-02-03T00:00:00Z')
  })

  it('keeps publication identity independent of source file name', async () => {
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
    ) as {
      receipt: typeof left.receipt
      source: { fileName: string }
    }
    const rightArtifact = JSON.parse(
      reopenedText(rightPublication, 'EPUB/struct.json'),
    ) as {
      receipt: typeof right.receipt
      source: { fileName: string }
    }

    expect(left.receipt.generatedSha256).not.toBe(
      right.receipt.generatedSha256,
    )
    expect(leftArtifact).toEqual(rightArtifact)
    expect(leftArtifact.source.fileName).not.toBe(left.source.fileName)
    expect(rightArtifact.source.fileName).not.toBe(right.source.fileName)
    expect(leftPublication.epub.identifier).toBe(
      rightPublication.epub.identifier,
    )
    expect(leftPublication.epub.fileName).toBe(
      rightPublication.epub.fileName,
    )
    expect(leftPublication.epub.bytes).toEqual(rightPublication.epub.bytes)
    expect(leftPublication.epub.sha256).toBe(rightPublication.epub.sha256)
    expect(leftArtifact.receipt.generatedSha256).toBe(
      leftPublication.epub.identifier.slice('urn:sha256:'.length),
    )
    const sanitizedDocument = structuredClone(leftPublication.decoded)
    sanitizedDocument.source.fileName = leftArtifact.source.fileName
    sanitizedDocument.receipt = leftArtifact.receipt
    expect(verifyStructReceipt(sanitizedDocument)).toBe(true)

    const changed = buildSealedSyntheticFixture('metadata-positive')
    changed.metadata.title = 'A Different Invented Publication'
    resealSyntheticDocument(changed)
    const changedPublication = await characterizeSealedDocument(changed)
    expect(changedPublication.epub.identifier).not.toBe(
      leftPublication.epub.identifier,
    )
    expect(changedPublication.epub.fileName).not.toBe(
      leftPublication.epub.fileName,
    )
  })

  it('rejects an invalid publication date consistently at all four boundaries', async () => {
    await characterizeCodecRejection('metadata-negative', 'DATE')
  })
})

describe('Stage 6 structural accessibility and required metadata invariants', () => {
  it('keeps title, language, identifier, navigation, IDs, ARIA, and image labels closed', async () => {
    const [metadataPublication, assetPublication] = await Promise.all([
      characterizeRenderedCase('metadata-positive'),
      characterizeRenderedCase('assets-positive'),
    ])
    const metadataXhtml = inspectXhtml(metadataPublication.xhtml)
    const navigationXhtml = inspectXhtml(
      reopenedText(metadataPublication, 'EPUB/nav.xhtml'),
    )
    const opf = inspectOpf(
      reopenedText(metadataPublication, 'EPUB/package.opf'),
    )
    const assetXhtml = inspectXhtml(assetPublication.xhtml)
    const image = xmlElements(assetXhtml.document.root).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'img',
    )!
    const navigation = xmlElements(navigationXhtml.document.root).find(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'nav',
    )!

    assertAccessibilityLinks('metadata-positive', metadataXhtml)
    assertAccessibilityLinks('metadata-positive', navigationXhtml)
    assertAccessibilityLinks('assets-positive', assetXhtml)
    assertOpfMetadataLinks('metadata-positive', opf)
    expect(metadataXhtml.rootLanguage).toEqual({ xml: 'en', html: 'en' })
    expect(navigationXhtml.rootLanguage).toEqual({ xml: 'en', html: 'en' })
    expect(opf.language).toBe('en')
    expect(
      opf.metadata.filter((entry) => entry.localName === 'language'),
    ).toEqual([
      expect.objectContaining({ value: 'en' }),
    ])
    expect(
      opf.metadata.filter(
        (entry) =>
          entry.localName === 'identifier' && entry.id === opf.uniqueIdentifier,
      ),
    ).toEqual([
      expect.objectContaining({ value: metadataPublication.epub.identifier }),
    ])
    expect(xmlAttribute(navigation, 'aria-label')).toBe(
      metadataPublication.decoded.metadata.title,
    )
    expect(metadataXhtml.duplicateIds).toEqual([])
    expect(navigationXhtml.duplicateIds).toEqual([])
    expect(xmlAttribute(image, 'alt')).toBe('Invented asset label')
    expect(
      opf.metadata.some((entry) =>
        entry.property?.startsWith('schema:accessibility'),
      ),
    ).toBe(false)
  })
})
