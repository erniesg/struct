# Source provenance

This bootstrap branch is locally prepared from `erniesg/erniesg` source SHA
`485edb69e83179d4a8b15dfbd324f4b5f89dda44`, the landed app default head.
The app `src/struct` tree at that revision is
`9adfe1bc352f31ddb40e34f6137d7157ed7e6ab7`.

| App source | Package destination |
| --- | --- |
| `src/struct/types.ts` | `src/core/types.ts` |
| `src/struct/{sha256,ids,reading-order,recovery}.ts` | `src/core/` |
| `src/struct/{consultation-receipt,emitted-ids}.ts` | `src/core/` |
| `src/struct/codec/**` | `src/core/codec/**` |
| `src/struct/xhtml.ts` | `src/renderers/xhtml.ts` |
| `src/struct/epub.ts` | `src/renderers/epub.ts` |

No app adapter, PDF/DOCX implementation, UI, provider, deployment code, or
`model-consultation-receipt.ts` is included. The package begins as private and
has no publish workflow.

## Staged migration contract

The canonical owner of the portable document boundary is Struct. Ernie.SG owns
the source-specific acquisition, reconstruction, editorial, approval, release,
and source-to-Struct adapters. This provenance map records an extraction, not a
claim that Ernie.SG has already switched to this package.

Migration follows **expand, switch, contract**:

1. Freeze legacy/current/recoverable documents, receipts, IDs, renderer output,
   asset hashes, and source-specific application fixtures.
2. Make the private package releasable without publishing: explicit public
   surface, Bundle implementation and adversarial tests, declarations, packed
   tarball, and a clean consumer with no repository source-path access.
3. Expand Ernie.SG readers first using an exact package version and exact packed
   artifact pin. Retain legacy `0.1.0` and current `0.2.0` reads and compare
   frozen application behavior with package behavior.
4. Move consumer families without changing the writer: types/codecs, then
   IDs/ordering/recovery, then XHTML/EPUB. Keep source-specific adapters in
   Ernie.SG and run parity after each seam.
5. Establish durable publication state behind an inactive gate. Only a later,
   target-specific activation decision may switch one writer to a current
   schema; existing source data and revisions remain immutable.
6. Remove duplicate portable application code and generic tests last, only
   after static zero-import checks, parity, packed-consumer proof, and rollback
   evidence pass.

Do not combine writer switching, duplicate deletion, and package rollback in
one change. The compatibility horizon is through the last production consumer
of legacy `0.1.0` and current `0.2.0` records, plus the API alias window in
[API.md](./API.md). A package downgrade is refused whenever it cannot read
already-written durable records.

Rollback before activation is to retain the current application writer and
expanded readers; no source deletion occurs. After an authorized writer switch,
rollback must follow the recorded target-specific forward-recovery or rollback
constraints rather than silently downgrading incompatible records.

First-release evidence is an exact package version and tarball digest, declared
export map and compatibility matrix, source-boundary/type/build/test evidence,
a clean packed-consumer install proof, and recorded renderer/profile evidence
where relevant. Those gates establish an **implemented, unreleased** artifact;
they do not publish it. A **released** package additionally needs separately
authorized registry publication, install proof, immutable artifact digest, and
a release record.
