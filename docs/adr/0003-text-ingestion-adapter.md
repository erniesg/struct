# ADR-0003: Tracked text ingestion is a repository reference adapter

- Status: accepted by owner request, 2026-10-12
- Builds on ADR-0002 and the existing source-neutral Struct package contract

## Decision

Host a reference text ingestion adapter and CLI under `adapters/text/`. The
adapter consumes built public document/receipt/renderers modules and remains
outside the package files and export map. It owns physical-line segmentation,
source offsets, cleanup policy, external CLI transport, local artifacts and
reports. The package gains only optional source-neutral publisher metadata and
OPF date/publisher emission. The existing schema/source format stays unchanged.

Default ingestion preserves exact text. A source-bound replayable cleanup
ledger marks lines kept, furniture or unresolved; nothing is deleted from the
semantic graph. Pending review uses the existing recovery gate to prevent EPUB
output. Human plans remain local decisions; model plans carry digest-bound
consultation and actual classification decisions. Integrity cannot prove their
editorial correctness or provider authenticity.

Optional model judgment uses explicit `--judge codex|claude`, original-byte
inspection, structured classification, bounded argv subprocesses, disabled
model tools, selected-engine environment forwarding and isolated working
directories. Authentication remains with the host's installed CLI. No provider,
secret provisioning, VM deployment or model transport is added to package sources.
Model-originated sources are marked non-local; deterministic replay needs no
provider call. Invalid/incomplete judgment fails without heuristic fallback.

The two user-supplied articles are regressions via committed source digests,
metadata, non-expressive line selections and cleanup plans. Full source text and
outputs stay in ignored private/local storage. Always-run synthetic tests cover
source fidelity, cleanup/recovery and fake-provider failure/lifecycle cases.

Output folders use native atomic no-replace publication through a Python 3
standard-library helper (macOS/Linux). Complete files are staged privately;
intervening destinations are preserved and public rollback deletion is avoided.
The ingestion API remains Node-only.
