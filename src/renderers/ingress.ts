import type { StructDocument } from '../document/index'
import {
  snapshotStructDocumentForRenderer,
  validateStructDocumentTableBounds,
} from '../document/codec/parsers'
import { isStructCodecError } from '../document/codec/primitives'

/** One bounded, strict normalization path shared by all renderers. */
export function normalizeStructDocumentForRenderer(
  input: StructDocument,
): StructDocument {
  validateStructDocumentTableBounds(input)
  const document = snapshotStructDocumentForRenderer(input)
  validateStructDocumentTableBounds(document)
  return document
}

export const isRendererIngressCodecError = isStructCodecError
