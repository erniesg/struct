# Stage 1.2 semantic-kind repair handoff

Status: complete.

This local repair keeps the layout EPUB evaluator source-neutral and confined to
test helpers. `assertSemanticLinks` now classifies each semantic reference as
exactly one accepted kind and requires its local target to have exactly one
compatible kind. Valid `role`/`epub:type` pairings and duplicate-ID rejection
remain unchanged.

Synthetic coverage rejects a mixed `biblioref`/`noteref` reference and mixed
`bibliography`/`footnote` or `bibliography`/`endnote` targets. All assertion
failures remain closed to the synthetic case ID and assertion name.

Verification passed:

- `npx vitest run tests/layout-eval/epub-package.test.ts`
- `npm run test:layout-boundary`
- `npm run typecheck`
- `npm run test:source-boundary`
- `npm run build`
- `npm run test:package`
- `git diff --check`
- `node scripts/check-layout-eval-boundary.mjs`
