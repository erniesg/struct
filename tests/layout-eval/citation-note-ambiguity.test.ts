import { describe, expect, it } from 'vitest'
import {
  assertAccessibilityLinks,
  assertNoHiddenSemanticTextDuplicates,
  assertSemanticLinks,
  LayoutAssertionError,
} from './helpers/assertions'
import {
  inspectXhtml,
  XML_NAMESPACES,
  xmlAttribute,
  xmlElements,
} from './helpers/xml'
import {
  characterizeRenderedCase,
  characterizeSealedDocument,
} from './baseline-characterization'
import {
  buildSealedSyntheticFixture,
  resealSyntheticDocument,
  syntheticBlock,
} from './fixture-builder'

function localHrefs(xhtml: ReturnType<typeof inspectXhtml>): string[] {
  return xhtml.hrefs
    .map(({ value }) => value)
    .filter((href) => href.startsWith('#'))
}

describe('Stage 2.1 citation baseline characterization', () => {
  it('links a matched citation while retaining the current incompatible bibliography target role', async () => {
    const publication = await characterizeRenderedCase('citations-positive')
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.decoded.relationships[0]!

    expect(relationship.status).toBe('matched')
    expect(localHrefs(xhtml)).toContain(`#${relationship.to[0]}`)
    expect(
      xhtml.roles.find(({ id }) => id === relationship.to[0])?.tokens,
    ).toEqual(['doc-biblioentry'])
    expect(() => assertSemanticLinks('citations-positive', xhtml)).toThrow(
      new LayoutAssertionError('citations-positive', 'semantic-links'),
    )
    assertNoHiddenSemanticTextDuplicates('citations-positive', xhtml)
  })

  it('currently emits focusable hidden links for unmatched grouped citation targets', async () => {
    const document = buildSealedSyntheticFixture('citations-positive')
    const relationship = document.relationships[0]!
    const secondTarget = syntheticBlock('citations-positive', {
      role: 'second-target',
      text: 'Invented second semantic target.',
      order: document.blocks.length,
      attributes: { bibliographyEntry: true },
    })
    document.blocks.push(secondTarget)
    document.pages[0]!.blocks.push(secondTarget.id)
    document.pages[0]!.columns[0]!.blockIds.push(secondTarget.id)
    relationship.to.push(secondTarget.id)
    relationship.label = 'A, B'
    document.blocks[0]!.inline[0]!.targetIds = [...relationship.to]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const hiddenLinks = xmlElements(xhtml.document.root).filter(
      (element) =>
        element.namespaceUri === XML_NAMESPACES.xhtml &&
        element.localName === 'a' &&
        xmlAttribute(element, 'class') === 'additional-semantic-reference',
    )

    expect(hiddenLinks).toHaveLength(2)
    expect(hiddenLinks.every((element) => xmlAttribute(element, 'href'))).toBe(
      true,
    )
    expect(() =>
      assertAccessibilityLinks('citations-positive', xhtml),
    ).toThrow(
      new LayoutAssertionError('citations-positive', 'accessibility-links'),
    )
  })

  it('currently follows an inline candidate target for an ambiguous citation', async () => {
    const publication = await characterizeRenderedCase(
      'citations-safe-ambiguity',
    )
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.normalized.relationships[0]!
    const candidate = relationship.candidates![0]!

    expect(relationship).toMatchObject({ status: 'ambiguous', to: [] })
    expect(candidate.target).toBe(publication.decoded.blocks[1]!.id)
    expect(localHrefs(xhtml)).toContain(`#${candidate.target}`)
  })
})

describe('Stage 2.1 note baseline characterization', () => {
  it('emits compatible footnote roles, one backlink, and resolved local anchors', async () => {
    const publication = await characterizeRenderedCase('notes-positive')
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.decoded.relationships[0]!

    assertSemanticLinks('notes-positive', xhtml)
    assertAccessibilityLinks('notes-positive', xhtml)
    expect(localHrefs(xhtml)).toEqual([
      `#${relationship.to[0]}`,
      `#${relationship.id}`,
    ])
  })

  it('preserves endnote type but currently labels its target as a footnote role', async () => {
    const document = buildSealedSyntheticFixture('notes-positive')
    document.blocks[1]!.kind = 'endnote'
    document.relationships[0]!.kind = 'endnote'
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const targetId = publication.decoded.blocks[1]!.id

    expect(
      xhtml.epubTypes.find(({ id }) => id === targetId)?.tokens,
    ).toEqual(['endnote'])
    expect(xhtml.roles.find(({ id }) => id === targetId)?.tokens).toEqual([
      'doc-footnote',
    ])
    expect(() => assertSemanticLinks('notes-positive', xhtml)).toThrow(
      new LayoutAssertionError('notes-positive', 'semantic-links'),
    )
  })

  it('currently follows an inline candidate target for an ambiguous note without adding a backlink', async () => {
    const publication = await characterizeRenderedCase(
      'notes-safe-ambiguity',
    )
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.normalized.relationships[0]!
    const candidate = relationship.candidates![0]!

    expect(relationship).toMatchObject({ status: 'ambiguous', to: [] })
    expect(localHrefs(xhtml)).toEqual([`#${candidate.target}`])
    expect(publication.xhtml).not.toContain('note-backlink')
  })
})

describe('Stage 2.1 ambiguity baseline characterization', () => {
  it('links the proven cross-reference target through every publication boundary', async () => {
    const publication = await characterizeRenderedCase('ambiguity-positive')
    const relationship = publication.decoded.relationships[0]!

    expect(relationship.status).toBe('matched')
    expect(localHrefs(inspectXhtml(publication.xhtml))).toContain(
      `#${relationship.to[0]}`,
    )
  })

  it('preserves candidate facts but currently links the ambiguous cross-reference candidate', async () => {
    const publication = await characterizeRenderedCase('ambiguity-safe')
    const relationship = publication.normalized.relationships[0]!
    const candidate = relationship.candidates![0]!

    expect(relationship).toMatchObject({ status: 'ambiguous', to: [] })
    expect(candidate.evidence.signals).toEqual([
      'independently-invented-layout-evidence',
    ])
    expect(localHrefs(inspectXhtml(publication.xhtml))).toContain(
      `#${candidate.target}`,
    )
  })

  it.each(['unresolved', 'source-preserved'] as const)(
    'currently links the inline candidate for a %s cross-reference',
    async (status) => {
      const document = buildSealedSyntheticFixture('ambiguity-safe')
      document.relationships[0]!.status = status
      resealSyntheticDocument(document)

      const publication = await characterizeSealedDocument(document)
      const candidate = publication.normalized.relationships[0]!.candidates![0]!

      expect(publication.normalized.relationships[0]).toMatchObject({
        status,
        to: [],
      })
      expect(localHrefs(inspectXhtml(publication.xhtml))).toContain(
        `#${candidate.target}`,
      )
    },
  )
})
