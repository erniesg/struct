/**
 * Public Bundle surface. This module exposes the verified embedded-bundle
 * boundary only. External asset resolution is not part of this version: an
 * envelope carrying an external payload fails closed with `UNRESOLVED`.
 *
 * The facade follows the approved ADR-0001 minimum stable contract:
 * `createStructBundle` and `verifyStructBundle` return a genuine handle or
 * throw `StructBundleError`; `decodeStructBundle` always returns a promise of
 * a genuine handle and rejects with `StructBundleError`; `encodeStructBundle`
 * returns canonical bytes and throws `StructBundleError` for a forged handle.
 *
 * A verified handle proves integrity and conservation of the bytes/value it was
 * created from; it is not a signature and proves nothing about producer
 * authenticity.
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
import { encodeVerifiedEmbeddedBundle } from './embedded'
import type { VerifiedEmbeddedBundle } from './embedded'
import {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
} from './limits'
import type { StructBundleLimitsProfile } from './limits'
import { StructBundleError } from './error'
import type {
  StructBundleErrorCode,
  StructBundleErrorStage,
} from './error'

export {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
  StructBundleError,
}
export type {
  StructBundleErrorCode,
  StructBundleErrorStage,
  StructBundleLimitsProfile,
}
export type {
  StructBundleCreateInput,
  StructBundleDecodeOptions,
  StructBundleEmbeddedOptions,
}

/** Verified bundle handle: integrity and conservation, never authenticity. */
export type VerifiedStructBundle = VerifiedEmbeddedBundle

/**
 * Creates an embedded bundle from a runtime or JSON document. Asset bytes must
 * be present on the document and match their declared SHA-256; the document's
 * serialized projection never contains them. External payloads cannot be
 * requested through this API.
 *
 * @throws {StructBundleError} with a static stage and code.
 */
export function createStructBundle(
  input: StructBundleCreateInput,
  options?: StructBundleEmbeddedOptions,
): VerifiedStructBundle {
  const result = arguments.length > 1
    ? createStructBundleFacade(input, options)
    : createStructBundleFacade(input)
  if (!result.ok) throw new StructBundleError(result.error.stage, result.error.code)
  return result.bundle
}

/**
 * Untrusted wire ingress. It applies the raw cap and optional expected
 * `bundleSha256` before parsing, proves canonical input, and always resolves
 * to a genuine handle.
 *
 * @throws {StructBundleError} as a promise rejection, never synchronously.
 */
export async function decodeStructBundle(
  raw: Uint8Array,
  options?: StructBundleDecodeOptions,
): Promise<VerifiedStructBundle> {
  const result = arguments.length > 1
    ? decodeStructBundleFacade(raw, options)
    : decodeStructBundleFacade(raw)
  if (!result.ok) throw new StructBundleError(result.error.stage, result.error.code)
  return result.bundle
}

/**
 * Embedded-only in-memory value verifier. It accepts strict JSON values with
 * embedded base64 payloads, computes canonical bytes itself, and exposes no
 * expected-raw-digest, resolver, or executor option. It makes no claim about
 * prior wire bytes.
 *
 * @throws {StructBundleError} with a static stage and code.
 */
export function verifyStructBundle(
  value: unknown,
  options?: StructBundleEmbeddedOptions,
): VerifiedStructBundle {
  const result = arguments.length > 1
    ? verifyStructBundleFacade(value, options)
    : verifyStructBundleFacade(value)
  if (!result.ok) throw new StructBundleError(result.error.stage, result.error.code)
  return result.bundle
}

/**
 * Encodes only a genuine package-created handle. Forged handles fail closed.
 *
 * @throws {StructBundleError} with stage `handle` and code `FORGED`.
 */
export function encodeStructBundle(handle: unknown): Uint8Array {
  const result = encodeVerifiedEmbeddedBundle(handle)
  if (!result.ok) throw new StructBundleError(result.error.stage, result.error.code)
  return result.bytes
}
