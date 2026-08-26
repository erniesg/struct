import { sha256HexSync } from './sha256'

/** Canonical identifier primitive shared by the STRUCT core and adapters. */
export const SAFE_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
export const CREDENTIAL_SHAPED_ID_PATTERNS = [
  /^sk-(?:proj-)?[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:AKIA|ASIA)[A-Z0-9]{12,}$/u,
  /^bearer[.:-][A-Za-z0-9._:-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/iu,
  /^(?:-----)?BEGIN[.:-]?(?:(?:RSA|EC|OPENSSH)[.:-]?)?PRIVATE[.:-]?KEY/iu,
  /^xox[baprs]-[A-Za-z0-9._:-]{8,}$/iu,
  /^(?:gh[pousr]|github_pat)_/iu,
] as const

export function credentialShapedValue(value: string) {
  return CREDENTIAL_SHAPED_ID_PATTERNS.some((pattern) => pattern.test(value))
}

export const SAFE_ID = {
  test(value: string) {
    return SAFE_ID_FORMAT.test(value) && !credentialShapedValue(value)
  },
}

/** Stable IDs are content-addressed so reflowing a page cannot rename a node. */
export function structId(namespace: string, value: string) {
  return `struct-${namespace}-${sha256HexSync(value).slice(0, 24)}`
}

export function structDigest(value: unknown) {
  return sha256HexSync(stableSerialize(value))
}

/** Digest used by serialized STRUCT 0.1.0 documents before ordering was fixed. */
export function legacyStructDigest(value: unknown, locale?: string) {
  return sha256HexSync(legacyStableSerialize(value, locale))
}

let legacySupportedLocales: string[] | undefined

function supportedLegacyLocales() {
  if (legacySupportedLocales) return legacySupportedLocales
  const candidates = [2, 3].flatMap((length) =>
    Array.from({ length: 26 ** length }, (_, index) => {
      let remaining = index
      return Array.from({ length }, () => {
        const character = String.fromCharCode(97 + (remaining % 26))
        remaining = Math.floor(remaining / 26)
        return character
      })
        .reverse()
        .join('')
    }),
  )
  legacySupportedLocales = Intl.Collator.supportedLocalesOf(candidates)
  return legacySupportedLocales
}

/** Reproduce every base-language collation supported by this ICU runtime. */
export function legacyStructDigests(value: unknown) {
  return new Set(
    [...legacyStableSerializations(value)].map((serialized) =>
      sha256HexSync(serialized),
    ),
  )
}

export function legacyStructDigestMatches(value: unknown, digest: string) {
  for (const serialized of legacyStableSerializations(value)) {
    if (sha256HexSync(serialized) === digest) return true
  }
  return false
}

type LegacySerializationPlan =
  | { kind: 'primitive'; serialized: string }
  | { kind: 'array'; values: LegacySerializationPlan[] }
  | {
      kind: 'object'
      keySetId: string
      values: Map<string, LegacySerializationPlan>
    }

type LegacyKeyOrder = {
  signature: string
  keysBySet: Map<string, string[]>
}

/**
 * Capture the JSON-shaped value once. Legacy verification used to recursively
 * walk the complete document once for every supported ICU locale.
 */
function legacySerializationPlan(
  value: unknown,
  keySets: Map<string, string[]>,
): LegacySerializationPlan {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      values: value.map((item) => legacySerializationPlan(item, keySets)),
    }
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    const keys = entries.map(([key]) => key)
    const keySetId = JSON.stringify(keys)
    if (!keySets.has(keySetId)) keySets.set(keySetId, keys)
    return {
      kind: 'object',
      keySetId,
      values: new Map(
        entries.map(([key, nested]) => [
          key,
          legacySerializationPlan(nested, keySets),
        ]),
      ),
    }
  }
  return { kind: 'primitive', serialized: JSON.stringify(value) as string }
}

function legacyKeyOrder(
  keySets: ReadonlyMap<string, readonly string[]>,
  locale?: string,
): LegacyKeyOrder {
  const keysBySet = new Map<string, string[]>()
  const signature: string[][] = []
  for (const [keySetId, keys] of keySets) {
    const ordered = [...keys].sort((left, right) =>
      left.localeCompare(right, locale),
    )
    keysBySet.set(keySetId, ordered)
    signature.push(ordered)
  }
  return { signature: JSON.stringify(signature), keysBySet }
}

function serializeLegacyPlan(
  plan: LegacySerializationPlan,
  order: LegacyKeyOrder,
): string {
  if (plan.kind === 'primitive') return plan.serialized
  if (plan.kind === 'array') {
    return `[${plan.values
      .map((item) => serializeLegacyPlan(item, order))
      .join(',')}]`
  }
  const keys = order.keysBySet.get(plan.keySetId)!
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeLegacyPlan(plan.values.get(key)!, order)}`,
    )
    .join(',')}}`
}

/** Serialize once per distinct whole-document key ordering, not per locale. */
function* legacyStableSerializations(value: unknown) {
  const keySets = new Map<string, string[]>()
  const plan = legacySerializationPlan(value, keySets)
  const seenOrders = new Set<string>()
  for (const locale of [undefined, ...supportedLegacyLocales()]) {
    const order = legacyKeyOrder(keySets, locale)
    if (seenOrders.has(order.signature)) continue
    seenOrders.add(order.signature)
    yield serializeLegacyPlan(plan, order)
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      // Order by code unit, never by collation. `localeCompare` asks the
      // runtime's ICU locale: `en-US` puts `a` before `B` and Lithuanian puts
      // `y` before `w` — and `w`/`y` are `StructBox` keys. Now that packaging
      // re-derives this digest, a collation-dependent order means a document
      // built on one machine cannot be packaged on another.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function legacyStableSerialize(value: unknown, locale?: string): string {
  if (Array.isArray(value))
    return `[${value.map((item) => legacyStableSerialize(item, locale)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, locale))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${legacyStableSerialize(nested, locale)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}
