# Source-neutral EPUB layout evaluation implementation plan

> Plan only. Do not implement these tasks as part of the planning change.

- Date: 2026-08-31
- Repository: `erniesg/struct`
- Branch: `codex/struct-layout-epub-corpus`
- Design: [Source-neutral EPUB layout evaluation design](../specs/2026-08-31-struct-layout-epub-corpus-evaluation-design.md)
- Baseline: `2434dcfddce3ee7100cba4f93dd8bc906b825de7`

## Objective

Add a standalone public evaluation that proves a source-neutral
`StructDocument` is strictly normalized and rendered into deterministic,
well-formed, linked, structurally accessible XHTML and EPUB across the required
layout categories. Connect it to a separately implemented owner-private
Ernie.SG bridge that can evaluate private reconstructed documents without
putting source-derived material or per-document results in Struct.

The implementation is complete only after the public synthetic suite, the
private development gate, and one untouched fixed holdout gate all pass under
the frozen protocol. This plan does not authorize registry publication,
deployment, a public route, remote mutation, or committing any private source
artifact.

## Guardrails for every task

- Work only from a clean, isolated worktree on the named branch. Recheck
  `git status --short --branch` before and after each commit.
- Never open, copy, enumerate, hash into a public artifact, or print the private
  corpus from a Struct command. Struct development uses synthetic cases only.
- Never add a PDF, PNG, screenshot, crop, private EPUB, source-derived fixture,
  source filename, source text, source geometry, source identifier, or private
  per-document result to Struct.
- Use existing public package exports at the private bridge. Do not create a
  PDF adapter, file reader, browser upload, or private runner in Struct.
- Preserve schema `0.1.0`/`0.2.0` compatibility. If a required behavior cannot
  be expressed with current fields, stop that slice and write a separately
  reviewed schema/version proposal; do not smuggle a breaking invariant into
  renderer ingress.
- Renderer changes require a renderer implementation/profile version change
  and reviewed golden deltas. A schema version changes only when the neutral
  document wire contract changes.
- Write a failing focused test before each production change. Never regenerate
  all goldens to discover the desired behavior.
- Keep failure reports closed and content-free. Assertions may identify a
  synthetic case and schema field but must not serialize arbitrary input.
- Private development observations may produce only independently invented
  abstract public fixtures after privacy/license review.

## Planned public tree

```text
evaluation/
  layout-epub-v1/
    README.md
    protocol.json
    aggregate-report.schema.json
    fixtures/
      manifest.json
      provenance.json
    goldens/
      <synthetic-case-id>/
        content.xhtml
        nav.xhtml
        package.opf
        container.xml
        styles.css
        archive.json
tests/
  layout-eval/
    fixture-builder.ts
    fixture-contract.test.ts
    paragraph-hierarchy.test.ts
    table-figure-asset.test.ts
    citation-note-ambiguity.test.ts
    multicolumn-rtl-navigation.test.ts
    metadata-accessibility.test.ts
    epub-package.test.ts
    malformed-bounds.test.ts
    reproducibility-goldens.test.ts
    helpers/
      archive.ts
      assertions.ts
      xml.ts
scripts/
  check-layout-eval-boundary.mjs
  verify-layout-goldens.mjs
```

Fixtures may be TypeScript builders even though their public manifest and
goldens live under `evaluation/`. Do not commit encoded asset binaries; builders
create bounded bytes at runtime. Keep test helpers private to the test suite and
do not add an evaluation export to the package API unless a later consumer
contract proves one is necessary.

## Stage 0 — freeze the protocol and add the leak-prevention gate

### Task 0.1: Add the machine-readable protocol

Files:

- Create `evaluation/layout-epub-v1/README.md`.
- Create `evaluation/layout-epub-v1/protocol.json`.
- Create `evaluation/layout-epub-v1/aggregate-report.schema.json`.
- Add schema/protocol tests in
  `tests/layout-eval/fixture-contract.test.ts`.

Protocol requirements:

- enumerate exactly: `paragraph`, `hierarchy`, `tables`, `figures`,
  `citations`, `notes`, `multicolumn`, `rtl`, `navigation`, `assets`,
  `metadata`, `malformed`, `bounds`, and `ambiguity`;
- record metric formulas, initial thresholds, two-run determinism, minimum
  reporting population, suppression rules, and development/holdout states;
- keep protocol, fixture, renderer, profile, bridge, and cohort versions as
  independent axes;
- make aggregate objects closed with `additionalProperties: false` at every
  level;
- allow only closed enum strings, public artifact identities, booleans,
  bounded non-negative integers, and derived rates;
- omit, rather than null-fill, suppressed counts and rates;
- disallow document arrays, free-form errors, paths, filenames, URLs, source or
  output hashes, timestamps, text, geometry, and arbitrary metadata;
- distinguish `rendered-ready`, `source-preserved-ready`,
  `expected-review-refusal`, `invalid-bridge-document`,
  `unexpected-renderer-refusal`, and `conformance-failure` as aggregate
  outcomes without carrying input details.

Tests first:

- a complete synthetic aggregate validates;
- every forbidden/unknown field is rejected;
- suppressed cells reject numerator, denominator, and rate;
- rates inconsistent with their integer counters are rejected or recomputed by
  one trusted aggregator, never accepted from input;
- zero-tolerance counts cannot be hidden by suppression;
- holdout reports reject an unfrozen protocol state or more than the allowed
  qualifying transaction count.

Verify:

```bash
npx vitest run tests/layout-eval/fixture-contract.test.ts
```

Commit:

```text
test: define the source-neutral EPUB evaluation protocol
```

### Task 0.2: Add a tracked-file and output privacy guard

Files:

- Create `scripts/check-layout-eval-boundary.mjs`.
- Add focused self-tests to `tests/layout-eval/fixture-contract.test.ts` or a
  sibling `layout-eval-boundary.test.ts`.
- Add `test:layout-boundary` to `package.json`.

The guard must inspect the full tracked/staged repository without printing file
contents, with stricter manifest rules inside the evaluation tree. It must fail
on:

- PDF or raster corpus extensions anywhere in the repository;
- PDF/PNG/JPEG magic bytes anywhere in the repository;
- archive/container files other than reviewed textual golden expansions;
- oversized fixture/golden files or suspicious long encoded payloads;
- absolute home/workspace paths;
- fixture files absent from both the manifest and synthetic provenance ledger;
- golden directories not linked to one declared synthetic case;
- provenance other than the closed `synthetic` origin and repository license.

The self-test creates only temporary invented sentinel files. Error output names
the violated policy and synthetic temp-relative path, never file contents.

Add the boundary command to ordinary `npm test` coverage or a dedicated
required script invoked by package evidence. Run it before any golden
generation and again before every commit.

Verify:

```bash
npm run test:layout-boundary
git diff --check
```

Commit:

```text
test: prevent source material in layout evaluation artifacts
```

## Stage 1 — build the synthetic fixture and assertion harness

### Task 1.1: Create one canonical fixture builder

Files:

- Create `tests/layout-eval/fixture-builder.ts`.
- Create `evaluation/layout-epub-v1/fixtures/manifest.json`.
- Create `evaluation/layout-epub-v1/fixtures/provenance.json`.
- Extend `tests/layout-eval/fixture-contract.test.ts`.

Builder behavior:

- construct current-schema synthetic documents with deterministic IDs,
  receipts, evidence, page layouts, and optional runtime-generated assets;
- default to generic invented metadata and prose that cannot be mistaken for a
  publication excerpt;
- expose narrow helpers for blocks, table cells, assets, relationships,
  diagnostics, and resealing after a mutation;
- never accept a filesystem source path or arbitrary fixture text from the
  environment;
- return fresh deep values so cases cannot alias or mutate each other;
- support an intentional-invalid mutation after the last valid seal so tests
  can prove the correct boundary fails;
- keep each case small and readable; bounds cases use proxies/sparse test
  values rather than materializing the declared maximum.

Manifest fields are closed: case ID, required categories, expected disposition,
golden entry list, and provenance key. Each required category must have a
positive case and a negative or safe-ambiguity case. A test fails when coverage
is missing or when an undeclared case/golden exists.

Verify:

```bash
npx vitest run tests/layout-eval/fixture-contract.test.ts
npm run test:layout-boundary
```

Commit:

```text
test: add synthetic Struct publication fixture builders
```

### Task 1.2: Add bounded XML, archive, and semantic assertion helpers

Files:

- Create `tests/layout-eval/helpers/xml.ts`.
- Create `tests/layout-eval/helpers/archive.ts`.
- Create `tests/layout-eval/helpers/assertions.ts`.
- Start `tests/layout-eval/epub-package.test.ts` with helper self-tests.

Required helpers:

- parse XML with entities disabled and bounded traversal;
- collect IDs, `href`, `src`, namespaced hrefs, headings, visible text, table
  scopes/captions, ARIA roles, EPUB types, OPF metadata/manifest/spine entries,
  and nav hierarchy without normalizing away meaningful differences;
- inspect ZIP local headers and central directory so the suite can prove first
  entry, compression method, duplicates, timestamps, and canonical order rather
  than relying only on `unzipSync`;
- resolve package-relative paths with the same strict policy as production,
  while independently checking production results;
- compute an archive manifest with entry name, method, uncompressed length,
  CRC/digest, and order, but no input metadata;
- compare exact visible text tokens for synthetic cases and detect visually
  hidden duplicate citation/note text;
- report only synthetic case IDs and closed assertion names.

Do not export these helpers from `src/` or use production implementation
functions as the sole oracle for their own tests.

Verify:

```bash
npx vitest run tests/layout-eval/epub-package.test.ts
npm run typecheck
```

Commit:

```text
test: add independent XHTML and EPUB conformance assertions
```

## Stage 2 — characterize before changing renderer behavior

### Task 2.1: Pin the current public renderer baseline

Files:

- Add characterization cases to the category test files under
  `tests/layout-eval/`.
- Do not add goldens yet.

Exercise the present decoder, `normalizeStructDocumentForRenderer`,
`renderPublicationXhtml`, and `buildStructEpub` through public entry points.
Record which required assertions already pass and write explicit failing tests
for only the remaining contract gaps. Keep existing tests intact; the new suite
should consolidate evidence, not replace adversarial coverage.

Before production edits, produce a reviewer-facing checklist that maps every
new failing assertion to one category and one intended file. If a failure
requires a new neutral field rather than a renderer rule, invoke the schema
stop condition and split it out.

Verify the unchanged baseline with:

```bash
npx vitest run tests/codec-fixtures-contract.test.ts tests/codec-rendering.test.ts tests/epub-integrity.test.ts tests/layout-eval
npm run typecheck
npm run test:source-boundary
```

No production commit is created for a red-only local checkpoint. Keep the
checkpoint local or commit only tests that accurately describe already landed
behavior.

## Stage 3 — paragraph, hierarchy, reading order, RTL, and navigation

### Task 3.1: Make canonical publication order explicit

Files:

- Test in `tests/layout-eval/paragraph-hierarchy.test.ts` and
  `tests/layout-eval/multicolumn-rtl-navigation.test.ts`.
- Update `src/document/codec/invariants.ts` only if the existing current-schema
  contract already entails the invariant without breaking accepted documents.
- Otherwise keep validation compatible and update renderer planning in
  `src/renderers/xhtml-plan.ts` or a new internal pure publication-plan module.
- Add focused ordering tests to `tests/codec-layout-receipts.test.ts` when the
  invariant belongs to the codec.

Red cases:

- canonical blocks traverse span, left, right, and following span evidence but
  render exactly once in `blocks` array order;
- furniture remains queryable in the graph but absent from visible reading
  order and navigation;
- duplicate/gapped `order` evidence is either rejected under an already valid
  invariant or proven non-authoritative without reordering output;
- `orderBlocksByLayout` produces its documented conservative adapter order but
  renderers do not call it implicitly.

Implementation rule: choose one authority and document it. Do not sort from
coordinates inside XHTML/EPUB and do not visually reproduce columns in
reflowable output.

### Task 3.2: Add a pure heading/navigation plan

Files:

- Prefer a new internal `src/renderers/navigation-plan.ts` if this keeps OPF/nav
  planning independent from string serialization.
- Update `src/renderers/xhtml.ts`, `src/renderers/epub.ts`, and
  `src/renderers/xhtml-plan.ts` only at their owned seams.
- Test in `tests/layout-eval/paragraph-hierarchy.test.ts` and
  `tests/layout-eval/multicolumn-rtl-navigation.test.ts`.

Red cases cover levels 1–3, repeated levels, a level gap, duplicate heading
text with distinct IDs, escaped heading text, an empty heading rejection or
documented representation, furniture exclusion, and every nav target resolving
to emitted content.

Implement the design's deterministic stack rule. Navigation uses exact heading
text and stable block IDs; it creates no placeholder hierarchy nodes and no
source-dependent labels. Preserve validated XHTML heading tags.

### Task 3.3: Propagate RTL consistently

Files:

- Update `src/renderers/xhtml.ts` and `src/renderers/epub.ts`.
- If shared default CSS would otherwise diverge, extract one internal constant
  used by both renderers rather than maintaining two strings.
- Test in `tests/layout-eval/multicolumn-rtl-navigation.test.ts`.

Red cases prove:

- content and nav carry matching language/direction;
- OPF spine progression derives from `baseDirection: rtl` for an unprofiled
  build;
- an explicit profile agrees with a known document direction or fails with a
  stable profile/direction error before archive construction;
- `unknown` does not invent RTL;
- CSS uses logical properties and mixed RTL/LTR Unicode is preserved exactly;
- two builds are byte-identical and do not use ambient locale case conversion.

Focused verify:

```bash
npx vitest run tests/layout-eval/paragraph-hierarchy.test.ts tests/layout-eval/multicolumn-rtl-navigation.test.ts tests/codec-rendering.test.ts
npm run typecheck
```

Commit after the three tasks are green and one reviewer confirms no schema
compatibility drift:

```text
fix: define deterministic hierarchy order and RTL navigation
```

## Stage 4 — tables, figures, assets, and structural accessibility

### Task 4.1: Complete semantic table assertions and accessible naming

Files:

- Add cases to `tests/layout-eval/table-figure-asset.test.ts` and
  `tests/layout-eval/metadata-accessibility.test.ts`.
- Update `src/renderers/xhtml.ts` and planning code as required.
- Extend codec tests only for genuine neutral invariants.

Cases cover rectangular and sparse grids, row/column spans, all supported
header scopes, cell inline links/notes, deterministic coordinate order, and
overlap/out-of-bounds rejection before cell traversal.

Use only an existing non-empty neutral block label/text as an accessible table
name or caption; never synthesize a description. A `verified` table may emit
semantic table markup. A `source-preserved` or `unresolved` table must follow
its declared accessible fallback and must not be marked verified. If current
fields cannot distinguish a complete accessible fallback, refuse publication
and open the schema proposal instead of inferring.

### Task 4.2: Make figure and asset output exact

Files:

- Extend `tests/layout-eval/table-figure-asset.test.ts` and
  `tests/layout-eval/epub-package.test.ts`.
- Update `src/renderers/xhtml.ts`, `src/renderers/epub.ts`, and asset validation
  at their existing boundary.

Cases cover one figure/caption, multiple declared fallback assets, SVG created
at runtime, digest mismatch, absent bytes, bad media type, duplicate/reserved
ID/href, traversal, percent ambiguity, and packaged XHTML assets.

Rules:

- asset iteration is deterministic and manifest-conserving;
- `img src` resolves to a packaged manifest item;
- alternative text comes only from an existing non-empty neutral label/text;
- no filename is used as alternative text;
- missing accessible labeling fails with a stable source-neutral error or
  review disposition;
- the renderer never mutates asset bytes or caller arrays;
- `href`, `src`, and namespaced link attributes receive equivalent integrity
  checks.

### Task 4.3: Add deterministic structural accessibility checks

Files:

- Complete `tests/layout-eval/metadata-accessibility.test.ts`.
- Update semantic markup in `src/renderers/xhtml.ts` and nav markup in
  `src/renderers/epub.ts`.

Assert language/direction, heading levels, named navigation, table caption and
scopes, non-empty image alternatives, note/bibliography roles, one-to-one
noteref/backlink anchors, no duplicate IDs, no dangling ARIA/link references,
and no focusable hidden duplicate links. These are Struct structural gates;
do not add claims about screen-reader usability or release approval.

Focused verify:

```bash
npx vitest run tests/layout-eval/table-figure-asset.test.ts tests/layout-eval/metadata-accessibility.test.ts tests/layout-eval/epub-package.test.ts tests/codec-rendering.test.ts tests/epub-integrity.test.ts
npm run typecheck
```

Commit:

```text
fix: harden table figure and asset accessibility
```

## Stage 5 — citations, notes, links, and ambiguity safety

### Task 5.1: Pin matched citation and note semantics

Files:

- Add cases to `tests/layout-eval/citation-note-ambiguity.test.ts`.
- Update `src/renderers/xhtml-plan.ts` and `src/renderers/xhtml.ts`.

Cases cover singleton/grouped numeric citations, author-year citations,
overlapping inline style owners, table-cell note references, footnotes,
endnotes, author notes, repeated rendered references, and external links.

Assert exact visible marker preservation, `biblioref`/`noteref` roles, one
stable relationship occurrence ID, all proven grouped targets represented
without visible invention, backlinks only to emitted references, and no hidden
duplicate canonical marker text.

### Task 5.2: Fail closed for non-matched relationships

Files:

- Extend `tests/layout-eval/citation-note-ambiguity.test.ts`.
- Update the semantic target selection in `src/renderers/xhtml-plan.ts`.
- Add codec invariant tests if relationship status/candidate combinations need
  validation without changing durable meanings.

Red cases explicitly place tempting `targetIds` and candidates on
`ambiguous`, `unresolved`, and `source-preserved` relationships. The visible
marker must survive, candidate facts must survive neutral encode/decode, and no
candidate becomes an emitted link or verified ARIA relationship. A matched
relationship remains linked. An explicit plain hyperlink with no ambiguous
semantic relationship remains governed by the safe URL policy.

Test recovery outcomes separately: complete source-preserved content may remain
ready, while missing publishable fallback yields the existing
review-required EPUB refusal. Never convert ambiguity to a renderer crash or
silently drop the marker.

Focused verify:

```bash
npx vitest run tests/layout-eval/citation-note-ambiguity.test.ts tests/codec-rendering.test.ts
npm run typecheck
```

Commit:

```text
fix: preserve notes citations and ambiguity without false links
```

## Stage 6 — metadata and complete EPUB package graph

### Task 6.1: Define exact publication metadata

Files:

- Add cases to `tests/layout-eval/metadata-accessibility.test.ts`.
- Update `src/renderers/xhtml.ts` and `src/renderers/epub.ts`.

Test title/subtitle policy, multiple authors, language, abstract/description
policy, publication date, artifact modified time, fallback updated date,
identifier, XML escaping, empty optional values, and RTL direction.

Decisions to enforce:

- metadata comes only from `StructMetadata`, receipt, and explicit profile;
- no `Date.now`, filesystem mtime, runtime locale, or source filename affects
  XHTML, OPF, identifier, archive, or output filename;
- date normalization has one canonical UTC representation;
- author and metadata ordering follows the neutral arrays and is stable;
- absent optional metadata is omitted rather than invented.

### Task 6.2: Validate ZIP/container/OPF/nav/content as one conserved graph

Files:

- Complete `tests/layout-eval/epub-package.test.ts`.
- Refactor internal helpers out of `src/renderers/epub.ts` only if needed for a
  cohesive `epub` plan/integrity boundary; do not expose new package subpaths.
- Extend `tests/epub-integrity.test.ts` for adversarial cases that belong in the
  general package contract.

Red/green checks:

1. `mimetype` is first, stored, exact, and has no BOM/newline.
2. Local and central ZIP directories agree; names are unique/safe; timestamps,
   flags, compression, and order are fixed.
3. Container XML is well formed and resolves exactly one existing OPF.
4. OPF unique identifier resolves; metadata is exact; manifest IDs/hrefs are
   unique; nav occurs once; spine IDs resolve.
5. Every EPUB publication entry is accounted for by the manifest and every
   manifest item has bytes, with only EPUB-defined container exceptions.
6. Every XHTML ID is unique in its document; every local `href`/`src` and
   fragment resolves; external schemes are allowlisted.
7. Nav nesting matches the heading plan and each target is in a spine XHTML
   document.
8. Asset media types/digests and reopened profile/CSS receipts agree.
9. Reserved-path shadowing, duplicate ZIP names, malformed XML, dangling
   links, unsafe traversal, query/fragment asset hrefs, and malformed packaged
   XHTML fail before a successful export is returned.

Do not use the same production parser as the only test oracle. Keep reopen
work bounded by declared archive limits.

Focused verify:

```bash
npx vitest run tests/layout-eval/metadata-accessibility.test.ts tests/layout-eval/epub-package.test.ts tests/epub-integrity.test.ts
npm run typecheck
```

Commit:

```text
fix: validate deterministic EPUB metadata and package graph
```

## Stage 7 — malformed inputs and resource boundaries

### Task 7.1: Build the mutation matrix

Files:

- Create/complete `tests/layout-eval/malformed-bounds.test.ts`.
- Reuse existing codec constants rather than duplicating numeric limits.
- Change `src/document/codec/**`, `src/renderers/xhtml-plan.ts`, or
  `src/renderers/epub.ts` only when a red test demonstrates a real gap.

Mutation coverage:

- unknown/missing fields at every major document level;
- invalid schema/document/receipt binding and digest;
- duplicate/reserved/normalization-colliding IDs across all emitted ID kinds;
- dangling block/asset/relationship/page/column/note/citation targets;
- forbidden XML 1.0 scalars and lone surrogates;
- invalid BCP-47, RFC 3339, MIME, URL scheme, URL credentials, path traversal,
  controls, whitespace, percent ambiguity, query, and fragment;
- non-finite/unsafe integers and negative zero;
- malformed table dimensions/spans/overlap/sparse cell count;
- malformed asset bytes, media mismatch, digest mismatch, absent bytes, and
  aggregate asset excess;
- malformed nav/content/asset XHTML and broken OPF/container references;
- accessor, proxy, revoked proxy, cycle, subclassed bytes, and hostile iterator
  behavior;
- inline segment/active-owner/wrapper/citation work and archive output limits.

For every declared bound, add N-1, N, and N+1 tests. N+1 must fail before
reading hostile tail data or allocating proportional output. N and N-1 must
not be rejected merely due to the boundary. Existing tests may supply evidence;
link them in the category manifest rather than copy expensive vectors.

Errors are asserted by stable class/code/path category, not full dynamic
messages. A renderer never returns partial XHTML/EPUB after a bound failure.

Verify:

```bash
npx vitest run tests/layout-eval/malformed-bounds.test.ts tests/codec.test.ts tests/codec-layout-receipts.test.ts tests/codec-rendering.test.ts tests/epub-integrity.test.ts
npm run typecheck
```

Commit:

```text
test: cover malformed publication inputs and exact bounds
```

## Stage 8 — neutral goldens and reproducibility

### Task 8.1: Add an explicit golden writer and verifier

Files:

- Create `scripts/verify-layout-goldens.mjs`.
- Complete `tests/layout-eval/reproducibility-goldens.test.ts`.
- Populate only declared directories under
  `evaluation/layout-epub-v1/goldens/`.
- Add `test:layout` and `test:layout-goldens` scripts to `package.json`.

Normal mode reads and compares goldens. Update mode requires an explicit flag,
a clean worktree, a selected synthetic case ID, and a successful privacy guard.
It refuses private paths, bulk implicit updates, undeclared files, binary EPUB
output, or a case without synthetic provenance.

For each successful case commit exact `content.xhtml`, `nav.xhtml`,
`package.opf`, `container.xml`, `styles.css`, and `archive.json`. Add
`profile.json` only for a profiled synthetic case. `archive.json` records the
full EPUB SHA-256 and bounded entry metadata; do not commit `.epub` files.

Tests build each case three times in one process and once in a fresh Node
process, comparing exact XHTML, entry text, entry order/metadata, EPUB bytes,
and digest. CI should run supported Node lanes from the lockfile. Any
cross-runtime delta fails until either removed or explicitly bounded by a new
renderer/protocol version; it is not auto-normalized in the test.

Golden review checklist:

- every line traces to a synthetic input or fixed renderer constant;
- no title/name/path resembles private material;
- visible text occurs exactly as expected and not in hidden duplicates;
- IDs, links, roles, table scopes, nav nesting, metadata, and asset entries are
  independently asserted in addition to snapshot equality;
- the diff is explained category by category;
- fixture/protocol/renderer versions are updated when required.

Verify:

```bash
npm run test:layout-boundary
npm run test:layout
npm run test:layout-goldens
git diff --check
```

Commit:

```text
test: pin source-neutral XHTML and EPUB goldens
```

## Stage 9 — Struct integration and public evidence

### Task 9.1: Wire the suite into required local evidence

Files:

- Update `package.json` scripts without broadening package exports.
- Update `README.md` with a short truthful evaluation section.
- Update `API.md` only if an actual existing renderer contract changed.
- Update `API_MANIFEST.json` only if a separately approved public API change is
  truly required; the expected plan is no new export.

Required local order:

```bash
npm ci
npm run test:layout-boundary
npm run typecheck
npm run test:source-boundary
npm test
npm run build
npm run test:package
git diff --check
git status --short --branch
```

Pack the exact clean candidate and install it in the existing clean packed
consumer test. Record the commit and tarball digest in local evidence. Do not
claim `implemented, unreleased` until these commands pass at the same clean
commit; do not claim `released` without the separate registry gate.

Review the source boundary for forbidden acquisition/reconstruction/provider/UI
imports and dependency cycles. Review the entire staged file list for binaries
and provenance before committing.

Commit:

```text
test: gate the source-neutral EPUB layout evaluation
```

## Stage 10 — separate owner-private Ernie.SG bridge

This stage is implemented in Ernie.SG/private evaluation infrastructure, never
in the Struct repository and never in the same commit series. The current
public Ernie.SG responsibility is represented by its reconstruction-to-Struct
adapter; use the adapter location current at the implementing Ernie.SG head.
Do not copy that adapter or its private source types into Struct.

### Task 10.1: Exact-pin and invoke Struct in memory

Ernie.SG bridge behavior:

1. Receive a source through the existing owner-private acquisition/browser
   boundary without placing its path on the command line or in logs.
2. Run the existing private reconstruction and source-to-Struct conservation
   checks.
3. Convert through the Ernie-owned adapter to a fresh `StructDocument`.
4. Load the exact clean packed Struct artifact and verify its expected digest
   before processing private input.
5. Call public codec, XHTML, and EPUB APIs in memory with a frozen profile.
6. Run the neutral document-to-output assertions twice in one sealed
   evaluation transaction.
7. Keep private document, XHTML, EPUB, source comparisons, errors, and hashes in
   access-controlled owner storage only.
8. Map outcomes to closed counters before any logger or serializer sees them.

The bridge must never invoke Struct with a source path, add a source reader to
Struct, use a Struct worktree as temporary storage, or include arbitrary
exception `message`, `stack`, `cause`, object inspection, document JSON, XHTML,
or EPUB bytes in output. Unexpected exceptions become one generic aggregate
failure counter; detailed evidence remains private.

### Task 10.2: Validate sanitizer and ownership

Private bridge tests use invented documents only and prove:

- output validates against the public aggregate schema;
- strings/titles/paths/IDs/digests injected into every possible exception and
  metadata location cannot appear in aggregate JSON or logs;
- unknown result fields and free-form error messages fail closed;
- every assigned member produces one terminal outcome and cannot disappear
  from denominators;
- renderer review refusal is distinct from bridge failure;
- two-run mismatch is counted without emitting either digest;
- source-to-Struct metrics and Struct-to-EPUB metrics remain separate;
- private temporary storage is access-restricted and cleaned by the private
  supervisor;
- the bridge has no write path to the Struct checkout or public artifact store.

Use Ernie.SG's existing source-neutral category tests—paragraph reconstruction,
heading/layout order, table scope/semantics, figures, formulas, citations,
notes, source fallbacks, and EPUB integrity—as bridge prerequisites. Do not
move their source-specific logic into Struct. Add only missing bridge seam tests
in Ernie.SG.

Suggested separate commit message:

```text
test: add the private Struct EPUB evaluation bridge
```

The commit may contain bridge code and synthetic seam tests, but no corpus
manifest, private config, per-document output, aggregate corpus result, or raw
artifact.

## Stage 11 — development gate and threshold freeze

### Task 11.1: Run development evaluation privately

Prerequisites:

- public Struct Stage 9 is green at one clean commit and packed artifact;
- the private license ledger, lineage-grouped split, development membership,
  and holdout membership are already frozen;
- bridge/sanitizer tests are green;
- protocol is still in `development-open` state;
- no holdout member has been processed by the candidate.

The owner-private development run records only aggregate:

- assigned/completed/eligible/ready/review outcome counts;
- category eligibility/readiness with minimum-cell suppression;
- neutral obligation conservation;
- semantic versus source-preserved coverage;
- false assertion, XML/ID/link/package/accessibility, bounds, and determinism
  failure counts;
- exact public Struct artifact/profile/protocol identities.

Gate:

- assigned completion and neutral conservation are 100%;
- privacy, false assertion, conformance, and determinism failures are zero;
- overall publication-ready is at least 95%;
- every unsuppressed category-ready rate is at least 90%;
- ambiguity safety is 100%;
- public synthetic suite remains fully green.

If development fails, improve only general rules reproducible with public
synthetic or private-development evidence. Do not inspect holdout. Safe
source-preserved output is preferable to a false semantic improvement.

### Task 11.2: Freeze the release-candidate protocol

After development passes, create an immutable private freeze record containing
the exact split, bridge, sanitizer, artifact, profile, runtime, formulas,
thresholds, suppression, and allowed execution count. In public Struct, change
only the non-sensitive protocol state/version needed to identify the frozen
evaluation contract; do not commit private manifest/digests or development
results.

Run the complete Struct commands again on the freeze commit. Any later public
code, fixture, golden, dependency, profile, formula, or sanitizer change returns
the protocol to development and requires a new freeze before holdout.

Suggested public commit, only if a protocol state file actually changes:

```text
chore: freeze the EPUB layout evaluation protocol
```

## Stage 12 — one immutable holdout transaction

### Task 12.1: Preflight without opening holdout inputs

Prove privately that:

- the candidate matches the frozen clean Struct artifact and profile;
- the aggregate serializer/sanitizer and output destination are fixed;
- no interactive debugger, verbose logger, snapshot updater, or public artifact
  upload is enabled;
- the transaction will execute the candidate twice per input and emit one
  aggregate receipt;
- the infrastructure-only retry condition is defined before execution;
- the implementing team has not accessed holdout per-document data.

### Task 12.2: Execute and decide

Run one qualifying transaction. Validate the aggregate receipt against the
frozen schema and thresholds. The fixed holdout gate is identical to the
development gate: 100% completion/conservation/ambiguity safety, zero privacy
or critical conformance/determinism failures, at least 95% overall ready, and
at least 90% ready for every unsuppressed category.

If it passes, retain the full evidence only in owner-private Ernie.SG storage.
Any optional public attestation receives separate owner privacy approval and
contains only protocol version, exact public Struct artifact, gate name, and
pass/fail.

If it fails, close that holdout version. Do not inspect or publish per-document
failures, loosen thresholds, edit the candidate, and rerun the same version as
if it were untouched. Start a new development epoch and require a previously
untouched licensed holdout version. If none exists, report the stop condition.

No Struct commit is made for private holdout output.

## Final review and commit discipline

Review every future Struct commit independently:

1. `git diff --check` and exact staged file inventory.
2. Privacy guard and synthetic provenance manifest.
3. Focused red/green tests named by the commit.
4. Typecheck and source-boundary check for production changes.
5. Golden diff review when renderer bytes change.
6. Full test/build/packed-consumer evidence at integration points.
7. Ownership grep confirming no source acquisition, reconstruction, private
   runner, provider, UI, or application imports.
8. Content-free failure output review.

Never amend a reviewed golden commit to hide output drift. Follow-up repairs
receive a new small commit. Do not mix the private bridge, private evidence, or
holdout decision into a Struct commit. Do not push, open a PR, publish, merge,
or deploy without the later explicit authority for that action.

## Completion checklist

- [ ] All fourteen categories have declared positive and negative/ambiguity
      synthetic coverage.
- [ ] Every public fixture has synthetic provenance and no tracked binary.
- [ ] Codec/renderer ingress remains strict, bounded, and source-neutral.
- [ ] Paragraph text, hierarchy, canonical order, tables, figures, citations,
      notes, RTL, navigation, assets, and metadata have exact assertions.
- [ ] Ambiguous/unresolved semantics never create false links or verification.
- [ ] XHTML is XML-well-formed, ID/link-safe, and structurally accessible.
- [ ] ZIP/container/OPF/nav/content/assets form one conserved package graph.
- [ ] Bounds have N-1/N/N+1 and hostile preflight tests.
- [ ] Synthetic XHTML/XML/archive goldens and three-run byte equality pass.
- [ ] Full type/test/build/source-boundary/packed-consumer evidence passes at one
      clean Struct commit.
- [ ] Ernie.SG's private bridge exact-pins that artifact and passes sanitizer
      tests without writing to Struct.
- [ ] Development aggregate meets the frozen gates.
- [ ] One untouched holdout version meets the same gates in one qualifying
      transaction.
- [ ] Private evidence remains private; Struct contains no corpus-derived
      artifacts or results.
- [ ] Release/publication/deployment remains separately authorized.

## Stop conditions

Stop and request a new design/review decision if implementation would require:

- adding any private or source-derived material to Struct;
- reading a source format from Struct;
- changing persisted schema semantics without a version/migration plan;
- inventing text, targets, table semantics, captions, or alternative text;
- treating review refusal as renderer success or excluding it from denominators;
- emitting a private per-document diagnostic to aggregate output;
- lowering a threshold or changing a metric after holdout access;
- rerunning an observed holdout version after a result-informed change;
- publishing a package, aggregate report, application, or route without its
  separate authorization.
