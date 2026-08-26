import type { StructConsultationReceipt } from './consultation-receipt'

/**
 * Source-agnostic document structure used between extraction and typesetting.
 *
 * The research importer predates this boundary and has PDF-specific types.
 * STRUCT deliberately keeps only evidence and semantics that are useful for
 * any source (PDF, DOCX, HTML, or a future adapter).  Rendering code should
 * consume this graph, never the extractor's private implementation details.
 */

export const LEGACY_STRUCT_SCHEMA_VERSION = '0.1.0' as const
export const STRUCT_SCHEMA_VERSION = '0.2.0' as const
export type StructSchemaVersion =
  typeof LEGACY_STRUCT_SCHEMA_VERSION | typeof STRUCT_SCHEMA_VERSION

export type StructSourceFormat = 'pdf' | 'docx' | 'html' | 'image' | 'unknown'

export type StructSource = {
  format: StructSourceFormat
  fileName: string
  sha256: string
  byteLength: number
  pageCount: number
  localOnly: boolean
}

export type StructBox = {
  page: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export type StructEvidence = {
  confidence: number
  pages: number[]
  boxes: StructBox[]
  sourceIds: string[]
  /** Stable extractor-independent reasons supporting this evidence. */
  signals?: string[]
}

export type StructBlockKind =
  | 'heading'
  | 'paragraph'
  | 'quote'
  | 'list-item'
  | 'figure'
  | 'table'
  | 'equation'
  | 'caption'
  | 'footnote'
  | 'endnote'
  | 'code'
  | 'furniture'
  | 'unknown'

export type StructFurnitureEvidence = {
  classification:
    | 'repeated-text'
    | 'incrementing-numeral'
    | 'rotated-margin'
    | 'separator-rule'
    | 'explicit-paratext'
  band: 'top' | 'bottom' | 'left' | 'right'
  pages: number[]
  boxes: StructBox[]
  evidence: string[]
  normalizedText?: string
  sequence?: number[]
  sourceRunIndexes?: number[]
}

export type StructFurnitureReview = {
  reason: 'single-occurrence-margin'
  band: 'top' | 'bottom' | 'left' | 'right'
  pages: number[]
  boxes: StructBox[]
  evidence: string[]
}

export type StructInline = {
  start: number
  end: number
  href?: string
  annotationId?: string
  relationshipId?: string
  targetIds?: string[]
  bold?: boolean
  italic?: boolean
  verticalAlign?: 'superscript' | 'subscript'
  compactMathAtom?: boolean
  semanticRole?:
    | 'citation'
    | 'cross-reference'
    | 'note-reference'
    | 'affiliation-marker'
    | 'bibliography-entry'
}

export type StructMetadata = {
  title: string
  subtitle: string
  authors: string[]
  abstract: string
  language?: string
  baseDirection?: 'ltr' | 'rtl' | 'unknown'
  publicationDate?: string
  artifactModifiedAt?: string
  updated?: string
  affiliations?: string[]
  authorAffiliations?: Array<{ author: string; label: string }>
  authorNotes?: Array<{
    id: string
    author: string
    label: string
    target: string
  }>
}

export type StructTableCell = {
  id: string
  text: string
  row: number
  column: number
  rowSpan: number
  columnSpan: number
  headerScope: 'column' | 'row' | 'colgroup' | 'rowgroup' | null
  inline: StructInline[]
  evidence: StructEvidence
}

export type StructTable = {
  rows: number
  columns: number
  cells: StructTableCell[]
  semantic: 'verified' | 'source-preserved' | 'unresolved'
}

export type StructBlock = {
  id: string
  kind: StructBlockKind
  text: string
  label?: string
  page: number | null
  order: number
  column: 'single' | 'left' | 'right' | 'span' | null
  inline: StructInline[]
  evidence: StructEvidence
  /** Exact #198 source anchors resolved to this rendered block by #200. */
  sourceObservationAnchorIds?: string[]
  table?: StructTable
  fallbackAssetIds?: string[]
  furniture?: StructFurnitureEvidence
  furnitureReview?: StructFurnitureReview
  attributes?: Record<string, string | number | boolean>
}

export type StructAssetKind =
  'figure' | 'diagram' | 'table' | 'equation' | 'page-region' | 'unknown'

export type StructAsset = {
  id: string
  kind: StructAssetKind
  href: string
  mediaType: string
  sha256: string
  width: number
  height: number
  bytes?: Uint8Array
  sourceObjectIds: string[]
  evidence: StructEvidence
  fallback: 'asset' | 'source-region' | 'text'
}

export type StructRelationshipKind =
  | 'caption'
  | 'figure'
  | 'table'
  | 'equation'
  | 'footnote'
  | 'endnote'
  | 'citation'
  | 'cross-reference'
  | 'hyperlink'
  | 'reading-order'

export type StructRelationshipStatus =
  'matched' | 'ambiguous' | 'unresolved' | 'source-preserved'

export type StructRelationshipCandidate = {
  target: string
  confidence: number
  evidence: StructEvidence
}

export type StructRelationship = {
  id: string
  kind: StructRelationshipKind
  from: string
  to: string[]
  label?: string
  status: StructRelationshipStatus
  confidence: number
  evidence: StructEvidence
  /** Fail-closed alternatives retained when source evidence is non-unique. */
  candidates?: StructRelationshipCandidate[]
}

export type StructDiagnosticSeverity = 'info' | 'warning' | 'error'

export type StructDiagnostic = {
  id: string
  severity: StructDiagnosticSeverity
  category:
    | 'text'
    | 'layout'
    | 'visuals'
    | 'tables'
    | 'equations'
    | 'links'
    | 'notes'
    | 'source'
  title: string
  message: string
  action?: string
  pages: number[]
  sourceIds: string[]
}

export type StructPageLayout = {
  page: number
  width: number
  height: number
  rotation: number
  blocks: string[]
  columns: Array<{
    id: string
    side: 'single' | 'left' | 'right' | 'span'
    blockIds: string[]
  }>
}

export type StructRecovery = {
  status: 'ready' | 'review-required'
  title: string
  summary: string
  issues: Array<{
    category: StructDiagnostic['category']
    title: string
    count: number
    pages: number[]
    action?: string
  }>
  userAction?: string
}

export type StructReceipt = {
  schemaVersion: StructSchemaVersion
  /** Absent only on serialized 0.1.0 documents created before ID binding. */
  documentId?: string
  sourceSha256: string
  /** Closed, source-bound audit trail for any bounded model decisions. */
  modelConsultations?: StructConsultationReceipt
  blockCount: number
  assetCount: number
  relationshipCount: number
  diagnosticCount: number
  textCharacterCount: number
  conservation: {
    sourceNodeCount: number
    accountedSourceNodeCount: number
    sourceRegionCount: number
    accountedSourceRegionCount: number
    sourceAnnotationCount: number
    accountedSourceAnnotationCount: number
    sourceAssetCount: number
    accountedSourceAssetCount: number
    sourceRelationshipCount: number
    accountedSourceRelationshipCount: number
    sourceDiagnosticCount: number
    accountedSourceDiagnosticCount: number
    sourceTextCharacterCount: number
    structBlockCount: number
    structAssetCount: number
    structRelationshipCount: number
    structDiagnosticCount: number
    structTextCharacterCount: number
    /** Present for PDF graphs that contain accounted page furniture. */
    sourceFurnitureBlockCount?: number
    accountedFurnitureBlockCount?: number
    sourceFurnitureTextCharacterCount?: number
    structFurnitureBlockCount?: number
    structFurnitureTextCharacterCount?: number
    furnitureContaminationCount?: number
  }
  generatedSha256: string
}

export type StructDocument = {
  schemaVersion: StructSchemaVersion
  /** Absent only on serialized 0.1.0 documents created before ID binding. */
  documentId?: string
  source: StructSource
  metadata: StructMetadata
  blocks: StructBlock[]
  assets: StructAsset[]
  relationships: StructRelationship[]
  pages: StructPageLayout[]
  diagnostics: StructDiagnostic[]
  recovery: StructRecovery
  receipt: StructReceipt
}
