/**
 * In-process resolver host fixtures.
 *
 * These fixtures stand in for the consumer-owned out-of-realm host. They are
 * deliberately hostile: every teardown step can throw, hang, swap a receipt,
 * or report a foreign identifier. They never touch a network, a filesystem,
 * or a process, and they never carry a secret.
 */
import { validateResolverPolicyV1 } from '../../../src/bundle/resolver-policy'
import type { StructAssetResolutionPolicyV1 } from '../../../src/bundle/resolver-policy'
import type {
  StructAssetResolutionRequest,
  StructAssetResolutionResult,
  StructResolverFailStopReason,
  StructResolverFailStopReceipt,
  StructResolverHostSupervisorV1,
  StructResolverRevocationReceipt,
  StructResolverTerminalReceipt,
} from '../../../src/bundle/resolver-protocol'
import { createStructResolverSupervisorV1 } from '../../../src/bundle/resolver-supervisor'
import type {
  StructResolverHostBindingV1,
  StructResolverSupervisor,
} from '../../../src/bundle/resolver-supervisor'

export const FIXTURE_DIGEST = 'a'.repeat(64)

export const httpsPolicy = (
  maxConcurrent = 1,
): StructAssetResolutionPolicyV1 => ({
  protocolVersion: '1.0.0',
  profileId: 'fixture',
  profileVersion: 'v1',
  maxConcurrent,
  transport: {
    kind: 'https',
    endpointMapId: 'map-1',
    allowedEndpointIds: ['a', 'b'],
    redirects: 'same-origin',
    maxRedirects: 1,
    denyPrivateNetworks: true,
    serializedLocators: false,
  },
})

export const policyDigest = (policy: StructAssetResolutionPolicyV1): string =>
  validateResolverPolicyV1(policy).policySha256

export const httpsReceipt = (digest: string, endpointId = 'a') => ({
  kind: 'https' as const,
  policySha256: digest,
  endpointMapId: 'map-1',
  endpointId,
  redirectEndpointIds: ['b'],
})

export type FakeHostBehaviour = Readonly<{
  /** 'resolve' returns the chunk stream, 'reject' fails, 'hang' never settles. */
  start?: 'resolve' | 'reject' | 'hang' | 'throw'
  /** Delay in milliseconds before a resolving start publishes its result. */
  startDelayMs?: number
  chunks?: readonly Uint8Array[]
  /** Fails the chunk iterator instead of completing it. */
  chunkError?: boolean
  /** Emits one chunk that is not a byte view. */
  nonByteChunk?: boolean
  revoke?: 'accept' | 'throw' | 'quarantine-false' | 'foreign-id' | 'swapped-id' | 'promise'
  cleanup?: 'resolve' | 'throw' | 'hang'
  terminate?: 'resolve' | 'throw' | 'hang' | 'foreign-id' | 'swapped-id' | 'wrong-state'
  /** Terminal state reported by a resolving join. Defaults to 'completed'. */
  terminalState?: 'terminated' | 'completed'
  /** Overrides the endpoint identifier echoed in the transport receipt. */
  receiptEndpointId?: string
  /** Overrides the policy digest echoed in the transport receipt. */
  receiptPolicySha256?: string
  declaredByteLength?: number
}>

export type FakeHost = StructResolverHostBindingV1 & {
  readonly calls: {
    start: number
    revoke: number
    cleanup: number
    terminate: number
    /** Broker grants or calls observed after an accepted revocation receipt. */
    brokerGrantsAfterRevocation: number
  }
  /** Ordered record of the lifecycle calls the host observed. */
  readonly order: string[]
  /** Abort state of the request signal when revocation was requested. */
  abortedAtRevoke: boolean | undefined
  /** Execution identifier this host is bound to. */
  readonly executionId: string
}

export function createFakeHost(
  executionId: string,
  behaviour: FakeHostBehaviour = {},
  context: {
    request?: StructAssetResolutionRequest
    policyDigest: string
    swapTargetId?: string
  } = { policyDigest: '' },
): FakeHost {
  const calls = {
    start: 0,
    revoke: 0,
    cleanup: 0,
    terminate: 0,
    brokerGrantsAfterRevocation: 0,
  }
  const order: string[] = []
  let revoked = false
  const chunks = behaviour.chunks ?? [new Uint8Array([1, 2, 3])]

  const host: FakeHost = {
    executionId,
    calls,
    order,
    abortedAtRevoke: undefined,
    start(): Promise<StructAssetResolutionResult> {
      calls.start += 1
      order.push('start')
      if (revoked) calls.brokerGrantsAfterRevocation += 1
      if (behaviour.start === 'throw')
        throw new Error('synchronous startup failure')
      if (behaviour.start === 'hang') return new Promise(() => {})
      if (behaviour.start === 'reject')
        return Promise.reject(new Error('startup rejected'))
      const build = (): StructAssetResolutionResult => ({
        protocolVersion: '1.0.0',
        resourceId: `sha256:${context.request?.expected.sha256 ?? FIXTURE_DIGEST}`,
        chunks: (async function* stream() {
          if (behaviour.nonByteChunk) {
            yield 'not-bytes' as unknown as Uint8Array
            return
          }
          for (const chunk of chunks) {
            yield chunk
            await Promise.resolve()
          }
          if (behaviour.chunkError) throw new Error('chunk stream failed')
        })(),
        transportReceipt: httpsReceipt(
          behaviour.receiptPolicySha256 ?? context.policyDigest,
          behaviour.receiptEndpointId ?? 'a',
        ) as never,
        ...(behaviour.declaredByteLength === undefined
          ? {}
          : { declaredByteLength: behaviour.declaredByteLength }),
      })
      if (!behaviour.startDelayMs) return Promise.resolve(build())
      return new Promise((resolve) => {
        setTimeout(() => resolve(build()), behaviour.startDelayMs)
      })
    },
    revokeAndQuarantine(): StructResolverRevocationReceipt {
      calls.revoke += 1
      order.push('revoke')
      host.abortedAtRevoke = context.request?.signal.aborted
      if (behaviour.revoke === 'throw') throw new Error('revocation failed')
      if (behaviour.revoke === 'promise')
        return Promise.resolve({
          executionId,
          capabilitiesRevoked: true,
          quarantined: true,
        }) as unknown as StructResolverRevocationReceipt
      if (behaviour.revoke === 'quarantine-false')
        return {
          executionId,
          capabilitiesRevoked: true,
          quarantined: false,
        } as unknown as StructResolverRevocationReceipt
      if (behaviour.revoke === 'foreign-id')
        return {
          executionId: 'foreign-execution',
          capabilitiesRevoked: true,
          quarantined: true,
        }
      if (behaviour.revoke === 'swapped-id')
        return {
          executionId: context.swapTargetId ?? 'foreign-execution',
          capabilitiesRevoked: true,
          quarantined: true,
        }
      revoked = true
      return { executionId, capabilitiesRevoked: true, quarantined: true }
    },
    async cleanup(): Promise<void> {
      calls.cleanup += 1
      order.push('cleanup')
      if (behaviour.cleanup === 'throw') throw new Error('cleanup failed')
      if (behaviour.cleanup === 'hang') await new Promise(() => {})
    },
    async terminateAndJoin(): Promise<StructResolverTerminalReceipt> {
      calls.terminate += 1
      order.push('terminate')
      if (behaviour.terminate === 'throw') throw new Error('join failed')
      if (behaviour.terminate === 'hang') await new Promise(() => {})
      if (behaviour.terminate === 'foreign-id')
        return { executionId: 'foreign-execution', state: 'terminated' }
      if (behaviour.terminate === 'swapped-id')
        return { executionId: context.swapTargetId ?? 'foreign-execution', state: 'terminated' }
      if (behaviour.terminate === 'wrong-state')
        return { executionId, state: 'terminated' as 'completed' }
      return { executionId, state: behaviour.terminalState ?? 'completed' }
    },
  }
  return host
}

export type FakeSupervisor = StructResolverSupervisor & {
  readonly hosts: FakeHost[]
  readonly requests: StructAssetResolutionRequest[]
}

/**
 * Builds a reference supervisor whose hosts follow `behaviourFor`.
 *
 * The supervisor owns identity, admission, and the one-shot start right; the
 * fake host owns the teardown behaviour under test.
 */
export function createFakeSupervisor(
  behaviourFor: (request: StructAssetResolutionRequest, executionId: string) => FakeHostBehaviour = () => ({}),
  options: { executionIdSource?: () => string } = {},
): FakeSupervisor {
  const hosts: FakeHost[] = []
  const requests: StructAssetResolutionRequest[] = []
  const supervisor = createStructResolverSupervisorV1({
    ...(options.executionIdSource ? { executionIdSource: options.executionIdSource } : {}),
    bind(request, executionId) {
      requests.push(request)
      const previous = hosts.length > 0 ? hosts[hosts.length - 1]!.executionId : undefined
      const host = createFakeHost(executionId, behaviourFor(request, executionId), {
        request,
        policyDigest: request.expectedPolicySha256,
        swapTargetId: previous,
      })
      hosts.push(host)
      return host
    },
  })
  return Object.freeze({
    ...supervisor,
    executor: supervisor.executor,
    hosts,
    requests,
  })
}

export type FakeHostSupervisor = StructResolverHostSupervisorV1 & {
  readonly calls: ReadonlyArray<{
    executionId: string
    reason: StructResolverFailStopReason
  }>
}

/** Records fail-stop requests and returns valid parent-attested evidence. */
export function createFakeHostSupervisor(
  behaviour: 'accept' | 'throw' | 'invalid' = 'accept',
): FakeHostSupervisor {
  const calls: Array<{ executionId: string; reason: StructResolverFailStopReason }> = []
  return {
    protocolVersion: '1.0.0',
    calls,
    async failStop(
      executionId: string,
      reason: StructResolverFailStopReason,
    ): Promise<StructResolverFailStopReceipt> {
      calls.push({ executionId, reason })
      if (behaviour === 'throw') throw new Error('fail-stop unavailable')
      if (behaviour === 'invalid')
        return {
          protocolVersion: '1.0.0',
          executionId,
          hostTerminated: true,
          descendantsDead: false,
          capacityRetired: true,
          evidence: {
            hostReaped: true,
            descendantCount: 3,
            waitedMs: 1,
            method: 'process-group',
          },
        } as unknown as StructResolverFailStopReceipt
      return {
        protocolVersion: '1.0.0',
        executionId,
        hostTerminated: true,
        descendantsDead: true,
        capacityRetired: true,
        evidence: {
          hostReaped: true,
          descendantCount: 0,
          waitedMs: 1,
          method: 'process-group',
        },
      }
    },
  }
}

/** A request the fake host can answer with a matching resource id. */
export function fixtureRequest(
  overrides: Partial<StructAssetResolutionRequest> = {},
): StructAssetResolutionRequest {
  const policy = httpsPolicy()
  return {
    protocolVersion: '1.0.0',
    logicalHref: 'Text/chapter1.xhtml',
    resourceId: `sha256:${FIXTURE_DIGEST}`,
    expected: {
      id: 'asset-1',
      sha256: FIXTURE_DIGEST,
      mediaType: 'image/png',
      byteLength: 3,
    },
    policy,
    expectedPolicySha256: policyDigest(policy),
    budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
    signal: new AbortController().signal,
    ...overrides,
  }
}
