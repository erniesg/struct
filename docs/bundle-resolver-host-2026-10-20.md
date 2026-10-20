# Sacrificial resolver verification host harness

**Date:** 2026-10-20
**Worktree:** `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/resolver-host`
**Branch:** `test/bundle-resolver-sacrificial-host-20261020`
**Base head:** `0eecf16`
**Status:** an OS-level verification harness and its fixtures. It is not a
Struct implementation, not S-03 completion, and not a security approval.

## Scope

This slice adds a real, sacrificial **verification host** and the **parent-side
supervisor** that owns it, so that a future conformance suite can prove, with
running processes rather than mocks, that a failed resolver execution can be
contained.

Owned artefacts:

| Path | Role |
|---|---|
| `tests/fixtures/resolver-host/host_fixture.py` | The host realm. A tiny untrusted test double for a transport adapter. |
| `tests/fixtures/resolver-host/parent_harness.py` | The parent supervisor. Owns identity, admission capacity, containment, death proof, and capacity retirement. |
| `scripts/test-resolver-host.mjs` | Focused driver. Runs the harness and re-emits its machine-readable evidence. |
| `tests/bundle-resolver-host.test.ts` | Assertions over the harness evidence. |

Nothing outside this list was touched: no `src/**`, no package manifest, no
lock file, no API surface, no consumer, no pack script.

## Why this exists

The ADR (`2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md`,
normative `StructBundle` contract, resolver lifecycle) requires that a
revocation failure, a never-settling cleanup, a never-settling join, or a
terminal-receipt mismatch forces the separately supervised verification host to
**fail-stop**, that the parent then **proves the host and its descendants are
dead**, and that the implicated executor capacity is **permanently retired**
rather than returned to the pool.

The prior OS-capability pilot
(`/home/ubuntu/.local/state/struct-migration/20261020-continuation/isolation-pilot-result.json`)
established three facts that this harness turns into a reusable, independently
verifiable fixture:

1. Process-group termination is **not** sufficient for a `setsid`/double-forked
   descendant.
2. `PR_SET_CHILD_SUBREAPER` plus `pidfd_open`/`pidfd_send_signal` can reclaim
   the supervisor's **own controlled** descendants.
3. An unprivileged user + PID namespace is available on this host once the
   `uid_map`/`gid_map` are written correctly, while **cgroup delegation is
   not**.

## Containment mechanism

Every host runs in its own dedicated PID namespace:

- the supervisor forks a launcher, the launcher calls
  `unshare(CLONE_NEWUSER | CLONE_NEWPID)`, writes `/proc/self/setgroups`,
  `/proc/self/uid_map` and `/proc/self/gid_map` (`0 <outer-uid> 1`), and then
  forks the host, which becomes **PID 1 of the new namespace**;
- the launcher strips **every** Linux capability from itself and from the host
  (`PR_CAPBSET_DROP` for the bounding set, `capset()` for the effective,
  permitted, inheritable and ambient sets). The host realm's own
  `/proc/self/status` is recorded as evidence that it holds `CapEff=0`,
  `CapPrm=0`, `CapBnd=0`;
- every signal is delivered through `pidfd_open`/`pidfd_send_signal`, so
  signalling has no PID-reuse window and does not depend on process groups;
- the supervisor enables `PR_SET_CHILD_SUBREAPER`, so orphaned descendants are
  re-parented to it and can be waited for;
- each host holds one end of a dedicated **lifetime pipe**. Every descendant
  that inherits the descriptor keeps it open, so **end-of-file on that pipe is
  a kernel-level proof that every holder is dead**. It is not a
  self-reported status;
- the supervisor additionally watches a monotonic **heartbeat file** written by
  the escaped descendant, so the death of that specific process is observed
  independently of the pipe.

Process-group termination is never treated as sufficient anywhere in this
harness.

### Evidence discipline

The harness reads `/proc/<pid>/stat`, `/proc/<pid>/ns/pid`, `/proc/<pid>/status`
(capability bitmasks only), and `/proc/<pid>/ns/user`. It never reads process
argv, environment blocks, file descriptors, or any credential material, and it
never writes outside its own run directory. Every recorded boolean is derived
from a real signal result, a real `/proc` observation, a real pipe EOF, or a
real file-content change. There are no mocks and no stubbed process APIs.

## The five cases

| Case | What it proves |
|---|---|
| `clean_host` | A cooperating host is reaped by the parent (`exit:0`), the lifetime pipe reaches EOF, and the residual census is empty. |
| `never_settling_cleanup` | The host ignores the cleanup marker and never acknowledges it. Cleanup does not settle; the parent escalates `SIGTERM` → `SIGKILL` on the namespace init, proves death, and **permanently retires** the implicated capacity slot. |
| `never_settling_join` | Cleanup settles (the host acknowledges it) but the terminate/join never settles. The parent still escalates, proves death, and permanently retires the slot. |
| `daemonized_escaped_descendant` | A `setsid` + double-fork descendant escapes the host's process group and session (observed in the inner view **and** in the outer view) but **cannot escape the PID namespace**. The parent signals only the namespace init, the namespace is destroyed, the heartbeat stops advancing, the pipe reaches EOF, the namespace's outer-visible member list empties, and the descendant is dead. |
| `aggregate_pressure_capacity_retirement` | Two live hosts create aggregate pressure. An over-capacity reservation is rejected **before** anything is spawned (the live-descendant census is byte-identical before and after). After a fail-stop, the implicated slot is retired, the retired execution ID is refused (`EXECUTION_ID_RETIRED`), a fresh ID is still refused (`CAPACITY_EXHAUSTED`, proving the retired slot was not returned to the pool), a later admission lands on the **other** slot, and once every slot is retired the supervisor answers `CAPACITY_RETIRED`. |

Each case is bounded: the harness enforces a 10 s per-case wall budget, the
host children carry `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_CORE` and `RLIMIT_FSIZE`
limits, the fixture forks at most twice per host, and the admission cap keeps
the number of live hosts at two. There are no fork bombs.

## Parent-owned identity and capacity

The supervisor, not the host, mints every execution identifier. The ledger has
three slot states — `free`, `held`, `retired` — and three refusal reasons:

| Reason | Meaning |
|---|---|
| `EXECUTION_ID_DUPLICATE` | The identifier is already held by a live reservation. |
| `EXECUTION_ID_RETIRED` | The identifier was tombstoned and is never reused for the supervisor's lifetime. |
| `CAPACITY_EXHAUSTED` | Every non-retired slot is currently held. |
| `CAPACITY_RETIRED` | Every slot is permanently retired; no capacity remains. |

A healthy termination tombstones the identifier and returns the slot to the
pool. A fail-stop tombstones the identifier **and** permanently retires the
slot, so an implicated capacity can never be handed out again.

## Generic parent/host channel

The parent/host channel is intentionally **not** a protocol proposal. It is
newline markers on stdin (`cleanup`, `terminate`) plus small JSON
acknowledgement files in the run directory. It exists so that this fixture
cannot conflict with, or pre-empt, the resolver protocol.

## Relationship to the published resolver contract

The resolver contract was published at
`/home/ubuntu/.local/state/struct-migration/20261020-continuation/resolver-contract.json`
(contract version `1.0.0`, published `2026-10-20`). It pins
`StructResolverHostSupervisorV1` as the additive fail-stop port:

```ts
interface StructResolverHostSupervisorV1 {
  readonly protocolVersion: '1.0.0'
  failStop(executionId: string, reason: StructResolverFailStopReason): Promise<StructResolverFailStopReceipt>
}
```

and pins the receipt shape as

```ts
Readonly<{
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
```

This harness is the OS substrate for exactly that port. Every fail-stop case
therefore records a `fail_stop_receipt` projection built from the real
observations, using the contract's own `method: 'pid-namespace'` value:

| Contract field | Harness source |
|---|---|
| `hostTerminated` | the namespace init was signalled and is gone |
| `hostReaped` | the launcher was waited for and reported the host's wait status |
| `descendantCount` | outer-visible members of that execution's PID namespace after the fail-stop |
| `descendantsDead` | `descendantCount === 0` |
| `capacityRetired` | the ledger permanently retired the implicated slot |
| `waitedMs` | measured elapsed time of the terminate-and-proof sequence |

The projection is **harness evidence for the coordinator's wiring**, not a
package export. It does not change the pinned surface, and the pinned TypeScript
types live on the contract's own branch
(`feat/bundle-resolver-lifecycle-20261020`, worktree `.../worktrees/resolver-runtime`),
not in this lane's branch, so no TypeScript port is implemented here.

The marker/acknowledgement channel between the parent and the host is a
lower layer than the contract's port: the contract fixes what the package
calls, not the byte channel between a parent and its host process. If the
contract later fixes a host wire channel, this fixture's channel has to be
re-bound to it; the containment mechanism, the five cases, and the death proof
stay valid.

## Explicit non-claims

- This is **not** a security approval and **not** S-03 or S-04 completion.
- No resolver, network, or filesystem transport behaviour is exercised.
- The harness proves containment for the escape it actually exercises
  (`setsid` + double-fork + signal refusal). A descendant that creates a
  **nested** user+PID namespace is **not** covered by that claim: an
  unprivileged user may create a nested user namespace when
  `unprivileged_userns_clone` is enabled, and the fixture does not attempt to
  prove death in that case. A controlled census of the supervisor's own
  descendants is therefore **not** presented as proof of adversarial
  descendant death.
- The host realm is unprivileged (all capabilities dropped) but still runs as
  the invoking user, so it can read that user's readable files. The fixture
  reads nothing outside its run directory; a production executor must broker
  a narrower authority.
- The harness does not model the resolver's budget accounting, the monotonic
  clock, or the `cleanupReserveMs`/`totalTimeoutMs` split. It uses fixed
  budgets (500 ms cleanup, 500 ms join, 300 ms terminate grace) that stand in
  for them.

## Integration gaps

1. **The TypeScript port is not implemented here.** The contract pins
   `StructResolverHostSupervisorV1.failStop()`, but the pinned protocol types
   (`src/bundle/resolver-protocol.ts`) live on the contract's own branch
   (`feat/bundle-resolver-lifecycle-20261020`, worktree
   `.../worktrees/resolver-runtime`). This lane's branch is based on
   `0eecf16` and does not contain them, and this lane owns no `src/**` file.
   The `fail_stop_receipt` projection in the harness evidence is the input for
   that implementation.
2. **No executor is wired.** Nothing here implements
   `StructResolverExecutorV1`. The contract's `conformanceHostLane` also asks
   for a consumer executor and for **non-conforming** fixtures that violate
   each invariant so the harness can prove the rejection, not only the happy
   path. Those fixtures are not built yet.
3. **The one-shot state machine and the revocation/terminal receipt binding**
   are modelled only indirectly, through the ledger and the fail-stop
   behaviour. The ADR's execution-ID-bound receipts must be checked against
   the published contract, not against this fixture.
4. **Capacity retirement is per-harness-lifetime.** Whether the retired-ID
   tombstones and the retired slots must survive a supervisor restart depends
   on the contract's lifetime-uniqueness wording; the current implementation
   does not persist them.
5. **The parent/host byte channel is generic.** If the contract later fixes a
   host wire channel, this fixture's marker/acknowledgement shape has to be
   re-bound to it.
6. **The harness does not model the resolver budget.** Fixed stand-in budgets
   are used (500 ms cleanup, 500 ms join, 300 ms terminate grace); the ADR's
   monotonic clock and the `totalTimeoutMs` / `cleanupReserveMs` split are not
   exercised.

## How to run

```bash
node scripts/test-resolver-host.mjs            # all five cases, evidence on stdout
node scripts/test-resolver-host.mjs --case never_settling_join
node_modules/.bin/vitest run tests/bundle-resolver-host.test.ts
```

The driver needs a `python3` on `PATH` (override with `--python` or the
`RESOLVER_HOST_PYTHON` environment variable). It creates its own temporary run
directory and removes it afterwards. The harness exits non-zero if any case
fails and reports an explicit `capability_blockers` entry when the dedicated
PID namespace could not be created; it never reports a pass in that case.
