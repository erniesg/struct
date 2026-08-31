# Stage 4 table, figure, caption, and asset renderer final

The Stage 4 local slice is complete on the accepted Stage 3 head
`1cc71f134fcb385ec5efe5a43dbd5d1d1cf12cb2`.

Verified tables now have exact neutral captions and retain declared header
scopes. Accepted schema `0.3.0` source-preserved table fallbacks render only as
named neutral block text; undeclared and unresolved table semantics fail
closed. Matched captions are associated without reordering canonical content,
ambiguous candidates remain unassociated, and image output requires explicit
image assets plus exact neutral alt content. EPUB integrity now covers local
`src` references and reports missing asset bytes without input content.

Red-first, focused, boundary, type, source-boundary, full-suite, build, packed
package, diff, and privacy evidence is recorded in `stage-4-handoff.md`. No
golden, schema/wire, public API, source document, or private corpus change was
made.

Fresh independent review of the current clean local HEAD is requested. No
remote, PR, issue, push, publish, or other-worktree action was taken.
