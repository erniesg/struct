/**
 * Public structured failure for every Bundle acceptance operation.
 *
 * The error retains only static facts: the failing stage, the failing code
 * from the fixed taxonomy, and a static message. No caller-supplied value,
 * path, identifier, byte, or digest is ever retained or echoed, so a rejected
 * hostile input cannot leak through the error object.
 */

/** Failing stage of a rejected Bundle operation. */
export type StructBundleErrorStage =
  | 'input'
  | 'digest'
  | 'canonical'
  | 'assets'
  | 'handle'
  | 'resolve'
  | 'budget'

/** Fixed failure codes. Every code is package-owned and input-independent. */
export type StructBundleErrorCode =
  | 'OPTIONS'
  | 'TYPE'
  | 'LIMIT'
  | 'MISMATCH'
  | 'SYNTAX'
  | 'NONCANONICAL'
  | 'SHAPE'
  | 'SET'
  | 'METADATA'
  | 'BASE64'
  | 'DIGEST'
  | 'UNRESOLVED'
  | 'FORGED'
  | 'BUDGET'
  | 'POLICY'
  | 'TARGET'
  | 'ALLOCATE'
  | 'START'
  | 'RESULT'
  | 'RECEIPT'
  | 'STREAM'
  | 'LENGTH'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'REVOCATION'
  | 'CLEANUP'
  | 'TERMINAL'
  | 'FAIL_STOP'

const STAGE_MESSAGES: Readonly<Record<StructBundleErrorStage, string>> =
  Object.freeze({
    input: 'struct bundle input rejected',
    digest: 'struct bundle digest mismatch',
    canonical: 'struct bundle canonical form rejected',
    assets: 'struct bundle assets rejected',
    handle: 'struct bundle handle rejected',
    resolve: 'struct bundle resolution rejected',
    budget: 'struct bundle budget rejected',
  })

/** Static message for a failing stage. */
export function structBundleErrorMessage(
  stage: StructBundleErrorStage,
): string {
  return STAGE_MESSAGES[stage]
}

/** The single public error type thrown or rejected by the Bundle facade. */
export class StructBundleError extends Error {
  readonly stage: StructBundleErrorStage
  readonly code: StructBundleErrorCode

  constructor(stage: StructBundleErrorStage, code: StructBundleErrorCode) {
    super(STAGE_MESSAGES[stage])
    this.name = 'StructBundleError'
    this.stage = stage
    this.code = code
    Object.freeze(this)
  }
}
