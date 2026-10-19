import { describe, expect, it } from 'vitest'
import {
  BundleValueLimitError,
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
  assertStructBundleValueLimits,
} from '../src/bundle/limits'

const small = {
  ...STRUCT_BUNDLE_LIMITS_PROFILE,
  maxDepth: 3,
  maxNodes: 8,
  maxStringLength: 10,
  maxFieldBytes: 10,
}

function fails(value: unknown, code: 'LIMIT' | 'TYPE', profile = small) {
  try {
    assertStructBundleValueLimits(value, profile)
    throw new Error('unexpected acceptance')
  } catch (error) {
    expect(error).toBeInstanceOf(BundleValueLimitError)
    expect((error as BundleValueLimitError).code).toBe(code)
  }
}

describe('versioned embedded Bundle limits profile pilot', () => {
  it('publishes one frozen versioned profile', () => {
    expect(STRUCT_BUNDLE_LIMITS_PROFILE_VERSION).toBe('1.0.0')
    expect(STRUCT_BUNDLE_LIMITS_PROFILE.profileVersion).toBe(
      STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
    )
    expect(Object.isFrozen(STRUCT_BUNDLE_LIMITS_PROFILE)).toBe(true)
    expect(STRUCT_BUNDLE_LIMITS_PROFILE).toMatchObject({
      maxRawBytes: 8 * 1024 * 1024,
      maxAssets: 256,
      maxAssetBytes: 4 * 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxDecodedBytes: 4 * 1024 * 1024,
      maxConcurrency: 1,
      maxDepth: 128,
    })
  })

  it.each([9, 10, 11])('applies the string-length cap at N-1/N/N+1 (%i)', (length) => {
    if (length > small.maxStringLength) fails('x'.repeat(length), 'LIMIT')
    else expect(() => assertStructBundleValueLimits('x'.repeat(length), small))
      .not.toThrow()
  })

  it.each([2, 3, 4])('applies the nesting cap at N-1/N/N+1 (%i arrays)', (arrays) => {
    const value = '['.repeat(arrays) + '0' + ']'.repeat(arrays)
    if (arrays > small.maxDepth) fails(JSON.parse(value), 'LIMIT')
    else expect(() => assertStructBundleValueLimits(JSON.parse(value), small))
      .not.toThrow()
  })

  it.each([7, 8, 9])('applies the node cap at N-1/N/N+1 (%i nodes)', (nodes) => {
    const value = Array.from({ length: nodes - 1 }, () => 0)
    if (nodes > small.maxNodes) fails(value, 'LIMIT')
    else expect(() => assertStructBundleValueLimits(value, small)).not.toThrow()
  })

  it.each([11, 12, 13])('applies the per-field byte cap at N-1/N/N+1 (%i)', (length) => {
    const value = { field: 'x'.repeat(length) }
    // JSON adds one quote on each side, so 12 is the encoded boundary here.
    const profile = { ...small, maxStringLength: 100, maxFieldBytes: 12 }
    if (length > profile.maxFieldBytes - 2) fails(value, 'LIMIT', profile)
    else expect(() => assertStructBundleValueLimits(value, profile)).not.toThrow()
  })

  it('rejects invalid Unicode, unsafe integers, accessors, cycles and prototypes', () => {
    fails({ value: '\ud800' }, 'TYPE')
    fails({ value: Number.MAX_SAFE_INTEGER + 1 }, 'TYPE')
    fails({ value: Infinity }, 'TYPE')
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { throw new Error('must not execute') },
    })
    fails(getter, 'TYPE')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    fails(cycle, 'TYPE')
    fails(Object.create({ inherited: true }), 'TYPE')
    fails(new Uint8Array(1), 'TYPE')
    fails(new Array(1), 'TYPE')
  })
})
