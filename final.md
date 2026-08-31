# Stage 6 metadata, malformed-input, and bounds final

The Stage 6 local slice is complete on the accepted Stage 5 head
`c1ab3cad272c1e158487172883a8843b682a4ea0`.

EPUB metadata now preserves the exact neutral title/subtitle policy, ordered
authors, language, abstract/description, publication date, and canonical UTC
modified time. Identifier linkage, navigation naming, language propagation,
ID/ARIA closure, image alternatives, and omission of unsupported accessibility
claims are explicit synthetic invariants.

Publication identity and default output naming no longer depend on the raw
source filename. The embedded source token and receipt are sanitized and
verifiable, and filename-only input changes produce identical EPUB bytes while
semantic changes still alter identity.

Malformed options, document values, packaged XHTML/XML, links, IDs, receipts,
and fixed-resource collisions now fail closed with stable content-free
classes. Shared byte, table, XML element/depth, stylesheet, and archive limits
have synthetic N-1/N/N+1 coverage, including hostile preflight controls. No
partial publication is returned after failure.

Red-first, focused, boundary, type, source-boundary, privacy, full-suite,
build, packed-package, diff, receipt, and content evidence is recorded in
`stage-6-handoff.md`. No schema field, package API, dependency, protocol,
golden, or private/source artifact changed.

Fresh independent review of the clean local Stage 6 commit is requested. One
mistyped `npx vititest` verification attempted an npm-registry lookup, failed
with 404, installed nothing, and changed no repository file. No Git remote,
PR, issue, push, publish, other-checkout, or private-corpus action was taken.
