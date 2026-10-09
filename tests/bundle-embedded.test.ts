import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { canonicalBundleDocumentBytes, canonicalBundleEnvelopeBytes } from '../src/bundle/canonical'
import { seal, validDocument } from './codec-fixtures'
import { canonicalJsonBytes } from '../src/bundle/canonical'
import vectors from './fixtures/bundle-canonical/vectors.json'

import * as api from '../src/bundle/embedded'
const utf8 = (value: string) => new TextEncoder().encode(value)
const vector = vectors.find((value) => value.name === 'current:envelope')!
function acceptance() {
  expect(typeof api?.decodeEmbeddedBundleBytes).toBe('function')
  expect(typeof api?.encodeVerifiedEmbeddedBundle).toBe('function')
  return api!
}

describe('private complete embedded Bundle acceptance', () => {
  it('accepts a frozen valid wire and encodes exactly its independently pinned bytes', () => {
    const { decodeEmbeddedBundleBytes, encodeVerifiedEmbeddedBundle } = acceptance()
    const result = decodeEmbeddedBundleBytes(utf8(vector.canonical))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.bundle.bundleSha256).toBe(vector.sha256)
    expect(encodeVerifiedEmbeddedBundle(result.bundle)).toEqual({ ok: true, bytes: utf8(vector.canonical) })
  })

  it('checks an expected raw digest before interpreting malformed JSON', () => {
    const { decodeEmbeddedBundleBytes } = acceptance()
    expect(decodeEmbeddedBundleBytes(utf8('{bad'), { expectedBundleSha256: '0'.repeat(64) }))
      .toEqual({ ok: false, error: { stage: 'digest', code: 'MISMATCH' } })
  })

  it('refuses canonical envelope shape when embedded bytes fail the bound digest', () => {
    const { decodeEmbeddedBundleBytes } = acceptance()
    const value = JSON.parse(vector.canonical)
    value.assets[0].payload.base64 = 'AAAA'
    expect(decodeEmbeddedBundleBytes(canonicalJsonBytes(value)))
      .toEqual({ ok: false, error: { stage: 'assets', code: 'DIGEST' } })
  })

  it('retains immutable copies and rejects a structurally copied handle', () => {
    const { decodeEmbeddedBundleBytes, encodeVerifiedEmbeddedBundle } = acceptance()
    const raw = utf8(vector.canonical)
    const result = decodeEmbeddedBundleBytes(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    raw.fill(0)
    const bytes = result.bundle.assetBytes('asset-1')
    expect(bytes).toEqual(new Uint8Array([0, 255, 128]))
    bytes!.fill(0)
    expect(result.bundle.assetBytes('asset-1')).toEqual(new Uint8Array([0, 255, 128]))
    expect(encodeVerifiedEmbeddedBundle({ ...result.bundle }))
      .toEqual({ ok: false, error: { stage: 'handle', code: 'FORGED' } })
    expect(encodeVerifiedEmbeddedBundle(result.bundle)).toEqual({ ok: true, bytes: utf8(vector.canonical) })
  })

  it('refuses external payloads without providing an executor option', () => {
    const { decodeEmbeddedBundleBytes } = acceptance()
    const value = JSON.parse(vector.canonical)
    value.assets[0].payload = { kind: 'external', resourceId: 'sha256:' + value.assets[0].sha256 }
    expect(decodeEmbeddedBundleBytes(canonicalJsonBytes(value)))
      .toEqual({ ok: false, error: { stage: 'assets', code: 'UNRESOLVED' } })
  })
})


const digest = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex')
const decoded = (raw: Uint8Array) => {
  const result = api.decodeEmbeddedBundleBytes(raw)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result.bundle
}
function envelopeWithAssets(sizes: number[], ids = sizes.map((_, i) => `asset-${i + 1}`)) {
  const document = validDocument()
  const original = document.assets[0]!
  const records = sizes.map((size, index) => {
    const bytes = Buffer.alloc(size, index % 256)
    return { id: ids[index]!, sha256: digest(bytes), mediaType: original.mediaType,
      byteLength: size, payload: { kind: 'embedded', base64: bytes.toString('base64') } }
  })
  document.assets = records.map((record) => {
    const asset = { ...original, id: record.id, href: `assets/${record.id}.bin`, sha256: record.sha256 }
    delete (asset as Record<string, unknown>).bytes
    return asset
  })
  document.receipt.assetCount = sizes.length
  document.receipt.conservation.sourceAssetCount = sizes.length
  document.receipt.conservation.accountedSourceAssetCount = sizes.length
  document.receipt.conservation.structAssetCount = sizes.length
  seal(document)
  return { mediaType: 'application/vnd.erniesg.struct+json', bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion, documentSha256: digest(canonicalBundleDocumentBytes(document)),
    document, assets: records, receipt: document.receipt }
}
function rejected(raw: Uint8Array, stage: string, code: string) {
  expect(api.decodeEmbeddedBundleBytes(raw)).toEqual({ ok: false, error: { stage, code } })
}

describe('private embedded acceptance captured inputs and bounded failures', () => {
  it.each(vectors.filter((v) => v.name.endsWith(':envelope')))('$name accepts its pinned expected digest', (v) => {
    const result = api.decodeEmbeddedBundleBytes(utf8(v.canonical), { expectedBundleSha256: v.sha256 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.bundle.bundleSha256).toBe(v.sha256)
    expect(api.encodeVerifiedEmbeddedBundle(result.bundle)).toEqual({ ok: true, bytes: utf8(v.canonical) })
  })

  it('a matching digest of malformed bytes still fails parsing', () => {
    const raw = utf8('{bad')
    expect(api.decodeEmbeddedBundleBytes(raw, { expectedBundleSha256: digest(raw) }))
      .toEqual({ ok: false, error: { stage: 'canonical', code: 'SYNTAX' } })
  })

  it('takes the caller raw copy only once, before hashing or parsing it', () => {
    const raw = utf8(vector.canonical)
    const original = Uint8Array.prototype.set
    let callerCopies = 0
    const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, source, offset) {
      original.call(this, source, offset)
      if (source === raw) { callerCopies += 1; raw.fill(0) }
    })
    let result
    try { result = api.decodeEmbeddedBundleBytes(raw, { expectedBundleSha256: vector.sha256 }) }
    finally { spy.mockRestore() }
    expect(callerCopies).toBe(1)
    expect(result!.ok).toBe(true)
    if (!result!.ok) throw new Error(JSON.stringify(result))
    expect(api.encodeVerifiedEmbeddedBundle(result!.bundle)).toEqual({ ok: true, bytes: utf8(vector.canonical) })
  })

  it('never invokes caller byte length, iterator or option accessors', () => {
    const raw = utf8(vector.canonical)
    const getter = vi.fn(() => { throw new Error('untrusted getter') })
    Object.defineProperty(raw, 'byteLength', { get: getter })
    Object.defineProperty(raw, Symbol.iterator, { get: getter })
    expect(api.decodeEmbeddedBundleBytes(raw).ok).toBe(true)
    const options = Object.defineProperty({}, 'expectedBundleSha256', { get: getter, enumerable: true })
    expect(api.decodeEmbeddedBundleBytes(raw, options)).toEqual({ ok: false, error: { stage: 'input', code: 'OPTIONS' } })
    expect(getter).not.toHaveBeenCalled()
  })

  it('accepts omitted and empty options, rejects explicitly supplied undefined', () => {
    const raw = utf8(vector.canonical)
    expect(api.decodeEmbeddedBundleBytes(raw).ok).toBe(true)
    expect(api.decodeEmbeddedBundleBytes(raw, {}).ok).toBe(true)
    expect(api.decodeEmbeddedBundleBytes(raw, Object.create(null)).ok).toBe(true)
    expect(api.decodeEmbeddedBundleBytes(raw, undefined)).toEqual({ ok: false, error: { stage: 'input', code: 'OPTIONS' } })
  })

  it.each([null, true, 1, '', [], new String(''), { expectedBundleSha256: undefined },
    { expectedBundleSha256: 'A'.repeat(64) }, { expectedBundleSha256: 'a'.repeat(63) },
    { expectedBundleSha256: 'a'.repeat(65) }, { expectedBundleSha256: 'a'.repeat(64) + '\n' },
    { expectedBundleSha256: 'a'.repeat(64) + '\r' }, { expectedBundleSha256: new String('a'.repeat(64)) },
    { executor: () => { throw new Error('must never run') } }, { [Symbol('extra')]: 1 },
    Object.create({ expectedBundleSha256: 'a'.repeat(64) }),
    new Proxy({}, { ownKeys() { throw new Error('private arbitrary exception') } }),
  ])('refuses malformed or capability-bearing options %# with closed failure', (options) => {
    expect(api.decodeEmbeddedBundleBytes(utf8(vector.canonical), options as any))
      .toEqual({ ok: false, error: { stage: 'input', code: 'OPTIONS' } })
  })

  it.each([null, undefined, {}, [], new Uint16Array(1), new DataView(new ArrayBuffer(1)),
    new Proxy(new Uint8Array(1), {})])('refuses non-byte-view input %#', (raw) => {
    expect(api.decodeEmbeddedBundleBytes(raw as Uint8Array))
      .toEqual({ ok: false, error: { stage: 'input', code: 'TYPE' } })
  })
})

describe('private embedded complete envelope integrity', () => {
  it.each(['missing', 'extra', 'duplicate', 'metadata', 'base64', 'length', 'unknown-key'])('refuses %s asset inconsistency', (kind) => {
    const value = JSON.parse(vector.canonical)
    let stage = 'assets'; let code = 'SET'
    if (kind === 'missing') value.assets = []
    if (kind === 'extra') value.assets.push({ ...value.assets[0], id: 'asset-extra' })
    if (kind === 'duplicate') { value.assets.push(value.assets[0]); stage = 'canonical'; code = 'TYPE' }
    if (kind === 'metadata') { value.assets[0].mediaType = 'image/png'; code = 'METADATA' }
    if (kind === 'base64') { value.assets[0].payload.base64 = 'AP+A\n'; code = 'BASE64' }
    if (kind === 'length') { value.assets[0].byteLength = 2; code = 'BASE64' }
    if (kind === 'unknown-key') { value.assets[0].secret = 'no'; stage = 'canonical'; code = 'TYPE' }
    rejected(canonicalJsonBytes(value), stage, code)
  })

  it('rejects an independently valid but unequal outer receipt', () => {
    const value = JSON.parse(vector.canonical)
    value.receipt = JSON.parse(vectors.find((v) => v.name === 'current-title:envelope')!.canonical).receipt
    rejected(canonicalJsonBytes(value), 'canonical', 'TYPE')
  })

  it.each(['mediaType', 'bundleVersion', 'schemaVersion', 'documentSha256'])('refuses changed envelope %s', (key) => {
    const value = JSON.parse(vector.canonical); value[key] = 'invalid'
    rejected(canonicalJsonBytes(value), 'canonical', 'TYPE')
  })

  it('rejects unknown document fields and embedded document byte carriers', () => {
    for (const update of [(v: any) => { v.document.secret = 'no' }, (v: any) => { v.document.assets[0].bytes = 'AP+A' }]) {
      const value = JSON.parse(vector.canonical); update(value)
      rejected(canonicalJsonBytes(value), 'canonical', 'TYPE')
    }
  })

  it('rejects unsorted array wire even when JSON object encoding is canonical', () => {
    const value = envelopeWithAssets([3, 3, 3], ['asset-1', 'asset-z', 'asset-a'])
    const canonical = canonicalBundleEnvelopeBytes(value)
    expect(decoded(canonical).assetIds()).toEqual(['asset-1', 'asset-a', 'asset-z'])
    rejected(canonicalJsonBytes(value), 'canonical', 'NONCANONICAL')
  })

  it.each(['duplicate', 'space', 'bom', 'utf8'])('rejects noncanonical raw wire %s', (kind) => {
    let raw = utf8(vector.canonical)
    if (kind === 'duplicate') raw = utf8(vector.canonical.replace('"bundleVersion":"1.0.0"', '"bundleVersion":"1.0.0","bundleVersion":"1.0.0"'))
    if (kind === 'space') raw = utf8(vector.canonical + ' ')
    if (kind === 'bom') raw = new Uint8Array([239, 187, 191, ...raw])
    if (kind === 'utf8') raw = new Uint8Array([255])
    rejected(raw, 'canonical', kind === 'utf8' ? 'SYNTAX' : 'NONCANONICAL')
  })
})

describe('private genuine handle and read isolation', () => {
  it('returns frozen fresh document descendants and ID arrays plus byte copies', () => {
    const bundle = decoded(utf8(vector.canonical))
    expect(Object.isFrozen(bundle)).toBe(true)
    const document = bundle.documentSnapshot()
    function walk(value: unknown) {
      if (value !== null && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true)
        expect(Reflect.set(value, 'untrusted-added-key', 1)).toBe(false)
        for (const child of Object.values(value)) walk(child)
      }
    }
    walk(document)
    expect(bundle.documentSnapshot()).not.toBe(document)
    const ids = bundle.assetIds(); expect(Object.isFrozen(ids)).toBe(true)
    expect(Reflect.set(ids, '0', 'changed')).toBe(false)
    expect(bundle.assetIds()).not.toBe(ids)
    for (const id of ids) {
      const bytes = bundle.assetBytes(id)!; const before = bytes.slice()
      bytes.fill(1); expect(bundle.assetBytes(id)).toEqual(before)
    }
    expect(bundle.assetBytes('absent')).toBeUndefined()
    const encoded = api.encodeVerifiedEmbeddedBundle(bundle)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error(JSON.stringify(encoded))
    encoded.bytes.fill(0)
    expect(api.encodeVerifiedEmbeddedBundle(bundle)).toEqual({ ok: true, bytes: utf8(vector.canonical) })
    expect(bundle.documentSnapshot()).toEqual(JSON.parse(vector.canonical).document)
  })

  it('refuses fake, spread, inherited, proxy, primitive and deserialized handles', () => {
    const bundle = decoded(utf8(vector.canonical))
    const trap = vi.fn(() => { throw new Error('must not reflect a handle') })
    for (const value of [null, undefined, true, 1, 'x', () => {}, {}, { ...bundle },
      Object.create(bundle), new Proxy(bundle, {}), new Proxy({}, { get: trap, getPrototypeOf: trap }),
      JSON.parse(JSON.stringify(bundle))]) {
      expect(api.encodeVerifiedEmbeddedBundle(value)).toEqual({ ok: false, error: { stage: 'handle', code: 'FORGED' } })
    }
    expect(trap).not.toHaveBeenCalled()
    expect(api.encodeVerifiedEmbeddedBundle(bundle).ok).toBe(true)
  })
})

describe('private embedded fixed resource conjunction', () => {
  it.each([-1, 0, 1])('enforces raw 8MiB cap at N%+i before parse', (delta) => {
    const raw = new Uint8Array(8 * 1024 * 1024 + delta).fill(32)
    rejected(raw, delta > 0 ? 'input' : 'canonical', delta > 0 ? 'LIMIT' : 'SYNTAX')
  })

  it.each([255, 256, 257])('enforces asset-count cap at %i records', (count) => {
    const raw = canonicalBundleEnvelopeBytes(envelopeWithAssets(Array(count).fill(0)))
    if (count <= 256) expect(decoded(raw).assetIds()).toHaveLength(count)
    else rejected(raw, 'assets', 'LIMIT')
  })

  it.each([-1, 0, 1])('enforces 4MiB per-asset cap at N%+i', (delta) => {
    const size = 4 * 1024 * 1024 + delta
    const raw = canonicalBundleEnvelopeBytes(envelopeWithAssets([size]))
    if (delta <= 0) expect(decoded(raw).assetBytes('asset-1')).toHaveLength(size)
    else rejected(raw, 'assets', 'LIMIT')
  })

  it.each([-1, 0, 1])('enforces 4MiB aggregate cap across two assets at N%+i', (delta) => {
    const raw = canonicalBundleEnvelopeBytes(envelopeWithAssets([2 * 1024 * 1024, 2 * 1024 * 1024 + delta]))
    if (delta <= 0) expect(decoded(raw).assetIds()).toHaveLength(2)
    else rejected(raw, 'assets', 'LIMIT')
  })

  it.each([-1, 1])('enforces base64 character boundary N%+i; misaligned lower neighbor is not valid base64', (delta) => {
    const value = JSON.parse(vector.canonical)
    value.assets[0].payload.base64 = 'A'.repeat(5_592_408 + delta)
    rejected(canonicalJsonBytes(value), 'assets', delta > 0 ? 'LIMIT' : 'BASE64')
  })

  it('refuses declared decoded pressure before allocating a decoded buffer', () => {
    const value = JSON.parse(vector.canonical); value.assets[0].byteLength = 4 * 1024 * 1024 + 1
    const raw = canonicalJsonBytes(value)
    const sizes: number[] = []
    const original = Uint8Array
    vi.stubGlobal('Uint8Array', new Proxy(original, {
      construct(target, args) {
        if (typeof args[0] === 'number') sizes.push(args[0])
        return Reflect.construct(target, args)
      },
    }))
    try {
      rejected(raw, 'assets', 'LIMIT')
      expect(sizes.length).toBeGreaterThan(0)
      expect(sizes.every((size) => size < 1024 * 1024)).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })

  it.each([127, 128, 129])('retains canonical depth bound at %i', (depth) => {
    rejected(utf8('['.repeat(depth) + '0' + ']'.repeat(depth)), 'canonical', depth > 128 ? 'LIMIT' : 'TYPE')
  })

  it.each([999_999, 1_000_000, 1_000_001])('retains canonical node bound at %i nodes', (nodes) => {
    const raw = utf8('[' + '0,'.repeat(nodes - 2) + '0]')
    rejected(raw, 'canonical', nodes > 1_000_000 ? 'LIMIT' : 'TYPE')
  })
})


it.each(['asset-😀', 'asset-\ue000'])('retains existing document identifier refusal for %s', (id) => {
  const value = JSON.parse(vector.canonical)
  value.document.assets[0].id = id
  value.assets[0].id = id
  rejected(canonicalJsonBytes(value), 'canonical', 'TYPE')
})
