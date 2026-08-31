import { describe, expect, it } from 'vitest'
import {
  buildStructEpub,
  type StructEpubProfile,
} from '../../src/renderers/epub'
import {
  assertNavigationHierarchy,
  assertNavigationTargets,
  assertOpfSpineLinks,
} from './helpers/assertions'
import {
  inspectNavigation,
  inspectOpf,
  inspectXhtml,
} from './helpers/xml'
import {
  characterizeCodecRejection,
  characterizeRenderedCase,
  characterizeReviewRefusal,
  reopenedText,
} from './baseline-characterization'

const contradictoryLtrProfile: StructEpubProfile = {
  id: 'synthetic-ltr-profile',
  version: '1.0.0',
  fileName: 'synthetic-ltr.epub',
  pageProgressionDirection: 'ltr',
  renditionFlow: 'scrolled-continuous',
  configurationSha256: '1'.repeat(64),
  css: 'body { margin-inline: 1rem; }',
}

describe('Stage 2.1 multicolumn baseline characterization', () => {
  it('keeps page-column evidence while rendering canonical block-array order once', async () => {
    const publication = await characterizeRenderedCase('multicolumn-positive')
    const blockIds = publication.decoded.blocks.map(({ id }) => id)
    const content = inspectXhtml(publication.xhtml)
    const css = reopenedText(publication, 'EPUB/styles.css')

    expect(publication.normalized.pages[0]!.columns).toEqual(
      publication.decoded.pages[0]!.columns,
    )
    expect(content.ids.filter((id) => blockIds.includes(id))).toEqual(blockIds)
    expect(
      publication.decoded.blocks.map(({ text }) =>
        publication.xhtml.indexOf(text),
      ),
    ).toEqual(
      publication.decoded.blocks
        .map(({ text }) => publication.xhtml.indexOf(text))
        .sort((left, right) => left - right),
    )
    expect(css).not.toMatch(/column-count|grid-template|float\s*:/u)
  })

  it('rejects a conflicting column membership consistently at all four boundaries', async () => {
    await characterizeCodecRejection(
      'multicolumn-negative',
      'PAGE_BINDING',
    )
  })
})

describe('Stage 2.1 RTL baseline characterization', () => {
  it('sets content direction and language deterministically but currently omits them from nav and unprofiled spine direction', async () => {
    const publication = await characterizeRenderedCase('rtl-positive')
    const content = inspectXhtml(publication.xhtml)
    const navigation = inspectNavigation(
      reopenedText(publication, 'EPUB/nav.xhtml'),
    )
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))
    const second = await buildStructEpub(publication.decoded)

    expect(content.rootLanguage).toEqual({ xml: 'ar', html: 'ar' })
    expect(content.rootDirection).toBe('rtl')
    expect(navigation.document.rootLanguage).toEqual({ xml: 'ar' })
    expect(navigation.document.rootDirection).toBeUndefined()
    expect(opf.language).toBe('ar')
    expect(opf.spine.pageProgressionDirection).toBeUndefined()
    expect(second.bytes).toEqual(publication.epub.bytes)
    expect(second.sha256).toBe(publication.epub.sha256)
  })

  it('currently accepts an explicit LTR profile for an RTL document and packages the contradiction', async () => {
    const profileBefore = structuredClone(contradictoryLtrProfile)
    const publication = await characterizeRenderedCase('rtl-positive', {
      profile: contradictoryLtrProfile,
    })
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))

    expect(opf.spine.pageProgressionDirection).toBe('ltr')
    expect(publication.epub.profile?.pageProgressionDirection).toBe('ltr')
    expect(contradictoryLtrProfile).toEqual(profileBefore)
  })

  it('omits unknown direction from XHTML and refuses publication only because recovery requires review', async () => {
    const refusal = await characterizeReviewRefusal('rtl-safe-ambiguity')
    const content = inspectXhtml(refusal.xhtml)

    expect(refusal.normalized.metadata.baseDirection).toBe('unknown')
    expect(content.rootDirection).toBeUndefined()
  })
})

describe('Stage 2.1 navigation baseline characterization', () => {
  it('emits one unnamed flat toc with a current publication-title item before headings', async () => {
    const publication = await characterizeRenderedCase('navigation-positive')
    const content = inspectXhtml(publication.xhtml)
    const navigation = inspectNavigation(
      reopenedText(publication, 'EPUB/nav.xhtml'),
    )
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))
    const headings = publication.decoded.blocks.filter(
      ({ kind }) => kind === 'heading',
    )
    const currentItems = [
      {
        href: 'content.xhtml',
        label: publication.decoded.metadata.title,
        children: [],
      },
      ...headings.map(({ id, text }) => ({
        href: `content.xhtml#${id}`,
        label: text,
        children: [],
      })),
    ]

    expect(navigation.tocs).toHaveLength(1)
    expect(navigation.tocs[0]!.ariaLabel).toBeUndefined()
    assertNavigationHierarchy(
      'navigation-positive',
      navigation,
      currentItems,
    )
    assertNavigationTargets(
      'navigation-positive',
      navigation,
      'EPUB/nav.xhtml',
      new Map([['EPUB/content.xhtml', new Set(content.ids)]]),
    )
    assertOpfSpineLinks('navigation-positive', opf)
    expect(navigation.document.visibleTextTokens).toContain('Contents')
  })

  it('omits furniture from content and nav but currently keeps the publication-title toc item when no headings exist', async () => {
    const publication = await characterizeRenderedCase(
      'navigation-safe-ambiguity',
    )
    const content = inspectXhtml(publication.xhtml)
    const navigation = inspectNavigation(
      reopenedText(publication, 'EPUB/nav.xhtml'),
    )
    const furniture = publication.decoded.blocks.find(
      ({ kind }) => kind === 'furniture',
    )!

    expect(content.ids).not.toContain(furniture.id)
    expect(content.visibleTextSegments.join('')).not.toContain(furniture.text)
    assertNavigationHierarchy(
      'navigation-safe-ambiguity',
      navigation,
      [
        {
          href: 'content.xhtml',
          label: publication.decoded.metadata.title,
          children: [],
        },
      ],
    )
  })
})
