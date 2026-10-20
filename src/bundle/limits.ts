import { CanonicalJsonError, canonicalJsonByteSize } from './canonical'
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
  /**
   * Upper bound for one resolver execution budget.
   *
   * The resolver total budget is mandatory and explicit. This bound is the
   * only resolver-specific cap in the single frozen profile; it never
   * enlarges the embedded caps above.
   */
  maxResolverTimeoutMs: number
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
    maxResolverTimeoutMs: 120_000,
  })

export class BundleValueLimitError extends Error {
  constructor(readonly code: 'LIMIT' | 'TYPE') {
    super(`invalid Bundle value: ${code.toLowerCase()}`)
    this.name = 'BundleValueLimitError'
  }
}

function invalid(code: 'LIMIT' | 'TYPE'): never {
  throw new BundleValueLimitError(code)
}

/**
 * Raw UTF-8 byte length of one string, counted without allocating a buffer.
 *
 * The length is the same count `TextEncoder#encode(value).byteLength` reports
 * for a well-formed string. A lone surrogate is rejected with the same `TYPE`
 * failure the canonicalizer reports for it, and it is rejected before the
 * length is used, so a hostile string is never half-measured.
 */
function rawUtf8Length(value: string): number {
  const bytes = measureRawUtf8Length(value)
  if (bytes === undefined) invalid('TYPE')
  return bytes
}

/**
 * Raw UTF-8 byte length of one string, or `undefined` when the string is not
 * well-formed Unicode.
 *
 * A malformed string is not a profile violation: the document codec rejects it
 * on its own, so a preflight reports no measurement for it and leaves the
 * codec's own failure untouched.
 */
function measureRawUtf8Length(value: string): number | undefined {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined
      bytes += 4
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return undefined
    bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3
  }
  return bytes
}

/**
 * Apply the profile's string cap to one string.
 *
 * The cap is on the raw UTF-8 length of the string, not on its escaped
 * canonical length, and the length is counted arithmetically so no buffer is
 * allocated for it.
 */
function stringBytes(value: string, profile: StructBundleLimitsProfile): void {
  if (rawUtf8Length(value) > profile.maxStringLength) invalid('LIMIT')
}

type VisitState = {
  readonly profile: StructBundleLimitsProfile
  /**
   * Objects on the current path. A repeat is a cycle; a shared subtree that
   * appears twice on different paths is visited twice, so the node count and the
   * canonical size are the expanded serialized size.
   */
  readonly active: WeakSet<object>
  nodes: number
}

/**
 * Validate one strict JSON value and count its nodes.
 *
 * The shape rules are the canonicalizer's own rules: plain objects and
 * canonical arrays only, enumerable data properties only, finite numbers with
 * safe integer values, and strings without lone surrogates. Cycles are
 * rejected on the active path, so a shared subtree is measured again for every
 * occurrence, exactly as the canonical text would serialize it: the canonical
 * size of a value is its expanded serialized size, never a deduplicated one.
 */
function visitValue(item: unknown, depth: number, state: VisitState): void {
  state.nodes += 1
  if (depth > state.profile.maxDepth || state.nodes > state.profile.maxNodes)
    invalid('LIMIT')
  if (item === null || typeof item === 'boolean') return
  if (typeof item === 'string') {
    stringBytes(item, state.profile)
    return
  }
  if (typeof item === 'number') {
    if (
      !Number.isFinite(item) ||
      (Number.isInteger(item) && !Number.isSafeInteger(item))
    )
      invalid('TYPE')
    return
  }
  if (typeof item !== 'object') invalid('TYPE')
  if (state.active.has(item)) invalid('TYPE')
  state.active.add(item)
  try {
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) invalid('TYPE')
      const keys = Reflect.ownKeys(item)
      if (
        keys.length !== item.length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9]\d*)$/u.test(key) ||
              Number(key) >= item.length),
        )
      )
        invalid('TYPE')
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          invalid('TYPE')
        visitValue(descriptor.value, depth + 1, state)
      }
      return
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) invalid('TYPE')
    const keys = Reflect.ownKeys(item)
    if (keys.some((key) => typeof key !== 'string')) invalid('TYPE')
    for (const key of keys as string[]) {
      stringBytes(key, state.profile)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      )
        invalid('TYPE')
      visitValue(descriptor.value, depth + 1, state)
    }
  } finally {
    state.active.delete(item)
  }
}

/**
 * Measure the canonical byte size of one field value under a byte budget.
 *
 * The size is the expanded serialized size, counted arithmetically, so an
 * oversized field is rejected without a canonical buffer ever being built for
 * it. A shape or unicode failure inside the field keeps the canonicalizer's
 * own `TYPE` meaning, and a budget failure is a `LIMIT`.
 */
function canonicalFieldSize(value: unknown, allowance: number): number {
  try {
    return canonicalJsonByteSize(value, allowance)
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      invalid(error.code === 'LIMIT' ? 'LIMIT' : 'TYPE')
    throw error
  }
}

/**
 * Validate the strict JSON value and the profile's nesting, node, string,
 * field, and raw byte limits.
 *
 * The value is validated in one pass: the node, depth, and per-string length
 * caps apply to the whole value, and the byte caps are charged per top-level
 * field while that field is measured. A field is rejected as soon as its
 * canonical size passes `maxFieldBytes`, and the accepted field sizes must sum
 * to at most `maxRawBytes`.
 *
 * The depth metric is root based: the root value is depth zero and the limit
 * rejects a value that reaches depth `maxDepth + 1`. A primitive root is
 * depth zero as well.
 */
export function assertStructBundleValueLimits(
  value: unknown,
  profile: StructBundleLimitsProfile = STRUCT_BUNDLE_LIMITS_PROFILE,
): void {
  const state: VisitState = {
    profile,
    active: new WeakSet<object>(),
    nodes: 0,
  }
  visitValue(value, 0, state)

  if (value === null || typeof value !== 'object' || Array.isArray(value)) return

  let accepted = 0
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid('TYPE')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('TYPE')
    const allowance = Math.min(
      profile.maxFieldBytes,
      profile.maxRawBytes - accepted,
    )
    const size = canonicalFieldSize(descriptor.value, allowance)
    accepted += size
    if (accepted > profile.maxRawBytes) invalid('LIMIT')
  }
}
