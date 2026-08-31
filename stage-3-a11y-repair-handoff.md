# Stage 3 accessibility repair handoff

Status: repair complete; fresh independent review requested.

Baseline: `48a66d26cb3e3c22eadfd25163fd9937feed88d7`.

## P1 repair

Renderer ingress now performs one shared accessibility-label preflight after
strict snapshot/decode normalization and before either XHTML or EPUB output.
It rejects:

- a document title whose NFKC-normalized value contains only Unicode whitespace;
- any heading whose NFKC-normalized text contains only Unicode whitespace.

The check is validation-only. It does not trim, normalize, translate, replace,
or otherwise rewrite accepted labels, so multilingual and RTL text remains
exactly source-neutral. Rejections use fixed, content-free messages:

- `STRUCT_PUBLICATION_TITLE_EMPTY`
- `STRUCT_PUBLICATION_HEADING_LABEL_EMPTY`

Title validation runs first, followed by headings in canonical block-array
order. Neither failure includes title text, heading text, source metadata, or a
document-derived identifier.

## TDD evidence

The focused tests were added before production code. Their initial run failed
in all four new rejection cases while the 104 pre-existing cases passed. After
the shared preflight was added, the same file passed 108/108.

Coverage includes empty and Unicode-whitespace-only titles and headings through
both direct `renderPublicationXhtml` and `buildStructEpub` entry paths. A
positive mixed Arabic/Japanese title and Arabic heading verifies exact XHTML
and reopened EPUB preservation under an RTL document direction.

## Scope and privacy

Production behavior changed only in internal renderer ingress. Tests changed
only in the existing renderer boundary suite. This handoff and `final.md` are
the only documentation additions. There is no schema, table contract, golden,
fixture manifest, public export, package manifest, or API manifest change.

No private corpus was opened or modified. No remote, PR, issue, push, publish,
or other-worktree operation was performed. The tracked-file privacy guard and
source ownership boundary both pass.

## Verification

- Red-first focused run: 4 expected failures; 104 existing tests passed.
- `npx vitest run tests/codec-rendering.test.ts`: 108/108 passed.
- Focused public/navigation boundary run: 9/9 passed.
- `npm run test:layout-boundary`: privacy scan passed; 26/26 passed.
- `npm run typecheck`: passed.
- `npm run test:source-boundary`: passed.
- Default-timeout `npm test`: 469/470 passed; the sole result was the existing,
  unchanged 5-second timeout in the 1 MiB canonical `Uint8Array` copy test.
- The unchanged timeout case passed alone at the normal timeout in 4.94 seconds.
- Full non-boundary suite with the repository-documented 10-second allowance:
  470/470 passed.
- `npm run build`: passed.
- `npm run test:package`: passed, including its clean rebuild.
- `git diff --check`: passed.
- Exact changed-file inventory and privacy/content-free-error review: passed.

## Fresh review request

Please review the current clean local HEAD independently against the Stage 3 P1
finding. In particular, confirm that both renderer entry paths fail before
output, the fixed errors contain no document content, accepted Unicode/RTL
labels are preserved exactly, and the change remains internal and
source-neutral.
