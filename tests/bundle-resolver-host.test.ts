import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const driver = fileURLToPath(new URL('../scripts/test-resolver-host.mjs', import.meta.url))

type Json = Record<string, any>

type HarnessEvidence = {
  kind: string
  generated_at_utc: string
  host: Json
  not_claimed: string[]
  capabilities: Json
  capability_blockers: string[]
  cases: Json[]
  final_cleanup: Json
  summary: Json
  ledger_events: Json[]
}

const CASE_BUDGET_S = 10

let evidence: HarnessEvidence
let driverStatus: number | null
let driverStderr = ''

function caseNamed(name: string): Json {
  const found = evidence.cases.find((entry) => entry.case === name)
  if (!found) throw new Error(`the harness did not run the case ${name}`)
  return found
}

function stepNamed(record: Json, name: string): Json {
  const found = (record.steps ?? []).find((entry: Json) => entry.step === name)
  if (!found) throw new Error(`the harness did not record the step ${name}`)
  return found
}

beforeAll(() => {
  const run = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  driverStatus = run.status
  driverStderr = run.stderr ?? ''
  expect(run.error, `the resolver-host driver could not be executed: ${run.error?.message}`).toBeUndefined()
  let parsed: HarnessEvidence
  try {
    parsed = JSON.parse(run.stdout) as HarnessEvidence
  } catch (error) {
    throw new Error(
      `the resolver-host driver produced no machine-readable evidence ` +
        `(status ${run.status}): ${driverStderr}\n${(error as Error).message}`,
    )
  }
  evidence = parsed
}, 120_000)

describe('sacrificial resolver verification host harness', () => {
  it('runs the harness to completion with a real parent-side supervisor', () => {
    expect(driverStatus).toBe(0)
    expect(evidence.kind).toBe('struct-resolver-sacrificial-host-harness')
    expect(evidence.summary.cases).toBe(5)
    expect(evidence.summary.failed).toBe(0)
    expect(evidence.summary.all_passed).toBe(true)
  })

  it('reports the containment capabilities it actually used', () => {
    expect(evidence.capability_blockers).toEqual([])
    expect(evidence.capabilities.pidfd.pidfd_open).toBe(true)
    expect(evidence.capabilities.pidfd.pidfd_send_signal).toBe(true)
    expect(evidence.capabilities.prctl_subreaper.enabled_for_this_run).toBe(true)
    expect(evidence.capabilities.pid_namespace.mechanism).toMatch(/CLONE_NEWPID/)
    expect(evidence.capabilities.cgroup2.used).toBe(false)
  })

  it('runs the host realm without any Linux capability', () => {
    for (const entry of evidence.cases) {
      const realm = entry.host?.realm_capabilities
      if (!realm) continue
      expect(realm.cap_eff, `${entry.case} host realm kept an effective capability`).toBe(0)
      expect(realm.cap_prm, `${entry.case} host realm kept a permitted capability`).toBe(0)
      expect(realm.cap_bnd, `${entry.case} host realm kept a bounding capability`).toBe(0)
    }
    const daemon = caseNamed('daemonized_escaped_descendant')
    expect(daemon.descendant.realm_capabilities.cap_eff).toBe(0)
    expect(daemon.descendant.realm_capabilities.cap_prm).toBe(0)
    expect(daemon.descendant.realm_capabilities.cap_bnd).toBe(0)
  })

  it('leaves no residual state after the whole run', () => {
    expect(evidence.final_cleanup.zero_residual).toBe(true)
    expect(evidence.final_cleanup.live_descendants).toEqual([])
    expect(evidence.final_cleanup.live_tracked_pids).toEqual([])
  })

  it('keeps every case inside the ten second budget', () => {
    for (const entry of evidence.cases) {
      expect(entry.wall_s, `${entry.case} exceeded the case budget`).toBeLessThan(CASE_BUDGET_S)
      expect(entry.within_budget).toBe(true)
    }
  })

  it('reaps a cooperating host and proves zero residual state', () => {
    const record = caseNamed('clean_host')
    expect(record.pass).toBe(true)
    expect(record.host.mode).toBe('cooperate')
    expect(record.host.identity.pid).toBe(1)
    expect(record.proof.host_status).toBe('exit:0')
    expect(record.proof.host_exit_code).toBe(0)
    expect(record.proof.lifetime_pipe_eof).toBe(true)
    expect(record.proof.launcher_reaped).toBe(true)
    expect(record.residual.clean).toBe(true)
    expect(record.residual.live_descendants_of_supervisor).toEqual([])
  })

  it('fails a host whose cleanup never settles and retires its capacity', () => {
    const record = caseNamed('never_settling_cleanup')
    expect(record.pass).toBe(true)
    expect(record.settlement.cleanup_settled).toBe(false)
    expect(record.settlement.join_settled).toBe(false)
    expect(record.termination.escalated_to_sigkill).toBe(true)
    expect(record.proof.lifetime_pipe_eof).toBe(true)
    expect(record.proof.host_term_signal).toBe(9)
    expect(record.proof.launcher_reaped).toBe(true)
    expect(record.residual.clean).toBe(true)
    expect(record.capacity_retirement.slot_is_permanently_retired).toBe(true)
    expect(record.ledger_after.slots[record.capacity_retirement.retired_slot].state).toBe('retired')
    expect(record.ledger_after.tombstones[record.execution_id]).toMatch(/FAIL_STOP/)
  })

  it('fails a host whose terminate/join never settles after cleanup settled', () => {
    const record = caseNamed('never_settling_join')
    expect(record.pass).toBe(true)
    expect(record.settlement.cleanup_settled).toBe(true)
    expect(record.settlement.join_settled).toBe(false)
    expect(record.termination.escalated_to_sigkill).toBe(true)
    expect(record.proof.lifetime_pipe_eof).toBe(true)
    expect(record.proof.host_term_signal).toBe(9)
    expect(record.residual.clean).toBe(true)
    expect(record.capacity_retirement.slot_is_permanently_retired).toBe(true)
  })

  it('contains a daemonized descendant inside the dedicated PID namespace', () => {
    const record = caseNamed('daemonized_escaped_descendant')
    expect(record.pass).toBe(true)

    // The descendant escaped the host's process group and session...
    expect(record.escape.escaped_process_group).toBe(true)
    expect(record.escape.escaped_session).toBe(true)
    expect(record.escape.escaped_process_group_outer_view).toBe(true)
    expect(record.escape.escaped_session_outer_view).toBe(true)

    // ...but it could not escape the namespace, and the parent observed that
    // from the outside without any cooperation from the host.
    expect(record.escape.descendant_still_inside_namespace).toBe(true)
    expect(record.escape.descendant_outer_pid_inside_namespace).toBe(true)
    expect(record.escape.descendant_namespace_local_pid).toBe(true)
    expect(record.escape.pid_ns_observed_by_parent).toBe(record.host.pid_ns)
    expect(record.escape.ns_members_outer_visible_while_alive.length).toBeGreaterThan(1)

    // The descendant was alive, then dead: heartbeat advanced, then stopped.
    expect(record.heartbeat.advanced_while_descendant_alive).toBe(true)
    expect(record.heartbeat.stopped_after_namespace_init_kill).toBe(true)

    // The parent proved death and the namespace emptied out.
    expect(record.proof.lifetime_pipe_eof).toBe(true)
    expect(record.proof.host_term_signal).toBe(9)
    expect(record.escape.ns_members_outer_visible_after_death).toEqual([])
    expect(record.residual.clean).toBe(true)
    expect(record.capacity_retirement.slot_is_permanently_retired).toBe(true)
  })

  it('rejects over-capacity and retired identities without spawning anything', () => {
    const record = caseNamed('aggregate_pressure_capacity_retirement')
    expect(record.pass).toBe(true)

    const overCapacity = stepNamed(record, 'over_capacity_reserve')
    expect(overCapacity.admitted).toBe(false)
    expect(overCapacity.reason).toBe('CAPACITY_EXHAUSTED')
    expect(overCapacity.no_process_spawned_on_reject).toBe(true)
    expect(overCapacity.live_descendant_census_after).toEqual(
      overCapacity.live_descendant_census_before,
    )

    const failStop = stepNamed(record, 'fail_stop_execution_a')
    expect(failStop.cleanup_settled).toBe(false)
    expect(failStop.escalated_to_sigkill).toBe(true)
    expect(failStop.lifetime_pipe_eof).toBe(true)
    expect(failStop.slot_retired).toBe(true)

    const reuse = stepNamed(record, 'retired_identity_reuse')
    expect(reuse.admitted).toBe(false)
    expect(reuse.reason).toBe('EXECUTION_ID_RETIRED')

    const fresh = stepNamed(record, 'fresh_identity_after_retirement')
    expect(fresh.admitted).toBe(false)
    expect(fresh.reason).toBe('CAPACITY_EXHAUSTED')

    const healthy = stepNamed(record, 'healthy_release_execution_b')
    expect(healthy.cleanup_settled).toBe(true)
    expect(healthy.join_settled).toBe(true)
    expect(healthy.host_status).toBe('exit:0')
    expect(healthy.slot_released).toBe(true)

    const readmitted = stepNamed(record, 'admit_execution_e_after_release')
    expect(readmitted.admitted).toBe(true)
    expect(readmitted.slot).toBe(1)
    expect(readmitted.retired_slot_was_not_reused).toBe(true)

    const exhausted = stepNamed(record, 'over_capacity_after_one_slot_retired')
    expect(exhausted.admitted).toBe(false)
    expect(exhausted.reason).toBe('CAPACITY_EXHAUSTED')

    const exhaustedFinal = stepNamed(record, 'reserve_after_all_capacity_retired')
    expect(exhaustedFinal.admitted).toBe(false)
    expect(exhaustedFinal.reason).toBe('CAPACITY_RETIRED')

    expect(record.residual.clean).toBe(true)
    expect(record.ledger_after.retired_slots).toBe(2)
    expect(record.ledger_after.free_slots).toBe(0)
  })

  it('does not claim conformance or approval for anything it did not do', () => {
    const claims = evidence.not_claimed.join(' ')
    expect(claims).toMatch(/not a security approval/)
    expect(claims).toMatch(/not S-03/)
    expect(claims).toMatch(/no resolver, network, or filesystem transport/)
  })
})
