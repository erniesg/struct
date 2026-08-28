# Struct package contract

This is the normative package contract for `@erniesg/struct`. The accepted
[ADR-0001](https://github.com/erniesg/erniesg/blob/131560e07ef692c27f57acd40a89eaac1f975d62/docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md)
at Ernie.SG commit `131560e07ef692c27f57acd40a89eaac1f975d62` is the detailed
normative architecture source for the planned Bundle protocol. This document
freezes the package-level decisions without duplicating that protocol verbatim.

## Ownership and state

Struct owns source-neutral `StructDocument` types/schema/codecs/migrations,
stable IDs/relationships/reading order, source-neutral diagnostics/recovery and
semantic receipts, the `StructBundle` wire schema and integrity verification,
and deterministic XHTML/reflowable EPUB rendering. It must not import or own
Ernie.SG, Aether, Rucksack, UI, storage, transport, providers, credentials,
extraction, editorial/release state, or source-specific recovery wording.
Document/schema modules must not depend on renderers.

Source-neutral recovery utilities emit facts, categories, and machine-readable
status only. Applications own source-specific and workflow-specific user copy.
Emitted XHTML identifier normalization, collision checks, and publication
planning belong to the XHTML renderer boundary; a semantically valid document
is not rejected merely because renderer-normalized identifiers collide.

At base `6ecb78d1753b847ec7295bf45f43237225663728`, only the private `0.0.0`
document/codecs/IDs/recovery/XHTML/EPUB capabilities are **current**.
`StructBundle`, its decoder, verifier, resolver executor, and `./bundle`
facade are a **documented target**, planned for S-03. Exact code plus local
evidence is **implemented, unreleased**; it is not a release. **Released**
requires the exact registry version, immutable artifact digest, install proof,
and release record. Local tests, branches, and documentation are not release
evidence.

Ernie.SG constructs bundles from approved revisions and authenticates producer
approval/release records. Aether consumes only a verified, exact-pinned bundle
and owns visual composition. Rucksack may orchestrate target-owned commands but
does not own a Struct model or renderer.

## Planned Bundle semantics (normative)

The JSON envelope (`StructBundleJson`), its byte-free document projection
(`StructBundleDocumentJson`), and an opaque runtime `VerifiedStructBundle` are
separate types. JSON values are strict: no binary values, functions,
prototypes, non-finite numbers, lone surrogates, unsafe integers, or duplicate
keys. Envelope, document-schema, package, renderer implementation, and
renderer profile versions are independent axes; `bundleVersion` is independent
of `schemaVersion`, which must exactly agree with the decoded document and both
receipts.

The byte-free projection is exact and version-specific. Bundle decoding rejects
unknown fields and `document.assets[*].bytes`; it never strips or migrates
input implicitly. Canonical document bytes are UTF-8 RFC 8785 JSON
Canonicalization Scheme bytes of that projection, and `documentSha256` is their
lowercase-hex SHA-256. Canonical full-envelope bytes are UTF-8 RFC 8785 bytes of
the normalized strict envelope, with assets sorted by ID under one documented
Unicode-scalar comparison; `bundleSha256` is their lowercase-hex SHA-256 and
lives outside the envelope in producer/consumer records. Noncanonical wire
bytes are rejected, not normalized. `encodeStructBundle` returns privately
stored canonical bytes. The existing semantic `document.receipt.generatedSha256`
is distinct from `documentSha256` and both verify for their respective purpose.

The top-level envelope receipt is a transport duplicate and must be exactly
equal to decoded `document.receipt`; independently valid but unequal receipts
are rejected. The decoded document receipt is the sole semantic authority.

There is exactly one envelope asset per document asset and no extras. Asset IDs
are unique and ID, MIME type, and digest agree. The envelope is the sole byte
authority: document assets retain logical identity/metadata but carry no bytes
in a bundle. A document asset's `href` remains a digest-bound logical
EPUB-relative path, never a URL, filesystem locator, or storage key. External
payloads carry only the non-secret content address
`resourceId: "sha256:" + asset.sha256`; resource IDs never contain a URL, path,
storage key, credential, or caller-selected locator. For schema `0.2.0`,
`byteLength` is envelope-only and must be checked against bytes, not invented as
document metadata.

Embedded asset payloads use strict canonical base64. Noncanonical alphabet,
padding, whitespace, decoded-length, or digest mismatch is rejected.

Untrusted bundle ingress is bytes-only through
`decodeStructBundle(rawJsonBytes, options)`. It applies a raw-input cap and an
optional expected `bundleSha256` before parsing or resolver execution, proves
canonical input, and returns only `VerifiedStructBundle` or a structured error.
`verifyStructBundle` accepts only strict in-memory embedded values and makes no
claim about prior wire bytes. `createStructBundle`, `decodeStructBundle`, and
`verifyStructBundle` never return an accepted unverified value; the encoder
accepts only a genuine package-created handle. Handles use private copied
canonical/document/asset storage, are frozen, deep-copy/deep-freeze snapshots,
and copy asset bytes on every read; forged handles and mutation/aliasing fail to
alter verified content.

External assets use only an explicit, versioned isolated resolver/executor
protocol. The package has no implicit network or filesystem access. Allocation
is side-effect-free: before any adapter authority can start, it returns a
supervisor-controlled handle with a collision-resistant, lifetime-unique
execution ID plus independently controlled `revokeAndQuarantine()`, idempotent
`cleanup()`, and `terminateAndJoin()` operations. It returns control, not a
terminal receipt, before one-shot `start()` atomically consumes the sole
authority-granting start right. A terminal receipt is produced only by teardown
after start or a pre-start failure.

Every outcome—success, synchronous startup throw, rejection, timeout,
never-settling start, stream error, limit breach, cancellation, or cleanup
failure—closes future grants and descendant admission; attempts revocation,
iterator return where available, cleanup within the reserved budget, and then
terminates and joins the isolated host before returning. All accepted
revocation/terminal receipts are bound to the active exact execution ID.
Missing, mismatched, swapped, failed, or never-settling revocation or terminal
join receipts force parent-proven fail-stop, proof that the host and descendants
are dead, permanent retirement/tombstoning of the implicated capacity, and no
normal completion or capacity reuse. After accepted revocation, instrumentation
must prove zero surviving broker grants/calls and zero admitted descendants.

The request carries separate `logicalHref`, digest-only `resourceId`, expected
asset metadata, versioned strict policy, policy digest, monotonic budget, and
cancellation signal. Trusted consumer configuration maps a resource ID to
transport authority; URLs, paths, storage keys, headers, and credentials never
enter canonical bytes, errors, receipts, or logs. Missing executor, unresolved
asset, policy/receipt mismatch, timeout, cancellation, incomplete cleanup, or
returned-byte mismatch fails verification. S-03 conformance must cover duplicate
and retired execution IDs, late completion after timeout/revocation, revocation
failure, mismatched or swapped receipts, never-settling cleanup/join, residual
work, and zero post-revocation authority, alongside one-shot start and ordinary
success/failure cases.

The public versioned limits profile caps raw input, each field, each asset,
asset count, decoded bytes, aggregate bytes, concurrency, nesting, and string
length. Limits are enforced before unbounded allocation and have N-1/N/N+1
conformance vectors.

Struct integrity proves schema, conservation, canonical bytes, and digest
integrity only. It does not prove producer authenticity: an attacker can
recompute unkeyed digests and receipts. A provenance-requiring consumer must
authenticate an Ernie.SG producer release/export record or detached signature
bound to `bundleSha256`, and persist its own exact package pin and import/event
receipt.

For any consumer ingress that can resolve external assets, producer
authentication is ordered before decoding: cap and hash raw envelope bytes;
authenticate current, fresh, audience-authorized, rollback-safe policy/status
producer evidence bound to that digest; then invoke the exact-pinned bytes-only
decoder with that authenticated digest as `expectedBundleSha256`. A forged,
revoked, stale, wrong-audience, replayed, or digest-mismatched record fails
before resolver allocation or `start()`. Later S-03/consumer negative tests
must prove zero allocation and zero start for each of those evidence failures.

## Current public surface

The actual current package paths and the intended first-release surface are
listed in [API.md](./API.md). `./bundle` is unavailable until S-03 completes;
no documentation in this contract makes it a current runtime capability.
