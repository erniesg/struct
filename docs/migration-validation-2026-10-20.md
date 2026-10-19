# Migration validation — 2026-10-20

Status: **package remains private and unreleased**. The Bundle surface is
**incomplete** (`./bundle` is still unavailable pending S-03), so **E03 remains
blocked**. Nothing in this validation changes that gate.

Base: `fae461e9` (`fix: validate MathML fragments before publication rendering
(#31)`). Only `tests/codec.test.ts` changed; no runtime codec, canonical,
recovery, external, or global Vitest configuration was modified.

## Defect

On the immutable base, `npm test` failed 1/325. The failing test was
`STRUCT runtime codec > copies a large canonical Uint8Array without
materializing numeric keys or descriptors`, which timed out at the default
5000 ms. The same failure reproduced with a serial `maxWorkers=1` run. Running
the test alone with a 30 s timeout passed but took ~4.67 s.

### Root cause (confirmed)

`parseBytes` is fast; the assertion matcher was the cost. In Vitest 4.1.10,
`toBe` calls `Object.is`, and when that is false it **eagerly runs deep
equality** (`toStrictEqual`/`toEqual` paths) to decide what failure explanation
to build — even for a passing `.not.toBe(...)` assertion. With two equal 1 MiB
`Uint8Array` values this deep-compares roughly a million elements per matcher
path. (See `@vitest/expect@4.1.10` `def("toBe")`.)

Instrumented targeted run on the unmodified semantics:

```text
PROBE parseBytes=0.807ms matcher=4873.497ms
✓ copies a large canonical Uint8Array ... 4877ms
```

This matches the reported ~0.85 ms `parseBytes(1 MiB)` measurement and proves
the fixture and runtime codec were not the bottleneck.

## Change

In `tests/codec.test.ts` only:

- Replaced `expect(snapshot).not.toBe(bytes)` with
  `expect(Object.is(snapshot, bytes)).toBe(false)`, a direct boolean reference
  comparison that cannot trigger typed-array deep comparison.
- Kept the `Reflect.ownKeys` / `Object.getOwnPropertyDescriptor` monkeypatch
  protections for `bytes` intact.
- Kept endpoint assertions and added a length assertion.
- Added mutation isolation: mutating `bytes[0]` must not change
  `snapshot[0]`, and mutating `snapshot[snapshot.length - 1]` must not change
  `bytes[bytes.length - 1]`, proving the snapshot owns independent storage.

No timeout was raised, the 1 MiB fixture was not shrunk, and no numeric
enumeration protection was weakened.

## Results

| Check | Command | Result |
| --- | --- | --- |
| Targeted (before fix) | `npx vitest run tests/codec.test.ts -t "copies a large canonical Uint8Array"` | timed out at 5000 ms (5979 ms) |
| Targeted (instrumented) | same, `--testTimeout=30000` | passed; parseBytes 0.807 ms, matcher 4873.497 ms |
| Targeted (after fix) | same, default 5 s timeout | passed in **3 ms** (suite tests 9 ms) |
| Full suite | `npm test` | **325 passed / 325**, 9 files, 10.49 s |
| Typecheck | `npm run typecheck` | passed, 3.26 s |
| Source boundary | `npm run test:source-boundary` | passed, 0.19 s |
| Packed consumer | `npm run test:package` | passed, 8.87 s (build + packed consumer) |

Logs are under `/home/ubuntu/.local/state/struct-migration/20261020/`:
`baseline-targeted.log`, `probe-instrumented.log`, `targeted-after-fix.log`,
`package-test.log`, `package-typecheck.log`, `package-source-boundary.log`,
`package-test-package.log`, and `package-fix.md`.

The packed-consumer check proves the artifact builds and installs; it does not
complete the Bundle surface or authorize a release.
