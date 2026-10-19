# Bundle resolver runtime: protocol, supervisor, and execution

**Date:** 2026-10-20
**Repository:** `erniesg/struct`
**Branch:** `feat/bundle-resolver-lifecycle-20261020`
**Governing authority:** ADR-0001 `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md` (Ernie.SG), issue-plan S-03/S-04
**Published contract:** `/home/ubuntu/.local/state/struct-migration/20261020-continuation/resolver-contract.json` (milestone-1 commit `be1fbe1`)
**Status:** implementation only. No S-03 or S-04 completion is claimed, no public export was added, and no external system was touched.

## 1. What this slice delivers

Three new package modules, two new test files, one new fixture module, and
this note. Nothing existing was edited: `src/bundle/index.ts`, `facade.ts`,
`limits.ts`, `embedded.ts`, `canonical.ts`, and `assets.ts` are untouched, and
no manifest, lockfile, API manifest, consumer, or pack script changed.

| File | Role |
| --- | --- |
| `src/bundle/resolver-protocol.ts` | The ADR-pinned resolver protocol, the one additive parent-owned fail-stop port, and total side-effect-free guards. |
| `src/bundle/resolver-supervisor.ts` | The package reference supervisor: lifetime identity, admission, the one-shot start right, revocation bookkeeping, retired tombstones, permanent capacity retirement. |
| `src/bundle/resolver-execution.ts` | The portable driver: preflight, allocation, start, bounded streaming, the fixed teardown order, and escalation to the parent fail-stop port. |
| `tests/bundle-resolver-lifecycle.test.ts` | Protocol contract tests plus the supervisor state machine and identity matrix. |
| `tests/bundle-resolver-execution.test.ts` | The adversarial pilots and the execution state matrix. |
| `tests/fixtures/resolver/fake-host.ts` | In-process hostile host fixtures: throwing, hanging, swapping, and lying hosts. |

The package still exposes only the embedded Stage-1 bundle facade. The
resolver runtime is reachable from `src/bundle/**` but is deliberately not
exported from `@erniesg/struct/bundle` yet, because the bytes-decoder
integration seam is reserved for the integration lane.

## 2. The frozen protocol

`src/bundle/resolver-protocol.ts` restates the ADR declarations without
change: `StructAssetResolutionRequest`, `StructAssetResolutionResult`,
`StructResolverRevocationReceipt`, `StructResolverTerminalReceipt`,
`StructResolverExecutionControl`, `StructResolverExecutionHandle`, and
`StructResolverExecutorV1`. A type-level equality assertion in the lifecycle
test fails the compile step if a member is renamed, narrowed, dropped, or
made mutable.

Exactly one port is additive: `StructResolverHostSupervisorV1`. The ADR makes
the parent responsible for forcing a fail-stop and for proving that the
verification host and its descendants are dead, but the pinned executor
interface gives the package no way to ask for that. The port is a
parent-owned capability outside the adapter realm, it is idempotent, and it
is mandatory whenever an external asset is resolved.

The pinned literals are not negotiable. `capabilitiesRevoked: true` and
`quarantined: true` are checked with `=== true`, so `quarantined: false` is a
revocation failure rather than a weaker receipt. A terminal receipt must
carry the exact reserved identifier. A revocation or terminal receipt that is
promised rather than returned, that carries an unknown member, or that is
swapped between executions is a failure.

The guards are total and side-effect free:

- `readStructResolverFields` accepts own data properties only. Accessors,
  symbols, foreign prototypes, unknown members, and missing required members
  are rejected.
- Execution identifiers are opaque: 1 to 256 code units of printable ASCII,
  no whitespace, and no `/` or `\`.
- Logical hrefs stay relative bundle paths. An absolute path, a `:` scheme,
  `//`, a backslash, a `%` escape, a query, a fragment, and `.` or `..`
  segments are rejected.
- `planStructResolverBudget` requires `totalTimeoutMs >= 1` and
  `1 <= cleanupReserveMs < totalTimeoutMs`, and returns the derived work
  window.
- `validateStructResolverRequest` re-projects and re-hashes the policy with
  the existing strict policy helper and refuses a request whose
  `expectedPolicySha256` disagrees with it. The returned snapshot carries the
  canonical frozen policy, never the caller's object.
- `validateStructResolverResult` rejects a thenable, a wrong version, a
  malformed resource id, a chunk stream that is not async iterable, and a
  transport receipt with an extra member or a non-secret identifier. Policy
  equality for the receipt is not duplicated here: the existing strict
  receipt projection helper owns that rule.

## 3. The reference supervisor

The package reference supervisor implements `StructResolverExecutorV1`. It
never spawns and never kills: the out-of-realm host is consumer-owned through
`StructResolverHostBindingV1`, and the parent process supervisor owns
termination and descendant proof. This is what keeps the package free of
ambient I/O and what makes "the package cannot kill its own host" true rather
than aspirational.

The state machine is `allocated -> starting -> running -> revoking ->
cleaning -> terminated`, with failure transitions only toward revocation,
cleanup, and termination.

- **Identity.** The supervisor generates the identifier, not the host. The
  default source is cryptographic and fails closed when no cryptographic
  source exists, because a weak identifier is not a collision-resistant one.
  The identifier is reserved in a lifetime registry before the host is bound.
  A duplicate active identifier or a retired identifier fails allocation
  before any spawn, broker grant, credential grant, filesystem grant, or
  network grant.
- **Admission.** Allocation is refused when the live plus permanently retired
  capacity reaches the policy `maxConcurrent`. A `maxConcurrent` of zero is a
  valid policy value but an unusable resolution profile, and it fails before
  any host is bound.
- **One-shot start.** The start right is consumed atomically. A second
  start, a start after revocation, a start after cleanup, and a start after
  termination all fail before any spawn or capability request.
- **Late completion.** A start that resolves after revocation, cleanup, or
  termination began is quarantined: it cannot publish a result.
- **Revocation.** The receipt must carry the exact reserved identifier and
  both pinned literals. A host that throws keeps its own error, so a caller
  can tell a throwing host from a host that returned invalid evidence. Either
  way the identifier is tombstoned and the capacity is permanently retired.
- **Termination.** A valid terminal receipt converts the reservation into an
  immutable retired tombstone before any capacity returns to the pool. A
  missing, mismatched, or foreign receipt retires the capacity permanently
  and raises a terminal protocol error.
- **Cleanup.** Cleanup is idempotent, is available before a start, and stays
  callable after a failed start.

## 4. The execution driver

`resolveStructResolverAssets` accepts already validated targets and returns a
structured result. It never throws for an expected failure.

Preflight happens before any allocation: the option set is a strict own-data
object, the policy is re-hashed and compared, the budget is planned, and the
targets are checked for a unique identifier, a lowercase digest, a media
type, a non-negative length, and a valid logical href. The policy digest is
therefore bound before `allocate()` is ever called, and an aborted caller
signal stops the resolution before any allocation.

Per execution the driver holds one monotonic deadline. The work window is
`totalTimeoutMs - cleanupReserveMs` and the outer deadline is
`totalTimeoutMs`. The cleanup step is additionally bounded by the reserved
cleanup budget, and the join is bounded by the outer deadline.

The teardown order is fixed and a failure in one step never skips a later
step:

1. abort the signal,
2. attempt the synchronous revocation,
3. return the chunk iterator, only when a result already exists,
4. invoke cleanup inside the reserved cleanup budget,
5. terminate and join inside the reserved outer budget.

A revocation failure, a foreign or missing terminal receipt, a join that
never settles, and a cleanup that never settles inside its reserved budget
escalate to the parent fail-stop port with a pinned reason:
`REVOCATION_RECEIPT`, `REVOCATION_THROW`, `TERMINAL_RECEIPT`,
`TERMINAL_TIMEOUT`, or `CLEANUP_TIMEOUT`. The fail-stop receipt is validated
against the exact execution identifier and must report `hostTerminated`,
`descendantsDead`, and `capacityRetired` as exactly true with
`descendantCount` exactly zero. An unavailable, throwing, or invalid
fail-stop is reported as `FAIL_STOP`; the driver never reports normal
completion and never reuses the capacity in that case.

An identifier that the same resolution already used is an identity
ambiguity. The driver refuses to continue under it and escalates with
`EXECUTION_ID_AMBIGUITY` before any start is attempted.

The stream is bounded. A chunk that is not a genuine byte view, or whose
backing buffer was detached, is rejected before any copy. A single chunk may
not exceed the per-asset cap. The cumulative bytes may not exceed the
expected length, the per-asset cap, or the remaining aggregate budget. At
completion the length must be exact and the digest must equal the expected
digest.

The transport receipt is checked with the existing strict receipt projection
helper, so the echoed policy digest and the transport-kind identifiers must
match the policy exactly.

The driver retains no secret. A failure carries only a fixed code and an
opaque execution identifier. No URL, path, storage key, header, credential,
matrix parameter, or percent-encoded alias is accepted by a guard, echoed in
a receipt, or written into a failure.

## 5. Limits integration

`src/bundle/limits.ts` is a reserved integration seam and was not edited, so
the driver reads the byte caps from the shipped versioned profile instead of
defining a second profile.

- The effective resolver fan-out is
  `min(STRUCT_BUNDLE_LIMITS_PROFILE.maxConcurrency, policy.maxConcurrent)`.
  The shipped Stage-1 profile caps `maxConcurrency` at 1, so external
  resolution is serial until the integration lane publishes a
  resolver-capable profile version. This is a deliberate conservative cap.
- Per-asset resolved bytes are bounded by
  `min(expected.byteLength, profile.maxAssetBytes)` and the aggregate by
  `min(profile.maxTotalBytes, profile.maxDecodedBytes)`.
- A single chunk may not exceed `profile.maxAssetBytes`.
- Raising the external fan-out, adding a resolver-specific timeout, or
  adding a resolver limits profile requires a profile version bump and is a
  reserved integration change.

The shared package SHA-256 helper is one-shot, and the shared primitive file
is outside this lane's ownership, so the driver verifies the digest over the
copied, capped bytes at completion instead of introducing a second digest
implementation. The cumulative cap is what bounds the retention.

## 6. Evidence

```text
./node_modules/.bin/tsc --noEmit                                   # clean
./node_modules/.bin/vitest run tests/bundle-resolver-lifecycle.test.ts \
  tests/bundle-resolver-execution.test.ts --maxWorkers=1           # 81 passed
./node_modules/.bin/vitest run tests/bundle-assets.test.ts \
  tests/bundle-canonical.test.ts tests/bundle-canonical-vectors.test.ts \
  tests/bundle-embedded.test.ts tests/bundle-embedded-value.test.ts \
  tests/bundle-limits.test.ts tests/bundle-public-surface.test.ts \
  tests/bundle-resolver-policy.test.ts tests/bundle-resolver-receipt.test.ts \
  --maxWorkers=1                                                   # 235 passed
node scripts/check-source-boundary.mjs                             # clean
```

The lifecycle file carries 48 tests and the execution file 33.

### Adversarial pilots

1. A late start completion after a timeout is quarantined; the identifier is
   tombstoned and no bytes are published.
2. A duplicate identifier and a retired identifier both fail allocation
   before a host is bound, so no authority is granted.
3. Aggregate pressure: the allocation beyond the policy concurrency is
   denied, and no second asset starts after the work deadline.
4. A swapped revocation receipt is refused, the capacity is retired, and the
   parent fail-stop port is called.
5. A never-settling cleanup and a never-settling join are both reported as
   failures and both escalate; neither is reported as a normal termination.

The full unit state matrix adds the startup throw, rejection, and hang
outcomes, the stream error, non-byte chunk, short stream, long stream, and
digest mismatch, the foreign endpoint, foreign policy digest, and wrong
declared length, the aborted resolution, the unavailable and invalid
fail-stop ports, the iterator return ordering, the identity ambiguity, and
the failure hygiene checks.

## 7. Known gaps and honest limits

- **Out-of-realm termination is not proven here.** The package cannot kill a
  host. The VM isolation pilot recorded cgroup2 present but not writable,
  `PR_SET_CHILD_SUBREAPER` available, pidfd signalling available, and
  unprivileged user-namespace pid namespaces usable, so a parent can prove
  death with a process group plus a subreaper and a descendant census. That
  is a host capability and it belongs to the conformance host lane, not to
  this package.
- **The conformance harness is not implemented.** This slice ships the
  protocol, the reference supervisor, and the driver. The reusable harness
  that drives a candidate consumer executor through the same path, plus the
  deliberately non-conforming fixtures per invariant, are still open.
- **The public surface is unchanged.** Nothing is exported from
  `@erniesg/struct/bundle` yet, `decodeStructBundle` is still synchronous,
  and the raw expected-digest gate and the asynchronous facade are the
  reserved integration work.
- **The policy concurrency and the profile concurrency differ.** The
  supervisor admits up to the policy `maxConcurrent`; the driver resolves at
  most `min(profile.maxConcurrency, policy.maxConcurrent)` targets at a time.
- **The reference supervisor is a reference, not a certification.** It proves
  that a conforming executor is implementable and it supplies the identity,
  admission, one-shot, revocation, and tombstone rules. Whether a consumer's
  host is conforming is decided by the conformance lane.
- **The retired-identity registry grows with the number of executions.** That
  is required: an identifier is never reused inside one supervisor lifetime.
- **Integrity is not authenticity.** Nothing here proves producer
  authenticity. Production external ingress stays inactive until a consumer
  authenticates its own producer record bound to `bundleSha256` and proves
  current, rollback-safe trust status.

## 8. Not claimed

- S-03 is not complete. `createStructBundle`, `verifyStructBundle`, the full
  public limit profile matrix, the complete wire and version matrix, the
  conformance harness, and the documentation and manifest integration are
  still open.
- S-04 is not complete and stays blocked on S-03.
- No independent review and no conformance host run exists for this work.
- No package was published, no branch was pushed, no merge, deployment, or
  writer activation happened, and no external system was mutated.
