# S04 release matrix — document compatibility and renderer repeatability (2026-10-20)

Status: **bounded S04 evidence only** (superseded by the current runtime
baseline `7db63613d22c0faba63cd65cc1c4e247b615d491`; original `049f96a` claims
preserved below). This document records the *document*
compatibility matrix and the *renderer repeatability* baselines implemented in
this lane. It does **not** claim a release, does not authorize publication, and
does not complete S-04.

The package remains private `0.0.0`. `./bundle` is still unavailable pending
S-03 at the original `049f96a` base, so the Bundle negative matrix is **not**
covered here. No application golden was regenerated or modified.

- Baseline source commit: `049f96ae6a8303dc0e00b92527da8df68f29fbd5`
  (`fix: reject standalone compiled test and source debris`)
- This lane changed **no** `src/**` file, no script, no manifest, no lockfile,
  and no public-consumer fixture. The frozen renderer baselines are therefore
  generated from exactly the runtime that ships in the commit above.

## Owned artifacts

| Path | Purpose |
| --- | --- |
| `tests/fixtures/s04/documents.ts` | Hand-built STRUCT fixtures (legacy/current/unsupported, typography, assets+links, reading order). |
| `tests/compatibility-release-matrix.test.ts` | Legacy/current/unsupported document compatibility matrix. |
| `tests/renderer-repeatability.test.ts` | Three-independent-run XHTML bytes and normalized EPUB entry content-hash repeatability against frozen baselines. |
| `docs/s04-release-matrix-2026-10-20.md` | This record. |

## Compatibility matrix

The matrix is keyed by the published version constants
(`LEGACY_STRUCT_SCHEMA_VERSION`, `STRUCT_SCHEMA_VERSION`) so a future Bundle
schema axis can reuse it unchanged.

| Declared version | `decodeStructDocument` | `decodeCompatibleStructDocument` | `migrateStructDocument` (deprecated alias) | XHTML renderer | EPUB builder |
| --- | --- | --- | --- | --- | --- |
| `0.1.0` (legacy) | accepted at declared version | accepted at declared version | accepted at declared version | accepted | accepted |
| `0.2.0` (current) | accepted at declared version | accepted at declared version | accepted at declared version | accepted | accepted |
| `0.3.0`, `1.0.0`, `0.2.1`, `0.2` (number), `null`, `" 0.2.0"` | rejected | rejected | rejected | rejected | rejected |

Unsupported input fails closed with `StructCodecError`
`code: "SCHEMA_VERSION"`, `path: "$.schemaVersion"`. The EPUB builder surfaces
the same rejection as `STRUCT_RECEIPT_BINDING_MISMATCH` (its documented
renderer-ingress mapping for `SCHEMA_VERSION`); the XHTML renderer propagates
the `StructCodecError` itself.

Two additional fail-closed cases are asserted:

- a legacy `0.1.0` document whose receipt declares `0.2.0` is rejected;
- a current `0.2.0` document whose `receipt.generatedSha256` does not match its
  content is rejected.

### Declared-version invariants

- No decode path transforms a document. `decodeCompatibleStructDocument` and
  the deprecated `migrateStructDocument` alias both return the document at its
  **declared** version; neither upgrades `0.1.0` to `0.2.0`.
- For equal semantics, the legacy and current documents render **byte-identical
  XHTML** (the schema version is not part of the XHTML artifact).
- The packaged EPUB artifacts **differ** between legacy and current, because
  the EPUB identifier and `EPUB/struct.json` bind the declared schema version
  and the version-specific semantic receipt digest. This is asserted, so a
  future change that silently drops the version binding from the EPUB would
  fail this suite.

## Renderer repeatability

### Method

Three independent runs per representative case. Each run:

1. resets the module registry (`vi.resetModules()`) and re-imports the
   renderers, so the run executes against a freshly loaded module graph;
2. rebuilds the input document from the fixture (never reuses a previous run's
   document object);
3. renders XHTML and builds the EPUB.

Runs are sequential so their module resets cannot interleave.

Frozen expectations are compared on three digests:

- `xhtmlSha256` — SHA-256 over the UTF-8 bytes of the rendered XHTML document.
- `epubContentSha256` — the **normalized** EPUB content hash. The ZIP
  container (compression, entry order, local headers) is not part of the
  artifact contract, so the normalized form hashes archive *content* only:
  every entry name sorted by byte order, paired with the SHA-256 of the entry
  bytes, joined by U+0000 inside a line and LF between lines.
- `epubArchiveSha256` — SHA-256 over the raw EPUB archive bytes.

### Representative cases

| Case | What it exercises |
| --- | --- |
| `typography` | Heading levels, bold/italic/superscript/subscript runs, a bibliographic citation relationship with a footnote target, blockquote, ordered list grouping, code block, footnote aside. |
| `assets-links` | A packaged figure asset (digest-bound bytes), an internal cross-reference link, an external `https` link, a caption and a figure caption. |
| `order` | Reading order across declared left/right/span columns plus an attached diagnostic, proving emitted block order follows the declared block array. |

### Frozen baselines

| Case | `xhtmlSha256` | `epubContentSha256` | `epubArchiveSha256` |
| --- | --- | --- | --- |
| `typography` | `dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30` | `4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67` | `8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908` |
| `assets-links` | `01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa` | `e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365` | `3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f` |
| `order` | `36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b` | `6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289` | `2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839` |

### Baseline provenance and anti-self-equality guards

The frozen literals are **not** copied from renderer output at test time, and
the assertions are not pure self-equality:

- Every fixture is hand-built from the published document contract. Receipt
  counts, conservation counts, and the semantic digest are derived from the
  constructed arrays by `finalizeS04Document` using the package's own digest
  primitives; no value is read back from a rendered artifact.
- The frozen digests were produced **once**, at commit
  `049f96ae6a8303dc0e00b92527da8df68f29fbd5`, and stored as literals in
  `tests/renderer-repeatability.test.ts`.
- They were independently re-verified on the VM with tools outside the
  package's own hashing code:

  ```sh
  sha256sum /tmp/opencode/s04-typography.xhtml \
            /tmp/opencode/s04-assets-links.xhtml \
            /tmp/opencode/s04-order.xhtml
  # dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30
  # 01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa
  # 36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b
  ```

  ```python
  # Python 3 zipfile + hashlib over the emitted EPUB archives
  hashlib.sha256("\n".join(
      name + "\x00" + hashlib.sha256(z.read(name)).hexdigest()
      for name in sorted(z.namelist())
  ).encode()).hexdigest()
  # 4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67
  # e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365
  # 6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289
  ```

- The suite additionally asserts the *meaningful* rendered markup (typography
  elements, packaged asset entry, both link kinds, emitted block order) so a
  digest match alone cannot carry the case.
- A digest change is renderer drift. The literals and this document must be
  updated **together in a reviewed change**; they must never be refreshed
  silently to make a red suite green.

## Validation performed in this lane

| Check | Command | Result |
| --- | --- | --- |
| Focused S04 suites | `./node_modules/.bin/vitest run tests/renderer-repeatability.test.ts tests/compatibility-release-matrix.test.ts` | 21 passed / 21, 2 files |
| Typecheck | `npm run typecheck` | see report |
| Full suite | `npm test` | see report |
| Source boundary | `npm run test:source-boundary` | see report |

## Remaining S-04 gaps (not closed by this lane)

1. **Bundle negative matrix through public exports.** Requires the `./bundle`
   export, which did not exist at the original `049f96a` base until S-03
   completed. Not attempted.
2. **Clean packed-consumer proof and tarball digest.** Owned by a separate
   lane; the packed-consumer script, export map, and API manifest were not
   edited here.
3. **Every documented root/subpath import and declaration resolving, and every
   private path failing.** Same separate lane; not re-implemented here.
4. **Release decision packet.** Requires the exact tarball digest, export/API
   manifest, and the remaining checks from the lanes above. No release, no
   prerelease publication, and no rollback authorization is claimed.
5. **Golden breadth.** This lane freezes three representative cases. A wider
   corpus (MathML equations, RTL/base-direction documents, multi-page and
   multi-column layouts, packaged XHTML assets, profiled EPUB exports) is not
   frozen yet and should be added before the release decision packet.
6. **Cross-runtime vectors.** RFC 8785 canonical bytes and cross-runtime
   `0.1`/`0.2` and N-1/N/N+1 vectors belong to the S-03 canonicalization
   contract, not to this lane.

## Rollback constraints

- The frozen digests are the renderer contract for this package revision.
  Reverting a renderer change must restore the matching digests; the frozen
  literals cannot be edited to match a regression.
- The compatibility matrix asserts that no decode path silently migrates a
  document. Any future migration implementation must be a **new** API with its
  own receipt, not a change to `decodeCompatibleStructDocument`.
- The package stays private `0.0.0` until an explicit, separately authorized
  publication decision.

## Supersession (2026-10-20 continuation)

The original claim that `./bundle` is unavailable (`"pending S-03"`) is
superseded at the current runtime baseline
`7db63613d22c0faba63cd65cc1c4e247b615d491`: the embedded `./bundle` export
exists with all seven runtime names. The isolated resolver/executor protocol
and its execution driver are implemented privately in-tree but are not public
surface; the public external-bytes decode seam and the real-host conformance
harness remain separately pending, so the full S-04 bundle negative matrix and
the three-run goldens for external payloads remain gated, but the embedded
surface covered by this lane (renderer repeatability, compatibility matrix)
remains valid and unchanged.
