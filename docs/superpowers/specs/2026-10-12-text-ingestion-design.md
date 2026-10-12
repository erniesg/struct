# Text ingestion and tracked cleanup

The user's goal is a reusable text ingestion adapter and CLI in Struct, with tracked cleanup, the two supplied essays as regression examples, and optional Codex/Claude Code judgment suitable for running on a VM.

## Boundary and selected approach

Add `adapters/text/` as a repository reference adapter, parallel to `adapters/pdf/`, consuming built public Struct paths. Keep provider execution, editorial choices, source acquisition and filesystem operations outside `src/`. Compare three approaches: unconditional heuristic deletion loses narrative; model rewriting loses source fidelity; source-bound classification preserves evidence and allows deterministic replay. Use the third. No rewrite/normalization operations in this version: keep exact prose, including paste artifacts. Existing one-off corrections are not silently generalized.

## Source and cleanup contract

`ingestText(sourceBytes, {fileName, metadata, cleanupPlan?})` returns `{document, report}`. UTF-8 is strict; maximum input 1 MiB. Split into nonblank physical lines with stable IDs `line-N`. Preserve each line exactly (without its line ending), retain UTF-16 start/end offsets and one-based line numbers in adapter reports/block attributes; preserve a UTF-8 BOM as U+FEFF. Empty lines and line terminators are separately reported as structural whitespace; raw bytes, SHA-256 and byte length remain authoritative. Metadata is supplied explicitly; do not guess author/title from arbitrary prose. Source format stays `unknown` until the core gains a versioned text format. No invented page geometry.

A version-1 cleanup plan has `schemaVersion`, `sourceSha256`, `actor` (`human`, `codex`, `claude`), `decisions` (each: `blockId`, `action` = `keep|remove|review`, `reason`). `consultation` stores prompt hash and model label and is required for model actors. Reject unknown fields, stale hashes, unknown or duplicate IDs, invalid actions and empty reasons. Unmentioned blocks remain kept. `remove` means retained verbatim as furniture with an explicit-paratext evidence signal (no invented positional band), never discarded from the Struct graph. `review` remains visible and sets recovery to review-required; EPUB production refuses it. No automatic lexical advertisement or duplicate-sentence deletion. Human plans are local decisions, not authentication evidence. Struct receipts bind model consultations and the actual decisions/actor to source and semantic digest; report carries all human and model decisions. Model plans mark source.localOnly false. Subprocesses receive only runtime/certificate/proxy and selected-engine authentication variables, not arbitrary parent environment or cross-engine credentials.

## Model judgment

A standalone bounded transport receives the original source bytes and derives a source-bound inspection internally with line IDs and exact text plus surrounding context. Callers cannot substitute judged text under a claimed source hash. Its prompt treats article text as untrusted data and requests classification only, including uncertain review decisions. Codex/Claude run only on explicit `--judge`, with existing CLI authentication, no provisioning or VM deployment. Run from an isolated temporary directory, use structured output, disable tools where the CLI supports it, disable inherited customizations/MCP, and never invoke a shell. Bound source, stdout/stderr, result file, process duration and child teardown. Validate the complete returned ID coverage and source digest. Invalid response, refusal, timeout or process error fails without rendering; there is no heuristic fallback. Save accepted plan for replay. Source text is sent to the chosen CLI/service only on explicit judgment invocation; integrity cannot prove judgment correctness.

## CLI and artifacts

`node adapters/text/text2epub.mjs input.txt --out DIR --metadata metadata.json [--cleanup plan.json | --judge codex|claude] [--model NAME] [--timeout-ms N]`.

Plain ingestion runs without a model. Output: copied original `source.txt`, validated `document.struct.json`, `document.xhtml`, `document.epub`, `ingestion-report.json`, and applied `cleanup-plan.json` when supplied/generated. Create a new output directory only after validation/judgment/render success; refuse existing destination and never overwrite the source. Pending review saves source/Struct/report/plan, omits EPUB, and returns distinct exit code 2. Other errors return 1. Validation/judgment/render failures precede output creation. Publication I/O failure after directory reservation preserves the destination for inspection; no destructive rollback is attempted because a competing writer may have replaced its files or directory. A complete main-CLI export publishes ingestion-report.json last. Reports bind original source and artifact hashes, offsets, whitespace accounting and decisions. Stable artifact modification time defaults to epoch for deterministic replay.

## Publication metadata

Add optional source-neutral `publisher` to Struct metadata and emit existing `publicationDate` plus publisher into EPUB OPF using normal escaping. Validate through codecs. This removes one-off ZIP patching.

## Regression and validation

Always-run synthetic tests cover exact Unicode/CRLF text, empty/invalid/oversized input, metadata, source offsets/whitespace, sparse cleanup, stale/unknown/duplicate decisions, unresolved review, receipt integrity and deterministic EPUB output. Transport tests use fake local executables only: valid structured output, malformed/refused/nonzero, partial/duplicate/out-of-source IDs, timeout, oversized data, process cleanup and literal prompt handling. CLI tests cover artifact hashes, safe outputs, replay and review-only output. Keep full copyrighted inputs in ignored private example storage; commit source hashes, metadata, cleanup plans and non-expressive expected counts. A separate example regression command requires the two private inputs and verifies hashes before applying their recorded cleanup. Run the two examples locally for this task. Final independent integrated review, full test suite, build, typecheck, source-boundary and packed-consumer checks are required.

## Review rulings

- Derive judgment input from original bytes internally, rather than accept caller-asserted source hashes with arbitrary text.
- Preserve a public destination on publication failure, including partial artifacts, rather than delete files that another writer may have replaced. This makes failure inspectable and favors preservation over automatic cleanup.
- Pin/check the Codex capability inventory before sending source; supported CLI updates require a reviewed inventory update.
