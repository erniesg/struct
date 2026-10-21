# Embedded Bundle completion plan

**Date:** 2026-10-20
**Worktree:** `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/embedded`
**Branch:** `feat/bundle-embedded-completion-20261020`
**Base head:** `998be09922dd07779b13153d45b06cbe3a3171b3`
**Status:** embedded Stage 1 completion on the approved ADR-0001 minimum stable
facade. S-03 remains open for the isolated resolver/executor lane and any
published full-contract claim.

## Scope

This slice completes the embedded-only Bundle facade over the existing private
Stage 1 decoder:

- `createStructBundle` from a runtime or JSON document with embedded asset bytes;
- `verifyStructBundle` for strict in-memory embedded values;
- one frozen, versioned public limits profile;
- genuine package-created opaque handles shared by create/decode/value paths;
- strict forbidden-key, byte-free projection, receipt equality, asset-set,
  metadata, base64, digest, raw-canonical, copy-on-read, forgery, and hostile
  input behavior;
- the ADR-aligned public contract: direct handles, a promise-returning bytes
  decoder, a byte-returning encoder, and one static structured error type.

It deliberately does not add a resolver executor, executor conformance harness,
network/filesystem access, producer authenticity, package publication, consumer
activation, or an export-manifest edit. External payloads continue to fail
closed with stage `assets` and code `UNRESOLVED`.

## Public contract (ADR-0001 section 13 / minimum stable facade)

```ts
type StructBundleCreateInput = Readonly<{
  document: StructDocument | StructDocumentJson
}>

type StructBundleDecodeOptions = Readonly<{
  expectedBundleSha256?: string
}>

type StructBundleEmbeddedOptions = Readonly<{
  limitsProfile?: '1.0.0'
}>

createStructBundle(
  input: StructBundleCreateInput,
  options?: StructBundleEmbeddedOptions,
): VerifiedStructBundle            // throws StructBundleError

decodeStructBundle(
  rawJsonBytes: Uint8Array,
  options?: StructBundleDecodeOptions,
): Promise<VerifiedStructBundle>    // rejects StructBundleError, never throws sync

verifyStructBundle(
  value: unknown,
  options?: StructBundleEmbeddedOptions,
): VerifiedStructBundle            // throws StructBundleError

encodeStructBundle(handle: unknown): Uint8Array  // throws StructBundleError
```

The public API never returns a result object and never returns an accepted
unverified value. The private result-object helpers in `src/bundle/facade.ts`
and `src/bundle/embedded.ts` are retained as internal implementation detail
and are not part of the public surface.

`StructBundleError` is a public export. It carries only static facts:

| Field | Values |
| --- | --- |
| `stage` | `input`, `digest`, `canonical`, `assets`, `handle` |
| `code` | `OPTIONS`, `TYPE`, `LIMIT`, `MISMATCH`, `SYNTAX`, `NONCANONICAL`, `SHAPE`, `SET`, `METADATA`, `BASE64`, `DIGEST`, `UNRESOLVED`, `FORGED` |
| `message` | one static message per stage |

No caller value, path, identifier, byte, or digest is retained or echoed. The
error instance is frozen and carries no `input`, `value`, or `cause` property.

The value verifier intentionally has no `expectedBundleSha256`, resolver,
executor, transport, or filesystem option. It makes no claim about prior wire
bytes. Consumer ingress for untrusted wire data must use `decodeStructBundle`.

## Versioned limits profile

`STRUCT_BUNDLE_LIMITS_PROFILE_VERSION` is `1.0.0`.
`STRUCT_BUNDLE_LIMITS_PROFILE` is frozen and cannot be enlarged by callers:

| Cap | Value |
| --- | ---: |
| raw input bytes | 8 MiB |
| any one top-level envelope field (canonical bytes) | 5,600,000 |
| asset count | 256 |
| per-asset decoded bytes | 4 MiB |
| aggregate decoded bytes | 4 MiB |
| decoded-byte cap | 4 MiB |
| canonical base64 characters | 5,592,408 |
| concurrency | 1 (embedded, single-pass) |
| nesting depth | 128 nested containers |
| one UTF-8 string | 5,592,408 bytes |
| JSON nodes | 1,000,000 |

The raw cap is applied while copying caller bytes and before digest/parse.
Nesting, node, string, and top-level field caps run before canonical envelope
and asset allocation. Asset count, per-asset, aggregate, decoded, and base64
caps run in the asset verifier. N-1/N/N+1 behavior is covered for raw, count,
per-asset, aggregate, base64, string, nesting, nodes, and field boundaries.

### Profile-view stability

The profile is enforced twice for the in-memory value API: once against the
caller's live object (fail-fast) and once against a private snapshot of the
canonical bytes that actually become the handle. A caller-supplied proxy can
present a different view to each traversal, so only the second check is
authoritative for the accepted content. The bytes decoder needs the single
check only: canonical wire bytes and their parsed value are the same content by
construction.

## Required invariants

1. The runtime document, byte-free `StructBundleDocumentJson`, full
   `StructBundleJson`, and opaque `VerifiedStructBundle` remain distinct.
2. A serialized document asset with `bytes`, an unknown key, or any non-exact
   projection field is rejected, never stripped.
3. `documentSha256` is lowercase SHA-256 over RFC 8785 UTF-8 bytes of the exact
   byte-free projection. `bundleSha256` is lowercase SHA-256 over normalized,
   asset-ID-sorted canonical full-envelope bytes.
4. The top-level receipt must equal `document.receipt` exactly; independently
   valid but unequal receipts are rejected.
5. The document asset set and envelope asset set are identical: no missing,
   duplicate, or extra ID; ID, media type, SHA-256, decoded length, and bytes
   agree.
6. Embedded payloads use strict canonical base64. Noncanonical alphabet,
   padding, whitespace, length, or digest fails closed.
7. Asset `href` stays a logical EPUB-relative path; an external payload may
   carry only `resourceId = "sha256:" + sha256`. URLs, paths, storage keys, and
   credentials are rejected by the exact projection or external payload shape.
8. `byteLength` remains envelope-only for `0.2.0`; create derives it from copied
   bytes and never writes it into the document.
9. Handles are frozen objects backed by private `WeakMap` state. Snapshots are
   fresh deep-frozen copies; asset reads return fresh byte copies; encoding reads
   only private canonical bytes and rejects spreads, prototypes, proxies, and
   deserialized fakes.
10. Struct integrity is not producer authenticity. Create/decode/value tests do
    not claim signature, approval, audience, or release authority.

## Execution order and pilot

Test-first pilot, run before the full matrix:

1. Create from the frozen `current:envelope` document and reproduce its exact
   canonical bytes and digest; mutate the input after create.
2. Verify a strict in-memory envelope value and prove handle isolation from later
   value/base64/asset-array mutation and returned-byte mutation.
3. Reject capability-bearing value options, document `bytes`, unknown keys,
   unequal receipts, wrong versions/digests, and external payloads.
4. Exercise missing/extra/duplicate assets, media/digest/metadata mismatch,
   noncanonical base64, declared-length mismatch, and payload digest mismatch.
5. Exercise hostile accessors, cycles, prototypes, sparse arrays, lone
   surrogates, unsafe integers, and string/nesting/node/field boundaries.
6. Exercise the ADR public contract: direct handles, promise-returning decode,
   byte-returning encode, static structured errors, and the profile-view
   stability regression.

After the pilot passes, run the full Bundle suite, typecheck, and the
source-boundary check. No app goldens are regenerated.

## Future integration interfaces (coordinator-owned)

The embedded facade exports seven runtime names from `./bundle`:

```text
STRUCT_BUNDLE_LIMITS_PROFILE
STRUCT_BUNDLE_LIMITS_PROFILE_VERSION
StructBundleError
createStructBundle
decodeStructBundle
encodeStructBundle
verifyStructBundle
```

The coordinator must, in its package/export-manifest lane:

- update `API_MANIFEST.json` `runtimeExports['./bundle']` to exactly those
  seven names and update `API.md` to the ADR contract (direct handle, promise
  decoder, byte encoder, `StructBundleError`);
- update `tests/public-consumer/runtime.mjs` and `types.ts` to exercise the
  promise decoder, the direct handle, the byte encoder, and the thrown error;
- keep `package.json` export-map paths unchanged (`./bundle` already exists);
- rebase the S-04 clean-tarball proof onto the integrated exact head.

The resolver lane must add a separate versioned executor surface and must not
widen `verifyStructBundle` or the embedded options. Its bytes-ingress
integration should extend `decodeStructBundle` options only through explicit
resolver policy objects and must preserve zero executor starts on
expected-digest mismatch, noncanonical input, strict-value failure, or
external-payload policy failure.

## Remaining gaps

- The isolated resolver/executor protocol, lifecycle state machine, conformance
  harness, and app-owned transports remain pending.
- Producer authenticity, trust epochs, audience/replay checks, and
  `bundleSha256`-bound release records are consumer-owned and absent.
- The public manifest and packed-consumer proof are intentionally not edited in
  this worktree.
- Full S-03/S-04 acceptance, publication, app repin, writer activation, and
  cutover are not claimed.
