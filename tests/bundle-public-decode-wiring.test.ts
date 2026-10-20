import { describe, expect, it } from 'vitest'
import vectors from './fixtures/bundle-canonical/vectors.json'
import * as bundle from '../src/bundle/index'
import {
  StructBundleError,
  createStructBundle,
  verifyStructBundle,
  decodeStructBundle,
  encodeStructBundle,
  STRUCT_BUNDLE_LIMITS_PROFILE,
} from '../src/bundle/index'
import { decodeEmbeddedBundleBytes } from '../src/bundle/embedded'
import { canonicalJsonBytes, canonicalBundleDocumentBytes, canonicalBundleEnvelopeBytes } from '../src/bundle/canonical'
import { sha256HexSync } from '../src/sha256'
import { seal, validDocument } from './codec-fixtures'
import {
  createFakeHostSupervisor,
  createFakeSupervisor,
  httpsPolicy,
} from './fixtures/resolver/fake-host'

const encoder = new TextEncoder()
const utf8 = (value: string) => encoder.encode(value)
const current = (vectors as any[]).find((value) => value.name === 'current:envelope')!

type AssetSpec = Readonly<{
  id: string
  bytes: Uint8Array
  external?: boolean
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
  const realDocSha = sha256HexSync(canonicalBundleDocumentBytes(document))
  const envelope = {
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256: realDocSha,
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

function successSupervisor(specs: readonly AssetSpec[]) {
  const bytesByDigest = new Map<string, Uint8Array>()
  for (const spec of specs) {
    if (spec.external) bytesByDigest.set(sha256HexSync(spec.bytes), spec.bytes.slice())
  }
  return createFakeSupervisor((request) => ({
    chunks: [bytesByDigest.get(request.expected.sha256) ?? new Uint8Array()],
  }))
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('unexpected acceptance')
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('unexpected acceptance')
}

describe('bundle public decode wiring', () => {
  it('exposes exactly seven runtime exports', () => {
    expect(Object.keys(bundle).sort()).toEqual([
      'STRUCT_BUNDLE_LIMITS_PROFILE',
      'STRUCT_BUNDLE_LIMITS_PROFILE_VERSION',
      'StructBundleError',
      'createStructBundle',
      'decodeStructBundle',
      'encodeStructBundle',
      'verifyStructBundle',
    ])
  })

  it('decode never throws synchronously and always returns a promise', async () => {
    let thrown: unknown
    let pending: unknown
    try {
      pending = decodeStructBundle(utf8('{bad'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeUndefined()
    expect(pending).toBeInstanceOf(Promise)
    await (pending as Promise<unknown>).catch(() => undefined)
  })

  it('embedded-only decode parity with pre-wiring facade', async () => {
    const handle = await decodeStructBundle(utf8(current.canonical))
    const embedded = decodeEmbeddedBundleBytes(utf8(current.canonical))
    expect(embedded.ok).toBe(true)
    if (!embedded.ok) throw new Error(JSON.stringify(embedded))
    expect(handle.bundleVersion).toBe(embedded.bundle.bundleVersion)
    expect(handle.schemaVersion).toBe(embedded.bundle.schemaVersion)
    expect(handle.documentSha256).toBe(embedded.bundle.documentSha256)
    expect(handle.bundleSha256).toBe(embedded.bundle.bundleSha256)
    expect(handle.bundleSha256).toBe(current.sha256)
    expect(encodeStructBundle(handle)).toEqual(utf8(current.canonical))
    const bytes = handle.assetBytes('asset-1')!
    bytes.fill(0)
    expect(handle.assetBytes('asset-1')).toEqual(new Uint8Array([0, 255, 128]))
  })

  it('failure codes for malformed, non-canonical and oversized input', async () => {
    const malformed = await rejectedBy(() => decodeStructBundle(utf8('{bad')))
    expect(malformed).toBeInstanceOf(StructBundleError)
    expect((malformed as StructBundleError).stage).toBe('canonical')
    expect((malformed as StructBundleError).code).toBe('SYNTAX')

    const pretty = utf8(JSON.stringify(JSON.parse(current.canonical), null, 2))
    const nonCanonical = await rejectedBy(() => decodeStructBundle(pretty))
    expect(nonCanonical).toBeInstanceOf(StructBundleError)
    expect((nonCanonical as StructBundleError).stage).toBe('canonical')
    expect((nonCanonical as StructBundleError).code).toBe('NONCANONICAL')

    const oversized = new Uint8Array(STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes + 1)
    const limit = await rejectedBy(() => decodeStructBundle(oversized))
    expect(limit).toBeInstanceOf(StructBundleError)
    expect((limit as StructBundleError).stage).toBe('input')
    expect((limit as StructBundleError).code).toBe('LIMIT')
  })

  it('external decode happy path with real executor, policy, budget and supervisor', async () => {
    const sourceBytes = new Uint8Array([9, 8, 7, 6])
    const built = buildBundle([{ id: 'asset-1', bytes: sourceBytes, external: true }])
    const supervisor = successSupervisor(built.specs)
    const host = createFakeHostSupervisor()
    const handle = await decodeStructBundle(built.canonical, {
      resolverExecutor: supervisor.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverHostSupervisor: host,
    })
    expect(handle.bundleSha256).toBe(built.bundleSha256)
    expect(handle.assetIds()).toEqual(['asset-1'])
    expect(handle.assetBytes('asset-1')).toEqual(sourceBytes)
    expect(encodeStructBundle(handle)).toEqual(built.canonical)
  })

  it('missing resolver configuration for external bundle -> UNRESOLVED with no handle', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])
    const error = await rejectedBy(() => decodeStructBundle(built.canonical)) as StructBundleError
    expect(error).toBeInstanceOf(StructBundleError)
    expect(error.stage).toBe('assets')
    expect(error.code).toBe('UNRESOLVED')
  })

  it('invalid budget -> BUDGET', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])
    const supervisor = successSupervisor(built.specs)
    const host = createFakeHostSupervisor()
    const error = await rejectedBy(() => decodeStructBundle(built.canonical, {
      resolverExecutor: supervisor.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 2, cleanupReserveMs: 2 },
      resolverHostSupervisor: host,
    })) as StructBundleError
    expect(error.stage).toBe('budget')
    expect(error.code).toBe('BUDGET')
  })

  it('invalid policy -> POLICY', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])
    const supervisor = successSupervisor(built.specs)
    const host = createFakeHostSupervisor()
    const error = await rejectedBy(() => decodeStructBundle(built.canonical, {
      resolverExecutor: supervisor.executor,
      resolverPolicy: {} as any,
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverHostSupervisor: host,
    })) as StructBundleError
    expect(error.code).toBe('POLICY')
  })

  it('fake signal -> OPTIONS', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])
    const supervisor = successSupervisor(built.specs)
    const host = createFakeHostSupervisor()
    const error = await rejectedBy(() => decodeStructBundle(built.canonical, {
      resolverExecutor: supervisor.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverHostSupervisor: host,
      resolverSignal: { aborted: false, addEventListener() {} } as any,
    })) as StructBundleError
    expect(error.stage).toBe('input')
    expect(error.code).toBe('OPTIONS')
  })

  it('expected digest mismatch -> MISMATCH', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]), external: true }])
    const supervisor = successSupervisor(built.specs)
    const host = createFakeHostSupervisor()
    const error = await rejectedBy(() => decodeStructBundle(built.canonical, {
      expectedBundleSha256: '0'.repeat(64),
      resolverExecutor: supervisor.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverHostSupervisor: host,
    })) as StructBundleError
    expect(error.stage).toBe('digest')
    expect(error.code).toBe('MISMATCH')
  })

  it('non-canonical bytes -> NONCANONICAL', async () => {
    const built = buildBundle([{ id: 'asset-1', bytes: new Uint8Array([1]) }])
    const pretty = utf8(JSON.stringify(JSON.parse(new TextDecoder().decode(built.canonical)), null, 2))
    const error = await rejectedBy(() => decodeStructBundle(pretty)) as StructBundleError
    expect(error.stage).toBe('canonical')
    expect(error.code).toBe('NONCANONICAL')
  })

  it('encode round-trip byte equality for external wire', async () => {
    const sourceBytes = new Uint8Array([9, 8, 7, 6])
    const built = buildBundle([{ id: 'asset-1', bytes: sourceBytes, external: true }])
    const supervisor = successSupervisor(built.specs)
    const host = createFakeHostSupervisor()
    const handle = await decodeStructBundle(built.canonical, {
      resolverExecutor: supervisor.executor,
      resolverPolicy: httpsPolicy(),
      resolverBudget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
      resolverHostSupervisor: host,
    })
    expect(encodeStructBundle(handle)).toEqual(built.canonical)
  })

  it('forged handle -> FORGED', () => {
    const error = thrownBy(() => encodeStructBundle({ bundleVersion: '1.0.0' })) as StructBundleError
    expect(error).toBeInstanceOf(StructBundleError)
    expect(error.stage).toBe('handle')
    expect(error.code).toBe('FORGED')
  })

  it('create and verify reject resolver options', () => {
    const input = { document: (validDocument() as any) }
    // ensure asset bytes present for create
    ;(input.document as any).assets[0].bytes = new Uint8Array([0, 255, 128])
    const createError = thrownBy(() => createStructBundle(input as any, {
      resolverExecutor: {},
    } as any)) as StructBundleError
    expect(createError.stage).toBe('input')
    expect(createError.code).toBe('OPTIONS')

    const verifyError = thrownBy(() => verifyStructBundle(JSON.parse(current.canonical), {
      resolverExecutor: {},
    } as any)) as StructBundleError
    expect(verifyError.stage).toBe('input')
    expect(verifyError.code).toBe('OPTIONS')
  })
})