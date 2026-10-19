/**
 * Package reference supervisor for the isolated resolver executor.
 *
 * The supervisor owns execution identity, admission, the one-shot start
 * right, revocation bookkeeping, the retired-identity tombstone, and the
 * permanent retirement of an implicated capacity. It never spawns a process,
 * never opens a socket, and never kills a host: the out-of-realm host is
 * consumer-owned through {@link StructResolverHostBindingV1}, and the parent
 * process supervisor owns termination and descendant proof.
 *
 * The state machine is `allocated -> starting -> running -> revoking ->
 * cleaning -> terminated`. Every failure transition goes toward revocation,
 * cleanup, and termination, or toward a parent-proven fail-stop. A failed
 * execution never returns its capacity to the pool.
 */
import {
  StructResolverProtocolError,
  isStructResolverExecutionId,
  validateStructResolverRequest,
  validateStructResolverResult,
  validateStructResolverRevocationReceipt,
  validateStructResolverTerminalReceipt,
} from './resolver-protocol'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from './limits'
import type {
  StructAssetResolutionRequest,
  StructAssetResolutionResult,
  StructResolverExecutionControl,
  StructResolverExecutionHandle,
  StructResolverExecutorV1,
  StructResolverRevocationReceipt,
  StructResolverTerminalReceipt,
} from './resolver-protocol'

/**
 * Consumer-owned out-of-realm host binding.
 *
 * The binding holds the actual isolated host. It must not start adapter code
 * before the supervisor consumes the start right, and it must not run adapter
 * code in the caller's realm. The binding echoes the reserved execution
 * identifier in every receipt so the supervisor can prove identity binding.
 */
export type StructResolverHostBindingV1 = Readonly<{
  readonly executionId: string
  start(): Promise<StructAssetResolutionResult>
  revokeAndQuarantine(): StructResolverRevocationReceipt
  cleanup(): Promise<void>
  terminateAndJoin(): Promise<StructResolverTerminalReceipt>
}>

/** Construction options for the reference supervisor. */
export type StructResolverSupervisorOptions = Readonly<{
  /**
   * Binds the out-of-realm host to a reserved execution identifier. The call
   * must not spawn adapter code and must not grant any authority.
   */
  bind(
    request: StructAssetResolutionRequest,
    executionId: string,
  ): StructResolverHostBindingV1
  /**
   * Conformance test seam for identity collision cases. The default source is
   * collision resistant and fails closed when no cryptographic source exists.
   */
  executionIdSource?: () => string
}>

/** Observable supervisor state. */
export type StructResolverSupervisor = Readonly<{
  /** The executor a consumer hands to the package driver. */
  readonly executor: StructResolverExecutorV1
  /** Live execution identifiers in reservation order. */
  activeExecutionIds(): readonly string[]
  /** Identifiers permanently tombstoned for this supervisor lifetime. */
  retiredExecutionIds(): readonly string[]
  /** Capacity permanently retired after an ambiguous or failed execution. */
  retiredCapacityCount(): number
  /** Live execution count. */
  activeCapacity(): number
  /** True when the identifier is a permanent retired tombstone. */
  isRetired(executionId: string): boolean
}>

type Phase =
  | 'allocated'
  | 'starting'
  | 'running'
  | 'revoking'
  | 'cleaning'
  | 'terminated'
  | 'failed'

type ExecutionState = {
  readonly executionId: string
  readonly request: StructAssetResolutionRequest
  binding: StructResolverHostBindingV1 | undefined
  phase: Phase
  startConsumed: boolean
  startClosed: boolean
  revoked: boolean
  revocationReceipt: StructResolverRevocationReceipt | undefined
  cleaned: boolean
  terminated: boolean
  terminalReceipt: StructResolverTerminalReceipt | undefined
  capacityRetired: boolean
  releaseStart: (() => void) | undefined
}

function defaultExecutionIdSource(): string {
  const source = (globalThis as {
    crypto?: {
      randomUUID?: () => string
      getRandomValues?: (target: Uint8Array) => void
    }
  }).crypto
  if (source && typeof source.randomUUID === 'function') {
    const candidate = source.randomUUID()
    if (isStructResolverExecutionId(candidate)) return candidate
  }
  if (source && typeof source.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    source.getRandomValues(bytes)
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return `exec-${hex}`
  }
  // Without a cryptographic source the supervisor cannot mint a
  // collision-resistant identifier, so it fails closed instead of guessing.
  throw new StructResolverProtocolError('EXECUTION_ID')
}

function validateBinding(
  value: unknown,
  executionId: string,
): StructResolverHostBindingV1 {
  if (value === null || typeof value !== 'object')
    throw new StructResolverProtocolError('REQUEST')
  const candidate = value as Partial<StructResolverHostBindingV1>
  if (candidate.executionId !== executionId)
    throw new StructResolverProtocolError('EXECUTION_ID', executionId)
  if (typeof candidate.start !== 'function' ||
    typeof candidate.revokeAndQuarantine !== 'function' ||
    typeof candidate.cleanup !== 'function' ||
    typeof candidate.terminateAndJoin !== 'function')
    throw new StructResolverProtocolError('REQUEST')
  return value as StructResolverHostBindingV1
}

/**
 * Creates the package reference supervisor.
 *
 * The supervisor is a conforming executor only when the bound host behaves;
 * the conformance lane proves that with adversarial fixtures. The package
 * guarantees the identity, admission, one-shot, revocation, and tombstone
 * rules on its own.
 */
export function createStructResolverSupervisorV1(
  options: StructResolverSupervisorOptions,
): StructResolverSupervisor {
  if (options === null || typeof options !== 'object' ||
    typeof options.bind !== 'function')
    throw new StructResolverProtocolError('REQUEST')
  const mintExecutionId = options.executionIdSource ?? defaultExecutionIdSource

  const active = new Map<string, ExecutionState>()
  const retired = new Set<string>()
  let retiredCapacity = 0

  function tombstone(executionId: string): void {
    retired.add(executionId)
  }

  function retireCapacity(state: ExecutionState): void {
    if (state.capacityRetired) return
    state.capacityRetired = true
    retiredCapacity += 1
  }

  function closeStartRight(state: ExecutionState): void {
    state.startClosed = true
    state.releaseStart?.()
    state.releaseStart = undefined
  }

  /**
   * Permanently retires the implicated capacity and tombstones the identity.
   *
   * The raised error distinguishes the two failure kinds. A host that threw
   * keeps its own error, so the caller can tell a throwing host from a host
   * that returned invalid evidence. A host that returned invalid evidence
   * raises a `REVOCATION` or `TERMINAL` protocol error.
   */
  function failExecution(
    state: ExecutionState,
    error: unknown,
    code: 'REVOCATION' | 'TERMINAL',
  ): never {
    closeStartRight(state)
    tombstone(state.executionId)
    retireCapacity(state)
    state.phase = 'failed'
    active.delete(state.executionId)
    if (error instanceof Error) throw error
    throw new StructResolverProtocolError(code, state.executionId)
  }

  function bindingOf(state: ExecutionState): StructResolverHostBindingV1 {
    if (!state.binding)
      throw new StructResolverProtocolError('REQUEST', state.executionId)
    return state.binding
  }

  function allocate(request: unknown): StructResolverExecutionHandle {
    const validated = validateStructResolverRequest(request)
    if (validated.policy.maxConcurrent < 1)
      throw new StructResolverProtocolError('POLICY')
    if (validated.signal.aborted)
      throw new StructResolverProtocolError('REQUEST')

    const limit = Math.min(
      STRUCT_BUNDLE_LIMITS_PROFILE.maxConcurrency,
      validated.policy.maxConcurrent,
    )
    if (active.size + retiredCapacity >= limit)
      throw new StructResolverProtocolError('POLICY')

    const executionId = mintExecutionId()
    if (!isStructResolverExecutionId(executionId))
      throw new StructResolverProtocolError('EXECUTION_ID')
    // A duplicate active identifier or a retired identifier fails allocation
    // before any host is bound, so before any authority is granted.
    if (active.has(executionId) || retired.has(executionId))
      throw new StructResolverProtocolError('EXECUTION_ID', executionId)

    const state: ExecutionState = {
      executionId,
      request: validated,
      binding: undefined,
      phase: 'allocated',
      startConsumed: false,
      startClosed: false,
      revoked: false,
      revocationReceipt: undefined,
      cleaned: false,
      terminated: false,
      terminalReceipt: undefined,
      capacityRetired: false,
      releaseStart: undefined,
    }
    active.set(executionId, state)

    let binding: StructResolverHostBindingV1
    try {
      binding = validateBinding(options.bind(validated, executionId), executionId)
    } catch (error) {
      // The host may have partially started. The identifier is tombstoned and
      // the capacity is retired so that nothing can be reused.
      closeStartRight(state)
      tombstone(executionId)
      retireCapacity(state)
      active.delete(executionId)
      throw error
    }
    state.binding = binding

    const control: StructResolverExecutionControl = Object.freeze({
      executionId,
      revokeAndQuarantine(): StructResolverRevocationReceipt {
        if (state.revocationReceipt) return state.revocationReceipt
        closeStartRight(state)
        state.phase = 'revoking'
        let receipt: unknown
        try {
          receipt = bindingOf(state).revokeAndQuarantine()
        } catch (error) {
          failExecution(state, error, 'REVOCATION')
        }
        try {
          const accepted = validateStructResolverRevocationReceipt(
            receipt,
            executionId,
          )
          state.revoked = true
          state.revocationReceipt = accepted
          return accepted
        } catch {
          failExecution(state, undefined, 'REVOCATION')
        }
      },
      async cleanup(): Promise<void> {
        if (state.cleaned || state.terminated) return
        closeStartRight(state)
        if (state.phase === 'allocated' || state.phase === 'starting' ||
          state.phase === 'running')
          state.phase = 'cleaning'
        try {
          await bindingOf(state).cleanup()
          state.cleaned = true
        } catch (error) {
          failExecution(state, error, 'TERMINAL')
        }
      },
      async terminateAndJoin(): Promise<StructResolverTerminalReceipt> {
        if (state.terminalReceipt) return state.terminalReceipt
        closeStartRight(state)
        if (state.phase !== 'failed') state.phase = 'cleaning'
        let receipt: unknown
        try {
          receipt = await bindingOf(state).terminateAndJoin()
        } catch (error) {
          failExecution(state, error, 'TERMINAL')
        }
        let accepted: StructResolverTerminalReceipt
        try {
          accepted = validateStructResolverTerminalReceipt(receipt, executionId, 'terminated')
        } catch {
          try {
            accepted = validateStructResolverTerminalReceipt(receipt, executionId, 'completed')
          } catch {
            failExecution(state, undefined, 'TERMINAL')
          }
        }
        state.terminalReceipt = accepted
        state.terminated = true
        state.phase = 'terminated'
        // The identifier becomes an immutable tombstone before any capacity
        // returns to the pool, and a retired capacity is never handed out.
        tombstone(executionId)
        active.delete(executionId)
        return accepted
      },
    })

    const handle: StructResolverExecutionHandle = Object.freeze({
      control,
      start(): Promise<StructAssetResolutionResult> {
        if (state.startConsumed || state.startClosed)
          return Promise.reject(new StructResolverProtocolError('REQUEST', executionId))
        state.startConsumed = true
        state.phase = 'starting'
        return new Promise<StructAssetResolutionResult>((resolve, reject) => {
          let settled = false
          const closed = new Promise<'closed'>((resolveClosed) => {
            state.releaseStart = () => resolveClosed('closed')
          })
          let pending: Promise<StructAssetResolutionResult>
          try {
            pending = Promise.resolve(bindingOf(state).start())
          } catch (error) {
            settled = true
            reject(error)
            return
          }
          pending.then(
            (value) => {
              if (settled) return
              settled = true
              if (state.startClosed) {
                // A late completion of a revoked, cleaned, or terminated start
                // is quarantined: it cannot publish a result.
                reject(new StructResolverProtocolError('RESULT', executionId))
                return
              }
              state.phase = 'running'
              try {
                resolve(validateStructResolverResult(value))
              } catch (error) {
                reject(error)
              }
            },
            (error) => {
              if (settled) return
              settled = true
              reject(error)
            },
          )
          closed.then(() => {
            if (settled) return
            settled = true
            reject(new StructResolverProtocolError('RESULT', executionId))
          })
        })
      },
    })
    return handle
  }

  const executor: StructResolverExecutorV1 = Object.freeze({
    allocate: (request: StructAssetResolutionRequest) => allocate(request),
  })

  return Object.freeze({
    executor,
    activeExecutionIds: () => Object.freeze([...active.keys()]),
    retiredExecutionIds: () => Object.freeze([...retired]),
    retiredCapacityCount: () => retiredCapacity,
    activeCapacity: () => active.size,
    isRetired: (executionId: string) => retired.has(executionId),
  })
}
