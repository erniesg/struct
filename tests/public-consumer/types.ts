import {
  decodeCompatibleStructDocument,
  decodeStructDocument,
  encodeStructDocument,
  migrateStructDocument,
  type StructDocument,
} from '@erniesg/struct'
import { STRUCT_SCHEMA_VERSION } from '@erniesg/struct/document'
import { structDigest, structId } from '@erniesg/struct/identity'
import { orderBlocksByLayout } from '@erniesg/struct/ordering'
import {
  verifyStructReceipt,
  type StructConsultationReceipt,
} from '@erniesg/struct/receipt'
import { recoverySummary } from '@erniesg/struct/recovery'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import { buildStructEpub } from '@erniesg/struct/renderers/epub'

declare const input: unknown
declare const document: StructDocument
declare const receipt: StructConsultationReceipt

decodeCompatibleStructDocument(input)
decodeStructDocument(input)
encodeStructDocument(document)
migrateStructDocument(input)
STRUCT_SCHEMA_VERSION satisfies '0.2.0'
structDigest(document)
structId('document', 'fixture')
orderBlocksByLayout(document.blocks)
verifyStructReceipt(document)
receipt.schemaVersion satisfies string
recoverySummary({ ready: true, diagnostics: [] })
renderPublicationXhtml(document)
buildStructEpub(document)

// @ts-expect-error removed prerelease package subpath
await import('@erniesg/struct/core')
// @ts-expect-error Bundle remains unavailable until S-03
await import('@erniesg/struct/bundle')
