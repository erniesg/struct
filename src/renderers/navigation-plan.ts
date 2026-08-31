import type { StructBlock } from '../document/types'

export type PublicationNavigationItem = {
  id: string
  label: string
  level: number
  children: PublicationNavigationItem[]
}

function headingLevel(block: StructBlock) {
  return Number(block.attributes?.level ?? 2)
}

/**
 * Derive heading navigation directly from the canonical block-array sequence.
 * Layout evidence is intentionally not consulted and level gaps do not create
 * placeholder items.
 */
export function buildPublicationNavigationPlan(
  blocks: readonly StructBlock[],
): PublicationNavigationItem[] {
  const roots: PublicationNavigationItem[] = []
  const stack: PublicationNavigationItem[] = []

  for (const block of blocks) {
    if (block.kind !== 'heading') continue

    const item: PublicationNavigationItem = {
      id: block.id,
      label: block.text,
      level: headingLevel(block),
      children: [],
    }
    while (
      stack.length > 0 &&
      stack[stack.length - 1]!.level >= item.level
    )
      stack.pop()

    const parent = stack.at(-1)
    if (parent) parent.children.push(item)
    else roots.push(item)
    stack.push(item)
  }

  return roots
}
