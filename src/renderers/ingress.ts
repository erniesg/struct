import type { StructDocument } from '../document/index'
import {
  decodeStructDocument,
  snapshotStructDocumentForRenderer,
  validateStructDocumentTableBounds,
} from '../document/codec/parsers'
import { isStructCodecError } from '../document/codec/primitives'

/** One bounded, strict normalization path shared by all renderers. */
export function normalizeStructDocumentForRenderer(
  input: StructDocument,
): StructDocument {
  validateStructDocumentTableBounds(input)
  const document = decodeStructDocument(
    snapshotStructDocumentForRenderer(input),
  )
  validateStructDocumentTableBounds(document)
  return document
}

export const isRendererIngressCodecError = isStructCodecError
