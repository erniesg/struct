import { describe, expect, it } from 'vitest'
import { inspectXhtml } from './helpers/xml'
import {
  characterizeCodecRejection,
  characterizeRenderedCase,
} from './baseline-characterization'
import { getSyntheticBoundsProbe } from './fixture-builder'

describe('Stage 2.1 malformed-input baseline characterization', () => {
  it('accepts the sealed malformed-control case without rendering diagnostic copy', async () => {
    const publication = await characterizeRenderedCase('malformed-positive')

    expect(publication.normalized.diagnostics).toEqual(
      publication.decoded.diagnostics,
    )
    expect(publication.normalized.diagnostics).toHaveLength(1)
    expect(publication.xhtml).not.toContain(
      publication.decoded.diagnostics[0]!.message,
    )
  })

  it('rejects an unknown block field consistently at all four boundaries', async () => {
    await characterizeCodecRejection('malformed-negative', 'UNKNOWN_FIELD')
  })
})

describe('Stage 2.1 bounds baseline characterization', () => {
  it('renders the bounded sparse table without truncating its declared dimensions', async () => {
    const publication = await characterizeRenderedCase('bounds-positive')
    const table = publication.normalized.blocks[0]!.table!
    const xhtml = inspectXhtml(publication.xhtml)

    expect(table).toMatchObject({ rows: 8, columns: 8 })
    expect(table.cells).toHaveLength(2)
    expect(xhtml.tables).toHaveLength(1)
    expect(xhtml.tables[0]!.cells).toHaveLength(64)
    expect(xhtml.tables[0]!.cells.at(-1)!.text).toBe(
      'Invented cell value.',
    )
  })

  it('rejects an oversized dimension at all four boundaries before reading proxy cell storage', async () => {
    const invalid = await characterizeCodecRejection(
      'bounds-negative',
      'TABLE_BOUNDS',
    )

    expect(getSyntheticBoundsProbe(invalid).cellStorageReads).toBe(0)
  })
})
