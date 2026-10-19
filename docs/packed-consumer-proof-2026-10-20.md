# Packed consumer proof — 2026-10-20

Status: **bounded S04 preparation only**. This proves the local packed artifact
and consumer surface. It does **not** implement Bundle, expose `./bundle`,
change the API manifest/export map, complete S03, run the full S04 matrix, or
authorize a release. The package remains `private` and `0.0.0`.

Diff base: `befe11c626dd142f896b7526cd16955c25c6e161`, recorded only as the
point this work started from. This document does not freeze a run-specific
source HEAD, proof digest, or dirty flag; those belong to the VM-local evidence
generated after the coordinator commit.

## Procedure

`npm run test:package` builds, then `scripts/test-packed-consumer.mjs` runs
`npm pack --json`, validates the pack file-list metadata, verifies packed
name/version, computes the tarball SHA256, installs the exact tarball into a
fresh temporary consumer, imports every available API path, checks unavailable
paths, typechecks the public declarations, and only then emits one compact JSON
proof line.

## Payload rules

- `package.json` must be packed.
- The fixed approved docs must be packed: `LICENSE`, `NOTICE`, `README.md`,
  `CONTRACT.md`, `API.md`, `MIGRATION.md`, `API_MANIFEST.json`.
- Every string target in `exports`, `main`, and `types` must be packed.
- `package.json#files` may declare only the approved docs and the `dist`
  directory; any other declaration fails closed rather than being trusted.
- `dist/**` may contain `.js`, `.d.ts`, and their `.map` variants, but
  recognizable test/spec/fixture/source debris is rejected, including standalone
  test/source basenames and
  `dist/*.test.*`, `dist/*.spec.*`, `dist/*.fixture.*`, and directories such
  as `__tests__`, `tests`, `fixtures`, `src`, or `source`.
- Missing docs/targets, unapproved declarations, unexpected top-level paths,
  and absolute/traversal/backslash/control-character paths fail closed.

No archive extraction or untrusted-archive parsing is used; `npm pack` metadata
is the trusted producer input.

## Installer policy

Selection is explicit and recorded as `installer: { name, version,
arguments }`.

- `STRUCT_PACKED_CONSUMER_INSTALLER=pnpm|npm` selects explicitly; any other
  value fails before packing. Otherwise pnpm is chosen when installed, falling
  back to real npm only when pnpm is not installed.
- pnpm: `install --ignore-scripts --offline --no-frozen-lockfile` (fresh temp
  consumer, no `pnpm exec`).
- npm: `install --ignore-scripts --no-audit --no-fund --offline` with
  `RUCKSACK_NPM_SHIM=passthrough` so the child install cannot be silently
  rewritten.

On the trusted VM, select pnpm explicitly:

```sh
STRUCT_PACKED_CONSUMER_INSTALLER=pnpm npm run test:package
```

The pnpm path is proven on this VM using the shared store. A real npm install
is **not** claimed as verified here; the npm fallback still uses `--offline`
and therefore needs a warm npm cache.

## Proof schema and acceptance

The proof line has `schemaVersion`, `package` (name/version), `exportPaths`,
`packedFiles`, `tarball` (filename/SHA256), `installer`
(name/version/arguments), and `source` (`head`, `dirty`). Git binding is
mandatory: if `git rev-parse`/`git status` cannot run, or HEAD/dirty state
changes during verification, the script aborts and emits no proof. Development runs may accurately report `dirty: true` and must
be labeled as development evidence. Acceptance evidence requires
`source.head` to equal the current producer HEAD and `source.dirty: false`,
generated after commit in the VM-local log/PR rather than embedded here.

Bundle implementation and `./bundle` stay unavailable; the full S04 matrix and
three-run goldens remain gated.
