/**
 * Public Bundle surface. This module exposes the verified embedded-bundle
 * boundary only. External asset resolution is not part of this version: an
 * envelope carrying an external payload fails closed with `UNRESOLVED`.
 *
 * Every operation returns a structured result. A verified handle proves
 * integrity and conservation of the bytes/value it was created from; it is not
 * a signature and proves nothing about producer authenticity.
 */
import {
  createStructBundleFacade,
  decodeStructBundleFacade,
  verifyStructBundleFacade,
} from './facade'
import type {
  StructBundleCreateInput,
  StructBundleDecodeOptions,
  StructBundleEmbeddedOptions,
} from './facade'
import {
  encodeVerifiedEmbeddedBundle,
} from './embedded'
import type {
  EmbeddedAcceptanceResult,
  EmbeddedEncodingResult,
  VerifiedEmbeddedBundle,
} from './embedded'
import {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
} from './limits'
import type { StructBundleLimitsProfile } from './limits'

export {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
}
export type { StructBundleLimitsProfile }
export type {
  StructBundleCreateInput,
  StructBundleDecodeOptions,
  StructBundleEmbeddedOptions,
}

/** Verified bundle handle: integrity and conservation, never authenticity. */
export type VerifiedStructBundle = VerifiedEmbeddedBundle

/** Structured failure for every public bundle operation. */
export type StructBundleFailure = Extract<EmbeddedAcceptanceResult, { ok: false }>['error']

export type StructBundleAcceptanceResult =
  | Readonly<{ ok: true; bundle: VerifiedStructBundle }>
  | Readonly<{ ok: false; error: StructBundleFailure }>

export type StructBundleEncodingResult =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; error: StructBundleFailure }>

/**
 * Creates an embedded bundle from a runtime or JSON document. Asset bytes must
 * be present on the document and match their declared SHA-256; the document's
 * serialized projection never contains them. External payloads cannot be
 * requested through this API.
 */
export function createStructBundle(
  input: StructBundleCreateInput,
  options?: StructBundleEmbeddedOptions,
): StructBundleAcceptanceResult {
  return (arguments.length > 1
    ? createStructBundleFacade(input, options)
    : createStructBundleFacade(input)) as StructBundleAcceptanceResult
}

/**
 * Untrusted wire ingress. Applies the raw cap and optional expected
 * `bundleSha256` before parsing, proves canonical input, and returns either a
 * verified handle or a structured failure.
 */
export function decodeStructBundle(
  raw: Uint8Array,
  options?: StructBundleDecodeOptions,
): StructBundleAcceptanceResult {
  return (arguments.length > 1
    ? decodeStructBundleFacade(raw, options)
    : decodeStructBundleFacade(raw)) as StructBundleAcceptanceResult
}

/**
 * Embedded-only in-memory value verifier. It accepts strict JSON values with
 * embedded base64 payloads, computes canonical bytes itself, and exposes no
 * expected-raw-digest, resolver, or executor option.
 */
export function verifyStructBundle(
  value: unknown,
  options?: StructBundleEmbeddedOptions,
): StructBundleAcceptanceResult {
  return (arguments.length > 1
    ? verifyStructBundleFacade(value, options)
    : verifyStructBundleFacade(value)) as StructBundleAcceptanceResult
}

/** Encodes only a genuine package-created handle; forged handles fail closed. */
export function encodeStructBundle(handle: unknown): StructBundleEncodingResult {
  return encodeVerifiedEmbeddedBundle(handle) as StructBundleEncodingResult
}
