/**
 * Test-only fixtures for the create preflight regression suite.
 *
 * The helpers build codec-valid STRUCT documents whose canonical size is
 * measured, so the preflight's budget can be exercised at exact boundaries.
 * Every builder keeps the receipt counts and the receipt digest consistent
 * with the document, so the document codec accepts the result and the only
 * reason to reject it is the size under test.
 */
import vectors from './fixtures/bundle-canonical/vectors.json'
import { canonicalJsonByteSize } from '../src/bundle/canonical'
import {
  decodeStructDocument,
  encodeStructDocument,
} from '../src/document/index'
import { structReceiptDigest } from '../src/receipt'
import { sha256HexSync } from '../src/sha256'

export type PreflightDocument = Record<string, unknown>

const current = vectors.find((value) => value.name === 'current:envelope')!

/** The published golden document, as a fresh mutable copy. */
export function goldenDocument(): PreflightDocument {
  return structuredClone(
    JSON.parse(current.canonical).document,
  ) as Record<string, unknown>
}

/** The golden document's single asset entry. */
export function goldenAsset(
  document: PreflightDocument,
): Record<string, unknown> {
  return (document.assets as Array<Record<string, unknown>>)[0]!
}

/** Recompute the receipt counts and the receipt digest of a document. */
export function syncReceipt(document: PreflightDocument): void {
  const receipt = document.receipt as Record<string, unknown>
  const conservation = receipt.conservation as Record<string, unknown>
  const blocks = document.blocks as Array<Record<string, unknown>>
  const assets = document.assets as Array<Record<string, unknown>>
  const relationships = document.relationships as Array<Record<string, unknown>>
  const diagnostics = document.diagnostics as Array<Record<string, unknown>>
  const text = blocks.reduce(
    (count, block) => count + String(block.text ?? '').length,
    0,
  )
  receipt.blockCount = blocks.length
  receipt.assetCount = assets.length
  receipt.relationshipCount = relationships.length
  receipt.diagnosticCount = diagnostics.length
  receipt.textCharacterCount = text
  conservation.structBlockCount = blocks.length
  conservation.structAssetCount = assets.length
  conservation.structRelationshipCount = relationships.length
  conservation.structDiagnosticCount = diagnostics.length
  conservation.structTextCharacterCount = text
  conservation.sourceTextCharacterCount = text
  conservation.accountedSourceAssetCount = assets.length
  conservation.accountedSourceRelationshipCount = relationships.length
  conservation.accountedSourceDiagnosticCount = diagnostics.length
  receipt.generatedSha256 = structReceiptDigest(document as never)
}

/**
 * A codec-valid document whose byte-free projection is larger than the
 * profile's field cap and smaller than its envelope byte cap.
 */
export function documentAboveFieldCap(): PreflightDocument {
  return documentWithLongMetadata(1_500_000)
}

/**
 * A codec-valid document whose byte-free projection is just below the
 * profile's field cap and smaller than its envelope byte cap.
 */
export function documentBelowFieldCap(): PreflightDocument {
  return documentWithLongMetadata(1_400_000)
}

/**
 * A codec-valid document whose byte-free projection is sized by two long
 * metadata strings. The codec caps a document string at 4 MiB, so the
 * cap-sized document needs two of them.
 */
function documentWithLongMetadata(subtitleLength: number): PreflightDocument {
  const document = goldenDocument()
  const metadata = document.metadata as Record<string, unknown>
  metadata.title = 't'.repeat(4 * 1024 * 1024)
  metadata.subtitle = 's'.repeat(subtitleLength)
  syncReceipt(document)
  return document
}

/** The same document with an asset of `byteLength` decoded bytes. */
export function withAssetPayload(
  document: PreflightDocument,
  byteLength: number,
): PreflightDocument {
  const bytes = new Uint8Array(byteLength)
  bytes.set([0, 255, 128])
  const asset = goldenAsset(document)
  asset.bytes = bytes
  asset.sha256 = sha256HexSync(bytes)
  syncReceipt(document)
  return document
}

/** The golden document whose first block carries `count` numeric attributes. */
export function documentWithNumericAttributes(
  count: number,
  value: unknown,
): PreflightDocument {
  const document = goldenDocument()
  const blocks = document.blocks as Array<Record<string, unknown>>
  const attributes: Record<string, unknown> = {}
  for (let index = 0; index < count; index += 1)
    attributes[`key-${index}`] = value
  blocks[0]!.attributes = attributes
  syncReceipt(document)
  return document
}

/** The golden document whose first block text holds `value` repeated. */
export function documentWithText(value: string, repeat: number): PreflightDocument {
  const document = goldenDocument()
  const blocks = document.blocks as Array<Record<string, unknown>>
  blocks[0]!.text = value.repeat(repeat)
  syncReceipt(document)
  return document
}

/**
 * The canonical size of the byte-free projection the create path hashes.
 *
 * This is the quantity the post-decode path charges against the envelope
 * field cap, and the quantity the preflight's own charge reproduces.
 */
export function projectionSize(document: unknown): number {
  const decoded = decodeStructDocument(document)
  const encoded = encodeStructDocument(decoded) as Record<string, unknown>
  return canonicalJsonByteSize({
    ...encoded,
    assets: (encoded.assets as Array<Record<string, unknown>>).map(
      ({ bytes: _bytes, ...asset }) => asset,
    ),
  })
}
