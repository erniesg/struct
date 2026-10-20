/**
 * Private external-bytes decoder core for StructBundle.
 *
 * This module decodes wire-format bundles that may carry external asset
 * references. It performs raw-digest gating, full canonical preflight,
 * strict asset-set/metadata verification, embedded asset decoding, and
 * resolver-driven external resolution before publishing a genuine handle
 * that shares encoder provenance with the embedded decoder.
 *
 * The implementation is private to the bundle package and is not part of the
 * public facade. A future public `decodeStructBundle` can delegate to the
 * single structured-result function here.
 */
import {
  CanonicalJsonError,
  canonicalBundleDocumentBytes,
  canonicalBundleEnvelopeBytes,
  parseCanonicalJsonBytes,
  snapshotCanonicalJsonInput,
} from './canonical'
import type { ByteFreeStructDocumentJson } from './canonical'
import { EmbeddedAssetError, verifyEmbeddedAssets } from './assets'
import { sha256HexSync } from '../sha256'
import {
  BundleValueLimitError,
  STRUCT_BUNDLE_LIMITS_PROFILE,
  STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
  assertStructBundleValueLimits,
} from './limits'
import type { StructBundleLimitsProfile } from './limits'
import {
  resolveStructResolverAssets,
  selectStructResolverTargets,
} from './resolver-execution'
import type {
  StructResolverAssetTarget,
  StructResolverExecutionOptions,
  StructResolverEnvelopeAssetProjection,
} from './resolver-execution'
import { planStructResolverBudget, StructResolverProtocolError } from './resolver-protocol'
import { validateResolverPolicyV1 } from './resolver-policy'
import { createVerifiedBundleHandle } from './embedded'

/** Stage identifiers for the private external failure taxonomy. */
export type ExternalDecodeStage =
  | 'input'
  | 'digest'
  | 'canonical'
  | 'assets'
  | 'resolve'
  | 'budget'

/** Private failure codes. Static only; no locator or input is ever retained. */
export type ExternalDecodeCode =
  | 'OPTIONS'
  | 'TYPE'
  | 'LIMIT'
  | 'MISMATCH'
  | 'SYNTAX'
  | 'NONCANONICAL'
  | 'SHAPE'
  | 'SET'
  | 'METADATA'
  | 'BASE64'
  | 'DIGEST'
  | 'UNRESOLVED'
  | 'BUDGET'
  | 'POLICY'
  | 'TARGET'
  | 'ALLOCATE'
  | 'START'
  | 'RESULT'
  | 'RECEIPT'
  | 'STREAM'
  | 'LENGTH'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'REVOCATION'
  | 'CLEANUP'
  | 'TERMINAL'
  | 'FAIL_STOP'

export type ExternalFailure = Readonly<{
  ok: false
  error: Readonly<{
    stage: ExternalDecodeStage
    code: ExternalDecodeCode
  }>
}>

/** Private genuine verified external bundle handle. */
export type VerifiedExternalBundle = Readonly<{
  bundleVersion: '1.0.0'
  schemaVersion: string
  documentSha256: string
  bundleSha256: string
  documentSnapshot(): ByteFreeStructDocumentJson
  assetIds(): readonly string[]
  assetBytes(id: string): Uint8Array | undefined
}>

export type ExternalAcceptanceResult =
  | Readonly<{ ok: true; bundle: VerifiedExternalBundle }>
  | ExternalFailure

/**
 * Flat resolver options. Every mandatory field is a sibling of the decoder
 * fields; there is deliberately no `resolver.executor` nesting.
 */
export type ExternalDecodeOptions = Readonly<{
  /** Optional expected raw bundle SHA-256. Checked before any parse. */
  expectedBundleSha256?: string
  /** Consumer-owned executor implementing StructResolverExecutorV1. */
  resolverExecutor?: StructResolverExecutionOptions['executor']
  /** Consumer-owned resolver policy snapshot. */
  resolverPolicy?: StructResolverExecutionOptions['policy']
  /** Mandatory explicit budget; there is no implicit default. */
  resolverBudget?: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  /** Optional caller AbortSignal. The package owns the execution controller. */
  resolverSignal?: AbortSignal
  /** Mandatory parent-owned fail-stop supervisor. */
  resolverHostSupervisor?: StructResolverExecutionOptions['hostSupervisor']
  /** Optional profile version; only the frozen version is accepted. */
  limitsProfile?: typeof STRUCT_BUNDLE_LIMITS_PROFILE_VERSION
}>

const DIGEST = /^[0-9a-f]{64}$/u

type ResolverOptions = Readonly<{
  executor: StructResolverExecutionOptions['executor']
  policy: StructResolverExecutionOptions['policy']
  budget: Readonly<{ totalTimeoutMs: number; cleanupReserveMs: number }>
  signal: AbortSignal | undefined
  hostSupervisor: StructResolverExecutionOptions['hostSupervisor']
}>

class ExternalAssetError extends Error {
  constructor(readonly code: 'SHAPE' | 'SET' | 'METADATA' | 'LIMIT' | 'BASE64') {
    super(`invalid external asset: ${code.toLowerCase()}`)
    this.name = 'ExternalAssetError'
  }
}

function failure(stage: ExternalDecodeStage, code: ExternalDecodeCode): ExternalFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ stage, code }) })
}

function ownField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
    throw new Error('options')
  return descriptor.value
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { aborted?: unknown; addEventListener?: unknown }
  return typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function'
}

/**
 * Reads the strict flat option object. All resolver fields must either be
 * absent together (embedded-only decode) or be present and valid. An explicit
 * `undefined` is not treated as an omitted resolver field.
 */
function parseOptions(
  supplied: boolean,
  options: unknown,
): Readonly<{ expected?: string; profile: StructBundleLimitsProfile; resolver?: ResolverOptions }> {
  if (!supplied) {
    return Object.freeze({ profile: STRUCT_BUNDLE_LIMITS_PROFILE })
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new Error('options')
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('options')
  const allowed = [
    'expectedBundleSha256',
    'resolverExecutor',
    'resolverPolicy',
    'resolverBudget',
    'resolverSignal',
    'resolverHostSupervisor',
    'limitsProfile',
  ] as const
  const keys = Reflect.ownKeys(options)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key as typeof allowed[number]))
      throw new Error('options')
  }

  let expected: string | undefined
  if (Object.hasOwn(options, 'expectedBundleSha256')) {
    const value = ownField(options, 'expectedBundleSha256')
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error('options')
    expected = value
  }

  if (Object.hasOwn(options, 'limitsProfile')) {
    const value = ownField(options, 'limitsProfile')
    if (value !== STRUCT_BUNDLE_LIMITS_PROFILE_VERSION) throw new Error('options')
  }

  const resolverKeys = [
    'resolverExecutor',
    'resolverPolicy',
    'resolverBudget',
    'resolverSignal',
    'resolverHostSupervisor',
  ] as const
  const present = resolverKeys.filter((key) => Object.hasOwn(options, key))
  let resolver: ResolverOptions | undefined
  if (present.length > 0) {
    for (const key of [
      'resolverExecutor',
      'resolverPolicy',
      'resolverBudget',
      'resolverHostSupervisor',
    ] as const) {
      if (!Object.hasOwn(options, key)) throw new Error('options')
    }
    const executor = ownField(options, 'resolverExecutor')
    if (!executor || typeof executor !== 'object' ||
      typeof (executor as { allocate?: unknown }).allocate !== 'function')
      throw new Error('options')
    const policy = ownField(options, 'resolverPolicy')
    if (!policy || typeof policy !== 'object') throw new Error('options')
    const budget = ownField(options, 'resolverBudget')
    if (!budget || typeof budget !== 'object' || Array.isArray(budget))
      throw new Error('options')
    const budgetKeys = Reflect.ownKeys(budget)
    for (const key of budgetKeys) {
      if (typeof key !== 'string' ||
        (key !== 'totalTimeoutMs' && key !== 'cleanupReserveMs'))
        throw new Error('options')
      if (typeof ownField(budget as object, key) !== 'number') throw new Error('options')
    }
    if (!Object.hasOwn(budget, 'totalTimeoutMs') ||
      !Object.hasOwn(budget, 'cleanupReserveMs'))
      throw new Error('options')
    const hostSupervisor = ownField(options, 'resolverHostSupervisor')
    if (!hostSupervisor || typeof hostSupervisor !== 'object' ||
      (hostSupervisor as { protocolVersion?: unknown }).protocolVersion !== '1.0.0' ||
      typeof (hostSupervisor as { failStop?: unknown }).failStop !== 'function')
      throw new Error('options')
    let signal: AbortSignal | undefined
    if (Object.hasOwn(options, 'resolverSignal')) {
      const value = ownField(options, 'resolverSignal')
      if (!isAbortSignalLike(value)) throw new Error('options')
      signal = value
    }
    resolver = Object.freeze({
      executor: executor as ResolverOptions['executor'],
      policy: policy as ResolverOptions['policy'],
      budget: Object.freeze({
        totalTimeoutMs: ownField(budget as object, 'totalTimeoutMs') as number,
        cleanupReserveMs: ownField(budget as object, 'cleanupReserveMs') as number,
      }),
      signal,
      hostSupervisor: hostSupervisor as ResolverOptions['hostSupervisor'],
    })
  }
  return Object.freeze({ expected, profile: STRUCT_BUNDLE_LIMITS_PROFILE, resolver })
}

/**
 * Strict asset-set and metadata preflight.
 *
 * Runs before any embedded decode and, critically, before any executor
 * allocate. It proves document/envelope set equality, metadata agreement,
 * per-asset bounds, aggregate bounds, count bounds, and external resource-id
 * binding for every asset, embedded or external.
 */
function preflightAssetSet(
  documentValue: unknown,
  envelopeValue: unknown,
  profile: StructBundleLimitsProfile,
): void {
  const document = documentValue as { assets?: unknown } | null
  const envelope = envelopeValue as { assets?: unknown } | null
  if (!document || typeof document !== 'object' ||
    !envelope || typeof envelope !== 'object')
    throw new ExternalAssetError('SHAPE')
  const documents = document.assets
  const envelopes = envelope.assets
  if (!Array.isArray(documents) || !Array.isArray(envelopes))
    throw new ExternalAssetError('SHAPE')
  if (documents.length > profile.maxAssets || envelopes.length > profile.maxAssets)
    throw new ExternalAssetError('LIMIT')
  if (documents.length !== envelopes.length)
    throw new ExternalAssetError('SET')

  const documentById = new Map<string, {
    href: unknown
    mediaType: unknown
    sha256: unknown
  }>()
  for (const candidate of documents as unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new ExternalAssetError('SHAPE')
    const asset = candidate as Record<string, unknown>
    const id = asset.id
    const href = asset.href
    const mediaType = asset.mediaType
    const sha256 = asset.sha256
    if (typeof id !== 'string' || id.length === 0)
      throw new ExternalAssetError('METADATA')
    if (documentById.has(id)) throw new ExternalAssetError('SET')
    if (typeof mediaType !== 'string' || mediaType.length === 0 ||
      typeof sha256 !== 'string' || !DIGEST.test(sha256))
      throw new ExternalAssetError('METADATA')
    documentById.set(id, { href, mediaType, sha256 })
  }

  const envelopeIds = new Set<string>()
  let total = 0
  for (const candidate of envelopes as unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new ExternalAssetError('SHAPE')
    const asset = candidate as Record<string, unknown>
    const id = asset.id
    if (typeof id !== 'string' || id.length === 0)
      throw new ExternalAssetError('METADATA')
    if (envelopeIds.has(id)) throw new ExternalAssetError('SET')
    envelopeIds.add(id)
    const documentAsset = documentById.get(id)
    if (!documentAsset) throw new ExternalAssetError('SET')
    if (documentAsset.sha256 !== asset.sha256 ||
      documentAsset.mediaType !== asset.mediaType)
      throw new ExternalAssetError('METADATA')
    const byteLength = asset.byteLength
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) ||
      byteLength < 0)
      throw new ExternalAssetError('METADATA')
    if (byteLength > profile.maxAssetBytes)
      throw new ExternalAssetError('LIMIT')
    if (byteLength > profile.maxTotalBytes - total ||
      byteLength > profile.maxDecodedBytes - total)
      throw new ExternalAssetError('LIMIT')
    total += byteLength

    const payload = asset.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new ExternalAssetError('SHAPE')
    const kind = (payload as Record<string, unknown>).kind
    if (kind === 'embedded') {
      const base64 = (payload as Record<string, unknown>).base64
      if (typeof base64 !== 'string') throw new ExternalAssetError('SHAPE')
      if (base64.length > profile.maxBase64Chars)
        throw new ExternalAssetError('LIMIT')
    } else if (kind === 'external') {
      if ((payload as Record<string, unknown>).resourceId !==
        `sha256:${String(asset.sha256)}`)
        throw new ExternalAssetError('METADATA')
    } else {
      throw new ExternalAssetError('SHAPE')
    }
  }
  if (envelopeIds.size !== documentById.size)
    throw new ExternalAssetError('SET')
}

/**
 * Decodes a wire-format StructBundle that may contain external assets.
 *
 * The processing order is fixed:
 * 1. options and flat resolver configuration;
 * 2. bounded raw snapshot (single copy);
 * 3. expected bundle SHA-256 check before any parse;
 * 4. canonical parse, profile value limits, full envelope canonicalization;
 * 5. strict asset-set/metadata preflight for every asset;
 * 6. embedded asset decode and external target selection (still no allocate);
 * 7. resolver execution with the remaining package monotonic budget;
 * 8. genuine handle publication only after all assets resolved and joined.
 *
 * It returns a structured result and never throws for expected failures.
 */
export async function decodeExternalBundleBytes(
  raw: Uint8Array,
  options?: Readonly<ExternalDecodeOptions>,
): Promise<ExternalAcceptanceResult> {
  // The package monotonic clock starts at function ENTRY, before input reads
  // or preflight, so preflight time is charged against the resolver budget.
  const started = (globalThis as { performance?: { now?: () => number } })
    .performance?.now?.() ?? Date.now()

  let expected: string | undefined
  let profile: StructBundleLimitsProfile
  let resolver: ResolverOptions | undefined
  try {
    const parsed = parseOptions(arguments.length > 1, options)
    expected = parsed.expected
    profile = parsed.profile
    resolver = parsed.resolver
  } catch {
    return failure('input', 'OPTIONS')
  }

  // Bounded raw snapshot, taken once. The caller's buffer is never retained.
  let snapshot: Uint8Array
  try {
    snapshot = snapshotCanonicalJsonInput(raw, profile.maxRawBytes)
  } catch (error) {
    return failure(
      'input',
      error instanceof CanonicalJsonError && error.code === 'LIMIT' ? 'LIMIT' : 'TYPE',
    )
  }

  // Expected raw digest is checked before parsing, canonicalization, or any
  // executor call.
  const bundleSha256 = sha256HexSync(snapshot)
  if (expected !== undefined && expected !== bundleSha256)
    return failure('digest', 'MISMATCH')

  // Canonical parse and full envelope projection.
  let envelope: {
    bundleVersion: '1.0.0'
    schemaVersion: string
    documentSha256: string
    document: ByteFreeStructDocumentJson
    assets: unknown
    receipt: unknown
  }
  let documentBytes: Uint8Array
  try {
    const value = parseCanonicalJsonBytes(snapshot, profile.maxRawBytes)
    assertStructBundleValueLimits(value, profile)
    const canonical = canonicalBundleEnvelopeBytes(value)
    if (canonical.length !== snapshot.length ||
      canonical.some((byte, index) => byte !== snapshot[index]))
      throw new CanonicalJsonError('NONCANONICAL')
    envelope = value as typeof envelope
    documentBytes = canonicalBundleDocumentBytes(envelope.document)
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      return failure('canonical', error.code)
    if (error instanceof BundleValueLimitError)
      return failure('canonical', error.code)
    return failure('canonical', 'TYPE')
  }

  // Full asset-set/metadata preflight before ANY executor allocate.
  try {
    preflightAssetSet(envelope.document, envelope, profile)
  } catch (error) {
    return failure('assets', error instanceof ExternalAssetError ? error.code : 'SHAPE')
  }

  // Embedded decode and external target selection happen next, still before
  // any allocate. A malformed later asset therefore prevents every allocate.
  let externalTargets: StructResolverAssetTarget[]
  let embeddedAssets: ReturnType<typeof verifyEmbeddedAssets>
  try {
    const envelopeAssets = envelope.assets as StructResolverEnvelopeAssetProjection[]
    const documentAssets = (envelope.document as {
      assets: Array<{ id: string; href: string; mediaType: string; sha256: string }>
    }).assets
    const embeddedEnvelopeAssets = envelopeAssets.filter(
      (asset) => asset.payload.kind === 'embedded',
    )
    const embeddedDocumentAssets = documentAssets.filter((asset) =>
      embeddedEnvelopeAssets.some((embedded) => embedded.id === asset.id),
    )
    if (embeddedEnvelopeAssets.length > 0) {
      embeddedAssets = verifyEmbeddedAssets(embeddedDocumentAssets, embeddedEnvelopeAssets, {
        maxAssets: profile.maxAssets,
        maxAssetBytes: profile.maxAssetBytes,
        maxTotalBytes: profile.maxTotalBytes,
        maxBase64Chars: profile.maxBase64Chars,
      })
    } else {
      embeddedAssets = { assetIds: () => [], assetBytes: () => undefined }
    }
    externalTargets = selectStructResolverTargets(documentAssets, envelopeAssets)
  } catch (error) {
    if (error instanceof EmbeddedAssetError) return failure('assets', error.code)
    if (error instanceof StructResolverProtocolError) return failure('assets', 'SHAPE')
    if (error instanceof ExternalAssetError) return failure('assets', error.code)
    return failure('assets', 'SHAPE')
  }

  // External resolution: mandatory configuration and no silent fallback.
  let resolvedExternalAssets: ReadonlyMap<string, Uint8Array> = new Map()
  if (externalTargets.length > 0) {
    if (!resolver) return failure('assets', 'UNRESOLVED')

    let plan: ReturnType<typeof planStructResolverBudget>
    try {
      plan = planStructResolverBudget(resolver.budget)
    } catch {
      return failure('budget', 'BUDGET')
    }
    const elapsed = ((globalThis as { performance?: { now?: () => number } })
      .performance?.now?.() ?? Date.now()) - started
    const remaining = plan.totalTimeoutMs - Math.floor(elapsed)
    if (remaining < 2) return failure('budget', 'BUDGET')

    let policyDigest: string
    let policySnapshot: StructResolverExecutionOptions['policy']
    try {
      const validated = validateResolverPolicyV1(resolver.policy)
      policyDigest = validated.policySha256
      policySnapshot = validated.policySnapshot()
    } catch {
      return failure('resolve', 'POLICY')
    }

    const driverOptions: StructResolverExecutionOptions = {
      executor: resolver.executor,
      hostSupervisor: resolver.hostSupervisor,
      policy: policySnapshot,
      expectedPolicySha256: policyDigest,
      budget: {
        totalTimeoutMs: remaining,
        cleanupReserveMs: Math.min(plan.cleanupReserveMs, remaining - 1),
      },
      ...(resolver.signal ? { signal: resolver.signal } : {}),
      // The package monotonic clock is used; no caller-supplied now.
    }

    const resolution = await resolveStructResolverAssets(externalTargets, driverOptions)
    if (!resolution.ok)
      return failure('resolve', resolution.error.code as ExternalDecodeCode)
    resolvedExternalAssets = resolution.assets
  }

  // Publish only after every asset was validated/resolved and joined.
  const combinedAssetBytes = new Map<string, Uint8Array>()
  for (const id of embeddedAssets.assetIds()) {
    const bytes = embeddedAssets.assetBytes(id)
    if (bytes) combinedAssetBytes.set(id, bytes)
  }
  for (const [id, bytes] of resolvedExternalAssets)
    combinedAssetBytes.set(id, bytes)

  const bundle = createVerifiedBundleHandle(
    envelope.bundleVersion,
    envelope.schemaVersion,
    envelope.documentSha256,
    bundleSha256,
    documentBytes,
    snapshot,
    combinedAssetBytes,
  )
  return Object.freeze({ ok: true, bundle })
}