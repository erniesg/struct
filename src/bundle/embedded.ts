import {
  CanonicalJsonError,
  canonicalBundleDocumentBytes,
  canonicalBundleEnvelopeBytes,
  parseCanonicalJsonBytes,
  snapshotCanonicalJsonInput,
} from './canonical'
import type { ByteFreeStructDocumentJson } from './canonical'
import { EmbeddedAssetError, verifyEmbeddedAssets } from './assets'
import { sha256HexSync } from '../sha256'

// Private implementation bounds, not the future public versioned Bundle profile.
const MAX_RAW_BYTES = 8 * 1024 * 1024
const ASSET_LIMITS = Object.freeze({
  maxAssets: 256,
  maxAssetBytes: 4 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxBase64Chars: 5_592_408,
})

type Failure = Readonly<{
  ok: false
  error:
    | Readonly<{ stage: 'input'; code: 'OPTIONS' | 'TYPE' | 'LIMIT' }>
    | Readonly<{ stage: 'digest'; code: 'MISMATCH' }>
    | Readonly<{ stage: 'canonical'; code: CanonicalJsonError['code'] }>
    | Readonly<{ stage: 'assets'; code: EmbeddedAssetError['code'] }>
    | Readonly<{ stage: 'handle'; code: 'FORGED' }>
}>

/** Private acceptance handle: integrity/conservation only, not authenticity. */
export type VerifiedEmbeddedBundle = Readonly<{
  bundleVersion: '1.0.0'
  schemaVersion: string
  documentSha256: string
  bundleSha256: string
  documentSnapshot(): ByteFreeStructDocumentJson
  assetIds(): readonly string[]
  assetBytes(id: string): Uint8Array | undefined
}>
export type EmbeddedAcceptanceResult =
  | Readonly<{ ok: true; bundle: VerifiedEmbeddedBundle }>
  | Failure
export type EmbeddedEncodingResult =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Failure

const retained = new WeakMap<VerifiedEmbeddedBundle, Uint8Array>()
const decoder = new TextDecoder()

function failure(error: Failure['error']): Failure {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

function expectedDigest(options: unknown): string | undefined {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new Error('options')
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('options')
  const keys = Reflect.ownKeys(options)
  if (keys.length === 0) return undefined
  if (keys.length !== 1 || keys[0] !== 'expectedBundleSha256') throw new Error('options')
  const descriptor = Object.getOwnPropertyDescriptor(options, 'expectedBundleSha256')
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable ||
    typeof descriptor.value !== 'string' || !/^[0-9a-f]{64}$/u.test(descriptor.value))
    throw new Error('options')
  return descriptor.value
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Private factory for creating a genuine verified bundle handle.
 *
 * Both the embedded decoder and the external-bytes decoder use this factory so
 * that encoder provenance is shared through the same WeakMap. The handle keeps
 * two independent byte copies:
 *
 * - `documentBytes`: the canonical byte-free document projection used for
 *   `documentSnapshot()`. Every call returns a fresh frozen JSON copy.
 * - `wireBytes`: the ORIGINAL canonical wire envelope used for `encode`.
 *   External decoding passes the original external wire, not a synthetic
 *   embedded envelope.
 * - `assetBytes`: copied on creation; `assetBytes(id)` returns a fresh copy on
 *   every call, including for caller-supplied Map inputs.
 *
 * The factory must only be called after all validation and, for external
 * bundles, after every asset has been resolved and joined.
 */
export function createVerifiedBundleHandle(
  bundleVersion: '1.0.0',
  schemaVersion: string,
  documentSha256: string,
  bundleSha256: string,
  documentBytes: Uint8Array,
  wireBytes: Uint8Array,
  assetBytes: Map<string, Uint8Array>,
): VerifiedEmbeddedBundle {
  const copiedAssets = new Map<string, Uint8Array>()
  for (const [id, bytes] of assetBytes) copiedAssets.set(id, bytes.slice())
  const sortedIds = (): string[] => [...copiedAssets.keys()].sort((left, right) => {
    const a = Array.from(left)
    const b = Array.from(right)
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!
      if (difference !== 0) return difference
    }
    return a.length - b.length
  })

  const bundle: VerifiedEmbeddedBundle = Object.freeze({
    bundleVersion,
    schemaVersion,
    documentSha256,
    bundleSha256,
    documentSnapshot: () => freezeJson(JSON.parse(decoder.decode(documentBytes)) as ByteFreeStructDocumentJson),
    assetIds: () => Object.freeze(sortedIds()),
    assetBytes: (id: string) => copiedAssets.get(id)?.slice(),
  })
  retained.set(bundle, wireBytes.slice())
  return bundle
}

/** Embedded wire ingress only; no external resolver or value-verifier capability. */
export function decodeEmbeddedBundleBytes(
  raw: Uint8Array,
  options?: Readonly<{ expectedBundleSha256?: string }>,
): EmbeddedAcceptanceResult {
  let expected: string | undefined
  try {
    expected = arguments.length > 1 ? expectedDigest(options) : undefined
  } catch {
    return failure({ stage: 'input', code: 'OPTIONS' })
  }
  let snapshot: Uint8Array
  try {
    snapshot = snapshotCanonicalJsonInput(raw, MAX_RAW_BYTES)
  } catch (error) {
    return failure({ stage: 'input', code: error instanceof CanonicalJsonError &&
      error.code === 'LIMIT' ? 'LIMIT' : 'TYPE' })
  }
  const bundleSha256 = sha256HexSync(snapshot)
  if (expected !== undefined && expected !== bundleSha256)
    return failure({ stage: 'digest', code: 'MISMATCH' })

  let envelope: {
    bundleVersion: '1.0.0'
    schemaVersion: string
    documentSha256: string
    document: ByteFreeStructDocumentJson
    assets: unknown
  }
  let documentBytes: Uint8Array
  try {
    const value = parseCanonicalJsonBytes(snapshot, MAX_RAW_BYTES)
    const canonical = canonicalBundleEnvelopeBytes(value)
    if (canonical.length !== snapshot.length ||
      canonical.some((byte, index) => byte !== snapshot[index]))
      throw new CanonicalJsonError('NONCANONICAL')
    // Existing complete shape/version/document checks ran above on parsed JSON.
    envelope = value as typeof envelope
    documentBytes = canonicalBundleDocumentBytes(envelope.document)
  } catch (error) {
    return failure({ stage: 'canonical', code: error instanceof CanonicalJsonError
      ? error.code : 'TYPE' })
  }

  try {
    const assets = verifyEmbeddedAssets(envelope.document.assets, envelope.assets, ASSET_LIMITS)
    const assetBytesMap = new Map<string, Uint8Array>()
    for (const id of assets.assetIds()) {
      const bytes = assets.assetBytes(id)
      if (bytes) assetBytesMap.set(id, bytes)
    }
    const bundle = createVerifiedBundleHandle(
      envelope.bundleVersion,
      envelope.schemaVersion,
      envelope.documentSha256,
      bundleSha256,
      documentBytes,
      snapshot,
      assetBytesMap,
    )
    return Object.freeze({ ok: true, bundle })
  } catch (error) {
    return failure({ stage: 'assets', code: error instanceof EmbeddedAssetError
      ? error.code : 'SHAPE' })
  }
}

/** WeakMap membership, not a caller-controlled shape or prototype, admits encode. */
export function encodeVerifiedEmbeddedBundle(handle: unknown): EmbeddedEncodingResult {
  if (handle === null || typeof handle !== 'object')
    return failure({ stage: 'handle', code: 'FORGED' })
  const bytes = retained.get(handle as VerifiedEmbeddedBundle)
  return bytes === undefined
    ? failure({ stage: 'handle', code: 'FORGED' })
    : Object.freeze({ ok: true, bytes: bytes.slice() })
}
