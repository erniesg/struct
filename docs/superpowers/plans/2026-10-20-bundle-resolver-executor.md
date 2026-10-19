# Bundle resolver executor: implementation and conformance plan

**Date:** 2026-10-20
**Repository:** `erniesg/struct`
**Governing contract:** ADR-0001 `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md` (Ernie.SG), issue-plan S-03/S-04, and `CONTRACT.md` "Planned Bundle semantics".
**Status:** implementation plan only. This document changes no runtime behavior and claims no cutover.

## 1. Scope and non-negotiable boundaries

This plan closes the resolver-executor slice of S-03:

- versioned resolver policy, request, result, revocation, terminal, and fail-stop contracts;
- lifetime-unique execution identity, one-shot start, revocation/quarantine, cleanup, termination/join;
- bounded streaming external-asset resolution through a consumer-supplied executor;
- package-owned conformance harness and a real sacrificial-host test for parent-proven fail-stop;
- versioned Bundle limits that bound raw input and resolved bytes before unbounded allocation.

It does **not**:

- implement HTTPS, filesystem, content-addressed-store, DNS, redirect, or descriptor-root resolution;
- publish a package, regenerate application goldens, activate a writer or public route, or claim S-04/full cutover;
- add producer authentication to Struct (that is Ernie.SG/E-02/E-05 and Aether/A-02 work);
- treat a `Promise.race`, `AbortSignal.timeout`, worker `terminate()`, or executor self-report as out-of-realm termination.

The pinned ADR interfaces in §3 are frozen. Any implementation pressure to remove a field, weaken a literal (`capabilitiesRevoked: true`, `quarantined: true`), or move a supervisor duty into adapter code requires an ADR amendment, not a plan deviation. Additive ports are marked as such.

## 2. Current-state audit (exact head `998be09`)

| Area | Present today | Gap against the full contract |
| --- | --- | --- |
| Public facade | `decodeStructBundle`/`encodeStructBundle` at `@erniesg/struct/bundle`; embedded assets only; `UNRESOLVED` for external | No async external path, no create/verify facade, no executor options |
| Policy | `src/bundle/resolver-policy.ts`: strict projection, identifier grammar, domain-separated digest, pinned vectors | `maxConcurrent: 0` is accepted; orchestration must reject it when work exists |
| Receipts | `src/bundle/resolver-receipt.ts`: data-only transport receipt validation | No result, revocation, terminal, execution-ID, or fail-stop receipts |
| Streaming | None | No bounded chunk accumulator, incremental digest, cancellation, or iterator return |
| State machine | None | No allocation, one-shot start, revoke/quarantine, cleanup, terminate/join ordering |
| Identity | None | No lifetime registry, retired tombstone, duplicate/retired-ID conformance |
| Limits | Private constants in `embedded.ts`/`assets.ts` | No versioned public profile or N-1/N/N+1 vectors |
| Conformance | None | No harness, no sacrificial host, no parent death proof |
| Facade shape | `decodeStructBundle` is synchronous | ADR facade is `Promise<VerifiedStructBundle>`; external resolution is necessarily async |

The existing embedded implementation, policy projection, receipt projection, canonicalization, and asset verification are sound inputs to this work and must be preserved rather than rewritten.

## 3. Frozen protocol interfaces

These declarations are copied from ADR-0001 and must remain semantically identical. Implementation may add internal helpers; it may not rename, narrow, or drop members.

```ts
type StructAssetResolutionRequest = {
  protocolVersion: '1.0.0'
  logicalHref: string
  resourceId: `sha256:${string}`
  expected: Readonly<{ id: string; sha256: string; mediaType: string; byteLength: number }>
  policy: StructAssetResolutionPolicyV1
  expectedPolicySha256: string
  budget: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  signal: AbortSignal
}

type StructAssetResolutionResult = {
  protocolVersion: '1.0.0'
  resourceId: `sha256:${string}`
  chunks: AsyncIterable<Uint8Array>
  transportReceipt:
    | Readonly<{ kind: 'https'; policySha256: string; endpointMapId: string; endpointId: string; redirectEndpointIds: readonly string[] }>
    | Readonly<{ kind: 'filesystem'; policySha256: string; rootCapabilityId: string }>
    | Readonly<{ kind: 'content-addressed'; policySha256: string; storeId: string }>
  declaredByteLength?: number
}

type StructResolverRevocationReceipt = Readonly<{
  executionId: string
  capabilitiesRevoked: true
  quarantined: true
}>

type StructResolverTerminalReceipt = Readonly<{
  executionId: string
  state: 'terminated' | 'completed'
}>

interface StructResolverExecutionControl {
  readonly executionId: string
  revokeAndQuarantine(): StructResolverRevocationReceipt
  cleanup(): Promise<void>
  terminateAndJoin(): Promise<StructResolverTerminalReceipt>
}

type StructResolverExecutionHandle = {
  control: StructResolverExecutionControl
  start(): Promise<StructAssetResolutionResult>
}

interface StructResolverExecutorV1 {
  allocate(request: StructAssetResolutionRequest): StructResolverExecutionHandle
}
```

### 3.1 Additive host-supervision port

The pinned interfaces make the executor supervisor responsible for revocation and termination, but they give Struct no parent-realm way to force fail-stop when `terminateAndJoin()` never settles or returns an invalid receipt. ADR requires "the separately supervised verification host to fail-stop" and "proves the host and descendants dead from the parent." Add one separate, versioned port; do not add members to the pinned executor/handle/control.

```ts
type StructResolverFailStopReason =
  | 'REVOCATION_RECEIPT'
  | 'REVOCATION_THROW'
  | 'TERMINAL_RECEIPT'
  | 'TERMINAL_TIMEOUT'
  | 'CLEANUP_TIMEOUT'
  | 'EXECUTION_ID_AMBIGUITY'

type StructResolverFailStopReceipt = Readonly<{
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

interface StructResolverHostSupervisorV1 {
  readonly protocolVersion: '1.0.0'
  // Parent-owned capability, outside the adapter realm. Idempotent.
  failStop(
    executionId: string,
    reason: StructResolverFailStopReason,
  ): Promise<StructResolverFailStopReceipt>
}
```

The receipt is **client-attested consistency evidence**, not cryptographic proof and not authentication. Struct validates its shape and execution ID. Only the parent process supervisor and the conformance harness can prove the host and descendants are dead. If fail-stop is unavailable, unresolvable, or returns an invalid receipt, Struct returns `RESOLVER_FAIL_STOP_UNPROVEN`; it never reports normal completion or capacity reuse.

### 3.2 Decode options

```ts
type StructBundleDecodeOptions = Readonly<{
  expectedBundleSha256?: string
  resolver?: Readonly<{
    executor: StructResolverExecutorV1
    hostSupervisor: StructResolverHostSupervisorV1
    policy: StructAssetResolutionPolicyV1
    budget: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
    signal?: AbortSignal
  }>
}>
```

Rules:

- Strict, own-data-property snapshot; unknown keys, accessors, prototypes, proxies, and duplicate keys fail closed before any allocation.
- `resolver` must be complete when present. `hostSupervisor` is mandatory: an executor that cannot fail-stop is non-conforming for external assets.
- Resolver options are validated before raw parsing so a malformed option set cannot allocate. They are ignored for envelopes with no external payload, but a partial/unknown option set is still an options error.
- `signal` is checked once for `AbortSignal` identity and retained only as an abort listener; the listener is removed in `finally`.
- The package computes `expectedPolicySha256` before any `allocate()` call and places the same immutable policy snapshot in every request.

## 4. Supervisor trust and realm boundaries

| Realm | Owner | Holds | Must never |
| --- | --- | --- | --- |
| Package/caller | Struct | raw bytes, canonical bytes, parsed document, monotonic deadline, orchestration state, private verified storage | spawn adapter code synchronously; grant broker/fs/net authority; treat executor or fail-stop receipts as proof of death/authenticity |
| Executor supervisor | Ernie.SG/Aether | lifetime registry of active IDs and retired tombstones, one-shot start right, broker grants, descendant admission, revocation, cleanup, terminate/join | run adapter code in the caller realm; reuse an ID or capacity; return a revocation receipt before atomic closure; let a late start publish a result |
| Isolated host/adapter | Ernie.SG/Aether | actual transport adapter, endpoint map, descriptor root, DNS/private-address policy, credentials as brokered capabilities | receive canonical bundle bytes it does not need; put URLs, paths, storage keys, matrix/percent aliases, headers, or credentials in receipts/errors/logs; outlive an accepted terminal receipt |
| Verification parent | Test/app process supervisor | child PID/process group/cgroup, kill/escalate policy, `waitpid`/reap, descendant census, aggregate admission counter | trust a child's self-report; call a timer "termination"; reuse capacity after fail-stop |

### Guarantees Struct can provide

- Validate every protocol object and bound every string/array/byte count before use.
- No `allocate()` on expected-digest mismatch, options failure, or canonical/version failure.
- Exactly one `start()` call per handle; no start after revocation/cleanup/termination from Struct's side.
- No result accepted before transport receipt validation, stream completion, digest/length equality, accepted revocation, and valid terminal receipt.
- No post-revocation broker/adapter call from Struct; only supervisor cleanup/terminate/join are called after revocation, in the fixed order.
- Bounded memory: raw cap, per-chunk cap, cumulative cap, node/depth/string caps.
- Fail closed when any teardown evidence is missing or inconsistent.

### Guarantees Struct cannot provide

- Real broker/fs/net authority revocation, or descendant admission closure inside the executor.
- Death of the host, its process group, or daemonized descendants. Only the parent OS supervisor can prove that.
- Confidentiality from a malicious executor that observes its own request.
- Producer authenticity, approval, audience, or freshness. Those are application records.

## 5. State machine and teardown ordering

Executor state (supervisor-owned):

```text
allocated -> starting -> running -> revoking -> cleaning -> terminated
     \__________/            \_________/          \________/
       failure                  failure             failure
          \_______________________|____________________/
                                  v
                         fail-stop / parent-proven dead
```

Package orchestration per execution:

1. **Preflight (no allocation)**: raw cap, snapshot, expected `bundleSha256`, canonical parse, exact envelope/document/receipt shape, version checks, asset-set equality, policy projection/digest, budget, limits. Any failure returns before `allocate()`.
2. **Allocate**: call `allocate(request)` once. Catch synchronous throws. Require a control with a non-empty bounded opaque `executionId`, callable `revokeAndQuarantine`, `cleanup`, `terminateAndJoin`, and a callable `start`. Allocation must be side-effect-free; Struct cannot verify that, so conformance does.
3. **Start**: call `start()` exactly once, after retaining control. Race against the monotonic work deadline and cancellation. A synchronous throw, rejection, timeout, or never-settling promise enters teardown with no result iterator.
4. **Result validation**: check protocol version, resource ID, transport receipt kind/policy/IDs, and optional declared length **before** consuming chunks. A bad receipt enters teardown.
5. **Stream**: consume chunks one at a time. Reject non-`Uint8Array`, detached, oversized, or over-budget chunks; copy each chunk; update an incremental SHA-256; enforce per-asset and aggregate caps. At completion require exact `byteLength` and digest equality.
6. **Success teardown**: synchronously `revokeAndQuarantine()`; race `chunks.return()` when a result iterator exists; race `cleanup()`; await `terminateAndJoin()`; require `state: 'completed'` and exact ID. Only then store asset bytes and return the verified bundle.
7. **Failure teardown**: abort the stream/start; synchronously attempt `revokeAndQuarantine()`; if a result iterator exists, race `return()`; call `cleanup()`; call `terminateAndJoin()`; require `state: 'terminated'` and exact ID. Revocation/iterator/cleanup failure does not stop teardown.
8. **Fail-stop escalation**: on revocation throw/invalid receipt, terminal throw/invalid/missing, cleanup/join timeout, or post-grant ID ambiguity, call `hostSupervisor.failStop(executionId, reason)`. Continue teardown attempts first when the ADR requires it. Never return a verified bundle from a failed execution.

**Budget rule (stricter than the prose but never weaker):** one monotonic deadline per execution, `deadline = start + totalTimeoutMs`; work must finish by `deadline - cleanupReserveMs`; revocation, iterator return, cleanup, terminate/join, and receipt validation must finish by `deadline`. Fail-stop proof has its own parent-owned hard bound; if it cannot be proven inside that bound, return `RESOLVER_FAIL_STOP_UNPROVEN`.

**No-simulation rule:** a raced promise that resolves after a timer is a package-level timeout, not termination. Tests may assert `RESOLVER_JOIN_TIMEOUT` from the package race, but out-of-realm termination is asserted only by a separate parent process after a real signal/reap/cgroup census.

## 6. Validation rules

### Request

- `logicalHref` is copied from the document asset `href`; it is a logical EPUB-relative path, never a locator.
- `resourceId === 'sha256:' + expected.sha256`; the envelope payload must carry the same value.
- `expected.id/mediaType/byteLength` equal the joined document/envelope asset metadata.
- Policy projection and `expectedPolicySha256` are computed by Struct; the caller cannot supply a digest that disagrees.
- `budget` is safe-integer, `totalTimeoutMs >= 1`, `0 < cleanupReserveMs < totalTimeoutMs`.
- `maxConcurrent > 0` whenever external work exists; `0` is a valid policy value but an unusable profile for resolution and fails before allocation.
- Signal is not already aborted at allocation; if aborted after allocation, teardown runs.

### Result and receipts

- Exact own keys only; no extra `url`, `path`, `secret`, `token`, `headers`, `chunks` metadata, or functions.
- `protocolVersion === '1.0.0'`; `resourceId` exact.
- `transportReceipt.kind` equals `policy.transport.kind`; `policySha256` exact; transport-specific IDs exact.
- HTTPS: endpoint map exact; endpoint in `allowedEndpointIds`; redirect list duplicate-free, bounded by `maxRedirects`, empty when `redirects: 'deny'`, every member allowed.
- Filesystem: root capability exact. Content-addressed: store exact and algorithm `sha256` only.
- `declaredByteLength`, when present, equals expected and actual bytes.
- Revocation receipt: exact `executionId`, `capabilitiesRevoked === true`, `quarantined === true`; a thenable is not accepted.
- Terminal receipt: exact `executionId`; expected state by outcome; a stale/retired/swapped receipt fails.
- IDs are opaque, non-empty, bounded (1–256 UTF-16 code units), and carry no path/URL semantics.

### Stream

- Chunks are `Uint8Array` views with intrinsic `byteLength`/tag checks; copy immediately, never retain caller memory.
- Cumulative bytes cannot exceed `min(expected.byteLength, maxAssetBytes, remaining aggregate)`.
- A chunk after the declared length, a short stream, a digest mismatch, or iterator error fails the asset and the whole bundle.
- Iterator `return()` is called only when a result iterator exists; its rejection is recorded but does not skip cleanup/terminate.

## 7. Versioned limits profile (initial V1 proposal)

Put these in `src/bundle/limits.ts` as a frozen `STRUCT_BUNDLE_LIMITS_V1`. They are never looser than the current private bounds; loosening requires a new profile version and a new fixed-vector set.

| Cap | V1 |
| --- | --- |
| `maxRawEnvelopeBytes` | 8 MiB |
| `maxAssets` | 256 |
| `maxAssetBytes` | 32 MiB |
| `maxEmbeddedDecodedBytes` | 4 MiB |
| `maxTotalDecodedAssetBytes` | 128 MiB |
| `maxBase64Chars` | 8 MiB |
| `maxFieldBytes` | 1 MiB |
| `maxStringBytes` | 1 MiB |
| `maxNesting` | 128 |
| `maxNodes` | 1,000,000 |
| `maxConcurrent` | 8 |
| `maxReceiptBytes` | 16 KiB |
| `maxErrorBytes` | 4 KiB |
| `defaultTotalTimeoutMs` | 30,000 |
| `defaultCleanupReserveMs` | 5,000 |
| `maxTimeoutMs` | 120,000 |

`maxEmbeddedDecodedBytes` and `maxTotalDecodedAssetBytes` are distinct: the raw cap bounds embedded base64, while external payloads are bounded during streaming. Every cap gets N-1/N/N+1 vectors; zero and `MAX_SAFE_INTEGER` boundaries are covered.

## 8. Package protocol/conformance host vs concrete app executor

| Component | Owner | This plan |
| --- | --- | --- |
| Protocol types, policy digest, receipt/result validators, orchestration, limits | Struct | Implement |
| Conformance harness and invariant probes | Struct | Implement as `@erniesg/struct/bundle/conformance` (Node-only subpath) |
| Sacrificial host fixture used to prove fail-stop | Struct tests | Implement as a real child process with no transport; test-only |
| HTTPS endpoint map, DNS/private-address checks, redirects, broker credentials | Ernie.SG/Aether | Not implemented here; consumed via executor port |
| Filesystem descriptor root, traversal/symlink defenses | Ernie.SG/Aether | Not implemented here; consumed via executor port |
| Content-addressed store | Ernie.SG/Aether | Not implemented here; consumed via executor port |
| Producer authentication, trust epoch, replay/idempotency | Ernie.SG/Aether | Not implemented here; required before production external ingress |
| OS process supervisor, cgroup/process-group kill, descendant proof | Consumer app / test parent | Required capability; package only consumes the fail-stop port |

The conformance harness is host-agnostic: it drives the candidate executor through the same orchestration path and requires probes for broker grants, descendant admission, capacity retirement, and a real host handle. Test transports are in-memory policy probes, not network/filesystem resolvers. The harness must not claim to certify DNS, redirects, symlinks, or credentials unless the candidate supplies a real test double and probe.

## 9. Task and file boundaries

Each task is test-first: add the failing test/fixture, implement the smallest change, run the focused command, then the full suite. No task edits application goldens or publication state.

### T1 — Protocol types and guards

**Files:** `src/bundle/resolver-protocol.ts` (new), `tests/bundle-resolver-protocol.test.ts` (new).

- Copy the frozen interfaces and add the additive host-supervisor port.
- Add strict guards for request, result, revocation, terminal, fail-stop, and execution ID.
- No behavior change to the facade.
- Tests: exact-key/accessor/proxy/lone-surrogate/unsafe-integer/ID-length matrices; no secret retention.

### T2 — Versioned limits profile

**Files:** `src/bundle/limits.ts` (new), `tests/bundle-resolver-limits.test.ts` (new), `src/bundle/embedded.ts` (use profile constants without changing embedded semantics).

- Freeze the V1 table, expose only the version string and immutable values.
- Add N-1/N/N+1 vectors for raw, assets, per-asset, embedded, total, base64, string, nesting, concurrency, receipts, errors, budgets.
- Prove raw cap precedes allocation and parsing.

### T3 — Receipt and result validation

**Files:** `src/bundle/resolver-receipt.ts` (extend), `src/bundle/resolver-protocol.ts` (new validators), `tests/bundle-resolver-receipt.test.ts` (extend).

- Reuse `validateResolverReceiptProjection`; add canonical result validation and execution-bound revocation/terminal/fail-stop validation.
- Reject thenables, extra keys, swapped IDs, stale IDs, `quarantined: false`, missing/incorrect literals, and over-budget receipts.
- Keep errors structured and secret-free.

### T4 — Bounded streaming accumulator

**Files:** `src/bundle/resolver-stream.ts` (new), `tests/bundle-resolver-stream.test.ts` (new).

- Incremental SHA-256 matching the existing browser-safe implementation; copy-on-chunk; exact length/digest checks.
- Reject non-byte chunks, detached buffers, over-cap chunks, short/long streams, and iterator errors.
- Test chunk-boundary, zero-length, and 1-byte cases; assert peak retained bytes are bounded.

### T5 — Execution orchestrator

**Files:** `src/bundle/resolver-execution.ts` (new), `tests/bundle-resolver-execution.test.ts` (new).

- Implement the §5 state machine against fake in-process executors with controllable promises.
- Enforce one start, deadline/work-deadline split, abort → revoke → conditional iterator return → cleanup → terminate order.
- On success, require accepted revocation and `completed` terminal receipt before returning bytes.
- On failure, require teardown attempts before fail-stop; never call `start` after revocation/cleanup/termination.
- Tests: sync throw, reject, never-settling start, duplicate start rejection, start-after-* rejection, late completion, iterator return present/absent, cleanup throw/timeout, join timeout, receipt mismatch/swap, fail-stop unproven. No child process yet.

### T6 — Wire integration and async facade

**Files:** `src/bundle/index.ts`, `src/bundle/embedded.ts`, `src/bundle/canonical.ts` (only if projection hooks needed), `tests/bundle-public-surface.test.ts`, `tests/bundle-embedded.test.ts`, `tests/public-consumer/runtime.mjs`, `tests/public-consumer/types.ts`.

- Make `decodeStructBundle` async (`Promise<StructBundleAcceptanceResult>`), matching the ADR facade. Keep the embedded fast path.
- Embedded-only envelopes never call resolver code. External envelopes require the complete resolver option set.
- Expected `bundleSha256` mismatch returns before parse/allocation; tests assert zero `allocate`/`start`.
- Update all existing tests/docs to `await`; keep encode/verify sync.
- Add public negative tests for missing/invalid executor, host supervisor, policy, budget, signal, and external asset metadata.

### T7 — Conformance harness

**Files:** `src/bundle/conformance/index.ts` (new), `src/bundle/conformance/probes.ts` (new), `tests/bundle-resolver-conformance.test.ts` (new), `tests/fixtures/resolver/*` (new).

- Export from a separate Node-only subpath `./bundle/conformance`; update `package.json` build/exports and `API_MANIFEST.json`.
- Harness cases: side-effect-free allocation; concurrent duplicate IDs; retired-ID reuse; duplicate/late start; start after revoke/cleanup/terminate; sync throw/reject/never-settling start; late completion; clean success; quarantine-false; revocation failure; mismatched/swapped receipts; zero post-revocation broker calls/grants/descendants; pre-start cleanup; iterator cleanup; never-settling cleanup; receipt equality; policy vectors; secret non-retention.
- A deliberately non-conforming fixture per invariant must fail the report; a conforming fixture must pass.
- The harness reports non-secret case names and outcomes only.

### T8 — Sacrificial host and aggregate admission

**Files:** `tests/fixtures/resolver/sacrificial-host.mjs` (new), `tests/bundle-resolver-failstop.test.ts` (new), `scripts/run-resolver-failstop.mjs` (optional helper).

- Spawn a real child with `detached: true` (process group) or an app-provided cgroup/pid-namespace launcher. The child can spawn a grandchild that ignores `SIGTERM` and never settles cleanup/join.
- Parent sends `SIGTERM`, waits a bounded grace period, sends `SIGKILL` to the process group, reaps, and proves no descendant remains by process-group/cgroup census. A timer-only path is a test failure, not a pass.
- Assert: host dead, descendants dead, capacity retired/tombstone, ID never reused, no new allocation admitted under the old capacity, aggregate admission at N-1/N/N+1.
- Fail-stop receipt is validated only after parent proof; a child that merely self-reports death fails.

### T9 — Docs, manifest, clean consumer

**Files:** `CONTRACT.md`, `API.md`, `API_MANIFEST.json`, `README.md`, `MIGRATION.md`, `package.json`, `tests/public-api-manifest.test.ts`, `tests/public-consumer/*`, `scripts/test-packed-consumer.mjs` (only if the new subpath needs packing coverage).

- Document the async facade, external resolver options, limits profile, conformance subpath, and the package-vs-app ownership split.
- Document that integrity/conservation is not authenticity.
- Add the new export and runtime export names to the manifest; keep private paths unavailable.
- Packed consumer: import every documented subpath, compile declarations, run an embedded and an external happy path with a fake executor, and assert private paths fail.

### T10 — Adversarial matrix and S-04 handoff

**Files:** tests only, plus a short evidence note in the PR/plan.

- Fuzz hostile objects, cycles, lone surrogates, unsafe integers, duplicate keys, huge nesting, raw pressure, chunk pressure, deceptive lengths, and limit boundaries.
- Run the full S-03 matrix through public exports and the packed consumer.
- Record exact head, tarball digest, test counts, and known limitations. Do **not** publish or regenerate app goldens.

## 10. Concrete test matrix (acceptance mapping)

| Contract clause | Test |
| --- | --- |
| Lifetime-unique ID, active/retired tombstone | T7 concurrent allocation with forced collision; T8 post-termination reuse rejection |
| Side-effect-free allocation | T7 probe: zero broker grants, adapter calls, descendants before `start` |
| One-shot start | T5/T7 duplicate start, start after revoke/cleanup/terminate |
| Startup throw/reject/never settle | T5/T7 each outcome; cleanup available and called |
| Revocation atomicity | T7 `quarantined: false`, throw, mismatch, thenable; probe zero grants/calls/descendants after accepted receipt |
| Late completion | T7 timeout/revoke then resolve start; no result, grant, descendant, capacity reuse |
| Cleanup/termination/join | T5 accepted and failing variants; T8 never-settling cleanup/join |
| Out-of-realm termination | T8 real child + parent signal/reap/descendant census; no timer-only assertion |
| Fail-stop and capacity retirement | T7 invalid terminal/revocation; T8 parent proof + tombstone probe |
| Receipt binding | T5/T7 stale/swapped IDs across active and retired executions |
| Policy digest | T3 fixed Python-generated vectors for all transport kinds and boundary IDs |
| Expected `bundleSha256` | T6 mismatch before parse; zero allocate/start |
| Streaming bounds | T4 chunk boundaries, over-cap, short/long, deceptive `declaredByteLength` |
| Budget/cancellation | T5 monotonic work/cleanup split; T7 startup timeout, abort, cleanup reserve |
| Iterator return | T5 result exists vs no result; return rejection still tears down |
| Zero post-revocation authority | T7/T8 probe counters |
| Secret non-retention | T3/T7 receipt/error/report scans for URL, path, token, matrix/percent alias |
| Aggregate admission | T8 N-1/N/N+1, repeated fail-stop capacity refusal |
| Canonical/wire invariants | Existing bundle tests remain green; no app goldens |

### Required negative fixtures

- Execution ID duplicate before grant; collision discovered after grant.
- Retired ID reused; stale receipt from retired execution; receipt swapped between two active executions.
- `quarantined: false`; missing `capabilitiesRevoked`; revocation returns a promise; terminal returns wrong state/ID.
- Start called twice; start after revocation; start after cleanup; start after termination.
- Startup never settles; cleanup never settles; join never settles; late start resolves after timeout.
- Chunk stream is longer/shorter than `declaredByteLength`; digest mismatch; non-`Uint8Array`; detached buffer.
- Endpoint alias, redirect loop, private target, traversal/symlink (candidate test double; package harness asserts protocol/receipt behavior only).
- Aggregate pressure: one more than `maxConcurrent`, one more than host admission, repeated fail-stop.

## 11. High-risk pilot scenarios (run 3–5 before broad work)

1. **Daemonized descendant escapes the direct child.** A sacrificial host spawns a grandchild with a new session/process group or double-forks. Kill only the direct child and prove whether the grandchild survives. This determines whether process-group kill is sufficient or cgroup v2/pid-namespace supervision is mandatory. A passing direct-child test alone is not evidence.
2. **Revocation races an in-flight broker grant and late start.** Force `start()` to resolve after the package timeout, while the adapter attempts a broker call. Assert the revocation receipt is returned only after grants/descendant admission are atomically closed, zero calls occur after receipt, and the late result is quarantined without capacity reuse.
3. **Execution-ID collision and retired reuse across supervisor restart.** Inject a deterministic ID source to collide during concurrent allocation, then reuse a retired ID. Verify pre-grant failure for both; for a post-grant collision, verify fail-stop, tombstone, and no capacity reuse. A supervisor restart must not reset the lifetime registry within the same supervisor lifetime.
4. **Aggregate pressure exhausts cleanup reserve.** Run `maxConcurrent` external assets with a short `totalTimeoutMs` and non-trivial `cleanupReserveMs`; assert no new start after the work deadline, every started execution tears down, peak memory stays bounded, and the extra asset is denied without reusing capacity.
5. **Receipt/secret swap across executions.** Swap revocation/terminal receipts between two concurrent executions and embed URL/path/token/matrix/percent aliases in a hostile transport receipt. Assert fail-closed ID checks, fail-stop when teardown evidence is invalid, and no secret appears in errors, reports, receipts, or logs.

## 12. Genuine external capability blockers

1. **OS-level descendant proof.** Node process groups cover ordinary children but not `setsid`/double-fork escapes. Proving "host and descendants dead" requires an app-owned cgroup v2 or PID-namespace launcher with `waitpid`/reap. If the deployment environment cannot delegate cgroups, the strongest available proof is process-group + `/proc` census, which must be documented as a limitation, not called guaranteed termination.
2. **Concrete transports.** HTTPS endpoint maps, DNS/private-address checks, redirects, descriptor-root filesystem access, symlink/traversal defenses, and content-addressed stores are consumer-owned. The package cannot certify real network/filesystem policy and must not implement it.
3. **Producer authenticity and trust epoch.** External asset resolution in production must remain inactive until Ernie.SG/Aether supply authenticated producer records, current/rollback-safe trust status, audience/replay checks, and `bundleSha256` binding before `start()`. Struct integrity alone is insufficient.
4. **Browser/runtime isolation.** A browser or worker-only host cannot guarantee out-of-realm process kill. External resolution is a server-side capability; a worker `terminate()` is not parent-proven termination.
5. **Publication and clean-consumer proof.** S-04 tarball/consumer evidence and any registry release remain separate approvals. No publish, writer activation, or app golden regeneration is authorized here.

## 13. Validation commands

Run every command from the assigned absolute worktree:

```bash
cd /home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/resolver-plan
pnpm exec vitest run tests/bundle-resolver-*.test.ts
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm run test:package
pnpm run test:source-boundary
```

The sacrificial-host test must be included in `vitest run` (not skipped) and must fail if the parent cannot prove death. Its timing bounds must be generous enough for CI but still bounded.

## 14. Exit criteria for this plan

- The frozen interfaces are implemented without semantic drift; the additive host port is the only public extension.
- An external bundle resolves only after a valid transport receipt, exact byte/digest match, accepted revocation, and execution-ID-bound terminal receipt.
- Duplicate/retired IDs, duplicate start, start-after-teardown, late start, revocation failure, swapped receipts, and never-settling cleanup/join fail closed.
- A real sacrificial host proves parent-side termination and descendant death; a timer-only test does not satisfy the clause.
- Limits and policy have fixed cross-runtime vectors and N-1/N/N+1 coverage.
- No app goldens, publication, writer, or cutover claims are included.
- S-03 remains open until the companion create/verify/full-limit-profile matrix lands; S-04 remains blocked on that complete surface.
