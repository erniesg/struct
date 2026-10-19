# Packed consumer proof — 2026-10-20

Status: **bounded S04 preparation only**. This improves the existing local
packed-consumer proof. It does **not** implement Bundle, expose `./bundle`,
change the API manifest/export map, complete S03, run the full S04 matrix, or
authorize a release. The package remains `private` and `0.0.0`.

Base/HEAD: `befe11c626dd142f896b7526cd16955c25c6e161` (no commit made).
The proof reports `source.dirty: true` because these changes are uncommitted.

## What changed

- `scripts/packed-payload.mjs` (new, focused helper): validates `npm pack`
  file-list metadata before any consumer install.
- `scripts/test-packed-consumer.mjs`: validates payload metadata, rejects
  package identity mismatch, computes the tarball SHA256, and prints one
  compact JSON proof line only after the runtime import and TypeScript
  declaration consumer checks pass.
- `tests/public-consumer/runtime.mjs`: derives imported paths and unavailable
  paths from the installed `API_MANIFEST.json`; compares installed
  `package.json` exports with the manifest so a future `./bundle` addition must
  be deliberate. Root alias, deprecated removal date, and private legacy-digest
  absence checks are retained.
- `tests/packed-payload.test.ts` (new): negative payload tests for missing
  legal docs, missing declared export targets, source/test/script/private
  debris, unsafe/absolute/traversal paths, unapproved `package.json#files`
  declarations, and an absent `package.json`.

## Payload rules

Accepted packed paths are only:

- `package.json`, which is required in the packed set;
- the fixed approved public docs (`LICENSE`, `NOTICE`, `README.md`,
  `CONTRACT.md`, `API.md`, `MIGRATION.md`, `API_MANIFEST.json`);
- `dist/**` implementation/chunk/declaration output ending in `.js`,
  `.d.ts`, or their `.map` variants.

`package.json#files` may name only those approved docs plus the `dist`
directory. A declaration is not treated as proof of public status: any other
declared path, such as `src/leak.ts`, `tests/leak.js`, `scripts/leak.mjs`, or
an unrelated private file, fails closed. A deliberate future public-doc
addition must update the explicit allowlist.

Validation fails closed for missing required docs or `package.json`, missing
`exports`/`main`/`types` targets, unapproved `package.json#files`
declarations, unexpected top-level or dist paths (for example `src/`,
`tests/`, `scripts/`, `.env*`, or `dist/*.ts`), and unsafe paths (absolute,
drive-qualified, backslash, traversal, empty segments, control characters).
No tarball extraction or untrusted-archive parsing is performed; `npm pack`
metadata is the trusted producer input.

## Proof output

Written to stdout after both consumer checks, preserved exactly in
`/home/ubuntu/.local/state/struct-migration/20261020/package-proof-package.log`:

```json
{"schemaVersion":"1.0.0","package":{"name":"@erniesg/struct","version":"0.0.0"},"exportPaths":[".","./document","./identity","./ordering","./receipt","./recovery","./renderers/xhtml","./renderers/epub"],"packedFiles":["API.md","API_MANIFEST.json","CONTRACT.md","LICENSE","MIGRATION.md","NOTICE","README.md","dist/chunk-7BBGSLQ3.js","dist/chunk-LLAOFHVY.js","dist/chunk-QB5SP7CM.js","dist/chunk-S4DIRYQY.js","dist/chunk-ZU6WU2FD.js","dist/document/index.d.ts","dist/document/index.js","dist/identity.d.ts","dist/identity.js","dist/index.d.ts","dist/index.js","dist/ordering.d.ts","dist/ordering.js","dist/receipt.d.ts","dist/receipt.js","dist/recovery.d.ts","dist/recovery.js","dist/renderers/epub.d.ts","dist/renderers/epub.js","dist/renderers/xhtml.d.ts","dist/renderers/xhtml.js","dist/types-J59yEqPh.d.ts","package.json"],"tarball":{"filename":"erniesg-struct-0.0.0.tgz","sha256":"512e806d4473bf24586edbed92e739e6c535ac78f4228fa11335803c523d85ac"},"source":{"head":"befe11c626dd142f896b7526cd16955c25c6e161","dirty":true}}
```

The proof contains no source contents, credentials, or publish/release claim.

## Red-first evidence

`package-proof-red.log` shows the new test file failing before the helper
existed: `Cannot find module '../scripts/packed-payload.mjs'`.
`package-proof-red-declaration-bypass.log` shows 5 failing tests before the
allowlist fix: four unapproved `package.json#files` declarations were accepted,
and an absent `package.json` was not rejected. After the fix, all 17 focused
payload tests pass.

## Results

| Check | Command | Result |
| --- | --- | --- |
| Full suite | `npm test` | 10 files, **342 passed** |
| Typecheck | `npm run typecheck` | pass |
| Source boundary | `npm run test:source-boundary` | pass |
| Packed consumer | `npm run test:package` | pass (build, payload proof, install, runtime import, declarations) |

Logs: `/home/ubuntu/.local/state/struct-migration/20261020/package-proof-*.log`.

## Remaining gates

Bundle implementation and `./bundle` stay unavailable; the full S04 matrix
and three-run goldens remain gated. This proof attests only to the packed
artifact's declared payload and local consumer checks at the recorded dirty
source state.
