/**
 * S-03 public Bundle conformance matrix.
 *
 * Every case in this file drives the published `./bundle` surface only:
 * `createStructBundle`, `verifyStructBundle`, `decodeStructBundle`,
 * `encodeStructBundle`, `StructBundleError`, and the frozen
 * `STRUCT_BUNDLE_LIMITS_PROFILE`. A private module is imported only to build
 * an adversarial input or to measure one; no assertion below depends on a
 * private contract.
 *
 * Each negative case asserts the exact documented stage and code and asserts
 * that no handle was published. No cap value is hard coded: every boundary is
 * derived from `STRUCT_BUNDLE_LIMITS_PROFILE` itself, so a profile change
 * moves the boundary with it.
 *
 * Axes already proven by an existing suite are listed in the report and are
 * not duplicated here.
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
  buildPublicMatrixCreateDocument,
  buildPublicMatrixEnvelope,
  createPublicMatrixResolverHarness,
  publicMatrixUtf8,
  sealPublicMatrixDocument,
} from './fixtures/bundle/public-matrix-fixtures'
import { httpsPolicy, policyDigest } from './fixtures/resolver/fake-host'

const profile = STRUCT_BUNDLE_LIMITS_PROFILE

/** Asserts that the call failed closed with the exact documented taxonomy. */
function expectFailure(
  error: unknown,
  stage: StructBundleErrorStage,
  code: StructBundleErrorCode,
): StructBundleError {
  expect(error).toBeInstanceOf(StructBundleError)
  const failure = error as StructBundleError
  expect(failure.stage).toBe(stage)
  expect(failure.code).toBe(code)
  expect(failure.name).toBe('StructBundleError')
  return failure
}

/** Runs a synchronous entry point and returns the thrown failure. */
function thrownBy(run: () => unknown): StructBundleError {
  try {
    run()
  } catch (error) {
    return error as StructBundleError
  }
  throw new Error('unexpected acceptance: a handle was returned')
}

/** Runs an asynchronous entry point and returns the rejection. */
async function rejectedBy(
  run: () => Promise<unknown>,
): Promise<StructBundleError> {
  try {
    await run()
  } catch (error) {
    return error as StructBundleError
  }
  throw new Error('unexpected acceptance: a handle was returned')
}

const oneByte = new Uint8Array([1])
const twoBytes = new Uint8Array([1, 2])

describe('S-03 public matrix: version axis', () => {
  it('rejects an unsupported bundle version without publishing a handle', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const envelope = JSON.parse(new TextDecoder().decode(built.canonical))
    const failure = await rejectedBy(() => decodeStructBundle(
      canonicalJsonBytes({ ...envelope, bundleVersion: '2.0.0' }),
    ))
    expectFailure(failure, 'canonical', 'TYPE')
  })

  it('rejects a schema version that disagrees with the document', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const envelope = JSON.parse(new TextDecoder().decode(built.canonical))
    const failure = await rejectedBy(() => decodeStructBundle(
      canonicalJsonBytes({ ...envelope, schemaVersion: '9.9.9' }),
    ))
    expectFailure(failure, 'canonical', 'TYPE')
  })

  it('rejects a version field that is not a string', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const envelope = JSON.parse(new TextDecoder().decode(built.canonical))
    const numericBundle = await rejectedBy(() => decodeStructBundle(
      canonicalJsonBytes({ ...envelope, bundleVersion: 100 }),
    ))
    expectFailure(numericBundle, 'canonical', 'TYPE')
    const numericSchema = await rejectedBy(() => decodeStructBundle(
      canonicalJsonBytes({ ...envelope, schemaVersion: 100 }),
    ))
    expectFailure(numericSchema, 'canonical', 'TYPE')
  })
})

describe('S-03 public matrix: canonical axis', () => {
  it('rejects every non-canonical spelling of the same document', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const text = new TextDecoder().decode(built.canonical)

    const keyOrder = await rejectedBy(() => decodeStructBundle(publicMatrixUtf8(
      `{"bundleVersion":"1.0.0",${text.slice(1, -1)}}`,
    )))
    expectFailure(keyOrder, 'canonical', 'NONCANONICAL')

    const whitespace = await rejectedBy(() => decodeStructBundle(publicMatrixUtf8(
      JSON.stringify(JSON.parse(text), null, 2),
    )))
    expectFailure(whitespace, 'canonical', 'NONCANONICAL')

    const duplicateKey = await rejectedBy(() => decodeStructBundle(publicMatrixUtf8(
      `${text.slice(0, -1)},"assets":[]}`,
    )))
    expectFailure(duplicateKey, 'canonical', 'NONCANONICAL')

    const nonMinimalNumber = await rejectedBy(() => decodeStructBundle(publicMatrixUtf8(
      text.replace('"assetCount":1', '"assetCount":1.0'),
    )))
    expectFailure(nonMinimalNumber, 'canonical', 'NONCANONICAL')

    const escapedString = await rejectedBy(() => decodeStructBundle(publicMatrixUtf8(
      text.replace('"title":"Fixture"', '"title":"\\u0046ixture"'),
    )))
    expectFailure(escapedString, 'canonical', 'NONCANONICAL')
  })

  it('accepts canonical bytes and re-encodes them byte for byte', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const handle = await decodeStructBundle(built.canonical)
    expect(handle.bundleSha256).toBe(built.bundleSha256)
    expect(encodeStructBundle(handle)).toEqual(built.canonical)
  })
})

describe('S-03 public matrix: policy axis', () => {
  it('refuses an invalid resolver policy before any allocation or start', async () => {
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: twoBytes, external: true },
    ])
    const harness = createPublicMatrixResolverHarness()
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical, {
      resolverExecutor: harness.executor,
      resolverPolicy: {} as never,
      resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    }))
    expectFailure(failure, 'resolve', 'POLICY')
    expect(harness.executionIds).toEqual([])
    expect(harness.requests).toEqual([])
  })

  it('uses the package-computed policy hash and refuses a caller-supplied one', async () => {
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: twoBytes, external: true },
    ])
    const policy = httpsPolicy()
    const harness = createPublicMatrixResolverHarness({
      bytesByDigest: () => twoBytes,
    })
    const pending = decodeStructBundle(built.canonical, {
      resolverExecutor: harness.executor,
      resolverPolicy: policy,
      resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    })
    await harness.allocated
    harness.release()
    const handle = await pending
    expect(handle.assetIds()).toEqual(['asset-1'])
    const request = harness.requests[0]!
    expect(request.expectedPolicySha256).toBe(policyDigest(policy))
    expect(request.expectedPolicySha256).toMatch(/^[0-9a-f]{64}$/u)

    const supplied = await rejectedBy(() => decodeStructBundle(built.canonical, {
      expectedPolicySha256: policyDigest(policy),
      resolverExecutor: harness.executor,
      resolverPolicy: policy,
      resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    } as never))
    expectFailure(supplied, 'input', 'OPTIONS')
  })

  it('does not honour a policy that changes between declaration and execution', async () => {
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: twoBytes, external: true },
    ])
    const policy = httpsPolicy()
    const declared = policyDigest(policy)
    const harness = createPublicMatrixResolverHarness({
      bytesByDigest: () => twoBytes,
      onAllocate: () => {
        ;(policy as unknown as Record<string, unknown>).profileId = 'mutated'
      },
    })
    const pending = decodeStructBundle(built.canonical, {
      resolverExecutor: harness.executor,
      resolverPolicy: policy,
      resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    })
    await harness.allocated
    harness.release()
    const handle = await pending
    expect(handle.assetIds()).toEqual(['asset-1'])
    const request = harness.requests[0]!
    // The package hashed and froze the policy it was handed; the mutated
    // caller object is neither hashed nor executed.
    expect(request.expectedPolicySha256).toBe(declared)
    expect(request.policy.profileId).toBe('fixture')
    expect(policyDigest(policy)).not.toBe(declared)
  })
})

describe('S-03 public matrix: receipt axis', () => {
  it('rejects a receipt that does not bind the document', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const envelope = JSON.parse(new TextDecoder().decode(built.canonical))

    const wrongDigest = await rejectedBy(() => decodeStructBundle(canonicalJsonBytes({
      ...envelope,
      documentSha256: '0'.repeat(64),
    })))
    expectFailure(wrongDigest, 'canonical', 'TYPE')

    const missing: Record<string, unknown> = { ...envelope }
    delete missing.receipt
    const absent = await rejectedBy(() => decodeStructBundle(canonicalJsonBytes(missing)))
    expectFailure(absent, 'canonical', 'TYPE')

    const wrongVersion = await rejectedBy(() => decodeStructBundle(canonicalJsonBytes({
      ...envelope,
      receipt: { ...(envelope.receipt as Record<string, unknown>), schemaVersion: '9.9.9' },
    })))
    expectFailure(wrongVersion, 'canonical', 'TYPE')

    const foreignDigest = await rejectedBy(() => decodeStructBundle(canonicalJsonBytes({
      ...envelope,
      receipt: { ...(envelope.receipt as Record<string, unknown>), generatedSha256: '0'.repeat(64) },
    })))
    expectFailure(foreignDigest, 'canonical', 'TYPE')
  })

  it('accepts a correct receipt and preserves it in the handle', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const handle = await decodeStructBundle(built.canonical)
    const snapshot = handle.documentSnapshot()
    expect(snapshot.receipt).toEqual(
      (built.envelope.document as Record<string, unknown>).receipt,
    )
    expect(encodeStructBundle(handle)).toEqual(built.canonical)
  })
})

describe('S-03 public matrix: asset set axis', () => {
  it('rejects an asset id set that differs between document and envelope', async () => {
    const missing = buildPublicMatrixBundle(
      [
        { id: 'asset-1', bytes: oneByte },
        { id: 'asset-2', bytes: twoBytes },
      ],
      ({ records }) => { records.splice(1, 1) },
    )
    const missingFailure = await rejectedBy(() => decodeStructBundle(missing.canonical))
    expectFailure(missingFailure, 'assets', 'SET')

    const extra = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        records.push({
          id: 'asset-9',
          sha256: sha256HexSync(new Uint8Array([9])),
          mediaType: 'application/octet-stream',
          byteLength: 1,
          payload: { kind: 'embedded', base64: 'CQ==' },
        })
      },
    )
    const extraFailure = await rejectedBy(() => decodeStructBundle(extra.canonical))
    expectFailure(extraFailure, 'assets', 'SET')

    // A duplicated envelope id is refused by the canonical envelope gate,
    // which runs before the asset-set preflight.
    const duplicate = buildPublicMatrixBundle(
      [
        { id: 'asset-1', bytes: oneByte },
        { id: 'asset-2', bytes: twoBytes },
      ],
      ({ records }) => { records[1] = { ...records[0]! } },
    )
    const duplicateFailure = await rejectedBy(() => decodeStructBundle(duplicate.canonical))
    expectFailure(duplicateFailure, 'canonical', 'TYPE')
  })

  it('rejects the same asset id with a different media type or digest', async () => {
    const mediaType = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).mediaType = 'image/png'
      },
    )
    const mediaTypeFailure = await rejectedBy(() => decodeStructBundle(mediaType.canonical))
    expectFailure(mediaTypeFailure, 'assets', 'METADATA')

    const digest = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).sha256 = 'b'.repeat(64)
      },
    )
    const digestFailure = await rejectedBy(() => decodeStructBundle(digest.canonical))
    expectFailure(digestFailure, 'assets', 'METADATA')
  })

  it('rejects a byteLength that disagrees with the payload', async () => {
    const built = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).byteLength = 7
      },
    )
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical))
    expectFailure(failure, 'assets', 'BASE64')
  })

  it('binds an external resource id to the declared digest', async () => {
    const built = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte, external: true }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).payload = {
          kind: 'external',
          resourceId: `sha256:${'c'.repeat(64)}`,
        }
      },
    )
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical))
    expectFailure(failure, 'canonical', 'TYPE')
  })
})

describe('S-03 public matrix: cap boundaries', () => {
  it('enforces the raw byte cap at N-1, N and N+1', async () => {
    const under = await rejectedBy(() => decodeStructBundle(
      new Uint8Array(profile.maxRawBytes - 1),
    ))
    expectFailure(under, 'canonical', 'SYNTAX')
    const at = await rejectedBy(() => decodeStructBundle(
      new Uint8Array(profile.maxRawBytes),
    ))
    expectFailure(at, 'canonical', 'SYNTAX')
    const over = await rejectedBy(() => decodeStructBundle(
      new Uint8Array(profile.maxRawBytes + 1),
    ))
    expectFailure(over, 'input', 'LIMIT')
  }, 120_000)

  it('enforces the top-level field byte cap at N-1, N and N+1', async () => {
    const base = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const empty = structuredClone(base.document) as Record<string, unknown>
    const metadata = empty.metadata as Record<string, unknown>
    metadata.title = ''
    metadata.abstract = ''
    const emptySize = canonicalJsonBytes(empty).byteLength

    const build = (target: number) => {
      const document = structuredClone(base.document) as Record<string, unknown>
      const targetMetadata = document.metadata as Record<string, unknown>
      const missing = target - emptySize
      const titleLength = Math.floor(missing / 2)
      targetMetadata.title = 'a'.repeat(titleLength)
      targetMetadata.abstract = 'a'.repeat(missing - titleLength)
      sealPublicMatrixDocument(document)
      const envelope = buildPublicMatrixEnvelope(
        document,
        base.envelope.assets as Array<Record<string, unknown>>,
      )
      return { ...envelope, documentSize: canonicalJsonBytes(document).byteLength }
    }

    const under = build(profile.maxFieldBytes - 1)
    expect(under.documentSize).toBe(profile.maxFieldBytes - 1)
    const underHandle = await decodeStructBundle(under.canonical)
    expect(underHandle.bundleSha256).toBe(under.bundleSha256)

    const at = build(profile.maxFieldBytes)
    expect(at.documentSize).toBe(profile.maxFieldBytes)
    const atHandle = await decodeStructBundle(at.canonical)
    expect(atHandle.bundleSha256).toBe(at.bundleSha256)

    const over = build(profile.maxFieldBytes + 1)
    expect(over.documentSize).toBe(profile.maxFieldBytes + 1)
    const failure = await rejectedBy(() => decodeStructBundle(over.canonical))
    expectFailure(failure, 'canonical', 'LIMIT')
  }, 180_000)

  it('enforces the asset count cap at N-1, N and N+1', async () => {
    const specs = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `asset-${index + 1}`,
      bytes: new Uint8Array([index & 255]),
    }))
    const under = buildPublicMatrixBundle(specs(profile.maxAssets - 1))
    const underHandle = await decodeStructBundle(under.canonical)
    expect(underHandle.assetIds()).toHaveLength(profile.maxAssets - 1)

    const at = buildPublicMatrixBundle(specs(profile.maxAssets))
    const atHandle = await decodeStructBundle(at.canonical)
    expect(atHandle.assetIds()).toHaveLength(profile.maxAssets)

    const over = buildPublicMatrixBundle(specs(profile.maxAssets + 1))
    const failure = await rejectedBy(() => decodeStructBundle(over.canonical))
    expectFailure(failure, 'assets', 'LIMIT')
  }, 180_000)

  it('enforces the per-asset byte cap at N-1, N and N+1', async () => {
    const under = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: new Uint8Array(profile.maxAssetBytes - 1) },
    ])
    const underHandle = await decodeStructBundle(under.canonical)
    expect(underHandle.assetBytes('asset-1')!.byteLength)
      .toBe(profile.maxAssetBytes - 1)

    const at = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: new Uint8Array(profile.maxAssetBytes) },
    ])
    const atHandle = await decodeStructBundle(at.canonical)
    expect(atHandle.assetBytes('asset-1')!.byteLength).toBe(profile.maxAssetBytes)

    // A declared length above the per-asset cap is refused by the asset gate
    // even when the payload itself still fits the other caps.
    const over = buildPublicMatrixBundle([
      {
        id: 'asset-1',
        bytes: new Uint8Array(profile.maxAssetBytes),
        byteLength: profile.maxAssetBytes + 1,
      },
    ])
    const failure = await rejectedBy(() => decodeStructBundle(over.canonical))
    expectFailure(failure, 'assets', 'LIMIT')
  }, 300_000)

  it('enforces the aggregate and decoded budgets at N-1, N and N+1', async () => {
    const half = Math.floor(profile.maxTotalBytes / 2)
    const pair = (second: number) => buildPublicMatrixBundle([
      { id: 'asset-1', bytes: new Uint8Array(half), byteLength: half },
      { id: 'asset-2', bytes: new Uint8Array(second), byteLength: second },
    ])

    const under = pair(half - 1)
    const underHandle = await decodeStructBundle(under.canonical)
    expect(underHandle.assetIds()).toEqual(['asset-1', 'asset-2'])

    const at = pair(half)
    const atHandle = await decodeStructBundle(at.canonical)
    expect(atHandle.assetIds()).toEqual(['asset-1', 'asset-2'])

    const over = pair(half + 1)
    const failure = await rejectedBy(() => decodeStructBundle(over.canonical))
    expectFailure(failure, 'assets', 'LIMIT')
  }, 300_000)

  it('enforces the aggregate budget across mixed embedded and external assets', async () => {
    const half = Math.floor(profile.maxTotalBytes / 2)
    const mixed = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: new Uint8Array(half), byteLength: half },
      {
        id: 'asset-2',
        bytes: oneByte,
        external: true,
        byteLength: half + 1,
      },
    ])
    const failure = await rejectedBy(() => decodeStructBundle(mixed.canonical))
    expectFailure(failure, 'assets', 'LIMIT')
  }, 300_000)

  it('enforces the base64 character cap at N-1, N and N+1', async () => {
    const bytes = new Uint8Array(profile.maxAssetBytes)
    const canonical = Buffer.from(bytes).toString('base64')
    expect(canonical).toHaveLength(profile.maxBase64Chars)

    // N-1: one character below the cap. The cap does not reject it, the
    // canonical base64 rule does, which proves the boundary is the cap.
    const under = buildPublicMatrixBundle([
      { id: 'asset-1', bytes, base64: canonical.slice(0, -1) },
    ])
    const underFailure = await rejectedBy(() => decodeStructBundle(under.canonical))
    expectFailure(underFailure, 'assets', 'BASE64')

    // N: the carrier sits exactly at the cap and the bundle is accepted.
    const at = buildPublicMatrixBundle([{ id: 'asset-1', bytes }])
    const atHandle = await decodeStructBundle(at.canonical)
    expect(atHandle.assetBytes('asset-1')!.byteLength).toBe(profile.maxAssetBytes)

    // N+1: the carrier is one character above the cap. On the wire path the
    // string cap binds first, because the carrier is one envelope string.
    const over = buildPublicMatrixBundle([
      { id: 'asset-1', bytes, base64: `${canonical}A` },
    ])
    const failure = await rejectedBy(() => decodeStructBundle(over.canonical))
    expectFailure(failure, 'canonical', 'LIMIT')
  }, 300_000)

  it('enforces the base64 character cap on the create path', () => {
    // The create path charges the carrier length against the base64 cap
    // before it charges the string cap, so the base64 cap is the one that
    // refuses an over-cap carrier there.
    const over = buildPublicMatrixCreateDocument([profile.maxAssetBytes])
    const asset = (over.assets as Array<Record<string, unknown>>)[0]!
    asset.bytes = 'A'.repeat(profile.maxBase64Chars + 1)
    sealPublicMatrixDocument(over)
    const failure = thrownBy(() => createStructBundle({ document: over } as never))
    expectFailure(failure, 'assets', 'LIMIT')
  }, 300_000)

  it('enforces the per-asset and aggregate caps on the create path', () => {
    const under = buildPublicMatrixCreateDocument([profile.maxAssetBytes - 1])
    const underHandle = createStructBundle({ document: under } as never)
    expect(underHandle.assetBytes('asset-1')!.byteLength)
      .toBe(profile.maxAssetBytes - 1)

    const at = buildPublicMatrixCreateDocument([profile.maxAssetBytes])
    const atHandle = createStructBundle({ document: at } as never)
    expect(atHandle.assetBytes('asset-1')!.byteLength).toBe(profile.maxAssetBytes)

    const over = buildPublicMatrixCreateDocument([profile.maxAssetBytes + 1])
    const failure = thrownBy(() => createStructBundle({ document: over } as never))
    expectFailure(failure, 'assets', 'LIMIT')

    const half = Math.floor(profile.maxTotalBytes / 2)
    const aggregateOver = buildPublicMatrixCreateDocument([half, half + 1])
    const aggregateFailure = thrownBy(() => createStructBundle({
      document: aggregateOver,
    } as never))
    expectFailure(aggregateFailure, 'assets', 'LIMIT')
  }, 300_000)

  it('enforces the nesting depth cap at N-1, N and N+1', async () => {
    const nested = (depth: number) =>
      publicMatrixUtf8(`${'['.repeat(depth)}0${']'.repeat(depth)}`)
    const under = await rejectedBy(() => decodeStructBundle(nested(profile.maxDepth - 1)))
    expectFailure(under, 'canonical', 'TYPE')
    const at = await rejectedBy(() => decodeStructBundle(nested(profile.maxDepth)))
    expectFailure(at, 'canonical', 'TYPE')
    const over = await rejectedBy(() => decodeStructBundle(nested(profile.maxDepth + 1)))
    expectFailure(over, 'canonical', 'LIMIT')
  }, 120_000)

  it('enforces the string length cap at N-1, N and N+1', async () => {
    const bytes = new Uint8Array(profile.maxAssetBytes)
    const canonical = Buffer.from(bytes).toString('base64')
    expect(canonical).toHaveLength(profile.maxStringLength)

    const under = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: new Uint8Array(profile.maxAssetBytes - 1) },
    ])
    const underHandle = await decodeStructBundle(under.canonical)
    expect(underHandle.assetIds()).toEqual(['asset-1'])

    const at = buildPublicMatrixBundle([{ id: 'asset-1', bytes }])
    const atHandle = await decodeStructBundle(at.canonical)
    expect(atHandle.assetIds()).toEqual(['asset-1'])

    // One character above the string cap. The carrier is one envelope string,
    // so the string cap refuses it.
    const over = buildPublicMatrixBundle([
      { id: 'asset-1', bytes, base64: `${canonical}A` },
    ])
    const failure = await rejectedBy(() => decodeStructBundle(over.canonical))
    expectFailure(failure, 'canonical', 'LIMIT')

    // The same cap on the create path, where the carrier is not the string
    // that is measured: an over-long document string is refused as well.
    const created = buildPublicMatrixCreateDocument([1])
    const metadata = created.metadata as Record<string, unknown>
    metadata.title = 'a'.repeat(profile.maxStringLength + 1)
    sealPublicMatrixDocument(created)
    const createFailure = thrownBy(() => createStructBundle({
      document: created,
    } as never))
    expectFailure(createFailure, 'canonical', 'LIMIT')
  }, 300_000)

  it('enforces the node count cap at N-1, N and N+1', async () => {
    const nodes = (count: number) =>
      publicMatrixUtf8(JSON.stringify(Array.from({ length: count }, () => 0)))
    const under = await rejectedBy(() => decodeStructBundle(nodes(profile.maxNodes - 2)))
    expectFailure(under, 'canonical', 'TYPE')
    const at = await rejectedBy(() => decodeStructBundle(nodes(profile.maxNodes - 1)))
    expectFailure(at, 'canonical', 'TYPE')
    const over = await rejectedBy(() => decodeStructBundle(nodes(profile.maxNodes)))
    expectFailure(over, 'canonical', 'LIMIT')
  }, 300_000)
})

describe('S-03 public matrix: decoded and base64 axis', () => {
  it('rejects a payload that is not canonical base64', async () => {
    const built = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).payload = {
          kind: 'embedded',
          base64: 'AB==',
        }
      },
    )
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical))
    expectFailure(failure, 'assets', 'BASE64')
  })

  it('rejects a payload whose decoded length disagrees with the declaration', async () => {
    const built = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).payload = {
          kind: 'embedded',
          base64: 'AAAA',
        }
      },
    )
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical))
    expectFailure(failure, 'assets', 'BASE64')
  })

  it('rejects a payload whose bytes disagree with the declared digest', async () => {
    const built = buildPublicMatrixBundle(
      [{ id: 'asset-1', bytes: oneByte }],
      ({ records }) => {
        (records[0] as Record<string, unknown>).payload = {
          kind: 'embedded',
          base64: 'Ag==',
        }
      },
    )
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical))
    expectFailure(failure, 'assets', 'DIGEST')
  })

  it('decodes exactly the byte length the codec decodes', async () => {
    const payload = new Uint8Array([0, 255, 128, 7])
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: payload }])
    const handle = await decodeStructBundle(built.canonical)
    const decoded = handle.assetBytes('asset-1')!
    expect(decoded.byteLength).toBe(payload.byteLength)
    expect(decoded).toEqual(payload)
    expect(
      (built.envelope.assets as Array<Record<string, unknown>>)[0]!.byteLength,
    ).toBe(payload.byteLength)
  })
})

describe('S-03 public matrix: nesting, string and node accounting', () => {
  it('charges an aliased string and subtree once per occurrence', () => {
    const shared = { a: 1 }
    const aliased = (count: number) =>
      Array.from({ length: count }, () => shared)
    // The root array plus two nodes per occurrence: the shared subtree is
    // measured again for every reference, never deduplicated. The array holds
    // one distinct object, so only the expanded accounting can reach the cap.
    const under = thrownBy(() => verifyStructBundle(
      aliased(Math.floor((profile.maxNodes - 1) / 2)),
    ))
    expectFailure(under, 'canonical', 'TYPE')
    const over = thrownBy(() => verifyStructBundle(
      aliased(Math.floor(profile.maxNodes / 2)),
    ))
    expectFailure(over, 'canonical', 'LIMIT')
    expect(new Set(aliased(4)).size).toBe(1)
  }, 180_000)
})

describe('S-03 public matrix: concurrency axis', () => {
  it('resolves external assets one at a time inside a single decode', async () => {
    const first = new Uint8Array([1, 2])
    const second = new Uint8Array([3, 4])
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes: first, external: true },
      { id: 'asset-2', bytes: second, external: true },
    ])
    const harness = createPublicMatrixResolverHarness({
      bytesByDigest: (digest) => (digest === sha256HexSync(first) ? first : second),
    })
    const pending = decodeStructBundle(built.canonical, {
      resolverExecutor: harness.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    })
    await harness.allocated
    // The profile allows one concurrent resolution, so the second asset is not
    // allocated while the first execution is still in flight.
    expect(harness.requests).toHaveLength(1)
    harness.release()
    const handle = await pending
    expect(handle.assetIds()).toEqual(['asset-1', 'asset-2'])
    expect(harness.requests).toHaveLength(2)
    expect(profile.maxConcurrency).toBe(1)
  }, 60_000)

  it('refuses a second concurrent decode instead of interleaving it', async () => {
    const bytes = new Uint8Array([1, 2])
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes, external: true },
    ])
    const harness = createPublicMatrixResolverHarness({
      bytesByDigest: () => bytes,
    })
    const options = {
      resolverExecutor: harness.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 5000, cleanupReserveMs: 500 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    }
    const first = decodeStructBundle(built.canonical, options)
    await harness.allocated
    const second = await rejectedBy(() => decodeStructBundle(built.canonical, options))
    expectFailure(second, 'resolve', 'ALLOCATE')
    harness.release()
    const handle = await first
    expect(handle.assetIds()).toEqual(['asset-1'])
    // Exactly one execution ever existed: the two decodes never interleaved
    // into a single execution.
    expect(harness.executionIds).toHaveLength(1)
  }, 60_000)
})

describe('S-03 public matrix: timeout axis', () => {
  it('fails closed with the budget taxonomy when the resolver budget expires', async () => {
    const bytes = new Uint8Array([1, 2])
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes, external: true },
    ])
    const harness = createPublicMatrixResolverHarness({ mode: 'hang' })
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical, {
      resolverExecutor: harness.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    }))
    expectFailure(failure, 'resolve', 'TIMEOUT')
    // The fixed teardown order ran and no execution is left behind.
    expect(harness.teardown).toEqual(['revoke', 'cleanup', 'terminate'])
    expect(harness.activeCapacity()).toBe(0)
    expect(harness.retiredExecutionIds()).toContain(harness.executionIds[0])
  }, 60_000)

  it('fails closed when the caller aborts the resolver signal mid-flight', async () => {
    const bytes = new Uint8Array([1, 2])
    const built = buildPublicMatrixBundle([
      { id: 'asset-1', bytes, external: true },
    ])
    const harness = createPublicMatrixResolverHarness({ mode: 'hang' })
    const controller = new AbortController()
    const pending = decodeStructBundle(built.canonical, {
      resolverExecutor: harness.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverSignal: controller.signal,
      resolverHostSupervisor: { protocolVersion: '1.0.0', failStop: async () => ({}) } as never,
    })
    await harness.allocated
    controller.abort()
    const failure = await rejectedBy(() => pending)
    expectFailure(failure, 'resolve', 'ABORTED')
    expect(harness.teardown).toEqual(['revoke', 'cleanup', 'terminate'])
    expect(harness.activeCapacity()).toBe(0)
  }, 60_000)

  it('keeps the package clock and refuses a caller-supplied one', async () => {
    const built = buildPublicMatrixBundle([{ id: 'asset-1', bytes: oneByte }])
    const failure = await rejectedBy(() => decodeStructBundle(built.canonical, {
      now: () => 0,
    } as never))
    expectFailure(failure, 'input', 'OPTIONS')
    const clock = await rejectedBy(() => decodeStructBundle(built.canonical, {
      resolverClock: () => 0,
    } as never))
    expectFailure(clock, 'input', 'OPTIONS')
  })
})
