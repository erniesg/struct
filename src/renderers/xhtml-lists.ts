import type { StructBlock } from '../document/types'

/**
 * Maximum rendered list nesting depth.
 *
 * A list item may declare any depth, so the rendered depth is bounded: an
 * item that would open a container deeper than this limit joins the
 * enclosing list instead. The bound keeps the published XHTML finite and
 * keeps the renderer from recursing without limit.
 */
export const MAX_RENDERED_LIST_NESTING_DEPTH = 16

/**
 * A list item's declared position in its list.
 *
 * `level` is the nesting depth (0 is the outermost list), `ordered` selects
 * the container element, `ordinal` is the item's number inside an ordered
 * list, and `listId` is an optional explicit list identity.
 */
export type RenderedListItem = {
  block: StructBlock
  blockIndex: number
  level: number
  ordered: boolean
  ordinal: number | null
  listId: string | null
  /** True when the item declares nesting metadata of its own. */
  nested: boolean
}

export type RenderedListItemEntry = {
  item: RenderedListItem
  children: RenderedListContainer[]
}

export type RenderedListContainer = {
  tag: 'ol' | 'ul'
  ordered: boolean
  /** The ordered list's start value, when the graph declares one. */
  start: number | null
  items: RenderedListItemEntry[]
}

function integerAttribute(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

/**
 * The nesting depth declared by a list item.
 *
 * `listLevel` is the additive compatibility attribute: a non-negative
 * integer is the item's depth, and anything else (absent, fractional,
 * negative, or not a number) is the outermost level.
 */
export function listItemLevel(attributes: Record<string, unknown> | undefined) {
  const level = integerAttribute(attributes?.listLevel)
  return level !== null && level >= 0 ? level : 0
}

/**
 * Whether a list item belongs to an ordered list.
 *
 * `listOrdered` is the additive compatibility attribute; the older `ordered`
 * attribute keeps working. A document that declares both is contradictory,
 * and `listOrdered` is the explicit list-metadata spelling, so it wins.
 */
export function listItemOrdered(
  attributes: Record<string, unknown> | undefined,
) {
  if (typeof attributes?.listOrdered === 'boolean')
    return attributes.listOrdered
  return attributes?.ordered === true
}

/** The item's number inside an ordered list, when the graph declares one. */
export function listItemOrdinal(
  attributes: Record<string, unknown> | undefined,
): number | null {
  const ordinal = integerAttribute(attributes?.listOrdinal)
  return ordinal !== null && ordinal >= 0 ? ordinal : null
}

/** The explicit list identity, when the graph declares one. */
export function listItemListId(
  attributes: Record<string, unknown> | undefined,
): string | null {
  return typeof attributes?.listId === 'string' ? attributes.listId : null
}

/** True when the item declares the nesting metadata of a nested list. */
export function listItemDeclaresNesting(
  attributes: Record<string, unknown> | undefined,
) {
  return (
    integerAttribute(attributes?.listLevel) !== null ||
    typeof attributes?.listOrdered === 'boolean'
  )
}

export function planListItem(
  block: StructBlock,
  blockIndex: number,
): RenderedListItem {
  const attributes = block.attributes as
    | Record<string, unknown>
    | undefined
  return {
    block,
    blockIndex,
    level: listItemLevel(attributes),
    ordered: listItemOrdered(attributes),
    ordinal: listItemOrdinal(attributes),
    listId: listItemListId(attributes),
    nested: listItemDeclaresNesting(attributes),
  }
}

function createContainer(
  ordered: boolean,
  ordinal: number | null,
): RenderedListContainer {
  return {
    tag: ordered ? 'ol' : 'ul',
    ordered,
    start: ordered && ordinal !== null && ordinal !== 1 ? ordinal : null,
    items: [],
  }
}

type Frame = {
  level: number
  listId: string | null
  ordered: boolean
  container: RenderedListContainer
  /** The list of sibling containers this container belongs to. */
  siblings: RenderedListContainer[]
  /** The item that would receive a nested container. */
  lastItem: RenderedListItemEntry | null
  depth: number
}

/**
 * Group the items that declare nesting metadata into nested lists.
 *
 * The grouping is a stack over the declared levels: an item at the level of
 * the open list joins it, an item one level deeper opens a list inside the
 * previous item, and an item at a shallower level closes the deeper lists.
 * The declared level is a grouping key, not the rendered depth, so a level
 * that jumps by more than one still opens exactly one nested list, and the
 * items that declare the same level stay together. A sibling whose ordering
 * differs from the open list starts a new sibling list instead of mixing
 * `<ol>` and `<ul>` items in one container.
 */
function buildNestedContainers(
  items: readonly RenderedListItem[],
): RenderedListContainer[] {
  const roots: RenderedListContainer[] = []
  const stack: Frame[] = []
  for (const item of items) {
    const level = item.level
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      if (top.listId !== item.listId || top.level > level) {
        stack.pop()
        continue
      }
      break
    }
    const top = stack[stack.length - 1]
    if (top && top.level === level && top.listId === item.listId) {
      if (top.ordered === item.ordered) {
        const entry: RenderedListItemEntry = { item, children: [] }
        top.container.items.push(entry)
        top.lastItem = entry
        continue
      }
      // The sibling changes ordering: the open list ends and a sibling list
      // with the other ordering starts at the same level.
      stack.pop()
      const container = createContainer(item.ordered, item.ordinal)
      top.siblings.push(container)
      const frame: Frame = {
        level,
        listId: item.listId,
        ordered: item.ordered,
        container,
        siblings: top.siblings,
        lastItem: null,
        depth: top.depth,
      }
      stack.push(frame)
      const entry: RenderedListItemEntry = { item, children: [] }
      container.items.push(entry)
      frame.lastItem = entry
      continue
    }
    const depth = top ? top.depth + 1 : 0
    if (top && depth > MAX_RENDERED_LIST_NESTING_DEPTH) {
      // The declared depth is beyond the rendered bound: the item joins the
      // enclosing list instead of opening another container.
      const entry: RenderedListItemEntry = { item, children: [] }
      top.container.items.push(entry)
      top.lastItem = entry
      continue
    }
    const container = createContainer(item.ordered, item.ordinal)
    let siblings: RenderedListContainer[]
    if (top && top.lastItem) {
      top.lastItem.children.push(container)
      siblings = top.lastItem.children
    } else {
      roots.push(container)
      siblings = roots
    }
    const frame: Frame = {
      level,
      listId: item.listId,
      ordered: item.ordered,
      container,
      siblings,
      lastItem: null,
      depth,
    }
    stack.push(frame)
    const entry: RenderedListItemEntry = { item, children: [] }
    container.items.push(entry)
    frame.lastItem = entry
  }
  return roots
}

/**
 * Group the items that do not declare nesting metadata into flat lists.
 *
 * This is the original list contract: consecutive items that share a list
 * identity form one list, and the first item of the list decides whether
 * the list is ordered. A document that declares no nesting metadata renders
 * exactly as it did before nested lists existed.
 */
function buildFlatContainers(
  items: readonly RenderedListItem[],
): RenderedListContainer[] {
  const containers: RenderedListContainer[] = []
  let current: RenderedListContainer | null = null
  let currentListId: string | null | undefined
  for (const item of items) {
    if (!current || currentListId !== item.listId) {
      current = createContainer(item.ordered, null)
      containers.push(current)
      currentListId = item.listId
    }
    current.items.push({ item, children: [] })
  }
  return containers
}

/**
 * Plan the lists of one contiguous run of list items.
 *
 * Items that declare nesting metadata and items that do not are grouped
 * separately, because the two contracts are different: the flat contract
 * groups by list identity, and the nested contract groups by declared
 * level. A run that mixes them publishes one list per group.
 */
export function planListContainers(
  items: readonly RenderedListItem[],
): RenderedListContainer[] {
  const containers: RenderedListContainer[] = []
  let segment: RenderedListItem[] = []
  let segmentNested: boolean | null = null
  const flush = () => {
    if (segment.length === 0) return
    containers.push(
      ...(segmentNested
        ? buildNestedContainers(segment)
        : buildFlatContainers(segment)),
    )
    segment = []
  }
  for (const item of items) {
    if (segmentNested !== null && item.nested !== segmentNested) flush()
    segmentNested = item.nested
    segment.push(item)
  }
  flush()
  return containers
}

/**
 * Render one list container.
 *
 * The container's items are indented by `indent`, and the closing tag sits
 * at the same indent, which is the shape the renderer has always published
 * for a flat list.
 */
export function renderListContainer(
  container: RenderedListContainer,
  renderItem: (entry: RenderedListItemEntry, indent: string) => string,
  indent: string,
): string {
  const start =
    container.start !== null ? ` start="${container.start}"` : ''
  const items = container.items
    .map((entry) => `\n${indent}${renderItem(entry, indent)}`)
    .join('')
  return `<${container.tag}${start}>${items}\n${indent}</${container.tag}>`
}
