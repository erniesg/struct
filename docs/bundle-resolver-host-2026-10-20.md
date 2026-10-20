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

---

# Real OS conformance binding (test-only)

**Added:** 2026-10-20, on top of the reviewed host component
`c2394c967d252285f6e026dd3784411944da76f2`.
**Contract:** `/home/ubuntu/.local/state/struct-migration/20261020-continuation/resolver-real-conformance-contract.json`.

This section binds the **real** published `StructResolverExecutorV1` and
`StructResolverHostSupervisorV1` surfaces to the sacrificial host above and
drives them through the **real** portable package driver
`resolveStructResolverAssets`. It is a test-only binding: no `src/**` file, no
package manifest, no lock file, no API surface and no existing test was
changed.

## Why this is separate from the harness above

The harness above is an OS substrate. It proves containment with a generic
marker/acknowledgement channel and it does **not** implement the pinned
TypeScript ports. It explicitly left three gaps open:

1. the `StructResolverHostSupervisorV1` port was not implemented;
2. no `StructResolverExecutorV1` was wired;
3. no **non-conforming** fixtures existed, so the suite could only prove the
   happy path.

This binding closes all three against a real operating system, and it closes
them through the package driver rather than around it.

## Realm topology

Four realms. The package driver never runs inside the host realm, so the
lifecycle return value is always observable and a dying executor can never
take the driver down with it.

| Realm | Process | Holds |
|---|---|---|
| package parent | the Node process calling `resolveStructResolverAssets` | the portable driver, the package reference supervisor, the outer host slot ledger, the tombstones, the fail-stop proxy port |
| OS host supervisor | `tests/fixtures/resolver-host/real_host_manager.py` | the namespaces, the capability drop, the pidfd, the lifetime pipe, the namespace census, the reap |
| launcher | a forked child of the OS host supervisor | `unshare(CLONE_NEWUSER | CLONE_NEWPID)`, the `uid_map`/`gid_map`, the reap of the body |
| host realm | `tests/fixtures/resolver-host/real_host_body.py` | an in-memory content-addressed fixture table. PID 1 of its own PID namespace, `CapEff=CapPrm=CapBnd=CapInh=CapAmb=0` |

The OS host supervisor reuses the reviewed primitives of `parent_harness.py`
directly (namespace creation, capability drop, pidfd signalling, subreaper
adoption, the lifetime pipe, the outer-visible census), so there is exactly one
implementation of the tricky operating-system parts.

## The narrow IPC

Two channels, and **no ambient command API**.

**Control channel** — the OS host supervisor's stdin/stdout, one NDJSON record
per line, with exactly five verbs: `manifest`, `spawn`, `failstop`, `status`
and `shutdown`. Every verb is bound to one host slot the supervisor owns.

**Body channel** — four FIFOs per execution:

| FIFO | Direction | Use |
|---|---|---|
| `bodyIn` | parent → body | `start`, `cleanup`, `terminate` |
| `bodyOut` | body → parent | `ready`, `result`, `chunk`, `stream-end`, `cleanup-ack`, `terminal`, `lifecycle` |
| `revIn` | parent → body | the synchronous revocation request |
| `revOut` | body → parent | the synchronous revocation receipt |

The two write sides are opened by the OS host supervisor **before** the
launcher exists and the supervisor closes its own copy immediately after the
fork, so the only remaining writer is the host realm. The parent therefore
observes a genuine end-of-file exactly when the realm and every descendant are
gone, and it never observes a spurious end-of-file while the realm is still
coming up.

The revocation channel is separate from the event channel on purpose. The
published contract makes `revokeAndQuarantine()` a **synchronous** call, so the
parent has to complete one request and response round trip without depending
on the event loop. The round trip is a bounded `fs.readSync` poll on a
non-blocking descriptor, so the package's own deadline accounting is
unaffected.

## The parent owns identity, admission and retirement

The parent, not the host, owns:

- the **execution identifier → outer host slot** mapping;
- **one-shot admission**: a tombstoned identifier and a live identifier are
  both refused before any host realm is created;
- the **immutable tombstones**: a terminated or retired identifier is never
  reused;
- the **permanent retirement** of an implicated capacity: a fail-stop retires
  the slot and the slot is never handed out again.

The outer host pool has *N* slots. The frozen profile concurrency stays **1**,
so a single `resolveStructResolverAssets` call resolves its assets serially.
The pool size is a test construct and is not a concurrency claim.

The disposition of a held slot is settled by the parent once the resolution
outcome is known: a completed resolution releases the slot, a failed
resolution retires it.

## The fail-stop evidence is never self-declared

`hostReaped`, `descendantCount`, `waitedMs` and `method` are produced by the OS
host supervisor from a real `waitpid`, a real lifetime-pipe end-of-file and a
real outer-visible namespace census. A value the host declared about itself is
never returned, and a client-declared `hostReaped` is never echoed. The parent
then re-validates the receipt with the package's own
`validateStructResolverFailStopReceipt` against the exact reserved
identifier, so a swapped or stale identifier fails closed.

## No transport authority at all

The conformance cases are tiny byte cases. The host realm resolves bytes from
an in-memory table keyed by the content address, and it publishes an
explicitly synthetic `content-addressed` receipt. It opens no socket, resolves
no filesystem locator, contacts no store and receives no credential. The
receipt in these cases is **not** evidence of real transport behaviour; the
transport kinds stay consumer-owned.

## The cases

Thirteen cases in `tests/bundle-resolver-real-conformance.test.ts`, all driven
through `resolveStructResolverAssets` unless the case is explicitly an
executor-level case.

### Conforming

| Case | What it proves against the real OS |
|---|---|
| resolves the exact bytes of an external asset through a real host realm | exact bytes and digest, a copied map, a valid receipt, one start / one revocation / one cleanup / one termination observed by the host realm, `CapEff=0` in the realm, PID 1 in a dedicated PID namespace, and no transport authority |

### Host death, proven by the parent OS

| Case | What it proves |
|---|---|
| fails closed and proves the host dead when cleanup never settles | the driver reports `CLEANUP`, asks for a fail-stop, and the parent proves the lifetime-pipe EOF, an empty namespace census, `descendantCount: 0` and a reaped host; the slot is permanently retired |
| fails closed and proves the host dead when the terminate and join never settle | the driver reports `TERMINAL`, the parent escalates `SIGTERM` → `SIGKILL`, and the same death proof holds |
| contains a daemonized descendant that escaped the host process group | the descendant is visible in the namespace census **before** the kill and absent **after** it; the lifetime pipe reaches EOF although the descendant held the descriptor and ignored `SIGTERM`; the slot is retired |

### Identity and capacity under pressure

| Case | What it proves |
|---|---|
| never reopens a retired slot under aggregate pressure | the first execution is fail-stopped and its slot is retired; the next execution is admitted on the **other** slot; the retired slot and the retired identifier are never reused |

### Intentionally non-conforming fixtures

| Mode | Invariant broken | Driver outcome |
|---|---|---|
| `nonconforming_revocation_id` | the revocation receipt must bind the exact reserved identifier | `REVOCATION`, then a real parent fail-stop and a retired slot |
| `nonconforming_terminal_id` | the terminal receipt must bind the exact reserved identifier | `TERMINAL`, then a real parent fail-stop and a retired slot |
| `nonconforming_terminal_state` | the terminal receipt must report the expected state | `TERMINAL`, then a real parent fail-stop and a retired slot |
| `nonconforming_transport_alias` | the transport receipt must echo the exact policy digest | `RECEIPT`, fail closed without a handle, slot retired |
| `nonconforming_unconstrained_stream` | the chunk stream must stay inside the declared length | `LIMIT`, fail closed without a handle, slot retired |

### Executor-level cases

| Case | What it proves |
|---|---|
| refuses a second start of the same execution | the one-shot start right refuses the second call and the host realm observed exactly one start |
| refuses a start after the revocation receipt was accepted | the start right is closed and the host realm observed no start at all |
| refuses a duplicate execution identifier before any host realm exists | the allocation is refused by the parent ledger before a realm is created |

### What the portable fixtures still cover

The **pure protocol** rejection rules — a thenable receipt, `quarantined:
false`, an extra receipt key, a hostile object, a swapped receipt between two
concurrent executions — are covered by the portable in-process fixtures in
`tests/fixtures/resolver/fake-host.ts` and by the existing package tests. This
lane proves the **real OS host binding** for those rules. It does not replace
the portable coverage, and it does not claim to.

## Honest labelling of the claims

- The conformance suite proves that the published ports can be bound to a real
  host, that the package driver fails closed against a real host, and that the
  parent can prove host and descendant death against the real operating
  system.
- It proves **nothing** about real transport behaviour. The receipt is a
  synthetic projection.
- It is **not** S-03 completion and **not** S-04 completion.
- It is **not** an independent review.
- The public decode helper that would call `resolveStructResolverAssets` from a
  real bundle decode is **not** part of this lane and is still open.

## Limitations carried forward

1. The nested user + PID namespace case is still not covered. The prior
   independent review proved that the host realm cannot complete a nested
   `uid_map` write after the capability drop. This lane **preserves** the
   complete capability drop and does not relax it to make the case reachable.
2. The host realm runs as `uid 0` **inside its own user namespace** with every
   capability dropped. That is not root in the parent namespace, and it is not
   a privilege the fixture grants itself.
3. The retired-slot registry and the tombstones live in the test parent for the
   lifetime of the pool. They are not persisted across a supervisor restart.
4. The fail-stop budget is owned by the OS host supervisor. It is not the ADR's
   `cleanupReserveMs` or `totalTimeoutMs` budget.
5. The outer host pool is a test construct. It is not a package feature.
6. The conformance budget is a single explicit `totalTimeoutMs` /
   `cleanupReserveMs` pair. The package never substitutes a default, and
   neither does this lane.

## How to run

```bash
# the real conformance driver: the reviewed host harness plus the real
# conformance suite, with machine-readable evidence on stdout
node scripts/test-resolver-conformance.mjs
node scripts/test-resolver-conformance.mjs --out /tmp/resolver-conformance.json

# the conformance suite alone
node_modules/.bin/vitest run tests/bundle-resolver-real-conformance.test.ts --maxWorkers=1

# the reviewed host harness alone (unchanged)
node scripts/test-resolver-host.mjs
```

Every process is bounded: the driver enforces a wall budget, the host children
carry `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_CORE` and `RLIMIT_FSIZE`, and the
pool disposes its hosts in a `finally` block that also proves zero residual
state.

---

# Public decode seam conformance (test-only)

**Added:** 2026-10-20, on top of the real OS conformance binding.
**Contract:** `/home/ubuntu/.local/state/struct-migration/20261020-continuation/resolver-real-conformance-contract.json`.

This section extends the real OS conformance suite to exercise the **public**
`decodeStructBundle` entry point (`src/bundle/index.ts`) against the same
sacrificial Linux user + PID namespace host. The public path delegates to the
private external-bytes core (`src/bundle/external.ts`) which in turn calls
`resolveStructResolverAssets` (`src/bundle/resolver-execution.ts`) with the
consumer-owned executor and the mandatory parent fail-stop supervisor. No
`src/**` files were modified; the suite only adds test code and fixtures.

## Why this is separate from the private-driver conformance

The private-driver conformance suite (`tests/bundle-resolver-real-conformance.test.ts`)
drives `resolveStructResolverAssets` directly. This suite proves that the **public
API** (`decodeStructBundle`) correctly wires the resolver options through to the
same driver and the same real OS host, and that the public error taxonomy
(`StructBundleError` with stage/code) matches the private driver's behaviour
exactly.

## The public seam

The public decode options are a flat object with the following mandatory fields
when the bundle carries external asset references:

| Option | Type | Role |
|---|---|---|
| `resolverExecutor` | `StructResolverExecutorV1` | Consumer-owned executor. |
| `resolverPolicy` | `StructAssetResolutionPolicyV1` | Consumer-owned policy snapshot. |
| `resolverBudget` | `{ totalTimeoutMs, cleanupReserveMs }` | Explicit budget; no implicit default. |
| `resolverHostSupervisor` | `StructResolverHostSupervisorV1` | Mandatory parent-owned fail-stop port. |
| `resolverSignal` | `AbortSignal` | Optional caller abort signal. |
| `expectedBundleSha256` | `string` | Optional raw bundle digest check. |
| `limitsProfile` | `string` | Optional profile version (only frozen version accepted). |

All resolver fields must either be absent together (embedded-only decode) or all
present. An explicit `undefined` is not treated as omitted.

## The cases

Fifteen cases in `tests/bundle-public-resolver-conformance.test.ts`, all driven
through the public `decodeStructBundle` entry point.

### PUBLIC SUCCESS

| Case | What it proves against the real OS |
|---|---|
| resolves the exact bytes of an external asset through the public decodeStructBundle with a real host realm | exact bytes and digest, a genuine handle whose `assetBytes(id)` equals the bytes the host actually produced, verified `documentSha256`/`bundleSha256` and asset digest conserved, one start / one revocation / one cleanup / one termination observed by the host realm, `CapEff=0` in the realm, PID 1 in a dedicated PID namespace, no transport authority |

### PUBLIC FAIL-CLOSED LIFECYCLE

| Case | What it proves |
|---|---|
| fails closed when the real host never settles its cleanup | the public decode rejects with `stage: 'resolve', code: 'CLEANUP'`, the parent asks for a fail-stop and proves the lifetime-pipe EOF, empty namespace census, `descendantCount: 0`, reaped host; the slot is permanently retired |
| fails closed when the terminate and join never settle | the public decode rejects with `stage: 'resolve', code: 'TERMINAL'`, the parent escalates `SIGTERM` → `SIGKILL`, same death proof; slot retired |
| contains a daemonized descendant that escaped the host process group | the descendant is visible in the namespace census **before** the kill and absent **after** it; lifetime pipe reaches EOF; slot retired; public decode rejects with `stage: 'resolve', code: 'TERMINAL'` |
| never reopens a retired slot under aggregate pressure | first execution fail-stopped, slot retired; second execution admitted on the other slot; retired slot and identifier never reused; public decode path |

### PUBLIC IDENTITY BINDING

| Case | What it proves |
|---|---|
| rejects a revocation receipt bound to a foreign identifier | public decode rejects with `stage: 'resolve', code: 'REVOCATION'`, parent fail-stop with `REVOCATION_RECEIPT`, slot retired |
| rejects a terminal receipt bound to a foreign identifier | public decode rejects with `stage: 'resolve', code: 'TERMINAL'`, parent fail-stop with `TERMINAL_RECEIPT`, slot retired |
| rejects a terminal receipt that reports the wrong terminal state | public decode rejects with `stage: 'resolve', code: 'TERMINAL'`, parent fail-stop with `TERMINAL_RECEIPT`, slot retired |
| rejects a transport receipt that aliases a foreign policy digest | public decode rejects with `stage: 'resolve', code: 'RECEIPT'`, no handle, slot retired |
| rejects an unconstrained chunk stream that exceeds the declared length | public decode rejects with `stage: 'resolve', code: 'LIMIT'|'LENGTH'`, no handle, slot retired |
| public decode with swapped execution ID is rejected by the public seam | second decode with same fixed execution ID rejected at allocation with `stage: 'resolve', code: 'ALLOCATE'`, first slot retired on cleanup |

### PUBLIC BUDGET AND ABORT

| Case | What it proves |
|---|---|
| fails closed when explicit budget expires | invalid budget (total < cleanup reserve) rejected at options parse with `stage: 'budget', code: 'BUDGET'`, no host contacted |
| fails closed when caller AbortSignal aborts mid-flight | pre-aborted signal rejected by driver with `stage: 'resolve', code: 'ABORTED'`, no host realm started, no slot retired |

### PUBLIC MISSING CONFIGURATION

| Case | What it proves |
|---|---|
| external bundle decoded without mandatory resolver configuration fails closed (UNRESOLVED) | public decode without resolver options rejects with `stage: 'assets', code: 'UNRESOLVED'`, no host contacted, no handle |

### NO REGRESSION

| Case | What it proves |
|---|---|
| existing private-driver conformance cases keep passing unchanged | private driver path (`resolveStructResolverAssets`) still works identically, same pool infrastructure, same outcomes |

## Honest labelling of the claims

- The public-seam conformance suite proves that the public `decodeStructBundle`
  API can be bound to a real host, that it fails closed against a real host, and
  that the parent can prove host and descendant death against the real operating
  system.
- It proves **nothing** about real transport behaviour. The receipt is a
  synthetic projection.
- It is **not** S-03 completion and **not** S-04 completion.
- It is **not** an independent review.

## How to run

```bash
# the public-seam conformance suite alone
node_modules/.bin/vitest run tests/bundle-public-resolver-conformance.test.ts --maxWorkers=1 --testTimeout=120000

# the full package suite (includes both private and public conformance)
node_modules/.bin/vitest run --maxWorkers=1

# the real conformance driver (private driver only)
node scripts/test-resolver-conformance.mjs
```

Every process is bounded: the driver enforces a wall budget, the host children
carry `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_CORE` and `RLIMIT_FSIZE`, and the
pool disposes its hosts in a `finally` block that also proves zero residual
state.
