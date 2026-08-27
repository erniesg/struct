import type { StructDocument } from '../document/index'
import { snapshotStructDocumentForRenderer } from '../document/codec/parsers'
import { isStructCodecError } from '../document/codec/primitives'

/** One bounded, strict normalization path shared by all renderers. */
export function normalizeStructDocumentForRenderer(
  input: StructDocument,
  renderer: 'xhtml' | 'epub',
): StructDocument {
  return renderer === 'epub'
    ? snapshotStructDocumentForRenderer(input)
    : input
}

export const isRendererIngressCodecError = isStructCodecError
