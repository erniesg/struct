# Stage 2.1 renderer baseline characterization handoff

Status: characterization implemented; production unchanged.

Baseline: `b26f1512de451be410b017ec18a2e5fd4ccf2e63`, including the accepted
Stage 1.2 semantic-kind repair.

The Stage 2.1 tests use only the declared synthetic fixture builders. Every
render or refusal case exercises the decoder,
`normalizeStructDocumentForRenderer`, `renderPublicationXhtml`, and
`buildStructEpub`. Successful EPUBs are reopened and inspected with the
independent XML, archive, and closed semantic assertion helpers. No golden was
added and no production source was changed.

## Category baseline

| Category | Current landed behavior characterized |
| --- | --- |
| paragraph | Exact text, whitespace, inline emphasis, superscript segmentation, safe links, escaping, and EPUB-reopened XHTML are stable; malformed ranges reject at all boundaries. |
| hierarchy | Validated heading tags and sequence are stable; current EPUB navigation remains flat. |
| tables | Sparse holes, spans, coordinate order, and header scope survive; current tables have no accessible name and non-verified semantics are not distinguished in markup. |
| figures | Figure and caption blocks remain visible; matched caption relationships are retained in the graph but ignored by markup, and empty alternative text is currently publishable. |
| citations | Matched references link; current bibliography target roles do not satisfy the accepted semantic-kind helper, and grouped fallbacks can create focusable hidden links. |
| notes | Matched footnotes have compatible references and backlinks; endnote targets currently retain the footnote ARIA role. |
| multicolumn | Page/column evidence survives normalization while canonical block-array order renders once with no visual column recreation. |
| rtl | Content language/direction and repeated bytes are stable; nav/spine propagation and profile agreement are incomplete. |
| navigation | One target-resolving TOC and a valid spine are emitted; it is unnamed, flat, and includes current renderer-authored/title furniture. |
| assets | Digest-bound bytes, `img src`, OPF manifest conservation, ZIP order, compression class, timestamps, and duplicate protection pass. |
| metadata | XHTML title/subtitle/authors and core OPF fields are stable; optional publication fields are omitted and publication identity still depends on the neutral source file-name field. |
| malformed | The valid control renders and the unknown-field mutation rejects with one stable codec class at all boundaries. |
| bounds | The bounded sparse table is not truncated and the over-limit proxy rejects before cell-storage access at all boundaries. |
| ambiguity | Candidate facts survive decode/normalization, but ambiguous, unresolved, and source-preserved semantic runs currently follow inline candidate targets. |

## Reviewer-facing remaining-gap checklist

Each gap is assigned to exactly one frozen category and one primary intended
implementation file. The listed assertion is the red contract checkpoint; it
must not be committed as green while the baseline behavior remains unchanged.

- [ ] `HIER-01` — **hierarchy** — nest heading navigation by the specified
      stack rule without placeholder nodes. Red assertion:
      `nests EPUB navigation with the heading stack`. Intended file:
      `src/renderers/navigation-plan.ts` (new internal module).
- [ ] `TABLE-01` — **tables** — expose an accessible name for a verified table
      from an existing nonempty neutral label/text. Red assertion:
      `names verified tables from neutral content`. Intended file:
      `src/renderers/xhtml.ts`.
- [ ] `TABLE-02` — **tables** — distinguish a complete publishable
      source-preserved fallback from retained but incomplete table content.
      This is a schema stop, not a renderer assertion. Intended file after
      approval: `src/document/types.ts`; see the separate schema proposal.
- [ ] `FIG-01` — **figures** — express a matched neutral caption association in
      figure markup. Red assertion: `keeps a matched caption with its figure`.
      Intended file: `src/renderers/xhtml.ts`.
- [ ] `FIG-02` — **figures** — refuse image publication when both neutral label
      and text are empty. Red assertion: `refuses an unlabeled figure image`.
      Intended file: `src/renderers/xhtml.ts`.
- [ ] `CITE-01` — **citations** — pair matched citation references with exactly
      one accepted bibliography target kind. Red assertion:
      `pairs citation references with bibliography targets`. Intended file:
      `src/renderers/xhtml.ts`.
- [ ] `CITE-02` — **citations** — remove focusable visually hidden grouped
      citation links while conserving proven targets. Red assertion:
      `has no focusable hidden grouped citation links`. Intended file:
      `src/renderers/xhtml-plan.ts`.
- [ ] `NOTE-01` — **notes** — emit the compatible endnote target role rather
      than `doc-footnote`. Red assertion: `uses the endnote target role`.
      Intended file: `src/renderers/xhtml.ts`.
- [ ] `RTL-01` — **rtl** — propagate language/direction to nav and derive
      unprofiled OPF spine progression from the document. Red assertion:
      `propagates RTL through nav and spine`. Intended file:
      `src/renderers/epub.ts`.
- [ ] `RTL-02` — **rtl** — reject a profile direction that contradicts known
      document direction. Red assertion: `rejects a contradictory RTL profile`.
      Intended file: `src/renderers/epub.ts`.
- [ ] `NAV-01` — **navigation** — emit a named heading-only TOC without the
      publication-title item or unbound renderer-authored heading. Red
      assertion: `uses one named heading-only toc`. Intended file:
      `src/renderers/epub.ts`.
- [ ] `META-01` — **metadata** — package the defined subtitle,
      abstract/description, and publication-date policy instead of omitting
      those neutral fields. Red assertion: `packages optional publication
      metadata`. Intended file: `src/renderers/epub.ts`.
- [ ] `META-02` — **metadata** — remove source file-name influence from EPUB
      identifier, output name, and archive bytes while retaining receipt
      integrity. Red assertion: `keeps publication identity independent of
      source file name`. Intended file: `src/renderers/epub.ts`.
- [ ] `AMB-01` — **ambiguity** — preserve non-matched candidate facts without
      converting inline candidate IDs into links or semantic assertions. Red
      assertion: `does not link non-matched semantic candidates`. Intended
      file: `src/renderers/xhtml-plan.ts`.

## Schema stop

[`Struct table accessible-fallback schema proposal`](docs/superpowers/specs/2026-08-31-struct-table-accessible-fallback-schema-proposal.md)
defines the smallest proposed neutral declaration for `TABLE-02`. No renderer
fallback behavior is authorized until that proposal and a schema-version plan
are reviewed.

## Verification

Green checkpoint evidence:

- focused six-file Stage 2.1 characterization: 6 files, 39 tests passed;
- prescribed codec-fixture/rendering/EPUB-integrity/layout command: 12 files,
  321 tests passed;
- `tests/codec-layout-receipts.test.ts`: 37 tests passed;
- `npm run typecheck`: passed;
- `npm run test:source-boundary`: passed;
- `npm run test:layout-boundary`: boundary scan passed and 26 tests passed;
- staged `git diff --check`: passed.

A supplemental default-timeout run of all `tests/codec.test.ts` cases reached
106 passing assertions and timed out only on the existing 1 MiB canonical-byte
copy test at 5 seconds. That exact test passed alone under the normal timeout;
the complete file passed 107/107 with a 10-second runner timeout. Stage 2.1
does not change the accepted test or timeout policy.

Any local red contract checkpoint remains uncommitted with its exact failing
assertion names reported separately.
