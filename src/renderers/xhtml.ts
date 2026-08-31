import type {
  StructBlock,
  StructDocument,
  StructTable,
  StructTableCell,
} from '../document/types'
import {
  buildRenderedPublicationPlan,
  emittedXhtmlIds,
  groupedCitationLinks,
  isPackagedAssetId,
  RenderedPublicationPlanError,
  resolveStructTarget,
  stableId,
  type EmittedXhtmlId,
  type RenderedInlineSourcePlan,
  type RenderedPublicationPlan,
} from './xhtml-plan'
import {
  normalizeStructDocumentForRenderer,
  selectPublicationAccessibleText,
} from './ingress'
import { verifyStructReceipt } from '../receipt'
import {
  isStructCodecError,
  stringValue,
} from '../document/codec/primitives'

export type StructXhtmlOptions = {
  embedStyles?: boolean
  styles?: string
}

const DEFAULT_STYLES = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }`

const XHTML_OPTION_KEYS = new Set(['embedStyles', 'styles'])

function snapshotXhtmlOptions(value: unknown): StructXhtmlOptions {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error()
    const keys = Reflect.ownKeys(value)
    if (
      keys.some(
        (key) => typeof key !== 'string' || !XHTML_OPTION_KEYS.has(key),
      )
    )
      throw new Error()
    const snapshot: StructXhtmlOptions = {}
    for (const key of keys as Array<keyof StructXhtmlOptions>) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new Error()
      if (key === 'embedStyles') {
        if (typeof descriptor.value !== 'boolean') throw new Error()
        snapshot.embedStyles = descriptor.value
      } else {
        try {
          snapshot.styles = stringValue(descriptor.value, '$.options.styles')
        } catch (error) {
          if (isStructCodecError(error) && error.code === 'BUDGET')
            throw new Error('STRUCT_XHTML_STYLES_RESOURCE_LIMIT')
          throw error
        }
      }
    }
    return snapshot
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'STRUCT_XHTML_STYLES_RESOURCE_LIMIT'
    )
      throw error
    throw new Error('STRUCT_XHTML_OPTIONS_INVALID')
  }
}

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;')
}

function renderInline(
  document: StructDocument,
  source: RenderedInlineSourcePlan,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const { value } = source
  const plan = source.segments
  if (plan.length === 0) return text(value)
  return plan
    .map((segment) => {
      const { start, end, owners } = segment
      const segmentValue = value.slice(start, end)
      const styled = (content: string) => {
        let rendered = content
        for (const run of owners) {
          if (run.bold) rendered = `<strong>${rendered}</strong>`
          if (run.italic) rendered = `<em>${rendered}</em>`
          if (run.verticalAlign === 'superscript') {
            rendered = `<sup>${rendered}</sup>`
          } else if (run.verticalAlign === 'subscript') {
            rendered = `<sub>${rendered}</sub>`
          }
        }
        return rendered
      }
      let rendered = styled(text(segmentValue))
      const semanticOwnerIndex = owners.findIndex(
        (run) => run.semanticRole && run.relationshipId,
      )
      const semanticRun =
        semanticOwnerIndex >= 0 ? owners[semanticOwnerIndex] : undefined
      const semantic =
        semanticOwnerIndex >= 0
          ? publicationPlan.semanticByOwnerKey.get(
              segment.ownerKeys[semanticOwnerIndex]!,
            )
          : undefined
      if (semanticRun?.relationshipId && semanticRun.semanticRole && semantic) {
        const relationshipId = semantic.relationshipIdStable
        const firstSegment = !emittedRelationshipIds.has(relationshipId)
        emittedRelationshipIds.add(relationshipId)
        const id = firstSegment ? ` id="${attribute(relationshipId)}"` : ''
        const targets = semantic.targets
        const semanticAttributes = semantic.semanticAttributes
        if (targets.length === 0) {
          rendered = `<span${id}${semanticAttributes}>${rendered}</span>`
        } else {
          const epubRole = semantic.epubRole
          if (targets.length === 1) {
            rendered = `<a${id} href="${attribute(targets[0]!.href)}"${epubRole}${semanticAttributes}>${rendered}</a>`
          } else {
            const grouped =
              semanticRun.semanticRole === 'citation'
                ? groupedCitationLinks(
                    segmentValue,
                    semantic.citationRanges,
                    semantic.targetById,
                    epubRole,
                    start - semanticRun.start!,
                  )
                : { html: text(segmentValue), linkedTargets: new Set<string>() }
            rendered = `<span${id}${semanticAttributes}>${styled(grouped!.html)}${firstSegment ? semantic.additionalTargets : ''}</span>`
          }
        }
      } else {
        const hyperlinkOwnerIndex = owners.findIndex(
          (run) => run.href || run.targetIds?.length,
        )
        const hyperlink =
          hyperlinkOwnerIndex >= 0
            ? publicationPlan.hyperlinkByOwnerKey.get(
                segment.ownerKeys[hyperlinkOwnerIndex]!,
              )
            : undefined
        if (hyperlink)
          rendered = `<a href="${attribute(hyperlink.href)}">${rendered}</a>`
      }
      return rendered
    })
    .join('')
}

function renderTable(
  document: StructDocument,
  table: StructTable,
  caption: string,
  tableBlockId: string,
  blockIndex: number,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const rows = Array.from({ length: table.rows }, () => [] as string[])
  const cells = new Map<string, { cell: StructTableCell; index: number }>(
    table.cells.map(
      (cell, index) => [`${cell.row}:${cell.column}`, { cell, index }] as const,
    ),
  )
  const occupied = new Set<string>()
  for (let row = 0; row < table.rows; row += 1) {
    for (let column = 0; column < table.columns; column += 1) {
      const coordinate = `${row}:${column}`
      if (occupied.has(coordinate)) continue
      const cellEntry = cells.get(coordinate)
      if (!cellEntry) {
        rows[row]!.push('<td></td>')
        continue
      }
      const { cell, index: cellIndex } = cellEntry
      const tag = cell.headerScope ? 'th' : 'td'
      const htmlScope = cell.headerScope === 'column' ? 'col' : cell.headerScope
      const scope = htmlScope ? ` scope="${htmlScope}"` : ''
      const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
      const columnSpan =
        cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
      rows[row]!.push(
        `<${tag} id="${attribute(`${tableBlockId}-${cell.id}`)}"${scope}${rowSpan}${columnSpan}>${renderInline(
          document,
          publicationPlan.sourceByKey.get(`table:${blockIndex}:${cellIndex}`)!,
          emittedRelationshipIds,
          publicationPlan,
        )}</${tag}>`,
      )
      for (
        let occupiedRow = cell.row;
        occupiedRow < cell.row + cell.rowSpan;
        occupiedRow += 1
      )
        for (
          let occupiedColumn = cell.column;
          occupiedColumn < cell.column + cell.columnSpan;
          occupiedColumn += 1
        )
          occupied.add(`${occupiedRow}:${occupiedColumn}`)
    }
  }
  return `<table><caption>${text(caption)}</caption>${rows.map((row) => `<tr>${row.join('')}</tr>`).join('')}</table>`
}

function renderAuthors(
  document: StructDocument,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  if (document.metadata.authors.length === 0) return ''
  const targetCache = new Map<string, ReturnType<typeof resolveStructTarget>>()
  for (const asset of document.assets)
    if (isPackagedAssetId(asset.id))
      targetCache.set(asset.id, {
        id: asset.id,
        href: asset.href,
        kind: 'asset',
      })
  for (const block of document.blocks)
    if (block.kind !== 'furniture' && !targetCache.has(block.id))
      targetCache.set(block.id, {
        id: block.id,
        href: `#${block.id}`,
        kind: 'block',
      })
  const authors = document.metadata.authors
    .map((author) => {
      const references = (publicationPlan.authorNotesByAuthor.get(author) ?? [])
        .map((reference) => {
          const target =
            targetCache.get(reference.target) ??
            resolveStructTarget(document, reference.target)
          targetCache.set(reference.target, target)
          emittedRelationshipIds.add(stableId(reference.id))
          return `<sup><a id="${attribute(stableId(reference.id))}" href="${attribute(target.href)}" epub:type="noteref" role="doc-noteref">${text(reference.label)}</a></sup>`
        })
        .join('')
      return `${text(author)}${references}`
    })
    .join(', ')
  return `<p class="authors">${authors}</p>`
}

function renderSourceObservationAnchors(block: StructBlock) {
  return (block.sourceObservationAnchorIds ?? [])
    .map(
      (anchorId) =>
        `<span id="${attribute(anchorId)}" class="visually-hidden source-observation-anchor" aria-hidden="true"></span>`,
    )
    .join('')
}

type CaptionBlock = { block: StructBlock; blockIndex: number }

type BlockRenderingPlan = {
  assetsById: ReadonlyMap<string, StructDocument['assets'][number]>
  describedByByFigure: ReadonlyMap<string, readonly string[]>
  nestedCaptionIds: ReadonlySet<string>
  nestedCaptionsByFigure: ReadonlyMap<string, readonly CaptionBlock[]>
}

function isRenderedFigureBlock(block: StructBlock): boolean {
  return (
    block.kind === 'figure' ||
    block.kind === 'equation' ||
    (block.kind === 'table' && block.table === undefined)
  )
}

function buildBlockRenderingPlan(document: StructDocument): BlockRenderingPlan {
  const blocksById = new Map(
    document.blocks.map((block, blockIndex) => [
      block.id,
      { block, blockIndex },
    ]),
  )
  const figureTargetsByCaption = new Map<string, Set<string>>()
  for (const relationship of document.relationships) {
    if (relationship.kind !== 'caption' || relationship.status !== 'matched')
      continue
    const caption = blocksById.get(relationship.from)?.block
    if (caption?.kind !== 'caption') continue
    const targets = figureTargetsByCaption.get(caption.id) ?? new Set<string>()
    for (const value of relationship.to) {
      const targetId = value.startsWith('#') ? value.slice(1) : value
      const target = blocksById.get(targetId)?.block
      if (target && isRenderedFigureBlock(target)) targets.add(target.id)
    }
    if (targets.size > 0) figureTargetsByCaption.set(caption.id, targets)
  }

  const nestedCaptionIds = new Set<string>()
  const nestedCaptionsByFigure = new Map<string, CaptionBlock[]>()
  const describedByByFigure = new Map<string, string[]>()
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.kind !== 'caption') continue
    const targetIds = [...(figureTargetsByCaption.get(block.id) ?? [])]
    const singleTarget =
      targetIds.length === 1 ? blocksById.get(targetIds[0]!) : undefined
    if (singleTarget && singleTarget.blockIndex + 1 === blockIndex) {
      const captions = nestedCaptionsByFigure.get(targetIds[0]!) ?? []
      captions.push({ block, blockIndex })
      nestedCaptionsByFigure.set(targetIds[0]!, captions)
      nestedCaptionIds.add(block.id)
      continue
    }
    for (const targetId of targetIds) {
      const captionIds = describedByByFigure.get(targetId) ?? []
      captionIds.push(block.id)
      describedByByFigure.set(targetId, captionIds)
    }
  }

  return {
    assetsById: new Map(document.assets.map((asset) => [asset.id, asset])),
    describedByByFigure,
    nestedCaptionIds,
    nestedCaptionsByFigure,
  }
}

function renderNestedFigureCaptions(
  document: StructDocument,
  captions: readonly CaptionBlock[],
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
): string {
  if (captions.length === 0) return ''
  if (captions.length === 1) {
    const { block, blockIndex } = captions[0]!
    const id = attribute(block.id)
    return `<figcaption id="${id}" data-struct-id="${id}">${renderSourceObservationAnchors(block)}${renderInline(
      document,
      publicationPlan.sourceByKey.get(`block:${blockIndex}`)!,
      emittedRelationshipIds,
      publicationPlan,
    )}</figcaption>`
  }
  return `<figcaption>${captions
    .map(({ block, blockIndex }) => {
      const id = attribute(block.id)
      return `<p id="${id}" data-struct-id="${id}" class="caption">${renderSourceObservationAnchors(block)}${renderInline(
        document,
        publicationPlan.sourceByKey.get(`block:${blockIndex}`)!,
        emittedRelationshipIds,
        publicationPlan,
      )}</p>`
    })
    .join('')}</figcaption>`
}

function renderBlock(
  document: StructDocument,
  block: StructBlock,
  blockIndex: number,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
  blockRenderingPlan: BlockRenderingPlan,
) {
  // Furniture remains queryable in STRUCT with its source evidence, but is
  // intentionally outside the publication reading flow.
  if (block.kind === 'furniture') return ''
  if (
    block.kind === 'caption' &&
    blockRenderingPlan.nestedCaptionIds.has(block.id)
  )
    return ''
  const id = attribute(block.id)
  const sourceAnchors = renderSourceObservationAnchors(block)
  if (block.kind === 'table' && block.table) {
    if (block.table.semantic === 'source-preserved') {
      const fallback = block.table.accessibleFallback!
      const accessibleName =
        fallback.accessibleNameSource === 'block-label'
          ? block.label!
          : block.text
      return `<div id="${id}" data-struct-id="${id}" data-table-fallback="source-preserved" role="group" aria-label="${attribute(accessibleName)}">${sourceAnchors}<p>${text(block.text)}</p></div>`
    }
    const caption = selectPublicationAccessibleText(block.label, block.text)!
    return `<div id="${id}" data-struct-id="${id}">${sourceAnchors}${renderTable(document, block.table, caption, block.id, blockIndex, emittedRelationshipIds, publicationPlan)}</div>`
  }
  const content = renderInline(
    document,
    publicationPlan.sourceByKey.get(`block:${blockIndex}`)!,
    emittedRelationshipIds,
    publicationPlan,
  )
  if (block.kind === 'heading') {
    const level = Math.max(1, Math.min(6, Number(block.attributes?.level ?? 2)))
    return `<h${level} id="${id}" data-struct-id="${id}">${sourceAnchors}${content}</h${level}>`
  }
  if (block.kind === 'quote') {
    return `<blockquote id="${id}" data-struct-id="${id}">${sourceAnchors}<p>${content}</p></blockquote>`
  }
  if (
    block.kind === 'figure' ||
    block.kind === 'equation' ||
    block.kind === 'table'
  ) {
    const assets = (block.fallbackAssetIds ?? [])
      .flatMap((assetId) => {
        const asset = blockRenderingPlan.assetsById.get(assetId)
        return asset ? [asset] : []
      })
    const alternativeText = selectPublicationAccessibleText(
      block.label,
      block.text,
    )
    const artwork = assets
      .map(
        (asset) =>
          `<img src="${attribute(asset.href)}" alt="${attribute(alternativeText!)}" />`,
      )
      .join('')
    const describedBy = blockRenderingPlan.describedByByFigure.get(block.id)
    const description = describedBy?.length
      ? ` aria-describedby="${attribute(describedBy.join(' '))}"`
      : ''
    const nestedCaptions =
      blockRenderingPlan.nestedCaptionsByFigure.get(block.id) ?? []
    if (nestedCaptions.length > 0) {
      const fallbackContent =
        content || (assets.length === 0 ? text(block.label ?? '') : '')
      return `<figure id="${id}" data-struct-id="${id}"${description}>${sourceAnchors}${artwork}${fallbackContent ? `<p class="figure-fallback">${fallbackContent}</p>` : ''}${renderNestedFigureCaptions(document, nestedCaptions, emittedRelationshipIds, publicationPlan)}</figure>`
    }
    return `<figure id="${id}" data-struct-id="${id}"${description}>${sourceAnchors}${artwork}<figcaption>${content || text(block.label ?? '')}</figcaption></figure>`
  }
  if (block.kind === 'caption') {
    return `<p id="${id}" data-struct-id="${id}" class="caption">${sourceAnchors}${content}</p>`
  }
  if (block.kind === 'footnote' || block.kind === 'endnote') {
    const noteRole =
      block.kind === 'endnote' ? 'doc-endnote' : 'doc-footnote'
    const backlinks = (publicationPlan.backlinksByTarget.get(block.id) ?? [])
      .map(
        (relationship) =>
          `<a href="#${attribute(stableId(relationship.id))}" class="note-backlink" aria-label="Back to note reference">↩</a>`,
      )
      .join(' ')
    return `<aside id="${id}" data-struct-id="${id}" epub:type="${block.kind}" role="${noteRole}" data-note-kind="${block.kind}">${sourceAnchors}<p>${content}${backlinks ? ` ${backlinks}` : ''}</p></aside>`
  }
  if (block.kind === 'code') {
    return `<pre id="${id}" data-struct-id="${id}">${sourceAnchors}<code>${content}</code></pre>`
  }
  const bibliographyEntry = block.attributes?.bibliographyEntry
    ? ' epub:type="bibliography" role="doc-bibliography" data-semantic-role="bibliography-entry"'
    : ''
  return `<p id="${id}" data-struct-id="${id}"${bibliographyEntry}>${sourceAnchors}${content}</p>`
}

function assertUniqueEmittedIds(entries: readonly EmittedXhtmlId[]) {
  const seen = new Map<string, string>()
  for (const { id, path } of entries) {
    const previous = seen.get(id)
    if (previous)
      throw new RenderedPublicationPlanError(
        'DUPLICATE_IDENTIFIER',
        path,
        'duplicate emitted XHTML identifier',
      )
    seen.set(id, path)
  }
}

/** Render a source-agnostic STRUCT graph without consulting extractor state. */
export function renderPublicationXhtml(
  document: StructDocument,
  options: StructXhtmlOptions = {},
) {
  options = snapshotXhtmlOptions(options)
  document = normalizeStructDocumentForRenderer(document)
  const publicationPlan = buildRenderedPublicationPlan(document)
  const blockRenderingPlan = buildBlockRenderingPlan(document)
  assertUniqueEmittedIds(emittedXhtmlIds(document, publicationPlan))
  if (!verifyStructReceipt(document))
    throw new Error('STRUCT_RECEIPT_BINDING_MISMATCH')
  const emittedRelationshipIds = new Set<string>()
  const language = document.metadata.language ?? 'und'
  const direction =
    document.metadata.baseDirection === 'ltr' ||
    document.metadata.baseDirection === 'rtl'
      ? ` dir="${document.metadata.baseDirection}"`
      : ''
  const styles = options.styles ?? DEFAULT_STYLES
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}" lang="${attribute(language)}"${direction}>
<head>
  <meta charset="utf-8" />
  <title>${text(document.metadata.title)}</title>
  ${options.embedStyles ? `<style>${text(styles)}</style>` : '<link rel="stylesheet" type="text/css" href="styles.css" />'}
</head>
<body>
  <header><h1>${text(document.metadata.title)}</h1>${document.metadata.subtitle ? `<p>${text(document.metadata.subtitle)}</p>` : ''}${renderAuthors(document, emittedRelationshipIds, publicationPlan)}</header>
  ${document.blocks.map((block, blockIndex) => renderBlock(document, block, blockIndex, emittedRelationshipIds, publicationPlan, blockRenderingPlan)).join('\n  ')}
</body>
</html>
`
}
