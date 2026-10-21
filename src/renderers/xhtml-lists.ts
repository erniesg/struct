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
 * integer is the item's depth. Every other value (absent, fractional,
 * negative, or not a number) resolves to the outermost level, 0.
 *
 * The resolved depth and the contract the item is published by are two
 * different questions, and `listItemDeclaresNesting` decides the contract.
 * Only an integer `listLevel` (or a boolean `listOrdered`) declares the
 * nested contract, so a fractional or non-numeric `listLevel` is not nesting
 * metadata at all and the item is published by the flat contract, while a
 * negative integer `listLevel` is nesting metadata whose depth resolves to
 * the outermost level.
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

/**
 * True when the item declares the nesting metadata of a nested list.
 *
 * Only an integer `listLevel` or a boolean `listOrdered` declares the
 * nested contract. A fractional or non-numeric `listLevel` is not nesting
 * metadata: the item is published by the flat contract. A negative integer
 * `listLevel` is nesting metadata, and its depth resolves to the outermost
 * level.
 */
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
 *
 * A change of the list identity is a hard boundary: the open list ends, and
 * the next list never joins the open list's container and never shares its
 * items. The list after the boundary keeps its own declared nesting. It is
 * rooted at its own declared level, measured from the base level of the run
 * (the declared level of the run's first item), and it opens inside the item
 * published at the parent depth, so the boundary never flattens the
 * following list's declared nesting to the root level.
 */
function buildNestedContainers(
  items: readonly RenderedListItem[],
): RenderedListContainer[] {
  const roots: RenderedListContainer[] = []
  const stack: Frame[] = []
  // The base level of the run: the declared level of its first item. Every
  // other item's depth is measured from it.
  const baseLevel = items.length > 0 ? items[0]!.level : 0
  // The last item published at each rendered depth. The list after a list
  // identity boundary opens inside the item at the parent depth, so the
  // boundary keeps the declared nesting of the following list.
  const lastItemAtDepth: Array<RenderedListItemEntry | undefined> = []
  for (const item of items) {
    const level = item.level
    let boundary = false
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      if (top.listId !== item.listId) {
        // The list identity changed: the open list ends here.
        stack.pop()
        boundary = true
        continue
      }
      if (top.level > level) {
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
        lastItemAtDepth[top.depth] = entry
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
      lastItemAtDepth[frame.depth] = entry
      continue
    }
    let depth: number
    let parent: RenderedListItemEntry | undefined
    if (top) {
      depth = top.depth + 1
      parent = top.lastItem ?? undefined
    } else if (boundary) {
      // The list after a list identity boundary is rooted at its own
      // declared level, measured from the base level of the run, and opens
      // inside the item published at the parent depth.
      const target = Math.min(
        Math.max(0, level - baseLevel),
        MAX_RENDERED_LIST_NESTING_DEPTH,
      )
      let parentDepth = target - 1
      while (parentDepth >= 0 && lastItemAtDepth[parentDepth] === undefined)
        parentDepth -= 1
      depth = parentDepth < 0 ? 0 : parentDepth + 1
      parent = parentDepth < 0 ? undefined : lastItemAtDepth[parentDepth]
    } else {
      depth = 0
      parent = undefined
    }
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
    if (parent) {
      parent.children.push(container)
      siblings = parent.children
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
    lastItemAtDepth[depth] = entry
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
 * A contiguous run of list items is one list. The run is a flat list when no
 * item in it declares the nested contract: consecutive items that share a
 * list identity form one list, and the first item of the list decides
 * whether the list is ordered. This is the original list contract, and a
 * document that declares no nesting metadata renders exactly as it did
 * before nested lists existed.
 *
 * The run is a nested list when any item in it declares the nested
 * contract. The items are then grouped by their declared level, and the
 * items that do not declare nesting are the outermost items of that same
 * list. A run that mixes the two contracts therefore publishes one list,
 * not one list per contract.
 */
export function planListContainers(
  items: readonly RenderedListItem[],
): RenderedListContainer[] {
  if (items.length === 0) return []
  const nested = items.some((item) => item.nested)
  return nested ? buildNestedContainers(items) : buildFlatContainers(items)
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
