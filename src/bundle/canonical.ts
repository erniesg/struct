import { decodeStructDocument } from '../document/index'
import type { StructDocumentJson } from '../document/codec/parsers'
import { sha256HexSync } from '../sha256'

/** The serialized Bundle document has no asset byte carrier. */
export type ByteFreeStructDocumentJson = Omit<StructDocumentJson, 'assets'> & {
  assets: Array<
    Omit<StructDocumentJson['assets'][number], 'bytes'> & { bytes?: never }
  >
}

/** Canonicalization helpers. They encode and parse bytes; they do not verify a bundle. */
export class CanonicalJsonError extends Error {
  constructor(readonly code: 'TYPE' | 'LIMIT' | 'SYNTAX' | 'NONCANONICAL') {
    super(`invalid canonical JSON: ${code.toLowerCase()}`)
    this.name = 'CanonicalJsonError'
  }
}

const MAX_DEPTH = 128
const MAX_NODES = 1_000_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, 'byteLength',
)?.get
const intrinsicTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, Symbol.toStringTag,
)?.get

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

/**
 * Walk one strict JSON value in canonical order.
 *
 * The traversal is the single definition of the canonical form: the same
 * accepted shapes, the same depth and node caps, the same cycle rule, the same
 * key order, and the same JSON escaping. The walk reports the value either as
 * canonical text or as its exact UTF-8 byte length, and never both: the byte
 * count is derived arithmetically, so measuring a value never materializes its
 * canonical text.
 */
function canonicalWalk(
  value: unknown,
  emitText: (chunk: string) => void,
  emitBytes: (bytes: number) => void,
  measure: boolean,
): void {
  const active = new WeakSet<object>()
  let nodes = 0

  function visit(item: unknown, depth: number): void {
    nodes += 1
    if (depth > MAX_DEPTH || nodes > MAX_NODES)
      throw new CanonicalJsonError('LIMIT')
    if (item === null || typeof item === 'boolean') {
      if (measure) emitBytes(item === null ? 4 : item ? 4 : 5)
      else emitText(JSON.stringify(item))
      return
    }
    if (typeof item === 'string') {
      if (!validUnicode(item)) throw new CanonicalJsonError('TYPE')
      if (measure) emitBytes(canonicalStringByteLength(item))
      else emitText(JSON.stringify(item))
      return
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        throw new CanonicalJsonError('TYPE')
      if (measure) emitBytes(canonicalNumberByteLength(item))
      else emitText(JSON.stringify(item))
      return
    }
    if (typeof item !== 'object') throw new CanonicalJsonError('TYPE')
    if (active.has(item)) throw new CanonicalJsonError('TYPE')
    active.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype)
          throw new CanonicalJsonError('TYPE')
        const keys = Reflect.ownKeys(item)
        if (
          keys.length !== item.length + 1 ||
          keys.some((key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9]\d*)$/u.test(key) ||
              Number(key) >= item.length),
          )
        ) throw new CanonicalJsonError('TYPE')
        if (measure) emitBytes(1) // the opening bracket
        else emitText('[')
        for (let index = 0; index < item.length; index += 1) {
          const property = Object.getOwnPropertyDescriptor(item, String(index))
          if (!property || !property.enumerable || !Object.hasOwn(property, 'value'))
            throw new CanonicalJsonError('TYPE')
          if (index > 0) {
            if (measure) emitBytes(1) // the separator
            else emitText(',')
          }
          visit(property.value, depth + 1)
        }
        if (measure) emitBytes(1) // the closing bracket
        else emitText(']')
        return
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null)
        throw new CanonicalJsonError('TYPE')
      const keys = Reflect.ownKeys(item)
      if (keys.some((key) => typeof key !== 'string'))
        throw new CanonicalJsonError('TYPE')
      if (measure) emitBytes(1) // the opening brace
      else emitText('{')
      let first = true
      for (const key of (keys as string[]).sort()) {
        if (!validUnicode(key)) throw new CanonicalJsonError('TYPE')
        const property = Object.getOwnPropertyDescriptor(item, key)
        if (!property || !property.enumerable || !Object.hasOwn(property, 'value'))
          throw new CanonicalJsonError('TYPE')
        if (!first) {
          if (measure) emitBytes(1) // the separator
          else emitText(',')
        }
        first = false
        if (measure) {
          emitBytes(canonicalStringByteLength(key))
          emitBytes(1) // the colon
        } else {
          emitText(JSON.stringify(key))
          emitText(':')
        }
        visit(property.value, depth + 1)
      }
      if (measure) emitBytes(1) // the closing brace
      else emitText('}')
    } finally {
      active.delete(item)
    }
  }

  visit(value, 0)
}

function canonicalText(value: unknown): string {
  const parts: string[] = []
  canonicalWalk(value, (chunk) => parts.push(chunk), () => {}, false)
  return parts.join('')
}

/** RFC 8785 bytes for strict JSON-safe in-memory data; no acceptance claim. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalText(value))
}

/**
 * UTF-8 byte length of the canonical JSON spelling of one string.
 *
 * The length matches the encoded length of `JSON.stringify(value)`: the
 * surrounding quotes, the two-byte escapes for `"` and `\`, the two-byte
 * escapes for `\b \t \n \f \r`, the six-byte `\u00xx` escape for the
 * remaining control characters, and the literal UTF-8 bytes for everything else.
 *
 * A lone surrogate is rejected with the same `TYPE` failure the canonicalizer
 * reports for it, and it is rejected before the length is used, so a hostile
 * string is never half-measured and never materialized.
 */
function canonicalStringByteLength(value: string): number {
  let bytes = 2 // the surrounding quotes
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJsonError('TYPE')
      bytes += 4
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new CanonicalJsonError('TYPE')
    if (unit < 0x20) {
      bytes +=
        unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d
          ? 2
          : 6
      continue
    }
    if (unit === 0x22 || unit === 0x5c) {
      bytes += 2
      continue
    }
    if (unit < 0x80) {
      bytes += 1
      continue
    }
    if (unit < 0x800) {
      bytes += 2
      continue
    }
    bytes += 3
  }
  return bytes
}

/**
 * UTF-8 byte length of the canonical JSON spelling of one finite number.
 *
 * A safe integer is written in plain decimal, so its length is counted
 * arithmetically and without allocating. Any other finite number is written
 * in the shortest round-trip form, whose spelling is bounded to a couple of
 * dozen characters.
 */
function canonicalNumberByteLength(value: number): number {
  if (Number.isInteger(value)) {
    if (value === 0) return 1 // `JSON.stringify(-0)` is `"0"`
    let digits = 0
    let magnitude = Math.abs(value)
    while (magnitude >= 1) {
      digits += 1
      magnitude = Math.floor(magnitude / 10)
    }
    return digits + (value < 0 ? 1 : 0)
  }
  return JSON.stringify(value).length
}

/**
 * Exact UTF-8 byte length of the canonical JSON form of a strict JSON value.
 *
 * The traversal is the canonicalizer's own: the same accepted shapes, the same
 * depth and node caps relative to the measured value, the same cycle rule, and
 * the same JSON escaping. The difference is that the size is counted instead
 * of materialized, so a hostile value is measured without a canonical buffer
 * for it. The result equals `canonicalJsonBytes(value).byteLength` for every
 * value the canonicalizer accepts.
 *
 * When `maximumBytes` is given, the count is abandoned as soon as it passes
 * that bound, so an oversized value is rejected before its full size is known.
 */
export function canonicalJsonByteSize(
  value: unknown,
  maximumBytes = Number.POSITIVE_INFINITY,
): number {
  let total = 0
  canonicalWalk(
    value,
    () => {},
    (bytes) => {
      total += bytes
      if (total > maximumBytes) throw new CanonicalJsonError('LIMIT')
    },
    true,
  )
  return total
}

/** Private bounded copy shared by raw-digest and canonical parsing callers. */
export function snapshotCanonicalJsonInput(
  raw: Uint8Array,
  maximumBytes: number,
): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new CanonicalJsonError('LIMIT')
  let snapshot: Uint8Array
  try {
    if (!ArrayBuffer.isView(raw) || !intrinsicByteLength || !intrinsicTag ||
      Reflect.apply(intrinsicTag, raw, []) !== 'Uint8Array')
      throw new CanonicalJsonError('TYPE')
    const length = Reflect.apply(intrinsicByteLength, raw, []) as number
    if (length > maximumBytes) throw new CanonicalJsonError('LIMIT')
    snapshot = new Uint8Array(length)
    Uint8Array.prototype.set.call(snapshot, raw)
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw error
    throw new CanonicalJsonError('TYPE')
  }
  return snapshot
}

/** Raw cap precedes UTF-8 decode and JSON parsing; canonical wire bytes only. */
export function parseCanonicalJsonBytes(
  raw: Uint8Array,
  maximumBytes: number,
): unknown {
  const snapshot = snapshotCanonicalJsonInput(raw, maximumBytes)
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(snapshot))
  } catch {
    throw new CanonicalJsonError('SYNTAX')
  }
  const canonical = canonicalJsonBytes(value)
  if (
    canonical.byteLength !== snapshot.byteLength ||
    canonical.some((byte, index) => byte !== snapshot[index])
  ) throw new CanonicalJsonError('NONCANONICAL')
  return value
}

/** Validate the exact byte-free document projection before hashing it. */
export function canonicalBundleDocumentBytes(value: unknown): Uint8Array {
  const inputBytes = canonicalJsonBytes(value)
  const snapshot = JSON.parse(decoder.decode(inputBytes)) as Record<string, unknown>
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new CanonicalJsonError('TYPE')
  const assets = Object.getOwnPropertyDescriptor(snapshot, 'assets')
  if (!assets || !Object.hasOwn(assets, 'value') || !Array.isArray(assets.value))
    throw new CanonicalJsonError('TYPE')
  for (const asset of assets.value) {
    if (!asset || typeof asset !== 'object' || Object.hasOwn(asset, 'bytes'))
      throw new CanonicalJsonError('TYPE')
  }
  const decoded = decodeStructDocument(snapshot)
  const decodedBytes = canonicalJsonBytes(decoded)
  if (
    inputBytes.byteLength !== decodedBytes.byteLength ||
    inputBytes.some((byte, index) => byte !== decodedBytes[index])
  ) throw new CanonicalJsonError('NONCANONICAL')
  return inputBytes
}

function unicodeScalarCompare(left: string, right: string): number {
  const first = Array.from(left)
  const second = Array.from(right)
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference = first[index]!.codePointAt(0)! - second[index]!.codePointAt(0)!
    if (difference !== 0) return difference
  }
  return first.length - second.length
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Normalize only the canonical envelope shape; asset verification is later. */
export function canonicalBundleEnvelopeBytes(value: unknown): Uint8Array {
  // Validate the complete input before reading properties, so getters and
  // prototype behavior cannot be invoked by the normalization below.
  const snapshotBytes = canonicalJsonBytes(value)
  const snapshot = JSON.parse(decoder.decode(snapshotBytes)) as unknown
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new CanonicalJsonError('TYPE')
  const envelope = snapshot as Record<string, unknown>
  if (!hasExactKeys(envelope, [
    'mediaType', 'bundleVersion', 'schemaVersion', 'documentSha256',
    'document', 'assets', 'receipt',
  ]) ||
    envelope.mediaType !== 'application/vnd.erniesg.struct+json' ||
    envelope.bundleVersion !== '1.0.0' ||
    typeof envelope.schemaVersion !== 'string' ||
    !Array.isArray(envelope.assets) ||
    typeof envelope.documentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(envelope.documentSha256)
  ) throw new CanonicalJsonError('TYPE')

  const documentBytes = canonicalBundleDocumentBytes(envelope.document)
  const document = envelope.document as Record<string, unknown>
  const receipt = envelope.receipt as Record<string, unknown>
  if (
    envelope.schemaVersion !== document.schemaVersion ||
    !receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    receipt.schemaVersion !== envelope.schemaVersion ||
    sha256HexSync(documentBytes) !== envelope.documentSha256 ||
    canonicalText(receipt) !== canonicalText(document.receipt)
  ) throw new CanonicalJsonError('TYPE')

  const ids = new Set<string>()
  for (const entry of envelope.assets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !hasExactKeys(entry as Record<string, unknown>, [
        'id', 'sha256', 'mediaType', 'byteLength', 'payload',
      ])) throw new CanonicalJsonError('TYPE')
    const asset = entry as Record<string, unknown>
    if (typeof asset.id !== 'string' || ids.has(asset.id) ||
      typeof asset.mediaType !== 'string' ||
      typeof asset.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteLength) || Number(asset.byteLength) < 0 ||
      !asset.payload || typeof asset.payload !== 'object' || Array.isArray(asset.payload))
      throw new CanonicalJsonError('TYPE')
    ids.add(asset.id)
    const payload = asset.payload as Record<string, unknown>
    if (payload.kind === 'embedded') {
      if (!hasExactKeys(payload, ['kind', 'base64']) ||
        typeof payload.base64 !== 'string') throw new CanonicalJsonError('TYPE')
    } else if (payload.kind === 'external') {
      if (!hasExactKeys(payload, ['kind', 'resourceId']) ||
        payload.resourceId !== `sha256:${asset.sha256}`)
        throw new CanonicalJsonError('TYPE')
    } else throw new CanonicalJsonError('TYPE')
  }

  const assets = [...envelope.assets].sort((a, b) =>
    unicodeScalarCompare(a.id, b.id))
  return canonicalJsonBytes({ ...envelope, assets })
}
