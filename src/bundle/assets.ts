import { sha256HexSync } from '../sha256'
import { canonicalBase64Padding } from '../document/codec/base64-lexical'

/** Private S-03 input to the future approved versioned limit profile. */
export type EmbeddedAssetLimits = Readonly<{
  maxAssets: number
  maxAssetBytes: number
  maxTotalBytes: number
  maxBase64Chars: number
}>

export class EmbeddedAssetError extends Error {
  constructor(readonly code: 'SHAPE' | 'SET' | 'METADATA' | 'LIMIT' | 'BASE64' | 'DIGEST' | 'UNRESOLVED') {
    super(`invalid embedded asset: ${code.toLowerCase()}`)
    this.name = 'EmbeddedAssetError'
  }
}

/** Validated embedded bytes, not a verified Bundle or wire-ingress handle. */
export type EmbeddedAssetBytes = Readonly<{
  assetIds(): string[]
  assetBytes(id: string): Uint8Array | undefined
}>

function copiedBytesView(bytes: Map<string, Uint8Array>): EmbeddedAssetBytes {
  return Object.freeze({
    assetIds: () => [...bytes.keys()].sort((left, right) => {
      const a = Array.from(left)
      const b = Array.from(right)
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!
        if (difference !== 0) return difference
      }
      return a.length - b.length
    }),
    assetBytes: (id: string) => bytes.get(id)?.slice(),
  })
}

type RecordValue = Record<string, unknown>
type AssetMetadata = { id: string; mediaType: string; sha256: string }
type EmbeddedRecord = AssetMetadata & { byteLength: number; base64: string }

function invalid(code: EmbeddedAssetError['code']): never {
  throw new EmbeddedAssetError(code)
}

function plainRecord(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('SHAPE')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid('SHAPE')
  const keys = Reflect.ownKeys(value)
  for (const key of keys) {
    if (typeof key !== 'string') invalid('SHAPE')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('SHAPE')
  }
  return value as RecordValue
}

function field(record: RecordValue, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('SHAPE')
  return descriptor.value
}

function exactKeys(record: RecordValue, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(record)
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) invalid('SHAPE')
}

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid('SHAPE')
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!Number.isSafeInteger(length) || length < 0) invalid('SHAPE')
  if (length > maximum) invalid('LIMIT')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1) invalid('SHAPE')
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('SHAPE')
    result.push(descriptor.value)
  }
  return result
}

function metadata(value: unknown): AssetMetadata {
  const record = plainRecord(value)
  if (Object.hasOwn(record, 'bytes') || Object.hasOwn(record, 'byteLength')) invalid('SHAPE')
  return metadataWithoutDocumentRestrictions(record)
}

function envelopeRecord(value: unknown, limits: EmbeddedAssetLimits): EmbeddedRecord {
  const record = plainRecord(value)
  exactKeys(record, ['id', 'mediaType', 'sha256', 'byteLength', 'payload'])
  const asset = metadataWithoutDocumentRestrictions(record)
  const byteLength = field(record, 'byteLength')
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) invalid('SHAPE')
  if (byteLength > limits.maxAssetBytes) invalid('LIMIT')
  const payload = plainRecord(field(record, 'payload'))
  const kind = field(payload, 'kind')
  if (kind === 'external') {
    exactKeys(payload, ['kind', 'resourceId'])
    if (field(payload, 'resourceId') !== `sha256:${asset.sha256}`) invalid('METADATA')
    invalid('UNRESOLVED')
  }
  if (kind !== 'embedded') invalid('SHAPE')
  exactKeys(payload, ['kind', 'base64'])
  const base64 = field(payload, 'base64')
  if (typeof base64 !== 'string') invalid('SHAPE')
  if (base64.length > limits.maxBase64Chars) invalid('LIMIT')
  return { ...asset, byteLength, base64 }
}

function metadataWithoutDocumentRestrictions(record: RecordValue): AssetMetadata {
  const id = field(record, 'id')
  const mediaType = field(record, 'mediaType')
  const sha256 = field(record, 'sha256')
  if (typeof id !== 'string' || id.length === 0 ||
      typeof mediaType !== 'string' || mediaType.length === 0 ||
      typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) invalid('METADATA')
  return { id, mediaType, sha256 }
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeCanonicalBase64(base64: string, declaredLength: number): Uint8Array {
  // Validate representation and pad bits before allocating the decoded buffer.
  const padding = canonicalBase64Padding(base64)
  if (padding === undefined) invalid('BASE64')
  const length = (base64.length / 4) * 3 - padding
  if (length !== declaredLength) invalid('BASE64')
  if (padding === 2 && (alphabet.indexOf(base64[base64.length - 3]!) & 15) !== 0) invalid('BASE64')
  if (padding === 1 && (alphabet.indexOf(base64[base64.length - 2]!) & 3) !== 0) invalid('BASE64')
  const result = new Uint8Array(length)
  let offset = 0
  for (let index = 0; index < base64.length; index += 4) {
    const bits = (alphabet.indexOf(base64[index]!) << 18) |
      (alphabet.indexOf(base64[index + 1]!) << 12) |
      ((base64[index + 2] === '=' ? 0 : alphabet.indexOf(base64[index + 2]!)) << 6) |
      (base64[index + 3] === '=' ? 0 : alphabet.indexOf(base64[index + 3]!))
    result[offset++] = (bits >>> 16) & 255
    if (offset < length) result[offset++] = (bits >>> 8) & 255
    if (offset < length) result[offset++] = bits & 255
  }
  return result
}

/**
 * Validate one complete embedded asset set without I/O. Limits are mandatory,
 * finite inputs to the future approved public profile; this helper is not a
 * Bundle verifier, does not prove document schema, wire bytes, or authenticity.
 */
export function verifyEmbeddedAssets(
  documentAssets: unknown,
  envelopeAssets: unknown,
  limits: EmbeddedAssetLimits,
): EmbeddedAssetBytes {
  try {
    const limitRecord = plainRecord(limits)
    exactKeys(limitRecord, ['maxAssets', 'maxAssetBytes', 'maxTotalBytes', 'maxBase64Chars'])
    const capNames = ['maxAssets', 'maxAssetBytes', 'maxTotalBytes', 'maxBase64Chars'] as const
    const capValues = capNames.map((key) => field(limitRecord, key))
    for (const value of capValues) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('LIMIT')
    }
    const [maxAssets, maxAssetBytes, maxTotalBytes, maxBase64Chars] = capValues as number[]
    const caps: EmbeddedAssetLimits = {
      maxAssets, maxAssetBytes, maxTotalBytes, maxBase64Chars,
    }
    // Private safety ceilings; the public versioned profile may be stricter.
    if (caps.maxAssets > 4096 || caps.maxAssetBytes > 16 * 1024 * 1024 ||
        caps.maxTotalBytes > 64 * 1024 * 1024 ||
        caps.maxBase64Chars > 24 * 1024 * 1024) invalid('LIMIT')
    const documents = boundedArray(documentAssets, caps.maxAssets)
    const envelopes = boundedArray(envelopeAssets, caps.maxAssets)
    if (documents.length !== envelopes.length) invalid('SET')
    const wanted = new Map<string, AssetMetadata>()
    for (const value of documents) {
      const asset = metadata(value)
      if (wanted.has(asset.id)) invalid('SET')
      wanted.set(asset.id, asset)
    }
    const pending = new Map<string, EmbeddedRecord>()
    let total = 0
    for (const value of envelopes) {
      const asset = envelopeRecord(value, caps)
      if (pending.has(asset.id)) invalid('SET')
      const document = wanted.get(asset.id)
      if (!document) invalid('SET')
      if (document.sha256 !== asset.sha256 || document.mediaType !== asset.mediaType) invalid('METADATA')
      if (asset.byteLength > caps.maxTotalBytes - total) invalid('LIMIT')
      total += asset.byteLength
      pending.set(asset.id, asset)
    }
    if (pending.size !== wanted.size) invalid('SET')
    const bytes = new Map<string, Uint8Array>()
    for (const [id, asset] of pending) {
      const decoded = decodeCanonicalBase64(asset.base64, asset.byteLength)
      if (sha256HexSync(decoded) !== asset.sha256) invalid('DIGEST')
      bytes.set(id, decoded)
    }
    return copiedBytesView(bytes)
  } catch (error) {
    if (error instanceof EmbeddedAssetError) throw error
    throw new EmbeddedAssetError('SHAPE')
  }
}
