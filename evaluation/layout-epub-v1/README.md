# Source-neutral EPUB layout evaluation protocol v1

This directory defines the Stage 0.1 public protocol boundary. It does not
contain a corpus, fixtures, rendered publications, per-document results, or a
private aggregate report, and it does not establish that the full evaluation
has passed.

`protocol.json` freezes the category and outcome enums, independent version
axes, formulas, initial gates, reporting bounds, two-run determinism rule, and
development/holdout access states. `aggregate-report.schema.json` defines the
only aggregate report shape. The schema uses the JSON Schema 2020-12
vocabulary; every object is closed with `additionalProperties: false`.

## Source-neutral boundary

The protocol begins after an owner-private bridge has produced a neutral
`StructDocument`. Struct receives no acquisition input and stores no private
document, source comparison, reconstruction evidence, or rendered private
artifact. Private bridge and cohort versions remain independent semantic
version axes; no private identifier or manifest is recorded here.

The aggregate allowlist contains only closed enum values, six semantic version
axes, the exact public `@erniesg/struct` package identity, booleans when a later
schema explicitly declares them, bounded non-negative integer counters, and
rates derived from those counters. `gitCommit` and `packedArtifactSha256`
identify only the public Struct artifact. They must never be populated with a
private source or rendered-output digest.

Reports cannot carry document arrays or rows, arbitrary metadata, diagnostic
messages, text, geometry, locations, filenames, links, run times, or source and
output digests. Unknown fields fail validation at every object boundary. Full
aggregate receipts remain owner-private by default and are not committed to
this repository.

## Rates, gates, and suppression

The trusted private aggregator owns integer counters and computes each rate as
its declared numerator divided by its declared denominator, rounded half up to
six decimal places. A report consumer must apply both the JSON schema and the
formula table in `protocol.json`; an incoming rate is never trusted or used to
reconstruct a counter. Only the trusted aggregator may add a recomputed rate to
its final receipt. A numerator greater than its denominator, a denominator of
zero, or a rate inconsistent with the counters is invalid.

The initial gates are:

- assigned completion, neutral conservation, and ambiguity safety: exactly
  `1`;
- publication-ready overall: at least `0.95`;
- category-ready for every reported category: at least `0.9`;
- every safety, conformance, privacy, bounds, and reproducibility counter:
  exactly `0`;
- semantic coverage: reported only and never traded against safety.

A category is reportable only when its denominator is at least five. Below
that population its cell is exactly `{ "status": "suppressed" }`; numerator,
denominator, and rate are omitted, not set to null or zero. Zero-tolerance
counters are always present and can never be suppressed.

## Development and holdout state

Development reports may use `development-open` or `frozen` protocol state and
may represent repeated qualifying transactions. A holdout report is valid only
for a frozen protocol and exactly one qualifying transaction. That transaction
runs the exact artifact twice per input to measure determinism. An
infrastructure retry is outside the qualifying count only when it produced no
semantic counters.

After any holdout result is observed, the owner-private protocol/cohort record
is closed. Result-informed changes require a new development epoch and a newly
frozen, untouched holdout version; the observed holdout is not queried again.
