import { describe, expect, it } from 'vitest'
import { canonicalBundleDocumentBytes, canonicalBundleEnvelopeBytes } from '../src/bundle/canonical'
import { sha256HexSync } from '../src/sha256'
import { verifyEmbeddedAssets } from '../src/bundle/assets'
import vectors from './fixtures/bundle-canonical/vectors.json'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const byName = (name: string) => vectors.find((vector) => vector.name === name)!
const envelopeVectors = vectors.filter((vector) => vector.name.endsWith(':envelope'))

describe('independent ASCII/integer canonical Bundle vectors', () => {
  it.each(vectors)('$name has pinned canonical UTF-8 bytes and SHA-256', (vector) => {
    const bytes = vector.name.endsWith(':document')
      ? canonicalBundleDocumentBytes(vector.input)
      : canonicalBundleEnvelopeBytes(vector.input)
    expect(text(bytes)).toBe(vector.canonical)
    expect(sha256HexSync(bytes)).toBe(vector.sha256)
  })

  it.each(envelopeVectors)('$name conserves the complete document asset set and metadata', (vector) => {
    const value = vector.input
    if (!('document' in value) || !value.document) throw new Error('missing fixture document')
    const documentAssets = value.document.assets
    const envelopeAssets = value.assets
    expect(envelopeAssets.map((asset) => asset.id).sort()).toEqual(
      documentAssets.map((asset) => asset.id).sort())
    for (const asset of envelopeAssets) {
      const documentAsset = documentAssets.find((entry) => entry.id === asset.id)
      expect(documentAsset).toBeDefined()
      expect(asset.sha256).toBe(documentAsset!.sha256)
      expect(asset.mediaType).toBe(documentAsset!.mediaType)
    }
    expect(verifyEmbeddedAssets(documentAssets, envelopeAssets, {
      maxAssets: 4, maxAssetBytes: 16, maxTotalBytes: 64, maxBase64Chars: 32,
    }).assetIds().length).toBe(documentAssets.length)
  })

  it('ignores insertion order of envelope object keys', () => {
    const vector = byName('current:envelope')
    const envelope = structuredClone(vector.input)
    const reordered = Object.fromEntries(Object.entries(envelope).reverse())
    expect(text(canonicalBundleEnvelopeBytes(reordered))).toBe(vector.canonical)
  })

  it('sorts two intentionally asset-inconsistent records in the private canonical helper', () => {
    // This is only an ordering probe: the document has asset-1, so the
    // augmented envelope is deliberately not a positive Bundle fixture.
    const vector = byName('current:envelope')
    const envelope = structuredClone(vector.input)
    const original = envelope.assets[0]!
    const extraAssets = [
      { ...original, id: 'asset-z' },
      { ...original, id: 'asset-a' },
    ]
    const ordered = text(canonicalBundleEnvelopeBytes({ ...envelope, assets: extraAssets }))
    expect(ordered.indexOf('"id":"asset-a"')).toBeLessThan(ordered.indexOf('"id":"asset-z"'))
    expect(extraAssets.map((asset) => asset.id)).toEqual(['asset-z', 'asset-a'])
    if (!('document' in envelope) || !envelope.document) throw new Error('missing fixture document')
    expect(() => verifyEmbeddedAssets(envelope.document.assets, extraAssets, {
      maxAssets: 4, maxAssetBytes: 16, maxTotalBytes: 64, maxBase64Chars: 32,
    })).toThrow()
  })

  it('distinguishes schema, semantic title, and source/receipt changes by both digests', () => {
    const names = ['legacy', 'current', 'current-title', 'current-source-receipt']
    const documentHashes = names.map((name) => byName(`${name}:document`).sha256)
    const envelopeHashes = names.map((name) => byName(`${name}:envelope`).sha256)
    expect(new Set(documentHashes).size).toBe(names.length)
    expect(new Set(envelopeHashes).size).toBe(names.length)
    expect(byName('current:document').input.receipt.generatedSha256).not.toBe(
      byName('current-source-receipt:document').input.receipt.generatedSha256)
  })

  it.each(['0.0.9', '0.1.1', '0.2.1', '0.3.0'])(
    'rejects adjacent unsupported document and envelope schema %s', (version) => {
      const document = structuredClone(byName('current:document').input)
      document.schemaVersion = version
      document.receipt.schemaVersion = version
      expect(() => canonicalBundleDocumentBytes(document)).toThrow()
      const envelope = structuredClone(byName('current:envelope').input)
      if (!('document' in envelope) || !envelope.document) throw new Error('missing fixture document')
      envelope.schemaVersion = version
      envelope.document.schemaVersion = version
      envelope.document.receipt.schemaVersion = version
      envelope.receipt.schemaVersion = version
      expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
    },
  )

  it('rejects forbidden document asset bytes and unknown envelope asset fields', () => {
    const document = structuredClone(byName('current:document').input)
    Object.assign(document.assets[0]!, { bytes: 'AP+A' })
    expect(() => canonicalBundleDocumentBytes(document)).toThrow()
    const envelope = structuredClone(byName('current:envelope').input)
    Object.assign(envelope.assets[0]!, { bytes: 'AP+A' })
    expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
  })

  it('rejects receipt drift even if the outer receipt copies it', () => {
    const envelope = structuredClone(byName('current:envelope').input)
    if (!('document' in envelope) || !envelope.document) throw new Error('missing fixture document')
    envelope.receipt.blockCount += 1
    expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
    envelope.document.receipt.blockCount += 1
    expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
  })
})
