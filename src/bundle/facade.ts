import {
  CanonicalJsonError,
  canonicalBundleDocumentBytes,
  canonicalBundleEnvelopeBytes,
  parseCanonicalJsonBytes,
  snapshotCanonicalJsonInput,
} from './canonical'
import {
  decodeEmbeddedBundleBytes,
} from './embedded'
import type { EmbeddedAcceptanceResult } from './embedded'
import {
  BundleValueLimitError,
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
  assertStructBundleValueLimits,
} from './limits'
import type { StructBundleLimitsProfile } from './limits'
import {
  decodeStructDocument,
  encodeStructDocument,
  type StructDocument,
  type StructDocumentJson,
} from '../document/index'
import { bytesToBase64 } from '../document/codec/bytes'
import { sha256HexSync } from '../sha256'

/** Strict in-memory document input accepted by {@link createStructBundle}. */
export type StructBundleCreateInput = Readonly<{
  document: StructDocument | StructDocumentJson
}>

/** Wire-only options. There is deliberately no profile override. */
export type StructBundleDecodeOptions = Readonly<{
  expectedBundleSha256?: string
}>

/**
 * Embedded value/create options. The profile version can be named for future
 * compatibility but cannot be enlarged or replaced.
 */
export type StructBundleEmbeddedOptions = Readonly<{
  limitsProfile?: typeof STRUCT_BUNDLE_LIMITS_PROFILE_VERSION
}>

type Failure = Extract<EmbeddedAcceptanceResult, { ok: false }>
type FailureError = Failure['error']

const canonicalDecoder = new TextDecoder('utf-8', { fatal: true })

function failure(error: FailureError): Failure {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

function canonicalFailure(error: unknown): Failure {
  if (error instanceof BundleValueLimitError)
    return failure({ stage: 'canonical', code: error.code })
  if (error instanceof CanonicalJsonError)
    return failure({ stage: 'canonical', code: error.code })
  return failure({ stage: 'canonical', code: 'TYPE' })
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected a plain object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('expected a plain object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('unexpected symbol')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')) throw new TypeError('unexpected accessor')
  }
  return value as Record<string, unknown>
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = plainRecord(value)
  const keys = Reflect.ownKeys(record)
  if (keys.length > allowed.length ||
    keys.some((key) => !allowed.includes(key as string)))
    throw new TypeError('unexpected field')
  return record
}

function readField(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')) throw new TypeError('unexpected accessor')
  return descriptor.value
}

function parseDecodeOptions(
  supplied: boolean,
  options: unknown,
): Readonly<{ expected?: string }> {
  if (!supplied) return Object.freeze({})
  const record = exactRecord(options, ['expectedBundleSha256'])
  if (!Object.hasOwn(record, 'expectedBundleSha256'))
    return Object.freeze({})
  const expected = readField(record, 'expectedBundleSha256')
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/u.test(expected))
    throw new TypeError('invalid digest')
  return Object.freeze({ expected })
}

function parseEmbeddedOptions(
  supplied: boolean,
  options: unknown,
): Readonly<{ profile: StructBundleLimitsProfile }> {
  if (!supplied) return Object.freeze({ profile: STRUCT_BUNDLE_LIMITS_PROFILE })
  const record = exactRecord(options, ['limitsProfile'])
  if (Object.hasOwn(record, 'limitsProfile')) {
    const profile = readField(record, 'limitsProfile')
    if (profile !== STRUCT_BUNDLE_LIMITS_PROFILE_VERSION)
      throw new TypeError('unsupported limits profile')
  }
  return Object.freeze({ profile: STRUCT_BUNDLE_LIMITS_PROFILE })
}

/**
 * Untrusted wire ingress. The caller's bytes are copied once, capped, hashed
 * before parsing when an expected digest is supplied, and value limits run
 * before the embedded verifier allocates its canonical envelope copy.
 */
export function decodeStructBundleFacade(
  raw: Uint8Array,
  options?: StructBundleDecodeOptions,
): EmbeddedAcceptanceResult {
  let expected: string | undefined
  try {
    expected = parseDecodeOptions(arguments.length > 1, options).expected
  } catch {
    return failure({ stage: 'input', code: 'OPTIONS' })
  }

  let snapshot: Uint8Array
  try {
    snapshot = snapshotCanonicalJsonInput(
      raw,
      STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes,
    )
  } catch (error) {
    return failure({
      stage: 'input',
      code: error instanceof CanonicalJsonError && error.code === 'LIMIT'
        ? 'LIMIT'
        : 'TYPE',
    })
  }

  const bundleSha256 = sha256HexSync(snapshot)
  if (expected !== undefined && expected !== bundleSha256)
    return failure({ stage: 'digest', code: 'MISMATCH' })

  try {
    const value = parseCanonicalJsonBytes(
      snapshot,
      STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes,
    )
    assertStructBundleValueLimits(value, STRUCT_BUNDLE_LIMITS_PROFILE)
  } catch (error) {
    return canonicalFailure(error)
  }

  return decodeEmbeddedBundleBytes(snapshot)
}

/**
 * Strict in-memory embedded value ingress. It accepts only JSON-safe embedded
 * values and computes the canonical envelope itself; it makes no claim about
 * prior wire bytes and exposes no expected-digest or resolver capability.
 */
export function verifyStructBundleFacade(
  value: unknown,
  options?: StructBundleEmbeddedOptions,
): EmbeddedAcceptanceResult {
  let profile: StructBundleLimitsProfile
  try {
    profile = parseEmbeddedOptions(arguments.length > 1, options).profile
  } catch {
    return failure({ stage: 'input', code: 'OPTIONS' })
  }

  try {
    assertStructBundleValueLimits(value, profile)
  } catch (error) {
    return canonicalFailure(error)
  }

  let canonical: Uint8Array
  try {
    canonical = canonicalBundleEnvelopeBytes(value)
  } catch (error) {
    return canonicalFailure(error)
  }
  if (canonical.byteLength > profile.maxRawBytes)
    return failure({ stage: 'canonical', code: 'LIMIT' })

  // The canonical bytes that become the handle are the only authority for the
  // published profile. A caller-supplied proxy can present a different view to
  // each traversal, so the profile is re-checked against a private snapshot of
  // exactly those bytes instead of trusting the caller's live object.
  try {
    assertStructBundleValueLimits(
      JSON.parse(canonicalDecoder.decode(canonical)),
      profile,
    )
  } catch (error) {
    return canonicalFailure(error)
  }

  return decodeEmbeddedBundleBytes(canonical)
}

/**
 * Build an embedded bundle from a runtime or JSON document. Asset bytes are
 * copied by the document decoder, digest-checked here, and never written into
 * the byte-free document projection.
 */
export function createStructBundleFacade(
  input: StructBundleCreateInput,
  options?: StructBundleEmbeddedOptions,
): EmbeddedAcceptanceResult {
  let profile: StructBundleLimitsProfile
  try {
    profile = parseEmbeddedOptions(arguments.length > 1, options).profile
  } catch {
    return failure({ stage: 'input', code: 'OPTIONS' })
  }

  let documentInput: unknown
  try {
    const record = exactRecord(input, ['document'])
    documentInput = readField(record, 'document')
  } catch {
    return failure({ stage: 'input', code: 'TYPE' })
  }

  let document: StructDocument
  try {
    document = decodeStructDocument(documentInput) as StructDocument
  } catch {
    return failure({ stage: 'input', code: 'TYPE' })
  }

  if (document.assets.length > profile.maxAssets)
    return failure({ stage: 'assets', code: 'LIMIT' })

  type AssetRecord = Readonly<{
    id: string
    sha256: string
    mediaType: string
    byteLength: number
    payload: Readonly<{ kind: 'embedded'; base64: string }>
  }>
  let projection: Record<string, unknown>
  let documentSha256: string
  let assets: AssetRecord[]
  try {
    const encoded = encodeStructDocument(document) as StructDocumentJson
    projection = {
      ...encoded,
      assets: encoded.assets.map(({ bytes: _bytes, ...asset }) => asset),
    }
    documentSha256 = sha256HexSync(canonicalBundleDocumentBytes(projection))

    let total = 0
    const records: AssetRecord[] = []
    for (const asset of document.assets) {
      const bytes = asset.bytes
      if (!(bytes instanceof Uint8Array))
        return failure({ stage: 'assets', code: 'SET' })
      if (bytes.byteLength > profile.maxAssetBytes ||
        bytes.byteLength > profile.maxDecodedBytes - total)
        return failure({ stage: 'assets', code: 'LIMIT' })
      total += bytes.byteLength
      if (total > Math.min(profile.maxTotalBytes, profile.maxDecodedBytes))
        return failure({ stage: 'assets', code: 'LIMIT' })
      if (sha256HexSync(bytes) !== asset.sha256)
        return failure({ stage: 'assets', code: 'DIGEST' })
      const base64 = bytesToBase64(bytes)
      if (base64.length > profile.maxBase64Chars)
        return failure({ stage: 'assets', code: 'LIMIT' })
      records.push(Object.freeze({
        id: asset.id,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        byteLength: bytes.byteLength,
        payload: Object.freeze({ kind: 'embedded', base64 }),
      }))
    }
    assets = records
  } catch (error) {
    return canonicalFailure(error)
  }

  const envelope = {
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256,
    document: projection,
    assets,
    receipt: document.receipt,
  }

  let canonical: Uint8Array
  try {
    assertStructBundleValueLimits(envelope, profile)
    canonical = canonicalBundleEnvelopeBytes(envelope)
  } catch (error) {
    return canonicalFailure(error)
  }
  if (canonical.byteLength > profile.maxRawBytes)
    return failure({ stage: 'canonical', code: 'LIMIT' })

  return decodeEmbeddedBundleBytes(canonical)
}
