import { describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  canonicalBundleDocumentBytes,
  canonicalBundleEnvelopeBytes,
  CanonicalJsonError,
  parseCanonicalJsonBytes,
  snapshotCanonicalJsonInput,
} from '../src/bundle/canonical'
import { sha256HexSync } from '../src/sha256'
import { seal, validDocument } from './codec-fixtures'

const utf8 = (text: string) => new TextEncoder().encode(text)
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

function validEnvelope(payloadKind: 'embedded' | 'external') {
  const document = structuredClone(validDocument())
  for (const asset of document.assets as Record<string, unknown>[])
    delete asset.bytes
  const asset = document.assets[0]
  return {
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256: sha256HexSync(canonicalBundleDocumentBytes(document)),
    document,
    assets: [{
      id: asset.id,
      sha256: asset.sha256 as unknown,
      mediaType: asset.mediaType,
      byteLength: 3,
      payload: payloadKind === 'embedded'
        ? { kind: 'embedded', base64: 'AP+A' }
        : { kind: 'external', resourceId: `sha256:${asset.sha256}` },
    }],
    receipt: document.receipt,
  }
}

describe('private Bundle canonicalization pilot', () => {
  it('uses RFC 8785 number and UTF-16 property ordering', () => {
    // Fixed independently from the JCS rules: supplementary U+1F600 sorts
    // before U+E000 by UTF-16 code units, and 1e-7 uses decimal exponent form.
    const input = { '\ue000': 2, '\ud83d\ude00': 1, n: 1e-7, z: -0 }
    expect(text(canonicalJsonBytes(input))).toBe(
      '{"n":1e-7,"z":0,"😀":1,"":2}',
    )
  })

  it('rejects a duplicate JSON member even when its values agree', () => {
    expect(() => parseCanonicalJsonBytes(utf8('{"a":1,"a":1}'), 64)).toThrow()
  })

  it('rejects an unpaired surrogate in an in-memory value', () => {
    expect(() => canonicalJsonBytes({ name: '\ud800' })).toThrow()
  })

  it('rejects unsafe integers before number serialization can round them', () => {
    expect(() => canonicalJsonBytes({ count: 2 ** 53 })).toThrow()
  })

  it('refuses document asset bytes instead of silently stripping them', () => {
    const document = validDocument()
    expect(() => canonicalBundleDocumentBytes(document)).toThrow()
    const byteFree = structuredClone(document)
    for (const asset of byteFree.assets as Record<string, unknown>[])
      delete asset.bytes
    expect(text(canonicalBundleDocumentBytes(byteFree))).toContain(
      '"schemaVersion":"0.1.0"',
    )
  })

  it('caps raw bytes before trying to parse them', () => {
    expect(() => parseCanonicalJsonBytes(utf8('{bad'), 3)).toThrowError(
      new CanonicalJsonError('LIMIT'),
    )
  })

  it.each(['subclass', 'own-property'] as const)(
    'uses intrinsic raw length for the %s cap before parsing', (variant) => {
      const input = utf8('{"a":1}')
      let getterCalls = 0
      let raw: Uint8Array
      if (variant === 'subclass') {
        class MaskedBytes extends Uint8Array {
          get byteLength() {
            getterCalls += 1
            return getterCalls === 1 ? 0 : super.byteLength
          }
        }
        raw = new MaskedBytes(input)
      } else {
        raw = new Uint8Array(input)
        Object.defineProperty(raw, 'byteLength', {
          get() { getterCalls += 1; return 0 },
        })
      }
      expect(() => parseCanonicalJsonBytes(raw, 0)).toThrowError(
        new CanonicalJsonError('LIMIT'),
      )
      expect(getterCalls).toBe(0)
    },
  )

  it('reads a bounded snapshot without invoking an overridden iterator', () => {
    const raw = new Uint8Array(utf8('{"a":1}'))
    Object.defineProperty(raw, Symbol.iterator, {
      value: () => { throw new Error('caller iterator invoked') },
    })
    expect(parseCanonicalJsonBytes(raw, 7)).toEqual({ a: 1 })
  })

  it('accepts canonical wire bytes and rejects whitespace and bad UTF-8', () => {
    expect(parseCanonicalJsonBytes(utf8('{"a":1}'), 7)).toEqual({ a: 1 })
    expect(() => parseCanonicalJsonBytes(utf8('{ "a":1}'), 16)).toThrow()
    expect(() => parseCanonicalJsonBytes(new Uint8Array([0xff]), 16)).toThrow()
  })

  it('rejects an unknown document asset field, including one with null value', () => {
    const document = structuredClone(validDocument())
    for (const asset of document.assets as Record<string, unknown>[])
      delete asset.bytes
    ;(document.assets[0] as Record<string, unknown>).other = null
    expect(() => canonicalBundleDocumentBytes(document)).toThrow()
  })

  it('keeps the 0.1.0 and 0.2.0 document projections distinct', () => {
    const legacy = structuredClone(validDocument())
    for (const asset of legacy.assets as Record<string, unknown>[])
      delete asset.bytes
    const current = structuredClone(legacy) as typeof legacy & {
      documentId: string
      receipt: typeof legacy.receipt & { documentId: string }
    }
    current.schemaVersion = '0.2.0'
    current.documentId = 'fixture-document'
    current.receipt.schemaVersion = '0.2.0'
    current.receipt.documentId = 'fixture-document'
    seal(current)
    expect(text(canonicalBundleDocumentBytes(current))).toContain(
      '"schemaVersion":"0.2.0"',
    )
    expect(sha256HexSync(canonicalBundleDocumentBytes(current))).not.toBe(
      sha256HexSync(canonicalBundleDocumentBytes(legacy)),
    )
  })

  it('rejects accessors without invoking them and rejects cycles', () => {
    let getterCalls = 0
    const hostile = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { getterCalls += 1; return 'secret' },
    })
    expect(() => canonicalJsonBytes(hostile)).toThrow()
    expect(getterCalls).toBe(0)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => canonicalJsonBytes(cycle)).toThrow()
  })

  it('orders envelope assets by ID without changing the document projection', () => {
    const document = structuredClone(validDocument())
    for (const asset of document.assets as Record<string, unknown>[])
      delete asset.bytes
    const documentSha256 = sha256HexSync(canonicalBundleDocumentBytes(document))
    const asset = document.assets[0]
    const envelope = {
      mediaType: 'application/vnd.erniesg.struct+json',
      bundleVersion: '1.0.0',
      schemaVersion: document.schemaVersion,
      documentSha256,
      document,
      assets: [
        { id: '😀', sha256: asset.sha256, mediaType: asset.mediaType, byteLength: 3,
          payload: { kind: 'embedded', base64: 'AP+A' } },
        { id: '', sha256: asset.sha256, mediaType: asset.mediaType, byteLength: 3,
          payload: { kind: 'embedded', base64: 'AP+A' } },
      ],
      receipt: document.receipt,
    }
    const originalOrder = envelope.assets.map((entry) => entry.id)
    const bytes = canonicalBundleEnvelopeBytes(envelope)
    expect(text(bytes).indexOf('"id":""')).toBeLessThan(
      text(bytes).indexOf('"id":"😀"'),
    )
    expect(envelope.assets.map((entry) => entry.id)).toEqual(originalOrder)
  })

  it('rejects a mismatched document digest and transport receipt', () => {
    const document = structuredClone(validDocument())
    for (const asset of document.assets as Record<string, unknown>[])
      delete asset.bytes
    const envelope = {
      mediaType: 'application/vnd.erniesg.struct+json',
      bundleVersion: '1.0.0',
      schemaVersion: document.schemaVersion,
      documentSha256: '0'.repeat(64),
      document,
      assets: [],
      receipt: document.receipt,
    }
    expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
    envelope.documentSha256 = sha256HexSync(canonicalBundleDocumentBytes(document))
    envelope.receipt = { ...document.receipt, blockCount: 2 }
    expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
  })

  it.each(['embedded', 'external'] as const)(
    'requires an exact string asset digest for %s payloads', (payloadKind) => {
      for (const wrap of [
        (digest: string): unknown => [digest],
        (digest: string): unknown => [[digest]],
        (_digest: string): unknown => ({ digest: 'a'.repeat(64) }),
        (_digest: string): unknown => null,
        (_digest: string): unknown => 7,
      ]) {
        const envelope = validEnvelope(payloadKind)
        envelope.assets[0].sha256 = wrap(envelope.assets[0].sha256 as string)
        expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
      }
    },
  )

  it('requires an exact string outer document digest', () => {
    for (const wrap of [
      (digest: string): unknown => [digest],
      (digest: string): unknown => [[digest]],
      (_digest: string): unknown => ({ digest: 'a'.repeat(64) }),
      (_digest: string): unknown => null,
      (_digest: string): unknown => 7,
    ]) {
      const envelope = validEnvelope('embedded')
      ;(envelope as Record<string, unknown>).documentSha256 = wrap(envelope.documentSha256)
      expect(() => canonicalBundleEnvelopeBytes(envelope)).toThrow()
    }
  })
})


describe('private bounded raw snapshot reuse', () => {
  it('copies capped byte input without parsing it for digest-before-parse callers', async () => {
    const canonical = await import('../src/bundle/canonical')
    const snapshot = (canonical as Record<string, unknown>).snapshotCanonicalJsonInput
    expect(typeof snapshot).toBe('function')
    const raw = utf8('{bad')
    const copied = (snapshot as (raw: Uint8Array, cap: number) => Uint8Array)(raw, 4)
    raw.fill(0)
    expect(text(copied)).toBe('{bad')
    expect(() => (snapshot as (raw: Uint8Array, cap: number) => Uint8Array)(raw, 3))
      .toThrowError(new CanonicalJsonError('LIMIT'))
  })
})


it.each([3, 4, 5])('shared raw snapshot enforces a four-byte input at cap %i without parsing', (cap) => {
  const raw = utf8('{bad')
  if (cap < 4) expect(() => snapshotCanonicalJsonInput(raw, cap)).toThrowError(new CanonicalJsonError('LIMIT'))
  else expect(snapshotCanonicalJsonInput(raw, cap)).toEqual(raw)
})

it.each([NaN, Infinity, -1, 0.5, true, '4', new Number(4)])('shared raw snapshot rejects malformed cap %#', (cap) => {
  expect(() => snapshotCanonicalJsonInput(utf8('{bad'), cap as number)).toThrowError(new CanonicalJsonError('LIMIT'))
})

it('shared snapshot ignores caller length and iterator, isolates every byte, and refuses non-byte views', () => {
  const raw = utf8('{bad')
  let touched = 0
  Object.defineProperty(raw, 'byteLength', { get() { touched += 1; return 0 } })
  Object.defineProperty(raw, Symbol.iterator, { get() { touched += 1; throw new Error('unused') } })
  const copy = snapshotCanonicalJsonInput(raw, 4)
  raw.fill(0)
  expect(text(copy)).toBe('{bad')
  copy.fill(1)
  expect(Array.from(raw.values())).toEqual([0, 0, 0, 0])
  expect(touched).toBe(0)
  for (const value of [new Uint16Array(1), new DataView(new ArrayBuffer(1)), {}, new Proxy(raw, {})]) {
    expect(() => snapshotCanonicalJsonInput(value as Uint8Array, 4)).toThrowError(new CanonicalJsonError('TYPE'))
  }
})
