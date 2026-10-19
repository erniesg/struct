import { describe, expect, it } from 'vitest'
import {
  STRUCT_RESOLVER_PROTOCOL_VERSION,
  StructResolverProtocolError,
  assertStructResolverExecutionId,
  isStructResolverExecutionId,
  isStructResolverLogicalHref,
  planStructResolverBudget,
  readStructResolverFields,
  validateStructResolverFailStopReceipt,
  validateStructResolverRequest,
  validateStructResolverResult,
  validateStructResolverRevocationReceipt,
  validateStructResolverTerminalReceipt,
} from '../src/bundle/resolver-protocol'
import type {
  StructAssetResolutionRequest,
  StructAssetResolutionResult,
  StructResolverExecutionControl,
  StructResolverExecutionHandle,
  StructResolverExecutorV1,
  StructResolverFailStopReceipt,
  StructResolverHostSupervisorV1,
  StructResolverRevocationReceipt,
  StructResolverTerminalReceipt,
} from '../src/bundle/resolver-protocol'

// The ADR pins these declarations literally. The type-level assertions below
// fail the compile step if a member is renamed, narrowed, or dropped.
type Assert<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

type _RequestIsPinned = Assert<Equals<StructAssetResolutionRequest, Readonly<{
  protocolVersion: '1.0.0'
  logicalHref: string
  resourceId: `sha256:${string}`
  expected: Readonly<{ id: string; sha256: string; mediaType: string; byteLength: number }>
  policy: import('../src/bundle/resolver-policy').StructAssetResolutionPolicyV1
  expectedPolicySha256: string
  budget: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  signal: AbortSignal
}>>>

type _ResultIsPinned = Assert<Equals<StructAssetResolutionResult, Readonly<{
  protocolVersion: '1.0.0'
  resourceId: `sha256:${string}`
  chunks: AsyncIterable<Uint8Array>
  transportReceipt:
    | Readonly<{
        kind: 'https'
        policySha256: string
        endpointMapId: string
        endpointId: string
        redirectEndpointIds: readonly string[]
      }>
    | Readonly<{ kind: 'filesystem'; policySha256: string; rootCapabilityId: string }>
    | Readonly<{ kind: 'content-addressed'; policySha256: string; storeId: string }>
  declaredByteLength?: number
}>>>

type _RevocationIsPinned = Assert<Equals<StructResolverRevocationReceipt, Readonly<{
  executionId: string
  capabilitiesRevoked: true
  quarantined: true
}>>>

type _TerminalIsPinned = Assert<Equals<StructResolverTerminalReceipt, Readonly<{
  executionId: string
  state: 'terminated' | 'completed'
}>>>

type _HandleIsPinned = Assert<Equals<StructResolverExecutionHandle, Readonly<{
  control: StructResolverExecutionControl
  start(): Promise<StructAssetResolutionResult>
}>>>

type _ExecutorIsPinned = Assert<Equals<StructResolverExecutorV1, {
  allocate(request: StructAssetResolutionRequest): StructResolverExecutionHandle
}>>

type _HostSupervisorIsPinned = Assert<Equals<StructResolverHostSupervisorV1, {
  readonly protocolVersion: '1.0.0'
  failStop(
    executionId: string,
    reason: import('../src/bundle/resolver-protocol').StructResolverFailStopReason,
  ): Promise<StructResolverFailStopReceipt>
}>>

const digest = 'a'.repeat(64)
const policyDigest = '272961206aa06ed4aa6c89608d604f19bc4bd0ca9b55a6ffea5237adf508cc4f'

const httpsPolicy = () => ({
  protocolVersion: '1.0.0' as const,
  profileId: 'p',
  profileVersion: 'v1',
  maxConcurrent: 1,
  transport: {
    kind: 'https' as const,
    endpointMapId: 'map-1',
    allowedEndpointIds: ['a', 'b'],
    redirects: 'same-origin' as const,
    maxRedirects: 1,
    denyPrivateNetworks: true as const,
    serializedLocators: false as const,
  },
})

const request = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '1.0.0',
  logicalHref: 'Text/chapter1.xhtml',
  resourceId: `sha256:${digest}`,
  expected: { id: 'asset-1', sha256: digest, mediaType: 'image/png', byteLength: 3 },
  policy: httpsPolicy(),
  expectedPolicySha256: policyDigest,
  budget: { totalTimeoutMs: 1000, cleanupReserveMs: 200 },
  signal: new AbortController().signal,
  ...overrides,
})

const transportReceipt = () => ({
  kind: 'https' as const,
  policySha256: policyDigest,
  endpointMapId: 'map-1',
  endpointId: 'a',
  redirectEndpointIds: ['b'],
})

async function* chunks() {
  yield new Uint8Array([1, 2, 3])
}

const result = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '1.0.0',
  resourceId: `sha256:${digest}`,
  chunks: chunks(),
  transportReceipt: transportReceipt(),
  ...overrides,
})

describe('frozen resolver protocol constants', () => {
  it('pins the protocol version', () => {
    expect(STRUCT_RESOLVER_PROTOCOL_VERSION).toBe('1.0.0')
  })
})

describe('strict own-data field reader', () => {
  it('rejects foreign prototypes, accessors, symbols, and unknown keys', () => {
    expect(() => readStructResolverFields(null, ['a'])).toThrow(StructResolverProtocolError)
    expect(() => readStructResolverFields([], ['a'])).toThrow(StructResolverProtocolError)
    expect(() => readStructResolverFields(Object.create({ inherited: 1 }), ['a'])).toThrow(
      StructResolverProtocolError,
    )
    expect(() => readStructResolverFields({ a: 1, b: 2 }, ['a'])).toThrow(
      StructResolverProtocolError,
    )
    expect(() => readStructResolverFields({}, ['a'])).toThrow(StructResolverProtocolError)
    const accessor = { a: 1 }
    Object.defineProperty(accessor, 'b', { enumerable: true, get: () => 2 })
    expect(() => readStructResolverFields(accessor, ['a', 'b'])).toThrow(
      StructResolverProtocolError,
    )
    const symbol = { a: 1 }
    Object.defineProperty(symbol, Symbol('x'), { enumerable: true, value: 2 })
    expect(() => readStructResolverFields(symbol, ['a'])).toThrow(
      StructResolverProtocolError,
    )
  })

  it('accepts an exact own-data record and a subset when required is narrowed', () => {
    expect(readStructResolverFields({ a: 1 }, ['a'])).toEqual({ a: 1 })
    expect(readStructResolverFields({ a: 1 }, ['a', 'b'], ['a'])).toEqual({ a: 1 })
  })
})

describe('execution identifier rules', () => {
  it('accepts bounded opaque printable identifiers', () => {
    expect(isStructResolverExecutionId('exec-1')).toBe(true)
    expect(isStructResolverExecutionId('01H8ZQ')).toBe(true)
    expect(isStructResolverExecutionId('a'.repeat(256))).toBe(true)
  })

  it('rejects empty, oversized, whitespace, non-ascii, and path-shaped identifiers', () => {
    for (const value of [
      '',
      'a'.repeat(257),
      'exec 1',
      'exec\t1',
      'exec\n1',
      'exec/1',
      'exec\\1',
      'https://example.test/asset',
      'ünïcode',
    ]) {
      expect(isStructResolverExecutionId(value)).toBe(false)
      expect(() => assertStructResolverExecutionId(value)).toThrow(
        StructResolverProtocolError,
      )
    }
    expect(isStructResolverExecutionId(42)).toBe(false)
    expect(isStructResolverExecutionId(null)).toBe(false)
  })
})

describe('logical href rules', () => {
  it('accepts a relative bundle path', () => {
    expect(isStructResolverLogicalHref('Text/chapter1.xhtml')).toBe(true)
    expect(isStructResolverLogicalHref('images/figure-1.png')).toBe(true)
  })

  it('rejects locator, absolute, traversal, and percent-encoded forms', () => {
    for (const value of [
      '',
      '/absolute/path.xhtml',
      'https://example.test/a.xhtml',
      'file:///etc/passwd',
      '../escape.xhtml',
      'a/../b.xhtml',
      'a/./b.xhtml',
      'a\\b.xhtml',
      'a%2fb.xhtml',
      'a?query=1',
      'a#fragment',
      'C:/windows',
    ]) {
      expect(isStructResolverLogicalHref(value)).toBe(false)
    }
  })
})

describe('budget plan', () => {
  it('reserves the cleanup budget from the total', () => {
    expect(planStructResolverBudget({ totalTimeoutMs: 1000, cleanupReserveMs: 200 })).toEqual({
      totalTimeoutMs: 1000,
      cleanupReserveMs: 200,
      workTimeoutMs: 800,
    })
    expect(Object.isFrozen(planStructResolverBudget({
      totalTimeoutMs: 10,
      cleanupReserveMs: 1,
    }))).toBe(true)
  })

  it('rejects zero, negative, oversized, and non-integer budgets', () => {
    for (const budget of [
      { totalTimeoutMs: 0, cleanupReserveMs: 1 },
      { totalTimeoutMs: 1000, cleanupReserveMs: 0 },
      { totalTimeoutMs: 1000, cleanupReserveMs: 1000 },
      { totalTimeoutMs: 1000, cleanupReserveMs: 2000 },
      { totalTimeoutMs: -1, cleanupReserveMs: 1 },
      { totalTimeoutMs: 1.5, cleanupReserveMs: 1 },
      { totalTimeoutMs: Number.MAX_SAFE_INTEGER + 2, cleanupReserveMs: 1 },
      { totalTimeoutMs: 1000 },
      { totalTimeoutMs: 1000, cleanupReserveMs: 1, extra: true },
    ]) {
      expect(() => planStructResolverBudget(budget)).toThrow(StructResolverProtocolError)
    }
  })
})

describe('request validation', () => {
  it('accepts a pinned request and freezes the canonical policy snapshot', () => {
    const validated = validateStructResolverRequest(request())
    expect(validated.protocolVersion).toBe('1.0.0')
    expect(validated.resourceId).toBe(`sha256:${digest}`)
    expect(validated.expectedPolicySha256).toBe(policyDigest)
    expect(validated.budget).toEqual({ totalTimeoutMs: 1000, cleanupReserveMs: 200 })
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.expected)).toBe(true)
    expect(Object.isFrozen(validated.policy)).toBe(true)
  })

  it('rejects a policy digest that disagrees with the policy', () => {
    expect(() => validateStructResolverRequest(
      request({ expectedPolicySha256: 'b'.repeat(64) }),
    )).toThrow(StructResolverProtocolError)
  })

  it('rejects a resource id that is not the expected digest address', () => {
    expect(() => validateStructResolverRequest(
      request({ resourceId: `sha256:${'b'.repeat(64)}` }),
    )).toThrow(StructResolverProtocolError)
  })

  it('rejects an unknown version, a locator-shaped href, and a malformed policy', () => {
    expect(() => validateStructResolverRequest(
      request({ protocolVersion: '2.0.0' }),
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverRequest(
      request({ logicalHref: 'https://example.test/a.xhtml' }),
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverRequest(
      request({ policy: { ...httpsPolicy(), transport: { kind: 'unknown' } } }),
    )).toThrow(StructResolverProtocolError)
  })

  it('rejects a missing, malformed, or non-signal abort member', () => {
    const withoutSignal = request()
    delete (withoutSignal as Record<string, unknown>).signal
    expect(() => validateStructResolverRequest(withoutSignal)).toThrow(
      StructResolverProtocolError,
    )
    expect(() => validateStructResolverRequest(request({ signal: 'abort' }))).toThrow(
      StructResolverProtocolError,
    )
  })

  it('rejects an unexpected member and an accessor', () => {
    expect(() => validateStructResolverRequest(request({ secret: 'x' }))).toThrow(
      StructResolverProtocolError,
    )
    const accessor = request() as Record<string, unknown>
    Object.defineProperty(accessor, 'extra', { enumerable: true, get: () => 1 })
    expect(() => validateStructResolverRequest(accessor)).toThrow(
      StructResolverProtocolError,
    )
  })
})

describe('result validation', () => {
  it('accepts a pinned result', () => {
    const validated = validateStructResolverResult(result())
    expect(validated.protocolVersion).toBe('1.0.0')
    expect(validated.resourceId).toBe(`sha256:${digest}`)
    expect(Object.isFrozen(validated)).toBe(true)
  })

  it('rejects a thenable, a missing chunk stream, and a locator-shaped receipt', () => {
    expect(() => validateStructResolverResult({
      ...result(),
      then: () => undefined,
    })).toThrow(StructResolverProtocolError)
    const withoutChunks = result() as Record<string, unknown>
    delete withoutChunks.chunks
    expect(() => validateStructResolverResult(withoutChunks)).toThrow(
      StructResolverProtocolError,
    )
    expect(() => validateStructResolverResult(result({
      transportReceipt: { ...transportReceipt(), url: 'https://example.test/a' },
    }))).toThrow(StructResolverProtocolError)
  })

  it('rejects a wrong version, a malformed resource id, and a negative length', () => {
    expect(() => validateStructResolverResult(result({ protocolVersion: '2.0.0' }))).toThrow(
      StructResolverProtocolError,
    )
    expect(() => validateStructResolverResult(result({ resourceId: 'sha256:zz' }))).toThrow(
      StructResolverProtocolError,
    )
    expect(() => validateStructResolverResult(result({ declaredByteLength: -1 }))).toThrow(
      StructResolverProtocolError,
    )
  })
})

describe('revocation receipt validation', () => {
  it('accepts the exact receipt bound to the expected id', () => {
    const receipt = validateStructResolverRevocationReceipt({
      executionId: 'exec-1',
      capabilitiesRevoked: true,
      quarantined: true,
    }, 'exec-1')
    expect(receipt).toEqual({
      executionId: 'exec-1',
      capabilitiesRevoked: true,
      quarantined: true,
    })
    expect(Object.isFrozen(receipt)).toBe(true)
  })

  it('rejects a foreign, swapped, partially populated, or promised receipt', () => {
    const base = {
      executionId: 'exec-1',
      capabilitiesRevoked: true,
      quarantined: true,
    }
    expect(() => validateStructResolverRevocationReceipt(base, 'exec-2')).toThrow(
      StructResolverProtocolError,
    )
    expect(() => validateStructResolverRevocationReceipt(
      { ...base, quarantined: false }, 'exec-1',
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverRevocationReceipt(
      { ...base, capabilitiesRevoked: false }, 'exec-1',
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverRevocationReceipt(
      { executionId: 'exec-1', quarantined: true }, 'exec-1',
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverRevocationReceipt(
      { ...base, extra: true }, 'exec-1',
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverRevocationReceipt(
      Promise.resolve(base), 'exec-1',
    )).toThrow(StructResolverProtocolError)
  })
})

describe('terminal receipt validation', () => {
  it('accepts the exact receipt bound to the expected id and state', () => {
    expect(validateStructResolverTerminalReceipt({
      executionId: 'exec-1',
      state: 'terminated',
    }, 'exec-1', 'terminated')).toEqual({ executionId: 'exec-1', state: 'terminated' })
  })

  it('rejects a swapped id, a wrong state, and an unknown state', () => {
    expect(() => validateStructResolverTerminalReceipt({
      executionId: 'exec-2',
      state: 'terminated',
    }, 'exec-1', 'terminated')).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverTerminalReceipt({
      executionId: 'exec-1',
      state: 'completed',
    }, 'exec-1', 'terminated')).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverTerminalReceipt({
      executionId: 'exec-1',
      state: 'unknown',
    }, 'exec-1', 'terminated')).toThrow(StructResolverProtocolError)
  })
})

describe('fail-stop receipt validation', () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: '1.0.0',
    executionId: 'exec-1',
    hostTerminated: true,
    descendantsDead: true,
    capacityRetired: true,
    evidence: {
      hostReaped: true,
      descendantCount: 0,
      waitedMs: 12,
      method: 'process-group',
    },
    ...overrides,
  })

  it('accepts exact parent-attested evidence', () => {
    const validated = validateStructResolverFailStopReceipt(receipt(), 'exec-1')
    expect(validated.capacityRetired).toBe(true)
    expect(validated.evidence.descendantCount).toBe(0)
    expect(Object.isFrozen(validated.evidence)).toBe(true)
  })

  it('rejects a foreign id, a false literal, a live descendant, and a bad method', () => {
    expect(() => validateStructResolverFailStopReceipt(receipt(), 'exec-2')).toThrow(
      StructResolverProtocolError,
    )
    expect(() => validateStructResolverFailStopReceipt(
      receipt({ descendantsDead: false }), 'exec-1',
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverFailStopReceipt(
      receipt({ evidence: {
        hostReaped: true,
        descendantCount: 1,
        waitedMs: 12,
        method: 'process-group',
      } }), 'exec-1',
    )).toThrow(StructResolverProtocolError)
    expect(() => validateStructResolverFailStopReceipt(
      receipt({ evidence: {
        hostReaped: true,
        descendantCount: 0,
        waitedMs: 12,
        method: 'timer',
      } }), 'exec-1',
    )).toThrow(StructResolverProtocolError)
  })
})
