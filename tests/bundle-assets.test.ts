import { describe, expect, it } from 'vitest'
import { sha256HexSync } from '../src/sha256'
import { verifyEmbeddedAssets, EmbeddedAssetError, type EmbeddedAssetLimits } from '../src/bundle/assets'

const limits: EmbeddedAssetLimits = {
  maxAssets: 3,
  maxAssetBytes: 4,
  maxTotalBytes: 6,
  maxBase64Chars: 8,
}

function pair(id: string, bytes: number[]) {
  const sha256 = sha256HexSync(new Uint8Array(bytes))
  return {
    document: { id, mediaType: 'image/png', sha256 },
    envelope: {
      id, mediaType: 'image/png', sha256, byteLength: bytes.length,
      payload: { kind: 'embedded', base64: Buffer.from(bytes).toString('base64') },
    },
  }
}

function fails(document: unknown, envelope: unknown, code: EmbeddedAssetError['code'], caps = limits) {
  try {
    verifyEmbeddedAssets(document, envelope, caps)
    throw new Error('unexpected acceptance')
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddedAssetError)
    expect((error as EmbeddedAssetError).code).toBe(code)
  }
}

describe('private embedded asset integrity pilot', () => {
  it('returns complete copied bytes only after matching all records', () => {
    const first = pair('a', [1, 2])
    const second = pair('b', [3])
    const result = verifyEmbeddedAssets(
      [first.document, second.document], [second.envelope, first.envelope], limits,
    )
    expect(result.assetIds()).toEqual(['a', 'b'])
    expect([...result.assetBytes('a')!]).toEqual([1, 2])
    result.assetBytes('a')![0] = 99
    first.envelope.payload.base64 = 'AAAA'
    expect([...result.assetBytes('a')!]).toEqual([1, 2])
  })

  it('rejects document bytes and byteLength even when envelope metadata matches', () => {
    const asset = pair('a', [1])
    for (const key of ['bytes', 'byteLength'])
      fails([{ ...asset.document, [key]: key === 'bytes' ? 'AQ==' : 1 }], [asset.envelope], 'SHAPE')
  })

  it('rejects missing, extra, and duplicated asset IDs across the complete set', () => {
    const a = pair('a', [1])
    const b = pair('b', [2])
    fails([a.document, b.document], [a.envelope], 'SET')
    fails([a.document], [a.envelope, b.envelope], 'SET')
    fails([a.document, a.document], [a.envelope, b.envelope], 'SET')
    fails([a.document, b.document], [a.envelope, a.envelope], 'SET')
  })

  it('rejects canonical base64 violations and digest mismatch', () => {
    const asset = pair('a', [1])
    for (const base64 of ['AR==', 'AQ=', 'AQ==\n', 'AQ-_', 'A==='])
      fails([asset.document], [{ ...asset.envelope, payload: { kind: 'embedded', base64 } }], 'BASE64')
    const two = pair('two', [1, 2])
    fails([two.document], [{ ...two.envelope,
      payload: { kind: 'embedded', base64: 'AQJ=' } }], 'BASE64')
    fails([asset.document], [{ ...asset.envelope, payload: { kind: 'embedded', base64: 'Ag==' } }], 'DIGEST')
  })

  it('leaves external references unresolved without invoking their contents', () => {
    const asset = pair('a', [1])
    fails([asset.document], [{ ...asset.envelope, payload: {
      kind: 'external', resourceId: `sha256:${asset.document.sha256}`,
    } }], 'UNRESOLVED')
  })

  it('checks metadata and digest at every position, with no partial result', () => {
    const records = [pair('a', [1]), pair('b', [2]), pair('c', [3])]
    for (const index of records.keys()) {
      const documents = records.map((record) => record.document)
      const envelopes = records.map((record) => record.envelope)
      envelopes[index] = { ...envelopes[index], mediaType: 'image/jpeg' }
      fails(documents, envelopes, 'METADATA')
      envelopes[index] = { ...records[index]!.envelope, sha256: '0'.repeat(64) }
      fails(documents, envelopes, 'METADATA')
      envelopes[index] = { ...records[index]!.envelope, byteLength: 0 }
      fails(documents, envelopes, 'BASE64')
    }
  })

  it('applies count, decoded per-asset, aggregate, and base64-field N-1/N/N+1 bounds', () => {
    const three = [pair('a', [1, 2, 3, 4]), pair('b', [5]), pair('c', [6])]
    const docs = three.map((record) => record.document)
    const envs = three.map((record) => record.envelope)
    expect(verifyEmbeddedAssets(docs, envs, limits).assetIds()).toHaveLength(3)
    fails(docs, envs, 'LIMIT', { ...limits, maxAssets: 2 })
    const fourth = pair('d', [])
    fails([...docs, fourth.document], [...envs, fourth.envelope], 'LIMIT')
    fails(docs, envs, 'LIMIT', { ...limits, maxAssetBytes: 3 })
    const five = pair('a', [1, 2, 3, 4, 5])
    fails([five.document], [five.envelope], 'LIMIT')
    fails(docs, envs, 'LIMIT', { ...limits, maxTotalBytes: 5 })
    const seven = [pair('a', [1, 2, 3, 4]), pair('b', [5, 6]), pair('c', [7])]
    fails(seven.map((record) => record.document), seven.map((record) => record.envelope), 'LIMIT')
    fails(docs, envs, 'LIMIT', { ...limits, maxBase64Chars: 7 })
    fails([three[0]!.document], [{ ...three[0]!.envelope,
      payload: { kind: 'embedded', base64: 'AAAAAAAAA' } }], 'LIMIT')
  })

  it('rejects hostile accessors, prototypes, sparse arrays, and malformed limits', () => {
    const asset = pair('a', [1])
    const getter = Object.defineProperty({ ...asset.envelope }, 'id', {
      enumerable: true, get() { throw new Error('must not execute') },
    })
    fails([asset.document], [getter], 'SHAPE')
    fails([asset.document], [Object.create(asset.envelope)], 'SHAPE')
    const sparse = new Array(1)
    fails(sparse, [asset.envelope], 'SHAPE')
    expect(() => verifyEmbeddedAssets([asset.document], [asset.envelope], {
      ...limits, maxAssetBytes: Number.MAX_SAFE_INTEGER,
    })).toThrowError(EmbeddedAssetError)
  })

  it('returns independent ID and byte snapshots despite caller mutation', () => {
    const asset = pair('a', [1, 2])
    const result = verifyEmbeddedAssets([asset.document], [asset.envelope], limits)
    const ids = result.assetIds()
    ids[0] = 'changed'
    asset.document.id = 'changed'
    asset.envelope.id = 'changed'
    expect(result.assetIds()).toEqual(['a'])
    expect([...result.assetBytes('a')!]).toEqual([1, 2])
    expect(result.assetBytes('changed')).toBeUndefined()
  })

  it('accepts canonical zero-length bytes without a special bypass', () => {
    const asset = pair('empty', [])
    const result = verifyEmbeddedAssets([asset.document], [asset.envelope], limits)
    expect(result.assetBytes('empty')).toEqual(new Uint8Array())
  })
})
