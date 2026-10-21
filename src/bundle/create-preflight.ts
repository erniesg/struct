import { preflightBytes } from '../document/codec/bytes'
import {
  canonicalNumberByteLength,
  canonicalStringByteLength,
} from './canonical'
import type { StructBundleLimitsProfile } from './limits'

/**
 * Private pre-allocation guard for the Bundle create path.
 *
 * `createStructBundle` receives an untrusted in-memory document. The document
 * codec has its own outer bounds (128 MiB per asset, 128 MiB aggregate asset
 * bytes, 100k document items, 4 MiB strings), so an oversized asset is copied
 * and digested before the Bundle profile's much tighter caps (4 MiB per
 * asset, 4 MiB decoded, 4 MiB total, 5,592,408 base64 characters) can reject
 * it. This module applies the frozen Bundle profile to the *untrusted input*
 * before `decodeStructDocument` runs, so the profile is the first allocation
 * guard for create, exactly as it already is for decode and verify.
 *
 * The preflight is conservative by construction:
 *
 * - Every rejection is implied by a cap the current post-decode path already
 *   enforces, so a document the current path accepts is never rejected here.
 * - The document-size charge is the canonicalizer's own measurement of the
 *   byte-free document projection, so exceeding the budget implies that the
 *   canonical projection would exceed the envelope field cap.
 * - The envelope total is charged from lower bounds only, so a rejection
 *   implies that the canonical envelope would exceed the envelope byte cap.
 * - Measurement is arithmetic: no base64 is decoded or encoded, no buffer is
 *   copied, no digest is computed, and no canonical text is materialized.
 * - Caller accessors are never invoked; every value is read through its own
 *   property descriptor.
 */

/** Preflight rejection mapped onto the existing Bundle failure taxonomy. */
export type StructBundleCreatePreflightError =
  | Readonly<{ stage: 'input'; code: 'TYPE' }>
  | Readonly<{ stage: 'assets'; code: 'LIMIT' }>
  | Readonly<{ stage: 'canonical'; code: 'LIMIT' }>

/** Preflight outcome: acceptance, or the taxonomy entry that rejects. */
export type StructBundleCreatePreflightResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: StructBundleCreatePreflightError }>

class CreatePreflightRejection extends Error {
  constructor(readonly error: StructBundleCreatePreflightError) {
    super('struct bundle create preflight rejected')
    this.name = 'CreatePreflightRejection'
  }
}

function reject(error: StructBundleCreatePreflightError): never {
  throw new CreatePreflightRejection(error)
}

const accepted: StructBundleCreatePreflightResult = Object.freeze({ ok: true })

function rejected(
  error: StructBundleCreatePreflightError,
): StructBundleCreatePreflightResult {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/**
 * Raw UTF-8 byte length of one string, counted without allocating a buffer.
 *
 * The count matches `TextEncoder#encode(value).byteLength` for every
 * well-formed string. A lone surrogate is not well-formed: the document codec
 * rejects it, so the preflight reports the codec's own `TYPE` meaning instead
 * of measuring half a string.
 */
function rawUtf8Length(value: string): number | undefined {
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

/** Own enumerable data property, or `undefined` for anything else. */
function dataProperty(
  value: object,
  key: string,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    !descriptor ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  )
    return undefined
  return descriptor
}

/** Array length read from its own data property, never through a getter. */
function arrayLength(value: unknown[]): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = descriptor?.value
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, 'value') ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  )
    return undefined
  return length
}

/**
 * Decoded byte length of one asset byte carrier, without decoding it.
 *
 * The three carriers the document codec accepts are a canonical `Uint8Array`,
 * a canonical base64 string, and a byte array. The codec's own carrier
 * inspection reports the exact decoded length for each of them, so the
 * preflight and the codec always agree on how many bytes an asset holds. A
 * carrier the codec cannot inspect returns `undefined` and is left to the
 * codec's own failure.
 */
function decodedByteLength(carrier: unknown): number | undefined {
  try {
    return preflightBytes(
      carrier,
      '$.assets[].bytes',
      Number.POSITIVE_INFINITY,
    )
  } catch {
    return undefined
  }
}

/** Base64 character count of a re-encoded asset payload. */
function base64CharCount(decodedBytes: number): number {
  return 4 * Math.ceil(decodedBytes / 3)
}

/**
 * The cap that actually bounds the document projection.
 *
 * The projection is one top-level envelope field, so the envelope field cap
 * binds it, and the envelope byte cap bounds it as well. The smaller of the
 * two is the budget the projection has to fit in.
 */
function documentBudget(profile: StructBundleLimitsProfile): number {
  return Math.min(profile.maxFieldBytes, profile.maxRawBytes)
}

/**
 * Lower bound of the canonical size of one envelope string field.
 *
 * The canonical length of a string is its raw UTF-8 length plus its two
 * quotes, and escaping only ever grows it, so the raw length plus two is a
 * lower bound of the canonical length.
 */
function stringFieldLowerBound(value: unknown): number {
  if (typeof value !== 'string') return 0
  const length = rawUtf8Length(value)
  if (length === undefined) return 0
  return length + 2
}

/* The envelope the create path builds, field by field. */
const envelopeMediaTypeBytes = 36 // `application/vnd.erniesg.struct+json`
const envelopeBundleVersionBytes = 7 // `1.0.0`
const envelopeDocumentSha256Bytes = 66 // 64 hexadecimal digits
const envelopeShellBytes = 8 // the braces and the six field separators
const envelopeKeyBytes = 77 // the seven field names and their colons
const envelopeAssetRecordBytes = 72 // one asset record without its payload

type VisitState = {
  readonly profile: StructBundleLimitsProfile
  /** Objects on the current path. A repeat is a cycle. */
  readonly active: WeakSet<object>
  nodes: number
  /** Canonical size of the byte-free document projection. */
  charged: number
  /** Canonical size of the document's receipt subtree. */
  receiptCharged: number
  /** Canonical size of the document's schema version string. */
  schemaVersionCharged: number
}

/**
 * Charge the canonical size of the byte-free document projection.
 *
 * Every charge is the canonicalizer's own measurement of the matching node: a
 * string is charged its canonical JSON length, a number its canonical JSON
 * length, `null` four bytes, a boolean four or five bytes, an object its
 * braces, separators, and quoted keys, and an array its brackets and
 * separators. The projection is the byte-free document, so the charge is the
 * size the post-decode path measures for the envelope's `document` field.
 */
function charge(state: VisitState, bytes: number): void {
  state.charged += bytes
  if (state.charged > documentBudget(state.profile))
    reject({ stage: 'canonical', code: 'LIMIT' })
}

/**
 * Lower bound of the canonical size of one envelope asset record.
 *
 * The create path writes one record per asset with exactly the fields
 * `id`, `sha256`, `mediaType`, `byteLength`, and `payload`, and the payload
 * holds the base64 spelling of the asset bytes. Every part of that record is
 * measured here without decoding or copying anything.
 */
function envelopeAssetRecord(entry: object, decodedBytes: number): number {
  return (
    envelopeAssetRecordBytes +
    canonicalNumberByteLength(decodedBytes) +
    stringFieldLowerBound(dataProperty(entry, 'id')?.value) +
    stringFieldLowerBound(dataProperty(entry, 'mediaType')?.value) +
    stringFieldLowerBound(dataProperty(entry, 'sha256')?.value) +
    base64CharCount(decodedBytes)
  )
}

/**
 * Apply the profile's asset caps to the untrusted asset list.
 *
 * The caps are the same caps the create path applies after the decode, with
 * the same meaning: the asset count, the decoded length of every asset, the
 * cumulative decoded length, and the base64 length of every payload. The
 * carrier is measured, never decoded, so an oversized asset is rejected
 * before its bytes are copied or digested.
 *
 * The returned value is the lower bound of the canonical size of the
 * envelope's `assets` field, which the post-decode path adds to the other
 * envelope fields before it applies the envelope byte cap.
 */
function preflightAssets(
  assets: unknown[],
  profile: StructBundleLimitsProfile,
): number {
  const length = arrayLength(assets)
  if (length === undefined) return 0
  if (length > profile.maxAssets) reject({ stage: 'assets', code: 'LIMIT' })
  const totalCap = Math.min(profile.maxTotalBytes, profile.maxDecodedBytes)
  let total = 0
  let envelope = 2 + Math.max(0, length - 1)
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(assets, String(index))
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      continue
    const entry = descriptor.value
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      continue
    const bytes = dataProperty(entry, 'bytes')
    if (bytes === undefined) continue
    const carrier = bytes.value
    if (
      typeof carrier === 'string' &&
      carrier.length > profile.maxBase64Chars
    )
      reject({ stage: 'assets', code: 'LIMIT' })
    const decoded = decodedByteLength(carrier)
    if (decoded === undefined) continue
    if (decoded > profile.maxAssetBytes) reject({ stage: 'assets', code: 'LIMIT' })
    if (total + decoded > totalCap) reject({ stage: 'assets', code: 'LIMIT' })
    total += decoded
    if (base64CharCount(decoded) > profile.maxBase64Chars)
      reject({ stage: 'assets', code: 'LIMIT' })
    envelope += envelopeAssetRecord(entry, decoded)
  }
  return envelope
}

/**
 * Apply the envelope byte cap to the fields the preflight can measure.
 *
 * The post-decode path bounds every envelope field by the field cap and the
 * sum of the envelope fields by the envelope byte cap, and it finally bounds
 * the canonical envelope itself by the envelope byte cap. The preflight
 * charges the same fields from lower bounds, in the order the create path
 * writes them, so a rejection here implies that the post-decode path
 * rejects the same document.
 */
function assertEnvelopeBudget(
  state: VisitState,
  assetsEnvelopeBytes: number,
): void {
  const profile = state.profile
  const fields: ReadonlyArray<readonly [string, number]> = [
    ['mediaType', envelopeMediaTypeBytes],
    ['bundleVersion', envelopeBundleVersionBytes],
    ['schemaVersion', state.schemaVersionCharged],
    ['documentSha256', envelopeDocumentSha256Bytes],
    ['document', state.charged],
    ['assets', assetsEnvelopeBytes],
    ['receipt', state.receiptCharged],
  ]
  let accepted = 0
  for (const [, size] of fields) {
    const allowance = Math.min(
      profile.maxFieldBytes,
      profile.maxRawBytes - accepted,
    )
    if (size > allowance) reject({ stage: 'canonical', code: 'LIMIT' })
    accepted += size
  }
  const envelope = accepted + envelopeShellBytes + envelopeKeyBytes
  if (envelope > profile.maxRawBytes)
    reject({ stage: 'canonical', code: 'LIMIT' })
}

/** Where the current value sits in the untrusted document graph. */
type VisitContext = {
  /** The value is an asset entry: its byte carrier is not projected. */
  readonly skipBytes: boolean
  /** The value is the asset array: its entries are asset entries. */
  readonly assetEntries: boolean
  /** The value is the document root. */
  readonly root: boolean
}

const plainContext: VisitContext = Object.freeze({
  skipBytes: false,
  assetEntries: false,
  root: false,
})

/**
 * Walk one strict JSON value of the untrusted document.
 *
 * The walk counts nodes and depth, applies the string cap, and charges the
 * canonical size of the byte-free projection. It reads only own property
 * descriptors, so a caller accessor is never invoked, and it rejects a cycle
 * on the active path. The shapes it rejects are the shapes the document codec
 * rejects as well, so a rejection here never hides an acceptance there.
 *
 * The returned value is the canonical size of the walked subtree.
 */
function visit(
  item: unknown,
  depth: number,
  state: VisitState,
  context: VisitContext,
): number {
  const before = state.charged
  state.nodes += 1
  if (depth > state.profile.maxDepth) reject({ stage: 'canonical', code: 'LIMIT' })
  if (state.nodes > state.profile.maxNodes) reject({ stage: 'canonical', code: 'LIMIT' })

  if (item === null) {
    charge(state, 4)
    return state.charged - before
  }
  if (typeof item === 'boolean') {
    charge(state, item ? 4 : 5)
    return state.charged - before
  }
  if (typeof item === 'number') {
    if (!Number.isFinite(item)) reject({ stage: 'input', code: 'TYPE' })
    charge(state, canonicalNumberByteLength(item))
    return state.charged - before
  }
  if (typeof item === 'string') {
    const length = rawUtf8Length(item)
    if (length === undefined) reject({ stage: 'input', code: 'TYPE' })
    if (length > state.profile.maxStringLength) reject({ stage: 'canonical', code: 'LIMIT' })
    charge(state, canonicalStringByteLength(item))
    return state.charged - before
  }
  if (typeof item !== 'object') reject({ stage: 'input', code: 'TYPE' })

  const value = item as object
  if (state.active.has(value)) reject({ stage: 'input', code: 'TYPE' })
  state.active.add(value)
  try {
    if (Array.isArray(value)) {
      const length = arrayLength(value)
      if (length === undefined) reject({ stage: 'input', code: 'TYPE' })
      charge(state, 2 + Math.max(0, length - 1))
      const elementContext: VisitContext = context.assetEntries
        ? Object.freeze({ ...plainContext, skipBytes: true })
        : plainContext
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        )
          reject({ stage: 'input', code: 'TYPE' })
        visit(descriptor.value, depth + 1, state, elementContext)
      }
      return state.charged - before
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      reject({ stage: 'input', code: 'TYPE' })
    const keys = Reflect.ownKeys(value)
    const skipped = context.skipBytes && dataProperty(value, 'bytes') !== undefined
    charge(state, 2 + Math.max(0, keys.length - (skipped ? 1 : 0) - 1))
    for (const key of keys) {
      if (typeof key !== 'string') reject({ stage: 'input', code: 'TYPE' })
      const keyLength = rawUtf8Length(key)
      if (keyLength === undefined) reject({ stage: 'input', code: 'TYPE' })
      if (keyLength > state.profile.maxStringLength)
        reject({ stage: 'canonical', code: 'LIMIT' })
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      )
        reject({ stage: 'input', code: 'TYPE' })
      if (skipped && key === 'bytes') continue
      charge(state, canonicalStringByteLength(key) + 1)
      const childContext: VisitContext = context.root && key === 'assets'
        ? Object.freeze({ ...plainContext, assetEntries: true })
        : plainContext
      const childCharge = visit(descriptor.value, depth + 1, state, childContext)
      if (context.root && key === 'receipt')
        state.receiptCharged = childCharge
      if (context.root && key === 'schemaVersion')
        state.schemaVersionCharged = stringFieldLowerBound(descriptor.value)
    }
    return state.charged - before
  } finally {
    state.active.delete(value)
  }
}

/**
 * Apply the frozen Bundle profile to an untrusted create input.
 *
 * The asset caps are checked first, so an oversized asset is reported as an
 * asset limit even when the rest of the document would fail the codec's own
 * validation. The document graph is then measured for nesting, node count,
 * string length, and canonical size, and the envelope fields the preflight
 * can measure are charged against the envelope byte cap.
 */
export function preflightStructBundleCreate(
  documentInput: unknown,
  profile: StructBundleLimitsProfile,
): StructBundleCreatePreflightResult {
  try {
    if (
      documentInput === null ||
      typeof documentInput !== 'object' ||
      Array.isArray(documentInput)
    )
      reject({ stage: 'input', code: 'TYPE' })
    const prototype = Object.getPrototypeOf(documentInput)
    if (prototype !== Object.prototype && prototype !== null)
      reject({ stage: 'input', code: 'TYPE' })

    const assets = dataProperty(documentInput, 'assets')
    const assetsEnvelopeBytes =
      assets !== undefined && Array.isArray(assets.value)
        ? preflightAssets(assets.value, profile)
        : 0

    const state: VisitState = {
      profile,
      active: new WeakSet<object>(),
      nodes: 0,
      charged: 0,
      receiptCharged: 0,
      schemaVersionCharged: 0,
    }
    visit(documentInput, 0, state, Object.freeze({ ...plainContext, root: true }))
    assertEnvelopeBudget(state, assetsEnvelopeBytes)
    return accepted
  } catch (error) {
    if (error instanceof CreatePreflightRejection) return rejected(error.error)
    return rejected({ stage: 'input', code: 'TYPE' })
  }
}
