# Stage 6 metadata, malformed-input, and bounds handoff

Status: implementation complete; fresh independent review requested.

Accepted baseline: `c1ab3cad272c1e158487172883a8843b682a4ea0`.

## Scope and boundaries

This local slice closes the two remaining Stage 2.1 metadata gaps, `META-01`
and `META-02`, and the assigned malformed/bounds renderer-validation gaps. The
production diff is confined to the existing document codec and XHTML/EPUB
renderer internals. Synthetic assertions are confined to the existing metadata,
malformed/bounds, and EPUB-integrity test files.

No schema field or wire shape was needed, so no schema proposal is required.
No package entrypoint, public type, API manifest, dependency, evaluation
protocol, fixture manifest, or golden changed. No source document, raw input,
private corpus, source-derived fixture, per-document result, or binary artifact
was opened or added.

## META-01: exact metadata and accessibility invariants

- OPF metadata now emits one linked publication identifier, the main title and
  its `title-type` refinement, optional subtitle and refinement, language,
  authors in neutral array order, optional abstract as description, optional
  publication date, and deterministic modified time in one exact order.
- Empty optional subtitle/abstract values and absent optional dates/authors are
  omitted rather than replaced. The explicit artifact timestamp is normalized
  to UTC seconds; the neutral updated date and fixed epoch are the deterministic
  fallbacks.
- XML escaping is asserted for titles, author names, and optional metadata.
  Content XHTML, navigation XHTML, and OPF language agree; the OPF
  `unique-identifier` resolves exactly once; navigation retains the exact title
  as its accessible name; emitted IDs and ARIA links remain closed; rendered
  images retain a nonempty neutral alternative. No unsupported accessibility
  claim is invented.
- Fixed OPF metadata IDs are reserved from asset IDs, preventing a manifest
  resource from shadowing title or identifier metadata.

## META-02: source-independent publication identity

- Publication identity uses the canonical receipt input with only the raw
  source filename replaced by the fixed neutral token `source`. The EPUB
  identifier, default output name, embedded `struct.json`, archive bytes, and
  archive digest therefore remain identical when only a valid input source
  filename changes.
- The embedded receipt is resealed against the sanitized source metadata and
  remains verifiable. Synthetic assertions cover current-schema identity and
  receipt integrity plus legacy `0.1.0` embedded-receipt compatibility.
- A semantic metadata change still changes the identifier and default output
  name. Explicit profile identity remains an explicit input to the existing
  identifier and filename policy.

## Malformed input and exact bounds

- Direct XHTML options and EPUB profile options are now closed plain data
  objects. Unknown fields, accessors, unsafe prototypes, invalid CSS scalars,
  and over-limit stylesheet values fail without invoking getters or returning
  output.
- Codec and invariant failures no longer copy invalid enum/schema values,
  duplicate IDs, dangling IDs, author names, page-side values, or target values
  into messages. Snapshot and direct decode paths now classify non-finite
  numbers consistently. Renderer mappings use fixed content-free error codes.
- Packaged XHTML is bounded before archive construction by fatal UTF-8 decode,
  the shared text-byte ceiling, the existing rendered-segment node ceiling,
  and a fixed nesting ceiling. It rejects malformed XML, duplicate IDs,
  internal/entity-bearing or external doctypes, other declarations, unsafe
  internal queries/percent ambiguity/Unicode whitespace, unsafe schemes,
  credentials, noncanonical external URLs, and dangling `href`, namespaced
  `href`, or `src` references.
- The XML parser is pinned to the same explicit nesting ceiling as lexical
  preflight, so dependency defaults cannot reject an accepted boundary or leak
  dependency error text.
- Generated container/OPF XML is checked before archiving. Fixed OPF/resource
  IDs and hrefs cannot be shadowed, and every packaged XHTML resource
  participates in the same ID/reference graph.
- N-1/N/N+1 assertions cover table dimensions, direct stylesheet bytes,
  packaged-XHTML bytes/elements/depth, and final archive bytes. Hostile
  over-dimension table storage and option accessors are not read after the
  preflight rejection point. No valid boundary value is silently truncated.

## Red-first evidence

The initial synthetic Stage 6 additions failed in the expected places before
production changes: three metadata/identity cases and nine malformed/bounds
cases exposed omitted optional OPF metadata, noncanonical timestamps,
source-filename identity coupling, inconsistent number classification,
content-bearing failures, option accessor reads, missing XHTML preflight, and
missing exact resource ceilings.

Focused review then produced additional red regressions before each follow-up
repair: fixed OPF title-ID shadowing was accepted; an external `SYSTEM` doctype
was archived; an over-limit XHTML element graph was archived; the dependency's
implicit nesting ceiling rejected an accepted boundary with its own message;
and percent-ambiguous/Unicode-whitespace internal references used the dangling
rather than unsafe error class. Each now fails or succeeds at its declared
boundary with a fixed content-free result. The legacy receipt assertion was a
passing preservation control and required no compatibility widening.

## Verification

- Focused metadata, malformed/bounds, package-graph, EPUB-integrity, and
  renderer suite: 5 files, 227/227 tests passed.
- Malformed/bounds plus codec, receipt, renderer, and EPUB-integrity suite:
  5 files, 320/320 tests passed.
- `npm run typecheck`: passed.
- `npm run test:source-boundary`: passed.
- `npm run test:layout-boundary`: privacy guard passed; 26/26 tests passed.
- Full non-boundary suite with the repository-documented 10-second allowance:
  17 files, 513/513 tests passed.
- Default-timeout `npm test`: boundary 26/26 passed; non-boundary 512/513
  passed, with only the existing unchanged 5-second timeout in the 1 MiB
  canonical `Uint8Array` copy test.
- That unchanged case passed alone at its normal timeout in 4.73 seconds.
- `npm run build`: passed.
- `npm run test:package`: passed, including a clean rebuild and packed consumer
  install.
- Final staged file inventory, `git diff --check`, source/privacy boundary,
  ownership grep, public-API review, and content-free failure review passed
  before the local commit.

## Fresh review request

Please independently verify exact OPF metadata order/refinements and omission
policy; UTC date normalization; source-filename-independent identifier, output
name, embedded receipt, and archive bytes; language/title/identifier and
structural accessibility closure; fixed-ID shadow prevention; strict option
snapshots; fixed content-free malformed errors; XHTML declaration/link/ID
preflight; and N-1/N/N+1 behavior without partial publication output.

Please also confirm that no schema/API/golden change was introduced and that
the diff contains only invented synthetic values. One mistyped verification
command, `npx vititest`, attempted an npm-registry lookup and failed with 404;
it installed nothing and changed no repository file. No Git remote, PR, issue,
push, publish, other-checkout, or private-corpus action was performed.
