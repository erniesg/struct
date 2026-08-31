import { describe, expect, it } from 'vitest'
import {
  assertAccessibilityLinks,
  assertNoHiddenSemanticTextDuplicates,
  assertSemanticLinks,
} from './helpers/assertions'
import {
  inspectXhtml,
  XML_NAMESPACES,
  xmlAttribute,
  xmlElements,
  xmlElementText,
  type XhtmlSemantics,
} from './helpers/xml'
import {
  characterizeRenderedCase,
  characterizeSealedDocument,
} from './baseline-characterization'
import {
  buildSealedSyntheticFixture,
  resealSyntheticDocument,
  syntheticBlock,
  syntheticTableCell,
} from './fixture-builder'

function localHrefs(xhtml: XhtmlSemantics): string[] {
  return xhtml.hrefs
    .map(({ value }) => value)
    .filter((href) => href.startsWith('#'))
}

function elementById(xhtml: XhtmlSemantics, id: string) {
  return xmlElements(xhtml.document.root).find(
    (element) => xmlAttribute(element, 'id') === id,
  )
}

function elementsWithClass(xhtml: XhtmlSemantics, className: string) {
  return xmlElements(xhtml.document.root).filter((element) =>
    (xmlAttribute(element, 'class')?.split(/[\t\n\r ]+/u) ?? []).includes(
      className,
    ),
  )
}

function semanticReferences(
  xhtml: XhtmlSemantics,
  type: 'biblioref' | 'noteref',
) {
  return xmlElements(xhtml.document.root).filter(
    (element) =>
      element.namespaceUri === XML_NAMESPACES.xhtml &&
      element.localName === 'a' &&
      (xmlAttribute(element, 'type', XML_NAMESPACES.epub)?.split(
        /[\t\n\r ]+/u,
      ) ?? []).includes(type),
  )
}

describe('Stage 5 citation contract (CITE-01/CITE-02)', () => {
  it('pairs citation references with bibliography targets', async () => {
    const publication = await characterizeRenderedCase('citations-positive')
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.decoded.relationships[0]!
    const marker = publication.decoded.blocks[0]!
    const target = publication.decoded.blocks[1]!
    const reference = elementById(xhtml, relationship.id)!
    const bibliography = elementById(xhtml, target.id)!

    expect(relationship).toMatchObject({
      kind: 'citation',
      status: 'matched',
      to: [target.id],
    })
    expect(reference).toBeDefined()
    expect(reference.localName).toBe('a')
    expect(xmlAttribute(reference, 'href')).toBe(`#${target.id}`)
    expect(xmlAttribute(reference, 'type', XML_NAMESPACES.epub)).toBe(
      'biblioref',
    )
    expect(xmlAttribute(reference, 'role')).toBe('doc-biblioref')
    expect(xmlElementText(reference)).toBe(marker.text)
    expect(xmlAttribute(reference, 'aria-hidden')).toBeUndefined()
    expect(xmlAttribute(bibliography, 'type', XML_NAMESPACES.epub)).toBe(
      'bibliography',
    )
    expect(xmlAttribute(bibliography, 'role')).toBe('doc-bibliography')
    expect(xhtml.ids.filter((id) => id === relationship.id)).toHaveLength(1)
    expect(localHrefs(xhtml)).toEqual([`#${target.id}`])
    assertSemanticLinks('citations-positive', xhtml)
    assertAccessibilityLinks('citations-positive', xhtml)
    assertNoHiddenSemanticTextDuplicates('citations-positive', xhtml)
  })

  it('uses the matched relationship target instead of an inline candidate id', async () => {
    const document = buildSealedSyntheticFixture('citations-positive')
    const relationship = document.relationships[0]!
    const marker = document.blocks[0]!
    const temptingTarget = syntheticBlock('citations-positive', {
      role: 'tempting-inline-target',
      text: 'Invented unselected inline target.',
      order: document.blocks.length,
      attributes: { bibliographyEntry: true },
    })
    document.blocks.push(temptingTarget)
    document.pages[0]!.blocks.push(temptingTarget.id)
    document.pages[0]!.columns[0]!.blockIds.push(temptingTarget.id)
    marker.inline[0]!.targetIds = [temptingTarget.id]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const occurrence = elementById(xhtml, relationship.id)!

    expect(localHrefs(xhtml)).toEqual([`#${relationship.to[0]}`])
    expect(localHrefs(xhtml)).not.toContain(`#${temptingTarget.id}`)
    expect(xmlAttribute(occurrence, 'data-target-ids')).toBe(
      relationship.to[0],
    )
    expect(xmlElementText(occurrence)).toBe(marker.text)
    assertSemanticLinks('citations-positive', xhtml)
    assertAccessibilityLinks('citations-positive', xhtml)
  })

  it('has no focusable hidden grouped citation links', async () => {
    const document = buildSealedSyntheticFixture('citations-positive')
    const relationship = document.relationships[0]!
    const marker = document.blocks[0]!
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
    marker.inline[0]!.targetIds = [...relationship.to]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const occurrence = elementById(xhtml, relationship.id)!

    expect(occurrence).toBeDefined()
    expect(xmlElementText(occurrence)).toBe(marker.text)
    expect(xmlAttribute(occurrence, 'data-target-ids')).toBe(
      relationship.to.join(' '),
    )
    expect(localHrefs(xhtml)).toEqual([])
    expect(elementsWithClass(xhtml, 'additional-semantic-reference')).toEqual(
      [],
    )
    expect(publication.xhtml).not.toContain('Additional citation target')
    assertSemanticLinks('citations-positive', xhtml)
    assertAccessibilityLinks('citations-positive', xhtml)
    assertNoHiddenSemanticTextDuplicates('citations-positive', xhtml)
  })

  it('links every explicitly mapped grouped numeric marker without duplicating visible text', async () => {
    const document = buildSealedSyntheticFixture('citations-positive')
    const relationship = document.relationships[0]!
    const marker = document.blocks[0]!
    const secondTarget = syntheticBlock('citations-positive', {
      role: 'numeric-second-target',
      text: 'Invented numeric reference two.',
      order: document.blocks.length,
      attributes: { bibliographyEntry: true },
    })
    document.blocks.push(secondTarget)
    document.pages[0]!.blocks.push(secondTarget.id)
    document.pages[0]!.columns[0]!.blockIds.push(secondTarget.id)
    marker.text = '[1, 2]'
    marker.inline[0]!.end = marker.text.length
    relationship.to.push(secondTarget.id)
    relationship.label = '1, 2'
    marker.inline[0]!.targetIds = [...relationship.to]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const references = semanticReferences(xhtml, 'biblioref')
    const occurrence = elementById(xhtml, relationship.id)!

    expect(xmlElementText(occurrence)).toBe(marker.text)
    expect(
      references.map((reference) => ({
        href: xmlAttribute(reference, 'href'),
        label: xmlElementText(reference),
      })),
    ).toEqual([
      { href: `#${relationship.to[0]}`, label: '1' },
      { href: `#${relationship.to[1]}`, label: '2' },
    ])
    expect(xhtml.ids.filter((id) => id === relationship.id)).toHaveLength(1)
    expect(elementsWithClass(xhtml, 'additional-semantic-reference')).toEqual(
      [],
    )
    assertSemanticLinks('citations-positive', xhtml)
    assertAccessibilityLinks('citations-positive', xhtml)
    assertNoHiddenSemanticTextDuplicates('citations-positive', xhtml)
  })

  it('keeps an ambiguous citation marker visible and neutral', async () => {
    const publication = await characterizeRenderedCase(
      'citations-safe-ambiguity',
    )
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.normalized.relationships[0]!
    const marker = publication.decoded.blocks[0]!
    const candidate = relationship.candidates![0]!

    expect(relationship).toMatchObject({ status: 'ambiguous', to: [] })
    expect(candidate.target).toBe(publication.decoded.blocks[1]!.id)
    expect(xmlElementText(elementById(xhtml, marker.id)!)).toBe(marker.text)
    expect(localHrefs(xhtml)).not.toContain(`#${candidate.target}`)
    expect(elementById(xhtml, relationship.id)).toBeUndefined()
    expect(semanticReferences(xhtml, 'biblioref')).toEqual([])
    expect(publication.xhtml).not.toContain(relationship.label!)
    assertAccessibilityLinks('citations-safe-ambiguity', xhtml)
    assertNoHiddenSemanticTextDuplicates('citations-safe-ambiguity', xhtml)
  })
})

describe('Stage 5 note contract (NOTE-01)', () => {
  it('keeps a footnote reference and its accessible backlink closed', async () => {
    const publication = await characterizeRenderedCase('notes-positive')
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.decoded.relationships[0]!
    const marker = publication.decoded.blocks[0]!
    const target = publication.decoded.blocks[1]!
    const reference = elementById(xhtml, relationship.id)!
    const backlinks = elementsWithClass(xhtml, 'note-backlink')

    expect(xmlElementText(reference)).toBe(marker.text)
    expect(xmlAttribute(reference, 'href')).toBe(`#${target.id}`)
    expect(xmlAttribute(reference, 'type', XML_NAMESPACES.epub)).toBe(
      'noteref',
    )
    expect(xmlAttribute(reference, 'role')).toBe('doc-noteref')
    expect(backlinks).toHaveLength(1)
    expect(xmlAttribute(backlinks[0]!, 'href')).toBe(`#${relationship.id}`)
    expect(xmlAttribute(backlinks[0]!, 'aria-label')).toBe(
      'Back to note reference',
    )
    expect(xmlElementText(backlinks[0]!)).toBe('↩')
    expect(localHrefs(xhtml)).toEqual([
      `#${target.id}`,
      `#${relationship.id}`,
    ])
    assertSemanticLinks('notes-positive', xhtml)
    assertAccessibilityLinks('notes-positive', xhtml)
    assertNoHiddenSemanticTextDuplicates('notes-positive', xhtml)
  })

  it('uses the endnote target role', async () => {
    const document = buildSealedSyntheticFixture('notes-positive')
    document.blocks[1]!.kind = 'endnote'
    document.relationships[0]!.kind = 'endnote'
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.decoded.relationships[0]!
    const target = publication.decoded.blocks[1]!
    const renderedTarget = elementById(xhtml, target.id)!
    const backlink = elementsWithClass(xhtml, 'note-backlink')[0]!

    expect(xmlAttribute(renderedTarget, 'type', XML_NAMESPACES.epub)).toBe(
      'endnote',
    )
    expect(xmlAttribute(renderedTarget, 'role')).toBe('doc-endnote')
    expect(xmlAttribute(backlink, 'href')).toBe(`#${relationship.id}`)
    expect(xmlAttribute(backlink, 'aria-label')).toBe(
      'Back to note reference',
    )
    assertSemanticLinks('notes-positive', xhtml)
    assertAccessibilityLinks('notes-positive', xhtml)
  })

  it('closes a table-cell note reference and backlink', async () => {
    const document = buildSealedSyntheticFixture('notes-positive')
    const marker = document.blocks[0]!
    const relationship = document.relationships[0]!
    marker.kind = 'table'
    marker.inline = []
    marker.table = {
      rows: 1,
      columns: 1,
      cells: [
        syntheticTableCell('notes-positive', {
          role: 'note-marker-cell',
          text: marker.text,
          inline: [
            {
              start: 0,
              end: marker.text.length,
              relationshipId: relationship.id,
              targetIds: [...relationship.to],
              semanticRole: 'note-reference',
            },
          ],
        }),
      ],
      semantic: 'verified',
    }
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)

    expect(semanticReferences(xhtml, 'noteref')).toHaveLength(1)
    expect(elementsWithClass(xhtml, 'note-backlink')).toHaveLength(1)
    expect(localHrefs(xhtml)).toEqual([
      `#${relationship.to[0]}`,
      `#${relationship.id}`,
    ])
    assertSemanticLinks('notes-positive', xhtml)
    assertAccessibilityLinks('notes-positive', xhtml)
  })

  it('keeps one accessible author-note occurrence for repeated proven references', async () => {
    const document = buildSealedSyntheticFixture('notes-positive')
    const relationship = document.relationships[0]!
    const target = document.blocks[1]!
    document.metadata.authorNotes = [
      {
        id: relationship.id,
        author: document.metadata.authors[0]!,
        label: '1',
        target: target.id,
      },
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)
    const occurrence = elementById(xhtml, relationship.id)!
    const references = semanticReferences(xhtml, 'noteref')
    const backlinks = elementsWithClass(xhtml, 'note-backlink')

    expect(references).toHaveLength(2)
    expect(xmlElementText(occurrence)).toBe('1')
    expect(xmlAttribute(occurrence, 'href')).toBe(`#${target.id}`)
    expect(xhtml.ids.filter((id) => id === relationship.id)).toHaveLength(1)
    expect(backlinks).toHaveLength(1)
    expect(xmlAttribute(backlinks[0]!, 'href')).toBe(`#${relationship.id}`)
    assertSemanticLinks('notes-positive', xhtml)
    assertAccessibilityLinks('notes-positive', xhtml)
  })

  it('keeps an ambiguous note visible without a reference or backlink', async () => {
    const publication = await characterizeRenderedCase('notes-safe-ambiguity')
    const xhtml = inspectXhtml(publication.xhtml)
    const relationship = publication.normalized.relationships[0]!
    const marker = publication.decoded.blocks[0]!
    const candidate = relationship.candidates![0]!

    expect(relationship).toMatchObject({ status: 'ambiguous', to: [] })
    expect(xmlElementText(elementById(xhtml, marker.id)!)).toBe(marker.text)
    expect(localHrefs(xhtml)).not.toContain(`#${candidate.target}`)
    expect(elementById(xhtml, relationship.id)).toBeUndefined()
    expect(semanticReferences(xhtml, 'noteref')).toEqual([])
    expect(elementsWithClass(xhtml, 'note-backlink')).toEqual([])
    assertAccessibilityLinks('notes-safe-ambiguity', xhtml)
    assertNoHiddenSemanticTextDuplicates('notes-safe-ambiguity', xhtml)
  })
})

describe('Stage 5 ambiguity contract (AMB-01)', () => {
  it('keeps a matched cross-reference linked through every publication boundary', async () => {
    const publication = await characterizeRenderedCase('ambiguity-positive')
    const relationship = publication.decoded.relationships[0]!
    const xhtml = inspectXhtml(publication.xhtml)

    expect(relationship.status).toBe('matched')
    expect(localHrefs(xhtml)).toEqual([`#${relationship.to[0]}`])
    expect(elementById(xhtml, relationship.id)).toBeDefined()
    assertAccessibilityLinks('ambiguity-positive', xhtml)
  })

  it('does not link non-matched semantic candidates', async () => {
    for (const status of [
      'ambiguous',
      'unresolved',
      'source-preserved',
    ] as const) {
      const document = buildSealedSyntheticFixture('ambiguity-safe')
      const relationship = document.relationships[0]!
      const marker = document.blocks[0]!
      relationship.status = status
      resealSyntheticDocument(document)

      const publication = await characterizeSealedDocument(document)
      const xhtml = inspectXhtml(publication.xhtml)
      const normalizedRelationship = publication.normalized.relationships[0]!
      const candidate = normalizedRelationship.candidates![0]!

      expect(normalizedRelationship).toMatchObject({ status, to: [] })
      expect(candidate.evidence.signals).toEqual([
        'independently-invented-layout-evidence',
      ])
      expect(xmlElementText(elementById(xhtml, marker.id)!)).toBe(marker.text)
      expect(localHrefs(xhtml)).not.toContain(`#${candidate.target}`)
      expect(elementById(xhtml, normalizedRelationship.id)).toBeUndefined()
      expect(publication.xhtml).not.toContain('data-semantic-role')
      expect(publication.xhtml).not.toContain('data-target-ids')
      expect(publication.xhtml).not.toContain(normalizedRelationship.label!)
      assertAccessibilityLinks('ambiguity-safe', xhtml)
    }
  })

  it('keeps semantic runs without a relationship neutral', async () => {
    for (const caseId of [
      'citations-safe-ambiguity',
      'notes-safe-ambiguity',
      'ambiguity-safe',
    ]) {
      const document = buildSealedSyntheticFixture(caseId)
      const marker = document.blocks[0]!
      const candidateId = marker.inline[0]!.targetIds![0]!
      delete marker.inline[0]!.relationshipId
      document.relationships = []
      resealSyntheticDocument(document)

      const publication = await characterizeSealedDocument(document)
      const xhtml = inspectXhtml(publication.xhtml)
      const renderedMarker = elementById(xhtml, marker.id)!

      expect(xmlElementText(renderedMarker)).toBe(marker.text)
      expect(localHrefs(xhtml)).not.toContain(`#${candidateId}`)
      expect(
        xmlElements(renderedMarker).some(
          (element) =>
            xmlAttribute(element, 'data-semantic-role') !== undefined,
        ),
      ).toBe(false)
      expect(semanticReferences(xhtml, 'biblioref')).toEqual([])
      expect(semanticReferences(xhtml, 'noteref')).toEqual([])
      expect(elementsWithClass(xhtml, 'note-backlink')).toEqual([])
      assertAccessibilityLinks(caseId, xhtml)
    }
  })

  it('keeps an explicit plain hyperlink under the safe URL policy', async () => {
    const document = buildSealedSyntheticFixture('ambiguity-safe')
    const marker = document.blocks[0]!
    const target = document.blocks[1]!
    marker.inline = [
      {
        start: 0,
        end: marker.text.length,
        href: `#${target.id}`,
        targetIds: [target.id],
      },
    ]
    document.relationships = []
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)

    expect(localHrefs(xhtml)).toEqual([`#${target.id}`])
    expect(xmlElementText(elementById(xhtml, marker.id)!)).toBe(marker.text)
    expect(publication.xhtml).not.toContain('data-semantic-role')
    assertAccessibilityLinks('ambiguity-safe', xhtml)
  })
})
