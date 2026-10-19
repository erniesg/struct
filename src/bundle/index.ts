/**
 * Public Bundle surface. This module re-exports the verified embedded-bundle
 * boundary only. External asset resolution is not part of this version: an
 * envelope carrying an external payload fails closed with `UNRESOLVED`.
 *
 * Every operation returns a structured result. A verified handle proves
 * integrity and conservation of the bytes it was created from; it is not a
 * signature and proves nothing about producer authenticity.
 */
export {
  decodeStructBundle,
  encodeStructBundle,
  type StructBundleAcceptanceResult,
  type StructBundleEncodingResult,
  type StructBundleFailure,
  type VerifiedStructBundle,
} from './embedded'
