import { canonicalJsonBytes } from './canonical'
import { sha256HexSync } from '../sha256'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DOMAIN = new TextEncoder().encode('erniesg.struct.resolver-policy.v1')
const decoder = new TextDecoder('utf-8', { fatal: true })

type HttpsTransport = Readonly<{
  kind: 'https'
  endpointMapId: string
  allowedEndpointIds: readonly string[]
  redirects: 'deny' | 'same-origin'
  maxRedirects: number
  denyPrivateNetworks: true
  serializedLocators: false
}>

type FilesystemTransport = Readonly<{
  kind: 'filesystem'
  rootCapabilityId: string
  allowAbsolute: false
  allowTraversal: false
  allowSymlinks: false
}>

type ContentAddressedTransport = Readonly<{
  kind: 'content-addressed'
  storeId: string
  algorithm: 'sha256'
}>

export type StructAssetResolutionPolicyV1 = Readonly<{
  protocolVersion: '1.0.0'
  profileId: string
  profileVersion: string
  maxConcurrent: number
  transport: HttpsTransport | FilesystemTransport | ContentAddressedTransport
}>

export class ResolverPolicyError extends Error {
  constructor(readonly code: 'SHAPE' | 'VALUE') {
    super(`invalid resolver policy: ${code.toLowerCase()}`)
    this.name = 'ResolverPolicyError'
  }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ResolverPolicyError('SHAPE')
  const object = value as Record<string, unknown>
  const actual = Object.keys(object)
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    throw new ResolverPolicyError('SHAPE')
  return object
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    throw new ResolverPolicyError('VALUE')
  return value
}

function safeInteger(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new ResolverPolicyError('VALUE')
  return value
}

function transport(value: unknown): StructAssetResolutionPolicyV1['transport'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ResolverPolicyError('SHAPE')
  const kind = (value as Record<string, unknown>).kind
  if (kind === 'https') {
    const fields = record(value, [
      'kind', 'endpointMapId', 'allowedEndpointIds', 'redirects',
      'maxRedirects', 'denyPrivateNetworks', 'serializedLocators',
    ])
    if (!Array.isArray(fields.allowedEndpointIds) ||
      fields.denyPrivateNetworks !== true || fields.serializedLocators !== false ||
      (fields.redirects !== 'deny' && fields.redirects !== 'same-origin'))
      throw new ResolverPolicyError('VALUE')
    const ids = fields.allowedEndpointIds.map(identifier)
    if (new Set(ids).size !== ids.length)
      throw new ResolverPolicyError('VALUE')
    // The identifier grammar is ASCII, so code-unit and Unicode-scalar order agree.
    ids.sort()
    return Object.freeze({
      kind, endpointMapId: identifier(fields.endpointMapId),
      allowedEndpointIds: Object.freeze(ids), redirects: fields.redirects,
      maxRedirects: safeInteger(fields.maxRedirects, 0),
      denyPrivateNetworks: true, serializedLocators: false,
    })
  }
  if (kind === 'filesystem') {
    const fields = record(value, [
      'kind', 'rootCapabilityId', 'allowAbsolute', 'allowTraversal', 'allowSymlinks',
    ])
    if (fields.allowAbsolute !== false || fields.allowTraversal !== false ||
      fields.allowSymlinks !== false)
      throw new ResolverPolicyError('VALUE')
    return Object.freeze({
      kind, rootCapabilityId: identifier(fields.rootCapabilityId),
      allowAbsolute: false, allowTraversal: false, allowSymlinks: false,
    })
  }
  if (kind === 'content-addressed') {
    const fields = record(value, ['kind', 'storeId', 'algorithm'])
    if (fields.algorithm !== 'sha256') throw new ResolverPolicyError('VALUE')
    return Object.freeze({
      kind, storeId: identifier(fields.storeId), algorithm: 'sha256',
    })
  }
  throw new ResolverPolicyError('VALUE')
}

/** Strict private projection and domain-separated digest; no resolver authority. */
export function validateResolverPolicyV1(value: unknown): Readonly<{
  policySha256: string
  canonicalBytes(): Uint8Array
  policySnapshot(): StructAssetResolutionPolicyV1
}> {
  // Canonicalize first, then validate the JSON snapshot. This prevents an
  // in-memory caller from changing values between inspection and hashing.
  const snapshot = JSON.parse(decoder.decode(canonicalJsonBytes(value))) as unknown
  const fields = record(snapshot, [
    'protocolVersion', 'profileId', 'profileVersion', 'maxConcurrent', 'transport',
  ])
  if (fields.protocolVersion !== '1.0.0')
    throw new ResolverPolicyError('VALUE')
  const policy: StructAssetResolutionPolicyV1 = Object.freeze({
    protocolVersion: '1.0.0',
    profileId: identifier(fields.profileId),
    profileVersion: identifier(fields.profileVersion),
    maxConcurrent: safeInteger(fields.maxConcurrent, 0),
    transport: transport(fields.transport),
  })
  const bytes = canonicalJsonBytes(policy)
  const digestInput = new Uint8Array(DOMAIN.length + 1 + bytes.length)
  digestInput.set(DOMAIN)
  digestInput.set(bytes, DOMAIN.length + 1)
  const policySha256 = sha256HexSync(digestInput)
  return Object.freeze({
    policySha256,
    canonicalBytes: () => new Uint8Array(bytes),
    policySnapshot: () => policy,
  })
}
