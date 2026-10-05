import { describe, expect, it } from 'vitest'
import { canonicalBundleDocumentBytes, canonicalBundleEnvelopeBytes } from '../src/bundle/canonical'
import { sha256HexSync } from '../src/sha256'
import vectors from './fixtures/bundle-canonical/vectors.json'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const byName = (name: string) => vectors.find((vector) => vector.name === name)!

describe('independent ASCII/integer canonical Bundle vectors', () => {
  it.each(vectors)('$name has pinned canonical UTF-8 bytes and SHA-256', (vector) => {
    const bytes = vector.name.endsWith(':document')
      ? canonicalBundleDocumentBytes(vector.input)
      : canonicalBundleEnvelopeBytes(vector.input)
    expect(text(bytes)).toBe(vector.canonical)
    expect(sha256HexSync(bytes)).toBe(vector.sha256)
  })

  it('sorts envelope assets by ID without mutating input and ignores insertion order of object keys', () => {
    const vector = byName('current:envelope')
    const envelope = structuredClone(vector.input)
    expect(envelope.assets.map((asset) => asset.id)).toEqual(['asset-z', 'asset-a'])
    const reordered = Object.fromEntries(Object.entries(envelope).reverse())
    expect(text(canonicalBundleEnvelopeBytes(reordered))).toBe(vector.canonical)
    expect(envelope.assets.map((asset) => asset.id)).toEqual(['asset-z', 'asset-a'])
    expect(vector.canonical.indexOf('"id":"asset-a"')).toBeLessThan(
      vector.canonical.indexOf('"id":"asset-z"'))
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
