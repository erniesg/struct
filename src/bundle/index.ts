/**
 * Public Bundle surface. This module re-exports the verified embedded-bundle
 * boundary only. External asset resolution is not part of this version: an
 * envelope carrying an external payload fails closed with `UNRESOLVED`.
 *
 * Every operation returns a structured result. A verified handle proves
 * integrity and conservation of the bytes it was created from; it is not a
 * signature and proves nothing about producer authenticity.
 */
import {
  decodeEmbeddedBundleBytes,
  encodeVerifiedEmbeddedBundle,
} from './embedded'
import type {
  EmbeddedAcceptanceResult,
  EmbeddedEncodingResult,
  VerifiedEmbeddedBundle,
} from './embedded'

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
 * Untrusted wire ingress. Applies the raw cap and optional expected
 * `bundleSha256` before parsing, proves canonical input, and returns either a
 * verified handle or a structured failure.
 */
export function decodeStructBundle(
  raw: Uint8Array,
  options?: Readonly<{ expectedBundleSha256?: string }>,
): StructBundleAcceptanceResult {
  return (options === undefined
    ? decodeEmbeddedBundleBytes(raw)
    : decodeEmbeddedBundleBytes(raw, options)) as StructBundleAcceptanceResult
}

/** Encodes only a genuine package-created handle; forged handles fail closed. */
export function encodeStructBundle(handle: unknown): StructBundleEncodingResult {
  return encodeVerifiedEmbeddedBundle(handle) as StructBundleEncodingResult
}
