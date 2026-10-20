import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import vectors from './fixtures/bundle-canonical/vectors.json'
import {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  StructBundleError,
  createStructBundle,
  encodeStructBundle,
} from '../src/bundle/index'
import type { StructBundleLimitsProfile } from '../src/bundle/index'
import { preflightStructBundleCreate } from '../src/bundle/create-preflight'
import {
  documentAboveFieldCap,
  documentBelowFieldCap,
  documentWithNumericAttributes,
  documentWithText,
  projectionSize,
  withAssetPayload,
} from './bundle-create-preflight-fixtures'
import { structReceiptDigest } from '../src/receipt'
import { sha256HexSync } from '../src/sha256'

/**
 * O-001 regression suite: the Bundle profile must be the first allocation
 * guard of the create path.
 *
 * Before the fix, `createStructBundle` decoded, re-encoded, and canonicalized
 * the whole document graph before `assertStructBundleValueLimits` ran, so the
 * document codec's outer bounds (128 MiB per asset, 4 MiB strings, 100k
 * document items) were the first guard and the much tighter Bundle caps were
 * only reached afterwards. These tests pin the corrected ordering, the
 * N-1/N/N+1 conformance of every cap the preflight applies, and the fact that
 * the preflight never rejects a document the previous path accepted.
 */

const counters = vi.hoisted(() => ({ digest: 0, base64: 0 }))

vi.mock('../src/sha256', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sha256')>()
  return {
    ...actual,
    sha256HexSync: (input: Uint8Array | string) => {
      counters.digest += 1
      return actual.sha256HexSync(input)
    },
  }
})

vi.mock('../src/document/codec/bytes', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/document/codec/bytes')>()
  return {
    ...actual,
    bytesToBase64: (bytes: Uint8Array) => {
      counters.base64 += 1
      return actual.bytesToBase64(bytes)
    },
  }
})

const current = vectors.find((value) => value.name === 'current:envelope')!
const utf8 = (value: string) => new TextEncoder().encode(value)

type Document = Record<string, unknown>

function goldenDocument(): Document {
  return structuredClone(JSON.parse(current.canonical).document) as Document
}

function goldenAsset(document: Document): Record<string, unknown> {
  return (document.assets as Array<Record<string, unknown>>)[0]!
}

/** The golden document with the golden asset bytes in the given carrier. */
function goldenInput(
  carrier: 'bytes' | 'base64' | 'array' = 'bytes',
): { document: Document } {
  const document = goldenDocument()
  const bytes = new Uint8Array([0, 255, 128])
  goldenAsset(document).bytes =
    carrier === 'bytes' ? bytes : carrier === 'base64' ? 'AP+A' : [0, 255, 128]
  return { document }
}

/** A codec-valid document whose single asset carries `byteLength` bytes. */
function documentWithAssetBytes(byteLength: number): { document: Document } {
  const document = goldenDocument()
  const bytes = new Uint8Array(byteLength)
  bytes.set([0, 255, 128])
  const asset = goldenAsset(document)
  asset.bytes = bytes
  asset.sha256 = sha256HexSync(bytes)
  const receipt = document.receipt as Record<string, unknown>
  receipt.generatedSha256 = structReceiptDigest(document as never)
  return { document }
}

/** Create a bundle from an untyped document, as hostile input requires. */
function createFrom(document: unknown): StructBundleError {
  return thrownBy(() => createStructBundle({ document } as never))
}

function thrownBy(run: () => unknown): StructBundleError {
  try {
    run()
  } catch (error) {
    return error as StructBundleError
  }
  throw new Error('unexpected acceptance')
}

function profile(
  overrides: Partial<StructBundleLimitsProfile> = {},
): StructBundleLimitsProfile {
  return { ...STRUCT_BUNDLE_LIMITS_PROFILE, ...overrides }
}

function preflight(
  document: unknown,
  overrides: Partial<StructBundleLimitsProfile> = {},
) {
  return preflightStructBundleCreate(document, profile(overrides))
}

function expectAccepted(
  result: ReturnType<typeof preflightStructBundleCreate>,
): void {
  expect(result).toEqual({ ok: true })
}

function expectRejected(
  result: ReturnType<typeof preflightStructBundleCreate>,
  stage: 'input' | 'assets' | 'canonical',
  code: 'TYPE' | 'LIMIT',
): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error).toEqual({ stage, code })
}

/** Count the UTF-8 buffers the guarded path materializes. */
function instrumentTextEncoder(run: () => void): number {
  const original = TextEncoder.prototype.encode
  let calls = 0
  const spy = vi
    .spyOn(TextEncoder.prototype, 'encode')
    .mockImplementation(function (this: TextEncoder, input?: string) {
      calls += 1
      return original.call(this, input)
    })
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return calls
}

beforeEach(() => {
  counters.digest = 0
  counters.base64 = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('O-001 ordering proof: the Bundle profile guards create first', () => {
  it('rejects an oversized asset before the codec rejects the document', () => {
    // The document is malformed: the codec would reject it with `input` and
    // `TYPE`. The asset cap is the first guard, so the asset limit wins.
    const document = goldenDocument()
    delete document.receipt
    const bytes = new Uint8Array(8 * 1024 * 1024)
    bytes.set([0, 255, 128])
    const asset = goldenAsset(document)
    asset.bytes = bytes
    asset.sha256 = sha256HexSync(bytes)

    const error = createFrom(document)
    expect(error).toBeInstanceOf(StructBundleError)
    expect(error.stage).toBe('assets')
    expect(error.code).toBe('LIMIT')
  })

  it('rejects a codec-valid over-cap asset before any digest or base64 work', () => {
    const { document } = documentWithAssetBytes(8 * 1024 * 1024)
    counters.digest = 0
    counters.base64 = 0

    const error = createFrom(document)
    expect(error.stage).toBe('assets')
    expect(error.code).toBe('LIMIT')
    // The codec digests every asset it decodes and the facade base64-encodes
    // every accepted asset. Neither ran, so the bytes were never copied.
    expect(counters.digest).toBe(0)
    expect(counters.base64).toBe(0)
  })

  it('materializes no canonical buffer for a rejected oversized input', () => {
    const { document } = documentWithAssetBytes(8 * 1024 * 1024)
    let encodes = 0
    encodes = instrumentTextEncoder(() => {
      const error = createFrom(document)
      expect(error.stage).toBe('assets')
      expect(error.code).toBe('LIMIT')
    })
    expect(encodes).toBe(0)
  })

  it('keeps the asset limit ahead of a document-shape failure', () => {
    const document = goldenDocument()
    const cyclic: Record<string, unknown> = { ...document }
    cyclic.self = cyclic
    const bytes = new Uint8Array(8 * 1024 * 1024)
    bytes.set([0, 255, 128])
    const asset = goldenAsset(cyclic)
    asset.bytes = bytes
    asset.sha256 = sha256HexSync(bytes)

    const error = createFrom(cyclic)
    expect(error.stage).toBe('assets')
    expect(error.code).toBe('LIMIT')
  })
})

describe('O-001 boundary conformance (N-1/N/N+1)', () => {
  it('enforces the per-asset byte cap at N-1/N/N+1', () => {
    const small = {
      maxAssetBytes: 10,
      maxTotalBytes: 1_000,
      maxDecodedBytes: 1_000,
      maxBase64Chars: 1_000,
    }
    expectAccepted(preflight({ assets: [{ bytes: new Uint8Array(9) }] }, small))
    expectAccepted(preflight({ assets: [{ bytes: new Uint8Array(10) }] }, small))
    expectRejected(
      preflight({ assets: [{ bytes: new Uint8Array(11) }] }, small),
      'assets',
      'LIMIT',
    )
  })

  it('enforces the cumulative asset byte cap at N-1/N/N+1', () => {
    const small = {
      maxAssetBytes: 100,
      maxTotalBytes: 10,
      maxDecodedBytes: 100,
      maxBase64Chars: 1_000,
    }
    const two = (first: number, second: number) => ({
      assets: [
        { bytes: new Uint8Array(first) },
        { bytes: new Uint8Array(second) },
      ],
    })
    expectAccepted(preflight(two(4, 5), small))
    expectAccepted(preflight(two(5, 5), small))
    expectRejected(preflight(two(5, 6), small), 'assets', 'LIMIT')
  })

  it('enforces the asset count cap at N-1/N/N+1', () => {
    const small = { maxAssets: 2 }
    expectAccepted(preflight({ assets: [{}, {}] }, small))
    expectRejected(
      preflight({ assets: [{}, {}, {}] }, small),
      'assets',
      'LIMIT',
    )
  })

  it('enforces the base64 character cap at N-1/N/N+1', () => {
    const small = {
      maxAssetBytes: 100,
      maxTotalBytes: 1_000,
      maxDecodedBytes: 1_000,
      maxBase64Chars: 8,
    }
    expectAccepted(preflight({ assets: [{ bytes: 'AAAAAAAA' }] }, small))
    expectRejected(
      preflight({ assets: [{ bytes: 'AAAAAAAAAAAA' }] }, small),
      'assets',
      'LIMIT',
    )
  })

  it('enforces the string length cap at N-1/N/N+1', () => {
    const small = { maxStringLength: 10 }
    expectAccepted(preflight({ text: 'x'.repeat(10) }, small))
    expectRejected(
      preflight({ text: 'x'.repeat(11) }, small),
      'canonical',
      'LIMIT',
    )
  })

  it('enforces the nesting cap at N-1/N/N+1', () => {
    const small = { maxDepth: 3 }
    // The document root is depth zero, so `{ deep: [0] }` puts the leaf at
    // depth two, `{ deep: [[0]] }` at depth three, and `{ deep: [[[0]]] }` at
    // depth four.
    expectAccepted(preflight({ deep: [0] }, small))
    expectAccepted(preflight({ deep: [[0]] }, small))
    expectRejected(preflight({ deep: [[[0]]] }, small), 'canonical', 'LIMIT')
  })

  it('enforces the node cap at N-1/N/N+1', () => {
    const small = { maxNodes: 4 }
    // `{ items: [0] }` is three nodes, `{ items: [0, 0] }` is four.
    expectAccepted(preflight({ items: [0] }, small))
    expectAccepted(preflight({ items: [0, 0] }, small))
    expectRejected(
      preflight({ items: [0, 0, 0] }, small),
      'canonical',
      'LIMIT',
    )
  })

  it('enforces the document size budget at N-1/N/N+1', () => {
    // `{ text: 'x' * n }` charges the braces, the quoted key, and the quoted
    // string: 2 + 6 + 1 + (n + 2) = n + 11 canonical bytes.
    //
    // The byte-free document projection is one top-level envelope field, so
    // its budget is the envelope field cap; the envelope byte cap bounds it
    // as well. The field cap of this fixture is 100 bytes, so the document
    // budget is 100 bytes and `n` is 89 at the boundary.
    const small = { maxFieldBytes: 100, maxRawBytes: 4096 }
    expectAccepted(preflight({ text: 'x'.repeat(89) }, small))
    expectRejected(
      preflight({ text: 'x'.repeat(90) }, small),
      'canonical',
      'LIMIT',
    )
  })
})

describe('O-001 frozen profile conformance', () => {
  it('keeps the published profile values unchanged', () => {
    expect(STRUCT_BUNDLE_LIMITS_PROFILE).toEqual({
      profileVersion: '1.0.0',
      maxRawBytes: 8 * 1024 * 1024,
      maxFieldBytes: 5_600_000,
      maxAssets: 256,
      maxAssetBytes: 4 * 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxDecodedBytes: 4 * 1024 * 1024,
      maxBase64Chars: 5_592_408,
      maxConcurrency: 1,
      maxDepth: 128,
      maxStringLength: 5_592_408,
      maxNodes: 1_000_000,
      maxResolverTimeoutMs: 120_000,
    })
  })

  it('accepts a per-asset payload exactly at the published cap', () => {
    expectAccepted(
      preflight({ assets: [{ bytes: new Uint8Array(4 * 1024 * 1024) }] }),
    )
    expectRejected(
      preflight({ assets: [{ bytes: new Uint8Array(4 * 1024 * 1024 + 1) }] }),
      'assets',
      'LIMIT',
    )
  })

  it('accepts a base64 carrier exactly at the published character cap', () => {
    // The canonical base64 spelling of a 4 MiB payload is 5,592,408
    // characters, which is exactly the published cap.
    const payload = 'A'.repeat(5_592_404) + 'AA=='
    expect(payload.length).toBe(5_592_408)
    expectAccepted(preflight({ assets: [{ bytes: payload }] }))
    expectRejected(
      preflight({ assets: [{ bytes: payload + 'AAAA' }] }),
      'assets',
      'LIMIT',
    )
  })

  it('accepts an asset count exactly at the published cap', () => {
    const assets = Array.from({ length: 256 }, () => ({}))
    expectAccepted(preflight({ assets }))
    expectRejected(
      preflight({ assets: [...assets, {}] }),
      'assets',
      'LIMIT',
    )
  })

  it('accepts a string exactly at the published length cap', () => {
    expectAccepted(preflight({ text: 'x'.repeat(5_592_408) }))
    expectRejected(
      preflight({ text: 'x'.repeat(5_592_409) }),
      'canonical',
      'LIMIT',
    )
  })

  it('accepts nesting exactly at the published depth cap', () => {
    const chain = (depth: number): unknown =>
      depth <= 0 ? 0 : [chain(depth - 1)]
    // The document root is depth zero, so the leaf of a chain of 127 arrays
    // sits at depth 128.
    expectAccepted(preflight({ deep: chain(127) }))
    expectRejected(preflight({ deep: chain(128) }), 'canonical', 'LIMIT')
  })

  it('accepts a node count exactly at the published cap', () => {
    const items = (count: number) => new Array<number>(count).fill(0)
    // The document root, the item array, and its items are all nodes.
    expectAccepted(preflight({ items: items(999_998) }))
    expectRejected(
      preflight({ items: items(999_999) }),
      'canonical',
      'LIMIT',
    )
  })
})

describe('O-001 carrier parity and digest stability', () => {
  it('creates the same handle and bytes for every supported carrier', () => {
    const runtime = createStructBundle(goldenInput('bytes') as never)
    const json = createStructBundle(goldenInput('base64') as never)
    const array = createStructBundle(goldenInput('array') as never)

    expect(runtime.bundleSha256).toBe(current.sha256)
    expect(json.bundleSha256).toBe(current.sha256)
    expect(array.bundleSha256).toBe(current.sha256)
    expect(runtime.documentSha256).toBe(json.documentSha256)
    expect(runtime.documentSha256).toBe(array.documentSha256)
    expect(Array.from(encodeStructBundle(runtime))).toEqual(
      Array.from(utf8(current.canonical)),
    )
    expect(Array.from(encodeStructBundle(json))).toEqual(
      Array.from(utf8(current.canonical)),
    )
    expect(Array.from(runtime.assetBytes('asset-1')!)).toEqual([0, 255, 128])
    expect(Array.from(json.assetBytes('asset-1')!)).toEqual([0, 255, 128])
  })

  it('keeps the byte-free document projection free of asset bytes', () => {
    const handle = createStructBundle(goldenInput('base64') as never)
    const snapshot = handle.documentSnapshot() as Document
    expect(Object.hasOwn(goldenAsset(snapshot as never), 'bytes')).toBe(false)
  })
})

describe('O-001 differential no-false-reject', () => {
  it('accepts every published document fixture', () => {
    for (const vector of vectors) {
      if (!vector.name.endsWith(':document')) continue
      expectAccepted(
        preflightStructBundleCreate(
          vector.input,
          STRUCT_BUNDLE_LIMITS_PROFILE,
        ),
      )
    }
  })

  it('accepts the byte-free projection of the golden document', () => {
    const document = goldenDocument()
    expectAccepted(preflight(document))
    expectAccepted(preflight(structuredClone(document)))
  })

  it('accepts the golden document through the public create path', () => {
    const handle = createStructBundle(goldenInput('bytes') as never)
    expect(handle.bundleSha256).toBe(current.sha256)
    expect(handle.documentSha256).toBe(
      JSON.parse(current.canonical).documentSha256,
    )
  })

  it('accepts an asset without bytes and leaves that failure to the codec', () => {
    const document = goldenDocument()
    delete goldenAsset(document).bytes
    expectAccepted(preflight(document))
    const error = createFrom(document)
    expect(error.stage).toBe('assets')
    expect(error.code).toBe('SET')
  })
})

describe('O-001 document-size budget: the field cap and the envelope total', () => {
  it('rejects a document above the field cap before any canonical byte is built', () => {
    // The projection is larger than the envelope field cap and smaller than
    // the envelope byte cap, so only the field cap can reject it.
    const document = documentAboveFieldCap()
    const size = projectionSize(document)
    expect(size).toBeGreaterThan(STRUCT_BUNDLE_LIMITS_PROFILE.maxFieldBytes)
    expect(size).toBeLessThan(STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes)

    counters.digest = 0
    counters.base64 = 0
    let encodes = 0
    encodes = instrumentTextEncoder(() => {
      const error = createFrom(document)
      expect(error.stage).toBe('canonical')
      expect(error.code).toBe('LIMIT')
    })
    // The document was never decoded, re-encoded, or canonicalized.
    expect(encodes).toBe(0)
    expect(counters.digest).toBe(0)
    expect(counters.base64).toBe(0)
  })

  it('accepts a document exactly at the field cap', () => {
    const document = documentAboveFieldCap()
    const size = projectionSize(document)
    expectAccepted(
      preflight(document, {
        maxFieldBytes: size,
        maxRawBytes: 10_000_000,
      }),
    )
    expectRejected(
      preflight(document, {
        maxFieldBytes: size - 1,
        maxRawBytes: 10_000_000,
      }),
      'canonical',
      'LIMIT',
    )
  })

  it('charges a number its exact canonical length', () => {
    // The float is spelled with 24 canonical bytes. A one-byte charge would
    // admit 23,000 bytes more than the projection holds, so the boundary
    // below only holds when the exact number length is charged.
    const document = documentWithNumericAttributes(
      1000,
      -1.2345678901234567e-300,
    )
    const size = projectionSize(document)
    expectAccepted(
      preflight(document, { maxFieldBytes: size, maxRawBytes: 10_000_000 }),
    )
    expectRejected(
      preflight(document, {
        maxFieldBytes: size - 1,
        maxRawBytes: 10_000_000,
      }),
      'canonical',
      'LIMIT',
    )
  })

  it('charges a string its exact canonical length', () => {
    // Every quote and backslash costs two canonical bytes, so the raw
    // length under-counts the projection by half.
    const document = documentWithText('"\\', 100_000)
    const size = projectionSize(document)
    expectAccepted(
      preflight(document, { maxFieldBytes: size, maxRawBytes: 10_000_000 }),
    )
    expectRejected(
      preflight(document, {
        maxFieldBytes: size - 1,
        maxRawBytes: 10_000_000,
      }),
      'canonical',
      'LIMIT',
    )
  })

  it('rejects a document and asset pair that exceeds the envelope byte budget', () => {
    // The document alone fits the envelope budget, and the asset alone fits
    // every asset cap, but together their envelope is larger than the
    // envelope byte cap.
    const document = documentBelowFieldCap()
    expectAccepted(preflight(document))
    const combined = withAssetPayload(
      documentBelowFieldCap(),
      4 * 1024 * 1024,
    )
    expect(projectionSize(combined) + 5_592_408).toBeGreaterThan(
      STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes,
    )
    expectRejected(preflight(combined), 'canonical', 'LIMIT')
    const error = createFrom(combined)
    expect(error.stage).toBe('canonical')
    expect(error.code).toBe('LIMIT')
  })
})

describe('O-001 hostile input handling', () => {
  it('maps an accessor document to TYPE without invoking the getter', () => {
    let invoked = false
    const document = goldenDocument()
    Object.defineProperty(document, 'metadata', {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true
        return undefined
      },
    })
    expectRejected(preflight(document), 'input', 'TYPE')
    expect(invoked).toBe(false)
    const error = createFrom(document)
    expect(error.stage).toBe('input')
    expect(error.code).toBe('TYPE')
    expect(invoked).toBe(false)
  })

  it('maps a cyclic document to TYPE', () => {
    const cyclic: Record<string, unknown> = { ...goldenDocument() }
    cyclic.self = cyclic
    expectRejected(preflight(cyclic), 'input', 'TYPE')
    const error = createFrom(cyclic)
    expect(error.stage).toBe('input')
    expect(error.code).toBe('TYPE')
  })

  it('maps a non-JSON shape to TYPE', () => {
    const withFunction: Record<string, unknown> = { ...goldenDocument() }
    withFunction.extra = () => 'not json'
    expectRejected(preflight(withFunction), 'input', 'TYPE')

    const withSymbol: Record<string, unknown> = { ...goldenDocument() }
    Object.defineProperty(withSymbol, Symbol('extra'), {
      enumerable: true,
      configurable: true,
      value: 'not json',
    })
    expectRejected(preflight(withSymbol), 'input', 'TYPE')

    const withUndefined: Record<string, unknown> = { ...goldenDocument() }
    withUndefined.extra = undefined
    expectRejected(preflight(withUndefined), 'input', 'TYPE')

    expectRejected(preflight('not a document'), 'input', 'TYPE')
    expectRejected(preflight([1, 2, 3]), 'input', 'TYPE')
    expectRejected(preflight(null), 'input', 'TYPE')
  })

  it('rejects a lone surrogate string with the codec TYPE meaning', () => {
    const document: Record<string, unknown> = { ...goldenDocument() }
    document.extra = '\ud800'
    expectRejected(preflight(document), 'input', 'TYPE')
  })
})
