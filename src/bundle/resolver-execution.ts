/**
 * Portable resolver execution driver.
 *
 * The driver resolves external bundle assets through a consumer-owned
 * executor. It performs no network or filesystem access of its own, holds no
 * capability, and never terminates a host. It owns the orchestration only:
 * policy binding before allocation, one-shot start, bounded streaming with
 * exact length and digest equality, the fixed teardown order, and the
 * escalation to the parent fail-stop port when teardown evidence is missing.
 *
 * The driver accepts already validated targets. The raw expected-digest gate
 * and the wire ingress live in the later bytes-decoder integration seam, and
 * the embedded value verifier exposes no executor option at all.
 */
import { sha256HexSync } from '../sha256'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from './limits'
import { ResolverPolicyError, validateResolverPolicyV1 } from './resolver-policy'
import { validateResolverReceiptProjection } from './resolver-receipt'
import {
  StructResolverProtocolError,
  isStructResolverLogicalHref,
  planStructResolverBudget,
  readStructResolverFields,
  validateStructResolverFailStopReceipt,
  validateStructResolverResult,
  validateStructResolverRevocationReceipt,
  validateStructResolverTerminalReceipt,
} from './resolver-protocol'
import type {
  StructAssetResolutionPolicyV1,
  StructAssetResolutionRequest,
  StructAssetResolutionResult,
  StructResolverExecutionControl,
  StructResolverExecutorV1,
  StructResolverFailStopReason,
  StructResolverHostSupervisorV1,
} from './resolver-protocol'

/** One external asset the driver has to resolve. */
export type StructResolverAssetTarget = Readonly<{
  id: string
  sha256: string
  mediaType: string
  byteLength: number
  logicalHref: string
}>

/** Envelope payload projection: embedded bytes or an external content address. */
export type StructResolverEnvelopePayloadProjection = Readonly<
  { kind: 'embedded'; base64: string }
  | { kind: 'external'; resourceId: string }
>

/** Envelope asset projection accepted by the target selector. */
export type StructResolverEnvelopeAssetProjection = Readonly<{
  id: string
  sha256: string
  mediaType: string
  byteLength: number
  payload: StructResolverEnvelopePayloadProjection
}>

/** Driver options. The fail-stop port is mandatory for external resolution. */
export type StructResolverExecutionOptions = Readonly<{
  executor: StructResolverExecutorV1
  hostSupervisor: StructResolverHostSupervisorV1
  policy: StructAssetResolutionPolicyV1
  expectedPolicySha256: string
  budget: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  signal?: AbortSignal
  /** Monotonic clock seam for deterministic budget tests. */
  now?: () => number
}>

/** Structured failure codes. No locator, secret, or free-form message. */
export type StructResolverResolutionFailureCode =
  | 'OPTIONS'
  | 'POLICY'
  | 'BUDGET'
  | 'TARGET'
  | 'ALLOCATE'
  | 'START'
  | 'RESULT'
  | 'RECEIPT'
  | 'STREAM'
  | 'LENGTH'
  | 'DIGEST'
  | 'LIMIT'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'REVOCATION'
  | 'CLEANUP'
  | 'TERMINAL'
  | 'FAIL_STOP'

/** Driver result. The success branch carries copied asset bytes only. */
export type StructResolverResolutionResult =
  | Readonly<{ ok: true; assets: ReadonlyMap<string, Uint8Array> }>
  | Readonly<{
    ok: false
    error: Readonly<{
      code: StructResolverResolutionFailureCode
      executionId?: string
    }>
  }>

const DIGEST = /^[0-9a-f]{64}$/u
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get
const intrinsicTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get

class DeadlineError extends Error {
  constructor() {
    super('resolver deadline')
    this.name = 'DeadlineError'
  }
}

class StreamError extends Error {
  constructor() {
    super('resolver stream')
    this.name = 'StreamError'
  }
}

/** Preflight failure with a stable, secret-free category. */
class OptionError extends Error {
  constructor(readonly code: 'OPTIONS' | 'POLICY' | 'BUDGET') {
    super('resolver options')
    this.name = 'OptionError'
  }
}

function defaultNow(): number {
  const clock = (globalThis as { performance?: { now?: () => number } }).performance
  if (clock && typeof clock.now === 'function') return clock.now()
  return Date.now()
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { aborted?: unknown; addEventListener?: unknown }
  return typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function'
}

function ownDataFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  return readStructResolverFields(value, allowed, required) as Record<string, unknown>
}

/**
 * Copies one chunk. A value that is not a genuine byte view, or whose backing
 * buffer was detached, is rejected before any copy is attempted.
 */
function copyChunk(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) || !intrinsicTag || !intrinsicByteLength)
    throw new StreamError()
  if (Reflect.apply(intrinsicTag, value, []) !== 'Uint8Array')
    throw new StreamError()
  const length = Reflect.apply(intrinsicByteLength, value, []) as number
  if (!Number.isSafeInteger(length) || length < 0) throw new StreamError()
  const copy = new Uint8Array(length)
  try {
    Uint8Array.prototype.set.call(copy, value as unknown as Uint8Array)
  } catch {
    throw new StreamError()
  }
  return copy
}

function raced<T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
): Promise<T> {
  const remaining = deadline - now()
  if (!(remaining > 0)) return Promise.reject(new DeadlineError())
  const delay = Math.min(remaining, 2_147_483_647)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), delay)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function failure(
  code: StructResolverResolutionFailureCode,
  executionId?: string,
): StructResolverResolutionResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze(
      executionId === undefined
        ? { code }
        : { code, executionId },
    ),
  })
}

/**
 * Selects the external assets of an already validated bundle.
 *
 * The document projection and the envelope asset set arrive verified, so this
 * helper only checks that the two agree and that an external payload carries
 * the content address of its digest. Embedded payloads are not external work.
 */
export function selectStructResolverTargets(
  documentAssets: readonly Readonly<{
    id: string
    href: string
    mediaType: string
    sha256: string
  }>[],
  envelopeAssets: readonly StructResolverEnvelopeAssetProjection[],
): StructResolverAssetTarget[] {
  const documents = new Map<string, {
    href: string
    mediaType: string
    sha256: string
  }>()
  for (const asset of documentAssets) {
    if (asset === null || typeof asset !== 'object')
      throw new StructResolverProtocolError('REQUEST')
    if (documents.has(asset.id))
      throw new StructResolverProtocolError('REQUEST')
    documents.set(asset.id, {
      href: asset.href,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
    })
  }
  const targets: StructResolverAssetTarget[] = []
  for (const asset of envelopeAssets) {
    if (asset === null || typeof asset !== 'object')
      throw new StructResolverProtocolError('REQUEST')
    if (asset.payload.kind !== 'external') continue
    if (asset.payload.resourceId !== `sha256:${asset.sha256}`)
      throw new StructResolverProtocolError('REQUEST')
    const document = documents.get(asset.id)
    if (!document ||
      document.sha256 !== asset.sha256 ||
      document.mediaType !== asset.mediaType)
      throw new StructResolverProtocolError('REQUEST')
    if (!isStructResolverLogicalHref(document.href))
      throw new StructResolverProtocolError('REQUEST')
    targets.push(Object.freeze({
      id: asset.id,
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      byteLength: asset.byteLength,
      logicalHref: document.href,
    }))
  }
  return targets
}

type ParsedOptions = Readonly<{
  executor: StructResolverExecutorV1
  hostSupervisor: StructResolverHostSupervisorV1
  policy: StructAssetResolutionPolicyV1
  expectedPolicySha256: string
  totalTimeoutMs: number
  cleanupReserveMs: number
  signal: AbortSignal | undefined
  now: () => number
}>

/**
 * Reads the monotonic clock seam before the options are validated.
 *
 * The total budget starts before the preflight, so the clock has to be
 * available before the option object is trusted. A foreign option object
 * falls back to the package monotonic clock.
 */
function readClock(value: unknown): () => number {
  try {
    if (value !== null && typeof value === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'now')
      if (descriptor && Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function')
        return descriptor.value as () => number
    }
  } catch {
    // A foreign option object falls back to the package monotonic clock.
  }
  return defaultNow
}

function parseOptions(value: unknown, fallbackNow: () => number): ParsedOptions {
  const fields = ownDataFields(
    value,
    ['executor', 'hostSupervisor', 'policy', 'expectedPolicySha256', 'budget', 'signal', 'now'],
    ['executor', 'hostSupervisor', 'policy', 'expectedPolicySha256', 'budget'],
  )
  const executor = fields.executor as Partial<StructResolverExecutorV1>
  if (!executor || typeof executor !== 'object' ||
    typeof executor.allocate !== 'function')
    throw new OptionError('OPTIONS')
  const host = fields.hostSupervisor as Partial<StructResolverHostSupervisorV1>
  if (!host || typeof host !== 'object' ||
    host.protocolVersion !== '1.0.0' || typeof host.failStop !== 'function')
    throw new OptionError('OPTIONS')
  let policyDigest: string
  let policy: StructAssetResolutionPolicyV1
  try {
    const validated = validateResolverPolicyV1(fields.policy)
    policyDigest = validated.policySha256
    policy = validated.policySnapshot()
  } catch (error) {
    if (error instanceof ResolverPolicyError) throw new OptionError('POLICY')
    throw error
  }
  if (fields.expectedPolicySha256 !== policyDigest)
    throw new OptionError('POLICY')
  const plan = planStructResolverBudget(fields.budget)
  if (Object.hasOwn(fields, 'signal') && !isAbortSignalLike(fields.signal))
    throw new OptionError('OPTIONS')
  if (Object.hasOwn(fields, 'now') && typeof fields.now !== 'function')
    throw new OptionError('OPTIONS')
  return Object.freeze({
    executor: fields.executor as StructResolverExecutorV1,
    hostSupervisor: fields.hostSupervisor as StructResolverHostSupervisorV1,
    policy,
    expectedPolicySha256: policyDigest,
    totalTimeoutMs: plan.totalTimeoutMs,
    cleanupReserveMs: plan.cleanupReserveMs,
    signal: Object.hasOwn(fields, 'signal') ? fields.signal as AbortSignal : undefined,
    now: typeof fields.now === 'function' ? fields.now as () => number : fallbackNow,
  })
}

function parseTargets(
  value: unknown,
): StructResolverAssetTarget[] {
  if (!Array.isArray(value)) throw new TypeError('targets')
  const seen = new Set<string>()
  const targets: StructResolverAssetTarget[] = []
  for (const item of value as unknown[]) {
    const fields = ownDataFields(item, [
      'id', 'sha256', 'mediaType', 'byteLength', 'logicalHref',
    ])
    const id = fields.id
    const sha256 = fields.sha256
    const mediaType = fields.mediaType
    const byteLength = fields.byteLength
    const logicalHref = fields.logicalHref
    if (typeof id !== 'string' || id.length === 0 || id.length > 256 ||
      seen.has(id))
      throw new TypeError('targets')
    if (typeof sha256 !== 'string' || !DIGEST.test(sha256))
      throw new TypeError('targets')
    if (typeof mediaType !== 'string' || mediaType.length === 0 ||
      mediaType.length > 256)
      throw new TypeError('targets')
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) ||
      byteLength < 0)
      throw new TypeError('targets')
    if (!isStructResolverLogicalHref(logicalHref))
      throw new TypeError('targets')
    seen.add(id)
    targets.push(Object.freeze({
      id,
      sha256,
      mediaType,
      byteLength,
      logicalHref,
    }))
  }
  return targets
}

type Execution = {
  readonly executionId: string
  readonly control: StructResolverExecutionControl
  readonly controller: AbortController
  iterator: AsyncIterator<Uint8Array> | undefined
}

type TeardownOutcome = Readonly<{
  ok: boolean
  code: StructResolverResolutionFailureCode | undefined
  failStopReason: StructResolverFailStopReason | undefined
}>

async function failStop(
  host: StructResolverHostSupervisorV1,
  executionId: string,
  reason: StructResolverFailStopReason,
): Promise<boolean> {
  try {
    const receipt = await host.failStop(executionId, reason)
    validateStructResolverFailStopReceipt(receipt, executionId)
    return true
  } catch {
    return false
  }
}

/**
 * Runs the fixed teardown order for one execution.
 *
 * Abort, then synchronous revocation, then the chunk iterator return when a
 * result already exists, then cleanup inside the reserved cleanup budget,
 * then terminate and join inside the reserved outer budget. A failure in one
 * step never skips a later step.
 *
 * A cleanup that throws is recorded and the join still runs, so the parent
 * still learns that the host is gone; only a cleanup that never settles
 * inside the reserved budget escalates, because then the reserved evidence
 * is missing rather than merely negative.
 */
async function teardown(
  execution: Execution,
  options: ParsedOptions,
  outerDeadline: number,
  expectCompleted: boolean,
): Promise<TeardownOutcome> {
  let revocationReason: StructResolverFailStopReason | undefined
  let cleanupTimedOut = false
  let cleanupFailed = false
  let terminalReason: StructResolverFailStopReason | undefined

  execution.controller.abort()

  let revocationReceipt: unknown
  try {
    revocationReceipt = execution.control.revokeAndQuarantine()
  } catch (error) {
    // A host that threw is a throwing revocation. A host that returned
    // evidence the supervisor rejected is an invalid receipt.
    revocationReason = error instanceof StructResolverProtocolError &&
      error.code === 'REVOCATION'
      ? 'REVOCATION_RECEIPT'
      : 'REVOCATION_THROW'
  }
  if (revocationReason === undefined) {
    try {
      validateStructResolverRevocationReceipt(
        revocationReceipt,
        execution.executionId,
      )
    } catch {
      revocationReason = 'REVOCATION_RECEIPT'
    }
  }

  if (execution.iterator) {
    try {
      await raced(
        Promise.resolve(execution.iterator.return?.(undefined)),
        Math.min(outerDeadline, options.now() + options.cleanupReserveMs),
        options.now,
      )
    } catch {
      // A failing iterator return is recorded and never skips cleanup or join.
    }
  }

  try {
    await raced(
      Promise.resolve(execution.control.cleanup()),
      options.now() + options.cleanupReserveMs,
      options.now,
    )
  } catch (error) {
    cleanupFailed = true
    cleanupTimedOut = !(error instanceof StructResolverProtocolError)
  }

  let terminalReceipt: unknown
  try {
    terminalReceipt = await raced(
      Promise.resolve(execution.control.terminateAndJoin()),
      outerDeadline,
      options.now,
    )
  } catch (error) {
    // A join that never settles is a timeout. A join that threw produced no
    // terminal receipt at all.
    terminalReason = error instanceof DeadlineError
      ? 'TERMINAL_TIMEOUT'
      : 'TERMINAL_RECEIPT'
  }
  if (terminalReason === undefined) {
    try {
      const state = (terminalReceipt as { state?: unknown }).state
      validateStructResolverTerminalReceipt(
        terminalReceipt,
        execution.executionId,
        expectCompleted
          ? 'completed'
          : state === 'completed' ? 'completed' : 'terminated',
      )
    } catch {
      terminalReason = 'TERMINAL_RECEIPT'
    }
  }

  const failed = revocationReason !== undefined || cleanupFailed ||
    terminalReason !== undefined
  if (!failed)
    return Object.freeze({ ok: true, code: undefined, failStopReason: undefined })
  const reason = revocationReason ??
    (cleanupTimedOut ? 'CLEANUP_TIMEOUT' : undefined) ??
    terminalReason
  const code: StructResolverResolutionFailureCode = revocationReason !== undefined
    ? 'REVOCATION'
    : cleanupFailed
    ? 'CLEANUP'
    : 'TERMINAL'
  return Object.freeze({ ok: false, code, failStopReason: reason })
}

async function resolveOne(
  target: StructResolverAssetTarget,
  options: ParsedOptions,
  remainingAggregate: number,
  seenExecutionIds: Set<string>,
  deadline: number,
): Promise<
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; code: StructResolverResolutionFailureCode; executionId?: string }>
> {
  const nowMs = options.now()
  // The total budget started before the preflight, so this execution only
  // owns what is left of it. The global deadline is never extended.
  const remaining = Math.floor(deadline - nowMs)
  if (remaining < 2)
    return Object.freeze({ ok: false, code: 'TIMEOUT' })
  const totalTimeoutMs = remaining
  const cleanupReserveMs = Math.min(options.cleanupReserveMs, totalTimeoutMs - 1)
  const outerDeadline = deadline
  const workDeadline = nowMs + (totalTimeoutMs - cleanupReserveMs)
  const controller = new AbortController()
  const callerSignal = options.signal
  const onAbort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onAbort, { once: true })
  }

  const request: StructAssetResolutionRequest = Object.freeze({
    protocolVersion: '1.0.0',
    logicalHref: target.logicalHref,
    resourceId: `sha256:${target.sha256}` as `sha256:${string}`,
    expected: Object.freeze({
      id: target.id,
      sha256: target.sha256,
      mediaType: target.mediaType,
      byteLength: target.byteLength,
    }),
    policy: options.policy,
    expectedPolicySha256: options.expectedPolicySha256,
    budget: Object.freeze({
      totalTimeoutMs,
      cleanupReserveMs,
    }),
    signal: controller.signal,
  })

  let handle: ReturnType<StructResolverExecutorV1['allocate']>
  try {
    handle = options.executor.allocate(request)
  } catch {
    if (callerSignal) callerSignal.removeEventListener('abort', onAbort)
    return Object.freeze({ ok: false, code: 'ALLOCATE' })
  }
  if (!handle || typeof handle !== 'object' ||
    typeof handle.start !== 'function' ||
    !handle.control || typeof handle.control !== 'object' ||
    typeof handle.control.revokeAndQuarantine !== 'function' ||
    typeof handle.control.cleanup !== 'function' ||
    typeof handle.control.terminateAndJoin !== 'function' ||
    typeof handle.control.executionId !== 'string')
    return Object.freeze({ ok: false, code: 'ALLOCATE' })

  const execution: Execution = {
    executionId: handle.control.executionId,
    control: handle.control,
    controller,
    iterator: undefined,
  }

  // An identifier that this resolution already used is either a live
  // collision or a retired reuse. The package never continues under an
  // ambiguous identity, so it escalates to the parent fail-stop port before
  // any start is attempted.
  if (seenExecutionIds.has(execution.executionId)) {
    const proven = await failStop(
      options.hostSupervisor,
      execution.executionId,
      'EXECUTION_ID_AMBIGUITY',
    )
    if (callerSignal) callerSignal.removeEventListener('abort', onAbort)
    return Object.freeze({
      ok: false,
      code: proven ? 'ALLOCATE' : 'FAIL_STOP',
      executionId: execution.executionId,
    })
  }
  seenExecutionIds.add(execution.executionId)

  const finish = async (
    outcome: Readonly<
      { ok: true; bytes: Uint8Array }
      | { ok: false; code: StructResolverResolutionFailureCode; executionId?: string }
    >,
  ): Promise<
    | Readonly<{ ok: true; bytes: Uint8Array }>
    | Readonly<{ ok: false; code: StructResolverResolutionFailureCode; executionId?: string }>
  > => {
    if (callerSignal) callerSignal.removeEventListener('abort', onAbort)
    if (outcome.ok) return outcome
    return Object.freeze({
      ok: false,
      code: outcome.code,
      ...(outcome.executionId === undefined
        ? {}
        : { executionId: outcome.executionId }),
    })
  }

  let started_: Promise<StructAssetResolutionResult>
  try {
    started_ = Promise.resolve(handle.start())
  } catch {
    const outcome = await teardown(execution, options, outerDeadline, false)
    if (!outcome.ok && outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? 'START',
      executionId: execution.executionId,
    }))
  }

  let result: StructAssetResolutionResult
  try {
    result = await raced(started_, workDeadline, options.now)
  } catch (error) {
    // A rejected start is a startup failure. Only the deadline race and the
    // abort signal produce a timeout or an abort.
    const code: StructResolverResolutionFailureCode =
      error instanceof DeadlineError
        ? controller.signal.aborted ? 'ABORTED' : 'TIMEOUT'
        : 'START'
    const outcome = await teardown(execution, options, outerDeadline, false)
    if (!outcome.ok && outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? code,
      executionId: execution.executionId,
    }))
  }

  try {
    validateStructResolverResult(result)
  } catch {
    const outcome = await teardown(execution, options, outerDeadline, false)
    if (!outcome.ok && outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? 'RESULT',
      executionId: execution.executionId,
    }))
  }

  try {
    validateResolverReceiptProjection(
      {
        policy: options.policy,
        expectedPolicySha256: options.expectedPolicySha256,
        expected: request.expected,
      },
      {
        protocolVersion: result.protocolVersion,
        resourceId: result.resourceId,
        transportReceipt: result.transportReceipt,
        ...(result.declaredByteLength === undefined
          ? {}
          : { declaredByteLength: result.declaredByteLength }),
      },
    )
  } catch {
    const outcome = await teardown(execution, options, outerDeadline, false)
    if (!outcome.ok && outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? 'RECEIPT',
      executionId: execution.executionId,
    }))
  }

  let iterator: AsyncIterator<Uint8Array>
  try {
    iterator = result.chunks[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>
  } catch {
    const outcome = await teardown(execution, options, outerDeadline, false)
    if (!outcome.ok && outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? 'STREAM',
      executionId: execution.executionId,
    }))
  }
  execution.iterator = iterator
  const maxAssetBytes = Math.min(
    target.byteLength,
    STRUCT_BUNDLE_LIMITS_PROFILE.maxAssetBytes,
    remainingAggregate,
  )
  const collected: Uint8Array[] = []
  let total = 0
  let streamFailure: StructResolverResolutionFailureCode | undefined
  try {
    for (;;) {
      const step = await raced(
        Promise.resolve(iterator.next()),
        workDeadline,
        options.now,
      )
      if (step.done) break
      const copy = copyChunk(step.value)
      if (copy.byteLength === 0) continue
      if (copy.byteLength > STRUCT_BUNDLE_LIMITS_PROFILE.maxAssetBytes) {
        streamFailure = 'LIMIT'
        break
      }
      if (total + copy.byteLength > maxAssetBytes) {
        streamFailure = 'LIMIT'
        break
      }
      collected.push(copy)
      total += copy.byteLength
    }
  } catch (error) {
    if (error instanceof StreamError) streamFailure = 'STREAM'
    else if (error instanceof DeadlineError)
      streamFailure = controller.signal.aborted ? 'ABORTED' : 'TIMEOUT'
    else streamFailure = 'STREAM'
  }

  if (!streamFailure && total !== target.byteLength) streamFailure = 'LENGTH'

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of collected) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (!streamFailure && sha256HexSync(bytes) !== target.sha256)
    streamFailure = 'DIGEST'

  if (streamFailure) {
    const outcome = await teardown(execution, options, outerDeadline, false)
    if (!outcome.ok && outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? streamFailure,
      executionId: execution.executionId,
    }))
  }

  const outcome = await teardown(execution, options, outerDeadline, true)
  if (!outcome.ok) {
    if (outcome.failStopReason) {
      const proven = await failStop(
        options.hostSupervisor,
        execution.executionId,
        outcome.failStopReason,
      )
      if (!proven)
        return finish(Object.freeze({
          ok: false,
          code: 'FAIL_STOP',
          executionId: execution.executionId,
        }))
    }
    return finish(Object.freeze({
      ok: false,
      code: outcome.code ?? 'TERMINAL',
      executionId: execution.executionId,
    }))
  }

  return finish(Object.freeze({ ok: true, bytes }))
}

/**
 * Resolves every external asset target through the consumer executor.
 *
 * The function never throws for an expected failure and never reports normal
 * completion when teardown evidence is missing.
 */
export async function resolveStructResolverAssets(
  targets: readonly StructResolverAssetTarget[],
  options: StructResolverExecutionOptions,
): Promise<StructResolverResolutionResult> {
  // The total budget starts before the preflight, so a later bytes decoder
  // can pass the remaining budget after a raw parse and the global deadline
  // is preserved.
  const now = readClock(options)
  const started = now()
  let parsed: ParsedOptions
  try {
    parsed = parseOptions(options, now)
  } catch (error) {
    if (error instanceof OptionError) return failure(error.code)
    if (error instanceof StructResolverProtocolError) {
      if (error.code === 'BUDGET') return failure('BUDGET')
      if (error.code === 'POLICY') return failure('POLICY')
      return failure('OPTIONS')
    }
    return failure('OPTIONS')
  }
  const deadline = started + parsed.totalTimeoutMs
  let wanted: StructResolverAssetTarget[]
  try {
    wanted = parseTargets(targets)
  } catch {
    return failure('TARGET')
  }
  if (parsed.policy.maxConcurrent < 1) return failure('POLICY')
  if (parsed.signal?.aborted) return failure('ABORTED')
  if (wanted.length === 0) return Object.freeze({ ok: true, assets: new Map() })

  const concurrency = Math.max(
    1,
    Math.min(
      STRUCT_BUNDLE_LIMITS_PROFILE.maxConcurrency,
      parsed.policy.maxConcurrent,
    ),
  )
  const aggregateCap = Math.min(
    STRUCT_BUNDLE_LIMITS_PROFILE.maxTotalBytes,
    STRUCT_BUNDLE_LIMITS_PROFILE.maxDecodedBytes,
  )
  const resolved = new Map<string, Uint8Array>()
  const seenExecutionIds = new Set<string>()
  let aggregate = 0
  let next = 0
  let stopped: StructResolverResolutionResult | undefined

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      const index = next
      next += 1
      if (index >= wanted.length) return
      const target = wanted[index]!
      const outcome = await resolveOne(
        target,
        parsed,
        aggregateCap - aggregate,
        seenExecutionIds,
        deadline,
      )
      if (!outcome.ok) {
        stopped = failure(outcome.code, outcome.executionId)
        return
      }
      aggregate += outcome.bytes.byteLength
      resolved.set(target.id, outcome.bytes)
    }
  }

  const workers: Promise<void>[] = []
  for (let index = 0; index < Math.min(concurrency, wanted.length); index += 1)
    workers.push(worker())
  await Promise.all(workers)
  if (stopped) return stopped
  return Object.freeze({ ok: true, assets: resolved })
}
