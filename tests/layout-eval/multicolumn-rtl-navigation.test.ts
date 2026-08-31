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
import { buildSealedSyntheticFixture } from './fixture-builder'

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

describe('Stage 3 RTL contract', () => {
  it('propagates RTL through nav and spine (RTL-01)', async () => {
    const publication = await characterizeRenderedCase('rtl-positive')
    const content = inspectXhtml(publication.xhtml)
    const navigation = inspectNavigation(
      reopenedText(publication, 'EPUB/nav.xhtml'),
    )
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))
    const second = await buildStructEpub(publication.decoded)

    expect(content.rootLanguage).toEqual({ xml: 'ar', html: 'ar' })
    expect(content.rootDirection).toBe('rtl')
    expect(navigation.document.rootLanguage).toEqual({
      xml: 'ar',
      html: 'ar',
    })
    expect(navigation.document.rootDirection).toBe('rtl')
    expect(opf.language).toBe('ar')
    expect(opf.spine.pageProgressionDirection).toBe('rtl')
    expect(second.bytes).toEqual(publication.epub.bytes)
    expect(second.sha256).toBe(publication.epub.sha256)
  })

  it('rejects a contradictory RTL profile (RTL-02)', async () => {
    const profileBefore = structuredClone(contradictoryLtrProfile)

    await expect(
      buildStructEpub(buildSealedSyntheticFixture('rtl-positive'), {
        profile: contradictoryLtrProfile,
      }),
    ).rejects.toThrow('STRUCT_EPUB_PROFILE_DIRECTION_MISMATCH')
    expect(contradictoryLtrProfile).toEqual(profileBefore)
  })

  it('omits unknown direction from XHTML and refuses publication only because recovery requires review', async () => {
    const refusal = await characterizeReviewRefusal('rtl-safe-ambiguity')
    const content = inspectXhtml(refusal.xhtml)

    expect(refusal.normalized.metadata.baseDirection).toBe('unknown')
    expect(content.rootDirection).toBeUndefined()
  })
})

describe('Stage 3 navigation contract (NAV-01)', () => {
  it('uses one named heading-only toc', async () => {
    const publication = await characterizeRenderedCase('navigation-positive')
    const content = inspectXhtml(publication.xhtml)
    const navigation = inspectNavigation(
      reopenedText(publication, 'EPUB/nav.xhtml'),
    )
    const opf = inspectOpf(reopenedText(publication, 'EPUB/package.opf'))
    const headings = publication.decoded.blocks.filter(
      ({ kind }) => kind === 'heading',
    )
    const expectedItems = [
      {
        href: `content.xhtml#${headings[0]!.id}`,
        label: headings[0]!.text,
        children: [
          {
            href: `content.xhtml#${headings[1]!.id}`,
            label: headings[1]!.text,
            children: [],
          },
        ],
      },
    ]

    expect(navigation.tocs).toHaveLength(1)
    expect(navigation.tocs[0]!.ariaLabel).toBe(
      publication.decoded.metadata.title,
    )
    assertNavigationHierarchy(
      'navigation-positive',
      navigation,
      expectedItems,
    )
    assertNavigationTargets(
      'navigation-positive',
      navigation,
      'EPUB/nav.xhtml',
      new Map([['EPUB/content.xhtml', new Set(content.ids)]]),
    )
    assertOpfSpineLinks('navigation-positive', opf)
    expect(navigation.document.headings).toEqual([])

    const furniturePublication = await characterizeRenderedCase(
      'navigation-safe-ambiguity',
    )
    const furnitureContent = inspectXhtml(furniturePublication.xhtml)
    const furnitureNavigation = inspectNavigation(
      reopenedText(furniturePublication, 'EPUB/nav.xhtml'),
    )
    const furniture = furniturePublication.decoded.blocks.find(
      ({ kind }) => kind === 'furniture',
    )!

    expect(furnitureContent.ids).not.toContain(furniture.id)
    expect(furnitureContent.visibleTextSegments.join('')).not.toContain(
      furniture.text,
    )
    expect(furnitureNavigation.tocs[0]!.ariaLabel).toBe(
      furniturePublication.decoded.metadata.title,
    )
    assertNavigationHierarchy(
      'navigation-safe-ambiguity',
      furnitureNavigation,
      [],
    )
  })
})
