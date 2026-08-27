# First-release API and export manifest

This manifest records current executable exports at base
`6ecb78d1753b847ec7295bf45f43237225663728` and the documented first-release
target from ADR-0001. It does not modify runtime exports. Current aliases are
private-package prerelease compatibility only, not a promise of a released API.

## Current package exports

| Current path | Source barrel | Classification | Contents |
| --- | --- | --- | --- |
| `@erniesg/struct` | `src/index.ts` | Current prerelease alias | Document types; codec operations; IDs; reading order; recovery; XHTML/EPUB renderer exports. |
| `@erniesg/struct/core` | `src/core.ts` | Current prerelease alias | Types, IDs, reading order, recovery, consultation receipt. |
| `@erniesg/struct/schema` | `src/schema.ts` | Current prerelease alias | Codec operations, `StructDocumentJson`, document types. |
| `@erniesg/struct/ids` | `src/ids.ts` | Current prerelease alias | ID and semantic-digest operations. |
| `@erniesg/struct/recovery` | `src/recovery.ts` | Intended stable first-release surface | Structured source-neutral recovery utilities. |
| `@erniesg/struct/renderers/xhtml` | `src/renderers/xhtml.ts` | Intended stable first-release surface | `renderPublicationXhtml`, `StructXhtmlOptions`. |
| `@erniesg/struct/renderers/epub` | `src/renderers/epub.ts` | Intended stable first-release surface | `buildStructEpub`, EPUB export/profile/options types, archive-size assertion. |

The root currently re-exports `StructCodecError`, `decodeStructDocument`,
`encodeStructDocument`, and `migrateStructDocument`; the latter is a current
prerelease alias only because it decodes the supported `0.1.0`/`0.2.0` matrix
and does not perform a version-to-version transform. It must become a real,
tested migration with a receipt or be replaced by honest decode-compatibility
terminology before first release.

All unlisted `src/**` modules, parser primitives, byte/hash implementations,
renderer plans, archive/XML helpers, legacy digest internals, and source-boundary
scripts are internal and unavailable to consumers. `@erniesg/struct/bundle` is
planned-unavailable: its runtime and wire types plus create/decode/verify/encode
operations are a documented S-03 target, not a current export.

## Documented stable first-release surface

| Intended path | Stable purpose |
| --- | --- |
| `@erniesg/struct` | Core `StructDocument` types, `StructCodecError`, `decodeStructDocument`, `encodeStructDocument`, and only a real migration operation. |
| `@erniesg/struct/document` | Full documented source-neutral document contract and version constants. |
| `@erniesg/struct/identity` | Stable IDs and semantic digest operations. |
| `@erniesg/struct/ordering` | Reading-order helpers. |
| `@erniesg/struct/receipt` | Semantic receipt types and fail-closed verification. |
| `@erniesg/struct/recovery` | Structured source-neutral diagnostics and recovery utilities. |
| `@erniesg/struct/bundle` | Bundle types and create/decode/verify/encode only when complete. |
| `@erniesg/struct/renderers/xhtml` | Deterministic XHTML renderer and versioned options/profile. |
| `@erniesg/struct/renderers/epub` | Deterministic EPUB builder and versioned profile/export types. |

`./core`, `./schema`, and `./ids` are not intended stable surfaces. Because no
exact-pinned external consumer exists at this base, they may be removed in the
first public prerelease after a **minimum 90-day prerelease compatibility window
starting with that prerelease's publication date**, with documented deprecation
warnings where technically applicable. If consumer evidence appears before that
release, the window restarts from the first documented consumer migration and a
removal version is recorded before removal. `./recovery` remains stable; the
root remains a slim convenience facade rather than an export-everything barrel.
