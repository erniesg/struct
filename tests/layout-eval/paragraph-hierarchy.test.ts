import { describe, expect, it } from 'vitest'
import {
  assertExactVisibleTextTokens,
  assertNavigationHierarchy,
  assertNavigationTargets,
  assertNoHiddenSemanticTextDuplicates,
} from './helpers/assertions'
import {
  inspectNavigation,
  inspectXhtml,
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

describe('Stage 2.1 paragraph baseline characterization', () => {
  it('preserves current inline styles and exact visible tokens through XHTML and EPUB reopen', async () => {
    const publication = await characterizeRenderedCase('paragraph-positive')
    const xhtml = inspectXhtml(publication.xhtml)

    expect(publication.normalized.blocks[0]!.inline).toEqual([
      { start: 0, end: 8, bold: true },
      { start: 9, end: 19, italic: true },
      { start: 35, end: 41, verticalAlign: 'superscript' },
    ])
    expect(publication.xhtml).toContain('<strong>Invented</strong>')
    expect(publication.xhtml).toContain('<em>alpha text</em>')
    expect(publication.xhtml).toContain('r<sup>aised </sup>marks.')
    assertExactVisibleTextTokens('paragraph-positive', xhtml, [
      'Synthetic',
      'Layout',
      'Publication',
      'Invented',
      'Test',
      'Edition',
      'Example',
      'Writer',
      'Invented',
      'alpha',
      'text',
      'uses',
      'bold',
      'and',
      'r',
      'aised',
      'marks.',
    ])
    expect(xhtml.visibleTextSegments.join('')).toContain(
      publication.decoded.blocks[0]!.text,
    )
    assertNoHiddenSemanticTextDuplicates('paragraph-positive', xhtml)
    expect(reopenedText(publication, 'EPUB/content.xhtml')).toBe(
      publication.xhtml,
    )
  })

  it('keeps the current whitespace, escaping, and safe-link policy at every boundary', async () => {
    const document = buildSealedSyntheticFixture('paragraph-positive')
    const value = 'Invented  spaced\ntext & <mark> link.'
    const linkStart = value.indexOf('link')
    document.blocks[0]!.text = value
    document.blocks[0]!.inline = [
      { start: 0, end: 8, bold: true },
      {
        start: linkStart,
        end: linkStart + 'link'.length,
        href: 'https://example.invalid/layout?a=1&b=2',
      },
    ]
    resealSyntheticDocument(document)

    const publication = await characterizeSealedDocument(document)
    const xhtml = inspectXhtml(publication.xhtml)

    expect(publication.xhtml).toContain(
      '</strong>  spaced\ntext &amp; &lt;mark&gt;',
    )
    expect(xhtml.hrefs.map(({ value: href }) => href)).toContain(
      'https://example.invalid/layout?a=1&b=2',
    )
    expect(xhtml.visibleTextSegments.join('')).toContain(value)
  })

  it('rejects an out-of-range inline run consistently at all four boundaries', async () => {
    await characterizeCodecRejection('paragraph-negative', 'RANGE')
  })
})

describe('Stage 3 hierarchy contract (HIER-01)', () => {
  it('nests EPUB navigation with the heading stack', async () => {
    const publication = await characterizeRenderedCase('hierarchy-positive')
    const content = inspectXhtml(publication.xhtml)
    const headingBlocks = publication.decoded.blocks
    const blockIds = new Set(headingBlocks.map(({ id }) => id))

    expect(
      content.headings
        .filter(({ id }) => id !== undefined && blockIds.has(id))
        .map(({ id, level, text }) => ({ id, level, text })),
    ).toEqual(
      headingBlocks.map(({ id, text, attributes }) => ({
        id,
        level: attributes!.level,
        text,
      })),
    )

    const navigation = inspectNavigation(
      reopenedText(publication, 'EPUB/nav.xhtml'),
    )
    const [root, nestedTopic, siblingTopic] = headingBlocks
    assertNavigationHierarchy(
      'hierarchy-positive',
      navigation,
      [
        {
          href: `content.xhtml#${root!.id}`,
          label: root!.text,
          children: [
            {
              href: `content.xhtml#${nestedTopic!.id}`,
              label: nestedTopic!.text,
              children: [],
            },
            {
              href: `content.xhtml#${siblingTopic!.id}`,
              label: siblingTopic!.text,
              children: [],
            },
          ],
        },
      ],
    )
    assertNavigationTargets(
      'hierarchy-positive',
      navigation,
      'EPUB/nav.xhtml',
      new Map([
        ['EPUB/content.xhtml', new Set(content.ids)],
      ]),
    )
  })

  it('rejects an unsupported heading level consistently at all four boundaries', async () => {
    await characterizeCodecRejection('hierarchy-negative', 'ATTRIBUTE')
  })
})
