/**
 * Public Bundle surface. External asset resolution is published through the
 * private external core: `decodeStructBundle` is the one public decode seam
 * and it delegates directly to `decodeExternalBundleBytes`, while embedded-only
 * bundles keep their prior observable behavior.
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
  verifyStructBundleFacade,
} from './facade'
import type {
  StructBundleCreateInput,
  StructBundleDecodeOptions,
  StructBundleEmbeddedOptions,
} from './facade'
import { decodeExternalBundleBytes } from './external'
import type { VerifiedExternalBundle } from './external'
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
import type { StructResolverExecutorV1 } from './resolver-protocol'
import type { StructAssetResolutionPolicyV1 } from './resolver-policy'
import type { StructResolverHostSupervisorV1 } from './resolver-protocol'
import type {
  StructResolverBudgetInput,
  StructResolverDerivedBudgetPlan,
} from './resolver-protocol'

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
export type {
  StructResolverExecutorV1,
  StructAssetResolutionPolicyV1,
  StructResolverHostSupervisorV1,
  /**
   * The caller-facing resolver budget: exactly `totalTimeoutMs` and
   * `cleanupReserveMs`. This is the value a caller passes as
   * `resolverBudget`, and it is the only budget shape the runtime accepts.
   */
  StructResolverBudgetInput,
  /**
   * The internal derived budget plan the package computes from
   * {@link StructResolverBudgetInput}. It is **not** the caller's budget and
   * must not be passed as `resolverBudget`; its extra `workTimeoutMs` key is
   * refused by the strict option parser.
   */
  StructResolverDerivedBudgetPlan,
}

/** Verified bundle handle: integrity and conservation, never authenticity. */
export type VerifiedStructBundle = VerifiedEmbeddedBundle & VerifiedExternalBundle

/**
 * Creates an embedded bundle from a runtime or JSON document.
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
  return result.bundle as VerifiedStructBundle
}

/**
 * Untrusted wire ingress. The one public decode seam: it delegates directly
 * to the private external core.
 *
 * @throws {StructBundleError} as a promise rejection, never synchronously.
 */
export async function decodeStructBundle(
  raw: Uint8Array,
  options?: StructBundleDecodeOptions,
): Promise<VerifiedStructBundle> {
  const result = arguments.length > 1
    ? await decodeExternalBundleBytes(raw, options)
    : await decodeExternalBundleBytes(raw)
  if (!result.ok) throw new StructBundleError(result.error.stage, result.error.code)
  return result.bundle as VerifiedStructBundle
}

/**
 * Embedded-only in-memory value verifier.
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
  return result.bundle as VerifiedStructBundle
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
