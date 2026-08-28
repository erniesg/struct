import { describe, expect, it } from 'vitest'
import * as structApi from '../src/index'
import { recoverySummary, toStructDiagnostic } from '../src/recovery'
import { verifyStructReceipt } from '../src/receipt'
import { validDocument } from './codec-fixtures'

describe('STRUCT public semantic boundary', () => {
  it('names decode compatibility truthfully while retaining the prerelease alias', () => {
    const api = structApi as Record<string, unknown>
    expect(api.decodeCompatibleStructDocument).toBeTypeOf('function')

    const decodeCompatible = api.decodeCompatibleStructDocument as (
      input: unknown,
    ) => unknown
    expect(decodeCompatible(validDocument())).toEqual(
      structApi.migrateStructDocument(validDocument()),
    )
  })

  it('emits source-neutral recovery facts without application workflow copy', () => {
    const diagnostic = toStructDiagnostic({
      code: 'UNREFERENCED_VISUAL_ASSET',
      severity: 'warning',
      message: 'A source visual has no verified semantic placement.',
      page: 1,
    })
    const ready = recoverySummary({ ready: true, diagnostics: [] })
    const review = recoverySummary({
      ready: false,
      diagnostics: [
        {
          code: 'UNREFERENCED_VISUAL_ASSET',
          severity: 'warning',
          message: 'A source visual has no verified semantic placement.',
          page: 1,
        },
      ],
      textCoverage: 1,
      assetCoverage: 0,
      relationshipCoverage: 0,
    })

    expect(JSON.stringify({ diagnostic, ready, review })).not.toMatch(
      /\b(?:PDF|EPUB|importer|preview|device|publish(?:ing|ed)?|upload(?:ed)?)\b/iu,
    )
  })

  it('fails closed when semantic receipt verification cannot inspect input', () => {
    const document = validDocument() as any
    Object.defineProperty(document, 'blocks', {
      enumerable: true,
      get() {
        throw new Error('hostile receipt input')
      },
    })

    expect(verifyStructReceipt(document)).toBe(false)
  })
})
