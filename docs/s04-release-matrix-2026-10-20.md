# S04 release matrix — complete evidence (2026-10-20)

Status: **S-04 release-packet evidence for the measured tree recorded below.** This
document records the *document* compatibility matrix, the *renderer
repeatability* baselines, the *nine-subpath import matrix*, the *Bundle
acceptance/version matrix*, the *three-run renderer goldens* against the packed
artifact, the *retained tarball* with file list and digests, and the
*regenerability proof*. It does **not** claim a release, does not authorize
publication, and does not complete any cutover. The package remains private
`0.0.0`.

- Evidence source commit (measured tree): `a35582d04eb45d24585e0c667c92dc9e60a0efe1`
  (`test(release): give the packet test's build hook an explicit timeout`)
- This document is committed in a descendant of the measured tree. A document
  inside the repository can never name the commit that carries it (the commit id
  covers this file's own blob), so the binding "artifact digest -> exact clean
  source commit" is recorded **outside Git** in
  `/home/ubuntu/.local/state/struct-migration/20261020-continuation/retention-s04-final/release-proof-final.json`
  (`source.head`, `source.dirty`, `tarball.sha256`, `tarball.retainedPath`).
- Source tree clean at the start of the measurement: yes (the proof records
  `source.dirty: false`; the packed-consumer script asserts that the head and
  the dirty flag are unchanged across the run).
- Source tree clean at the finish of the measurement: yes (the proof records
  `source.dirty: false`). This document is added afterwards, in a descendant
  commit, and it is not part of the packed file set (`package.json` `files`
  lists only `dist` and the root documents), so committing it does not change
  the tarball digest.
- Installer used: `pnpm 12.8.1` (`pnpm install --ignore-scripts --offline --no-frozen-lockfile`)

## Owned artifacts (this lane)

| Path | Purpose |
| --- | --- |
| `tests/fixtures/s04/documents.ts` | Hand-built STRUCT fixtures (legacy/current/unsupported, typography, assets+links, reading order). |
| `tests/compatibility-release-matrix.test.ts` | Legacy/current/unsupported document compatibility matrix. |
| `tests/renderer-repeatability.test.ts` | Three-independent-run XHTML bytes and normalized EPUB entry content-hash repeatability against frozen baselines. |
| `tests/s04-release-packet.test.ts` | Nine-subpath import matrix, Bundle public API surface, tarball integrity, API manifest consistency, regenerability proof (recorded). |
| `scripts/s04-goldens-packed.mjs` | Standalone three-run renderer goldens against the installed packed artifact. |
| `scripts/build-release-packet.mjs` | Single-command packet builder (runs all verification steps). |
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
  `872d6a2efed87317e319f98b306344412163b882`
  (`test(release): freeze S04 compatibility matrix and renderer repeatability baselines`),
  and stored as literals in
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

## Nine-subpath import matrix (packed artifact)

Verified by `scripts/test-packed-consumer.mjs` and `tests/s04-release-packet.test.ts`
against the installed tarball `erniesg-struct-0.0.0.tgz`.

| Export path | Runtime import | Declaration file | Type-checks in consumer | Private path fails |
| --- | --- | --- | --- | --- |
| `.` | ✓ | ✓ `dist/index.d.ts` | ✓ | N/A |
| `./document` | ✓ | ✓ `dist/document/index.d.ts` | ✓ | N/A |
| `./identity` | ✓ | ✓ `dist/identity.d.ts` | ✓ | N/A |
| `./ordering` | ✓ | ✓ `dist/ordering.d.ts` | ✓ | N/A |
| `./receipt` | ✓ | ✓ `dist/receipt.d.ts` | ✓ | N/A |
| `./recovery` | ✓ | ✓ `dist/recovery.d.ts` | ✓ | N/A |
| `./renderers/xhtml` | ✓ | ✓ `dist/renderers/xhtml.d.ts` | ✓ | N/A |
| `./renderers/epub` | ✓ | ✓ `dist/renderers/epub.d.ts` | ✓ | N/A |
| `./bundle` | ✓ | ✓ `dist/bundle/index.d.ts` | ✓ | N/A |
| `./core` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./schema` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./ids` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./parsers` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./sha256` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./renderers` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./bundle/canonical` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./bundle/external` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./bundle/facade` | ✗ | N/A | N/A | ✓ `ERR_PACKAGE_PATH_NOT_EXPORTED` |

Root and `./document` exports are equivalent for shared symbols
(`decodeCompatibleStructDocument`, `decodeStructDocument`, `encodeStructDocument`,
`migrateStructDocument`, `LEGACY_STRUCT_SCHEMA_VERSION`, `STRUCT_SCHEMA_VERSION`,
`StructCodecError`).

## Bundle acceptance/version matrix (packed artifact)

Verified against the installed tarball by `tests/public-consumer/runtime.mjs` (run by
`scripts/test-packed-consumer.mjs`) and asserted by the committed test
`tests/s04-bundle-acceptance-packed.test.ts`.
Only the public `./bundle` surface is tested (private modules `./bundle/canonical`,
`./bundle/external`, etc. are not exported and correctly fail closed).

### Public API surface

| Export | Type | Verified |
| --- | --- | --- |
| `createStructBundle` | function | ✓ |
| `verifyStructBundle` | function | ✓ |
| `decodeStructBundle` | function | ✓ |
| `encodeStructBundle` | function | ✓ |
| `StructBundleError` | class (extends Error) | ✓ |
| `STRUCT_BUNDLE_LIMITS_PROFILE` | object (frozen) | ✓ |
| `STRUCT_BUNDLE_LIMITS_PROFILE_VERSION` | string | ✓ |

### STRUCT_BUNDLE_LIMITS_PROFILE structure

| Cap | Value | Type |
| --- | --- | --- |
| `maxRawBytes` | 8,388,608 | integer |
| `maxFieldBytes` | 5,600,000 | integer |
| `maxAssets` | 256 | integer |
| `maxAssetBytes` | 4,194,304 | integer |
| `maxTotalBytes` | 4,194,304 | integer |
| `maxDecodedBytes` | 4,194,304 | integer |
| `maxBase64Chars` | 5,592,408 | integer |
| `maxConcurrency` | 1 | integer |
| `maxDepth` | 128 | integer |
| `maxStringLength` | 5,592,408 | integer |
| `maxNodes` | 1,000,000 | integer |
| `maxResolverTimeoutMs` | 120,000 | integer |
| `profileVersion` | `"1.0.0"` | string |

All numeric caps are positive integers. `maxConcurrency` is 1 (sequential resolution).

### Version axis (via `verifyStructBundle` which accepts envelope objects)

| Check | Result |
| --- | --- |
| Accepts `bundleVersion: "1.0.0"` | ✓ |
| Rejects `bundleVersion: "2.0.0"` | ✓ (stage `canonical`, code `TYPE`) |
| Rejects non-string `bundleVersion` | ✓ (stage `canonical`, code `TYPE`) |
| Accepts `schemaVersion: "0.2.0"` | ✓ |
| Rejects `schemaVersion: "9.9.9"` | ✓ (stage `canonical`, code `TYPE`) |
| Rejects non-string `schemaVersion` | ✓ (stage `canonical`, code `TYPE`) |

### Error hygiene (`StructBundleError`)

- Real `Error` subclass, frozen, no `cause` property.
- Own properties: `code`, `message`, `name`, `stack`, `stage`.
- Does not leak caller-supplied values in message or JSON serialization.

### Payload guards and legal-payload checks

The package's payload guards hold in the packed artifact:
- Non-canonical base64 rejected (stage `assets`, code `BASE64`)
- Payload decoded length mismatch rejected (stage `assets`, code `BASE64`)
- Payload bytes vs. declared digest mismatch rejected (stage `assets`, code `DIGEST`)
- Oversized base64 payload rejected (stage `canonical`, code `LIMIT`) — the string
  cap (`maxStringLength` = `maxBase64Chars` = 5,592,408) is applied before the asset
  cap, so an oversized base64 string is refused at the canonical stage. The
  asset-stage `LIMIT` code is reachable through `maxAssetBytes` / `maxTotalBytes`
  / `maxAssets`, not through an oversized base64 string.

Note: This lane measures the **embedded** public path against the packed
artifact (the create -> encode -> decode round trip, the version axis, the
error hygiene and the payload guards). The **external-resolver** wire path (a
consumer-supplied executor, concurrency, budget expiry, cleanup) is exercised in
the source-tree suites (`bundle-public-matrix.test.ts`,
`bundle-public-negative-matrix.test.ts`, `bundle-public-decode-wiring.test.ts`,
`bundle-public-resolver-conformance.test.ts`), because the resolver harness and
the sacrificial OS host are not part of the packed artifact. **No external
resolver conformance is claimed by this lane.**

## Three-run renderer goldens (packed artifact)

Verified by `scripts/s04-goldens-packed.mjs` against the installed tarball.
Each variant rendered three independent times with fresh module loads.

### Per-run digests

| Variant | Run | `xhtmlSha256` | `epubContentSha256` | `epubArchiveSha256` |
| --- | --- | --- | --- | --- |
| `typography` | 1 | `dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30` | `4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67` | `8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908` |
| `typography` | 2 | `dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30` | `4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67` | `8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908` |
| `typography` | 3 | `dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30` | `4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67` | `8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908` |
| `assets-links` | 1 | `01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa` | `e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365` | `3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f` |
| `assets-links` | 2 | `01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa` | `e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365` | `3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f` |
| `assets-links` | 3 | `01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa` | `e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365` | `3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f` |
| `order` | 1 | `36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b` | `6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289` | `2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839` |
| `order` | 2 | `36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b` | `6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289` | `2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839` |
| `order` | 3 | `36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b` | `6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289` | `2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839` |

All three runs per variant produce byte-identical XHTML, identical normalized
EPUB content hashes, and identical EPUB archive hashes. All digests match the
frozen baselines exactly. No baseline was refreshed.

## Retained tarball

- **Filename**: `erniesg-struct-0.0.0.tgz`
- **SHA-256**: `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1`
- **Retained at**: `/home/ubuntu/.local/state/struct-migration/20261020-continuation/retention-s04-final/erniesg-struct-0.0.0.tgz` (outside the repository)
- **Re-hash verified**: yes (the retained copy digest equals the built tarball digest;
  the proof record carries `tarball.retainedDigestVerified: true`)
- **Bound to the final clean source commit**: see the proof record named at the top
  of this document

### File list (33 entries)

| Path | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `API.md` | 13579 | `23f168450ffb497efe8d3e528ea95dd90d6940bfe18afb293ec49c09e9c455db` |
| `API_MANIFEST.json` | 2132 | `0c548efcb62e92c2d8e2981c2023b696a62818025646df007ef0286c3c194afc` |
| `CONTRACT.md` | 11541 | `267f52b1ba624f64242d35754ba8a152c72579e6fe09e819f32b731b4dfb6ca3` |
| `LICENSE` | 1065 | `14bb0d08b9a59c5c025c2247c0c56da32840cade3af1935a27d49921aba75b76` |
| `MIGRATION.md` | 5746 | `4e6ebbd17a014d14476782c7b051499c1a0790d3e88d321b132a563d925a489c` |
| `NOTICE` | 131 | `8ec296d3437244761f79415f81424ab321445e342dbd8ec4c11776a7640ae21a` |
| `README.md` | 5200 | `f747b42b7cd4a0f2a71070e57356a29434f08607d340c540e80cf9e6ba4e2bfb` |
| `dist/bundle/index.d.ts` | 15024 | `7672c598ae3b0a70dbc89140033b503da9383f4c75baa46b17c6d4a0b7f723c2` |
| `dist/bundle/index.js` | 100443 | `4ef488568866f247fc3124903d4b0cdf427ded3a0636295e38011496b3989bd6` |
| `dist/chunk-7BBGSLQ3.js` | 21563 | `f1c07434b69652ed8178a924763dbae8ff21ec16509c05f7e51b5201a2643e0a` |
| `dist/chunk-JWLJY4O4.js` | 74823 | `90d1b4ebb1d937c0352a1d8628967624d52d3c96eddcee1e5574fde6ea759325` |
| `dist/chunk-QB5SP7CM.js` | 4724 | `0e765a454f6aeef9f1c60a1347e2d1c768e5b817089b918fb71eceac15110046` |
| `dist/chunk-UPOUJIFO.js` | 43580 | `c575fa161a5417c4ddc75c04329f32a03d1f89027247bc04d86f5b2506e6e988` |
| `dist/chunk-ZU6WU2FD.js` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `dist/document/index.d.ts` | 1102 | `af578c7cc53f34752314b708ecd155b896e03112d32881b066b0bb47ee4845f9` |
| `dist/document/index.js` | 519 | `58aa51dffbfee5981f8e1815999ab67f4e3cbf332cf2c191f1b7ebf672dd2111` |
| `dist/identity.d.ts` | 675 | `e654a08ba8bf351fe10aefcae67d4538a4291d334ae31e272c8be41838b439a3` |
| `dist/identity.js` | 279 | `e1f24ced0d5a5aba76a980d32157631fc4c39c9f21df12778a27b57412aea941` |
| `dist/index.d.ts` | 956 | `18d6602319732b3466b9f3ec06b0e8d5eef747dda6d8bc9c28aa8497e2f2b307` |
| `dist/index.js` | 515 | `506c0ad9ce52e0c1dae91aa66b6a0261ff73e8d183a6de3d4fae801db9198235` |
| `dist/ordering.d.ts` | 675 | `9508d9c31a25ee002c2476fd5817b54f3cb3e56c1996039083c3774881d19ad6` |
| `dist/ordering.js` | 1712 | `243609a292515c532cee9ed4e4adf67a97a43aadc4231f19c9300ab66b65a69b` |
| `dist/parsers-DEVCdXao.d.ts` | 1100 | `2fef0f3128528805209018541bf8389a83d8a55bfd05b6721ee156afe46e28a3` |
| `dist/receipt.d.ts` | 1103 | `8735ea0754084ca5c3ce2652e9ef3ad879cf011b5b815aa1bcbe82447f9ce1fc` |
| `dist/receipt.js` | 479 | `fe0975af925ea153bd266b4cb3ec058213f6b1bfaec08a3ce173c649a5b7b60f` |
| `dist/recovery.d.ts` | 1701 | `461436493bd3562654e0a7a6927af32ddda538dbe82716b545d119db3d7ebede` |
| `dist/recovery.js` | 4048 | `244a130e226e726982e648fa2cea6d6e082d6840ea09d10dad86a079aa7f1c1a` |
| `dist/renderers/epub.d.ts` | 1689 | `22cb8d09cb0a826ee6735b1c0b77fd2f474776f857611e51a1f207e4ed99c3d7` |
| `dist/renderers/epub.js` | 18322 | `3825abc00f0168a5624aff7bba4bd04c397fc99b65d40ba6b4f44ebf96031ff9` |
| `dist/renderers/xhtml.d.ts` | 387 | `0289516189ac4e832fb536596d639428765e6a86bca84aad43807d4f2eee900d` |
| `dist/renderers/xhtml.js` | 195 | `778b9020b2102ee29f810b7d4c4e7d3a3ef7d41a05975d524dd1c55eaee8c040` |
| `dist/types-DRghr3d6.d.ts` | 9065 | `ebc0e7999372bf95a1a472cabc66c443b027f96e3d073be0bbc838f6bd8d93f6` |
| `package.json` | 2215 | `4ee997b5c23619a7bacfed26c2c5079d406eed0c64d55b4f710b556cc2f82e91` |

Total: 33 files, 346288 bytes (uncompressed tarball size).

## Regenerability proof

Two independent `npm pack` runs at the same head produce byte-identical tarballs.

| Build | Tarball SHA-256 |
| --- | --- |
| 1 | `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1` |
| 2 | `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1` |
| **Match** | **yes** |

The packet is regenerable by a single documented command from a clean checkout:
```sh
git checkout a35582d04eb45d24585e0c667c92dc9e60a0efe1
npm run build
STRUCT_PACKED_CONSUMER_ARTIFACT_DIR=/path/to/outside node scripts/test-packed-consumer.mjs
node scripts/s04-goldens-packed.mjs  # in a consumer dir with the tarball
```

or, in one command, the whole packet (typecheck, build, source-boundary check,
full suite, packed-consumer verification, the S-04 packet tests, the three-run
goldens and the second-build regenerability check):

```sh
git checkout a35582d04eb45d24585e0c667c92dc9e60a0efe1
STRUCT_PACKED_CONSUMER_ARTIFACT_DIR=/path/to/outside node scripts/build-release-packet.mjs
```

## Validation performed (all commands, exit codes, counts)

| Check | Command | Exit code | Count |
| --- | --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | 0 | — |
| Source boundary | `node scripts/check-source-boundary.mjs` | 0 | — |
| Full test suite | `npx vitest run --maxWorkers=1` | 0 | 1003 passed, 35 files |
| S-04 packet tests | `npx vitest run --maxWorkers=1 tests/s04-release-packet.test.ts` | 0 | 11 passed |
| Packed consumer | `STRUCT_PACKED_CONSUMER_ARTIFACT_DIR=... node scripts/test-packed-consumer.mjs` | 0 | 9 exports, 33 files |
| Three-run goldens | `node scripts/s04-goldens-packed.mjs` (in consumer) | 0 | 3 variants × 3 runs |
| Regenerability | two `npm pack` runs | 0 | 2 builds, identical SHA-256 |
| `git diff --check` | `git diff --check` | 0 | — |

## What is NOT proven (no overclaim)

- **No release, no publication, no version bump, no cutover.** The package remains private `0.0.0`.
- **No application golden regenerated or modified.** The existing application (if any) is not repinned.
- **No S-03 overclaim.** The private resolver/executor protocol and its real-host conformance harness are not public surface.
- **No cross-runtime vectors.** RFC 8785 canonical bytes and cross-runtime `0.1`/`0.2` and N-1/N/N+1 vectors belong to the S-03 canonicalization contract.
- **No golden breadth beyond three representative cases.** MathML equations, RTL/base-direction documents, multi-page and multi-column layouts, packaged XHTML assets, profiled EPUB exports are not frozen.
- **No `decodeStructBundle` wire-path goldens for external payloads.** The canonical serializer and resolver harness are private; external decode repeatability is not frozen.
- **No merge, push, deploy, or external mutation.** This lane only produces retained evidence artifacts.

## Rollback constraints

- The frozen digests are the renderer contract for this package revision.
  Reverting a renderer change must restore the matching digests; the frozen
  literals cannot be edited to match a regression.
- The compatibility matrix asserts that no decode path silently migrates a
  document. Any future migration implementation must be a **new** API with its
  own receipt, not a change to `decodeCompatibleStructDocument`.
- The package stays private `0.0.0` until an explicit, separately authorized
  publication decision.
- The retained tarball and its digest are the source of truth for the artifact.
  Any future publication must use exactly this tarball.

## Coordinator verification checklist

The coordinator must still verify:

1. The measured tree `a35582d04eb45d24585e0c667c92dc9e60a0efe1` is an ancestor of the cutover candidate head.
2. The retained tarball at `/home/ubuntu/.local/state/struct-migration/20261020-continuation/retention-s04-final/erniesg-struct-0.0.0.tgz` has SHA-256 `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1`.
3. The file list matches the 33 entries recorded above.
4. The nine-subpath matrix passes (public exports work, types exist, private paths fail).
5. The Bundle public API surface exports all seven runtime names plus limits and error class.
6. The three-run goldens match the frozen baselines exactly (no drift).
7. The regenerability proof holds (two builds, identical tarball SHA-256 `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1`).
8. All validation commands exit 0 with the recorded counts.
9. No external mutations were made (`pushed: false`, `externalMutations: "none"`).