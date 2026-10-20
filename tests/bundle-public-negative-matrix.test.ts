/**
 * S-03 public Bundle fail-closed matrix.
 *
 * This file proves the error hygiene of the published `./bundle` surface:
 * for every public entry point and every reachable error stage of the frozen
 * taxonomy, a rejected call fails with a `StructBundleError` that carries a
 * static stage and code, returns no handle, and echoes no caller-supplied
 * identifier, path, byte, or digest.
 *
 * The cases are the negative half of the conformance matrix: the same
 * rejections the axis file pins for behaviour are pinned here for the shape
 * of the failure, so a stage can never start leaking caller input.
 */
import { describe, expect, it } from 'vitest'
import {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  StructBundleError,
  createStructBundle,
  decodeStructBundle,
  encodeStructBundle,
  verifyStructBundle,
} from '../src/bundle/index'
import type {
  StructBundleErrorCode,
  StructBundleErrorStage,
} from '../src/bundle/index'
import { canonicalJsonBytes } from '../src/bundle/canonical'
import { sha256HexSync } from '../src/sha256'
import {
  buildPublicMatrixBundle,
  createPublicMatrixResolverHarness,
  publicMatrixUtf8,
  sealPublicMatrixDocument,
} from './fixtures/bundle/public-matrix-fixtures'
import { httpsPolicy } from './fixtures/resolver/fake-host'

const profile = STRUCT_BUNDLE_LIMITS_PROFILE

/** The caller-supplied token that must never reach the error object. */
const MARKER = 's03-marker-4f19c2'

type NegativeCase = Readonly<{
  name: string
  entry: 'create' | 'verify' | 'decode' | 'encode'
  stage: StructBundleErrorStage
  code: StructBundleErrorCode
  /** The caller-supplied value that must not be echoed. */
  marker: string
  run: () => unknown
}>

/**
 * Runs one entry point and returns the failure it produced.
 *
 * A call that returns a value instead of failing is a test failure: no
 * entry point may publish a handle on a rejected input.
 */
async function capture(run: () => unknown): Promise<unknown> {
  let value: unknown
  try {
    value = run()
  } catch (error) {
    return error
  }
  if (value instanceof Promise) {
    try {
      await value
    } catch (error) {
      return error
    }
  }
  throw new Error('unexpected acceptance: a handle was returned')
}

/** Asserts that the failure carries only static facts. */
function expectStaticFailure(
  error: unknown,
  stage: StructBundleErrorStage,
  code: StructBundleErrorCode,
  marker: string,
): void {
  expect(error).toBeInstanceOf(StructBundleError)
  const failure = error as StructBundleError
  expect(failure.stage).toBe(stage)
  expect(failure.code).toBe(code)
  expect(failure.name).toBe('StructBundleError')
  expect(failure.message).not.toContain(marker)
  expect(JSON.stringify({
    name: failure.name,
    stage: failure.stage,
    code: failure.code,
    message: failure.message,
  })).not.toContain(marker)
  for (const key of Object.getOwnPropertyNames(failure)) {
    expect([
      'code', 'message', 'name', 'stack', 'stage',
    ]).toContain(key)
    expect(String((failure as unknown as Record<string, unknown>)[key]))
      .not.toContain(marker)
  }
  expect(Object.isFrozen(failure)).toBe(true)
  expect(Object.hasOwn(failure, 'cause')).toBe(false)
}

const oneByte = new Uint8Array([1])

/** A bundle whose asset identity carries the caller-supplied marker. */
function markedBundle(marker = MARKER) {
  return buildPublicMatrixBundle([
    { id: `asset-${marker}`, bytes: oneByte },
  ])
}

/** A bundle with one external asset whose identity carries the marker. */
function markedExternalBundle(marker = MARKER) {
  return buildPublicMatrixBundle([
    { id: `asset-${marker}`, bytes: oneByte, external: true },
  ])
}

/** Runs a public decode against a harness and releases the gated execution. */
function decodeWithHarness(
  canonical: Uint8Array,
  harness: ReturnType<typeof createPublicMatrixResolverHarness>,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const pending = decodeStructBundle(canonical, {
    resolverExecutor: harness.executor,
    resolverPolicy: httpsPolicy(),
    resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
    resolverHostSupervisor: {
      protocolVersion: '1.0.0',
      failStop: async () => ({}),
    } as never,
    ...overrides,
  })
  return harness.allocated.then(() => {
    harness.release()
    return pending
  })
}

const cases: NegativeCase[] = [
  {
    name: 'an unknown create option is refused',
    entry: 'create',
    stage: 'input',
    code: 'OPTIONS',
    marker: MARKER,
    run: () => createStructBundle(
      { document: markedBundle().document } as never,
      { resolverExecutor: {} } as never,
    ),
  },
  {
    name: 'a create input that is not a document is refused',
    entry: 'create',
    stage: 'input',
    code: 'TYPE',
    marker: MARKER,
    run: () => createStructBundle({
      document: { assets: [{ id: MARKER }] },
      extra: MARKER,
    } as never),
  },
  {
    name: 'an over-cap create document is refused',
    entry: 'create',
    stage: 'canonical',
    code: 'LIMIT',
    marker: MARKER,
    run: () => {
      const document = structuredClone(markedBundle().document) as Record<string, unknown>
      const metadata = document.metadata as Record<string, unknown>
      metadata.title = `${MARKER}${'a'.repeat(profile.maxStringLength)}`
      return createStructBundle({ document } as never)
    },
  },
  {
    name: 'an over-cap create asset is refused',
    entry: 'create',
    stage: 'assets',
    code: 'LIMIT',
    marker: MARKER,
    run: () => {
      const document = structuredClone(markedBundle().document) as Record<string, unknown>
      const assets = document.assets as Array<Record<string, unknown>>
      const bytes = new Uint8Array(profile.maxAssetBytes + 1)
      assets[0]!.bytes = bytes
      assets[0]!.sha256 = sha256HexSync(bytes)
      sealPublicMatrixDocument(document)
      return createStructBundle({ document } as never)
    },
  },
  {
    name: 'an unknown verify option is refused',
    entry: 'verify',
    stage: 'input',
    code: 'OPTIONS',
    marker: MARKER,
    run: () => verifyStructBundle(
      { id: MARKER },
      { resolverExecutor: {} } as never,
    ),
  },
  {
    name: 'a value that is not a bundle envelope is refused',
    entry: 'verify',
    stage: 'canonical',
    code: 'TYPE',
    marker: MARKER,
    run: () => verifyStructBundle({ id: MARKER, bytes: MARKER }),
  },
  {
    name: 'an over-cap verify value is refused',
    entry: 'verify',
    stage: 'canonical',
    code: 'LIMIT',
    marker: MARKER,
    run: () => verifyStructBundle({
      id: MARKER,
      text: `${MARKER}${'a'.repeat(profile.maxStringLength)}`,
    }),
  },
  {
    name: 'a verify value with an external payload is refused',
    entry: 'verify',
    stage: 'assets',
    code: 'UNRESOLVED',
    marker: MARKER,
    run: () => {
      const bundle = markedBundle()
      const envelope = JSON.parse(
        new TextDecoder().decode(bundle.canonical),
      ) as Record<string, unknown>
      const assets = envelope.assets as Array<Record<string, unknown>>
      assets[0]!.payload = {
        kind: 'external',
        resourceId: `sha256:${String(assets[0]!.sha256)}`,
      }
      return verifyStructBundle(envelope)
    },
  },
  {
    name: 'an unknown decode option is refused',
    entry: 'decode',
    stage: 'input',
    code: 'OPTIONS',
    marker: MARKER,
    run: () => decodeStructBundle(markedBundle().canonical, {
      resolverExecutor: { id: MARKER },
    } as never),
  },
  {
    name: 'a decode input that is not a byte view is refused',
    entry: 'decode',
    stage: 'input',
    code: 'TYPE',
    marker: MARKER,
    run: () => decodeStructBundle(MARKER as never),
  },
  {
    name: 'an over-cap decode input is refused',
    entry: 'decode',
    stage: 'input',
    code: 'LIMIT',
    marker: MARKER,
    run: () => decodeStructBundle(
      new Uint8Array(profile.maxRawBytes + 1).fill(0x41),
    ),
  },
  {
    name: 'a wrong expected bundle digest is refused',
    entry: 'decode',
    stage: 'digest',
    code: 'MISMATCH',
    marker: 'deadbeef'.repeat(8),
    run: () => decodeStructBundle(markedBundle().canonical, {
      expectedBundleSha256: 'deadbeef'.repeat(8),
    }),
  },
  {
    name: 'malformed decode bytes are refused',
    entry: 'decode',
    stage: 'canonical',
    code: 'SYNTAX',
    marker: MARKER,
    run: () => decodeStructBundle(publicMatrixUtf8(`{${MARKER}`)),
  },
  {
    name: 'non-canonical decode bytes are refused',
    entry: 'decode',
    stage: 'canonical',
    code: 'NONCANONICAL',
    marker: MARKER,
    run: () => decodeStructBundle(publicMatrixUtf8(
      JSON.stringify(
        JSON.parse(new TextDecoder().decode(markedBundle().canonical)),
        null,
        2,
      ),
    )),
  },
  {
    name: 'a wrong bundle version is refused',
    entry: 'decode',
    stage: 'canonical',
    code: 'TYPE',
    marker: MARKER,
    run: () => {
      const bundle = markedBundle()
      const envelope = JSON.parse(
        new TextDecoder().decode(bundle.canonical),
      ) as Record<string, unknown>
      envelope.bundleVersion = `9.9.9-${MARKER}`
      return decodeStructBundle(canonicalJsonBytes(envelope))
    },
  },
  {
    name: 'an over-cap decode field is refused',
    entry: 'decode',
    stage: 'canonical',
    code: 'LIMIT',
    marker: MARKER,
    run: () => decodeStructBundle(publicMatrixUtf8(
      `{"document":["${MARKER}${'a'.repeat(profile.maxFieldBytes)}"]}`,
    )),
  },
  {
    name: 'an asset set that differs from the document is refused',
    entry: 'decode',
    stage: 'assets',
    code: 'SET',
    marker: MARKER,
    run: () => {
      const bundle = buildPublicMatrixBundle(
        [
          { id: `asset-${MARKER}-1`, bytes: oneByte },
          { id: `asset-${MARKER}-2`, bytes: new Uint8Array([2]) },
        ],
        ({ records }) => { records.splice(1, 1) },
      )
      return decodeStructBundle(bundle.canonical)
    },
  },
  {
    name: 'an asset with a foreign media type is refused',
    entry: 'decode',
    stage: 'assets',
    code: 'METADATA',
    marker: MARKER,
    run: () => {
      const bundle = buildPublicMatrixBundle(
        [{ id: `asset-${MARKER}`, bytes: oneByte }],
        ({ records }) => {
          (records[0] as Record<string, unknown>).mediaType = `text/${MARKER}`
        },
      )
      return decodeStructBundle(bundle.canonical)
    },
  },
  {
    name: 'an asset with a non-canonical payload is refused',
    entry: 'decode',
    stage: 'assets',
    code: 'BASE64',
    marker: MARKER,
    run: () => {
      const bundle = buildPublicMatrixBundle(
        [{ id: `asset-${MARKER}`, bytes: oneByte }],
        ({ records }) => {
          (records[0] as Record<string, unknown>).payload = {
            kind: 'embedded',
            base64: MARKER.slice(0, 3),
          }
        },
      )
      return decodeStructBundle(bundle.canonical)
    },
  },
  {
    name: 'an asset whose bytes disagree with its digest is refused',
    entry: 'decode',
    stage: 'assets',
    code: 'DIGEST',
    marker: MARKER,
    run: () => {
      const bundle = buildPublicMatrixBundle(
        [{ id: `asset-${MARKER}`, bytes: oneByte }],
        ({ records }) => {
          (records[0] as Record<string, unknown>).payload = {
            kind: 'embedded',
            base64: 'Ag==',
          }
        },
      )
      return decodeStructBundle(bundle.canonical)
    },
  },
  {
    name: 'an over-cap asset is refused',
    entry: 'decode',
    stage: 'assets',
    code: 'LIMIT',
    marker: MARKER,
    run: () => {
      const bundle = buildPublicMatrixBundle(
        [{ id: `asset-${MARKER}`, bytes: oneByte }],
        ({ records }) => {
          (records[0] as Record<string, unknown>).byteLength =
            profile.maxAssetBytes + 1
        },
      )
      return decodeStructBundle(bundle.canonical)
    },
  },
  {
    name: 'an external payload without a resolver is refused',
    entry: 'decode',
    stage: 'assets',
    code: 'UNRESOLVED',
    marker: MARKER,
    run: () => decodeStructBundle(markedExternalBundle().canonical),
  },
  {
    name: 'an invalid resolver policy is refused',
    entry: 'decode',
    stage: 'resolve',
    code: 'POLICY',
    marker: MARKER,
    run: () => {
      const harness = createPublicMatrixResolverHarness()
      return decodeStructBundle(markedExternalBundle().canonical, {
        resolverExecutor: harness.executor,
        resolverPolicy: { profileId: MARKER } as never,
        resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
        resolverHostSupervisor: {
          protocolVersion: '1.0.0',
          failStop: async () => ({}),
        } as never,
      })
    },
  },
  {
    name: 'a transport receipt that does not bind the policy is refused',
    entry: 'decode',
    stage: 'resolve',
    code: 'RECEIPT',
    marker: MARKER,
    run: () => {
      const harness = createPublicMatrixResolverHarness({
        bytesByDigest: () => oneByte,
        receiptPolicySha256: 'a'.repeat(64),
      })
      return decodeWithHarness(markedExternalBundle().canonical, harness)
    },
  },
  {
    name: 'a resolved stream with the wrong length is refused',
    entry: 'decode',
    stage: 'resolve',
    code: 'LENGTH',
    marker: MARKER,
    run: () => {
      const harness = createPublicMatrixResolverHarness({
        bytesByDigest: () => new Uint8Array(0),
      })
      return decodeWithHarness(markedExternalBundle().canonical, harness)
    },
  },
  {
    name: 'a resolved stream with the wrong bytes is refused',
    entry: 'decode',
    stage: 'resolve',
    code: 'DIGEST',
    marker: MARKER,
    run: () => {
      const harness = createPublicMatrixResolverHarness({
        bytesByDigest: () => new Uint8Array([9]),
      })
      return decodeWithHarness(markedExternalBundle().canonical, harness)
    },
  },
  {
    name: 'an unusable resolver budget is refused',
    entry: 'decode',
    stage: 'budget',
    code: 'BUDGET',
    marker: MARKER,
    run: () => {
      const harness = createPublicMatrixResolverHarness()
      return decodeStructBundle(markedExternalBundle().canonical, {
        resolverExecutor: harness.executor,
        resolverPolicy: httpsPolicy(),
        resolverBudget: { totalTimeoutMs: 10, cleanupReserveMs: 10 },
        resolverHostSupervisor: {
          protocolVersion: '1.0.0',
          failStop: async () => ({}),
        } as never,
      })
    },
  },
  {
    name: 'a forged handle is refused',
    entry: 'encode',
    stage: 'handle',
    code: 'FORGED',
    marker: MARKER,
    run: () => encodeStructBundle({
      bundleVersion: '1.0.0',
      schemaVersion: MARKER,
      assetIds: () => [MARKER],
    }),
  },
]

describe('S-03 public fail-closed matrix', () => {
  for (const testCase of cases) {
    it(
      `${testCase.entry} fails closed with ${testCase.stage}/${testCase.code}: ${testCase.name}`,
      async () => {
        const error = await capture(testCase.run)
        expectStaticFailure(error, testCase.stage, testCase.code, testCase.marker)
      },
      120_000,
    )
  }
})
