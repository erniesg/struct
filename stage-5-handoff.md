# Stage 5 citation, note, and ambiguity renderer handoff

Status: implementation complete; fresh independent review requested.

Accepted baseline: `abb8a0d4912a8afdb6d75f61e9d7608d3e38d0ed`.

## Scope and boundaries

This local slice implements only the four renderer gaps assigned by the Stage
2.1 map: `CITE-01`, `CITE-02`, `NOTE-01`, and `AMB-01`. Production changes are
confined to `src/renderers/xhtml.ts` and `src/renderers/xhtml-plan.ts`; the
synthetic contract change is confined to
`tests/layout-eval/citation-note-ambiguity.test.ts`.

No schema, codec wire shape, table behavior, golden, evaluation protocol,
package/API manifest, public export, dependency, or renderer profile changed.
No source document, raw input, private corpus, source-derived fixture, or
binary artifact was opened or added.

## Citation behavior

- A neutral block explicitly marked `bibliographyEntry` now emits the one
  accepted target pair, `epub:type="bibliography"` and
  `role="doc-bibliography"`. A matched citation reference retains
  `epub:type="biblioref"` and `role="doc-biblioref"`, preserves its exact
  visible marker, and resolves to that local target.
- Grouped numeric markers link only the exact visible ranges that map to the
  explicit relationship labels and targets. The relationship occurrence ID is
  emitted once.
- When a matched grouped citation cannot map every target to visible source
  marker text, the marker remains exact and the proven target IDs remain on
  the existing neutral `data-target-ids` relationship metadata. No hidden
  focusable link and no renderer-authored "Additional citation target" text is
  emitted.

## Note behavior

- Footnote targets retain the paired `footnote`/`doc-footnote` semantics.
  Endnote targets now emit the compatible `endnote`/`doc-endnote` pair.
- Inline and table-cell note references retain the exact visible label and the
  paired `noteref`/`doc-noteref` semantics. Author-note aliases and repeated
  proven references retain one stable relationship occurrence ID.
- Backlinks are emitted only for rendered matched note relationships. Each
  tested backlink resolves to the emitted occurrence and retains the closed
  nonempty label `Back to note reference`.

## Ambiguity safety

- Semantic target selection now reads targets only from a present `matched`
  relationship. Inline `targetIds` and retained candidates are never promoted
  for `ambiguous`, `unresolved`, or `source-preserved` relationships.
- A semantic run with no relationship remains visible as its exact source
  marker but emits no candidate link, semantic relationship wrapper,
  relationship occurrence ID, target metadata, or backlink.
- Candidate targets, confidence, and evidence remain unchanged through decode
  and renderer normalization. A matched relationship remains linked, and a
  plain explicit hyperlink with no semantic relationship remains governed by
  the existing safe URL policy.
- The emitted-ID plan now reserves a semantic relationship ID only when the
  matched semantic plan actually emits it, avoiding false ID assertions for
  neutral non-matched runs.

## Red-first evidence

Before either production file changed, the new focused Stage 5 file reported
8 expected failures and 5 passing preservation controls. The failures included
all four exact Stage 2.1 checkpoints:

- `pairs citation references with bibliography targets`
- `has no focusable hidden grouped citation links`
- `uses the endnote target role`
- `does not link non-matched semantic candidates`

The other red cases demonstrated ambiguous citation/note promotion and target
inference when a semantic relationship was absent. After the minimal renderer
changes, the focused Stage 5 plus renderer regression run passed 122/122.

## Verification

- Focused Stage 5 and adversarial codec-rendering suite: 2 files, 122/122
  tests passed.
- Citation/note, semantic package, accessibility, heading/navigation, EPUB
  integrity, and codec-rendering boundary: 7 files, 220/220 tests passed.
- `npm run typecheck`: passed.
- `npm run test:source-boundary`: passed.
- `npm run test:layout-boundary`: privacy scan passed; 26/26 tests passed.
- `npm run build`: passed.
- `npm run test:package`: passed, including a clean rebuild and packed
  consumer install.
- Default-timeout `npm test`: boundary 26/26 passed; non-boundary 484/485
  passed, with only the existing unchanged 5-second timeout in the 1 MiB
  canonical `Uint8Array` copy test.
- That unchanged timeout case passed alone under its normal timeout in 4.83
  seconds.
- Full non-boundary suite with the repository-documented 10-second allowance:
  485/485 tests passed.
- Final `git diff --check`, changed-file inventory, source/privacy boundary,
  and content review are rerun after handoff finalization and before commit.

## Fresh review request

Please independently confirm that only matched relationship targets can become
semantic links; opaque grouped citations retain explicit target metadata but
create no hidden focusable links or invented labels; bibliography and endnote
target kinds pair exactly with their references; note labels and backlinks are
nonempty and locally closed; and heading/navigation output remains unchanged.

No remote, PR, issue, push, publish, other-checkout, or private-corpus action
was performed.
