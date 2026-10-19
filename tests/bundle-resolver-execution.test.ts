import { describe, expect, it } from 'vitest'
import { sha256HexSync } from '../src/sha256'
import {
  resolveStructResolverAssets,
  selectStructResolverTargets,
} from '../src/bundle/resolver-execution'
import type {
  StructResolverAssetTarget,
  StructResolverExecutionOptions,
} from '../src/bundle/resolver-execution'
import { StructResolverProtocolError } from '../src/bundle/resolver-protocol'
import type { StructResolverExecutorV1 } from '../src/bundle/resolver-protocol'
import {
  createFakeHostSupervisor,
  createFakeSupervisor,
  httpsPolicy,
  policyDigest,
} from './fixtures/resolver/fake-host'
import type { FakeHostBehaviour } from './fixtures/resolver/fake-host'

const payload = new Uint8Array([1, 2, 3])
const payloadDigest = sha256HexSync(payload)

const target = (overrides: Partial<StructResolverAssetTarget> = {}): StructResolverAssetTarget => ({
  id: 'asset-1',
  sha256: payloadDigest,
  mediaType: 'image/png',
  byteLength: payload.byteLength,
  logicalHref: 'Text/chapter1.xhtml',
  ...overrides,
})

const options = (
  overrides: Partial<StructResolverExecutionOptions> = {},
): StructResolverExecutionOptions => {
  const policy = httpsPolicy()
  return {
    executor: createFakeSupervisor().executor,
    hostSupervisor: createFakeHostSupervisor(),
    policy,
    expectedPolicySha256: policyDigest(policy),
    budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
    ...overrides,
  }
}

describe('adversarial pilot: late start completion after a timeout', () => {
  it('quarantines the late result and never publishes it', async () => {
    const supervisor = createFakeSupervisor(() => ({
      start: 'resolve',
      startDelayMs: 400,
    }))
    const host = createFakeHostSupervisor()
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      hostSupervisor: host,
      policy,
      expectedPolicySha256: policyDigest(policy),
      budget: { totalTimeoutMs: 120, cleanupReserveMs: 40 },
    }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TIMEOUT')
    expect(result.error.executionId).toBeTruthy()
    // The late result is quarantined: the host was asked to stop, the
    // execution was joined, and the identifier is now a permanent tombstone.
    const hostFixture = supervisor.hosts[0]!
    expect(hostFixture.calls.start).toBe(1)
    expect(hostFixture.calls.revoke).toBe(1)
    expect(hostFixture.calls.cleanup).toBe(1)
    expect(hostFixture.calls.terminate).toBe(1)
    expect(supervisor.isRetired(result.error.executionId!)).toBe(true)
    expect(host.calls).toHaveLength(0)
  })
})

describe('adversarial pilot: execution identity collision and retired reuse', () => {
  it('refuses a duplicate identifier before any host is bound', () => {
    let issued = 0
    const supervisor = createFakeSupervisor(() => ({}), {
      executionIdSource: () => `exec-fixed-${issued++}`,
    })
    const policy = httpsPolicy()
    const request = {
      protocolVersion: '1.0.0' as const,
      logicalHref: 'Text/chapter1.xhtml',
      resourceId: `sha256:${payloadDigest}` as `sha256:${string}`,
      expected: {
        id: 'asset-1',
        sha256: payloadDigest,
        mediaType: 'image/png',
        byteLength: payload.byteLength,
      },
      policy,
      expectedPolicySha256: policyDigest(policy),
      budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      signal: new AbortController().signal,
    }
    const first = supervisor.executor.allocate(request)
    expect(() => supervisor.executor.allocate(request)).toThrow(
      StructResolverProtocolError,
    )
    // The rejected allocation never bound a host, so no authority was granted.
    expect(supervisor.hosts).toHaveLength(1)
    expect(supervisor.activeCapacity()).toBe(1)
    void first
  })

  it('refuses a retired identifier after a termination', async () => {
    const supervisor = createFakeSupervisor(() => ({}), {
      executionIdSource: () => 'exec-retired',
    })
    const policy = httpsPolicy()
    const request = {
      protocolVersion: '1.0.0' as const,
      logicalHref: 'Text/chapter1.xhtml',
      resourceId: `sha256:${payloadDigest}` as `sha256:${string}`,
      expected: {
        id: 'asset-1',
        sha256: payloadDigest,
        mediaType: 'image/png',
        byteLength: payload.byteLength,
      },
      policy,
      expectedPolicySha256: policyDigest(policy),
      budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      signal: new AbortController().signal,
    }
    const handle = supervisor.executor.allocate(request)
    await handle.control.terminateAndJoin()
    expect(supervisor.isRetired('exec-retired')).toBe(true)
    expect(() => supervisor.executor.allocate(request)).toThrow(
      StructResolverProtocolError,
    )
    expect(supervisor.hosts).toHaveLength(1)
  })
})

describe('adversarial pilot: aggregate pressure admission', () => {
  it('denies the allocation beyond the policy concurrency', () => {
    const supervisor = createFakeSupervisor(() => ({}))
    const policy = httpsPolicy(1)
    const request = {
      protocolVersion: '1.0.0' as const,
      logicalHref: 'Text/chapter1.xhtml',
      resourceId: `sha256:${payloadDigest}` as `sha256:${string}`,
      expected: {
        id: 'asset-1',
        sha256: payloadDigest,
        mediaType: 'image/png',
        byteLength: payload.byteLength,
      },
      policy,
      expectedPolicySha256: policyDigest(policy),
      budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      signal: new AbortController().signal,
    }
    supervisor.executor.allocate(request)
    expect(() => supervisor.executor.allocate(request)).toThrow(
      StructResolverProtocolError,
    )
    expect(supervisor.hosts).toHaveLength(1)
  })

  it('never starts a second asset after the work deadline', async () => {
    const supervisor = createFakeSupervisor(() => ({ start: 'hang' }))
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets(
      [target({ id: 'asset-1' }), target({ id: 'asset-2' })],
      options({
        executor: supervisor.executor,
        policy,
        expectedPolicySha256: policyDigest(policy),
        budget: { totalTimeoutMs: 120, cleanupReserveMs: 40 },
      }),
    )
    expect(result.ok).toBe(false)
    // The first execution hung and was torn down; the second asset never
    // started because the resolution stopped at the first failure.
    expect(supervisor.hosts).toHaveLength(1)
    expect(supervisor.hosts[0]!.calls.start).toBe(1)
  })
})

describe('adversarial pilot: swapped receipts between executions', () => {
  it('fails closed on a foreign revocation receipt and escalates', async () => {
    const behaviours: FakeHostBehaviour[] = [
      { revoke: 'accept' },
      { revoke: 'swapped-id' },
    ]
    let index = 0
    const supervisor = createFakeSupervisor(() => behaviours[Math.min(index++, 1)]!)
    const host = createFakeHostSupervisor()
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets(
      [target({ id: 'asset-1' }), target({ id: 'asset-2' })],
      options({
        executor: supervisor.executor,
        hostSupervisor: host,
        policy,
        expectedPolicySha256: policyDigest(policy),
        budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('REVOCATION')
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.reason).toBe('REVOCATION_RECEIPT')
  })
})

describe('adversarial pilot: never-settling cleanup and join', () => {
  it('never reports a hanging cleanup as a normal termination', async () => {
    const supervisor = createFakeSupervisor(() => ({ cleanup: 'hang' }))
    const host = createFakeHostSupervisor()
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      hostSupervisor: host,
      policy,
      expectedPolicySha256: policyDigest(policy),
      budget: { totalTimeoutMs: 150, cleanupReserveMs: 40 },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CLEANUP')
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.reason).toBe('CLEANUP_TIMEOUT')
  })

  it('never reports a hanging join as a normal termination', async () => {
    const supervisor = createFakeSupervisor(() => ({ terminate: 'hang' }))
    const host = createFakeHostSupervisor()
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      hostSupervisor: host,
      policy,
      expectedPolicySha256: policyDigest(policy),
      budget: { totalTimeoutMs: 150, cleanupReserveMs: 40 },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TERMINAL')
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.reason).toBe('TERMINAL_TIMEOUT')
  })
})

describe('resolver execution success path', () => {
  it('resolves an asset, verifies the digest, and tears down in order', async () => {
    const supervisor = createFakeSupervisor(() => ({}))
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      policy,
      expectedPolicySha256: policyDigest(policy),
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.assets.get('asset-1')).toEqual(payload)
    const host = supervisor.hosts[0]!
    expect(host.order).toEqual(['start', 'revoke', 'cleanup', 'terminate'])
    expect(host.abortedAtRevoke).toBe(true)
    expect(host.calls.brokerGrantsAfterRevocation).toBe(0)
  })
})

describe('external target selection', () => {
  it('keeps only external payloads and binds the content address', () => {
    const targets = selectStructResolverTargets(
      [{ id: 'a', href: 'Text/a.xhtml', mediaType: 'image/png', sha256: payloadDigest }],
      [
        {
          id: 'a',
          sha256: payloadDigest,
          mediaType: 'image/png',
          byteLength: 3,
          payload: { kind: 'external', resourceId: `sha256:${payloadDigest}` },
        },
        {
          id: 'b',
          sha256: payloadDigest,
          mediaType: 'image/png',
          byteLength: 3,
          payload: { kind: 'embedded', base64: 'AQID' },
        },
      ],
    )
    expect(targets).toHaveLength(1)
    expect(targets[0]!.id).toBe('a')
    expect(targets[0]!.logicalHref).toBe('Text/a.xhtml')
  })

  it('rejects a resource id that is not the content address', () => {
    expect(() => selectStructResolverTargets(
      [{ id: 'a', href: 'Text/a.xhtml', mediaType: 'image/png', sha256: payloadDigest }],
      [{
        id: 'a',
        sha256: payloadDigest,
        mediaType: 'image/png',
        byteLength: 3,
        payload: { kind: 'external', resourceId: `sha256:${'b'.repeat(64)}` },
      }],
    )).toThrow(StructResolverProtocolError)
  })
})

describe('execution preflight', () => {
  it('refuses a policy digest that disagrees with the policy', async () => {
    const supervisor = createFakeSupervisor(() => ({}))
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      policy,
      expectedPolicySha256: 'b'.repeat(64),
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('POLICY')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('refuses an unusable budget before any allocation', async () => {
    const supervisor = createFakeSupervisor(() => ({}))
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      budget: { totalTimeoutMs: 100, cleanupReserveMs: 100 },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BUDGET')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('refuses a malformed target before any allocation', async () => {
    const supervisor = createFakeSupervisor(() => ({}))
    const result = await resolveStructResolverAssets(
      [{ id: 'a', sha256: 'not-a-digest', mediaType: 'image/png', byteLength: 3, logicalHref: 'Text/a.xhtml' } as never],
      options({ executor: supervisor.executor }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TARGET')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('refuses an incomplete option set before any allocation', async () => {
    const supervisor = createFakeSupervisor(() => ({}))
    const result = await resolveStructResolverAssets(
      [target()],
      { executor: supervisor.executor } as never,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('OPTIONS')
    expect(supervisor.hosts).toHaveLength(0)
  })
})

describe('execution startup outcomes', () => {
  it('tears down a synchronous startup throw', async () => {
    const supervisor = createFakeSupervisor(() => ({ start: 'throw' }))
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('START')
    const host = supervisor.hosts[0]!
    expect(host.order).toEqual(['start', 'revoke', 'cleanup', 'terminate'])
  })

  it('tears down a rejected startup', async () => {
    const supervisor = createFakeSupervisor(() => ({ start: 'reject' }))
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('START')
    expect(supervisor.hosts[0]!.order).toEqual(['start', 'revoke', 'cleanup', 'terminate'])
  })

  it('tears down a startup that never settles', async () => {
    const supervisor = createFakeSupervisor(() => ({ start: 'hang' }))
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      budget: { totalTimeoutMs: 120, cleanupReserveMs: 40 },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TIMEOUT')
    expect(supervisor.hosts[0]!.calls.terminate).toBe(1)
  })
})

describe('execution stream bounds', () => {
  const runWith = async (
    behaviour: FakeHostBehaviour,
    targetOverrides: Partial<StructResolverAssetTarget> = {},
  ) => {
    const supervisor = createFakeSupervisor(() => behaviour)
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets(
      [target(targetOverrides)],
      options({
        executor: supervisor.executor,
        policy,
        expectedPolicySha256: policyDigest(policy),
      }),
    )
    return { result, supervisor }
  }

  it('rejects a chunk that is not a byte view', async () => {
    const { result } = await runWith({ nonByteChunk: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('STREAM')
  })

  it('rejects a failing chunk stream', async () => {
    const { result } = await runWith({ chunkError: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('STREAM')
  })

  it('rejects a short stream on the exact length', async () => {
    const { result } = await runWith({ chunks: [new Uint8Array([1])] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('LENGTH')
  })

  it('rejects a stream longer than the declared length', async () => {
    const { result } = await runWith({
      chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('LIMIT')
  })

  it('rejects bytes that do not match the expected digest', async () => {
    const { result } = await runWith({}, { sha256: 'b'.repeat(64) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('DIGEST')
  })

  it('rejects a transport receipt that names a foreign endpoint', async () => {
    const { result } = await runWith({ receiptEndpointId: 'c' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RECEIPT')
  })

  it('rejects a transport receipt that echoes a foreign policy digest', async () => {
    const { result } = await runWith({ receiptPolicySha256: 'c'.repeat(64) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RECEIPT')
  })

  it('rejects a declared length that disagrees with the expected length', async () => {
    const { result } = await runWith({ declaredByteLength: 99 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RECEIPT')
  })
})

describe('execution cancellation and fail-stop escalation', () => {
  it('reports an aborted resolution and still tears down', async () => {
    const supervisor = createFakeSupervisor(() => ({ chunks: [payload] }))
    const policy = httpsPolicy()
    const controller = new AbortController()
    controller.abort()
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      policy,
      expectedPolicySha256: policyDigest(policy),
      signal: controller.signal,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ABORTED')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('fails closed when the parent fail-stop port is unavailable', async () => {
    const supervisor = createFakeSupervisor(() => ({ revoke: 'throw' }))
    const host = createFakeHostSupervisor('throw')
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      hostSupervisor: host,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('FAIL_STOP')
  })

  it('fails closed when the parent fail-stop evidence is invalid', async () => {
    const supervisor = createFakeSupervisor(() => ({ revoke: 'throw' }))
    const host = createFakeHostSupervisor('invalid')
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
      hostSupervisor: host,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('FAIL_STOP')
  })
})

describe('execution iterator handling', () => {
  type Recorder = {
    order: string[]
    iteratorReturned: number
  }

  const recordingExecutor = (
    recorder: Recorder,
    result: boolean,
  ): StructResolverExecutorV1 => ({
    allocate(request) {
      const executionId = 'exec-recorder'
      const control = {
        executionId,
        revokeAndQuarantine: () => {
          recorder.order.push('revoke')
          return {
            executionId,
            capabilitiesRevoked: true,
            quarantined: true,
          } as const
        },
        cleanup: async () => {
          recorder.order.push('cleanup')
        },
        terminateAndJoin: async () => {
          recorder.order.push('terminate')
          return { executionId, state: 'completed' as const }
        },
      }
      return {
        control,
        start: async () => {
          recorder.order.push('start')
          if (!result) throw new Error('no result')
          return {
            protocolVersion: '1.0.0' as const,
            resourceId: `sha256:${request.expected.sha256}` as `sha256:${string}`,
            chunks: {
              [Symbol.asyncIterator]() {
                let done = false
                return {
                  async next() {
                    if (done) return { done: true, value: undefined }
                    done = true
                    return { done: false, value: payload }
                  },
                  async return() {
                    recorder.iteratorReturned += 1
                    recorder.order.push('iteratorReturn')
                    return { done: true, value: undefined }
                  },
                }
              },
            },
            transportReceipt: {
              kind: 'https' as const,
              policySha256: request.expectedPolicySha256,
              endpointMapId: 'map-1',
              endpointId: 'a',
              redirectEndpointIds: ['b'],
            },
          }
        },
      }
    },
  })

  it('returns the chunk iterator only after a result exists and before cleanup', async () => {
    const recorder: Recorder = { order: [], iteratorReturned: 0 }
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: recordingExecutor(recorder, true),
      policy,
      expectedPolicySha256: policyDigest(policy),
    }))
    expect(result.ok).toBe(true)
    expect(recorder.iteratorReturned).toBe(1)
    expect(recorder.order).toEqual([
      'start',
      'revoke',
      'iteratorReturn',
      'cleanup',
      'terminate',
    ])
  })

  it('never returns an iterator that does not exist', async () => {
    const recorder: Recorder = { order: [], iteratorReturned: 0 }
    const policy = httpsPolicy()
    const result = await resolveStructResolverAssets([target()], options({
      executor: recordingExecutor(recorder, false),
      policy,
      expectedPolicySha256: policyDigest(policy),
    }))
    expect(result.ok).toBe(false)
    expect(recorder.iteratorReturned).toBe(0)
    expect(recorder.order).toEqual(['start', 'revoke', 'cleanup', 'terminate'])
  })
})

describe('execution failure hygiene', () => {
  it('carries only a code and an opaque identifier', async () => {
    const supervisor = createFakeSupervisor(() => ({ revoke: 'throw' }))
    const result = await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    const serialized = JSON.stringify(result.error)
    expect(serialized).not.toMatch(/https?:\/\//u)
    expect(serialized).not.toMatch(/secret|token|password|credential/iu)
    expect(Object.keys(result.error).sort()).toEqual(['code', 'executionId'])
  })

  it('does not retain the request payload after a failure', async () => {
    const supervisor = createFakeSupervisor(() => ({ revoke: 'throw' }))
    await resolveStructResolverAssets([target()], options({
      executor: supervisor.executor,
    }))
    const request = supervisor.requests[0]!
    expect(Object.keys(request)).toEqual([
      'protocolVersion',
      'logicalHref',
      'resourceId',
      'expected',
      'policy',
      'expectedPolicySha256',
      'budget',
      'signal',
    ])
  })
})
