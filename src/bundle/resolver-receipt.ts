import { canonicalJsonBytes } from './canonical'
import { validateResolverPolicyV1 } from './resolver-policy'

const decoder = new TextDecoder('utf-8', { fatal: true })
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DIGEST = /^[0-9a-f]{64}$/u

type Receipt =
  | Readonly<{ kind: 'https'; policySha256: string; endpointMapId: string; endpointId: string; redirectEndpointIds: readonly string[] }>
  | Readonly<{ kind: 'filesystem'; policySha256: string; rootCapabilityId: string }>
  | Readonly<{ kind: 'content-addressed'; policySha256: string; storeId: string }>

export type ResolverReceiptProjection = Readonly<{
  protocolVersion: '1.0.0'
  resourceId: `sha256:${string}`
  transportReceipt: Receipt
  declaredByteLength?: number
}>

export class ResolverReceiptError extends Error {
  constructor(readonly code: 'SHAPE' | 'VALUE') {
    super(`invalid resolver receipt: ${code.toLowerCase()}`)
    this.name = 'ResolverReceiptError'
  }
}

function fail(code: 'SHAPE' | 'VALUE'): never { throw new ResolverReceiptError(code) }

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SHAPE')
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields)
  if (required.some((key) => !Object.hasOwn(fields, key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) fail('SHAPE')
  return fields
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('VALUE')
  return value
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('VALUE')
  return value
}

function safeLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('VALUE')
  return value
}

/** Checks inert receipt data only. It does not inspect chunks or establish transport success. */
export function validateResolverReceiptProjection(
  contextValue: unknown,
  projectionValue: unknown,
): ResolverReceiptProjection {
  // Snapshot both inputs without invoking accessors or retaining caller aliases.
  const context = record(JSON.parse(decoder.decode(canonicalJsonBytes(contextValue))) as unknown,
    ['policy', 'expectedPolicySha256', 'expected'])
  const policy = validateResolverPolicyV1(context.policy)
  const expectedDigest = digest(context.expectedPolicySha256)
  if (expectedDigest !== policy.policySha256) fail('VALUE')
  const expected = record(context.expected, ['id', 'sha256', 'mediaType', 'byteLength'])
  if (typeof expected.id !== 'string' || expected.id.length === 0 ||
      typeof expected.mediaType !== 'string' || expected.mediaType.length === 0) fail('VALUE')
  const assetDigest = digest(expected.sha256)
  const assetLength = safeLength(expected.byteLength)

  const projection = record(JSON.parse(decoder.decode(canonicalJsonBytes(projectionValue))) as unknown,
    ['protocolVersion', 'resourceId', 'transportReceipt'], ['declaredByteLength'])
  if (projection.protocolVersion !== '1.0.0' ||
      projection.resourceId !== `sha256:${assetDigest}`) fail('VALUE')
  const hasLength = Object.hasOwn(projection, 'declaredByteLength')
  if (hasLength && safeLength(projection.declaredByteLength) !== assetLength) fail('VALUE')

  const transport = policy.policySnapshot().transport
  if (!projection.transportReceipt || typeof projection.transportReceipt !== 'object' ||
      Array.isArray(projection.transportReceipt)) fail('SHAPE')
  const rawReceipt = projection.transportReceipt as Record<string, unknown>
  if (digest(rawReceipt.policySha256) !== expectedDigest || rawReceipt.kind !== transport.kind)
    fail('VALUE')

  let transportReceipt: Receipt
  if (transport.kind === 'https') {
    const fields = record(projection.transportReceipt,
      ['kind', 'policySha256', 'endpointMapId', 'endpointId', 'redirectEndpointIds'])
    if (identifier(fields.endpointMapId) !== transport.endpointMapId) fail('VALUE')
    const endpointId = identifier(fields.endpointId)
    if (!transport.allowedEndpointIds.includes(endpointId)) fail('VALUE')
    if (!Array.isArray(fields.redirectEndpointIds)) fail('SHAPE')
    const ids = fields.redirectEndpointIds.map(identifier)
    if (ids.length > transport.maxRedirects ||
        (transport.redirects === 'deny' && ids.length !== 0) ||
        ids.some((id) => !transport.allowedEndpointIds.includes(id))) fail('VALUE')
    transportReceipt = Object.freeze({
      kind: 'https', policySha256: expectedDigest, endpointMapId: transport.endpointMapId,
      endpointId, redirectEndpointIds: Object.freeze(ids),
    })
  } else if (transport.kind === 'filesystem') {
    const fields = record(projection.transportReceipt,
      ['kind', 'policySha256', 'rootCapabilityId'])
    if (identifier(fields.rootCapabilityId) !== transport.rootCapabilityId) fail('VALUE')
    transportReceipt = Object.freeze({
      kind: 'filesystem', policySha256: expectedDigest, rootCapabilityId: transport.rootCapabilityId,
    })
  } else {
    const fields = record(projection.transportReceipt, ['kind', 'policySha256', 'storeId'])
    if (identifier(fields.storeId) !== transport.storeId) fail('VALUE')
    transportReceipt = Object.freeze({
      kind: 'content-addressed', policySha256: expectedDigest, storeId: transport.storeId,
    })
  }
  return Object.freeze({
    protocolVersion: '1.0.0', resourceId: `sha256:${assetDigest}`,
    transportReceipt, ...(hasLength ? { declaredByteLength: assetLength } : {}),
  })
}
