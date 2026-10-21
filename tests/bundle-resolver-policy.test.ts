import { describe, expect, it } from 'vitest'
import { validateResolverPolicyV1 } from '../src/bundle/resolver-policy'

const asText = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const httpsPolicy = () => ({
  protocolVersion: '1.0.0', profileId: 'research', profileVersion: 'v1',
  maxConcurrent: 2,
  transport: {
    kind: 'https', endpointMapId: 'trusted-map',
    allowedEndpointIds: ['cdn:2', 'api-1'], redirects: 'deny', maxRedirects: 0,
    denyPrivateNetworks: true, serializedLocators: false,
  },
})
const filesystemPolicy = () => ({
  protocolVersion: '1.0.0', profileId: 'research', profileVersion: 'v1',
  maxConcurrent: 1,
  transport: {
    kind: 'filesystem', rootCapabilityId: 'doc-root',
    allowAbsolute: false, allowTraversal: false, allowSymlinks: false,
  },
})
const contentPolicy = () => ({
  protocolVersion: '1.0.0', profileId: 'research', profileVersion: 'v1',
  maxConcurrent: 3,
  transport: { kind: 'content-addressed', storeId: 'objects', algorithm: 'sha256' },
})

// Expected bytes/digests generated independently by Python json.dumps with
// ASCII/integer-only vectors and hashlib.sha256(domain + zero + bytes).
const vectors = [
  {
    name: 'https', input: httpsPolicy,
    canonical: '{"maxConcurrent":2,"profileId":"research","profileVersion":"v1","protocolVersion":"1.0.0","transport":{"allowedEndpointIds":["api-1","cdn:2"],"denyPrivateNetworks":true,"endpointMapId":"trusted-map","kind":"https","maxRedirects":0,"redirects":"deny","serializedLocators":false}}',
    digest: 'abbc067f63f4542d92a24704e3a8646244684cb176d59e848f5a92f5ca3f6bcd',
  },
  {
    name: 'filesystem', input: filesystemPolicy,
    canonical: '{"maxConcurrent":1,"profileId":"research","profileVersion":"v1","protocolVersion":"1.0.0","transport":{"allowAbsolute":false,"allowSymlinks":false,"allowTraversal":false,"kind":"filesystem","rootCapabilityId":"doc-root"}}',
    digest: '13171db1e0812d7d66aaed790be2e934ca2d5808509823e4d6d4b448437ce021',
  },
  {
    name: 'content-addressed', input: contentPolicy,
    canonical: '{"maxConcurrent":3,"profileId":"research","profileVersion":"v1","protocolVersion":"1.0.0","transport":{"algorithm":"sha256","kind":"content-addressed","storeId":"objects"}}',
    digest: '8ad256231a5f15a47dbb9499da696774311716ec755c9fda514875c85d1a11d8',
  },
] as const

describe('private resolver policy projection', () => {
  it.each(vectors)('$name has independently pinned bytes and digest', ({ input, canonical, digest }) => {
    const result = validateResolverPolicyV1(input())
    expect(asText(result.canonicalBytes())).toBe(canonical)
    expect(result.policySha256).toBe(digest)
  })

  it('rejects unknown fields and disabled security literals', () => {
    expect(() => validateResolverPolicyV1({ ...httpsPolicy(), extra: 'x' })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...httpsPolicy(), transport: { ...httpsPolicy().transport, denyPrivateNetworks: false },
    })).toThrow()
  })

  it('rejects non-ASCII and percent-encoded policy identifiers', () => {
    expect(() => validateResolverPolicyV1({ ...filesystemPolicy(), profileId: 'résearch' })).toThrow()
    expect(() => validateResolverPolicyV1({ ...contentPolicy(), profileId: 'profile%2Fone' })).toThrow()
  })

  it.each([127, 128, 129])('enforces the identifier grammar at length %i', (length) => {
    const input = { ...contentPolicy(), profileId: 'A'.repeat(length) }
    if (length <= 128)
      expect(validateResolverPolicyV1(input).policySnapshot().profileId).toBe(input.profileId)
    else expect(() => validateResolverPolicyV1(input)).toThrow()
  })

  it.each([-1, 0, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'enforces nonnegative safe maxConcurrent at %i', (value) => {
      const input = { ...filesystemPolicy(), maxConcurrent: value }
      if (value >= 0 && Number.isSafeInteger(value))
        expect(validateResolverPolicyV1(input).policySnapshot().maxConcurrent).toBe(value)
      else expect(() => validateResolverPolicyV1(input)).toThrow()
    },
  )

  it.each([-1, 0, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'enforces nonnegative safe maxRedirects at %i', (value) => {
      const input = {
        ...httpsPolicy(), transport: { ...httpsPolicy().transport, maxRedirects: value },
      }
      if (value >= 0 && Number.isSafeInteger(value))
        expect(() => validateResolverPolicyV1(input)).not.toThrow()
      else expect(() => validateResolverPolicyV1(input)).toThrow()
    },
  )

  it('rejects fractional and nonnumber limits', () => {
    expect(() => validateResolverPolicyV1({ ...contentPolicy(), maxConcurrent: 1.5 })).toThrow()
    expect(() => validateResolverPolicyV1({ ...contentPolicy(), maxConcurrent: '2' })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...httpsPolicy(), transport: { ...httpsPolicy().transport, maxRedirects: 0.5 },
    })).toThrow()
  })

  it('applies the identifier grammar to every transport-owned ID', () => {
    expect(() => validateResolverPolicyV1({ ...httpsPolicy(), profileVersion: '/v1' })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...httpsPolicy(), transport: { ...httpsPolicy().transport, endpointMapId: 'x/y' },
    })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...httpsPolicy(), transport: { ...httpsPolicy().transport, allowedEndpointIds: ['x/y'] },
    })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...filesystemPolicy(), transport: { ...filesystemPolicy().transport, rootCapabilityId: 'x/y' },
    })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...contentPolicy(), transport: { ...contentPolicy().transport, storeId: 'x/y' },
    })).toThrow()
  })

  it('rejects duplicate endpoint IDs and any unknown transport member', () => {
    expect(() => validateResolverPolicyV1({
      ...httpsPolicy(), transport: {
        ...httpsPolicy().transport, allowedEndpointIds: ['api-1', 'api-1'],
      },
    })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...filesystemPolicy(), transport: { ...filesystemPolicy().transport, secretPath: '/tmp/x' },
    })).toThrow()
  })

  it('rejects protocol, transport and security-literal substitutions', () => {
    expect(() => validateResolverPolicyV1({ ...contentPolicy(), protocolVersion: '1.0.1' })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...contentPolicy(), transport: { ...contentPolicy().transport, algorithm: 'sha512' },
    })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...filesystemPolicy(), transport: { ...filesystemPolicy().transport, allowTraversal: true },
    })).toThrow()
    expect(() => validateResolverPolicyV1({
      ...httpsPolicy(), transport: { ...httpsPolicy().transport, serializedLocators: true },
    })).toThrow()
  })

  it('does not retain mutable input, policy or canonical-byte aliases', () => {
    const input = httpsPolicy()
    const result = validateResolverPolicyV1(input)
    input.transport.allowedEndpointIds[0] = 'changed'
    const policy = result.policySnapshot()
    expect(policy.transport.kind).toBe('https')
    if (policy.transport.kind !== 'https') throw new Error('unexpected transport')
    expect(policy.transport.allowedEndpointIds).toEqual(['api-1', 'cdn:2'])
    expect(Object.isFrozen(policy.transport.allowedEndpointIds)).toBe(true)
    const bytes = result.canonicalBytes()
    bytes.fill(0)
    expect(asText(result.canonicalBytes())).toBe(vectors[0].canonical)
    expect(result.policySha256).toBe(vectors[0].digest)
  })
})
