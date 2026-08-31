import type { StructDocument } from '../document/index'
import {
  decodeStructDocument,
  snapshotStructDocumentForRenderer,
  validateStructDocumentTableBounds,
} from '../document/codec/parsers'
import { isStructCodecError } from '../document/codec/primitives'

const PUBLICATION_TITLE_EMPTY = 'STRUCT_PUBLICATION_TITLE_EMPTY'
const PUBLICATION_HEADING_LABEL_EMPTY =
  'STRUCT_PUBLICATION_HEADING_LABEL_EMPTY'
const PUBLICATION_TABLE_NAME_EMPTY = 'STRUCT_PUBLICATION_TABLE_NAME_EMPTY'
const PUBLICATION_TABLE_FALLBACK_REQUIRED =
  'STRUCT_PUBLICATION_TABLE_FALLBACK_REQUIRED'
const PUBLICATION_TABLE_FALLBACK_EMPTY =
  'STRUCT_PUBLICATION_TABLE_FALLBACK_EMPTY'
const PUBLICATION_IMAGE_ALT_EMPTY = 'STRUCT_PUBLICATION_IMAGE_ALT_EMPTY'
const PUBLICATION_IMAGE_MEDIA_TYPE_UNSUPPORTED =
  'STRUCT_PUBLICATION_IMAGE_MEDIA_TYPE_UNSUPPORTED'

function hasNonemptyNormalizedLabel(value: string): boolean {
  return (
    value
      .normalize('NFKC')
      .replace(/[\p{White_Space}\uFEFF]/gu, '').length > 0
  )
}

/** Select explicit neutral content without rewriting the selected value. */
export function selectPublicationAccessibleText(
  ...values: readonly (string | undefined)[]
): string | undefined {
  return values.find(
    (value): value is string =>
      value !== undefined && hasNonemptyNormalizedLabel(value),
  )
}

function renderedImageAssetIds(
  block: StructDocument['blocks'][number],
): readonly string[] {
  if (
    block.kind === 'figure' ||
    block.kind === 'equation' ||
    (block.kind === 'table' && block.table === undefined)
  )
    return block.fallbackAssetIds ?? []
  return []
}

/** Validate names required by publication accessibility without rewriting them. */
function assertPublicationLabels(document: StructDocument): void {
  if (!hasNonemptyNormalizedLabel(document.metadata.title))
    throw new Error(PUBLICATION_TITLE_EMPTY)

  for (const block of document.blocks)
    if (
      block.kind === 'heading' &&
      !hasNonemptyNormalizedLabel(block.text)
    )
      throw new Error(PUBLICATION_HEADING_LABEL_EMPTY)

  const assetsById = new Map(document.assets.map((asset) => [asset.id, asset]))
  for (const block of document.blocks) {
    if (block.kind === 'table' && block.table) {
      if (block.table.semantic === 'verified') {
        if (!selectPublicationAccessibleText(block.label, block.text))
          throw new Error(PUBLICATION_TABLE_NAME_EMPTY)
      } else if (
        block.table.semantic === 'source-preserved' &&
        block.table.accessibleFallback
      ) {
        const accessibleName =
          block.table.accessibleFallback.accessibleNameSource === 'block-label'
            ? block.label
            : block.text
        if (
          !hasNonemptyNormalizedLabel(block.text) ||
          accessibleName === undefined ||
          !hasNonemptyNormalizedLabel(accessibleName)
        )
          throw new Error(PUBLICATION_TABLE_FALLBACK_EMPTY)
      } else {
        throw new Error(PUBLICATION_TABLE_FALLBACK_REQUIRED)
      }
    }

    const assetIds = renderedImageAssetIds(block)
    if (assetIds.length === 0) continue
    if (!selectPublicationAccessibleText(block.label, block.text))
      throw new Error(PUBLICATION_IMAGE_ALT_EMPTY)
    for (const assetId of assetIds) {
      const asset = assetsById.get(assetId)
      if (!asset || !/^image\//iu.test(asset.mediaType))
        throw new Error(PUBLICATION_IMAGE_MEDIA_TYPE_UNSUPPORTED)
    }
  }
}

/** One bounded, strict normalization path shared by all renderers. */
export function normalizeStructDocumentForRenderer(
  input: StructDocument,
): StructDocument {
  validateStructDocumentTableBounds(input)
  const document = decodeStructDocument(
    snapshotStructDocumentForRenderer(input),
  )
  validateStructDocumentTableBounds(document)
  assertPublicationLabels(document)
  return document
}

export const isRendererIngressCodecError = isStructCodecError
