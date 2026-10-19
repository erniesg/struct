import { CanonicalJsonError, canonicalJsonBytes } from './canonical'

/**
 * Versioned public resource profile for embedded Bundle acceptance.
 *
 * The profile is deliberately fixed. A caller cannot enlarge it, and no option
 * on the embedded value API can select another profile. Nested limits are
 * enforced before canonical full-envelope or asset allocation.
 */
export const STRUCT_BUNDLE_LIMITS_PROFILE_VERSION = '1.0.0' as const

export type StructBundleLimitsProfile = Readonly<{
  profileVersion: typeof STRUCT_BUNDLE_LIMITS_PROFILE_VERSION
  maxRawBytes: number
  /** Maximum canonical bytes in one top-level envelope field. */
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
}>

export const STRUCT_BUNDLE_LIMITS_PROFILE: StructBundleLimitsProfile =
  Object.freeze({
    profileVersion: STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
    maxRawBytes: 8 * 1024 * 1024,
    maxFieldBytes: 5_600_000,
    maxAssets: 256,
    maxAssetBytes: 4 * 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxBase64Chars: 5_592_408,
    maxConcurrency: 1,
    maxDepth: 128,
    maxStringLength: 5_592_408,
    maxNodes: 1_000_000,
  })

export class BundleValueLimitError extends Error {
  constructor(readonly code: 'LIMIT' | 'TYPE') {
    super(`invalid Bundle value: ${code.toLowerCase()}`)
    this.name = 'BundleValueLimitError'
  }
}

const encoder = new TextEncoder()

function invalid(code: 'LIMIT' | 'TYPE'): never {
  throw new BundleValueLimitError(code)
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function stringBytes(value: string, profile: StructBundleLimitsProfile): number {
  if (!validUnicode(value)) invalid('TYPE')
  const length = encoder.encode(value).byteLength
  if (length > profile.maxStringLength) invalid('LIMIT')
  return length
}

/**
 * Validate the strict JSON value and the profile's nesting, node, string and
 * top-level field caps without invoking accessors. This is not canonicalization
 * and makes no wire-bytes claim; canonical helpers still run afterwards.
 */
export function assertStructBundleValueLimits(
  value: unknown,
  profile: StructBundleLimitsProfile = STRUCT_BUNDLE_LIMITS_PROFILE,
): void {
  const active = new WeakSet<object>()
  let nodes = 0

  function visit(item: unknown, depth: number): void {
    nodes += 1
    if (depth > profile.maxDepth || nodes > profile.maxNodes) invalid('LIMIT')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') {
      stringBytes(item, profile)
      return
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item))) invalid('TYPE')
      return
    }
    if (typeof item !== 'object') invalid('TYPE')
    if (active.has(item)) invalid('TYPE')
    active.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) invalid('TYPE')
        const keys = Reflect.ownKeys(item)
        if (
          keys.length !== item.length + 1 ||
          keys.some((key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9]\d*)$/u.test(key) ||
              Number(key) >= item.length))
        ) invalid('TYPE')
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value')) invalid('TYPE')
          visit(descriptor.value, depth + 1)
        }
        return
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) invalid('TYPE')
      const keys = Reflect.ownKeys(item)
      if (keys.some((key) => typeof key !== 'string')) invalid('TYPE')
      for (const key of keys as string[]) {
        stringBytes(key, profile)
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')) invalid('TYPE')
        visit(descriptor.value, depth + 1)
      }
    } finally {
      active.delete(item)
    }
  }

  visit(value, 0)

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    try {
      let fields = 0
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') invalid('TYPE')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('TYPE')
        const size = canonicalJsonBytes(descriptor.value).byteLength
        if (size > profile.maxFieldBytes) invalid('LIMIT')
        fields += size
        if (fields > profile.maxRawBytes) invalid('LIMIT')
      }
    } catch (error) {
      if (error instanceof BundleValueLimitError) throw error
      if (error instanceof CanonicalJsonError) invalid(error.code === 'LIMIT' ? 'LIMIT' : 'TYPE')
      throw error
    }
  }
}
