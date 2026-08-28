import { sha256HexSync } from './sha256'

/** Package-internal compatibility digest for serialized STRUCT 0.1.0. */
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

export function legacyStructDigestMatches(value: unknown, digest: string) {
  for (const serialized of legacyStableSerializations(value)) {
    if (sha256HexSync(serialized) === digest) return true
  }
  return false
}

/** Reproduce every legacy base-language collation supported by this runtime. */
export function legacyStructDigests(value: unknown) {
  return new Set(
    [...legacyStableSerializations(value)].map((serialized) =>
      sha256HexSync(serialized),
    ),
  )
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
