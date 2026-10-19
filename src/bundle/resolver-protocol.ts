/**
 * Frozen resolver protocol for the isolated external-asset executor.
 *
 * The declarations below are copied from the governing ADR-0001 bundle
 * contract. They are the complete interface a consumer executor has to
 * satisfy; the package never widens them. Exactly one additive port exists:
 * `StructResolverHostSupervisorV1`, the parent-owned fail-stop channel the
 * package needs when teardown evidence is missing, mismatched, swapped, or
 * never settles.
 *
 * This module is inert. It performs no I/O, opens no capability, and never
 * accepts a transport locator. Every guard is total, side-effect free, and
 * returns a frozen snapshot that cannot alias caller memory.
 */
import { validateResolverPolicyV1 } from './resolver-policy'
import type { StructAssetResolutionPolicyV1 } from './resolver-policy'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from './limits'

export type { StructAssetResolutionPolicyV1 } from './resolver-policy'

/** Protocol version carried by requests, results, and the fail-stop port. */
export const STRUCT_RESOLVER_PROTOCOL_VERSION = '1.0.0' as const

/** Maximum code units in an opaque execution identifier. */
export const STRUCT_RESOLVER_EXECUTION_ID_MAX = 256 as const

/** Maximum code units in a logical bundle-relative asset href. */
export const STRUCT_RESOLVER_LOGICAL_HREF_MAX = 1024 as const

/**
 * One external asset resolution request.
 *
 * `logicalHref` and `resourceId` are separate and cannot substitute for one
 * another. The href is a logical EPUB-relative path; the resource id is the
 * only external-resolution reference and carries no URL, path, storage key, or
 * credential.
 */
export type StructAssetResolutionRequest = Readonly<{
  protocolVersion: '1.0.0'
  logicalHref: string
  resourceId: `sha256:${string}`
  expected: Readonly<{
    id: string
    sha256: string
    mediaType: string
    byteLength: number
  }>
  policy: StructAssetResolutionPolicyV1
  expectedPolicySha256: string
  budget: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  signal: AbortSignal
}>

/**
 * One external asset resolution result.
 *
 * The chunk stream is the only byte carrier. The transport receipt echoes
 * non-secret identifiers only; it must never contain a URL, path, storage key,
 * header, credential, matrix parameter, or percent-encoded alias.
 */
export type StructAssetResolutionResult = Readonly<{
  protocolVersion: '1.0.0'
  resourceId: `sha256:${string}`
  chunks: AsyncIterable<Uint8Array>
  transportReceipt:
    | Readonly<{
        kind: 'https'
        policySha256: string
        endpointMapId: string
        endpointId: string
        redirectEndpointIds: readonly string[]
      }>
    | Readonly<{
        kind: 'filesystem'
        policySha256: string
        rootCapabilityId: string
      }>
    | Readonly<{
        kind: 'content-addressed'
        policySha256: string
        storeId: string
      }>
  declaredByteLength?: number
}>

/**
 * Accepted revocation receipt.
 *
 * Both literals are pinned: a receipt that reports `quarantined: false`, that
 * is missing a literal, that carries a foreign execution id, or that is not
 * an own-data object is a revocation failure.
 */
export type StructResolverRevocationReceipt = Readonly<{
  executionId: string
  capabilitiesRevoked: true
  quarantined: true
}>

/**
 * Terminal receipt for a joined execution. `completed` is the success state
 * and `terminated` the teardown state; both bind the exact reserved id.
 */
export type StructResolverTerminalReceipt = Readonly<{
  executionId: string
  state: 'terminated' | 'completed'
}>

/**
 * Supervisor control surface returned before the start right is consumed.
 *
 * Revocation is synchronous by contract so that a caller can close future
 * grants and descendant admission before the receipt is observed. Cleanup is
 * idempotent and available before start. Termination and join are controlled
 * by the isolated host supervisor, not by adapter code.
 */
export interface StructResolverExecutionControl {
  /** Collision-resistant, supervisor-generated, never reused in this lifetime. */
  readonly executionId: string
  /** Synchronously invalidates brokered credential, filesystem, and egress authority. */
  revokeAndQuarantine(): StructResolverRevocationReceipt
  /** Idempotent supervisor cleanup, available before start and after failure. */
  cleanup(): Promise<void>
  /** Controlled by the isolated worker/process supervisor, not adapter code. */
  terminateAndJoin(): Promise<StructResolverTerminalReceipt>
}

/**
 * One-shot handle. `start` is the sole authority-granting step and is called
 * only after the caller holds `control`.
 */
export type StructResolverExecutionHandle = Readonly<{
  control: StructResolverExecutionControl
  start(): Promise<StructAssetResolutionResult>
}>

/**
 * Consumer-owned isolated executor port.
 *
 * Allocation is side-effect free with respect to adapter and transport
 * authority: it reserves a lifetime-unique execution id, returns supervisor
 * control, and grants nothing. The start right is consumed atomically inside
 * `start`.
 */
export interface StructResolverExecutorV1 {
  allocate(request: StructAssetResolutionRequest): StructResolverExecutionHandle
}

/**
 * Reason a verification host was forced to fail-stop.
 *
 * The reasons are additive and versioned. A reason outside this set is a
 * protocol failure, not a silent downgrade.
 */
export type StructResolverFailStopReason =
  | 'REVOCATION_RECEIPT'
  | 'REVOCATION_THROW'
  | 'TERMINAL_RECEIPT'
  | 'TERMINAL_TIMEOUT'
  | 'CLEANUP_TIMEOUT'
  | 'EXECUTION_ID_AMBIGUITY'

/**
 * Parent-attested fail-stop evidence.
 *
 * The receipt is consistency evidence about the verification host, not
 * cryptographic proof and not producer authenticity. Only the parent process
 * supervisor can actually prove the host and its descendants are dead.
 */
export type StructResolverFailStopReceipt = Readonly<{
  protocolVersion: '1.0.0'
  executionId: string
  hostTerminated: true
  descendantsDead: true
  capacityRetired: true
  evidence: Readonly<{
    hostReaped: true
    descendantCount: 0
    waitedMs: number
    method: 'process-group' | 'cgroup' | 'pid-namespace'
  }>
}>

/**
 * Additive parent-owned fail-stop port.
 *
 * The package cannot kill its own host, so the caller supplies this port.
 * It is idempotent, lives outside the adapter realm, and is mandatory
 * whenever an external asset is resolved: a missing, throwing, or invalid
 * fail-stop makes the whole resolution fail closed instead of reporting
 * normal structured completion.
 */
export interface StructResolverHostSupervisorV1 {
  readonly protocolVersion: '1.0.0'
  failStop(
    executionId: string,
    reason: StructResolverFailStopReason,
  ): Promise<StructResolverFailStopReceipt>
}

/** Structured protocol failure codes. No locator or secret is ever carried. */
export type StructResolverProtocolErrorCode =
  | 'SHAPE'
  | 'REQUEST'
  | 'RESULT'
  | 'REVOCATION'
  | 'TERMINAL'
  | 'FAIL_STOP'
  | 'EXECUTION_ID'
  | 'BUDGET'
  | 'POLICY'

/** Total, side-effect-free protocol failure. */
export class StructResolverProtocolError extends Error {
  constructor(
    readonly code: StructResolverProtocolErrorCode,
    readonly executionId?: string,
  ) {
    super(`resolver protocol error: ${code.toLowerCase()}`)
    this.name = 'StructResolverProtocolError'
  }
}

const DIGEST = /^[0-9a-f]{64}$/u

/**
 * The shared policy identifier grammar.
 *
 * It is exactly the grammar the strict policy projection applies to profile,
 * endpoint map, endpoint, root capability, and store identifiers:
 * case-sensitive ASCII, no Unicode, no percent decoding, no case folding,
 * and no other normalization. A URL, a path, a percent escape, a matrix
 * parameter, a query, and a fragment are all outside it.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/**
 * Validates one opaque identifier against the shared grammar.
 *
 * The value is an identifier, never a locator: it carries no URL, path,
 * storage key, credential, or alias.
 */
function identifier(
  value: unknown,
  code: StructResolverProtocolErrorCode = 'REQUEST',
): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    throw new StructResolverProtocolError(code)
  return value
}

/**
 * Reads own data properties only.
 *
 * Accessors, symbols, foreign prototypes, unknown keys, and missing required
 * keys are rejected. The result is a frozen snapshot of the own data
 * properties: the caller's object is never retained or aliased, and no
 * accessor or proxy getter is ever invoked.
 *
 * A foreign prototype trap, a revoked proxy, or a throwing descriptor trap
 * is reported as a static `SHAPE` protocol error. The foreign message and
 * the foreign error are never carried into the package error.
 */
export function readStructResolverFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Readonly<Record<string, unknown>> {
  let keys: (string | symbol)[]
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new StructResolverProtocolError('SHAPE')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new StructResolverProtocolError('SHAPE')
    keys = Reflect.ownKeys(value)
  } catch (error) {
    if (error instanceof StructResolverProtocolError) throw error
    throw new StructResolverProtocolError('SHAPE')
  }
  const allowedSet = new Set(allowed)
  const snapshot: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof key !== 'string') throw new StructResolverProtocolError('SHAPE')
    if (!allowedSet.has(key)) throw new StructResolverProtocolError('SHAPE')
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new StructResolverProtocolError('SHAPE')
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new StructResolverProtocolError('SHAPE')
    snapshot[key] = descriptor.value
  }
  for (const key of required)
    if (!Object.hasOwn(snapshot, key)) throw new StructResolverProtocolError('SHAPE')
  return Object.freeze(snapshot)
}

/**
 * An execution identifier is opaque, bounded, and free of path or URL
 * meaning. Printable ASCII only, no whitespace, no separator characters.
 */
export function isStructResolverExecutionId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > STRUCT_RESOLVER_EXECUTION_ID_MAX)
    return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
    if (code === 0x2f || code === 0x5c) return false
  }
  return true
}

/** Narrows an execution identifier or fails closed. */
export function assertStructResolverExecutionId(value: unknown): string {
  if (!isStructResolverExecutionId(value))
    throw new StructResolverProtocolError('EXECUTION_ID')
  return value
}

/**
 * A logical bundle href is a relative EPUB-relative path. It is never a
 * URL, filesystem locator, storage key, or percent-encoded alias.
 */
export function isStructResolverLogicalHref(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > STRUCT_RESOLVER_LOGICAL_HREF_MAX)
    return false
  if (value.includes(':') || value.includes('//') || value.includes('\\'))
    return false
  if (value.startsWith('/')) return false
  if (value.includes('%') || value.includes('?') || value.includes('#'))
    return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  const segments = value.split('/')
  return segments.every((segment) => segment !== '.' && segment !== '..')
}

function isAbortSignalLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { aborted?: unknown; addEventListener?: unknown }
  return typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function'
}

function isThenable(value: unknown): boolean {
  return value !== null && typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
}

function digest(
  value: unknown,
  code: StructResolverProtocolErrorCode = 'REQUEST',
): string {
  if (typeof value !== 'string' || !DIGEST.test(value))
    throw new StructResolverProtocolError(code)
  return value
}

function boundedText(
  value: unknown,
  maximum: number,
  code: StructResolverProtocolErrorCode = 'REQUEST',
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    throw new StructResolverProtocolError(code)
  return value
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new StructResolverProtocolError('REQUEST')
  return value
}

/**
 * Validates a budget pair and returns the derived work/cleanup split.
 *
 * The total budget bounds one execution. The cleanup reserve is withheld
 * from the work phase so that teardown always has time inside the total
 * budget. A reserve that is zero, negative, or not smaller than the total is
 * rejected before any allocation.
 *
 * The budget is mandatory and explicit: there is no implicit default. The
 * total is also bounded by the single frozen limits profile, so a caller
 * cannot enlarge the resolver budget past the published cap.
 */
export type StructResolverBudgetPlan = Readonly<{
  totalTimeoutMs: number
  cleanupReserveMs: number
  workTimeoutMs: number
}>

/** Validates a budget pair and returns the derived work/cleanup split. */
export function planStructResolverBudget(
  budget: unknown,
): StructResolverBudgetPlan {
  const fields = readStructResolverFields(budget, ['totalTimeoutMs', 'cleanupReserveMs'])
  const totalTimeoutMs = fields.totalTimeoutMs
  const cleanupReserveMs = fields.cleanupReserveMs
  if (typeof totalTimeoutMs !== 'number' || !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < 1)
    throw new StructResolverProtocolError('BUDGET')
  if (typeof cleanupReserveMs !== 'number' || !Number.isSafeInteger(cleanupReserveMs) ||
    cleanupReserveMs < 1 || cleanupReserveMs >= totalTimeoutMs)
    throw new StructResolverProtocolError('BUDGET')
  if (totalTimeoutMs > STRUCT_BUNDLE_LIMITS_PROFILE.maxResolverTimeoutMs)
    throw new StructResolverProtocolError('BUDGET')
  return Object.freeze({
    totalTimeoutMs,
    cleanupReserveMs,
    workTimeoutMs: totalTimeoutMs - cleanupReserveMs,
  })
}

/**
 * Validates one resolution request and returns a frozen snapshot.
 *
 * The policy is re-projected and re-hashed here, and the request digest must
 * equal that hash, so a caller can never pair a policy with a foreign
 * digest. The returned policy is the canonical frozen projection.
 */
export function validateStructResolverRequest(
  value: unknown,
): StructAssetResolutionRequest {
  const fields = readStructResolverFields(value, [
    'protocolVersion', 'logicalHref', 'resourceId', 'expected',
    'policy', 'expectedPolicySha256', 'budget', 'signal',
  ])
  if (fields.protocolVersion !== '1.0.0')
    throw new StructResolverProtocolError('REQUEST')
  if (!isStructResolverLogicalHref(fields.logicalHref))
    throw new StructResolverProtocolError('REQUEST')
  const expectedFields = readStructResolverFields(fields.expected, [
    'id', 'sha256', 'mediaType', 'byteLength',
  ])
  const assetDigest = digest(expectedFields.sha256)
  if (fields.resourceId !== `sha256:${assetDigest}`)
    throw new StructResolverProtocolError('REQUEST')

  let policyDigest: string
  let policy: StructAssetResolutionPolicyV1
  try {
    const validated = validateResolverPolicyV1(fields.policy)
    policyDigest = validated.policySha256
    policy = validated.policySnapshot()
  } catch {
    // A foreign policy object, a proxy trap, or a malformed projection is a
    // static policy failure. The foreign message and cause are not carried.
    throw new StructResolverProtocolError('POLICY')
  }
  if (fields.expectedPolicySha256 !== policyDigest)
    throw new StructResolverProtocolError('POLICY')

  const plan = planStructResolverBudget(fields.budget)
  if (!isAbortSignalLike(fields.signal))
    throw new StructResolverProtocolError('REQUEST')

  return Object.freeze({
    protocolVersion: '1.0.0',
    logicalHref: fields.logicalHref,
    resourceId: `sha256:${assetDigest}` as `sha256:${string}`,
    expected: Object.freeze({
      id: boundedText(expectedFields.id, 256),
      sha256: assetDigest,
      mediaType: boundedText(expectedFields.mediaType, 256),
      byteLength: safeCount(expectedFields.byteLength),
    }),
    policy,
    expectedPolicySha256: policyDigest,
    budget: Object.freeze({
      totalTimeoutMs: plan.totalTimeoutMs,
      cleanupReserveMs: plan.cleanupReserveMs,
    }),
    signal: fields.signal as AbortSignal,
  })
}

/**
 * Strict shape of one transport receipt.
 *
 * Only non-secret identifiers are allowed, and they follow the same ASCII
 * grammar as the policy identifiers. A URL, path, storage key, header,
 * credential, matrix parameter, or percent-encoded alias is rejected here
 * because it must never reach a receipt, an error, or a log.
 *
 * The returned receipt is a fresh deep-frozen copy. The caller's object and
 * the caller's redirect array are never retained or aliased.
 */
function validateTransportReceiptShape(
  value: unknown,
): StructAssetResolutionResult['transportReceipt'] {
  const kind = readTransportKind(value)
  if (kind === 'https') {
    const fields = readStructResolverFields(value, [
      'kind', 'policySha256', 'endpointMapId', 'endpointId', 'redirectEndpointIds',
    ])
    const redirectEndpointIds = fields.redirectEndpointIds
    if (!Array.isArray(redirectEndpointIds))
      throw new StructResolverProtocolError('RESULT')
    const ids = redirectEndpointIds.map((entry) => identifier(entry, 'RESULT'))
    return Object.freeze({
      kind: 'https',
      policySha256: digest(fields.policySha256, 'RESULT'),
      endpointMapId: identifier(fields.endpointMapId, 'RESULT'),
      endpointId: identifier(fields.endpointId, 'RESULT'),
      redirectEndpointIds: Object.freeze(ids),
    })
  }
  if (kind === 'filesystem') {
    const fields = readStructResolverFields(value, [
      'kind', 'policySha256', 'rootCapabilityId',
    ])
    return Object.freeze({
      kind: 'filesystem',
      policySha256: digest(fields.policySha256, 'RESULT'),
      rootCapabilityId: identifier(fields.rootCapabilityId, 'RESULT'),
    })
  }
  if (kind === 'content-addressed') {
    const fields = readStructResolverFields(value, ['kind', 'policySha256', 'storeId'])
    return Object.freeze({
      kind: 'content-addressed',
      policySha256: digest(fields.policySha256, 'RESULT'),
      storeId: identifier(fields.storeId, 'RESULT'),
    })
  }
  throw new StructResolverProtocolError('RESULT')
}

/** Reads the transport kind without invoking a foreign getter or trap. */
function readTransportKind(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new StructResolverProtocolError('RESULT')
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  } catch {
    throw new StructResolverProtocolError('RESULT')
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value'))
    throw new StructResolverProtocolError('RESULT')
  return descriptor.value
}

/**
 * Validates the shape of one resolution result.
 *
 * Transport-receipt policy equality is not checked here; the receipt
 * projection helper owns that rule because it is the strict policy bound
 * validator.
 */
export function validateStructResolverResult(
  value: unknown,
): StructAssetResolutionResult {
  if (isThenable(value)) throw new StructResolverProtocolError('RESULT')
  const fields = readStructResolverFields(
    value,
    ['protocolVersion', 'resourceId', 'chunks', 'transportReceipt', 'declaredByteLength'],
    ['protocolVersion', 'resourceId', 'chunks', 'transportReceipt'],
  )
  if (fields.protocolVersion !== '1.0.0')
    throw new StructResolverProtocolError('RESULT')
  if (typeof fields.resourceId !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(fields.resourceId))
    throw new StructResolverProtocolError('RESULT')
  const chunks = fields.chunks
  if (chunks === null || typeof chunks !== 'object')
    throw new StructResolverProtocolError('RESULT')
  let chunkIterator: unknown
  try {
    chunkIterator = (chunks as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
  } catch {
    throw new StructResolverProtocolError('RESULT')
  }
  if (typeof chunkIterator !== 'function')
    throw new StructResolverProtocolError('RESULT')
  const transportReceipt = validateTransportReceiptShape(fields.transportReceipt)
  const hasLength = Object.hasOwn(fields, 'declaredByteLength')
  if (hasLength) safeCount(fields.declaredByteLength)
  return Object.freeze({
    protocolVersion: '1.0.0',
    resourceId: fields.resourceId as `sha256:${string}`,
    chunks: chunks as AsyncIterable<Uint8Array>,
    transportReceipt,
    ...(hasLength ? { declaredByteLength: safeCount(fields.declaredByteLength) } : {}),
  })
}

/**
 * Validates an accepted revocation receipt bound to `expectedExecutionId`.
 *
 * A swapped, stale, foreign, or partially populated receipt is a revocation
 * failure, never an accepted revocation.
 */
export function validateStructResolverRevocationReceipt(
  value: unknown,
  expectedExecutionId: string,
): StructResolverRevocationReceipt {
  if (isThenable(value)) throw new StructResolverProtocolError('REVOCATION')
  const fields = readStructResolverFields(value, [
    'executionId', 'capabilitiesRevoked', 'quarantined',
  ])
  if (fields.executionId !== expectedExecutionId)
    throw new StructResolverProtocolError('REVOCATION')
  if (!isStructResolverExecutionId(fields.executionId))
    throw new StructResolverProtocolError('REVOCATION')
  if (fields.capabilitiesRevoked !== true || fields.quarantined !== true)
    throw new StructResolverProtocolError('REVOCATION')
  return Object.freeze({
    executionId: fields.executionId,
    capabilitiesRevoked: true,
    quarantined: true,
  })
}

/**
 * Validates a terminal receipt bound to `expectedExecutionId` and the
 * expected terminal state.
 */
export function validateStructResolverTerminalReceipt(
  value: unknown,
  expectedExecutionId: string,
  expectedState: 'terminated' | 'completed',
): StructResolverTerminalReceipt {
  if (isThenable(value)) throw new StructResolverProtocolError('TERMINAL')
  const fields = readStructResolverFields(value, ['executionId', 'state'])
  if (fields.executionId !== expectedExecutionId)
    throw new StructResolverProtocolError('TERMINAL')
  if (!isStructResolverExecutionId(fields.executionId))
    throw new StructResolverProtocolError('TERMINAL')
  if (fields.state !== expectedState)
    throw new StructResolverProtocolError('TERMINAL')
  return Object.freeze({
    executionId: fields.executionId,
    state: expectedState,
  })
}

/**
 * Validates parent-attested fail-stop evidence bound to `expectedExecutionId`.
 */
export function validateStructResolverFailStopReceipt(
  value: unknown,
  expectedExecutionId: string,
): StructResolverFailStopReceipt {
  if (isThenable(value)) throw new StructResolverProtocolError('FAIL_STOP')
  const fields = readStructResolverFields(value, [
    'protocolVersion', 'executionId', 'hostTerminated', 'descendantsDead',
    'capacityRetired', 'evidence',
  ])
  if (fields.protocolVersion !== '1.0.0')
    throw new StructResolverProtocolError('FAIL_STOP')
  if (fields.executionId !== expectedExecutionId)
    throw new StructResolverProtocolError('FAIL_STOP')
  if (!isStructResolverExecutionId(fields.executionId))
    throw new StructResolverProtocolError('FAIL_STOP')
  if (fields.hostTerminated !== true || fields.descendantsDead !== true ||
    fields.capacityRetired !== true)
    throw new StructResolverProtocolError('FAIL_STOP')
  const evidence = readStructResolverFields(fields.evidence, [
    'hostReaped', 'descendantCount', 'waitedMs', 'method',
  ])
  if (evidence.hostReaped !== true || evidence.descendantCount !== 0)
    throw new StructResolverProtocolError('FAIL_STOP')
  if (typeof evidence.waitedMs !== 'number' || !Number.isSafeInteger(evidence.waitedMs) ||
    evidence.waitedMs < 0)
    throw new StructResolverProtocolError('FAIL_STOP')
  if (evidence.method !== 'process-group' && evidence.method !== 'cgroup' &&
    evidence.method !== 'pid-namespace')
    throw new StructResolverProtocolError('FAIL_STOP')
  return Object.freeze({
    protocolVersion: '1.0.0',
    executionId: fields.executionId,
    hostTerminated: true,
    descendantsDead: true,
    capacityRetired: true,
    evidence: Object.freeze({
      hostReaped: true,
      descendantCount: 0,
      waitedMs: evidence.waitedMs,
      method: evidence.method,
    }),
  })
}
