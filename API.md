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
Private `src/**` modules are not consumer APIs.

## Bundle surface

`@erniesg/struct/bundle` exposes the first portable interchange boundary:

- `createStructBundle(input, options?)` builds an embedded bundle from a
  runtime or JSON document. Asset bytes must be present on the document and
  match their declared SHA-256; the serialized document projection never
  contains them.
- `decodeStructBundle(rawJsonBytes, options?)` accepts untrusted wire bytes
  only. It applies the raw-input cap, checks an optional expected
  `bundleSha256` before parsing, proves canonical input, validates the
  byte-free document projection and receipt equality, and verifies every
  embedded asset's base64, length, and digest. It returns a structured result.
- `verifyStructBundle(value, options?)` performs strict in-memory value
  verification for embedded-asset envelopes only. It exposes no
  expected-raw-digest, resolver, or executor option.
- `encodeStructBundle(handle)` re-encodes only a genuine package-created
  handle. Structurally copied or forged values fail with `stage: 'handle'`,
  `code: 'FORGED'`.
- `STRUCT_BUNDLE_LIMITS_PROFILE` and
  `STRUCT_BUNDLE_LIMITS_PROFILE_VERSION` expose the frozen embedded limit
  profile.

A verified handle proves integrity and conservation of the exact bytes it was
created from. It is not a signature and proves nothing about producer
authenticity. Handles are frozen, expose deep-copied snapshots, and copy asset
bytes on every read.

This version accepts embedded assets only. An envelope carrying an external
payload fails closed with `stage: 'assets'`, `code: 'UNRESOLVED'`: the versioned
isolated resolver/executor protocol and its conformance harness are not part of
this surface yet.

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
