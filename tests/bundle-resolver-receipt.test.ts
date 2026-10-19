import { describe, expect, it } from 'vitest'
import { validateResolverReceiptProjection } from '../src/bundle/resolver-receipt'

const digest = 'a'.repeat(64)
const expected = () => ({ id: 'asset-1', sha256: digest, mediaType: 'image/png', byteLength: 3 })
const base = <T extends object>(transport: T) => ({ protocolVersion: '1.0.0', profileId: 'p', profileVersion: 'v1', maxConcurrent: 1, transport })
const https = () => base({ kind: 'https', endpointMapId: 'map-1', allowedEndpointIds: ['a', 'b'], redirects: 'same-origin', maxRedirects: 1, denyPrivateNetworks: true, serializedLocators: false })
const filesystem = () => base({ kind: 'filesystem', rootCapabilityId: 'root-1', allowAbsolute: false, allowTraversal: false, allowSymlinks: false })
const content = () => base({ kind: 'content-addressed', storeId: 'store-1', algorithm: 'sha256' })

// Policy digests pinned independently with Python json.dumps(sort_keys=True,
// separators=(',', ':')) and hashlib.sha256(domain + b'\0' + canonical bytes).
const vectors = [
  { policy: https, digest: '272961206aa06ed4aa6c89608d604f19bc4bd0ca9b55a6ffea5237adf508cc4f', receipt: { kind: 'https', policySha256: '272961206aa06ed4aa6c89608d604f19bc4bd0ca9b55a6ffea5237adf508cc4f', endpointMapId: 'map-1', endpointId: 'a', redirectEndpointIds: ['b'] } },
  { policy: filesystem, digest: '6cd71782374bcc64d27b16f175d5fa58e2b7a37a3a5854a41ae717aafe30b977', receipt: { kind: 'filesystem', policySha256: '6cd71782374bcc64d27b16f175d5fa58e2b7a37a3a5854a41ae717aafe30b977', rootCapabilityId: 'root-1' } },
  { policy: content, digest: '04c93bf89a06c89759409e4854b0c09e8b5079b98fe9560d40857cedc11d3071', receipt: { kind: 'content-addressed', policySha256: '04c93bf89a06c89759409e4854b0c09e8b5079b98fe9560d40857cedc11d3071', storeId: 'store-1' } },
] as const

function projection(receipt: object) {
  return { protocolVersion: '1.0.0', resourceId: `sha256:${digest}`, transportReceipt: receipt, declaredByteLength: 3 }
}
function check(policy: object, policyDigest: string, receipt: object, overrides: object = {}) {
  return validateResolverReceiptProjection({
    policy, expectedPolicySha256: policyDigest, expected: expected(),
  }, { ...projection(receipt), ...overrides })
}

describe('private data-only resolver receipt projection', () => {
  it.each(vectors)('accepts a pinned $receipt.kind vector', ({ policy, digest: policyDigest, receipt }) => {
    const result = check(policy(), policyDigest, receipt)
    expect(result.resourceId).toBe(`sha256:${digest}`)
    expect(result.transportReceipt).toEqual(receipt)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.transportReceipt)).toBe(true)
  })

  it('allows omitted declared length and rejects mismatches', () => {
    const vector = vectors[2]
    const omitted = projection(vector.receipt) as Record<string, unknown>
    delete omitted.declaredByteLength
    expect(validateResolverReceiptProjection({ policy: vector.policy(), expectedPolicySha256: vector.digest, expected: expected() }, omitted)).not.toHaveProperty('declaredByteLength')
    for (const length of [-1, 2, 4, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => check(vector.policy(), vector.digest, vector.receipt, { declaredByteLength: length })).toThrow()
    }
  })

  it.each(vectors)('rejects kind, digest, resource and version mismatch for $receipt.kind', ({ policy, digest: policyDigest, receipt }) => {
    expect(() => check(policy(), policyDigest, { ...receipt, kind: 'wrong' })).toThrow()
    expect(() => check(policy(), policyDigest, { ...receipt, policySha256: 'b'.repeat(64) })).toThrow()
    expect(() => check(policy(), 'b'.repeat(64), receipt)).toThrow()
    expect(() => check(policy(), policyDigest, receipt, { resourceId: `sha256:${'b'.repeat(64)}` })).toThrow()
    expect(() => check(policy(), policyDigest, receipt, { protocolVersion: '2.0.0' })).toThrow()
    expect(() => check(policy(), policyDigest, { ...receipt, url: 'https://secret.example/path' })).toThrow()
    expect(() => check(policy(), policyDigest, receipt, { chunks: [] })).toThrow()
    expect(() => check(policy(), policyDigest, receipt, { cleanup: () => Promise.resolve() })).toThrow()
  })

  it('enforces HTTPS map, endpoint membership and redirect bounds', () => {
    const { digest: policyDigest, receipt } = vectors[0]
    expect(() => check(https(), policyDigest, { ...receipt, endpointMapId: 'other' })).toThrow()
    expect(() => check(https(), policyDigest, { ...receipt, endpointId: 'c' })).toThrow()
    expect(() => check(https(), policyDigest, { ...receipt, redirectEndpointIds: ['c'] })).toThrow()
    expect(() => check(https(), policyDigest, { ...receipt, redirectEndpointIds: ['a', 'b'] })).toThrow()
    expect(() => check(https(), policyDigest, { ...receipt, endpointId: 'https://secret' })).toThrow()
    const deny = structuredClone(https())
    deny.transport.redirects = 'deny'
    deny.transport.maxRedirects = 0
    expect(() => check(deny, 'dad26554a21ebd29ec676ba187e0d116686d04c3206443835e5aa65682df462d', { ...receipt, policySha256: 'dad26554a21ebd29ec676ba187e0d116686d04c3206443835e5aa65682df462d', redirectEndpointIds: ['b'] })).toThrow()
  })

  it('enforces filesystem and store IDs', () => {
    expect(() => check(filesystem(), vectors[1].digest, { ...vectors[1].receipt, rootCapabilityId: 'other' })).toThrow()
    expect(() => check(content(), vectors[2].digest, { ...vectors[2].receipt, storeId: 'other' })).toThrow()
  })

  it.each([
    [127, 'e730760e6fb3e7dfcf4c3cc6edc727597c78d911a16baae616e69ef61e244f30'],
    [128, '04d441729e4c81fcbb226a033cf7ecf06543cbe76950d7a1a8c2486d949bcdc6'],
  ] as const)('accepts identifier boundary length %i when policy and receipt agree', (length, policyDigest) => {
    const id = 'A'.repeat(length)
    const policy = filesystem()
    policy.transport.rootCapabilityId = id
    const receipt = { ...vectors[1].receipt, policySha256: policyDigest, rootCapabilityId: id }
    expect(check(policy, policyDigest, receipt).transportReceipt).toHaveProperty('rootCapabilityId', id)
    expect(() => check(policy, policyDigest, { ...receipt, rootCapabilityId: `${id}A` })).toThrow()
  })

  it('rejects malformed receipt identifiers and digest spellings for every transport', () => {
    for (const { policy, digest: policyDigest, receipt } of vectors) {
      for (const bad of ['é', 'path%2Fname', '', 'A'.repeat(129), ['a'], 7]) {
        const identifierKey = receipt.kind === 'https' ? 'endpointId' :
          receipt.kind === 'filesystem' ? 'rootCapabilityId' : 'storeId'
        expect(() => check(policy(), policyDigest, { ...receipt, [identifierKey]: bad })).toThrow()
      }
      for (const bad of ['A'.repeat(64), 'a'.repeat(63), ['a'.repeat(64)], null])
        expect(() => check(policy(), policyDigest, { ...receipt, policySha256: bad })).toThrow()
    }
  })

  it('binds expected asset metadata and accepts only its exact resource digest', () => {
    const vector = vectors[2]
    const result = projection(vector.receipt)
    for (const metadata of [
      { ...expected(), sha256: 'A'.repeat(64) },
      { ...expected(), sha256: ['a'.repeat(64)] },
      { ...expected(), byteLength: -1 },
      { ...expected(), byteLength: Number.MAX_SAFE_INTEGER + 1 },
      { ...expected(), mediaType: '' },
      { ...expected(), path: '/secret/file' },
    ]) {
      expect(() => validateResolverReceiptProjection({ policy: vector.policy(), expectedPolicySha256: vector.digest, expected: metadata }, result)).toThrow()
    }
  })

  it('rejects hostile values without retaining them in errors', () => {
    const secret = 'https://secret.example/token'
    const value = { ...projection(vectors[2].receipt), secret }
    expect(() => check(content(), vectors[2].digest, value.transportReceipt, value)).toThrow()
    try { check(content(), vectors[2].digest, value.transportReceipt, value) }
    catch (error) { expect(String(error)).not.toContain(secret) }
    let calls = 0
    const accessor = { ...projection(vectors[2].receipt) }
    Object.defineProperty(accessor, 'resourceId', { enumerable: true, get() { calls++; return `sha256:${digest}` } })
    expect(() => validateResolverReceiptProjection({ policy: content(), expectedPolicySha256: vectors[2].digest, expected: expected() }, accessor)).toThrow()
    expect(calls).toBe(0)
    const policyWithGetter = content()
    Object.defineProperty(policyWithGetter.transport, 'storeId', { enumerable: true, get() { calls++; return 'store-1' } })
    expect(() => validateResolverReceiptProjection({ policy: policyWithGetter, expectedPolicySha256: vectors[2].digest, expected: expected() }, projection(vectors[2].receipt))).toThrow()
    expect(calls).toBe(0)
    const accepted = check(content(), vectors[2].digest, vectors[2].receipt)
    expect(accepted.transportReceipt).not.toBe(vectors[2].receipt)
    const source = { ...vectors[0].receipt, redirectEndpointIds: ['b'] }
    const snapshot = check(https(), vectors[0].digest, source)
    source.redirectEndpointIds[0] = 'a'
    expect(snapshot.transportReceipt).toHaveProperty('redirectEndpointIds', ['b'])
  })
})
