# Bundle resolver executor: implementation and conformance plan

**Date:** 2026-10-20
**Revision:** v3 — resolves independent review `resolver-plan-v2` findings F1–F6 and fresh review notes L1–L2 against the updated `CONTRACT-DECISIONS.json` (one frozen `STRUCT_BUNDLE_LIMITS_PROFILE`, mandatory `resolverBudget`, no implicit default budget).
**Repository:** `erniesg/struct`
**Governing contract:** ADR-0001 (`erniesg/erniesg:docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md`), issue-plan S-03/S-04 (`erniesg/erniesg:docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md`), and this repository's `CONTRACT.md` "Planned Bundle semantics".
**Status:** implementation plan only. This document changes no runtime behavior, proposes no ADR amendment, and claims no cutover.

## 1. Scope and non-negotiable boundaries

This plan closes the resolver-executor slice of S-03:

- versioned resolver policy, request, result, revocation, terminal, and fail-stop contracts;
- lifetime-unique execution identity, one-shot start, revocation/quarantine, cleanup, termination/join;
- bounded streaming external-asset resolution through a consumer-supplied executor;
- package-owned conformance harness and a real sacrificial-host test for parent-proven fail-stop;
- the frozen versioned Bundle limits profile that bounds raw input and resolved bytes before unbounded allocation.

It does **not**:

- implement HTTPS, filesystem, content-addressed-store, DNS, redirect, or descriptor-root resolution;
- publish a package, regenerate application goldens, activate a writer or public route, repin an application artifact, or claim S-04/full cutover;
- add producer authentication to Struct (that is Ernie.SG/E-02/E-05 and Aether/A-02 work);
- treat a `Promise.race`, `AbortSignal.timeout`, worker `terminate()`, or executor self-report as out-of-realm termination;
- amend ADR-0001 to fit any implementation convenience.

The pinned ADR interfaces in §4.1 are frozen. Any implementation pressure to remove a field, weaken a literal (`capabilitiesRevoked: true`, `quarantined: true`), or move a supervisor duty into adapter code requires an ADR amendment, not a plan deviation. Additive ports are marked as such and stay outside the pinned declarations.

## 2. Binding coordinator decisions

`CONTRACT-DECISIONS.json` is mandatory implementation guidance derived from the already-approved ADR-0001 facade and S-03 acceptance. This plan conforms to it; it does not reinterpret it.

| Decision | Binding rule | Applied in |
| --- | --- | --- |
| Facade | `createStructBundle` returns a `VerifiedStructBundle` and throws a documented structured error; `decodeStructBundle` is always `Promise<VerifiedStructBundle>` and rejects with a structured error; `verifyStructBundle` returns a handle and throws; `encodeStructBundle` returns `Uint8Array` and throws a structured error for a forged handle | §4.4, §10 (T6) |
| Resolver option | `decodeOptions.resolverExecutor` implements the pinned `StructResolverExecutorV1`. Policy, budget, signal, and host-supervisor inputs are separate documented option fields; a nested `resolver.executor` object is not public authority | §4.3 |
| Limits | One frozen profile: `maxAssetBytes` 4194304, `maxTotalBytes` 4194304, `maxDecodedBytes` 4194304, `maxBase64Chars` 5592408, `maxRawBytes` 8388608. External resolution cannot silently enlarge current limits. Boundary tests required | §8 |
| Resolver runtime caps | One frozen `STRUCT_BUNDLE_LIMITS_PROFILE` in `src/bundle/limits.ts` is the single source: `maxConcurrency` 1 and `maxResolverTimeoutMs` 120000. `policy.maxConcurrent <= profile.maxConcurrency` and `totalTimeoutMs <= profile.maxResolverTimeoutMs` are validated before allocation. `resolverBudget` is mandatory; there is no implicit default budget. The package monotonic clock is authoritative; any test clock injection stays private and is never a public decode option | §4.3, §7, §8 |
| Signal | `request.signal` is always a real `AbortSignal`. The decoder may accept an optional caller signal; the package creates a package-owned `AbortController` per execution and combines caller abort with the total/cleanup deadline. The request signal is never omitted | §4.3, §6, §7 |
| Budget | The package monotonic total starts before preflight and allocation; the cleanup reserve is taken before allocation; allocation, start, stream, revoke, cleanup, and terminate all fit one bounded lifecycle; an unavailable join is an irreversible fail-stop | §6 |
| Pinned interfaces | Copy the exact ADR request/result/executor/handle/control declarations; an additive parent fail-stop port may be separate; no concrete I/O transport implementation | §4.1, §4.2 |
| Compatibility | The installed application core tarball exposes no `./bundle`, so no released Bundle consumer is broken. Private result-object helpers may be preserved internally; public names must match the stable ADR. Stage 1 tests/docs need a deliberate migration, and no application artifact repin is authorized here | §3, §4.4 |
| Ownership lanes | Plan: `resolver-plan-fix`. Public facade: `embedded-facade-fix`. Protocol lifecycle: `resolver-runtime`. Host conformance: `resolver-host-resume`. Manifest/pack consumer: reserved for later integration. `src/bundle/limits.ts`: `resolver-runtime` adds `maxResolverTimeoutMs` and enforces `maxConcurrency` 1 on its branch; the facade lane leaves `limits.ts` unchanged; the integrator merges | §10 |

## 3. Current-state audit (exact head `998be09`)

| Area | Present today | Gap against the full contract |
| --- | --- | --- |
| Public facade | `decodeStructBundle`/`encodeStructBundle` at `@erniesg/struct/bundle`; embedded assets only; `UNRESOLVED` for external | No external path, no `createStructBundle`/`verifyStructBundle`, no resolver options |
| Public error style | Stage 1 returns `{ ok: false, error }` result objects | ADR facade returns a handle and throws/rejects a documented structured error; Stage 1 must be migrated deliberately in the facade lane |
| Policy | `src/bundle/resolver-policy.ts`: strict projection, identifier grammar, domain-separated digest, pinned vectors | `maxConcurrent: 0` is accepted; orchestration must reject it when work exists |
| Receipts | `src/bundle/resolver-receipt.ts`: data-only transport receipt validation | No result, revocation, terminal, execution-ID, or fail-stop receipts |
| Streaming | None | No bounded chunk accumulator, incremental digest, cancellation, or iterator return |
| State machine | None | No allocation, one-shot start, revoke/quarantine, cleanup, terminate/join ordering |
| Identity | None | No lifetime registry, retired tombstone, duplicate/retired-ID conformance |
| Limits | Private constants in `embedded.ts` (`maxRawBytes` 8 MiB, `maxAssetBytes` 4 MiB, `maxTotalBytes` 4 MiB, `maxBase64Chars` 5592408) and `assets.ts`/`canonical.ts` | No frozen public profile module, no N-1/N/N+1 vectors |
| Conformance | None | No harness, no sacrificial host, no parent death proof |
| Facade shape | `decodeStructBundle` is synchronous | ADR facade is `Promise<VerifiedStructBundle>`; external resolution is necessarily async |
| Compatibility | The installed application core tarball has no `./bundle` export | No released consumer is broken; no application artifact repin is authorized in this plan |

The existing embedded implementation, policy projection, receipt projection, canonicalization, and asset verification are sound inputs to this work and must be preserved rather than rewritten.

## 4. Protocol, options, and public shape

### 4.1 Frozen protocol interfaces

These declarations are copied verbatim from ADR-0001 and must remain semantically identical. Implementation may add internal helpers; it may not rename, narrow, or drop members.

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

type StructAssetResolutionPolicyV1 = {
  protocolVersion: '1.0.0'
  profileId: string
  profileVersion: string
  maxConcurrent: number
  transport:
    | {
        kind: 'https'
        endpointMapId: string
        allowedEndpointIds: readonly string[]
        redirects: 'deny' | 'same-origin'
        maxRedirects: number
        denyPrivateNetworks: true
        serializedLocators: false
      }
    | {
        kind: 'filesystem'
        rootCapabilityId: string
        allowAbsolute: false
        allowTraversal: false
        allowSymlinks: false
      }
    | {
        kind: 'content-addressed'
        storeId: string
        algorithm: 'sha256'
      }
}

type StructAssetResolutionResult = {
  protocolVersion: '1.0.0'
  resourceId: `sha256:${string}`
  chunks: AsyncIterable<Uint8Array>
  transportReceipt:
    | Readonly<{
        kind: 'https'
        policySha256: string
        endpointMapId: string
        endpointId: string
        redirectEndpointIds: readonly string[]
      }>
    | Readonly<{
        kind: 'filesystem'
        policySha256: string
        rootCapabilityId: string
      }>
    | Readonly<{
        kind: 'content-addressed'
        policySha256: string
        storeId: string
      }>
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
  // Collision-resistant, supervisor-generated, and never reused during this supervisor lifetime.
  readonly executionId: string
  // Synchronously invalidates brokered credential, filesystem, and egress authority.
  revokeAndQuarantine(): StructResolverRevocationReceipt
  // Idempotent supervisor cleanup is available before start and remains callable if start throws, rejects, or never settles.
  cleanup(): Promise<void>
  // Controlled by the isolated worker/process supervisor, not adapter code.
  terminateAndJoin(): Promise<StructResolverTerminalReceipt>
}

type StructResolverExecutionHandle = {
  control: StructResolverExecutionControl
  // One-shot: called only after Struct holds `control`; this is the sole authority-granting step.
  start(): Promise<StructAssetResolutionResult>
}

interface StructResolverExecutorV1 {
  // Allocation is side-effect-free with respect to adapter/transport authority.
  allocate(request: StructAssetResolutionRequest): StructResolverExecutionHandle
}
```

### 4.2 Additive host-supervision port (separate from the pinned types)

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

The receipt is **client-attested consistency evidence**, not cryptographic proof and not authentication. Struct validates its shape and execution ID. Only the parent process supervisor and the conformance harness can prove the host and descendants are dead. If fail-stop is unavailable, unresolvable, or returns an invalid receipt, Struct reports `RESOLVER_FAIL_STOP_UNPROVEN`; it never reports normal completion or capacity reuse.

### 4.3 Decode options (flat, ADR-aligned field names)

ADR-0001 pins `decodeOptions.resolverExecutor`. The remaining resolver inputs are separate, explicitly documented option fields. There is no nested `resolver` grouping and no `resolver.executor` nesting in the public authority.

```ts
type StructBundleDecodeOptions = Readonly<{
  // Bytes ingress only.
  expectedBundleSha256?: string
  // Versioned consumer port (ADR-pinned field name).
  resolverExecutor?: StructResolverExecutorV1
  // Strict policy projection; Struct computes expectedPolicySha256 from it.
  resolverPolicy?: StructAssetResolutionPolicyV1
  // Monotonic total budget and the cleanup reserve taken before allocation.
  // Mandatory whenever a resolver is used; there is no implicit default budget.
  resolverBudget?: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  // Optional caller cancellation; the package still owns the request signal.
  resolverSignal?: AbortSignal
  // Required parent-realm fail-stop capability for any executor.
  resolverHostSupervisor?: StructResolverHostSupervisorV1
}>
```

Rules:

- Strict, own-data-property snapshot; unknown keys, accessors, prototypes, proxies, and duplicate keys fail closed before any allocation.
- All-or-nothing resolver configuration: if any `resolver*` field is present, `resolverExecutor`, `resolverPolicy`, `resolverBudget`, and `resolverHostSupervisor` must all be present and valid. `resolverSignal` is optional because the package supplies the default (§4.3.1). A partial set is an options error.
- `resolverBudget` is mandatory whenever a resolver is used. There is no implicit default budget: the package never substitutes a timeout or a cleanup reserve, and a missing or malformed budget is an options error raised before any allocation.
- `resolverBudget` bounds: `totalTimeoutMs` is a safe integer in `[1, profile.maxResolverTimeoutMs]`; `cleanupReserveMs` is a safe integer in `[1, totalTimeoutMs)`. Values above the profile bound are rejected in preflight, before any allocation (§7).
- `resolverHostSupervisor` is mandatory: an executor that cannot fail-stop is non-conforming for external assets.
- Resolver options are validated before raw parsing so a malformed option set cannot allocate. They are inert for envelopes with no external payload, but a partial or unknown option set is still an options error.
- The package computes `expectedPolicySha256` from the strict policy projection before any `allocate()` call and places the same immutable policy snapshot in every request.

#### 4.3.1 Cancellation signal

- `resolverSignal` is an optional caller signal. It is validated once for `AbortSignal` identity and retained only as an abort listener; the listener is removed in `finally`.
- The package creates a **package-owned `AbortController` for every execution** and passes that controller's `signal` as `request.signal`. The request signal is never omitted and is never the caller's object.
- The package-owned signal aborts when the caller signal aborts or when the execution's work deadline elapses, whichever happens first. The caller signal is never forwarded by reference.
- If the caller signal is already aborted when the execution is prepared, the package still creates its controller, aborts it immediately, and the execution fails through the normal abort/teardown path rather than skipping cleanup.
- Negative tests: missing/invalid `resolverSignal` type, a pre-aborted caller signal, an `AbortSignal` from a foreign realm, and an `AbortSignal`-like impostor object are all rejected or handled without leaking a caller-owned signal into the request.

### 4.4 Public facade shape (stable, ADR-aligned)

```ts
createStructBundle(input, options): VerifiedStructBundle
decodeStructBundle(rawJsonBytes, decodeOptions): Promise<VerifiedStructBundle>
verifyStructBundle(value, embeddedValueOptions): VerifiedStructBundle
encodeStructBundle(bundle: VerifiedStructBundle): Uint8Array
```

Rules:

- Every public acceptance API returns a genuine handle or throws/rejects a documented structured error. No public API returns a nominally accepted unverified bundle, and no public API returns a result object on the success or failure path.
- The structured error is a documented error type with a stable machine-readable `code`, a `stage`, and non-secret context only. It never carries URLs, paths, tokens, or raw adapter output.
- Private result-object helpers (the current `decodeEmbeddedBundleBytes` shape) may be preserved inside `src/bundle/**` as internal implementation and for internal tests, but the public names and public behavior must match the ADR.
- Stage 1 migration is deliberate: current Stage 1 tests and docs expect result objects, so the facade lane migrates them together. The installed application core tarball exposes no `./bundle`, so no released consumer is broken, and no application artifact repin is authorized by this plan.

## 5. Supervisor trust and realm boundaries

| Realm | Owner | Holds | Must never |
| --- | --- | --- | --- |
| Package/caller | Struct | raw bytes, canonical bytes, parsed document, monotonic deadline, package-owned abort controller, orchestration state, private verified storage | spawn adapter code synchronously; grant broker/fs/net authority; treat executor or fail-stop receipts as proof of death/authenticity |
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

## 6. State machine, budget origin, and teardown ordering

Executor state (supervisor-owned):

```text
allocated -> starting -> running -> revoking -> cleaning -> terminated
     \__________/            \_________/          \________/
       failure                  failure             failure
          \_______________________|____________________/
                                  v
                         fail-stop / parent-proven dead
```

Package orchestration per decode:

0. **Deadline origin.** The package starts its monotonic total clock at decode entry, before preflight, before parsing, and before any `allocate()` call. The cleanup reserve is subtracted from the total and reserved before the first allocation. One decode-level deadline governs the whole decode; each execution receives a sub-deadline derived from it.
1. **Preflight (no allocation)**: raw cap, snapshot, expected `bundleSha256`, canonical parse, exact envelope/document/receipt shape, version checks, asset-set equality, policy projection/digest, mandatory `resolverBudget` with its profile bounds, profile limits, and the package-owned abort controller. Any failure returns before `allocate()`.
2. **Allocate**: call `allocate(request)` once. Catch synchronous throws. Require a control with a non-empty bounded opaque `executionId`, callable `revokeAndQuarantine`, `cleanup`, `terminateAndJoin`, and a callable `start`. Allocation must be side-effect-free; Struct cannot verify that, so conformance does.
3. **Start**: call `start()` exactly once, after retaining control. Race against the execution work deadline and the package-owned signal. A synchronous throw, rejection, timeout, or never-settling promise enters teardown with no result iterator.
4. **Result validation**: check protocol version, resource ID, transport receipt kind/policy/IDs, and optional declared length **before** consuming chunks. A bad receipt enters teardown.
5. **Stream**: consume chunks one at a time. Reject non-`Uint8Array`, detached, oversized, or over-budget chunks; copy each chunk; update an incremental SHA-256; enforce per-asset and aggregate caps. At completion require exact `byteLength` and digest equality.
6. **Success teardown**: synchronously `revokeAndQuarantine()`; race `chunks.return()` when a result iterator exists; race `cleanup()`; await `terminateAndJoin()`; require `state: 'completed'` and exact ID. Only then store asset bytes and resolve the verified bundle.
7. **Failure teardown**: abort the package-owned signal and the stream/start; synchronously attempt `revokeAndQuarantine()`; if a result iterator exists, race `return()`; call `cleanup()`; call `terminateAndJoin()`; require `state: 'terminated'` and exact ID. Revocation/iterator/cleanup failure does not stop teardown.
8. **Fail-stop escalation**: on revocation throw/invalid receipt, terminal throw/invalid/missing, cleanup/join timeout, or post-grant ID ambiguity, call `resolverHostSupervisor.failStop(executionId, reason)`. Continue teardown attempts first when the ADR requires it. Never resolve a verified bundle from a failed execution.

**Budget rule.** The budget comes only from the mandatory `resolverBudget`; there is no implicit default budget and no substituted timeout or cleanup reserve. The monotonic total starts before preflight and allocation; the cleanup reserve is taken before the first `allocate()`. For one decode: `totalDeadline = decodeStart + totalTimeoutMs`, `workDeadline = totalDeadline - cleanupReserveMs`. Preflight, allocation, start, and stream must complete by `workDeadline`; revocation, iterator return, cleanup, terminate/join, and receipt validation must complete by `totalDeadline`. When the decode serves several external assets, the work budget is shared: the sum of the scheduled per-asset work windows must fit inside `workDeadline`, and no new allocation may start after `workDeadline`. Fail-stop proof has its own parent-owned hard bound; if it cannot be proven inside that bound, the result is `RESOLVER_FAIL_STOP_UNPROVEN` and the lifecycle is irreversibly failed.

**No-simulation rule:** a raced promise that resolves after a timer is a package-level timeout, not termination. Tests may assert `RESOLVER_JOIN_TIMEOUT` from the package race, but out-of-realm termination is asserted only by a separate parent process after a real signal/reap/cgroup census.

## 7. Validation rules

### Request

- `logicalHref` is copied from the document asset `href`; it is a logical EPUB-relative path, never a locator.
- `resourceId === 'sha256:' + expected.sha256`; the envelope payload must carry the same value.
- `expected.id/mediaType/byteLength` equal the joined document/envelope asset metadata.
- Policy projection and `expectedPolicySha256` are computed by Struct; the caller cannot supply a digest that disagrees.
- `resolverBudget` is mandatory whenever a resolver is used; there is no implicit default budget. `totalTimeoutMs` is a safe integer in `[1, profile.maxResolverTimeoutMs]` and `cleanupReserveMs` is a safe integer in `[1, totalTimeoutMs)`. A `totalTimeoutMs` above the profile bound is rejected in preflight, before any allocation.
- `policy.maxConcurrent` must satisfy `1 <= policy.maxConcurrent <= profile.maxConcurrency`. A policy above the profile bound is rejected in preflight, before any allocation. The effective concurrency is `min(policy.maxConcurrent, profile.maxConcurrency)`.
- The policy projection itself is unchanged by these profile checks: the standalone strict policy validator keeps accepting the pinned policy vectors, and the profile bounds apply on the resolution path only.
- All budget and policy bound checks run in preflight, before `allocate()`. The frozen profile is the authority for these numbers; the test vectors only demonstrate them and never define a cap.
- `signal` is always the package-owned controller's signal (§4.3.1); it is never omitted, never the caller's object, and aborts on caller abort or work deadline.

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
- Cumulative bytes cannot exceed `min(expected.byteLength, maxAssetBytes, maxDecodedBytes, remaining aggregate)`.
- A chunk after the declared length, a short stream, a digest mismatch, or iterator error fails the asset and the whole bundle.
- Iterator `return()` is called only when a result iterator exists; its rejection is recorded but does not skip cleanup/terminate.

## 8. Frozen limits profile (`STRUCT_BUNDLE_LIMITS_PROFILE`)

One frozen profile lives in `src/bundle/limits.ts` as `STRUCT_BUNDLE_LIMITS_PROFILE`. There is exactly one object, one set of field names, and no aliases. The byte/size values are exactly the current private/embedded bounds, so adopting the profile changes no embedded behavior. External resolution is bounded by the same numbers and **cannot silently enlarge current limits**; any later widening requires a new profile version plus a new fixed-vector set.

| Cap | Value | Source of the bound |
| --- | --- | --- |
| `maxRawBytes` | 8388608 (8 MiB) | `embedded.ts` `MAX_RAW_BYTES` |
| `maxAssetBytes` | 4194304 (4 MiB) | `embedded.ts` `ASSET_LIMITS.maxAssetBytes` |
| `maxTotalBytes` | 4194304 (4 MiB) | `embedded.ts` `ASSET_LIMITS.maxTotalBytes` |
| `maxDecodedBytes` | 4194304 (4 MiB) | per-asset decoded cap, equal to the current per-asset cap |
| `maxBase64Chars` | 5592408 | `embedded.ts` `ASSET_LIMITS.maxBase64Chars` |
| `maxAssets` | 256 | `embedded.ts` `ASSET_LIMITS.maxAssets` |
| `maxNesting` | 128 | `canonical.ts` `MAX_DEPTH` |
| `maxNodes` | 1000000 | `canonical.ts` `MAX_NODES` |
| `maxFieldBytes` | 1048576 (1 MiB) | new cap; see the corpus rule below |
| `maxStringBytes` | 1048576 (1 MiB) | new cap; see the corpus rule below |
| `maxReceiptBytes` | 16384 (16 KiB) | new cap for transport/execution receipts |
| `maxErrorBytes` | 4096 (4 KiB) | new cap for structured error payloads |
| `maxConcurrency` | 1 | package ceiling for concurrent resolver executions |
| `maxResolverTimeoutMs` | 120000 | upper bound for `resolverBudget.totalTimeoutMs` |

**Adoption status at the cutover candidate head.** This table is a proposal; the
frozen profile is the authority. At the cutover candidate the published
`STRUCT_BUNDLE_LIMITS_PROFILE` adopted `maxFieldBytes = 5600000` (not the
1048576 proposed above) and did **not** adopt `maxStringBytes`,
`maxReceiptBytes` or `maxErrorBytes`. The published caps are `maxRawBytes`,
`maxFieldBytes`, `maxAssets`, `maxAssetBytes`, `maxTotalBytes`,
`maxDecodedBytes`, `maxBase64Chars`, `maxConcurrency`, `maxDepth`,
`maxStringLength`, `maxNodes`, `maxResolverTimeoutMs` and `profileVersion`.
The per-string bound is `maxStringLength`, enforced as a UTF-8 byte length in
the canonicalizer's `visitValue` and in the create preflight.

Profile rules:

- The embedded fast path keeps its current constants and semantics. The profile module is the single source of those values, so the embedded numbers are unchanged by construction; no external cap is applied to the embedded path beyond the values it already enforces.
- External resolution is bounded by the same profile: per-asset decoded bytes cannot exceed `maxDecodedBytes`, the aggregate across assets cannot exceed `maxTotalBytes`, and the raw cap still bounds the envelope that carries embedded base64. External streaming cannot exceed the embedded per-asset or aggregate caps.
- `maxFieldBytes` and `maxStringBytes` are caps ADR clause 12 requires but the current code does not enforce. They are validated against the existing canonical corpus first. If any currently accepted fixture exceeds a proposed value, the cap is raised to the smallest value above the observed maximum and recorded with that evidence; a cap is never silently tightened below input the package already accepts.
- Every cap gets N-1/N/N+1 vectors, plus zero and `MAX_SAFE_INTEGER` boundaries. The raw cap and the per-asset/aggregate caps are enforced before unbounded allocation.
- `maxConcurrency` 1 is the package ceiling: `policy.maxConcurrent` must satisfy `1 <= policy.maxConcurrent <= profile.maxConcurrency`, checked in preflight before any allocation, and the effective concurrency is `min(policy.maxConcurrent, profile.maxConcurrency)`. There is no second, looser concurrency alias.
- `maxResolverTimeoutMs` 120000 is the ceiling for `resolverBudget.totalTimeoutMs`, checked in preflight before any allocation. There is no second, looser timeout alias.
- There is no default budget. The profile carries no default timeout and no default cleanup reserve; `resolverBudget` is mandatory at the call site, and the package never substitutes one.
- The frozen profile is the authority for every number in this table. Test vectors demonstrate the bounds; they never define, widen, or narrow a cap.
- There is exactly one set of numbers. If another lane introduces a shared `src/limits.ts`, the bundle profile must be expressed from that module, or the two modules must carry identical frozen values; the profile is never forked or re-derived per call site.
- Ownership: `resolver-runtime` adds `maxResolverTimeoutMs` and enforces `maxConcurrency` 1 on its branch; the public-facade lane leaves `src/bundle/limits.ts` unchanged; the integrator merges the branches.

## 9. Package protocol/conformance host vs concrete app executor

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

## 10. Task and file boundaries

Each task is test-first: add the failing test/fixture, implement the smallest change, run the focused command, then the type check. No task edits application goldens, repins an application artifact, or touches publication state. Task ownership follows the coordinator lanes in §2; a lane must not edit another lane's seam.

### T1 — Protocol types and guards

**Lane:** `resolver-runtime`. **Files:** `src/bundle/resolver-protocol.ts` (new), `tests/bundle-resolver-protocol.test.ts` (new).

- Copy the frozen §4.1 declarations exactly and add the separate §4.2 host-supervisor port.
- Add strict guards for request, result, revocation, terminal, fail-stop, and execution ID.
- No behavior change to the facade.
- Tests: exact-key/accessor/proxy/lone-surrogate/unsafe-integer/ID-length matrices; no secret retention.

### T2 — Frozen limits profile

**Lane:** `resolver-runtime`. **Files:** `src/bundle/limits.ts` (new), `tests/bundle-resolver-limits.test.ts` (new), `src/bundle/embedded.ts` (adopt the profile constants with identical values).

- Freeze the single `STRUCT_BUNDLE_LIMITS_PROFILE` object in `src/bundle/limits.ts`; expose only the profile version string and the immutable values. One object, one set of field names, no aliases.
- The embedded fast path keeps its current constants and behavior; the profile module carries the same numbers, so nothing about embedded acceptance changes.
- Add the resolver runtime caps on this lane's branch: `maxConcurrency` 1 and `maxResolverTimeoutMs` 120000. The public-facade lane leaves `src/bundle/limits.ts` unchanged; the integrator merges the branches.
- The profile carries no default budget: no default timeout and no default cleanup reserve. `resolverBudget` is mandatory at the call site.
- Add N-1/N/N+1 vectors for raw bytes, assets, per-asset bytes, decoded bytes, total bytes, base64 chars, field/string bytes, nesting, nodes, receipts, errors, `maxConcurrency`, and `maxResolverTimeoutMs`, including vectors that prove a policy above `maxConcurrency` and a budget above `maxResolverTimeoutMs` are rejected before allocation. The vectors demonstrate the frozen profile; they never define a cap.
- Validate the new field/string caps against the existing canonical corpus and record the outcome before freezing them.
- Prove the raw cap precedes allocation and parsing.

### T3 — Receipt and result validation

**Lane:** `resolver-runtime`. **Files:** `src/bundle/resolver-receipt.ts` (extend), `src/bundle/resolver-protocol.ts` (new validators), `tests/bundle-resolver-receipt.test.ts` (extend).

- Reuse `validateResolverReceiptProjection`; add canonical result validation and execution-bound revocation/terminal/fail-stop validation.
- Reject thenables, extra keys, swapped IDs, stale IDs, `quarantined: false`, missing/incorrect literals, and over-budget receipts.
- Keep errors structured and secret-free.

### T4 — Bounded streaming accumulator

**Lane:** `resolver-runtime`. **Files:** `src/bundle/resolver-stream.ts` (new), `tests/bundle-resolver-stream.test.ts` (new).

- Incremental SHA-256 matching the existing browser-safe implementation; copy-on-chunk; exact length/digest checks.
- Enforce `maxDecodedBytes` per asset and `maxTotalBytes` in aggregate; reject non-byte chunks, detached buffers, over-cap chunks, short/long streams, and iterator errors.
- Test chunk-boundary, zero-length, and 1-byte cases; assert peak retained bytes are bounded.

### T5 — Execution orchestrator

**Lane:** `resolver-runtime`. **Files:** `src/bundle/resolver-execution.ts` (new), `tests/bundle-resolver-execution.test.ts` (new).

- Implement the §6 state machine against fake in-process executors with controllable promises.
- Enforce one start, the decode-level deadline with its pre-preflight origin and pre-allocation cleanup reserve, the package-owned abort controller, and the abort → revoke → conditional iterator return → cleanup → terminate order.
- Enforce the mandatory `resolverBudget` and its profile bounds (`totalTimeoutMs <= profile.maxResolverTimeoutMs`, `policy.maxConcurrent <= profile.maxConcurrency`) in preflight, before any `allocate()`. No default budget is ever substituted.
- On success, require accepted revocation and `completed` terminal receipt before returning bytes.
- On failure, require teardown attempts before fail-stop; never call `start` after revocation/cleanup/termination.
- Tests: sync throw, reject, never-settling start, duplicate start rejection, start-after-* rejection, late completion, iterator return present/absent, cleanup throw/timeout, join timeout, receipt mismatch/swap, fail-stop unproven, caller abort, pre-aborted caller signal, a missing `resolverBudget`, a budget above `profile.maxResolverTimeoutMs`, a policy above `profile.maxConcurrency`, and budget exhaustion before allocation. A test clock may be injected privately, but it is never a public decode option. No child process yet.

### T6 — Wire integration and public facade alignment

**Lane:** `embedded-facade-fix` (public facade) with `resolver-runtime` (resolver call site). **Files:** `src/bundle/index.ts`, `src/bundle/embedded.ts`, `src/bundle/canonical.ts` (only if projection hooks are needed), `tests/bundle-public-surface.test.ts`, `tests/bundle-embedded.test.ts`, `tests/public-consumer/runtime.mjs`, `tests/public-consumer/types.ts`.

- Public facade matches §4.4: `decodeStructBundle` always returns `Promise<VerifiedStructBundle>` and rejects with a documented structured error; `createStructBundle`/`verifyStructBundle` return a handle and throw; `encodeStructBundle` returns `Uint8Array` and throws a structured error for a forged handle.
- Decode options use the flat §4.3 field names: `resolverExecutor`, `resolverPolicy`, `resolverBudget`, `resolverSignal`, `resolverHostSupervisor`. No nested `resolver` object and no `resolver.executor` nesting.
- Embedded-only envelopes never call resolver code. External envelopes require the complete resolver option set, including the mandatory `resolverBudget`; a missing budget is an options error raised before allocation.
- Expected `bundleSha256` mismatch is rejected before parse and before allocation; tests assert zero `allocate` and zero `start`.
- Migrate the Stage 1 result-object tests and docs deliberately; keep private result-object helpers internal.
- Add public negative tests for a missing/invalid executor, host supervisor, policy, budget, signal, and external asset metadata, including a `totalTimeoutMs` above `profile.maxResolverTimeoutMs` and a policy `maxConcurrent` above `profile.maxConcurrency`.

### T7 — Conformance harness

**Lane:** `resolver-host-resume`. **Files:** `src/bundle/conformance/index.ts` (new), `src/bundle/conformance/probes.ts` (new), `tests/bundle-resolver-conformance.test.ts` (new), `tests/fixtures/resolver/*` (new).

- Export from a separate Node-only subpath `./bundle/conformance`; the export map and `API_MANIFEST.json` update is reserved for the integration lane (§2).
- Harness cases: side-effect-free allocation; concurrent duplicate IDs; retired-ID reuse; duplicate/late start; start after revoke/cleanup/terminate; sync throw/reject/never-settling start; late completion; clean success; quarantine-false; revocation failure; mismatched/swapped receipts; zero post-revocation broker calls/grants/descendants; pre-start cleanup; iterator cleanup; never-settling cleanup; receipt equality; policy vectors; secret non-retention; mandatory-budget and profile-bound rejection (`totalTimeoutMs` above `profile.maxResolverTimeoutMs`, policy `maxConcurrent` above `profile.maxConcurrency`) before any allocation.
- The harness reads the same single `STRUCT_BUNDLE_LIMITS_PROFILE` object; it does not carry its own copy of the caps, and a test vector never becomes the authority for a bound.
- A deliberately non-conforming fixture per invariant must fail the report; a conforming fixture must pass.
- The harness reports non-secret case names and outcomes only.

### T8 — Sacrificial host and aggregate admission

**Lane:** `resolver-host-resume`. **Files:** `tests/fixtures/resolver/sacrificial-host.mjs` (new), `tests/bundle-resolver-failstop.test.ts` (new), `scripts/run-resolver-failstop.mjs` (optional helper).

- Spawn a real child with `detached: true` (process group) or an app-provided cgroup/pid-namespace launcher. The child can spawn a grandchild that ignores `SIGTERM` and never settles cleanup/join.
- Parent sends `SIGTERM`, waits a bounded grace period, sends `SIGKILL` to the process group, reaps, and proves no descendant remains by process-group/cgroup census. A timer-only path is a test failure, not a pass.
- Assert: host dead, descendants dead, capacity retired/tombstone, ID never reused, no new allocation admitted under the old capacity, aggregate admission at N-1/N/N+1.
- The fail-stop receipt is validated only after parent proof; a child that merely self-reports death fails.

### T9 — Docs, manifest, clean consumer

**Lane:** reserved for later integration. **Files:** `CONTRACT.md`, `API.md`, `API_MANIFEST.json`, `README.md`, `MIGRATION.md`, `package.json`, `tests/public-api-manifest.test.ts`, `tests/public-consumer/*`, `scripts/test-packed-consumer.mjs` (only if the new subpath needs packing coverage).

- Document the ADR-shaped public facade, the flat resolver option fields, the frozen limits profile, the conformance subpath, and the package-vs-app ownership split.
- Document that integrity/conservation is not authenticity.
- Add the new export and runtime export names to the manifest; keep private paths unavailable.
- Packed consumer: import every documented subpath, compile declarations, run an embedded and an external happy path with a fake executor, and assert private paths fail.
- No application artifact repin, publication, writer activation, or golden regeneration.

### T10 — Adversarial matrix and S-04 handoff

**Lane:** `resolver-runtime` with the integration lane for consumer evidence. **Files:** tests only, plus a short evidence note.

- Fuzz hostile objects, cycles, lone surrogates, unsafe integers, duplicate keys, huge nesting, raw pressure, chunk pressure, deceptive lengths, and limit boundaries.
- Run the full S-03 matrix through public exports and the packed consumer.
- Record exact head, tarball digest, test counts, and known limitations. Do **not** publish, repin, or regenerate app goldens.

## 11. Concrete test matrix (acceptance mapping)

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
| Budget/cancellation | T5 decode-level deadline with pre-preflight origin, pre-allocation cleanup reserve, caller abort, pre-aborted caller signal, work-deadline abort |
| Mandatory budget and profile bounds | T2/T5/T6/T7 a missing `resolverBudget` is an options error; `totalTimeoutMs` above `profile.maxResolverTimeoutMs` and policy `maxConcurrent` above `profile.maxConcurrency` are rejected in preflight with zero allocate/start; no default budget is ever substituted |
| Iterator return | T5 result exists vs no result; return rejection still tears down |
| Zero post-revocation authority | T7/T8 probe counters |
| Secret non-retention | T3/T7 receipt/error/report scans for URL, path, token, matrix/percent alias |
| Aggregate admission | T8 N-1/N/N+1, repeated fail-stop capacity refusal |
| Canonical/wire invariants | Existing bundle tests remain green; no app goldens |
| Public facade shape (ADR) | T6 `decodeStructBundle` resolves a handle and rejects with a structured error; `encodeStructBundle` returns `Uint8Array` and throws for a forged handle; no public result object |
| Option field names (ADR) | T6 `resolverExecutor` plus flat `resolverPolicy`/`resolverBudget`/`resolverSignal`/`resolverHostSupervisor`; a nested `resolver` object and unknown keys are options errors |
| Frozen limits (no silent enlargement) | T2 profile values equal the current private bounds; external per-asset and aggregate caps are the same numbers; embedded acceptance is unchanged; a single `STRUCT_BUNDLE_LIMITS_PROFILE` object with no alias names is the only source |
| Package-owned signal | T5/T6 the request signal is the package controller's signal, aborts on caller abort or deadline, and is never the caller's object |

### Required negative fixtures

- Execution ID duplicate before grant; collision discovered after grant.
- Retired ID reused; stale receipt from retired execution; receipt swapped between two active executions.
- `quarantined: false`; missing `capabilitiesRevoked`; revocation returns a promise; terminal returns wrong state/ID.
- Start called twice; start after revocation; start after cleanup; start after termination.
- Startup never settles; cleanup never settles; join never settles; late start resolves after timeout.
- Caller signal pre-aborted; caller signal of a foreign realm; `AbortSignal`-like impostor; deadline abort during streaming.
- Chunk stream is longer/shorter than `declaredByteLength`; digest mismatch; non-`Uint8Array`; detached buffer.
- Endpoint alias, redirect loop, private target, traversal/symlink (candidate test double; package harness asserts protocol/receipt behavior only).
- Aggregate pressure: a policy declaring `maxConcurrent` above `profile.maxConcurrency`, a budget above `profile.maxResolverTimeoutMs`, a missing `resolverBudget`, one more than the host admission limit, repeated fail-stop.

## 12. High-risk pilot scenarios (run 3–5 before broad work)

1. **Daemonized descendant escapes the direct child.** A sacrificial host spawns a grandchild with a new session/process group or double-forks. Kill only the direct child and prove whether the grandchild survives. This determines whether process-group kill is sufficient or cgroup v2/pid-namespace supervision is mandatory. A passing direct-child test alone is not evidence.
2. **Revocation races an in-flight broker grant and late start.** Force `start()` to resolve after the package timeout, while the adapter attempts a broker call. Assert the revocation receipt is returned only after grants/descendant admission are atomically closed, zero calls occur after receipt, and the late result is quarantined without capacity reuse.
3. **Execution-ID collision and retired reuse across supervisor restart.** Inject a deterministic ID source to collide during concurrent allocation, then reuse a retired ID. Verify pre-grant failure for both; for a post-grant collision, verify fail-stop, tombstone, and no capacity reuse. A supervisor restart must not reset the lifetime registry within the same supervisor lifetime.
4. **Aggregate pressure exhausts cleanup reserve.** With `profile.maxConcurrency` 1, external assets resolve serially. Run them under one mandatory `resolverBudget` whose `totalTimeoutMs` sits at the profile ceiling and whose `cleanupReserveMs` is non-trivial; assert no new allocation starts after the work deadline, every started execution tears down, peak memory stays bounded, and the remaining assets are denied without reusing capacity.
5. **Receipt/secret swap across executions.** Swap revocation/terminal receipts between two concurrent executions and embed URL/path/token/matrix/percent aliases in a hostile transport receipt. Assert fail-closed ID checks, fail-stop when teardown evidence is invalid, and no secret appears in errors, reports, receipts, or logs.

## 13. Genuine external capability blockers

1. **OS-level descendant proof.** Node process groups cover ordinary children but not `setsid`/double-fork escapes. Proving "host and descendants dead" requires an app-owned cgroup v2 or PID-namespace launcher with `waitpid`/reap. If the deployment environment cannot delegate cgroups, the strongest available proof is process-group + `/proc` census, which must be documented as a limitation, not called guaranteed termination.
2. **Concrete transports.** HTTPS endpoint maps, DNS/private-address checks, redirects, descriptor-root filesystem access, symlink/traversal defenses, and content-addressed stores are consumer-owned. The package cannot certify real network/filesystem policy and must not implement it.
3. **Producer authenticity and trust epoch.** External asset resolution in production must remain inactive until Ernie.SG/Aether supply authenticated producer records, current/rollback-safe trust status, audience/replay checks, and `bundleSha256` binding before `start()`. Struct integrity alone is insufficient.
4. **Browser/runtime isolation.** A browser or worker-only host cannot guarantee out-of-realm process kill. External resolution is a server-side capability; a worker `terminate()` is not parent-proven termination.
5. **Publication and clean-consumer proof.** S-04 tarball/consumer evidence and any registry release remain separate approvals. No publish, writer activation, app golden regeneration, or application artifact repin is authorized here.

## 14. Validation commands

Run every command from the assigned absolute worktree. Use the installed local binaries, keep the worker count at one for deterministic timing, and avoid repeating a broad baseline suite once it is green:

```bash
cd /home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/resolver-plan
./node_modules/.bin/vitest run --maxWorkers=1 tests/bundle-resolver-*.test.ts
./node_modules/.bin/tsc --noEmit
```

Use the installed local binaries, keep the worker count at one for deterministic timing, and do not repeat a broad baseline suite once it is green. The sacrificial-host test must be included in the focused run (not skipped) and must fail if the parent cannot prove death. Its timing bounds must be generous enough for CI but still bounded. The integration lane runs the packed-consumer and source-boundary scripts when the manifest and packed consumer change; those are reserved seams, not part of this plan's changes.

## 15. Exit criteria for this plan

- The frozen interfaces are implemented without semantic drift; the additive host port is the only public extension, and no ADR amendment is proposed.
- The public facade matches ADR-0001: handles and documented structured errors, never a nominally accepted unverified bundle.
- The decode options use the ADR-pinned `resolverExecutor` field plus flat documented policy/budget/signal/host-supervisor fields.
- `resolverBudget` is mandatory whenever a resolver is used, there is no implicit default budget, and its bounds plus `policy.maxConcurrent` are validated against the frozen profile in preflight, before any allocation.
- The request signal is always a package-owned `AbortSignal`, and the monotonic total budget starts before preflight and allocation with the cleanup reserve taken before allocation.
- The frozen limits profile equals the current private bounds; external resolution cannot enlarge them, and one `STRUCT_BUNDLE_LIMITS_PROFILE` object with `maxConcurrency` 1 and `maxResolverTimeoutMs` 120000 is the only source of those numbers.
- An external bundle resolves only after a valid transport receipt, exact byte/digest match, accepted revocation, and execution-ID-bound terminal receipt.
- Duplicate/retired IDs, duplicate start, start-after-teardown, late start, revocation failure, swapped receipts, and never-settling cleanup/join fail closed.
- A real sacrificial host proves parent-side termination and descendant death; a timer-only test does not satisfy the clause.
- Limits and policy have fixed cross-runtime vectors and N-1/N/N+1 coverage.
- No app goldens, publication, writer, artifact repin, or cutover claims are included.
- S-03 remains open until the companion create/verify/limit-profile matrix lands; S-04 remains blocked on that complete surface.

## 16. Review finding reconciliation (v2)

| Finding | Resolution in this plan |
| --- | --- |
| F1 decode option name drift | §4.3 uses the ADR-pinned `resolverExecutor` with flat documented `resolverPolicy`, `resolverBudget`, `resolverSignal`, `resolverHostSupervisor`; the nested `resolver` grouping is removed, and T6 plus the public-consumer type expectations are updated accordingly |
| F2 limits looser than current bounds | §8 freezes the exact current values (`maxAssetBytes`/`maxTotalBytes`/`maxDecodedBytes` 4194304, `maxBase64Chars` 5592408, `maxRawBytes` 8388608) and states that external resolution cannot enlarge them; N-1/N/N+1 vectors are required in T2 |
| F3 embedded semantics conflict | T2 keeps the embedded path's current constants and behavior; the shared profile carries identical values, and no external cap is applied to the embedded fast path |
| F4 optional vs mandatory signal | §4.3.1 makes `resolverSignal` an optional caller signal while the package owns a per-execution `AbortController`; `request.signal` is always that real signal, never omitted, and negative tests are added |
| F5 deadline origin ambiguity | §6 starts the monotonic total at decode entry, before preflight and before allocation, reserves the cleanup budget before the first `allocate()`, and requires every phase to fit the bounded lifecycle |
| F6 facade return type | §4.4 adopts the ADR facade: `decodeStructBundle` is always `Promise<VerifiedStructBundle>` and rejects with a documented structured error; `createStructBundle`/`verifyStructBundle` return a handle and throw; `encodeStructBundle` returns `Uint8Array` and throws for a forged handle; Stage 1 result-object helpers stay private and the tests/docs migrate deliberately |

## 17. Fresh review reconciliation (L1–L2)

| Note | Resolution in this plan |
| --- | --- |
| L1 dangling default budget values | §8 no longer defines `defaultTotalTimeoutMs` or `defaultCleanupReserveMs`; the profile has no default budget, §4.3 and §6 state that `resolverBudget` is mandatory and that the package never substitutes a timeout or cleanup reserve, and T2/T5/T6 carry the same rule. No undefined caller-supplied budget source remains |
| L2 profile caps not cross-referenced in request validation | §7 now states the strict upper bounds explicitly and requires them in preflight before any allocation: `totalTimeoutMs <= profile.maxResolverTimeoutMs` (120000), `1 <= policy.maxConcurrent <= profile.maxConcurrency` (1), and `1 <= cleanupReserveMs < totalTimeoutMs`. The frozen profile is the authority; test vectors only demonstrate the bounds |
