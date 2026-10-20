# Source-neutral EPUB layout evaluation design

- Status: proposed implementation contract; documentation only
- Date: 2026-08-31
- Repository: `erniesg/struct`
- Planning branch: `codex/struct-layout-epub-corpus`
- Inspected Struct baseline: `2434dcfddce3ee7100cba4f93dd8bc906b825de7`

## Decision summary

Build a standalone, versioned evaluation lane around Struct's existing strict
`StructDocument` ingress and deterministic XHTML/EPUB renderers. The public
lane contains only source-neutral protocol code, wholly invented abstract
fixtures, and expected outputs produced from those fixtures. It never ingests
a PDF and never contains a corpus filename, source text, source identifier,
source geometry, screenshot, crop, rendered private artifact, or per-document
private result.

The owner-private Ernie.SG lane remains the only place that may acquire a PDF,
run reconstruction, accept a browser upload, compare output with a source, or
retain per-document evidence. It converts an approved private reconstruction
to a `StructDocument`, invokes an exact-pinned Struct artifact in the same
private execution boundary, and emits only a closed, non-identifying aggregate
receipt. Aggregate evidence is private by default and is not committed to
Struct.

This separates two claims that must not be conflated:

1. Ernie.SG proves, privately, that source obligations were accounted for in a
   neutral `StructDocument`.
2. Struct proves that a valid neutral document is normalized and rendered to
   deterministic, conforming, accessible XHTML and EPUB without semantic loss
   or unsafe invention.

## Current baseline and gaps

At the inspected baseline, Struct already has:

- strict decoders for schema `0.1.0` and `0.2.0`, canonical encoding, receipt
  binding, conservation checks, bounded text/assets/collections, and hostile
  object containment;
- source-neutral blocks, tables, assets, relationships, page/column evidence,
  diagnostics, recovery state, and document metadata;
- one bounded renderer-ingress normalization path;
- XHTML rendering for inline styles, tables, figures, notes, citations,
  cross-references, author notes, source anchors, language, and base direction;
- deterministic ZIP timestamps, bounded EPUB construction, OPF/container/nav
  generation, profile receipts, XML well-formedness checks, unique XHTML ID
  checks, internal `href` checks, and archive reopening;
- tests for table geometry and sparse cells, ID collisions, references, notes,
  citation planning budgets, Unicode/XML characters, unsafe paths, profile
  immutability, malformed XHTML assets, digest binding, and resource bounds.

The standalone evaluation must close or expose these material gaps:

- there is no committed category matrix or synthetic golden corpus;
- heading hierarchy and navigation nesting are not a stated contract;
- page/column data is validated, but publication reading-order behavior is not
  evaluated as a complete multicolumn scenario;
- global RTL behavior is not checked consistently across content, navigation,
  OPF spine direction, and logical styling;
- accessibility semantics are covered incidentally rather than by an explicit
  contract;
- OPF metadata coverage, archive entry ordering, container resolution, `src`
  integrity, and manifest/spine conservation need direct assertions;
- ambiguous and unresolved relationships need an explicit no-false-link gate;
- exact textual goldens and byte-for-byte EPUB reproducibility are not pinned
  as one reviewed suite;
- no development/holdout access protocol or privacy-safe aggregate schema is
  defined in this repository.

No private corpus was enumerated or opened to reach these conclusions.

## Ownership and data flow

```text
owner-private source
        |
        v
Ernie.SG acquisition / reconstruction / browser upload
        |
        | private source-to-neutral conservation and fidelity checks
        v
Ernie.SG reconstruction-to-Struct adapter
        |
        | in-memory StructDocument; never copied into the Struct checkout
        v
exact-pinned @erniesg/struct codec -> XHTML -> EPUB
        |
        | closed enum counters only
        v
owner-private aggregate receipt and release decision

public Struct repository
        |
        +-- protocol and aggregate JSON schema
        +-- wholly synthetic StructDocument fixtures
        +-- neutral XHTML/XML/textual archive goldens
        +-- deterministic conformance and mutation tests
```

| Concern | Owner | Struct repository rule |
| --- | --- | --- |
| PDF/file/browser acquisition | Ernie.SG | No reader, path option, upload code, or source adapter. |
| PDF reconstruction and source comparison | Ernie.SG | No private types, geometry heuristics, OCR, or source-derived expectations. |
| Reconstruction-to-Struct bridge | Ernie.SG | Struct exposes only its neutral package API. |
| `StructDocument` codec and normalization | Struct | Strict, bounded, source-neutral, deterministic. |
| XHTML and reflowable EPUB | Struct | Deterministic output from the neutral graph and explicit profile. |
| Synthetic cases and expected neutral output | Struct | Invented from scratch and provenance-reviewed. |
| Private per-document results and artifacts | Ernie.SG owner-private lane | Never enter a Struct worktree, log, issue, commit, or CI artifact. |
| EPUBCheck, Ace, browser/reader, and human release acceptance | Ernie.SG | Struct owns structural unit checks, not application release approval. |

## Non-negotiable privacy and licensing rules

### Public material

Every public fixture must be authored from scratch with generic labels,
invented prose, invented IDs, and deliberately simple geometry. Its provenance
record states `synthetic`, its authoring date, and the repository license. A
fixture must not be a transcription, paraphrase, geometry trace, minimized
private failure, or recognizable structural fingerprint of a private source.

Tracked evaluation material is text only. Figure and asset cases use tiny
hand-authored SVG or bytes created at test runtime. No PDF, PNG, screenshot,
crop, page image, OCR output, base64 corpus payload, or expanded private EPUB is
tracked. A generated golden may contain only output derived from a synthetic
fixture.

When a private failure motivates a regression, an implementer first writes a
category-level behavioral statement. A different reviewer then creates an
independent abstract fixture using unrelated text, IDs, counts, dimensions,
and assets. The private failing artifact is never used by a golden updater.

### Private material

Private source access is owner-only and read-only during evaluation. The
private runner must not put source material or a source-derived
`StructDocument` in command arguments, environment variables, public temp
directories, the Struct checkout, test snapshots, exception strings, or CI
logs. Per-document XHTML, EPUB, source comparisons, stack traces, and receipts
stay in access-controlled Ernie.SG evidence storage.

The source's access or publication venue is not evidence of redistribution
permission. Ernie.SG keeps an owner-private license/access ledger and excludes
any source whose evaluation right is unclear. Struct's public synthetic
fixtures remain MIT-licensed with the repository and require no source
license.

### Aggregate disclosure

The bridge output is a strict allowlist of protocol versions, closed category
and outcome enums, integer counters, rates derived from those counters, and
zero-tolerance booleans. It contains no free-form message, path, document ID,
private source/output digest, filename, title, author, URL, timestamp precise
enough to identify a run, text sample, geometry, or per-document row. The exact
public Struct artifact identity is allowed because it contains no corpus data.
Unknown fields fail validation.

Cells below the protocol's minimum reporting population are marked
`suppressed`; their numerator, denominator, and rate are omitted. Aggregate
receipts remain owner-private by default. If the owner later elects to publish
an attestation, the Struct repository may receive only the protocol version,
exact public Struct artifact identity, gate name, and pass/fail result after a
separate privacy review. Corpus-derived aggregate reports are not committed to
Struct.

## Evaluation artifact model

The public protocol has four independently versioned artifacts:

1. **Protocol version**: category definitions, metric formulas, suppression,
   sanitization, and gates.
2. **Neutral fixture version**: the complete public case set and golden
   manifest.
3. **Renderer implementation/profile versions**: the exact Struct artifact and
   explicit rendering configuration.
4. **Private bridge/cohort versions**: opaque owner-private identities. Their
   manifests and digests never cross into Struct.

A public case contains only:

- a stable synthetic case ID such as `hierarchy-01`;
- one or more required categories;
- a valid or intentionally invalid synthetic `StructDocument` builder;
- an expected disposition: render, codec rejection, renderer rejection, or
  review-required publication refusal;
- closed structural assertions;
- for successful cases, exact neutral textual goldens and an archive manifest
  containing entry names, compression method, uncompressed length, and digest.

Goldens are reviewed evidence, not an update oracle. Golden regeneration is an
explicit command disabled in ordinary test runs. A change must show both the
semantic assertion diff and the exact textual/archive diff; reviewers reject a
bulk acceptance with no contract explanation.

## Required category contract

Every category has at least one positive synthetic case, one relevant
negative/ambiguity case, and assertions at codec, XHTML, and EPUB-reopen
boundaries where applicable.

| Category | Required neutral behavior |
| --- | --- |
| Paragraph | Preserve visible text, whitespace policy, inline emphasis, superscript/subscript, safe links, XML escaping, and canonical block order without hidden duplicate text. |
| Hierarchy | Preserve validated heading levels, deterministic heading sequence, and a navigation tree derived only from headings; skipped/repeated levels follow one documented stack rule and never invent labels. |
| Tables | Preserve coordinate order, sparse holes, spans, header scope, cell inline semantics, and an accessible name/caption; reject overlaps and bounds before large allocation; unresolved semantics never become a falsely verified table. |
| Figures | Keep figure/caption association, deterministic asset order, meaningful synthetic alternative text, and fallback policy; missing required accessible labeling or bytes fails closed rather than inventing content. |
| Citations | Link only proven targets, use bibliographic EPUB/ARIA roles, cover grouped targets exactly once, preserve visible marker text, and avoid hidden canonical-text duplication. |
| Notes | Emit typed note references, note bodies, stable unique anchors, and backlinks only for rendered proven references; orphaned or ambiguous notes remain visible but unlinked/reviewable. |
| Multicolumn | Treat the canonical Struct block sequence as publication order, verify page/column membership evidence, exercise span/left/right transitions, and never recreate a visual column layout in reflowable XHTML. |
| RTL | Propagate document language/direction to content and navigation, set compatible OPF page progression, use logical CSS, preserve mixed Unicode, and reject an explicit profile whose direction contradicts the document contract. |
| Navigation | Emit one accessible EPUB 3 table of contents, preserve hierarchy and block IDs, resolve every target in the spine, omit furniture, and use no source- or locale-invented navigation text. |
| Assets | Verify ID/href/media type/digest/byte agreement, safe relative paths, exact manifest conservation, `src`/`href` resolution, no duplicate/reserved entries, and deterministic packaging. |
| Metadata | Preserve and escape title, subtitle policy, authors, language, abstract/description policy, publication date, deterministic modified time, identifier, and direction with no current-clock or source-filename dependence. |
| Malformed | Reject unknown fields, unsafe URLs/paths, forbidden XML scalars, invalid language/date/media types, duplicate IDs, dangling references, malformed XML assets, bad digests, and inconsistent receipts with stable error classes. |
| Bounds | Exercise N-1/N/N+1 for declared dimensions and counts, preflight before attacker-controlled materialization, bound inline expansion and archive size, and never truncate a valid value silently. |
| Ambiguity | Preserve visible content and candidate facts in the neutral graph, emit no false link/semantic assertion for non-matched relationships, choose a documented safe fallback, and require review when no publishable fallback exists. |

`source-preserved` is a safe, explicit outcome, not a semantic success. It may
count as publication-ready only when the neutral graph contains a complete
accessible fallback and recovery is `ready`. `review-required` must cause EPUB
publication refusal and counts separately from a renderer failure.

## Canonical reading order and hierarchy

The `blocks` array is the authoritative publication sequence passed to a
renderer. `block.order`, `pages[*].blocks`, and `pages[*].columns` are
cross-checkable evidence; they must not cause a renderer to reorder an already
canonical document. `orderBlocksByLayout` remains a conservative adapter helper
for constructing that sequence when explicit order is absent. It is not a
license to visually interleave columns during rendering.

The evaluation will make the invariant explicit: a normalized current-schema
document has one unambiguous block sequence, and every non-furniture block
appears exactly once in that order. Tightening persisted schema invariants must
use normal schema compatibility review; the evaluation must not silently make
previously accepted durable documents invalid.

Heading navigation uses a deterministic stack over the canonical heading
sequence. A heading becomes the nearest following descendant of the latest
heading with a lower numeric level; if no such heading exists it is a root.
Level gaps do not create synthetic nodes. Repeated levels become siblings.
Navigation labels are exact heading text after XML escaping.

## Deterministic XHTML contract

For a decoded document and a versioned options/profile value, XHTML output is
an exact pure function. Renderer ingress snapshots and validates before
planning. Rendering must not consult extractor state, filesystem/network,
ambient locale, time, randomness, object enumeration accident, or mutable
caller aliases.

Checks cover:

- XML declaration, XHTML and EPUB namespaces, `xml:lang`, `lang`, and `dir`;
- well-formed XML 1.0 and deterministic escaping of text/attributes/styles;
- one emitted ID plan spanning blocks, normalized relationship IDs, author
  notes, source anchors, and composed table-cell IDs, with fail-closed
  collision detection before output;
- exact visible-text conservation for synthetic cases, including overlapping
  inline runs, grouped citations, notes, and furniture exclusion;
- semantic heading, paragraph, quote, code, figure, caption, table, and note
  markup;
- accessible names for images/tables/navigation, table scopes, note and
  bibliography roles, backlinks, and no focusable visually hidden duplicates;
- internal/external link policy and resolution for `href`, `src`, and relevant
  namespaced link attributes;
- no linking of an ambiguous/unresolved relationship merely because candidate
  IDs are present;
- bounded planning with stable error codes rather than partial output.

Locale-sensitive case conversion is forbidden in deterministic planning unless
the locale is explicit and versioned. CSS uses logical properties for behavior
that changes under RTL.

## Deterministic EPUB contract

The EPUB gate reopens raw ZIP structure as well as decompressed entries.

### ZIP and container

- `mimetype` is the first local entry, uncompressed, with exact bytes
  `application/epub+zip` and no BOM/newline.
- Entry names are unique, safe, and emitted in a documented canonical order.
- Timestamps and platform-dependent ZIP metadata are fixed; identical input
  produces identical bytes and SHA-256 on every supported runtime lane.
- `META-INF/container.xml` is well formed, has the required namespace/version,
  names exactly one OPF rootfile, and that entry exists with the correct media
  type.
- There are no unmanifested publication resources or manifest entries without
  bytes, apart from the EPUB-defined container files.

### OPF

- Package version, unique-identifier linkage, language, title, authors, dates,
  modified time, direction, and optional profile metadata are exact and
  escaped.
- Manifest IDs and hrefs are unique; media types agree with neutral assets;
  the nav property occurs exactly once; every spine reference resolves to a
  manifest XHTML item.
- The identifier and modified time derive only from canonical input and the
  explicit profile. The current clock and raw source filename never contribute.
- RTL page progression agrees with document direction and any explicit
  profile; contradictions fail before packaging.

### Navigation, content, and assets

- `nav.xhtml` and every packaged XHTML resource are XML-well-formed.
- The table of contents follows the defined heading stack and all targets
  resolve to emitted IDs in a spine document.
- All local `href`/`src` targets resolve within the package; fragments exist;
  unsafe schemes, authority-relative URLs, queries on internal resources,
  traversal, backslashes, controls, and ambiguous percent encoding fail.
- Asset bytes match their declared digest and media type contract. Package
  entry order is stable and reserved paths cannot be shadowed.
- The reopened stylesheet and profile receipt match the retained profile
  hashes exactly.

Structural accessibility checks live in Struct because they are deterministic
properties of its markup. Pinned EPUBCheck/Ace runs, real reader/browser tests,
and human accessibility approval remain Ernie.SG release evidence and cannot
be replaced by Struct unit tests.

## Development and immutable holdout protocol

### Private census and split

Before implementation tuning, the owner-private runner deduplicates source
lineages and assigns whole related groups to either development or holdout. It
uses only private source identities and private category vectors. The split,
secret salt, license ledger, category membership, and manifest commitment stay
private. No filename, title, source hash, manifest hash, or per-category member
list is copied into Struct.

The holdout must be large enough for the minimum reporting population in every
privately measured category that claims holdout coverage. If a category lacks
that population, its private cell is `suppressed` and the public synthetic gate
is authoritative; the release must say private coverage was insufficient, not
claim a holdout pass for that category. The split is never adjusted after
results are observed.

### Development access

Development members may be rerun while implementing general rules. Developers
receive only sanitized aggregate category counters. Per-document debugging,
when unavoidable, is performed by the owner in the private Ernie.SG lane and
is not pasted into Struct discussions. Any public regression is independently
abstracted as described above.

Before the first holdout run, freeze:

- protocol and neutral fixture versions;
- exact Struct commit, packed artifact digest, dependencies, supported Node
  lanes, renderer implementation version, and profile receipt;
- private bridge version and private cohort version;
- metric formulas, minimum cell population, gate thresholds, and the allowed
  holdout execution count;
- the sanitizer and aggregate JSON schema.

### Holdout access

The holdout runner has no interactive inspection mode. One qualifying
evaluation transaction runs the exact artifact twice to measure determinism
and emits one sanitized aggregate receipt. A retry is allowed only for a
predefined infrastructure failure that produced no semantic counters; the
reason is retained privately.

Once any holdout result is observed, the cohort and protocol version are
closed. A code, profile, fixture, formula, threshold, sanitizer, or bridge
change informed by that result cannot claim a fresh pass against the same
holdout version. It starts a new development epoch and requires a previously
untouched, newly frozen holdout version. If no untouched licensed holdout
remains, work stops until the owner supplies one; repeated querying is not
reclassified as validation.

Changing only the private manifest also creates a new cohort version. Changing
category semantics, aggregation, suppression, or thresholds creates a new
protocol version. Results across versions may be shown side by side but are not
merged into one score.

## Metrics and fixed gates

Metrics distinguish safety/conformance from semantic coverage so that an
implementation cannot improve its score by inventing semantics or by refusing
every document.

| Metric | Meaning | Gate |
| --- | --- | --- |
| Assigned completion | Every cohort member reaches a closed bridge outcome; exclusions have an allowlisted aggregate reason. | 100% |
| Neutral conservation | Every Struct input obligation is rendered exactly once or has an explicit source-preserved/review disposition. | 100% |
| Safety assertions | False links, false verified tables, invented visible text, digest mismatches, dangling references, unsafe paths, or privacy-sanitizer failures. | Exactly zero |
| Structural conformance | XML, ID, link, manifest, spine, container, metadata, and structural accessibility failures. | Exactly zero |
| Reproducibility | XHTML or EPUB byte mismatch between the two runs for the same exact input/profile/runtime lane. | Exactly zero |
| Publication-ready | Valid, conforming EPUB or a complete accessible source-preserved fallback with recovery `ready`; expected review refusals are not ready. | At least 95% overall |
| Category-ready | Publication-ready among eligible documents for a category. | At least 90% for each unsuppressed category |
| Ambiguity safety | Ambiguous/unresolved cases preserve content without a false target; correct review refusal is allowed. | 100% |
| Semantic coverage | Fraction rendered semantically rather than by safe source-preserved fallback. | Reported aggregate; non-regression target, never traded against safety |

The public neutral suite has stricter binary gates: every positive case passes,
every negative case has its exact expected error class, every structural check
has zero violations, every golden is exact, and three same-input builds produce
identical XHTML and EPUB bytes. Bounds use N-1/N/N+1 vectors without allocating
unbounded payloads.

The numeric private thresholds above are the initial protocol. They may be
changed after a development baseline only by committing a new protocol version
before holdout access. They cannot be relaxed after a holdout result.

## Evidence and review

### Public Struct evidence

- exact clean commit and packed artifact digest;
- package/type/build/test/source-boundary results;
- fixture provenance and privacy-boundary scan;
- category coverage manifest;
- exact XHTML/XML/golden and archive-structure results;
- deterministic reruns on the supported Node lanes;
- mutation, bounds, structural accessibility, link, ID, and XML results.

### Owner-private Ernie.SG evidence

- source access/license ledger and frozen split;
- exact bridge and Struct artifact identities;
- per-document source-to-Struct conservation and source comparison;
- private rendered artifacts and validator details;
- sanitizer input/output audit;
- development or holdout aggregate receipt;
- pinned EPUBCheck/Ace and reader/browser evidence where required for release.

### Required reviews

1. **Privacy/license review** confirms every public case is independently
   synthetic, every tracked file is allowed, and no generated diff contains
   private material.
2. **Ownership review** confirms Struct has no acquisition/reconstruction/UI
   dependency and Ernie.SG retains the bridge and private runner.
3. **Determinism/testability review** checks pure inputs, exact versions,
   machine-verifiable assertions, negative cases, bounds, and golden update
   discipline.
4. **Accessibility/EPUB review** checks that deterministic structural tests are
   meaningful without misrepresenting them as release approval.

## Success definition

The design is implemented when the public neutral suite covers every required
category with reviewed synthetic fixtures and exact goldens, all public binary
gates pass from a clean packed artifact, the Ernie.SG private bridge can run
without persisting or logging source-derived data in Struct, the development
aggregate meets the frozen thresholds, and one untouched holdout version meets
the same precommitted gates in a single qualifying transaction.

A passing public suite alone is not private-corpus evidence. A passing private
aggregate alone is not permission to publish source material or release an
application. Registry publication, application deployment, and public route
activation remain separate authorization gates.

## Non-goals

- importing, parsing, OCRing, or reconstructing PDFs in Struct;
- committing a representative private document, crop, screenshot, EPUB, or
  source-derived minimized case;
- visual pixel matching or fixed-page facsimile output;
- moving browser upload, recovery copy, editorial approval, or release state
  into Struct;
- treating a safe fallback as verified semantics;
- publishing private aggregate evidence by default;
- changing the current schema or renderer while producing this plan.
