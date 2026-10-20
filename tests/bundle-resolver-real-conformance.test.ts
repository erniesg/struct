/**
 * Real OS conformance for the published resolver ports.
 *
 * Every case in this file binds the pinned `StructResolverExecutorV1` and
 * `StructResolverHostSupervisorV1` surfaces to a sacrificial Linux user and
 * PID namespace host, and drives them through the portable package driver
 * `resolveStructResolverAssets`.
 *
 * The claims are deliberately narrow and are labelled as such:
 *
 *   * the host realm, the capability drop, the namespace containment, the
 *     pidfd signalling, the lifetime-pipe proof and the descendant census are
 *     proven here against the real operating system;
 *   * the transport is never exercised. The host realm resolves bytes from an
 *     in-memory content-addressed table and publishes an explicitly synthetic
 *     `content-addressed` receipt, so nothing here is evidence of real
 *     network, filesystem or store behaviour;
 *   * the pure protocol rejection rules (swapped identifiers, `quarantined:
 *     false`, an illegal terminal state) are also covered by the portable
 *     in-process fixtures. This file proves the *host binding* for those
 *     rules against a real OS host, not the protocol rules themselves.
 */
import { writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'

import { resolveStructResolverAssets } from '../src/bundle/resolver-execution'
import type {
  StructResolverAssetTarget,
  StructResolverResolutionResult,
} from '../src/bundle/resolver-execution'
import { validateResolverPolicyV1 } from '../src/bundle/resolver-policy'
import type { StructAssetResolutionPolicyV1 } from '../src/bundle/resolver-policy'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from '../src/bundle/limits'
import type {
  StructAssetResolutionRequest,
} from '../src/bundle/resolver-protocol'
import { sha256HexSync } from '../src/sha256'
import { createRealHostPool } from './fixtures/resolver/real-conformance-host'
import type {
  RealHostAsset,
  RealHostPool,
} from './fixtures/resolver/real-conformance-host'

const CASE_TIMEOUT_MS = 120_000

/**
 * The conformance policy. It is a synthetic content-addressed projection: no
 * store, no endpoint map and no filesystem root is ever contacted.
 */
const nonTransportPolicy: StructAssetResolutionPolicyV1 = Object.freeze({
  protocolVersion: '1.0.0',
  profileId: 'nontransport-fixture',
  profileVersion: 'v1',
  maxConcurrent: 1,
  transport: Object.freeze({
    kind: 'content-addressed',
    storeId: 'nontransport-fixture',
    algorithm: 'sha256',
  }),
})

const expectedPolicySha256 = validateResolverPolicyV1(nonTransportPolicy).policySha256

/** One mandatory budget. There is no implicit default in the package. */
const budget = Object.freeze({ totalTimeoutMs: 4000, cleanupReserveMs: 500 })

function targetFor(asset: RealHostAsset): StructResolverAssetTarget {
  return Object.freeze({
    id: asset.id,
    sha256: asset.sha256,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    logicalHref: 'Text/chapter1.xhtml',
  })
}

function requestFor(
  asset: RealHostAsset,
): StructAssetResolutionRequest {
  return {
    protocolVersion: '1.0.0',
    logicalHref: 'Text/chapter1.xhtml',
    resourceId: `sha256:${asset.sha256}`,
    expected: {
      id: asset.id,
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      byteLength: asset.byteLength,
    },
    policy: nonTransportPolicy,
    expectedPolicySha256,
    budget,
    signal: new AbortController().signal,
  }
}

async function withPool(
  options: Parameters<typeof createRealHostPool>[0],
  run: (pool: RealHostPool) => Promise<void>,
): Promise<void> {
  const pool = await createRealHostPool(options)
  try {
    await run(pool)
  } finally {
    await pool.dispose()
  }
}

function expectFailure(
  result: StructResolverResolutionResult,
): { code: string; executionId: string | undefined } {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a failed resolution')
  return { code: result.error.code, executionId: result.error.executionId }
}

/**
 * Machine-readable evidence for the conformance driver.
 *
 * Every entry is a real observation of the parent OS: the driver outcome, the
 * fail-stop reasons the package asked for, the death proof the OS host
 * supervisor produced, the parent ledger and the realm identity.
 */
type CaseEvidence = Readonly<Record<string, unknown>>

const evidence: CaseEvidence[] = []

function record(name: string, data: CaseEvidence): void {
  evidence.push({ case: name, ...data })
}

afterAll(() => {
  const path = process.env.RESOLVER_CONFORMANCE_EVIDENCE
  if (!path) return
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        kind: 'struct-resolver-real-conformance-cases',
        generatedAtUtc: new Date().toISOString(),
        cases: evidence,
      },
      null,
      2,
    )}\n`,
  )
})

describe('real OS resolver conformance', () => {
  it(
    'resolves the exact bytes of an external asset through a real host realm',
    async () => {
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const result = await resolveStructResolverAssets([targetFor(asset)], {
          executor: pool.executor,
          hostSupervisor: pool.hostSupervisor,
          policy: nonTransportPolicy,
          expectedPolicySha256,
          budget,
        })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect([...result.assets.keys()]).toEqual([asset.id])
        const bytes = result.assets.get(asset.id)!
        expect(bytes.byteLength).toBe(asset.byteLength)
        expect(sha256HexSync(bytes)).toBe(asset.sha256)
        // The driver copies every chunk, so the map never aliases the host's
        // own buffer.
        expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype)

        // The host realm ran as PID 1 of a dedicated PID namespace with every
        // capability dropped, and it held no transport authority at all.
        const realm = pool.realm()!
        expect(realm.pid).toBe(1)
        expect(realm.transportAuthority).toBe('none')
        expect(realm.capabilities).toEqual({
          CapAmb: 0,
          CapBnd: 0,
          CapEff: 0,
          CapInh: 0,
          CapPrm: 0,
        })

        // The host observed exactly one start, one revocation, one cleanup and
        // one termination.
        const lifecycle = pool.lifecycle()!
        expect(lifecycle.starts).toBe(1)
        expect(lifecycle.revokes).toBe(1)
        expect(lifecycle.cleanups).toBe(1)
        expect(lifecycle.terminates).toBe(1)
        expect(lifecycle.start_after_revoke).toBe(false)
        expect(lifecycle.start_after_cleanup).toBe(false)
        expect(lifecycle.start_after_terminate).toBe(false)

        // No fail-stop was needed and the identifier is now a tombstone.
        expect(pool.failStopCalls()).toHaveLength(0)
        // The OS host supervisor and the host realm produced no diagnostics.
        expect(pool.stderrText()).toBe('')
        pool.settle('completed')
        const ledger = pool.ledger()
        expect(ledger.freeSlots).toBe(1)
        expect(ledger.retiredSlots).toBe(0)
        expect(Object.values(ledger.tombstones)).toEqual(['TERMINAL_COMPLETED'])
        record('conforming_resolution', {
          outcome: 'completed',
          assetId: asset.id,
          byteLength: asset.byteLength,
          sha256: asset.sha256,
          realm: pool.realm(),
          lifecycle: pool.lifecycle(),
          failStopCalls: pool.failStopCalls(),
          ledger,
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'fails closed and proves the host dead when cleanup never settles',
    async () => {
      await withPool({ mode: 'never_settle_cleanup', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const result = await resolveStructResolverAssets([targetFor(asset)], {
          executor: pool.executor,
          hostSupervisor: pool.hostSupervisor,
          policy: nonTransportPolicy,
          expectedPolicySha256,
          budget,
        })

        const failure = expectFailure(result)
        expect(failure.code).toBe('CLEANUP')
        expect(failure.executionId).toBeTruthy()

        // The parent asked for a fail-stop and the parent proved it.
        const calls = pool.failStopCalls()
        expect(calls).toHaveLength(1)
        expect(calls[0]!.reason).toBe('CLEANUP_TIMEOUT')
        expect(calls[0]!.executionId).toBe(failure.executionId)

        const proof = pool.failStopProofs()[0]!
        expect(proof.lifetime_pipe_eof).toBe(true)
        expect(proof.descendant_count).toBe(0)
        expect(proof.ns_members_outer_visible_after_death).toEqual([])
        expect(proof.launcher_reaped).toBe(true)
        expect(proof.host_status).toBeTruthy()
        expect(proof.method).toBe('pid-namespace')
        expect(Number(proof.waited_ms)).toBeGreaterThanOrEqual(0)

        // The implicated capacity is permanently retired and the identifier is
        // an immutable tombstone.
        pool.settle('failed')
        const ledger = pool.ledger()
        expect(ledger.retiredSlots).toBe(1)
        expect(ledger.slots[0]!.state).toBe('retired')
        expect(ledger.tombstones[failure.executionId!]).toBeTruthy()
        expect(ledger.freeSlots).toBe(0)
        record('never_settling_cleanup', {
          outcome: failure.code,
          executionId: failure.executionId,
          failStopCalls: pool.failStopCalls(),
          proof,
          realm: pool.realm(),
          ledger,
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'fails closed and proves the host dead when the terminate and join never settle',
    async () => {
      await withPool({ mode: 'never_settle_join', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const result = await resolveStructResolverAssets([targetFor(asset)], {
          executor: pool.executor,
          hostSupervisor: pool.hostSupervisor,
          policy: nonTransportPolicy,
          expectedPolicySha256,
          budget,
        })

        const failure = expectFailure(result)
        expect(failure.code).toBe('TERMINAL')
        expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
          'TERMINAL_TIMEOUT',
        ])

        const proof = pool.failStopProofs()[0]!
        expect(proof.lifetime_pipe_eof).toBe(true)
        expect(proof.descendant_count).toBe(0)
        expect(proof.ns_members_outer_visible_after_death).toEqual([])
        expect(proof.launcher_reaped).toBe(true)

        pool.settle('failed')
        expect(pool.ledger().retiredSlots).toBe(1)
        record('never_settling_join', {
          outcome: failure.code,
          executionId: failure.executionId,
          failStopCalls: pool.failStopCalls(),
          proof,
          realm: pool.realm(),
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'contains a daemonized descendant that escaped the host process group',
    async () => {
      await withPool({ mode: 'daemon_escape', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const result = await resolveStructResolverAssets([targetFor(asset)], {
          executor: pool.executor,
          hostSupervisor: pool.hostSupervisor,
          policy: nonTransportPolicy,
          expectedPolicySha256,
          budget,
        })

        const failure = expectFailure(result)
        const proof = pool.failStopProofs()[0]!
        // The descendant was alive inside the dedicated namespace while the
        // host was killed, and it is gone afterwards.
        const before = proof.ns_members_outer_visible_before_kill as number[]
        expect(before.length).toBeGreaterThanOrEqual(2)
        expect(proof.ns_members_outer_visible_after_death).toEqual([])
        expect(proof.descendant_count).toBe(0)
        // The descendant held the lifetime descriptor, so the end-of-file is a
        // kernel-level proof that it died with the namespace.
        expect(proof.lifetime_pipe_eof).toBe(true)
        expect(proof.escalated_to_sigkill).toBe(true)

        pool.settle('failed')
        expect(pool.ledger().retiredSlots).toBe(1)
        record('daemonized_escaped_descendant', {
          outcome: failure.code,
          executionId: failure.executionId,
          failStopCalls: pool.failStopCalls(),
          proof,
          realm: pool.realm(),
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'never reopens a retired slot under aggregate pressure',
    async () => {
      // The first execution never settles its cleanup; the second one is
      // healthy. The mode is chosen per execution, in admission order.
      const modes = ['never_settle_cleanup', 'conformant']
      let admission = 0
      await withPool(
        {
          slots: 2,
          mode: () => modes[Math.min(admission++, modes.length - 1)]!,
        },
        async (pool) => {
          const asset = pool.assets[0]!

          // The outer host pool has two slots. The frozen profile concurrency
          // is still one, so one resolution call resolves its assets serially.
          expect(pool.ledger().slots).toHaveLength(2)
          expect(nonTransportPolicy.maxConcurrent).toBe(1)
          expect(STRUCT_BUNDLE_LIMITS_PROFILE.maxConcurrency).toBe(1)

          // The first execution escalates to the parent fail-stop, so the
          // parent retires the implicated slot permanently.
          const first = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })
          const firstFailure = expectFailure(first)
          expect(firstFailure.code).toBe('CLEANUP')
          expect(pool.failStopCalls()).toHaveLength(1)
          pool.settle('failed')
          const afterFirst = pool.ledger()
          expect(afterFirst.retiredSlots).toBe(1)
          expect(afterFirst.slots[0]!.state).toBe('retired')
          expect(afterFirst.tombstones[firstFailure.executionId!]).toBeTruthy()

          // A fresh execution is admitted on the other slot. The retired slot
          // is never handed out again.
          const second = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })
          expect(second.ok).toBe(true)
          const secondId = [...pool.ledger().slots]
            .filter((slot) => slot.state === 'held')
            .map((slot) => slot.executionId)[0]
          expect(secondId).toBeTruthy()
          expect(secondId).not.toBe(firstFailure.executionId)
          const ledgerDuring = pool.ledger()
          const held = ledgerDuring.slots.find((slot) => slot.executionId === secondId)
          expect(held?.index).toBe(1)
          pool.settle('completed')

          // With one slot retired and one slot released, the pool has one free
          // slot and the retired capacity is still gone for good.
          const ledger = pool.ledger()
          expect(ledger.retiredSlots).toBe(1)
          expect(ledger.freeSlots).toBe(1)
          expect(ledger.slots[0]!.state).toBe('retired')
          expect(ledger.tombstones[firstFailure.executionId!]).toBeTruthy()
          record('aggregate_pressure_retired_slot', {
            firstOutcome: firstFailure.code,
            firstExecutionId: firstFailure.executionId,
            secondExecutionId: secondId,
            secondSlotIndex: held?.index,
            failStopCalls: pool.failStopCalls(),
            proofs: pool.failStopProofs(),
            ledger,
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'rejects a revocation receipt that is bound to a foreign identifier',
    async () => {
      await withPool(
        { mode: 'nonconforming_revocation_id', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const result = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })

          const failure = expectFailure(result)
          expect(failure.code).toBe('REVOCATION')
          expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
            'REVOCATION_RECEIPT',
          ])
          const proof = pool.failStopProofs()[0]!
          expect(proof.lifetime_pipe_eof).toBe(true)
          expect(proof.descendant_count).toBe(0)
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('nonconforming_revocation_id', {
            outcome: failure.code,
            executionId: failure.executionId,
            failStopCalls: pool.failStopCalls(),
            proof,
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'rejects a terminal receipt that is bound to a foreign identifier',
    async () => {
      await withPool(
        { mode: 'nonconforming_terminal_id', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const result = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })

          const failure = expectFailure(result)
          expect(failure.code).toBe('TERMINAL')
          expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
            'TERMINAL_RECEIPT',
          ])
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('nonconforming_terminal_id', {
            outcome: failure.code,
            executionId: failure.executionId,
            failStopCalls: pool.failStopCalls(),
            proofs: pool.failStopProofs(),
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'rejects a terminal receipt that reports the wrong terminal state',
    async () => {
      await withPool(
        { mode: 'nonconforming_terminal_state', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const result = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })

          const failure = expectFailure(result)
          expect(failure.code).toBe('TERMINAL')
          expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
            'TERMINAL_RECEIPT',
          ])
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('nonconforming_terminal_state', {
            outcome: failure.code,
            executionId: failure.executionId,
            failStopCalls: pool.failStopCalls(),
            proofs: pool.failStopProofs(),
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'rejects a transport receipt that aliases a foreign policy digest',
    async () => {
      await withPool(
        { mode: 'nonconforming_transport_alias', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const result = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })

          const failure = expectFailure(result)
          expect(failure.code).toBe('RECEIPT')
          expect(result.ok).toBe(false)
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('nonconforming_transport_alias', {
            outcome: failure.code,
            executionId: failure.executionId,
            failStopCalls: pool.failStopCalls(),
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'rejects an unconstrained chunk stream that exceeds the declared length',
    async () => {
      await withPool(
        { mode: 'nonconforming_unconstrained_stream', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const result = await resolveStructResolverAssets([targetFor(asset)], {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          })

          const failure = expectFailure(result)
          expect(['LIMIT', 'LENGTH']).toContain(failure.code)
          expect(result.ok).toBe(false)
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('nonconforming_unconstrained_stream', {
            outcome: failure.code,
            executionId: failure.executionId,
            failStopCalls: pool.failStopCalls(),
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'refuses a second start of the same execution against a real host realm',
    async () => {
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const handle = pool.executor.allocate(requestFor(asset))
        const started = await handle.start()
        expect(started.resourceId).toBe(`sha256:${asset.sha256}`)
        await expect(handle.start()).rejects.toBeTruthy()
        expect(pool.lifecycle()?.starts).toBe(1)
        await handle.control.terminateAndJoin()
        pool.settle('completed')
        record('one_shot_start', {
          executionId: handle.control.executionId,
          lifecycle: pool.lifecycle(),
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'refuses a start after the revocation receipt was accepted',
    async () => {
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const handle = pool.executor.allocate(requestFor(asset))
        const receipt = handle.control.revokeAndQuarantine()
        expect(receipt.executionId).toBe(handle.control.executionId)
        expect(receipt.capabilitiesRevoked).toBe(true)
        expect(receipt.quarantined).toBe(true)
        await expect(handle.start()).rejects.toBeTruthy()
        // The host realm was never asked to resolve anything.
        expect(pool.lifecycle()?.starts ?? 0).toBe(0)
        pool.settle('failed')
        record('start_after_revocation', {
          executionId: handle.control.executionId,
          revocationReceipt: receipt,
          lifecycle: pool.lifecycle(),
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'refuses a duplicate execution identifier before any host realm exists',
    async () => {
      await withPool(
        {
          mode: 'conformant',
          slots: 2,
          executionIdSource: () => 'exec-fixed-duplicate',
        },
        async (pool) => {
          const asset = pool.assets[0]!
          const first = pool.executor.allocate(requestFor(asset))
          expect(first.control.executionId).toBe('exec-fixed-duplicate')
          // The second allocation must be refused before a host realm exists.
          expect(() => pool.executor.allocate(requestFor(asset))).toThrow()
          // The first execution is untouched.
          expect(pool.ledger().slots[0]!.state).toBe('held')
          pool.settle('failed')
          record('duplicate_execution_identifier', {
            executionId: first.control.executionId,
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )
})
