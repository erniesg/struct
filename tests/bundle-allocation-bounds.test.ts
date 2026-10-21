import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonBytes,
  canonicalJsonByteSize,
} from '../src/bundle/canonical'
import {
  BundleValueLimitError,
  STRUCT_BUNDLE_LIMITS_PROFILE,
  assertStructBundleValueLimits,
} from '../src/bundle/limits'

/**
 * BAL-001 preallocation regression pilots.
 *
 * Before the fix, `assertStructBundleValueLimits` materialized a UTF-8 buffer
 * for every string occurrence during traversal and only then compared the
 * canonical field size to `maxFieldBytes`. A compact alias graph therefore
 * allocated far above the cap before it could be rejected. These tests pin
 * the corrected behavior: measurement is arithmetic, the cap is charged per
 * top-level field with an early abort, and no buffer is built for a value that
 * is about to be rejected.
 */

type EncodeObservation = { chars: number; bytes: number }

/**
 * Count every `TextEncoder#encode` call that happens while `run` executes and
 * record the largest single buffer it produces. The corrected limits path must
 * perform none at all.
 */
function instrumentTextEncoder(run: () => void): {
  calls: EncodeObservation[]
  maxSingle: number
} {
  const original = TextEncoder.prototype.encode
  const calls: EncodeObservation[] = []
  const spy = vi
    .spyOn(TextEncoder.prototype, 'encode')
    .mockImplementation(function (this: TextEncoder, input?: string) {
      const text = input ?? ''
      const bytes = original.call(this, text)
      calls.push({ chars: text.length, bytes: bytes.byteLength })
      return bytes
    })
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return { calls, maxSingle: calls.reduce((max, c) => Math.max(max, c.bytes), 0) }
}

type LimitsProfile = {
  profileVersion: typeof STRUCT_BUNDLE_LIMITS_PROFILE.profileVersion
  maxRawBytes: number
  maxFieldBytes: number
  maxAssets: number
  maxAssetBytes: number
  maxTotalBytes: number
  maxDecodedBytes: number
  maxBase64Chars: number
  maxConcurrency: number
  maxDepth: number
  maxStringLength: number
  maxNodes: number
  maxResolverTimeoutMs: number
}

function limitsProfile(overrides: Partial<LimitsProfile> = {}): LimitsProfile {
  return { ...STRUCT_BUNDLE_LIMITS_PROFILE, ...overrides }
}

function assertLimits(
  value: unknown,
  profile: LimitsProfile = STRUCT_BUNDLE_LIMITS_PROFILE,
) {
  assertStructBundleValueLimits(value, profile)
}

function assertFails(
  value: unknown,
  code: 'LIMIT' | 'TYPE',
  profile: LimitsProfile = STRUCT_BUNDLE_LIMITS_PROFILE,
) {
  try {
    assertStructBundleValueLimits(value, profile)
  } catch (error) {
    expect(error).toBeInstanceOf(BundleValueLimitError)
    expect((error as BundleValueLimitError).code).toBe(code)
    return
  }
  throw new Error('unexpected acceptance')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BAL-001 pilot: no allocation before the cap rejects', () => {
  it('rejects a compact alias graph with zero encode calls and zero buffers', () => {
    const shared = 'x'.repeat(100)
    const refs = Array.from({ length: 5000 }, () => shared)
    const value = { field: refs }
    const profile = limitsProfile({ maxFieldBytes: 50 })

    const { calls, maxSingle } = instrumentTextEncoder(() =>
      assertFails(value, 'LIMIT', profile),
    )

    expect(calls).toHaveLength(0)
    expect(maxSingle).toBe(0)
  })

  it('never builds the canonical field buffer it is about to reject', () => {
    const value = { field: 'x'.repeat(60) }
    const profile = limitsProfile({ maxFieldBytes: 50, maxStringLength: 10_000 })

    const { calls, maxSingle } = instrumentTextEncoder(() =>
      assertFails(value, 'LIMIT', profile),
    )

    expect(calls).toHaveLength(0)
    expect(maxSingle).toBe(0)
  })

  it('accepts an in-bounds value without materializing its canonical form', () => {
    const value = { field: 'x'.repeat(48) }
    const profile = limitsProfile({ maxFieldBytes: 50 })

    const { calls } = instrumentTextEncoder(() => assertLimits(value, profile))

    expect(calls).toHaveLength(0)
  })
})

describe('BAL-001 pilot: canonicalJsonByteSize equals canonicalJsonBytes length', () => {
  const samples: Array<[string, unknown]> = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['negative zero', -0],
    ['small integer', -42],
    ['max safe integer', Number.MAX_SAFE_INTEGER],
    ['fraction', 1.5],
    ['exponent', 1e-7],
    ['pi', 3.141592653589793],
    ['ascii string', 'hello'],
    ['escaped quote', 'a"b'],
    ['escaped backslash', 'a\\b'],
    ['escaped newline and tab', 'a\nb\tc'],
    ['escaped carriage and form feed', 'a\rb\fc'],
    ['escaped backspace', 'a\bb'],
    ['escaped control', 'a\u0001b'],
    ['escaped unit separator', 'a\u001cb'],
    ['latin-1', 'héllo'],
    ['two-byte boundary', 'Ā'],
    ['three-byte', '€'],
    ['astral pair', '\u{1F600}'],
    ['nested arrays', [1, [2, [3, []]], { a: [null, false] }]],
    ['sorted object keys', { c: 1, a: 2, b: 3 }],
    ['empty object', {}],
    ['empty array', []],
    ['mixed', { list: [1, 'two', { three: 3 }], text: 'é😀' }],
  ]

  it.each(samples)('matches for %s', (_label, value) => {
    const bytes = canonicalJsonBytes(value)
    expect(canonicalJsonByteSize(value)).toBe(bytes.byteLength)
  })

  it('reports the exact expanded size for a shared subtree', () => {
    const shared = { a: 1 }
    const value = { x: shared, y: shared }
    expect(canonicalJsonByteSize(value)).toBe(
      canonicalJsonBytes(value).byteLength,
    )
  })
})

describe('BAL-001 pilot: per-occurrence accounting, not global dedup', () => {
  it('charges a shared leaf once per reference', () => {
    // Expanded nodes: root + 3 * (shared object + leaf number) = 7. A
    // deduplicated model would see only 3 nodes and accept a cap of 6.
    const shared = { leaf: 1 }
    const value = { a: shared, b: shared, c: shared }
    assertFails(value, 'LIMIT', limitsProfile({ maxNodes: 6 }))
    assertLimits(value, limitsProfile({ maxNodes: 7 }))
  })

  it('measures a shared subtree at every occurrence', () => {
    const shared = { a: 1 }
    const single = { field: shared }
    // One occurrence of the subtree: `{"a":1}` === 7 canonical bytes.
    assertFails(single, 'LIMIT', limitsProfile({ maxFieldBytes: 6 }))
    assertLimits(single, limitsProfile({ maxFieldBytes: 7 }))

    // Two occurrences are charged twice, not deduplicated: 7 + 7 = 14.
    const doubled = { a: shared, b: shared }
    expect(canonicalJsonByteSize(doubled)).toBe(
      canonicalJsonBytes(doubled).byteLength,
    )
    assertFails(doubled, 'LIMIT', limitsProfile({ maxRawBytes: 13 }))
    assertLimits(doubled, limitsProfile({ maxRawBytes: 14 }))
  })

  it('accepts an acyclic shared DAG and rejects an active cycle', () => {
    const shared = { leaf: 1 }
    const dag = { left: shared, right: shared }
    expect(() => assertLimits(dag)).not.toThrow()

    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    assertFails(cyclic, 'TYPE')
  })
})

describe('BAL-001 pilot: N-1/N/N+1 conformance is unchanged', () => {
  it.each([49, 50, 51])('enforces maxFieldBytes at N-1/N/N+1 (%i)', (length) => {
    const value = { field: 'x'.repeat(length) }
    const profile = limitsProfile({ maxFieldBytes: 50 })
    if (length + 2 > 50) assertFails(value, 'LIMIT', profile)
    else assertLimits(value, profile)
  })

  it.each([7, 8, 9])('enforces maxRawBytes at N-1/N/N+1 (%i bytes)', (total) => {
    // The raw budget sums each top-level field value's canonical size. A
    // single 6-character string field has a value of 8 bytes (2 quotes + 6).
    const value = { a: 'x'.repeat(6) }
    expect(canonicalJsonByteSize('x'.repeat(6))).toBe(8)
    const profile = limitsProfile({ maxRawBytes: total })
    if (total < 8) assertFails(value, 'LIMIT', profile)
    else assertLimits(value, profile)
  })

  it('accepts fields exactly at the raw budget and rejects one over it', () => {
    const value = { a: 'x'.repeat(6) } // one 8-byte field value
    assertLimits(value, limitsProfile({ maxRawBytes: 8 }))
    assertFails(value, 'LIMIT', limitsProfile({ maxRawBytes: 7 }))
  })

  it.each([9, 10, 11])('enforces maxStringLength at N-1/N/N+1 (%i bytes)', (bytes) => {
    const value = 'x'.repeat(bytes)
    const profile = limitsProfile({ maxStringLength: 10 })
    if (bytes > 10) assertFails(value, 'LIMIT', profile)
    else assertLimits(value, profile)
  })

  it.each([2, 3, 4])('enforces maxDepth at N-1/N/N+1 (%i arrays)', (arrays) => {
    const value = JSON.parse('['.repeat(arrays) + '0' + ']'.repeat(arrays))
    const profile = limitsProfile({ maxDepth: 3 })
    if (arrays > 3) assertFails(value, 'LIMIT', profile)
    else assertLimits(value, profile)
  })

  it.each([7, 8, 9])('enforces maxNodes at N-1/N/N+1 (%i nodes)', (nodes) => {
    const value = Array.from({ length: nodes - 1 }, () => 0)
    const profile = limitsProfile({ maxNodes: 8 })
    if (nodes > 8) assertFails(value, 'LIMIT', profile)
    else assertLimits(value, profile)
  })
})

describe('BAL-001 pilot: canonical matching is preserved', () => {
  it('sorts object keys the same way the canonicalizer does', () => {
    const value = { zebra: 1, apple: 2, mango: 3 }
    expect(canonicalJsonByteSize(value)).toBe(
      canonicalJsonBytes({ apple: 2, mango: 3, zebra: 1 }).byteLength,
    )
  })

  it('matches number spellings exactly', () => {
    for (const number of [0, -0, 7, -7, 9007199254740991, 0.5, -1.25, 1e-7]) {
      expect(canonicalJsonByteSize({ n: number })).toBe(
        canonicalJsonBytes({ n: number }).byteLength,
      )
    }
  })

  it('matches escape spellings exactly', () => {
    for (const text of [
      '"',
      '\\',
      '\n',
      '\t',
      '\r',
      '\f',
      '\b',
      '\u0001',
      '\u001c',
      '',
      '\u001f',
    ]) {
      expect(canonicalJsonByteSize({ s: text })).toBe(
        canonicalJsonBytes({ s: text }).byteLength,
      )
    }
  })

  it('rejects lone surrogates with the canonicalizer TYPE meaning', () => {
    assertFails({ value: '\ud800' }, 'TYPE')
    assertFails({ value: 'ok\udfff' }, 'TYPE')
  })

  it('rejects non-finite and unsafe-integer numbers with TYPE', () => {
    assertFails({ value: Infinity }, 'TYPE')
    assertFails({ value: Number.MAX_SAFE_INTEGER + 1 }, 'TYPE')
  })
})

describe('BAL-001 pilot: cumulative caps are not enlarged', () => {
  it('keeps the raw budget under the sum of accepted fields', () => {
    const value = { a: 'x'.repeat(24), b: 'x'.repeat(24) }
    // Each field value is 26 canonical bytes (2 quotes + 24 chars); sum 52.
    assertLimits(value, limitsProfile({ maxRawBytes: 52 }))
    assertFails(value, 'LIMIT', limitsProfile({ maxRawBytes: 51 }))
  })

  it('rejects the first field that would exceed the raw budget', () => {
    const value = { a: 'x'.repeat(48), b: 1 }
    const profile = limitsProfile({ maxRawBytes: 50 })
    assertFails(value, 'LIMIT', profile)
  })
})
