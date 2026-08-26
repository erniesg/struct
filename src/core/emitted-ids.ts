import type { StructDocument, StructInline } from './types'

const EPUB_RESERVED_IDS = new Set([
  'publication-id',
  'nav',
  'content',
  'styles',
  'struct',
  'profile',
])

/**
 * Publication planning budgets. These bound the work which can be expanded
 * into owner arrays and markup, rather than rejecting a raw run count: a
 * document with many disjoint runs is linear, while nested runs can be
 * quadratic. No valid run is truncated or reordered.
 */
export const MAX_RENDERED_INLINE_SEGMENTS = 250_000
export const MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS = 750_000
export const MAX_RENDERED_INLINE_WRAPPER_BYTES = 16_000_000
const ESTIMATED_WRAPPER_BYTES_PER_OWNER = 64
const ESTIMATED_CITATION_RANGE_VISIT_BYTES = 16
const MAX_CITATION_MATCH_WORK = MAX_RENDERED_INLINE_SEGMENTS
const MAX_RENDERED_INLINE_EVENT_STORAGE = MAX_RENDERED_INLINE_SEGMENTS * 4

export type StructTarget = {
  id: string
  href: string
  kind: 'asset' | 'block' | 'external'
}

export function isPackagedAssetId(value: string) {
  return (
    /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value) && !EPUB_RESERVED_IDS.has(value)
  )
}

/** Resolve every publication target through the same local/external rules. */
export function resolveStructTarget(
  document: StructDocument,
  value: string,
): StructTarget {
  const id = value.startsWith('#') ? value.slice(1) : value
  const asset = document.assets.find((entry) => entry.id === id)
  if (asset) {
    if (!isPackagedAssetId(asset.id))
      throw new Error(`STRUCT target asset is not packageable: ${asset.id}`)
    return { id: asset.id, href: asset.href, kind: 'asset' }
  }
  const block = document.blocks.find((entry) => entry.id === id)
  if (block) {
    if (block.kind === 'furniture')
      throw new Error(`STRUCT target block is not rendered: ${block.id}`)
    return { id: block.id, href: `#${block.id}`, kind: 'block' }
  }
  if (/^(?:https?|mailto):/iu.test(value))
    return { id: value, href: value, kind: 'external' }
  throw new Error(`STRUCT target is not renderable: ${value}`)
}

type PlanningTargetIndex = ReadonlyMap<
  string,
  { id: string; href: string; kind: 'asset' | 'block'; furniture?: boolean }
>

function buildPlanningTargetIndex(
  document: StructDocument,
): PlanningTargetIndex {
  const index = new Map<
    string,
    { id: string; href: string; kind: 'asset' | 'block'; furniture?: boolean }
  >()
  for (const asset of document.assets)
    index.set(asset.id, { id: asset.id, href: asset.href, kind: 'asset' })
  for (const block of document.blocks)
    if (!index.has(block.id))
      index.set(block.id, {
        id: block.id,
        href: `#${block.id}`,
        kind: 'block',
        furniture: block.kind === 'furniture',
      })
  return index
}

function resolvePlanningTarget(
  index: PlanningTargetIndex,
  value: string,
): StructTarget {
  const id = value.startsWith('#') ? value.slice(1) : value
  const target = index.get(id)
  if (target) {
    if (target.kind === 'asset') {
      if (!isPackagedAssetId(target.id))
        throw new Error(`STRUCT target asset is not packageable: ${target.id}`)
      return { id: target.id, href: target.href, kind: target.kind }
    }
    if (target.furniture)
      throw new Error(`STRUCT target block is not rendered: ${target.id}`)
    return { id: target.id, href: target.href, kind: target.kind }
  }
  if (/^(?:https?|mailto):/iu.test(value))
    return { id: value, href: value, kind: 'external' }
  throw new Error(`STRUCT target is not renderable: ${value}`)
}

function resolvePlanningTargetLazily(
  getTargetIndex: () => PlanningTargetIndex,
  value: string,
): StructTarget {
  if (/^(?:https?|mailto):/iu.test(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value))
      return { id: value, href: value, kind: 'external' }
    const index = getTargetIndex()
    if (!index.has(value)) return { id: value, href: value, kind: 'external' }
  }
  return resolvePlanningTarget(getTargetIndex(), value)
}

export type EmittedXhtmlId = {
  id: string
  path: string
}

/** Keep the renderer's XML-compatible identifier normalization in one place. */
export function stableId(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/u.test(cleaned) ? cleaned : `n-${cleaned}`
}

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/\"/g, '&quot;')
}

const UNICODE_DECIMAL_ZERO_CODE_POINTS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
  0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0,
  0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730,
  0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50,
  0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950,
  0x1fbf0,
] as const

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
}

function normalizedNumericToken(value: string) {
  return [...value]
    .map((character) => {
      if (SUPERSCRIPT_DIGITS[character]) return SUPERSCRIPT_DIGITS[character]
      const codePoint = character.codePointAt(0)!
      const zero = UNICODE_DECIMAL_ZERO_CODE_POINTS.find(
        (candidate) => codePoint >= candidate && codePoint <= candidate + 9,
      )
      return zero === undefined ? character : String(codePoint - zero)
    })
    .join('')
}

function foldedCitationText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/’/gu, "'")
    .toLocaleLowerCase()
}

function citationRanges(
  sourceValue: string,
  labels: readonly string[],
  targets: readonly StructTarget[],
  path: string,
  totals: PlanningTotals,
) {
  if (
    labels.length !== targets.length ||
    new Set(labels).size !== labels.length
  )
    return null
  const targetByLabel = new Map(
    labels.map((label, index) => [label, targets[index]!.id] as const),
  )
  const labelsByYear = new Map<
    string,
    Array<{ label: string; index: number; surname: string }>
  >()
  for (const [index, label] of labels.entries()) {
    const separator = label.lastIndexOf(':')
    if (separator <= 0) continue
    const year = label.slice(separator + 1)
    const candidates = labelsByYear.get(year) ?? []
    candidates.push({
      label,
      index,
      surname: foldedCitationText(label.slice(0, separator)),
    })
    labelsByYear.set(year, candidates)
  }
  const ranges: Array<{ start: number; end: number; target: string }> = [
    ...sourceValue.matchAll(/[\p{Nd}⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu),
  ].flatMap((match) => {
    const target = targetByLabel.get(normalizedNumericToken(match[0]))
    const start = match.index ?? -1
    return target && start >= 0
      ? [{ start, end: start + match[0].length, target }]
      : []
  })
  const linkedTargets = new Set(ranges.map((range) => range.target))
  for (const match of sourceValue.matchAll(/\b(?:18|19|20)\d{2}[a-z]?\b/giu)) {
    const start = match.index ?? -1
    if (start < 0) continue
    const year = match[0].toLocaleLowerCase()
    const prefix = foldedCitationText(
      sourceValue.slice(Math.max(0, start - 96), start),
    )
    const yearLabels = labelsByYear.get(year) ?? []
    if (totals.citationWork + yearLabels.length > MAX_CITATION_MATCH_WORK)
      throw new RenderedPublicationPlanError(
        'BUDGET',
        path,
        'citation matching work exceeds the publication planning budget',
      )
    totals.citationWork += yearLabels.length
    const candidates = yearLabels.flatMap(({ index, surname }) => {
      const position = prefix.lastIndexOf(surname)
      return position >= 0 && !linkedTargets.has(targets[index]!.id)
        ? [{ target: targets[index]!.id, position }]
        : []
    })
    const nearest = Math.max(...candidates.map(({ position }) => position))
    const selected = candidates.filter(({ position }) => position === nearest)
    if (selected.length !== 1) continue
    ranges.push({
      start,
      end: start + match[0].length,
      target: selected[0]!.target,
    })
    linkedTargets.add(selected[0]!.target)
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  return ranges.some(
    (range, index) => index > 0 && range.start < ranges[index - 1]!.end,
  )
    ? null
    : ranges
}

export function groupedCitationLinks(
  value: string,
  ranges: readonly { start: number; end: number; target: string }[] | null,
  targetById: ReadonlyMap<string, StructTarget>,
  epubRole: string,
  sourceOffset = 0,
) {
  if (!ranges) return { html: text(value), linkedTargets: new Set<string>() }
  const linkedTargets = new Set(ranges.map((range) => range.target))
  const segmentEnd = sourceOffset + value.length
  const segmentRanges = ranges.flatMap((range) => {
    const start = Math.max(range.start, sourceOffset)
    const end = Math.min(range.end, segmentEnd)
    return start < end
      ? [
          {
            start: start - sourceOffset,
            end: end - sourceOffset,
            target: range.target,
          },
        ]
      : []
  })
  let cursor = 0
  let html = ''
  for (const range of segmentRanges) {
    html += text(value.slice(cursor, range.start))
    const target = targetById.get(range.target)
    if (!target) return { html: text(value), linkedTargets: new Set<string>() }
    html += `<a href="${attribute(target.href)}"${epubRole}>${text(value.slice(range.start, range.end))}</a>`
    cursor = range.end
  }
  html += text(value.slice(cursor))
  return { html, linkedTargets }
}

function validInline(run: StructInline, text: string) {
  return (
    Number.isInteger(run.start) &&
    Number.isInteger(run.end) &&
    run.start >= 0 &&
    run.end > run.start &&
    run.end <= text.length
  )
}

type RenderedInlineSource = {
  key: string
  value: string
  runs: readonly StructInline[]
  pathPrefix: string
}

export type RenderedInlineSegment = {
  start: number
  end: number
  owners: readonly StructInline[]
  ownerPaths: readonly string[]
  ownerKeys: readonly string[]
}

export type RenderedInlineSourcePlan = RenderedInlineSource & {
  segments: readonly RenderedInlineSegment[]
}

type CitationRange = { start: number; end: number; target: string }

export type RenderedSemanticPlan = {
  semanticRole: NonNullable<StructInline['semanticRole']>
  relationshipId: string
  relationshipIdStable: string
  targets: readonly StructTarget[]
  targetById: ReadonlyMap<string, StructTarget>
  labels: readonly string[]
  semanticAttributes: string
  epubRole: string
  additionalTargets: string
  citationRanges: readonly CitationRange[] | null
  estimatedBytesPerSegment: number
}

export type RenderedHyperlinkPlan = {
  href: string
  estimatedBytesPerSegment: number
}

type DraftRun = {
  run: StructInline
  originalIndex: number
  path: string
  key: string
}

type PlanningTotals = {
  segmentCount: number
  activeOwnerVisits: number
  wrapperBytes: number
  eventStorage: number
  citationWork: number
}

export type RenderedPublicationPlan = {
  sources: readonly RenderedInlineSourcePlan[]
  sourceByKey: ReadonlyMap<string, RenderedInlineSourcePlan>
  relationships: ReadonlyMap<string, StructDocument['relationships'][number]>
  renderedRelationshipIds: ReadonlySet<string>
  backlinksByTarget: ReadonlyMap<
    string,
    readonly StructDocument['relationships'][number][]
  >
  authorNotesByAuthor: ReadonlyMap<
    string,
    readonly NonNullable<StructDocument['metadata']['authorNotes']>[number][]
  >
  semanticByOwnerKey: ReadonlyMap<string, RenderedSemanticPlan>
  hyperlinkByOwnerKey: ReadonlyMap<string, RenderedHyperlinkPlan>
}

export class RenderedPublicationPlanError extends Error {
  constructor(
    readonly code: 'BUDGET' | 'DUPLICATE_IDENTIFIER',
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'RenderedPublicationPlanError'
  }
}

/** Return exactly the inline sources that the publication renderer consumes. */
function* renderedInlineSources(
  document: StructDocument,
): Generator<RenderedInlineSource> {
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.kind === 'furniture') continue
    if (block.kind === 'table' && block.table) {
      for (const [cellIndex, cell] of block.table.cells.entries())
        yield {
          key: `table:${blockIndex}:${cellIndex}`,
          value: cell.text,
          runs: cell.inline,
          pathPrefix: `$.blocks[${blockIndex}].table.cells[${cellIndex}].inline`,
        }
      continue
    }
    yield {
      key: `block:${blockIndex}`,
      value: block.text,
      runs: block.inline,
      pathPrefix: `$.blocks[${blockIndex}].inline`,
    }
  }
}

type InlineEvent = { position: number; runIndex: number; end: boolean }

type InlineDraft = {
  source: RenderedInlineSource
  runs: DraftRun[]
  events: InlineEvent[]
  positions: number[]
  segmentCount: number
  activeOwnerVisits: number
  wrapperBytes: number
  semanticByOwnerKey: Map<string, RenderedSemanticPlan>
  hyperlinkByOwnerKey: Map<string, RenderedHyperlinkPlan>
  renderedRelationshipIds: Set<string>
}

function semanticPlanForRun(
  document: StructDocument,
  source: RenderedInlineSource,
  run: StructInline,
  path: string,
  relationships: ReadonlyMap<string, StructDocument['relationships'][number]>,
  targetCache: WeakMap<readonly string[], StructTarget[]>,
  getTargetIndex: () => PlanningTargetIndex,
  totals: PlanningTotals,
  remainingSegments: number,
): RenderedSemanticPlan | undefined {
  if (!run.semanticRole || !run.relationshipId) return undefined
  const relationship = relationships.get(run.relationshipId)
  const rawTargets =
    relationship?.status === 'matched' ? relationship.to : (run.targetIds ?? [])
  const labels = (relationship?.label ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
  let targets = targetCache.get(rawTargets)
  if (!targets) {
    targets = []
    let targetEstimate = 0
    for (
      let targetIndex = 0;
      targetIndex < rawTargets.length;
      targetIndex += 1
    ) {
      const rawTarget = rawTargets[targetIndex]!
      const target = resolvePlanningTargetLazily(getTargetIndex, rawTarget)
      targets.push(target)
      targetEstimate +=
        `<a href="${attribute(target.href)}"${run.semanticRole === 'note-reference' ? ' epub:type="noteref" role="doc-noteref"' : run.semanticRole === 'citation' ? ' epub:type="biblioref" role="doc-biblioref"' : ''}>${text(labels[targetIndex] ?? String(targetIndex + 1))}</a>`
          .length
      if (
        totals.wrapperBytes + targetEstimate * Math.max(1, remainingSegments) >
        MAX_RENDERED_INLINE_WRAPPER_BYTES
      )
        throw new RenderedPublicationPlanError(
          'BUDGET',
          path,
          'semantic target expansion exceeds the publication planning budget',
        )
    }
    targetCache.set(rawTargets, targets)
  }
  const relationshipIdStable = stableId(run.relationshipId)
  const epubRole =
    run.semanticRole === 'note-reference'
      ? ' epub:type="noteref" role="doc-noteref"'
      : run.semanticRole === 'citation'
        ? ' epub:type="biblioref" role="doc-biblioref"'
        : ''
  const targetIds = targets.map((target) => target.id).join(' ')
  const targetById = new Map(
    targets.map((target) => [target.id, target] as const),
  )
  const semanticAttributes = ` data-semantic-role="${attribute(run.semanticRole)}" data-relationship-id="${attribute(relationshipIdStable)}"${targets.length > 0 ? ` data-target-ids="${attribute(targetIds)}"` : ''}`
  const ranges =
    run.semanticRole === 'citation'
      ? citationRanges(
          source.value.slice(run.start!, run.end!),
          labels,
          targets,
          path,
          totals,
        )
      : null
  const visibleTargets = new Set((ranges ?? []).map((range) => range.target))
  const additionalTargets =
    targets.length > 1
      ? targets
          .map((target, targetIndex) => ({ target, targetIndex }))
          .filter(({ target }) => !visibleTargets.has(target.id))
          .map(
            ({ target, targetIndex }) =>
              `<a href="${attribute(target!.href)}"${epubRole} class="additional-semantic-reference">Additional ${text(run.semanticRole!)} target ${text(labels[targetIndex] ?? String(targetIndex + 1))}</a>`,
          )
          .join('')
      : ''
  const targetMarkupBytes = targets.reduce(
    (total, target, targetIndex) =>
      total +
      `<a href="${attribute(target.href)}"${epubRole}>${text(labels[targetIndex] ?? String(targetIndex + 1))}</a>`
        .length,
    0,
  )
  const openingBytes =
    targets.length === 0
      ? `<span${semanticAttributes}>`.length + '</span>'.length
      : targets.length === 1
        ? `<a href="${attribute(targets[0]!.href)}"${epubRole}${semanticAttributes}>`
            .length + '</a>'.length
        : `<span${semanticAttributes}>`.length + '</span>'.length
  return {
    semanticRole: run.semanticRole,
    relationshipId: run.relationshipId,
    relationshipIdStable,
    targets,
    targetById,
    labels,
    semanticAttributes,
    epubRole,
    additionalTargets,
    citationRanges: ranges,
    estimatedBytesPerSegment:
      openingBytes +
      targetMarkupBytes +
      (ranges?.length ?? 0) * ESTIMATED_CITATION_RANGE_VISIT_BYTES,
  }
}

function hyperlinkPlanForRun(
  document: StructDocument,
  run: StructInline,
  getTargetIndex: () => PlanningTargetIndex,
): RenderedHyperlinkPlan | undefined {
  if (!run.href && !run.targetIds?.length) return undefined
  const internalTarget = run.targetIds?.[0]
  const rawHref = run.href
  const href = rawHref?.startsWith('#')
    ? internalTarget || getTargetIndex().has(rawHref.slice(1))
      ? resolvePlanningTarget(getTargetIndex(), internalTarget ?? rawHref).href
      : rawHref
    : rawHref
      ? /^(?:https?|mailto):/iu.test(rawHref)
        ? resolvePlanningTargetLazily(getTargetIndex, rawHref).href
        : rawHref
      : internalTarget
        ? (() => {
            return resolvePlanningTarget(getTargetIndex(), internalTarget).href
          })()
        : undefined
  if (!href) return undefined
  return {
    href,
    estimatedBytesPerSegment: `<a href="${attribute(href)}"></a>`.length,
  }
}

function draftInlinePlan(
  document: StructDocument,
  source: RenderedInlineSource,
  relationships: ReadonlyMap<string, StructDocument['relationships'][number]>,
  targetCache: WeakMap<readonly string[], StructTarget[]>,
  getTargetIndex: () => PlanningTargetIndex,
  seenSemanticIds: Set<string>,
  totals: PlanningTotals,
): InlineDraft {
  if (source.runs.length * 2 > MAX_RENDERED_INLINE_EVENT_STORAGE)
    throw new RenderedPublicationPlanError(
      'BUDGET',
      `${source.pathPrefix}[0]`,
      'inline event storage exceeds the publication planning budget',
    )
  const runs: DraftRun[] = []
  for (const [originalIndex, run] of source.runs.entries()) {
    if (!validInline(run, source.value)) continue
    const path = `${source.pathPrefix}[${originalIndex}]`
    runs.push({
      run,
      originalIndex,
      path,
      key: `${source.key}:${originalIndex}`,
    })
  }
  runs.sort(
    (left, right) =>
      left.run.start - right.run.start || right.run.end - left.run.end,
  )
  const boundaries = new Set<number>([0, source.value.length])
  const events: InlineEvent[] = []
  runs.forEach(({ run }, runIndex) => {
    boundaries.add(run.start)
    boundaries.add(run.end)
    events.push(
      { position: run.start, runIndex, end: false },
      { position: run.end, runIndex, end: true },
    )
  })
  events.sort((left, right) => left.position - right.position)
  totals.eventStorage += events.length
  if (totals.eventStorage > MAX_RENDERED_INLINE_EVENT_STORAGE)
    throw new RenderedPublicationPlanError(
      'BUDGET',
      `${source.pathPrefix}[0]`,
      'inline event storage exceeds the publication planning budget',
    )
  const positions = [...boundaries].sort((left, right) => left - right)
  const active = new Set<number>()
  let eventIndex = 0
  let segmentCount = 0
  let activeOwnerVisits = 0
  let wrapperBytes = 0
  const semanticByOwnerKey = new Map<string, RenderedSemanticPlan>()
  const hyperlinkByOwnerKey = new Map<string, RenderedHyperlinkPlan>()
  const renderedRelationshipIds = new Set<string>()
  const selectedOwners: Array<{
    semanticIndex: number
    hyperlinkIndex: number
  }> = []
  const semanticSegmentCounts = new Map<number, number>()
  for (
    let positionIndex = 0;
    positionIndex < positions.length - 1;
    positionIndex += 1
  ) {
    const position = positions[positionIndex]!
    while (events[eventIndex]?.position === position) {
      const event = events[eventIndex++]!
      if (event.end) active.delete(event.runIndex)
      else active.add(event.runIndex)
    }
    const next = positions[positionIndex + 1]!
    if (next <= position) continue
    segmentCount += 1
    activeOwnerVisits += active.size
    wrapperBytes += active.size * ESTIMATED_WRAPPER_BYTES_PER_OWNER
    totals.segmentCount += 1
    totals.activeOwnerVisits += active.size
    totals.wrapperBytes += active.size * ESTIMATED_WRAPPER_BYTES_PER_OWNER
    if (
      totals.segmentCount > MAX_RENDERED_INLINE_SEGMENTS ||
      totals.activeOwnerVisits > MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS ||
      totals.wrapperBytes > MAX_RENDERED_INLINE_WRAPPER_BYTES
    )
      throw new RenderedPublicationPlanError(
        'BUDGET',
        `${source.pathPrefix}[0]`,
        'inline ownership work exceeds publication budgets',
      )
    let semanticIndex = -1
    for (const runIndex of active) {
      const candidate = runs[runIndex]!
      if (candidate.run.semanticRole && candidate.run.relationshipId) {
        semanticIndex = runIndex
        break
      }
    }
    let hyperlinkIndex = -1
    if (semanticIndex < 0)
      for (const runIndex of active) {
        const hyperlinkRun = runs[runIndex]!
        if (hyperlinkRun.run.href || hyperlinkRun.run.targetIds?.length) {
          hyperlinkIndex = runIndex
          break
        }
      }
    selectedOwners.push({ semanticIndex, hyperlinkIndex })
    if (semanticIndex >= 0)
      semanticSegmentCounts.set(
        semanticIndex,
        (semanticSegmentCounts.get(semanticIndex) ?? 0) + 1,
      )
  }
  for (const { semanticIndex, hyperlinkIndex } of selectedOwners) {
    if (semanticIndex >= 0) {
      const semanticRun = runs[semanticIndex]!
      let semantic = semanticByOwnerKey.get(semanticRun.key)
      if (!semantic) {
        semantic = semanticPlanForRun(
          document,
          source,
          semanticRun.run,
          semanticRun.path,
          relationships,
          targetCache,
          getTargetIndex,
          totals,
          semanticSegmentCounts.get(semanticIndex)!,
        )
        if (!semantic) continue
        semanticByOwnerKey.set(semanticRun.key, semantic)
      }
      wrapperBytes += semantic.estimatedBytesPerSegment
      totals.wrapperBytes += semantic.estimatedBytesPerSegment
      if (!seenSemanticIds.has(semantic.relationshipIdStable)) {
        wrapperBytes += semantic.additionalTargets.length
        totals.wrapperBytes += semantic.additionalTargets.length
        seenSemanticIds.add(semantic.relationshipIdStable)
      }
      renderedRelationshipIds.add(semantic.relationshipId)
    } else if (hyperlinkIndex >= 0) {
      const hyperlinkRun = runs[hyperlinkIndex]!
      let hyperlink = hyperlinkByOwnerKey.get(hyperlinkRun.key)
      if (!hyperlink) {
        hyperlink = hyperlinkPlanForRun(
          document,
          hyperlinkRun.run,
          getTargetIndex,
        )
        if (!hyperlink) continue
        hyperlinkByOwnerKey.set(hyperlinkRun.key, hyperlink)
      }
      wrapperBytes += hyperlink.estimatedBytesPerSegment
      totals.wrapperBytes += hyperlink.estimatedBytesPerSegment
    }
    if (totals.wrapperBytes > MAX_RENDERED_INLINE_WRAPPER_BYTES)
      throw new RenderedPublicationPlanError(
        'BUDGET',
        `${source.pathPrefix}[0]`,
        'inline ownership work exceeds publication budgets',
      )
  }
  return {
    source,
    runs,
    events,
    positions,
    segmentCount,
    activeOwnerVisits,
    wrapperBytes,
    semanticByOwnerKey,
    hyperlinkByOwnerKey,
    renderedRelationshipIds,
  }
}

/** Build the owner plan shared by XHTML rendering, emitted IDs, and backlinks. */
export function renderedInlinePlan(
  value: string,
  runs: readonly StructInline[],
): RenderedInlineSegment[] {
  const relationships = new Map<
    string,
    StructDocument['relationships'][number]
  >()
  const draft = draftInlinePlan(
    {} as StructDocument,
    { key: 'direct', value, runs, pathPrefix: '$.blocks.inline' },
    relationships,
    new WeakMap(),
    () => new Map(),
    new Set(),
    {
      segmentCount: 0,
      activeOwnerVisits: 0,
      wrapperBytes: 0,
      eventStorage: 0,
      citationWork: 0,
    },
  )
  if (
    draft.segmentCount > MAX_RENDERED_INLINE_SEGMENTS ||
    draft.activeOwnerVisits > MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS ||
    draft.wrapperBytes > MAX_RENDERED_INLINE_WRAPPER_BYTES
  )
    throw new RenderedPublicationPlanError(
      'BUDGET',
      '$.blocks.inline',
      'inline ownership work exceeds the publication planning budget',
    )
  return materializeInlinePlan(draft)
}

function materializeInlinePlan(draft: InlineDraft): RenderedInlineSegment[] {
  const active = new Set<number>()
  let eventIndex = 0
  const segments: RenderedInlineSegment[] = []
  for (
    let positionIndex = 0;
    positionIndex < draft.positions.length - 1;
    positionIndex += 1
  ) {
    const position = draft.positions[positionIndex]!
    while (draft.events[eventIndex]?.position === position) {
      const event = draft.events[eventIndex++]!
      if (event.end) active.delete(event.runIndex)
      else active.add(event.runIndex)
    }
    const end = draft.positions[positionIndex + 1]!
    if (end <= position) continue
    const ownerIndexes = [...active].sort((left, right) => left - right)
    segments.push({
      start: position,
      end,
      owners: ownerIndexes.map((index) => draft.runs[index]!.run),
      ownerPaths: ownerIndexes.map((index) => draft.runs[index]!.path),
      ownerKeys: ownerIndexes.map((index) => draft.runs[index]!.key),
    })
  }
  return segments
}

/** Build one document-local publication plan before any rendered owner arrays. */
export function buildRenderedPublicationPlan(
  document: StructDocument,
): RenderedPublicationPlan {
  const authors = document.metadata.authors
  const authorNotes = document.metadata.authorNotes ?? []
  const seenAuthors = new Set<string>()
  for (const [index, author] of authors.entries()) {
    if (seenAuthors.has(author))
      throw new RenderedPublicationPlanError(
        'DUPLICATE_IDENTIFIER',
        `$.metadata.authors[${index}]`,
        `duplicate metadata author ${author} is ambiguous without a stable identity`,
      )
    seenAuthors.add(author)
  }
  const relationships = new Map(
    document.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const seenSemanticIds = new Set(
    (authorNotes ?? [])
      .filter((note) => {
        const relationship = relationships.get(note.id)
        return (
          relationship?.status === 'matched' &&
          (relationship.kind === 'footnote' ||
            relationship.kind === 'endnote') &&
          relationship.to.includes(note.target)
        )
      })
      .map((note) => stableId(note.id)),
  )
  const targetCache = new WeakMap<readonly string[], StructTarget[]>()
  let targetIndex: PlanningTargetIndex | undefined
  const getTargetIndex = () =>
    (targetIndex ??= buildPlanningTargetIndex(document))
  const drafts: InlineDraft[] = []
  const totals: PlanningTotals = {
    segmentCount: 0,
    activeOwnerVisits: 0,
    wrapperBytes: 0,
    eventStorage: 0,
    citationWork: 0,
  }
  const renderedRelationshipIds = new Set<string>()
  for (const note of authorNotes)
    if (seenSemanticIds.has(stableId(note.id)))
      renderedRelationshipIds.add(note.id)
  for (const source of renderedInlineSources(document)) {
    const draft = draftInlinePlan(
      document,
      source,
      relationships,
      targetCache,
      getTargetIndex,
      seenSemanticIds,
      totals,
    )
    for (const relationshipId of draft.renderedRelationshipIds)
      renderedRelationshipIds.add(relationshipId)
    drafts.push(draft)
  }
  const sources = drafts.map((draft) => ({
    ...draft.source,
    segments: materializeInlinePlan(draft),
  }))
  const sourceByKey = new Map(sources.map((source) => [source.key, source]))
  const semanticByOwnerKey = new Map<string, RenderedSemanticPlan>()
  const hyperlinkByOwnerKey = new Map<string, RenderedHyperlinkPlan>()
  for (const draft of drafts)
    for (const [key, semantic] of draft.semanticByOwnerKey)
      semanticByOwnerKey.set(key, semantic)
  for (const draft of drafts)
    for (const [key, hyperlink] of draft.hyperlinkByOwnerKey)
      hyperlinkByOwnerKey.set(key, hyperlink)
  const backlinksByTarget = new Map<
    string,
    StructDocument['relationships'][number][]
  >()
  for (const relationship of document.relationships) {
    if (
      relationship.status !== 'matched' ||
      !renderedRelationshipIds.has(relationship.id) ||
      (relationship.kind !== 'footnote' && relationship.kind !== 'endnote')
    )
      continue
    for (const target of relationship.to) {
      const backlinks = backlinksByTarget.get(target) ?? []
      backlinks.push(relationship)
      backlinksByTarget.set(target, backlinks)
    }
  }
  const authorNotesByAuthor = new Map<string, typeof authorNotes>()
  for (const note of authorNotes) {
    const notes = authorNotesByAuthor.get(note.author) ?? []
    notes.push(note)
    authorNotesByAuthor.set(note.author, notes)
  }
  return {
    sources,
    sourceByKey,
    relationships,
    renderedRelationshipIds,
    backlinksByTarget,
    authorNotesByAuthor,
    semanticByOwnerKey,
    hyperlinkByOwnerKey,
  }
}

/** Return relationship IDs that have an owner in the actual rendered plan. */
export function renderedInlineRelationshipIds(document: StructDocument) {
  return buildRenderedPublicationPlan(document).renderedRelationshipIds
}

/**
 * Describe every id that the publication XHTML renderer can emit. Relationship
 * ids are document-scoped: one relationship occurrence receives the id and
 * later occurrences reuse its data without emitting another id attribute.
 */
export function emittedXhtmlIds(
  document: StructDocument,
  publicationPlan = buildRenderedPublicationPlan(document),
): EmittedXhtmlId[] {
  const entries: EmittedXhtmlId[] = []
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.kind === 'furniture') continue
    entries.push({ id: block.id, path: `$.blocks[${blockIndex}].id` })
    for (const [anchorIndex, anchor] of (
      block.sourceObservationAnchorIds ?? []
    ).entries()) {
      entries.push({
        id: anchor,
        path: `$.blocks[${blockIndex}].sourceObservationAnchorIds[${anchorIndex}]`,
      })
    }
    if (block.kind === 'table' && block.table) {
      for (const [cellIndex, cell] of block.table.cells.entries()) {
        entries.push({
          id: `${block.id}-${cell.id}`,
          path: `$.blocks[${blockIndex}].table.cells[${cellIndex}].id`,
        })
      }
    }
  }
  const relationshipIds = new Set<string>()
  const authorNoteAliasIds = new Set(
    (document.metadata.authorNotes ?? [])
      .filter((note) => {
        const relationship = publicationPlan.relationships.get(note.id)
        return (
          relationship?.status === 'matched' &&
          (relationship.kind === 'footnote' ||
            relationship.kind === 'endnote') &&
          relationship.to.includes(note.target)
        )
      })
      .map((note) => note.id),
  )
  for (const [index, note] of (document.metadata.authorNotes ?? []).entries())
    entries.push({
      id: stableId(note.id),
      path: `$.metadata.authorNotes[${index}].id`,
    })
  for (const source of publicationPlan.sources) {
    for (const segment of source.segments) {
      const ownerIndex = segment.owners.findIndex(
        (owner) => owner.relationshipId && owner.semanticRole,
      )
      const run = ownerIndex >= 0 ? segment.owners[ownerIndex] : undefined
      if (
        !run?.relationshipId ||
        relationshipIds.has(run.relationshipId) ||
        authorNoteAliasIds.has(run.relationshipId)
      )
        continue
      relationshipIds.add(run.relationshipId)
      entries.push({
        id: stableId(run.relationshipId),
        path: `${segment.ownerPaths[ownerIndex]}.relationshipId`,
      })
    }
  }
  return entries
}
