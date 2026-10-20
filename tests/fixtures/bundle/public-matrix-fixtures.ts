/**
 * Test-only helpers for the S-03 public Bundle conformance matrix.
 *
 * Everything in this module is adversarial-input construction or a consumer
 * owned resolver harness. Nothing here asserts a private contract: the
 * helpers build bytes and a resolver environment, and the assertions always
 * land on the public `./bundle` surface (`createStructBundle`,
 * `verifyStructBundle`, `decodeStructBundle`, `encodeStructBundle`).
 *
 * The private `canonicalJsonBytes` helper is used to serialize an envelope
 * that is deliberately *not* a valid Bundle envelope: the package's own
 * `canonicalBundleEnvelopeBytes` refuses exactly the shapes the negative
 * matrix has to submit (a wrong version, a foreign resource id, a missing
 * receipt, a duplicated asset id).
 */
import { canonicalBundleDocumentBytes, canonicalJsonBytes } from '../../../src/bundle/canonical'
import { sha256HexSync } from '../../../src/sha256'
import { structReceiptDigest } from '../../../src/receipt'
import { createStructResolverSupervisorV1 } from '../../../src/bundle/resolver-supervisor'
import type {
  StructAssetResolutionRequest,
  StructAssetResolutionResult,
  StructResolverExecutorV1,
} from '../../../src/bundle/resolver-protocol'
import { validDocument } from '../../codec-fixtures'

/** UTF-8 bytes of a string. */
export const publicMatrixUtf8 = (value: string): Uint8Array =>
  new TextEncoder().encode(value)

/** One asset of a matrix bundle. */
export type PublicMatrixAssetSpec = Readonly<{
  id: string
  bytes: Uint8Array
  /** Emits an external payload bound to the declared digest. */
  external?: boolean
  /** Overrides the envelope-declared byte length. */
  byteLength?: number
  /** Overrides the envelope-declared media type. */
  mediaType?: string
  /** Overrides the envelope-declared digest. */
  sha256?: string
  /** Overrides the embedded base64 spelling. */
  base64?: string
}>

/** A built matrix bundle: the document, the envelope, and its canonical bytes. */
export type PublicMatrixBundle = Readonly<{
  document: Record<string, unknown>
  records: Array<Record<string, unknown>>
  envelope: Record<string, unknown>
  canonical: Uint8Array
  bundleSha256: string
}>

/** Unicode-scalar comparison, the package's envelope asset order. */
function compareAssetIds(left: string, right: string): number {
  const first = Array.from(left)
  const second = Array.from(right)
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference = first[index]!.codePointAt(0)! - second[index]!.codePointAt(0)!
    if (difference !== 0) return difference
  }
  return first.length - second.length
}

/** Sorts envelope asset records the way the canonical envelope spells them. */
export function sortPublicMatrixAssets(
  records: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [...records].sort((left, right) =>
    compareAssetIds(String(left.id), String(right.id)))
}

/**
 * Reseals a document receipt after its content changed.
 *
 * The document codec verifies the semantic receipt digest, so any test that
 * changes the document has to reseal it before the package will accept it.
 */
export function sealPublicMatrixDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const receipt = document.receipt as Record<string, unknown>
  receipt.generatedSha256 = structReceiptDigest(document as never)
  return document
}

/**
 * Builds the canonical wire envelope of an already sealed document.
 *
 * The document digest is computed from the final document, so the envelope
 * stays digest-consistent and the test exercises the axis it targets.
 */
export function buildPublicMatrixEnvelope(
  document: Record<string, unknown>,
  records: ReadonlyArray<Record<string, unknown>>,
): Readonly<{
  canonical: Uint8Array
  documentSha256: string
  bundleSha256: string
}> {
  const documentBytes = canonicalBundleDocumentBytes(document)
  const envelope = {
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256: sha256HexSync(documentBytes),
    document,
    assets: sortPublicMatrixAssets(records),
    receipt: document.receipt,
  }
  const canonical = canonicalJsonBytes(envelope)
  return {
    canonical,
    documentSha256: envelope.documentSha256,
    bundleSha256: sha256HexSync(canonical),
  }
}

/**
 * Builds a create-path document whose assets carry the given byte length.
 *
 * The bytes travel as a `Uint8Array` carrier so that the document codec's own
 * textual bound does not mask the Bundle profile's asset caps.
 */
export function buildPublicMatrixCreateDocument(
  byteLengths: readonly number[],
): Record<string, unknown> {
  const base = buildPublicMatrixBundle([
    { id: 'asset-1', bytes: new Uint8Array([0, 255, 128]) },
  ])
  const document = structuredClone(base.document) as Record<string, unknown>
  const assets = document.assets as Array<Record<string, unknown>>
  const template = assets[0]!
  const built = byteLengths.map((byteLength, index) => {
    const bytes = new Uint8Array(byteLength)
    bytes.set([0, 255, 128].slice(0, Math.min(3, byteLength)))
    return {
      ...template,
      id: `asset-${index + 1}`,
      href: `assets/asset-${index + 1}.bin`,
      bytes,
      sha256: sha256HexSync(bytes),
    }
  })
  document.assets = built
  const receipt = document.receipt as Record<string, unknown>
  receipt.assetCount = built.length
  const conservation = receipt.conservation as Record<string, unknown>
  conservation.sourceAssetCount = built.length
  conservation.accountedSourceAssetCount = built.length
  conservation.structAssetCount = built.length
  sealPublicMatrixDocument(document)
  return document
}

/**
 * Builds one matrix bundle from a fixture document.
 *
 * `tamper` runs after the document is built and resealed but before the
 * envelope is serialized, so a test can create a canonical but semantically
 * invalid document, envelope, or asset set. The document digest is always
 * computed from the *final* document, so a tampered envelope stays
 * digest-consistent and the test exercises the intended axis.
 */
export function buildPublicMatrixBundle(
  specs: readonly PublicMatrixAssetSpec[],
  tamper?: (state: {
    document: Record<string, unknown>
    records: Array<Record<string, unknown>>
  }) => void,
): PublicMatrixBundle {
  const document = validDocument() as unknown as Record<string, unknown>
  const original = (document.assets as Array<Record<string, unknown>>)[0]!
  const mediaType = String(original.mediaType)
  const records = specs.map((spec) => {
    const digest = spec.sha256 ?? sha256HexSync(spec.bytes)
    return {
      id: spec.id,
      sha256: digest,
      mediaType: spec.mediaType ?? mediaType,
      byteLength: spec.byteLength ?? spec.bytes.byteLength,
      payload: spec.external
        ? { kind: 'external', resourceId: `sha256:${digest}` }
        : { kind: 'embedded', base64: spec.base64 ?? Buffer.from(spec.bytes).toString('base64') },
    } as Record<string, unknown>
  })
  document.assets = specs.map((spec) => {
    const asset: Record<string, unknown> = {
      ...original,
      id: spec.id,
      href: `assets/${spec.id}.bin`,
      sha256: spec.sha256 ?? sha256HexSync(spec.bytes),
    }
    delete asset.bytes
    return asset
  })
  // The fixture block falls back to the original asset id. Renaming the
  // assets would leave a dangling reference, so the fallback is remapped.
  const blocks = document.blocks as Array<Record<string, unknown>>
  for (const block of blocks) {
    const fallback = block.fallbackAssetIds
    if (!Array.isArray(fallback)) continue
    block.fallbackAssetIds = fallback.map((id) =>
      id === original.id ? specs[0]!.id : id)
  }
  const receipt = document.receipt as Record<string, unknown>
  receipt.assetCount = specs.length
  const conservation = receipt.conservation as Record<string, unknown>
  conservation.sourceAssetCount = specs.length
  conservation.accountedSourceAssetCount = specs.length
  conservation.structAssetCount = specs.length
  sealPublicMatrixDocument(document)
  if (tamper) tamper({ document, records })
  const envelope = {
    mediaType: 'application/vnd.erniesg.struct+json',
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256: sha256HexSync(canonicalJsonBytes(document)),
    document,
    assets: sortPublicMatrixAssets(records),
    receipt: document.receipt,
  }
  const canonical = canonicalJsonBytes(envelope)
  return {
    document,
    records,
    envelope,
    canonical,
    bundleSha256: sha256HexSync(canonical),
  }
}

/** How the harness host behaves when the driver starts an execution. */
export type PublicMatrixHostMode = 'gate' | 'hang'

/** A consumer owned resolver harness with a deterministic, non-wall-clock gate. */
export type PublicMatrixResolverHarness = Readonly<{
  readonly executor: StructResolverExecutorV1
  readonly requests: StructAssetResolutionRequest[]
  readonly executionIds: readonly string[]
  readonly teardown: readonly string[]
  readonly allocated: Promise<void>
  readonly release: () => void
  readonly activeCapacity: () => number
  readonly retiredExecutionIds: () => readonly string[]
}>

/**
 * Builds a resolver harness on the package reference supervisor.
 *
 * The supervisor owns admission control, so the profile's `maxConcurrency`
 * decides whether a second concurrent allocation is admitted. The bound host
 * is the adversarial part: it never settles until the test releases it, or it
 * never settles at all.
 */
export function createPublicMatrixResolverHarness(
  options: {
    mode?: PublicMatrixHostMode
    bytesByDigest?: (digest: string) => Uint8Array | undefined
    onAllocate?: (request: StructAssetResolutionRequest) => void
    /** Echoes a foreign policy digest in the transport receipt. */
    receiptPolicySha256?: string
  } = {},
): PublicMatrixResolverHarness {
  const mode = options.mode ?? 'gate'
  const requests: StructAssetResolutionRequest[] = []
  const executionIds: string[] = []
  const teardown: string[] = []
  let release = (): void => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  let announce = (): void => {}
  const allocated = new Promise<void>((resolve) => { announce = resolve })

  const supervisor = createStructResolverSupervisorV1({
    bind(request, executionId) {
      requests.push(request)
      executionIds.push(executionId)
      options.onAllocate?.(request)
      announce()
      return {
        executionId,
        async start(): Promise<StructAssetResolutionResult> {
          if (mode === 'hang')
            return new Promise<StructAssetResolutionResult>(() => {})
          await released
          const bytes = options.bytesByDigest?.(request.expected.sha256) ??
            new Uint8Array([1, 2, 3])
          return {
            protocolVersion: '1.0.0',
            resourceId: `sha256:${request.expected.sha256}`,
            chunks: (async function* stream() {
              yield bytes
            })(),
            transportReceipt: {
              kind: 'https',
              policySha256: options.receiptPolicySha256 ??
                request.expectedPolicySha256,
              endpointMapId: 'map-1',
              endpointId: 'a',
              redirectEndpointIds: [],
            },
          }
        },
        revokeAndQuarantine() {
          teardown.push('revoke')
          return {
            executionId,
            capabilitiesRevoked: true,
            quarantined: true,
          }
        },
        async cleanup() {
          teardown.push('cleanup')
        },
        async terminateAndJoin() {
          teardown.push('terminate')
          return { executionId, state: 'completed' as const }
        },
      }
    },
  })

  return {
    executor: supervisor.executor,
    requests,
    executionIds,
    teardown,
    allocated,
    release,
    activeCapacity: () => supervisor.activeCapacity(),
    retiredExecutionIds: () => supervisor.retiredExecutionIds(),
  }
}

/** Counts the resolutions that are in flight at the same moment. */
export function createPublicMatrixConcurrencyProbe(): {
  readonly inFlight: () => number
  readonly peak: () => number
  readonly enter: () => void
  readonly leave: () => void
} {
  let current = 0
  let peak = 0
  return {
    inFlight: () => current,
    peak: () => peak,
    enter: () => {
      current += 1
      if (current > peak) peak = current
    },
    leave: () => { current -= 1 },
  }
}
