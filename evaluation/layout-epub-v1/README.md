# Source-neutral EPUB layout evaluation protocol v1

This directory defines the Stage 0.1 public protocol boundary. It does not
contain a corpus, fixtures, rendered publications, per-document results, or a
private aggregate report, and it does not establish that the full evaluation
has passed.

`protocol.json` freezes the category and outcome enums, independent version
axes, formulas, initial gates, reporting bounds, two-run determinism rule, and
development/holdout access states. `aggregate-report.schema.json` defines the
only aggregate report shape. The schema uses the JSON Schema 2020-12
vocabulary, declares that dialect with `$schema`, and is compiled by the pinned
Ajv 2020 validator in `tests/layout-eval/aggregate-acceptance.ts`. Every object
is closed with `additionalProperties: false`. That test-boundary module is the
required executable acceptance rule; it is not a package export or shipped
package file.

## Source-neutral boundary

The protocol begins after an owner-private bridge has produced a neutral
`StructDocument`. Struct receives no acquisition input and stores no private
document, source comparison, reconstruction evidence, or rendered private
artifact. Private bridge and cohort versions remain independent semantic
version axes; no private identifier or manifest is recorded here.

The aggregate allowlist contains only closed enum values, six version axes,
the exact public `@erniesg/struct` package identity, booleans when a later
schema explicitly declares them, bounded non-negative integer counters, and
rates derived from those counters. Every version string follows the SemVer 2.0
grammar with a 64-character bound; prerelease and build identifiers are
allowed, while leading zeroes in numeric core or numeric prerelease identifiers
are not. `gitCommit` and `packedArtifactSha256` identify only the public Struct
artifact. They must never be populated with a private source or rendered-output
digest.

Reports cannot carry document arrays or rows, arbitrary metadata, diagnostic
messages, text, geometry, locations, filenames, links, run times, or source and
output digests. Unknown fields fail validation at every object boundary. Full
aggregate receipts remain owner-private by default and are not committed to
this repository.

## Rates, gates, and suppression

The trusted private aggregator owns integer counters and computes each rate as
its declared numerator divided by its declared denominator, rounded half up to
six decimal places. A consumer must call the required executable acceptance
rule, which first validates the actual report with the actual Draft 2020-12
schema and then applies the formula table in `protocol.json`. Schema validation
alone is not acceptance because JSON Schema does not express these sibling
arithmetic and stateful rules. An incoming rate is never trusted or used to
reconstruct a counter. A numerator greater than its denominator, a denominator
of zero, or a rate inconsistent with the counters is rejected. Thresholds are
applied to the exact counter ratio before the six-place display rounding.

The initial gates are:

- assigned completion, neutral conservation, and ambiguity safety: exactly
  `1`;
- publication-ready overall: at least `0.95`;
- category-ready for every reported category: at least `0.9`;
- every safety, conformance, privacy, bounds, and reproducibility counter:
  exactly `0`;
- semantic coverage: reported only and never traded against safety.

A category is reportable only when its denominator is at least five. Before
public emission, the acceptance rule requires an injected, owner-private map of
pre-suppression category populations. A reported denominator must equal that
trusted population. A population below five requires exactly
`{ "status": "suppressed" }`; a population of five or more makes suppression
ineligible. Suppressed numerator, denominator, and rate values stay private and
are omitted, not set to null or zero. Zero-tolerance counters are always present
and every one must equal zero; they can never be suppressed.

## Development and holdout state

The report's `evaluation` object carries only the content-free gate label. It
never carries protocol state, a transaction count, a state identifier, a
receipt, or other authorization evidence. The committed protocol is
`development-open`, so its schema admits only development reports and its
required acceptance rule rejects every holdout report, regardless of fields a
caller might attempt to self-attest.

A future frozen protocol and report-schema version may admit the holdout gate
only through an injected trusted-state adapter owned outside Struct. Before any
holdout input is opened, the owner atomically freezes a private record binding
the exact frozen protocol artifact and state, all six version axes, the exact
public artifact, and the allowed transaction count. The aggregator must then
invoke one atomic consult-and-consume operation against that record before
opening input. A match consumes the one allowed claim and yields an in-memory
authorization bound to those source-neutral axes; a second otherwise identical
claim is rejected. That authorization is matched once again before public
emission and cannot be reused.

Neither the private state implementation nor durable storage is implemented in
Struct. No state identifier, private digest, timestamp, location, source
information, or authorization value is serialized into a Struct report. An
infrastructure retry remains outside the qualifying count only when it produced
no semantic counters. After any holdout result is observed, the owner-private
protocol/cohort record is closed. Result-informed changes require a new
development epoch and a newly frozen, untouched holdout version; the observed
holdout is not queried again.
