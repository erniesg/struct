# Stage 4 table, figure, caption, and asset renderer handoff

Status: implementation complete; fresh independent review requested.

Accepted baseline: `1cc71f134fcb385ec5efe5a43dbd5d1d1cf12cb2`.

## Scope and schema boundary

This slice implements only the Stage 4 renderer behavior supported by the
accepted document schema `0.3.0`. It changes no schema, codec wire shape,
migration rule, public export, package/API manifest, evaluation protocol, or
golden. No source document, raw input, private corpus, or source-derived
artifact was opened or added.

## Table behavior

- A `verified` table renders semantic `<table>` markup with its declared
  `th`/`td`, span, and scope values. The table receives one visible `<caption>`
  from the first accessibility-nonempty neutral value in `block.label`, then
  `block.text`; the selected value is escaped but otherwise preserved exactly.
- A `source-preserved` table renders no `<table>`, cells, composed cell IDs, or
  verified semantics. Only an explicit schema `0.3.0`
  `accessibleFallback: { kind: "block-text", completeness: "complete", ... }`
  is publishable. It renders the exact retained block text in a neutral named
  group, with the accessible name taken only from the declared source.
- `source-preserved` without that declaration and every `unresolved` table
  fail both renderer entry points with
  `STRUCT_PUBLICATION_TABLE_FALLBACK_REQUIRED`.
- Accessibility-empty verified names and declared fallback content fail with
  fixed content-free errors. NFKC/Unicode-whitespace checks validate only;
  accepted neutral values are never trimmed or rewritten.

## Figure, caption, and asset behavior

- Caption relationships affect markup only when `kind` is `caption`, status is
  `matched`, `from` is a caption block, and a target is a rendered figure-like
  block. Candidate IDs and non-matched statuses never create an association.
- An immediately following one-target matched caption becomes the figure's
  `<figcaption>` and keeps its block ID and inline content. Other explicit
  matched associations use `aria-describedby`, keeping caption text in
  canonical block order. Relationship labels never become visible content or
  alternative text.
- Figure artwork comes only from explicit `fallbackAssetIds`, in their declared
  order. Unattached assets remain packaged in canonical document asset order
  but do not become `<img>` elements.
- Every emitted image requires an `image/*` asset and exact nonempty neutral
  alternative text selected from `block.label`, then `block.text`. Captions,
  relationship labels, asset IDs, and filenames are never promoted to alt
  semantics. Failures are fixed as `STRUCT_PUBLICATION_IMAGE_ALT_EMPTY` and
  `STRUCT_PUBLICATION_IMAGE_MEDIA_TYPE_UNSUPPORTED`.
- EPUB export reports missing payload bytes as the fixed
  `STRUCT_EPUB_ASSET_BYTES_MISSING`. Package integrity now validates local
  `src` references as well as ordinary and namespaced `href` references.
- The synthetic asset fixture is a tiny hand-authored SVG created as bounded
  runtime bytes; no binary fixture or golden is tracked.

## Red-first evidence

Before production edits, the Stage 4 focused file reported 12 expected
failures while 6 prior cases passed. The failures included the exact TABLE-01,
FIG-01, and FIG-02 assertions:

- `names verified tables from neutral content`
- `keeps a matched caption with its figure`
- `refuses an unlabeled figure image`

The same red run also demonstrated the undeclared table fallback, exact alt
selection, non-image fallback, and fixed missing-byte gaps. A separate
packaged-XHTML `src` test failed because a dangling image source was accepted.
After implementation, the focused Stage 4/integrity/codec run passed 233/233.

## Verification

- Focused Stage 4, accessibility, EPUB-package, codec-rendering, integrity, and
  `0.3.0` fallback suite: 6 files, 233 tests passed.
- Focused follow-up after final semantic-wrapper/error assertions: 3 files,
  165 tests passed.
- `npm run test:layout-boundary`: privacy scan passed; 26/26 tests passed.
- `npm run test:source-boundary`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run test:package`: passed, including clean rebuild and packed consumer.
- Default-timeout `npm test`: 480/481 passed; the sole result was the existing,
  unchanged 5-second timeout in the 1 MiB canonical `Uint8Array` copy test.
- That unchanged timeout case passed alone at the normal timeout in 4.62
  seconds.
- Full non-boundary suite with the repository-documented 10-second allowance:
  481/481 passed.
- `git diff --check`, exact changed-file inventory, and content/privacy review:
  passed before handoff finalization and are rerun on the final tree.

## Fresh review request

Please independently review the clean local Stage 4 candidate. In particular,
confirm that non-verified tables never emit semantic cell markup; fallback
publication depends only on the accepted `0.3.0` declaration; matched caption
markup preserves block order and IDs; ambiguous candidates do not associate;
image alt text has no filename/caption inference; and `href`/`src`, payload,
manifest, and archive integrity remain closed and deterministic.

No remote, PR, issue, push, publish, other-worktree, or private-corpus action
was performed.
