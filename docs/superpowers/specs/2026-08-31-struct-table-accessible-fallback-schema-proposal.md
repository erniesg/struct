# Struct table accessible-fallback schema proposal

- Status: review required; schema stop; no implementation
- Date: 2026-08-31
- Trigger: Stage 2.1 source-neutral EPUB baseline characterization
- Compatibility target: a new schema version after `0.2.0`

## Problem

The current neutral graph distinguishes `verified`, `source-preserved`, and
`unresolved` table semantics. It does not say whether a non-verified table has
a complete accessible publication fallback. `StructBlock.text`,
`StructBlock.label`, and `fallbackAssetIds` retain useful content, but none of
them authoritatively declares that the retained content fully represents the
table for publication.

The Stage 2.1 characterization therefore pins the current behavior without
endorsing it: a `source-preserved` table is rendered as the same semantic
`<table>` as a `verified` table. A renderer must not infer fallback completeness
from a nonempty label, generic block text, an asset, or document-level recovery
state.

## Proposed neutral field

If approved, add this closed optional field to `StructTable` in a new document
schema version:

```ts
type StructTableAccessibleFallback = {
  kind: 'block-text'
  completeness: 'complete'
  accessibleNameSource: 'block-label' | 'block-text'
}

type StructTable = {
  // Existing fields remain unchanged.
  accessibleFallback?: StructTableAccessibleFallback
}
```

This adds no fallback prose and no renderer-authored label. It only declares
the publication meaning of already-neutral content on the containing table
block. An asset-only alternative is intentionally absent from this first
proposal because an image does not, by itself, establish an accessible table
fallback.

## Proposed invariants

- `semantic: "verified"` prohibits `accessibleFallback`; verified table cells
  remain the semantic publication authority.
- `semantic: "source-preserved"` may carry the field. Publication readiness
  requires `completeness: "complete"`, recovery `ready`, nonempty block text,
  and a nonempty value at the selected accessible-name source.
- `semantic: "unresolved"` prohibits the field and remains review-required.
- An absent field on a non-verified table never means complete.
- A complete block-text fallback renders as source-preserved text, not as a
  falsely verified `<table>`.
- The codec validates these rules before renderer planning. The renderer never
  upgrades completeness or invents a name.

## Versioning and migration

This is a wire-semantic addition, so it must not be added silently to schema
`0.2.0`. Existing `0.1.0` and `0.2.0` decoding remains unchanged. No automatic
migration may claim that an older non-verified table has a complete fallback;
an approved producer must emit the new version and declaration explicitly.

Until this proposal is accepted, non-verified table publication is a schema
stop. Renderer work may add accessible naming for already verified tables from
existing nonempty neutral labels, but it must not implement the fallback rule
described here.

## Intended implementation files after approval

- `src/document/types.ts`
- `src/document/codec/parsers.ts`
- `src/document/codec/invariants.ts`
- schema compatibility and migration documentation
- focused codec and layout-evaluation tests

No renderer file is authorized by this proposal alone.
