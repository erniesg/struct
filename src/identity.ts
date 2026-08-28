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
