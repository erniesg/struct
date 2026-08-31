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

function hasNonemptyNormalizedLabel(value: string): boolean {
  return (
    value
      .normalize('NFKC')
      .replace(/[\p{White_Space}\uFEFF]/gu, '').length > 0
  )
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
