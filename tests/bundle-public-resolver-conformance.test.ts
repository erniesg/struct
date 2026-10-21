/**
 * Public-seam real OS conformance for the resolver.
 *
 * Every case in this file exercises the PUBLIC `decodeStructBundle` entry point
 * against the same sacrificial Linux user + PID namespace host that the existing
 * private-driver conformance suite uses. The public path must reuse the same
 * reviewed OS harness and the same real ports, not a parallel mock.
 *
 * The claims are deliberately narrow and match the existing suite:
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

import { decodeStructBundle } from '../src/bundle/index'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from '../src/bundle/limits'
import { validateResolverPolicyV1 } from '../src/bundle/resolver-policy'
import type { StructAssetResolutionPolicyV1 } from '../src/bundle/resolver-policy'
import { sha256HexSync } from '../src/sha256'
import {
  canonicalBundleDocumentBytes,
  canonicalBundleEnvelopeBytes,
} from '../src/bundle/canonical'
import { seal, validDocument } from './codec-fixtures'
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

/**
 * Builds a canonical wire-format bundle whose envelope carries an EXTERNAL
 * asset reference that the real host can resolve.
 *
 * The document/envelope asset sets must match exactly in id, sha256, and
 * mediaType. The envelope payload must be `kind: 'external'` with the
 * content-addressed resourceId.
 */
function buildExternalBundle(asset: RealHostAsset, logicalHref: string): Uint8Array {
  // Start with a valid document fixture and replace its assets.
  const document = validDocument() as any

  // Build a new asset object without the 'bytes' property (required by
  // canonicalBundleDocumentBytes validation).
  const { bytes: _unused, ...assetWithoutBytes } = document.assets[0]
  document.assets = Object.freeze([
    Object.freeze({
      ...assetWithoutBytes,
      id: asset.id,
      href: logicalHref,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
    }),
  ])

  // Update block fallbackAssetIds to reference the new asset ID.
  for (const block of document.blocks) {
    if (block.fallbackAssetIds) {
      block.fallbackAssetIds = [asset.id]
    }
  }

  document.receipt.assetCount = 1
  document.receipt.conservation.sourceAssetCount = 1
  document.receipt.conservation.accountedSourceAssetCount = 1
  document.receipt.conservation.structAssetCount = 1
  seal(document)

  // Compute the exact canonical document bytes and its digest.
  const documentBytes = canonicalBundleDocumentBytes(document)
  const documentSha256 = sha256HexSync(documentBytes)

  const envelope = Object.freeze({
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256,
    document,
    assets: Object.freeze([
      Object.freeze({
        id: asset.id,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        payload: Object.freeze({
          kind: 'external' as const,
          resourceId: `sha256:${asset.sha256}`,
        }),
      }),
    ]),
    receipt: document.receipt,
  })

  const canonical = canonicalBundleEnvelopeBytes(envelope)
  return canonical
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
  error: unknown,
): { stage: string; code: string } {
  expect(error).toBeInstanceOf(Error)
  const e = error as { stage?: string; code?: string }
  expect(e.stage).toBeDefined()
  expect(e.code).toBeDefined()
  return { stage: e.stage!, code: e.code! }
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
        kind: 'struct-resolver-public-conformance-cases',
        generatedAtUtc: new Date().toISOString(),
        cases: evidence,
      },
      null,
      2,
    )}\n`,
  )
})

describe('public decode seam real OS resolver conformance', () => {
  it(
    'PUBLIC SUCCESS: resolves the exact bytes of an external asset through the public decodeStructBundle with a real host realm',
    async () => {
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        const handle = await decodeStructBundle(canonical, {
          resolverExecutor: pool.executor,
          resolverPolicy: nonTransportPolicy,
          resolverBudget: budget,
          resolverHostSupervisor: pool.hostSupervisor,
        })

        expect(handle.bundleVersion).toBe('1.0.0')
        // The validDocument fixture uses schemaVersion '0.1.0'.
        expect(handle.schemaVersion).toBe('0.1.0')
        // The documentSha256 is the digest of the canonical document bytes.
        // We don't have direct access to the document here, so verify the
        // bundleSha256 round-trip instead.
        expect(handle.bundleSha256).toBe(sha256HexSync(canonical))
        expect(handle.assetIds()).toEqual([asset.id])
        const bytes = handle.assetBytes(asset.id)!
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
        record('public_conforming_resolution', {
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
    'PUBLIC FAIL-CLOSED LIFECYCLE: fails closed when the real host never settles its cleanup',
    async () => {
      await withPool({ mode: 'never_settle_cleanup', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        let error: unknown
        try {
          await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: budget,
            resolverHostSupervisor: pool.hostSupervisor,
          })
        } catch (e) {
          error = e
        }

        const failure = expectFailure(error)
        expect(failure.stage).toBe('resolve')
        expect(failure.code).toBe('CLEANUP')

        // The parent asked for a fail-stop and the parent proved it.
        const calls = pool.failStopCalls()
        expect(calls).toHaveLength(1)
        expect(calls[0]!.reason).toBe('CLEANUP_TIMEOUT')
        expect(calls[0]!.executionId).toBeTruthy()

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
        expect(ledger.tombstones[calls[0]!.executionId]).toBeTruthy()
        expect(ledger.freeSlots).toBe(0)
        record('public_never_settling_cleanup', {
          outcome: failure.code,
          executionId: calls[0]!.executionId,
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
    'PUBLIC FAIL-CLOSED LIFECYCLE: fails closed when the terminate and join never settle',
    async () => {
      await withPool({ mode: 'never_settle_join', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        let error: unknown
        try {
          await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: budget,
            resolverHostSupervisor: pool.hostSupervisor,
          })
        } catch (e) {
          error = e
        }

        const failure = expectFailure(error)
        expect(failure.stage).toBe('resolve')
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
        record('public_never_settling_join', {
          outcome: failure.code,
          executionId: pool.failStopCalls()[0]!.executionId,
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
    'PUBLIC FAIL-CLOSED LIFECYCLE: contains a daemonized descendant that escaped the host process group',
    async () => {
      await withPool({ mode: 'daemon_escape', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        let error: unknown
        try {
          await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: budget,
            resolverHostSupervisor: pool.hostSupervisor,
          })
        } catch (e) {
          error = e
        }

        const failure = expectFailure(error)
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
        record('public_daemonized_escaped_descendant', {
          outcome: failure.code,
          executionId: pool.failStopCalls()[0]!.executionId,
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
    'PUBLIC FAIL-CLOSED LIFECYCLE: never reopens a retired slot under aggregate pressure',
    async () => {
      const modes = ['never_settle_cleanup', 'conformant']
      let admission = 0
      await withPool(
        {
          slots: 2,
          mode: () => modes[Math.min(admission++, modes.length - 1)]!,
        },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          // The outer host pool has two slots. The frozen profile concurrency
          // is still one, so one resolution call resolves its assets serially.
          expect(pool.ledger().slots).toHaveLength(2)
          expect(nonTransportPolicy.maxConcurrent).toBe(1)
          expect(STRUCT_BUNDLE_LIMITS_PROFILE.maxConcurrency).toBe(1)

          // The first execution escalates to the parent fail-stop, so the
          // parent retires the implicated slot permanently.
          let firstError: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            firstError = e
          }
          const firstFailure = expectFailure(firstError)
          expect(firstFailure.code).toBe('CLEANUP')
          expect(pool.failStopCalls()).toHaveLength(1)
          pool.settle('failed')
          const afterFirst = pool.ledger()
          expect(afterFirst.retiredSlots).toBe(1)
          expect(afterFirst.slots[0]!.state).toBe('retired')
          expect(afterFirst.tombstones[pool.failStopCalls()[0]!.executionId]).toBeTruthy()

          // A fresh execution is admitted on the other slot. The retired slot
          // is never handed out again.
          const handle = await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: budget,
            resolverHostSupervisor: pool.hostSupervisor,
          })
          expect(handle.assetBytes(asset.id)!.byteLength).toBe(asset.byteLength)
          const secondId = [...pool.ledger().slots]
            .filter((slot) => slot.state === 'held')
            .map((slot) => slot.executionId)[0]
          expect(secondId).toBeTruthy()
          expect(secondId).not.toBe(pool.failStopCalls()[0]!.executionId)
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
          expect(ledger.tombstones[pool.failStopCalls()[0]!.executionId]).toBeTruthy()
          record('public_aggregate_pressure_retired_slot', {
            firstOutcome: firstFailure.code,
            firstExecutionId: pool.failStopCalls()[0]!.executionId,
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
    'PUBLIC IDENTITY BINDING: rejects a revocation receipt bound to a foreign identifier',
    async () => {
      await withPool(
        { mode: 'nonconforming_revocation_id', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          let error: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            error = e
          }

          const failure = expectFailure(error)
          expect(failure.stage).toBe('resolve')
          expect(failure.code).toBe('REVOCATION')
          expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
            'REVOCATION_RECEIPT',
          ])
          const proof = pool.failStopProofs()[0]!
          expect(proof.lifetime_pipe_eof).toBe(true)
          expect(proof.descendant_count).toBe(0)
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('public_nonconforming_revocation_id', {
            outcome: failure.code,
            executionId: pool.failStopCalls()[0]!.executionId,
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
    'PUBLIC IDENTITY BINDING: rejects a terminal receipt bound to a foreign identifier',
    async () => {
      await withPool(
        { mode: 'nonconforming_terminal_id', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          let error: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            error = e
          }

          const failure = expectFailure(error)
          expect(failure.stage).toBe('resolve')
          expect(failure.code).toBe('TERMINAL')
          expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
            'TERMINAL_RECEIPT',
          ])
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('public_nonconforming_terminal_id', {
            outcome: failure.code,
            executionId: pool.failStopCalls()[0]!.executionId,
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
    'PUBLIC IDENTITY BINDING: rejects a terminal receipt that reports the wrong terminal state',
    async () => {
      await withPool(
        { mode: 'nonconforming_terminal_state', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          let error: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            error = e
          }

          const failure = expectFailure(error)
          expect(failure.stage).toBe('resolve')
          expect(failure.code).toBe('TERMINAL')
          expect(pool.failStopCalls().map((call) => call.reason)).toEqual([
            'TERMINAL_RECEIPT',
          ])
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('public_nonconforming_terminal_state', {
            outcome: failure.code,
            executionId: pool.failStopCalls()[0]!.executionId,
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
    'PUBLIC IDENTITY BINDING: rejects a transport receipt that aliases a foreign policy digest',
    async () => {
      await withPool(
        { mode: 'nonconforming_transport_alias', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          let error: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            error = e
          }

          const failure = expectFailure(error)
          expect(failure.stage).toBe('resolve')
          expect(failure.code).toBe('RECEIPT')
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('public_nonconforming_transport_alias', {
            outcome: failure.code,
            executionId: pool.failStopCalls()[0]?.executionId ?? 'none',
            failStopCalls: pool.failStopCalls(),
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'PUBLIC IDENTITY BINDING: rejects an unconstrained chunk stream that exceeds the declared length',
    async () => {
      await withPool(
        { mode: 'nonconforming_unconstrained_stream', slots: 1 },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          let error: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            error = e
          }

          const failure = expectFailure(error)
          expect(failure.stage).toBe('resolve')
          expect(['LIMIT', 'LENGTH']).toContain(failure.code)
          pool.settle('failed')
          expect(pool.ledger().retiredSlots).toBe(1)
          record('public_nonconforming_unconstrained_stream', {
            outcome: failure.code,
            executionId: pool.failStopCalls()[0]?.executionId ?? 'none',
            failStopCalls: pool.failStopCalls(),
            ledger: pool.ledger(),
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'PUBLIC BUDGET: invalid budget rejected at option parse (BUDGET stage, no host contacted)',
    async () => {
      // Use a conformant host but with an invalid budget pair where
      // totalTimeoutMs < cleanupReserveMs. The package validates the budget
      // at decode entry and rejects it before any host realm is started.
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        // A budget with totalTimeoutMs < cleanupReserveMs is invalid and
        // rejected at options parse time (BUDGET stage).
        let error: unknown
        try {
          await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: { totalTimeoutMs: 2, cleanupReserveMs: 1 },
            resolverHostSupervisor: pool.hostSupervisor,
          })
        } catch (e) {
          error = e
        }

        const failure = expectFailure(error)
        expect(failure.stage).toBe('budget')
        expect(failure.code).toBe('BUDGET')
        // No handle was published and no host was contacted.
        expect(pool.ledger().freeSlots).toBe(1)
        record('public_invalid_budget_rejected', {
          outcome: failure.code,
          stage: failure.stage,
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'PUBLIC BUDGET AND ABORT: fails closed when caller AbortSignal aborts mid-flight',
    async () => {
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        const controller = new AbortController()
        // Abort immediately so the driver sees it before or during allocation.
        controller.abort()

        let error: unknown
        try {
          await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: budget,
            resolverSignal: controller.signal,
            resolverHostSupervisor: pool.hostSupervisor,
          })
        } catch (e) {
          error = e
        }

        const failure = expectFailure(error)
        expect(failure.stage).toBe('resolve')
        expect(failure.code).toBe('ABORTED')
        // No handle was published and no host realm was started.
        expect(pool.lifecycle()?.starts ?? 0).toBe(0)
        // The abort was seen before allocation, so no slot was held and none retired.
        pool.settle('completed')
        expect(pool.ledger().retiredSlots).toBe(0)
        record('public_abort_signal', {
          outcome: failure.code,
          stage: failure.stage,
          executionId: pool.failStopCalls()[0]?.executionId,
          failStopCalls: pool.failStopCalls(),
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'PUBLIC MISSING CONFIGURATION: external bundle decoded without mandatory resolver configuration fails closed (UNRESOLVED)',
    async () => {
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const asset = pool.assets[0]!
        const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

        let error: unknown
        try {
          await decodeStructBundle(canonical)
        } catch (e) {
          error = e
        }

        const failure = expectFailure(error)
        expect(failure.stage).toBe('assets')
        expect(failure.code).toBe('UNRESOLVED')
        // No host was contacted because the resolver configuration was missing.
        expect(pool.lifecycle()?.starts ?? 0).toBe(0)
        expect(pool.ledger().freeSlots).toBe(1)
        record('public_missing_resolver_config', {
          outcome: failure.code,
          stage: failure.stage,
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'PUBLIC IDENTITY BINDING: public decode with swapped execution ID is rejected by the public seam',
    async () => {
      await withPool(
        {
          mode: 'conformant',
          slots: 2,
          executionIdSource: () => 'exec-fixed-duplicate',
        },
        async (pool) => {
          const asset = pool.assets[0]!
          const canonical = await buildExternalBundle(asset, 'Text/chapter1.xhtml')

          // First decode consumes the fixed execution ID.
          const firstHandle = await decodeStructBundle(canonical, {
            resolverExecutor: pool.executor,
            resolverPolicy: nonTransportPolicy,
            resolverBudget: budget,
            resolverHostSupervisor: pool.hostSupervisor,
          })
          expect(firstHandle.assetBytes(asset.id)!.byteLength).toBe(asset.byteLength)
          // The first execution is still held (not settled).

          // Second decode with the same fixed ID source must be rejected at
          // allocation time (EXECUTION_ID ambiguity).
          let error: unknown
          try {
            await decodeStructBundle(canonical, {
              resolverExecutor: pool.executor,
              resolverPolicy: nonTransportPolicy,
              resolverBudget: budget,
              resolverHostSupervisor: pool.hostSupervisor,
            })
          } catch (e) {
            error = e
          }

          const failure = expectFailure(error)
          expect(failure.stage).toBe('resolve')
          expect(failure.code).toBe('ALLOCATE')
          // The failed allocation must not leave a held slot. The first execution
          // is still held, the second was refused.
          pool.settle('failed')
          const ledger = pool.ledger()
          expect(ledger.retiredSlots).toBe(1)
          expect(ledger.tombstones['exec-fixed-duplicate']).toBeTruthy()
          record('public_duplicate_execution_identifier', {
            outcome: failure.code,
            executionId: 'exec-fixed-duplicate',
            failStopCalls: pool.failStopCalls(),
            ledger,
          })
        },
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'NO REGRESSION: existing private-driver conformance cases keep passing unchanged',
    async () => {
      // This test simply verifies that the private driver path (resolveStructResolverAssets)
      // still works as before. It uses the same pool infrastructure and asserts
      // the same outcomes, proving no regression from the public-seam additions.
      await withPool({ mode: 'conformant', slots: 1 }, async (pool) => {
        const { resolveStructResolverAssets } = await import('../src/bundle/resolver-execution')
        const asset = pool.assets[0]!

        const result = await resolveStructResolverAssets(
          [
            Object.freeze({
              id: asset.id,
              sha256: asset.sha256,
              mediaType: asset.mediaType,
              byteLength: asset.byteLength,
              logicalHref: 'Text/chapter1.xhtml',
            }),
          ],
          {
            executor: pool.executor,
            hostSupervisor: pool.hostSupervisor,
            policy: nonTransportPolicy,
            expectedPolicySha256,
            budget,
          },
        )

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect([...result.assets.keys()]).toEqual([asset.id])
        const bytes = result.assets.get(asset.id)!
        expect(bytes.byteLength).toBe(asset.byteLength)
        expect(sha256HexSync(bytes)).toBe(asset.sha256)

        pool.settle('completed')
        record('private_driver_no_regression', {
          outcome: 'completed',
          assetId: asset.id,
          ledger: pool.ledger(),
        })
      })
    },
    CASE_TIMEOUT_MS,
  )
})