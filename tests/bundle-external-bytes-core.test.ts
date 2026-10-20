import { describe, expect, it } from 'vitest'
import {
  canonicalBundleDocumentBytes,
  canonicalBundleEnvelopeBytes,
  canonicalJsonBytes,
} from '../src/bundle/canonical'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from '../src/bundle/limits'
import {
  decodeExternalBundleBytes,
  type ExternalDecodeOptions,
} from '../src/bundle/external'
import {
  createVerifiedBundleHandle,
  decodeEmbeddedBundleBytes,
  encodeVerifiedEmbeddedBundle,
} from '../src/bundle/embedded'
import { sha256HexSync } from '../src/sha256'
import { seal, validDocument } from './codec-fixtures'
import {
  createFakeHostSupervisor,
  createFakeSupervisor,
  httpsPolicy,
  policyDigest,
} from './fixtures/resolver/fake-host'
import type { StructResolverExecutorV1 } from '../src/bundle/resolver-protocol'
import vectors from './fixtures/bundle-canonical/vectors.json'

const encoder = new TextEncoder()
const utf8 = (value: string) => encoder.encode(value)
const currentVector = vectors.find((value) => value.name === 'current:envelope')!
const policy = httpsPolicy()
const policySha256 = policyDigest(policy)

type AssetSpec = Readonly<{
  id: string
  bytes: Uint8Array
  external?: boolean
  /** Overrides the envelope-declared length; used for limit pilots. */
  byteLength?: number
}>

type BuiltBundle = Readonly<{
  document: Record<string, unknown>
  envelope: Record<string, unknown>
  canonical: Uint8Array
  bundleSha256: string
  specs: readonly AssetSpec[]
  bytesById: ReadonlyMap<string, Uint8Array>
}>

/**
 * Builds a canonical wire envelope from a valid fixture document. The base
 * document is mutated into the requested asset set, resealed, and projected
 * without asset bytes. `tamper` runs before the document digest and envelope
 * are computed, so a test can create a canonical but semantically invalid set.
 */
function buildBundle(
  specs: readonly AssetSpec[],
  tamper?: (state: { document: any; records: any[] }) => void,
): BuiltBundle {
  const document = validDocument() as any
  const original = document.assets[0] as any
  const records = specs.map((spec) => ({
    id: spec.id,
    sha256: sha256HexSync(spec.bytes),
    mediaType: original.mediaType,
    byteLength: spec.byteLength ?? spec.bytes.byteLength,
    payload: spec.external
      ? { kind: 'external' as const, resourceId: `sha256:${sha256HexSync(spec.bytes)}` }
      : { kind: 'embedded' as const, base64: Buffer.from(spec.bytes).toString('base64') },
  }))
  document.assets = specs.map((spec) => {
    const asset = {
      ...original,
      id: spec.id,
      href: `assets/${spec.id}.bin`,
      sha256: sha256HexSync(spec.bytes),
    }
    delete (asset as any).bytes
    return asset
  })
  document.receipt.assetCount = specs.length
  document.receipt.conservation.sourceAssetCount = specs.length
  document.receipt.conservation.accountedSourceAssetCount = specs.length
  document.receipt.conservation.structAssetCount = specs.length
  seal(document)
  if (tamper) tamper({ document, records })
  const documentSha256 = sha256HexSync(canonicalBundleDocumentBytes(document))
  const envelope = {
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256,
    document,
    assets: records,
    receipt: document.receipt,
  }
  const canonical = canonicalBundleEnvelopeBytes(envelope)
  const bytesById = new Map<string, Uint8Array>()
  for (const spec of specs) bytesById.set(spec.id, spec.bytes.slice())
  return {
    document,
    envelope,
    canonical,
    bundleSha256: sha256HexSync(canonical),
    specs,
    bytesById,
  }
}

/** A supervisor whose host streams the expected bytes for each digest. */
function successSupervisor(specs: readonly AssetSpec[]) {
  const bytesByDigest = new Map<string, Uint8Array>()
  for (const spec of specs) {
    if (spec.external) bytesByDigest.set(sha256HexSync(spec.bytes), spec.bytes.slice())
  }
  return createFakeSupervisor((request) => ({
    chunks: [bytesByDigest.get(request.expected.sha256) ?? new Uint8Array()],
  }))
}

function resolverOptions(
  executor: StructResolverExecutorV1,
  host = createFakeHostSupervisor(),
  overrides: Partial<ExternalDecodeOptions> = {},
): ExternalDecodeOptions {
  return {
    resolverExecutor: executor,
    resolverPolicy: policy,
    resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
    resolverHostSupervisor: host,
    ...overrides,
  }
}

const expectFailure = (
  result: Awaited<ReturnType<typeof decodeExternalBundleBytes>>,
  stage: string,
  code: string,
) => {
  expect(result).toEqual({ ok: false, error: { stage, code } })
}

describe('external bytes pilot: successful external resolution', () => {
  it('resolves an external asset and preserves the original external wire', async () => {
    const sourceBytes = new Uint8Array([9, 8, 7, 6])
    const built = buildBundle([{ id: 'asset-1', bytes: sourceBytes, external: true }])
    const originalWire = built.canonical.slice()
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))

    expect(result.bundle.bundleSha256).toBe(built.bundleSha256)
    expect(result.bundle.assetBytes('asset-1')).toEqual(sourceBytes)
    expect(result.bundle.assetIds()).toEqual(['asset-1'])
    // Encoding an external handle returns the ORIGINAL external wire, not a
    // synthetic embedded envelope.
    const encoded = encodeVerifiedEmbeddedBundle(result.bundle)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('expected encode')
    expect(encoded.bytes).toEqual(originalWire)
    expect(supervisor.hosts).toHaveLength(1)
  })

  it('resolves a mixed embedded and external bundle before publishing', async () => {
    const embeddedBytes = new Uint8Array([0, 255, 128])
    const externalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const built = buildBundle([
      { id: 'asset-1', bytes: embeddedBytes },
      { id: 'asset-2', bytes: externalBytes, external: true },
    ])
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.bundle.assetIds()).toEqual(['asset-1', 'asset-2'])
    expect(result.bundle.assetBytes('asset-1')).toEqual(embeddedBytes)
    expect(result.bundle.assetBytes('asset-2')).toEqual(externalBytes)
    expect(supervisor.hosts).toHaveLength(1)
  })
})

describe('external bytes pilot: raw digest gate', () => {
  it('rejects a wrong raw SHA before parsing or allocating', async () => {
    const built = buildBundle([
      { id: 'asset-1', bytes: new Uint8Array([1]), external: true },
    ])
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor, undefined, {
        expectedBundleSha256: '0'.repeat(64),
      }),
    )
    expectFailure(result, 'digest', 'MISMATCH')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('rejects malformed bytes on a wrong digest without parsing them', async () => {
    const result = await decodeExternalBundleBytes(utf8('{bad'), {
      expectedBundleSha256: '0'.repeat(64),
    })
    expectFailure(result, 'digest', 'MISMATCH')
  })
})

describe('external bytes pilot: all assets preflight before allocate', () => {
  it('rejects a later metadata mismatch before any executor allocate', async () => {
    const built = buildBundle(
      [
        { id: 'asset-1', bytes: new Uint8Array([1]), external: true },
        { id: 'asset-2', bytes: new Uint8Array([2]), external: true },
      ],
      ({ document }) => {
        // Canonical but disagreeing document metadata for the later asset.
        document.assets[1].sha256 = 'b'.repeat(64)
        seal(document)
      },
    )
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor),
    )
    expectFailure(result, 'assets', 'METADATA')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('rejects an invalid later embedded asset before any executor allocate', async () => {
    const built = buildBundle([
      { id: 'asset-1', bytes: new Uint8Array([1]), external: true },
      { id: 'asset-2', bytes: new Uint8Array([2]) },
    ])
    const value = JSON.parse(new TextDecoder().decode(built.canonical))
    // Same declared length, different digest, so the failure is DIGEST.
    value.assets[1].payload.base64 = Buffer.from([9]).toString('base64')
    const raw = canonicalJsonBytes(value)
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      raw,
      resolverOptions(supervisor.executor),
    )
    expectFailure(result, 'assets', 'DIGEST')
    expect(supervisor.hosts).toHaveLength(0)
  })
})

describe('external bytes pilot: teardown evidence', () => {
  it('escalates a never-settling cleanup to the parent fail-stop port', async () => {
    const built = buildBundle([
      { id: 'asset-1', bytes: new Uint8Array([1, 2, 3]), external: true },
    ])
    const supervisor = successSupervisor(built.specs)
    // Replace the host behaviour with a hanging cleanup for this execution.
    const hanging = createFakeSupervisor((request) => ({
      chunks: [built.bytesById.get(request.expected.id)!],
      cleanup: 'hang',
    }))
    const host = createFakeHostSupervisor()
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(hanging.executor, host, {
        resolverBudget: { totalTimeoutMs: 200, cleanupReserveMs: 50 },
      }),
    )
    expectFailure(result, 'resolve', 'CLEANUP')
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.reason).toBe('CLEANUP_TIMEOUT')
  })

  it('fails closed when the fail-stop port is unavailable', async () => {
    const built = buildBundle([
      { id: 'asset-1', bytes: new Uint8Array([1, 2, 3]), external: true },
    ])
    const hanging = createFakeSupervisor((request) => ({
      chunks: [built.bytesById.get(request.expected.id)!],
      cleanup: 'hang',
    }))
    const host = createFakeHostSupervisor('throw')
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(hanging.executor, host, {
        resolverBudget: { totalTimeoutMs: 200, cleanupReserveMs: 50 },
      }),
    )
    expectFailure(result, 'resolve', 'FAIL_STOP')
  })
})

describe('external bytes options and mandatory resolver configuration', () => {
  const externalBuilt = () =>
    buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])

  it('requires a complete resolver configuration for external assets', async () => {
    const built = externalBuilt()
    expectFailure(await decodeExternalBundleBytes(built.canonical), 'assets', 'UNRESOLVED')
  })

  it('rejects partial resolver configuration before allocation', async () => {
    const built = externalBuilt()
    const supervisor = successSupervisor(built.specs)
    const partial = { resolverExecutor: supervisor.executor } as unknown as ExternalDecodeOptions
    expectFailure(await decodeExternalBundleBytes(built.canonical, partial), 'input', 'OPTIONS')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('rejects unknown keys, explicit undefined and invalid option types', async () => {
    const built = externalBuilt()
    expectFailure(
      await decodeExternalBundleBytes(built.canonical, { bogus: true } as never),
      'input',
      'OPTIONS',
    )
    expectFailure(
      await decodeExternalBundleBytes(built.canonical, undefined as never),
      'input',
      'OPTIONS',
    )
    expectFailure(
      await decodeExternalBundleBytes('not-bytes' as never),
      'input',
      'TYPE',
    )
    expectFailure(
      await decodeExternalBundleBytes(built.canonical, { limitsProfile: '2.0.0' } as never),
      'input',
      'OPTIONS',
    )
  })

  it('rejects an invalid executor, budget, signal or policy before allocate', async () => {
    const built = externalBuilt()
    const supervisor = successSupervisor(built.specs)
    expectFailure(
      await decodeExternalBundleBytes(
        built.canonical,
        resolverOptions(supervisor.executor, undefined, {
          resolverExecutor: {} as never,
        }),
      ),
      'input',
      'OPTIONS',
    )
    expectFailure(
      await decodeExternalBundleBytes(
        built.canonical,
        resolverOptions(supervisor.executor, undefined, {
          resolverBudget: { totalTimeoutMs: 2, cleanupReserveMs: 2 },
        }),
      ),
      'budget',
      'BUDGET',
    )
    expectFailure(
      await decodeExternalBundleBytes(
        built.canonical,
        resolverOptions(supervisor.executor, undefined, {
          resolverSignal: {} as never,
        }),
      ),
      'input',
      'OPTIONS',
    )
    expectFailure(
      await decodeExternalBundleBytes(
        built.canonical,
        resolverOptions(supervisor.executor, undefined, {
          resolverPolicy: {} as never,
        }),
      ),
      'resolve',
      'POLICY',
    )
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('never accepts a caller-supplied policy hash as authority', async () => {
    const built = externalBuilt()
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      built.canonical,
      {
        ...resolverOptions(supervisor.executor),
        resolverPolicySha256: '0'.repeat(64),
      } as never,
    )
    expectFailure(result, 'input', 'OPTIONS')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('honours an already-aborted caller signal before allocate', async () => {
    const built = externalBuilt()
    const supervisor = successSupervisor(built.specs)
    const controller = new AbortController()
    controller.abort()
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor, undefined, {
        resolverSignal: controller.signal,
      }),
    )
    expectFailure(result, 'resolve', 'ABORTED')
    expect(supervisor.hosts).toHaveLength(0)
  })

  it('maps a wrong transport receipt to RECEIPT without publishing', async () => {
    const built = externalBuilt()
    const supervisor = createFakeSupervisor((request) => ({
      chunks: [built.bytesById.get(request.expected.id)!],
      receiptPolicySha256: 'f'.repeat(64),
    }))
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor),
    )
    expectFailure(result, 'resolve', 'RECEIPT')
  })

  it('keeps embedded-only decoding behavior identical and resolver-free', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([4, 5, 6]) }])
    const result = await decodeExternalBundleBytes(built.canonical)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.bundle.assetBytes('asset-1')).toEqual(new Uint8Array([4, 5, 6]))
    const encoded = encodeVerifiedEmbeddedBundle(result.bundle)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('expected encode')
    expect(encoded.bytes).toEqual(built.canonical)
  })
})

describe('external bytes strict limits N-1 / N / N+1', () => {
  const profile = STRUCT_BUNDLE_LIMITS_PROFILE

  it('enforces the raw byte cap', async () => {
    expectFailure(
      await decodeExternalBundleBytes(new Uint8Array(profile.maxRawBytes + 1)),
      'input',
      'LIMIT',
    )
    // N-1 is accepted by the cap and then rejected as syntax.
    expectFailure(
      await decodeExternalBundleBytes(new Uint8Array(profile.maxRawBytes - 1)),
      'canonical',
      'SYNTAX',
    )
  })

  it('enforces nesting depth N-1 / N / N+1', async () => {
    const nested = (depth: number) => utf8(`${'['.repeat(depth)}0${']'.repeat(depth)}`)
    expectFailure(await decodeExternalBundleBytes(nested(128)), 'canonical', 'TYPE')
    expectFailure(await decodeExternalBundleBytes(nested(129)), 'canonical', 'LIMIT')
  })

  it('enforces the top-level field byte cap', async () => {
    // A composite field above maxFieldBytes while every string stays under
    // maxStringLength, so this exercises the field cap specifically.
    const chunk = 'a'.repeat(1000)
    const entries = Array.from({ length: 6000 }, () => `"${chunk}"`).join(',')
    const raw = utf8(`{"document":[${entries}]}`)
    expectFailure(await decodeExternalBundleBytes(raw), 'canonical', 'LIMIT')
  })

  it('enforces the string length cap', async () => {
    const raw = utf8(`"${'a'.repeat(profile.maxStringLength + 1)}"`)
    expectFailure(await decodeExternalBundleBytes(raw), 'canonical', 'LIMIT')
  })

  it('enforces the asset count cap at N-1 / N / N+1', async () => {
    const specs = (count: number): AssetSpec[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `asset-${index + 1}`,
        bytes: new Uint8Array([index & 255]),
      }))
    const atMinusOne = buildBundle(specs(profile.maxAssets - 1))
    expect((await decodeExternalBundleBytes(atMinusOne.canonical)).ok).toBe(true)
    const atLimit = buildBundle(specs(profile.maxAssets))
    expect((await decodeExternalBundleBytes(atLimit.canonical)).ok).toBe(true)
    const overLimit = buildBundle(specs(profile.maxAssets + 1))
    expectFailure(await decodeExternalBundleBytes(overLimit.canonical), 'assets', 'LIMIT')
  })

  it('enforces per-asset declared bytes at N-1 / N / N+1', async () => {
    const spec = (byteLength: number): AssetSpec[] => [
      { id: 'asset-1', bytes: new Uint8Array([1]), external: true, byteLength },
    ]
    expectFailure(
      await decodeExternalBundleBytes(buildBundle(spec(profile.maxAssetBytes - 1)).canonical),
      'assets',
      'UNRESOLVED',
    )
    expectFailure(
      await decodeExternalBundleBytes(buildBundle(spec(profile.maxAssetBytes)).canonical),
      'assets',
      'UNRESOLVED',
    )
    expectFailure(
      await decodeExternalBundleBytes(buildBundle(spec(profile.maxAssetBytes + 1)).canonical),
      'assets',
      'LIMIT',
    )
  })

  it('enforces the aggregate/decoded cap at N-1 / N / N+1', async () => {
    const half = Math.floor(profile.maxTotalBytes / 2)
    const pair = (second: number): AssetSpec[] => [
      { id: 'asset-1', bytes: new Uint8Array([1]), external: true, byteLength: half },
      { id: 'asset-2', bytes: new Uint8Array([2]), external: true, byteLength: second },
    ]
    expectFailure(
      await decodeExternalBundleBytes(buildBundle(pair(half - 1)).canonical),
      'assets',
      'UNRESOLVED',
    )
    expectFailure(
      await decodeExternalBundleBytes(buildBundle(pair(half)).canonical),
      'assets',
      'UNRESOLVED',
    )
    expectFailure(
      await decodeExternalBundleBytes(buildBundle(pair(half + 1)).canonical),
      'assets',
      'LIMIT',
    )
  })
})

describe('external bytes canonical, version and provenance', () => {
  it('rejects a wrong bundle or schema version canonically', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])
    const wrongBundle = JSON.parse(new TextDecoder().decode(built.canonical))
    wrongBundle.bundleVersion = '2.0.0'
    expectFailure(
      await decodeExternalBundleBytes(canonicalJsonBytes(wrongBundle), resolverOptions(
        successSupervisor(built.specs).executor,
      )),
      'canonical',
      'TYPE',
    )
    const wrongSchema = JSON.parse(new TextDecoder().decode(built.canonical))
    wrongSchema.schemaVersion = '9.9.9'
    expectFailure(
      await decodeExternalBundleBytes(canonicalJsonBytes(wrongSchema), resolverOptions(
        successSupervisor(built.specs).executor,
      )),
      'canonical',
      'TYPE',
    )
  })

  it('copies raw wire, asset bytes and document snapshots without aliasing', async () => {
    const sourceBytes = new Uint8Array([9, 8, 7, 6])
    const built = buildBundle([{ id: 'asset-1', bytes: sourceBytes, external: true }])
    const wire = built.canonical.slice()
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(wire, resolverOptions(supervisor.executor))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    const handle = result.bundle

    // Caller raw and source chunk mutation cannot change the handle.
    wire.fill(0)
    sourceBytes.fill(0)
    expect(handle.assetBytes('asset-1')).toEqual(new Uint8Array([9, 8, 7, 6]))
    const returned = handle.assetBytes('asset-1')!
    returned.fill(0)
    expect(handle.assetBytes('asset-1')).toEqual(new Uint8Array([9, 8, 7, 6]))

    const snapshot = handle.documentSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(() => { (snapshot as any).metadata.title = 'MUTATED' }).toThrow()
    const fresh = handle.documentSnapshot()
    expect(fresh).not.toBe(snapshot)
    expect(fresh.metadata.title).toBe('Fixture')

    const encoded = encodeVerifiedEmbeddedBundle(handle)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('expected encode')
    expect(encoded.bytes).toEqual(built.canonical)
  })

  it('shares WeakMap provenance and rejects structural handle copies', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1, 2]), external: true }])
    const supervisor = successSupervisor(built.specs)
    const result = await decodeExternalBundleBytes(
      built.canonical,
      resolverOptions(supervisor.executor),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(encodeVerifiedEmbeddedBundle({ ...result.bundle })).toEqual({
      ok: false,
      error: { stage: 'handle', code: 'FORGED' },
    })
    expect(encodeVerifiedEmbeddedBundle(result.bundle).ok).toBe(true)
  })

  it('copies caller Map inputs in the shared private factory', () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1, 2, 3]) }])
    const documentBytes = canonicalBundleDocumentBytes(built.document)
    const wire = built.canonical.slice()
    const inputBytes = new Uint8Array([7, 7, 7])
    const map = new Map<string, Uint8Array>([['asset-1', inputBytes]])
    const handle = createVerifiedBundleHandle(
      '1.0.0',
      '0.1.0',
      sha256HexSync(documentBytes),
      built.bundleSha256,
      documentBytes,
      wire,
      map,
    )
    inputBytes.fill(0)
    wire.fill(0)
    expect(handle.assetBytes('asset-1')).toEqual(new Uint8Array([7, 7, 7]))
    const returned = handle.assetBytes('asset-1')!
    returned.fill(0)
    expect(handle.assetBytes('asset-1')).toEqual(new Uint8Array([7, 7, 7]))
    const encoded = encodeVerifiedEmbeddedBundle(handle)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('expected encode')
    expect(encoded.bytes).toEqual(built.canonical)
  })

  it('keeps the embedded decoder and encoder behavior unchanged', () => {
    const result = decodeEmbeddedBundleBytes(utf8(currentVector.canonical))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.bundle.bundleSha256).toBe(currentVector.sha256)
    expect(encodeVerifiedEmbeddedBundle(result.bundle)).toEqual({
      ok: true,
      bytes: utf8(currentVector.canonical),
    })
    expect(result.bundle.documentSnapshot().metadata.title)
      .toBe(JSON.parse(currentVector.canonical).document.metadata.title)
  })
})