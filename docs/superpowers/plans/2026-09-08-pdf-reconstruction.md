# PDF reconstruction implementation plan

**Goal:** Repair every supplied PDF's applicable reader failures and establish source-grounded fidelity for every unique input and both device profiles.

**Architecture:** PDF extraction, normalization, recovery, and source validation remain in `adapters/pdf`. The Struct package remains source-neutral. The coordinator owns adapter build hooks, evaluator changes, integration and external writes; independent workers own disjoint reconstruction methods and tests.

**Tech stack:** Docling 2.126.0 / docling-core 2.95.0, Python 3.12, Poppler, TypeScript/Node, EPUBCheck 5.3.0. Verified starting revision: `568d550fb4479e55045a74886ca7eb1569ca5330`.

## Acceptance and constraints

- Preserve the original private archive; new private evidence belongs in ignored `out/reconstruction`.
- 113 supplied inputs represent 111 distinct PDF hashes. The historical holdout has already been used for tuning.
- No reduced thresholds, suppressed diagnostics, filename rules, dropped meaningful content, or full-page images substituting for reflowable content.
- Source-backed captions/crops, semantic tables/equations/code/styles, linked notes/URIs, coherent text flow, accounted furniture, valid usable Paper Pro and Paper Pro Move EPUBs.
- Evaluator corrections require separate source evidence and independent review; report their effect separately.
- Require exact input/cache/image binding, unique stems, distinct profiles, empty renderer errors, direct checker exit codes for every EPUB, manifests, per-paper changes/regressions, source visual/semantic checks, and repeat determinism.
- Do not commit private source material or large artifacts. No publication, service deployment or outreach is in scope.

## Dependency graph and ownership

1. **Coordinator:** preserve Git state, create isolated branch at verified baseline, inventory immutable evidence, prepare bound cache copies, capture baseline pilot. Own shared hooks and exact integrated validation.
2. **Inventory lane:** extract all source/hash/status/diagnostic/path records and duplicate groups without changing code.
3. **Tables lane:** repair table interpretation/recovery/ownership and semantic grid construction; dedicated `test_table_recovery.py`.
4. **Figures lane:** repair caption/crop/panel geometry and linked picture children; dedicated helpers and `test_figure_recovery.py`.
5. **Notes/links lane:** recover source markers and URI annotations, preserve appropriate note/reference classifications; dedicated tests.
6. **Prose/furniture lane:** separate merged float text/notes, rejoin attested prose, exclude actual source furniture; dedicated tests.
7. **Source raster lane:** deterministic original-PDF page images for crops; fail closed on rendering errors. Coordinator integrates provider into adapter and CLI owner passes it in production.
8. **Verification tooling lane:** fail-closed CLI and independent corpus verifier; validate malformed evidence and direct checker failures.
9. **Fidelity audit lane:** independently compare pilot source pages and semantic output, expose blind spots, define per-paper census before full corpus review.

## Pilot, integration, and review loop

- [x] Start from verified baseline with clean isolated branch and archived source untouched.
- [x] Build inventory and independent lane ownership.
- [ ] Run source-bound baseline and repaired 5-input pilot: `2408.10903v5`, `2609.03933v1`, `2609.04198v1`, `2508.03474v1`, `spark2022_paper_2`.
- [ ] Add failing fixtures based on source defects, implement general repairs, run focused tests and source comparisons in each lane.
- [ ] Snapshot each coherent fix with base SHA and diff/artifact hashes; fresh independent reviewer inspects actual changes and runs proportionate checks. Assign actionable fixes and repeat fresh review after material changes.
- [ ] Integrate at one immutable source snapshot. Run package tests, adapter tests, build/typecheck, source-boundary and packed-consumer validation.
- [ ] Convert all inputs in a fixed documented environment, verify every EPUB directly, compare every paper and investigate regressions.
- [ ] Inspect every unique input for source text/object accounting and both device layouts; resolve hidden defects rather than infer fidelity from the scorecard.
- [ ] Repeat final conversion for determinism, preserve code/env/input/cache/output manifests, and obtain independent exact-revision review with no actionable findings.
- [ ] Deliver usable EPUB index and exact evidence. If anything remains unresolved, retain precise source evidence and continue all solvable work; never call an approximation complete.
