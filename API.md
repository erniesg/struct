# Public API and export manifest

`API_MANIFEST.json` is the deterministic, machine-checked manifest. The package
export map and packed-consumer test enforce these accepted paths:

| Path | Ownership |
| --- | --- |
| `@erniesg/struct` | Slim document types and core codec operations. |
| `@erniesg/struct/document` | Source-neutral document contract, versions, types, and codecs. |
| `@erniesg/struct/identity` | Stable identifiers and semantic digest primitives. |
| `@erniesg/struct/ordering` | Reading-order helpers. |
| `@erniesg/struct/receipt` | Consultation-receipt validation and authoritative semantic receipt digest/verification. |
| `@erniesg/struct/recovery` | Source-neutral recovery facts and summaries without application copy. |
| `@erniesg/struct/renderers/xhtml` | Deterministic XHTML rendering. |
| `@erniesg/struct/renderers/epub` | Deterministic EPUB construction and archive bounds. |
| `@erniesg/struct/bundle` | Verified StructBundle bytes ingress and encoding. |

The prerelease thin paths `./core`, `./schema`, and `./ids` are removed.
Private `src/**` modules are not consumer APIs. The manifest records only
runtime exports per path; it has no schema field for type exports (`VerifiedStructBundle`, `StructBundleCreateInput`, etc.), so those are documented here but are not listed in `API_MANIFEST.json`.

## Bundle surface (`@erniesg/struct/bundle`)

Runtime exports (exactly seven, matching `API_MANIFEST.json`):

- `STRUCT_BUNDLE_LIMITS_PROFILE`
- `STRUCT_BUNDLE_LIMITS_PROFILE_VERSION`
- `StructBundleError`
- `createStructBundle`
- `decodeStructBundle`
- `encodeStructBundle`
- `verifyStructBundle`

Public type exports (not in the manifest schema, documented here):

- `VerifiedStructBundle`
- `StructBundleCreateInput`
- `StructBundleEmbeddedOptions`
- `StructBundleDecodeOptions`
- `StructBundleLimitsProfile`
- `StructBundleErrorStage`
- `StructBundleErrorCode`
- `StructResolverExecutorV1`
- `StructAssetResolutionPolicyV1`
- `StructResolverHostSupervisorV1`
- `StructResolverBudgetInput` — the caller-facing budget: exactly `{ totalTimeoutMs: number; cleanupReserveMs: number }`. This is the value passed as `resolverBudget`; it is the only budget shape the runtime accepts.
- `StructResolverDerivedBudgetPlan` — the package's **internal derived** plan. It carries an extra `workTimeoutMs` key and is **not** a value a caller may pass: a budget carrying that key is refused with `input` / `OPTIONS`.

### Function contracts

**`createStructBundle(input, options?)`: `VerifiedStructBundle`**

- Signature: `(input: StructBundleCreateInput, options?: StructBundleEmbeddedOptions) => VerifiedStructBundle`
- Synchronicity: synchronous; throws `StructBundleError` on failure (never returns a result object).
- `StructBundleCreateInput`: `{ document: StructDocument | StructDocumentJson }`. The `document` must be a strict JSON-safe value; unknown fields, non-canonical shapes, and malformed assets are rejected before any handle is built.
- `StructBundleEmbeddedOptions`: `{ limitsProfile?: typeof STRUCT_BUNDLE_LIMITS_PROFILE_VERSION }`. Only the frozen profile version `'1.0.0'` is accepted. Any other value throws `input` / `OPTIONS`. If omitted, the frozen profile is used.
- The function copies embedded asset bytes, verifies their digest against the declared SHA-256, enforces the frozen profile (asset count, per-asset bytes, aggregate bytes, raw bytes, base64 length, nesting, nodes), builds the canonical full envelope, and returns a genuine frozen handle.

**`verifyStructBundle(value, options?)`: `VerifiedStructBundle`**

- Signature: `(value: unknown, options?: StructBundleEmbeddedOptions) => VerifiedStructBundle`
- Synchronicity: synchronous; throws `StructBundleError` on failure.
- Accepts only strict in-memory embedded-asset envelopes. It exposes no `expectedBundleSha256`, no `resolverExecutor`, no `resolverPolicy`, no `resolverBudget`, no `resolverSignal`, and no `resolverHostSupervisor`. Passing any of those fields as `options` throws `input` / `OPTIONS`.
- The profile (`limitsProfile`) behaves exactly as for `createStructBundle`.
- A caller-supplied proxy can present a different view per traversal; the accepted canonical bytes are re-validated against the frozen profile after snapshot, so only the canonical snapshot is authoritative.

**`decodeStructBundle(raw, options?)`: `Promise<VerifiedStructBundle>`**

- Signature: `(raw: Uint8Array, options?: StructBundleDecodeOptions) => Promise<VerifiedStructBundle>`
- Synchronicity: **always async and returns a `Promise`**; it never throws synchronously. A malformed option set or invalid bytes always produces a rejected promise, never a synchronous exception.
- `StructBundleDecodeOptions` (flat, exact names, no nesting):
  - `expectedBundleSha256?: string` — optional; must be exactly 64 lowercase hex characters (`/^[0-9a-f]{64}$/`). If present, checked against the raw snapshot before any parse. A mismatch rejects with stage `digest`, code `MISMATCH`. If missing, no digest gate applies.
  - `resolverExecutor?: StructResolverExecutorV1` — mandatory when any external asset exists in the bundle; mandatory when any other `resolver*` field is present. The executor object must implement `allocate(request: StructAssetResolutionRequest): StructResolverExecutionHandle`. Missing or malformed executor throws/rejects with `input` / `OPTIONS`.
  - `resolverPolicy?: StructAssetResolutionPolicyV1` — mandatory when any other `resolver*` field is present. Must be a strict own-property snapshot with `protocolVersion: '1.0.0'`. An invalid policy rejects with `resolve` / `POLICY`.
  - `resolverBudget?: StructResolverBudgetInput` — **mandatory whenever a resolver is used; there is no implicit default budget**. `StructResolverBudgetInput` is exactly `Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>`. `totalTimeoutMs` must be a safe positive integer within the profile cap (`maxResolverTimeoutMs` = 120000). `cleanupReserveMs` must be a safe positive integer strictly less than `totalTimeoutMs`. A missing budget, a non-object budget, wrong key names, non-number values, or out-of-range values reject with `budget` / `BUDGET` (before any allocation).
  - `resolverSignal?: AbortSignal` — optional caller cancellation signal. If provided, it must be a genuine `AbortSignal` (platform brand check: `aborted` getter from the real prototype, no own listener shadows). A fake signal rejects with `input` / `OPTIONS`. When absent, the package creates its own `AbortController` per execution; the request signal is never omitted.
  - `resolverHostSupervisor?: StructResolverHostSupervisorV1` — mandatory when any other `resolver*` field is present. Must implement the `failStop` port with `protocolVersion: '1.0.0'`. Missing or invalid supervisor throws/rejects with `input` / `OPTIONS`.
  - `limitsProfile?: typeof STRUCT_BUNDLE_LIMITS_PROFILE_VERSION` — optional; only `'1.0.0'` accepted. Any other value throws/rejects with `input` / `OPTIONS`.
- All-or-nothing resolver configuration rule: if any of the five `resolver*` fields (`executor`, `policy`, `budget`, `signal`, `hostSupervisor`) is present (even `signal` alone is not enough), then `executor`, `policy`, `budget`, and `hostSupervisor` must all be present and valid. A partial set is an `input` / `OPTIONS` error raised before any raw byte parsing or allocation.
- The decode applies the frozen profile cap (`maxRawBytes` = 8 MiB) to the raw snapshot, checks the expected digest before parse, verifies canonical bytes, validates the document/envelope/receipt equality, verifies embedded assets, selects external targets (when external payloads are present and a valid resolver configuration is provided), runs bounded streaming resolution under the explicit budget, and only then returns a verified handle. Any failure path rejects the returned promise with `StructBundleError`.

**`encodeStructBundle(handle)`: `Uint8Array`**

- Signature: `(handle: unknown) => Uint8Array`
- Synchronicity: synchronous; throws `StructBundleError` (`stage: 'handle'`, `code: 'FORGED'`) for forged or structurally copied handles.
- Accepts only a genuine package-created `VerifiedStructBundle`. The function reads only the private canonical bytes stored at creation time; spreading, proxying, or mutating the handle does not alter the returned bytes. Any forged or aliased value is rejected.

### Error taxonomy (`StructBundleError`)

Every public Bundle operation that fails produces a frozen `StructBundleError` instance (no mutable extensions, no `cause`, no `input`, no `value`). The instance carries:

- `name`: `'StructBundleError'`
- `stage`: one of `'input' | 'digest' | 'canonical' | 'assets' | 'handle' | 'resolve' | 'budget'`
- `code`: one of `'OPTIONS' | 'TYPE' | 'LIMIT' | 'MISMATCH' | 'SYNTAX' | 'NONCANONICAL' | 'SHAPE' | 'SET' | 'METADATA' | 'BASE64' | 'DIGEST' | 'UNRESOLVED' | 'FORGED' | 'BUDGET' | 'POLICY' | 'TARGET' | 'ALLOCATE' | 'START' | 'RESULT' | 'RECEIPT' | 'STREAM' | 'LENGTH' | 'ABORTED' | 'TIMEOUT' | 'REVOCATION' | 'CLEANUP' | 'TERMINAL' | 'FAIL_STOP'`
- `message`: a static message derived from the stage only (e.g., `'struct bundle input rejected'` for stage `input`). It never contains caller input, identifiers, paths, digest values, or adapter output.

The complete static stage-to-message mapping is defined in `src/bundle/error.ts`. No additional runtime code is added; the taxonomy is authoritative for this head.

### Frozen limits profile

`STRUCT_BUNDLE_LIMITS_PROFILE_VERSION` is `'1.0.0'`. `STRUCT_BUNDLE_LIMITS_PROFILE` is an immutable frozen object (exact values, no aliases, no second profile):

| Cap | Value |
| --- | --- |
| `profileVersion` | `'1.0.0'` |
| `maxRawBytes` | 8388608 (8 MiB) |
| `maxFieldBytes` | 5600000 |
| `maxAssets` | 256 |
| `maxAssetBytes` | 4194304 (4 MiB) |
| `maxTotalBytes` | 4194304 (4 MiB) |
| `maxDecodedBytes` | 4194304 (4 MiB) |
| `maxBase64Chars` | 5592408 |
| `maxConcurrency` | 1 |
| `maxDepth` | 128 |
| `maxStringLength` | 5592408 |
| `maxStringBytes` (new cap) | 1048576 (1 MiB) — enforced in `visitValue`; see profile adoption note below |
| `maxNodes` | 1000000 |
| `maxResolverTimeoutMs` | 120000 |

Profile rules:

- The profile is frozen and cannot be enlarged by callers. A different `limitsProfile` value on embedded options throws `input` / `OPTIONS`.
- The embedded fast path (`createStructBundle`, `verifyStructBundle`, embedded-only `decodeStructBundle`) uses the same frozen profile; no separate embedded cap exists. External resolution uses the same profile and cannot silently enlarge any embedded cap.
- `resolverBudget.totalTimeoutMs` must be a safe positive integer `1 <= totalTimeoutMs <= maxResolverTimeoutMs` (120000). A value above the profile cap is rejected before any allocation (`budget` / `BUDGET`).
- `resolverPolicy.maxConcurrent` must satisfy `1 <= maxConcurrent <= maxConcurrency` (1). A policy above the profile bound is rejected before any allocation.
- There is no implicit default budget: when any `resolver*` field is present, `resolverBudget` is mandatory; the package never substitutes a timeout or cleanup reserve.
- `maxStringBytes` and `maxFieldBytes` are new public caps adopted by the profile at this head. They are validated against the existing canonical corpus: no currently accepted fixture exceeds the proposed cap, and the cap is never silently tightened below existing input. N-1/N/N+1 boundary vectors apply.

### What a verified handle proves

A verified handle (`VerifiedStructBundle`) proves **integrity and conservation** of the exact bytes/value it was created from. It is not a signature and proves **nothing** about producer authenticity, approval, release authority, or audience. The package does not implement producer authentication, trust epochs, replay checks, or audience verification; those are consumer-owned requirements. A consumer that needs producer authenticity must authenticate a separate producer-release/export record bound to `bundleSha256` and prove current, rollback-safe status before invoking `decodeStructBundle`.

### Compatibility note

`migrateStructDocument` remains a deprecated alias for `decodeCompatibleStructDocument` with removal date **2026-11-30**; it performs strict version-preserving decode and never transforms or migrates a document.

## Decode compatibility and deprecated alias

`decodeCompatibleStructDocument(input)` is the truthful public compatibility
operation. It strictly decodes supported `0.1.0` and `0.2.0` documents at their
declared versions; it does not transform or migrate either version.

`migrateStructDocument(input)` remains a deprecated prerelease alias with the
same decode-compatibility behavior for unindexed prerelease consumers. Use
`decodeCompatibleStructDocument` instead. The alias will be removed after
**2026-11-30**. The replacement, removal date, and behavior are machine-checked
in `API_MANIFEST.json` and the packed public-consumer test.

Renderer exports are intentionally absent from the root facade. Import them
from their explicit renderer paths. Public-consumer validation installs the
packed tarball, imports only through the package export map, typechecks those
imports, and proves the removed and not-yet-available paths fail closed.
