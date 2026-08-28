import type { StructBlock, StructPageLayout } from './document/types'

/**
 * Conservative geometry ordering for adapters that do not have an explicit
 * reading-order ledger. It never interleaves columns: each column is read
 * top-to-bottom, then the next column. Spanning blocks are emitted at their
 * vertical position between columns.
 */
export function orderBlocksByLayout(blocks: readonly StructBlock[]) {
  return [...blocks].sort((left, right) => {
    const leftPage = left.page ?? Number.MAX_SAFE_INTEGER
    const rightPage = right.page ?? Number.MAX_SAFE_INTEGER
    if (leftPage !== rightPage) return leftPage - rightPage
    const leftBox = left.evidence.boxes[0]
    const rightBox = right.evidence.boxes[0]
    if (!leftBox || !rightBox) return left.order - right.order
    if (left.column !== right.column) {
      const columnRank = { span: 0, single: 1, left: 2, right: 3 } as const
      const rankDelta =
        columnRank[left.column ?? 'single'] -
        columnRank[right.column ?? 'single']
      if (rankDelta !== 0) return rankDelta
    }
    return (
      leftBox.y - rightBox.y ||
      leftBox.x - rightBox.x ||
      left.order - right.order
    )
  })
}

export function pageLayoutsFromBlocks(
  pages: ReadonlyArray<
    Pick<StructPageLayout, 'page' | 'width' | 'height' | 'rotation'>
  >,
  blocks: readonly StructBlock[],
): StructPageLayout[] {
  const byPage = new Map<number, StructBlock[]>()
  for (const block of orderBlocksByLayout(blocks)) {
    if (block.page === null) continue
    const pageBlocks = byPage.get(block.page) ?? []
    pageBlocks.push(block)
    byPage.set(block.page, pageBlocks)
  }
  return pages.map((page) => {
    const pageBlocks = byPage.get(page.page) ?? []
    const columns = new Map<string, StructPageLayout['columns'][number]>()
    for (const block of pageBlocks) {
      const side = block.column ?? 'single'
      const column = columns.get(side) ?? {
        id: `page-${page.page}-${side}`,
        side,
        blockIds: [],
      }
      column.blockIds.push(block.id)
      columns.set(side, column)
    }
    return {
      ...page,
      blocks: pageBlocks.map((block) => block.id),
      columns: [...columns.values()],
    }
  })
}
