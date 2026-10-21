import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { buildStructEpub } from '../src/renderers/epub'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import { MAX_RENDERED_LIST_NESTING_DEPTH } from '../src/renderers/xhtml-lists'
import { RenderedPublicationPlanError } from '../src/renderers/xhtml-plan'
import {
  assetBytesHash,
  evidence,
  seal,
  validDocument,
} from './codec-fixtures'

type FixtureBlock = {
  id: string
  kind: string
  text: string
  label?: string
  order: number
  attributes?: Record<string, string | number | boolean>
  inline?: Array<Record<string, unknown>>
  fallbackAssetIds?: string[]
}

function block(
  id: string,
  kind: string,
  text: string,
  order: number,
  attributes?: Record<string, string | number | boolean>,
): FixtureBlock {
  return { id, kind, text, order, ...(attributes ? { attributes } : {}) }
}

function documentWith(
  blocks: FixtureBlock[],
  relationships: Array<Record<string, unknown>> = [],
  withAsset = false,
) {
  const document: any = validDocument()
  document.blocks = blocks.map((entry) => ({
    page: 1,
    column: 'single',
    inline: [],
    evidence: evidence(),
    ...entry,
  }))
  document.pages = [
    {
      page: 1,
      width: 100,
      height: 100,
      rotation: 0,
      blocks: blocks.map((entry) => entry.id),
      columns: [
        {
          id: 'column-1',
          side: 'single',
          blockIds: blocks.map((entry) => entry.id),
        },
      ],
    },
  ]
  document.relationships = relationships
  document.metadata.authorNotes = []
  document.assets = withAsset
    ? [
        {
          id: 'asset-1',
          kind: 'figure',
          href: 'assets/asset-1.bin',
          mediaType: 'application/octet-stream',
          sha256: assetBytesHash,
          width: 10,
          height: 10,
          bytes: 'AP+A',
          sourceObjectIds: ['source-asset'],
          evidence: evidence(),
          fallback: 'asset',
        },
      ]
    : []
  const text = blocks.reduce((total, entry) => total + entry.text.length, 0)
  document.receipt = {
    ...document.receipt,
    blockCount: blocks.length,
    assetCount: document.assets.length,
    relationshipCount: relationships.length,
    diagnosticCount: document.diagnostics.length,
    textCharacterCount: text,
    conservation: {
      ...document.receipt.conservation,
      sourceAssetCount: document.assets.length,
      accountedSourceAssetCount: document.assets.length,
      sourceRelationshipCount: relationships.length,
      accountedSourceRelationshipCount: relationships.length,
      sourceTextCharacterCount: text,
      structBlockCount: blocks.length,
      structAssetCount: document.assets.length,
      structRelationshipCount: relationships.length,
      structTextCharacterCount: text,
    },
  }
  return seal(document)
}

function captionRelationship(
  id: string,
  from: string,
  to: string,
  status: 'matched' | 'ambiguous' | 'unresolved' = 'matched',
) {
  return {
    id,
    kind: 'caption',
    from,
    to: [to],
    status,
    confidence: 1,
    evidence: evidence(),
  }
}

describe('STRUCT nested lists', () => {
  it('publishes a nested list from the declared level and ordering', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-parent', 'list-item', 'Ordered parent item', 0, {
          listLevel: 0,
          listOrdered: true,
          listOrdinal: 1,
        }),
        block('li-child', 'list-item', 'Nested bullet item', 1, {
          listLevel: 1,
          listOrdered: false,
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ol>\n  <li id="li-parent" data-struct-id="li-parent">Ordered parent item\n    <ul>\n      <li id="li-child" data-struct-id="li-child">Nested bullet item</li>\n      </ul>\n  </li>\n  </ol>',
    )
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('publishes a nested list with the declared start value', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-1', 'list-item', 'third', 0, {
          listLevel: 0,
          listOrdered: true,
          listOrdinal: 3,
        }),
      ]),
    )

    expect(xhtml).toContain('<ol start="3">')
  })

  it('keeps the flat list contract exactly as it was', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('p-1', 'paragraph', 'Intro', 0),
        block('li-1', 'list-item', 'first', 1, { ordered: true, listId: 'a' }),
        block('li-2', 'list-item', 'second', 2, { ordered: true, listId: 'a' }),
        block('li-3', 'list-item', 'bullet', 3, {
          ordered: false,
          listId: 'b',
        }),
        block('p-2', 'paragraph', 'Outro', 4),
      ]),
    )

    expect(xhtml).toContain(
      '<ol>\n  <li id="li-1" data-struct-id="li-1">first</li>\n  <li id="li-2" data-struct-id="li-2">second</li>\n  </ol>',
    )
    expect(xhtml).toContain(
      '<ul>\n  <li id="li-3" data-struct-id="li-3">bullet</li>\n  </ul>',
    )
    expect(xhtml.indexOf('<p id="p-1"')).toBeLessThan(xhtml.indexOf('<ol>'))
  })

  it('starts a sibling list when the sibling ordering changes', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-1', 'list-item', 'numbered', 0, {
          listLevel: 0,
          listOrdered: true,
        }),
        block('li-2', 'list-item', 'bulleted', 1, {
          listLevel: 0,
          listOrdered: false,
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ol>\n  <li id="li-1" data-struct-id="li-1">numbered</li>\n  </ol>\n  <ul>\n  <li id="li-2" data-struct-id="li-2">bulleted</li>\n  </ul>',
    )
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('bounds an invalid level jump to a single nesting step', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-1', 'list-item', 'outer', 0, {
          listLevel: 0,
          listOrdered: false,
        }),
        block('li-2', 'list-item', 'inner', 1, {
          listLevel: 3,
          listOrdered: false,
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ul>\n  <li id="li-1" data-struct-id="li-1">outer\n    <ul>\n      <li id="li-2" data-struct-id="li-2">inner</li>\n      </ul>\n  </li>\n  </ul>',
    )
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('bounds the rendered nesting depth', () => {
    const blocks = Array.from(
      { length: MAX_RENDERED_LIST_NESTING_DEPTH + 8 },
      (_, index) =>
        block(`li-${index}`, 'list-item', `item ${index}`, index, {
          listLevel: index,
          listOrdered: false,
        }),
    )
    const xhtml = renderPublicationXhtml(documentWith(blocks))
    const depth = (xhtml.match(/<ul>/g) ?? []).length

    // The outermost list plus at most MAX_RENDERED_LIST_NESTING_DEPTH
    // nested lists.
    expect(depth).toBe(MAX_RENDERED_LIST_NESTING_DEPTH + 1)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('keeps the inline code mark inside a list item', () => {
    const document = documentWith([
      {
        ...block('li-1', 'list-item', 'call build()', 0, {
          listLevel: 0,
          listOrdered: false,
        }),
        inline: [{ start: 5, end: 12, code: true }],
      },
    ])
    const xhtml = renderPublicationXhtml(document)

    expect(xhtml).toContain(
      '<li id="li-1" data-struct-id="li-1">call <code>build()</code></li>',
    )
  })

  it('groups by the relative level, whatever the level base is', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-1', 'list-item', 'outer', 0, {
          listLevel: 1,
          listOrdered: true,
        }),
        block('li-2', 'list-item', 'inner', 1, {
          listLevel: 2,
          listOrdered: false,
        }),
        block('li-3', 'list-item', 'inner sibling', 2, {
          listLevel: 2,
          listOrdered: false,
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ol>\n  <li id="li-1" data-struct-id="li-1">outer\n    <ul>\n      <li id="li-2" data-struct-id="li-2">inner</li>\n      <li id="li-3" data-struct-id="li-3">inner sibling</li>\n      </ul>\n  </li>\n  </ol>',
    )
  })

  it('keeps the list identity as a boundary inside a nested list', () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-1', 'list-item', 'first list', 0, {
          listLevel: 0,
          listOrdered: false,
          listId: 'a',
        }),
        block('li-2', 'list-item', 'second list', 1, {
          listLevel: 0,
          listOrdered: false,
          listId: 'b',
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ul>\n  <li id="li-1" data-struct-id="li-1">first list</li>\n  </ul>\n  <ul>\n  <li id="li-2" data-struct-id="li-2">second list</li>\n  </ul>',
    )
  })

  it('keeps the declared nesting of the list after a listId boundary', () => {
    // The listId boundary stays hard: the second list never joins the first
    // list's container. The second list keeps its own declared nesting: its
    // items declare level 1, so the second list is rooted one level deep
    // instead of being flattened to the root level.
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-a1', 'list-item', 'li-a1', 0, {
          listLevel: 0,
          listOrdered: false,
          listId: 'a',
        }),
        block('li-a2', 'list-item', 'li-a2', 1, {
          listLevel: 1,
          listOrdered: false,
          listId: 'a',
        }),
        block('li-b1', 'list-item', 'li-b1', 2, {
          listLevel: 1,
          listOrdered: false,
          listId: 'b',
        }),
        block('li-b2', 'list-item', 'li-b2', 3, {
          listLevel: 1,
          listOrdered: false,
          listId: 'b',
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ul>\n  <li id="li-a1" data-struct-id="li-a1">li-a1\n    <ul>\n      <li id="li-a2" data-struct-id="li-a2">li-a2</li>\n      </ul>\n    <ul>\n      <li id="li-b1" data-struct-id="li-b1">li-b1</li>\n      <li id="li-b2" data-struct-id="li-b2">li-b2</li>\n      </ul>\n  </li>\n  </ul>',
    )
    // The boundary is still hard: the second list is its own container.
    expect(xhtml.match(/<ul>/g)).toHaveLength(3)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('publishes a mixed flat and nested run as one list', () => {
    // A contiguous run of list items is one list: the item that does not
    // declare the nested contract is the outermost item of the same list.
    const xhtml = renderPublicationXhtml(
      documentWith([
        block('li-1', 'list-item', 'first', 0, { ordered: true }),
        block('li-2', 'list-item', 'second', 1, {
          listLevel: 0,
          listOrdered: true,
        }),
        block('li-3', 'list-item', 'third', 2, {
          listLevel: 1,
          listOrdered: true,
        }),
      ]),
    )

    expect(xhtml).toContain(
      '<ol>\n  <li id="li-1" data-struct-id="li-1">first</li>\n  <li id="li-2" data-struct-id="li-2">second\n    <ol>\n      <li id="li-3" data-struct-id="li-3">third</li>\n      </ol>\n  </li>\n  </ol>',
    )
    expect(xhtml.match(/<\/ol>/g)).toHaveLength(2)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })
})

describe('STRUCT figure captions', () => {
  it('publishes an attached caption once, inside the figure figcaption', () => {
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
            label: 'A synthetic image.',
          },
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1')],
      ),
    )

    expect(xhtml.match(/Figure 1\. A synthetic image\./g)).toHaveLength(1)
    expect(xhtml).toContain(
      '<figcaption id="caption-1" data-struct-id="caption-1" data-relationship-id="rel-1">Figure 1. A synthetic image.</figcaption>',
    )
    expect(xhtml).not.toContain('class="caption"')
  })

  it('keeps the alt text of a figure whose caption is attached', () => {
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
            label: 'A synthetic image.',
            fallbackAssetIds: ['asset-1'],
          },
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1')],
        true,
      ),
    )

    expect(xhtml).toContain('alt="A synthetic image."')
  })

  it('publishes an unlinked caption that repeats the same text', () => {
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
            label: 'A synthetic image.',
          },
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
          block('caption-2', 'caption', 'Figure 1. A synthetic image.', 2),
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1')],
      ),
    )

    expect(xhtml.match(/Figure 1\. A synthetic image\./g)).toHaveLength(2)
    expect(xhtml).toContain(
      '<p id="caption-2" data-struct-id="caption-2" class="caption">Figure 1. A synthetic image.</p>',
    )
  })

  it('does not attach a caption whose relationship is not matched', () => {
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
            label: 'A synthetic image.',
          },
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1', 'ambiguous')],
      ),
    )

    expect(xhtml).toContain(
      '<p id="caption-1" data-struct-id="caption-1" class="caption">Figure 1. A synthetic image.</p>',
    )
    expect(xhtml).toContain(
      '<figure id="figure-1" data-struct-id="figure-1"><figcaption>Figure 1. A synthetic image.</figcaption></figure>',
    )
  })

  it('does not attach a caption that two hosts claim', () => {
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
            label: 'A synthetic image.',
          },
          {
            ...block('figure-2', 'figure', 'Figure 2. A synthetic image.', 1),
            label: 'A synthetic image.',
          },
          block('caption-1', 'caption', 'Shared caption.', 2),
        ],
        [
          captionRelationship('rel-1', 'figure-1', 'caption-1'),
          captionRelationship('rel-2', 'figure-2', 'caption-1'),
        ],
      ),
    )

    expect(xhtml).toContain(
      '<p id="caption-1" data-struct-id="caption-1" class="caption">Shared caption.</p>',
    )
  })

  it('publishes an attached caption once when the caption block comes first', () => {
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 0),
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 1),
            label: 'A synthetic image.',
          },
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1')],
      ),
    )

    expect(xhtml.match(/Figure 1\. A synthetic image\./g)).toHaveLength(1)
    expect(xhtml).toContain(
      '<figcaption id="caption-1" data-struct-id="caption-1" data-relationship-id="rel-1">Figure 1. A synthetic image.</figcaption>',
    )
    expect(xhtml.match(/ id="caption-1"/g)).toHaveLength(1)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('publishes the attached caption once in the EPUB content document', async () => {
    const document = documentWith(
      [
        {
          ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
          label: 'A synthetic image.',
        },
        block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
        block('li-parent', 'list-item', 'Ordered parent item', 2, {
          listLevel: 0,
          listOrdered: true,
        }),
        block('li-child', 'list-item', 'Nested bullet item', 3, {
          listLevel: 1,
          listOrdered: false,
        }),
      ],
      [captionRelationship('rel-1', 'figure-1', 'caption-1')],
    )
    const epub = await buildStructEpub(document)
    const content = strFromU8(unzipSync(epub.bytes)['EPUB/content.xhtml']!)

    expect(content.match(/Figure 1\. A synthetic image\./g)).toHaveLength(1)
    expect(content).toContain('<figcaption id="caption-1"')
    expect(content).toContain(
      '<ol>\n  <li id="li-parent" data-struct-id="li-parent">Ordered parent item\n    <ul>\n      <li id="li-child" data-struct-id="li-child">Nested bullet item</li>\n      </ul>\n  </li>\n  </ol>',
    )
  })

  it('publishes the attached caption once when the host carries the same text', () => {
    // Precedence: the attached caption is the host's caption. The host's own
    // copy of the caption text is the duplicate and is not published twice.
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', 'Figure 1. A synthetic image.', 0),
            label: 'A synthetic image.',
          },
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1')],
      ),
    )

    expect(xhtml.match(/Figure 1\. A synthetic image\./g)).toHaveLength(1)
    expect(xhtml).toContain(
      '<figcaption id="caption-1" data-struct-id="caption-1" data-relationship-id="rel-1">Figure 1. A synthetic image.</figcaption>',
    )
  })

  it('refuses a host whose own caption text differs from the attached caption', () => {
    // The host's own text is not silently dropped: the document is
    // inconsistent and the renderer refuses it instead of publishing a
    // caption that contradicts the host's own text.
    const document = documentWith(
      [
        {
          ...block('figure-1', 'figure', 'HOST TEXT', 0),
          label: 'A synthetic image.',
        },
        block('caption-1', 'caption', 'CAPTION TEXT', 1),
      ],
      [captionRelationship('rel-1', 'figure-1', 'caption-1')],
    )

    let raised: unknown
    try {
      renderPublicationXhtml(document)
    } catch (error) {
      raised = error
    }

    expect(raised).toBeInstanceOf(RenderedPublicationPlanError)
    expect((raised as RenderedPublicationPlanError).code).toBe(
      'CONFLICTING_CAPTION',
    )
  })

  it('publishes the attached caption when the host carries no own caption text', () => {
    // The host has no figcaption text of its own: its label stays published
    // as the alt attribute and the attached caption is the host's caption.
    const xhtml = renderPublicationXhtml(
      documentWith(
        [
          {
            ...block('figure-1', 'figure', '', 0),
            label: 'A synthetic image.',
            fallbackAssetIds: ['asset-1'],
          },
          block('caption-1', 'caption', 'Figure 1. A synthetic image.', 1),
        ],
        [captionRelationship('rel-1', 'figure-1', 'caption-1')],
        true,
      ),
    )

    expect(xhtml).toContain('alt="A synthetic image."')
    expect(xhtml).toContain(
      '<figcaption id="caption-1" data-struct-id="caption-1" data-relationship-id="rel-1">Figure 1. A synthetic image.</figcaption>',
    )
    expect(xhtml).not.toContain('class="caption"')
  })
})
