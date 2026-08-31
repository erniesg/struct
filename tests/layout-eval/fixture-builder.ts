import {
  decodeStructDocument,
  STRUCT_SCHEMA_VERSION,
  type StructAsset,
  type StructBlock,
  type StructDiagnostic,
  type StructDocument,
  type StructEvidence,
  type StructInline,
  type StructPageLayout,
  type StructRelationship,
  type StructTable,
  type StructTableCell,
} from '../../src/document/index'
import { MAX_TABLE_DIMENSION } from '../../src/document/codec/parsers'
import { structId } from '../../src/identity'
import { structReceiptDigest } from '../../src/receipt'
import { sha256HexSync } from '../../src/sha256'

export const SYNTHETIC_LAYOUT_CATEGORIES = Object.freeze([
  'paragraph',
  'hierarchy',
  'tables',
  'figures',
  'citations',
  'notes',
  'multicolumn',
  'rtl',
  'navigation',
  'assets',
  'metadata',
  'malformed',
  'bounds',
  'ambiguity',
] as const)

export const REQUIRED_SYNTHETIC_GOLDEN_ENTRIES = Object.freeze([
  'content.xhtml',
  'nav.xhtml',
  'package.opf',
  'container.xml',
  'styles.css',
  'archive.json',
] as const)

export const SYNTHETIC_PROVENANCE = Object.freeze({
  origin: 'synthetic' as const,
  authoredOn: '2026-08-30',
  license: 'MIT' as const,
})

const SYNTHETIC_ASSET_BYTE_LIMIT = 256
const SYNTHETIC_SOURCE_NAME = 'synthetic-input.struct'
const SYNTHETIC_TITLE = 'Synthetic Layout Publication'
const SYNTHETIC_AUTHOR = 'Example Writer'
const SYNTHETIC_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const textEncoder = new TextEncoder()

export type SyntheticLayoutCategory =
  (typeof SYNTHETIC_LAYOUT_CATEGORIES)[number]
export type SyntheticFixtureScenario =
  | 'positive'
  | 'negative'
  | 'safe-ambiguity'
export type SyntheticExpectedDisposition =
  | 'codec-rejection'
  | 'render'
  | 'renderer-rejection'
  | 'review-required-publication-refusal'
export type SyntheticGoldenEntry =
  (typeof REQUIRED_SYNTHETIC_GOLDEN_ENTRIES)[number]

export type SyntheticFixtureDescriptor = {
  caseId: string
  requiredCategories: SyntheticLayoutCategory[]
  scenario: SyntheticFixtureScenario
  expectedDisposition: SyntheticExpectedDisposition
  expectedCodecError?: string
  goldenEntries: SyntheticGoldenEntry[]
  provenanceKey: string
}

type FixtureDefinition = Omit<
  SyntheticFixtureDescriptor,
  'goldenEntries' | 'provenanceKey'
> & {
  configure?: (document: StructDocument) => void
  invalidate?: (document: StructDocument) => void
}

type SyntheticBlockOptions = {
  role?: string
  id?: string
  kind?: StructBlock['kind']
  text?: string
  label?: string
  page?: number | null
  order?: number
  column?: StructBlock['column']
  inline?: readonly StructInline[]
  evidence?: StructEvidence
  sourceObservationAnchorIds?: readonly string[]
  table?: StructTable
  fallbackAssetIds?: readonly string[]
  attributes?: Readonly<Record<string, string | number | boolean>>
}

type SyntheticTableCellOptions = {
  role?: string
  id?: string
  text?: string
  row?: number
  column?: number
  rowSpan?: number
  columnSpan?: number
  headerScope?: StructTableCell['headerScope']
  inline?: readonly StructInline[]
  evidence?: StructEvidence
}

type SyntheticAssetOptions = {
  role?: string
  id?: string
  kind?: StructAsset['kind']
  href?: string
  mediaType?: string
  width?: number
  height?: number
  includeBytes?: boolean
  sourceObjectIds?: readonly string[]
  evidence?: StructEvidence
  fallback?: StructAsset['fallback']
}

type SyntheticRelationshipOptions = {
  role?: string
  id?: string
  kind?: StructRelationship['kind']
  from?: string
  to?: readonly string[]
  label?: string
  status?: StructRelationship['status']
  confidence?: number
  evidence?: StructEvidence
  candidates?: StructRelationship['candidates']
}

type SyntheticDiagnosticOptions = {
  role?: string
  id?: string
  severity?: StructDiagnostic['severity']
  category?: StructDiagnostic['category']
  title?: string
  message?: string
  action?: string
  pages?: readonly number[]
  sourceIds?: readonly string[]
}

type MutableStructDocument = StructDocument & Record<string, unknown>
type BoundsProbeState = { cellStorageReads: number }

const boundsProbes = new WeakMap<StructDocument, BoundsProbeState>()

function copy<T>(value: T): T {
  return structuredClone(value)
}

function assertSyntheticId(value: string, label: string): void {
  if (value.length > 64 || !SYNTHETIC_ID.test(value))
    throw new TypeError(`${label} must be a closed synthetic identifier`)
}

function fixtureId(caseId: string, role: string, ordinal = 1): string {
  assertSyntheticId(caseId, 'case ID')
  assertSyntheticId(role, 'fixture role')
  return structId('layout-fixture', `${caseId}:${role}:${ordinal}`)
}

function syntheticHash(label: string): string {
  return sha256HexSync(textEncoder.encode(`invented-layout-value:${label}`))
}

export function syntheticEvidence(
  caseId: string,
  page = 1,
  role = 'evidence',
): StructEvidence {
  return {
    confidence: 1,
    pages: [page],
    boxes: [],
    sourceIds: [fixtureId(caseId, role)],
    signals: ['independently-invented-layout-evidence'],
  }
}

export function syntheticBlock(
  caseId: string,
  options: SyntheticBlockOptions = {},
): StructBlock {
  const role = options.role ?? 'block'
  const page = options.page === undefined ? 1 : options.page
  return {
    id: options.id ?? fixtureId(caseId, role),
    kind: options.kind ?? 'paragraph',
    text: options.text ?? 'Invented words form a public layout example.',
    ...(options.label === undefined ? {} : { label: options.label }),
    page,
    order: options.order ?? 0,
    column: options.column === undefined ? 'single' : options.column,
    inline: options.inline?.map((entry) => copy(entry)) ?? [],
    evidence: copy(
      options.evidence ?? syntheticEvidence(caseId, page ?? 1, `${role}-evidence`),
    ),
    ...(options.sourceObservationAnchorIds === undefined
      ? {}
      : {
          sourceObservationAnchorIds: [...options.sourceObservationAnchorIds],
        }),
    ...(options.table === undefined ? {} : { table: copy(options.table) }),
    ...(options.fallbackAssetIds === undefined
      ? {}
      : { fallbackAssetIds: [...options.fallbackAssetIds] }),
    ...(options.attributes === undefined
      ? {}
      : { attributes: { ...options.attributes } }),
  }
}

export function syntheticTableCell(
  caseId: string,
  options: SyntheticTableCellOptions = {},
): StructTableCell {
  const role = options.role ?? 'cell'
  return {
    id: options.id ?? fixtureId(caseId, role),
    text: options.text ?? 'Invented cell value.',
    row: options.row ?? 0,
    column: options.column ?? 0,
    rowSpan: options.rowSpan ?? 1,
    columnSpan: options.columnSpan ?? 1,
    headerScope:
      options.headerScope === undefined ? null : options.headerScope,
    inline: options.inline?.map((entry) => copy(entry)) ?? [],
    evidence: copy(
      options.evidence ?? syntheticEvidence(caseId, 1, `${role}-evidence`),
    ),
  }
}

export function syntheticAsset(
  caseId: string,
  options: SyntheticAssetOptions = {},
): StructAsset {
  const role = options.role ?? 'asset'
  const bytes = textEncoder.encode('Invented public asset note.\n')
  if (bytes.byteLength > SYNTHETIC_ASSET_BYTE_LIMIT)
    throw new RangeError('synthetic runtime asset exceeds its fixed bound')
  return {
    id: options.id ?? fixtureId(caseId, role),
    kind: options.kind ?? 'unknown',
    href: options.href ?? `assets/${caseId}-${role}.txt`,
    mediaType: options.mediaType ?? 'text/plain',
    sha256: sha256HexSync(bytes),
    width: options.width ?? 16,
    height: options.height ?? 16,
    ...(options.includeBytes === false ? {} : { bytes: bytes.slice() }),
    sourceObjectIds:
      options.sourceObjectIds === undefined
        ? [fixtureId(caseId, `${role}-object`)]
        : [...options.sourceObjectIds],
    evidence: copy(
      options.evidence ?? syntheticEvidence(caseId, 1, `${role}-evidence`),
    ),
    fallback: options.fallback ?? 'text',
  }
}

/** A tiny hand-authored SVG for explicit runtime-only image asset cases. */
export function syntheticSvgAsset(
  caseId: string,
  role = 'svg-asset',
): StructAsset {
  const bytes = textEncoder.encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="currentColor"/></svg>',
  )
  if (bytes.byteLength > SYNTHETIC_ASSET_BYTE_LIMIT)
    throw new RangeError('synthetic runtime asset exceeds its fixed bound')
  return {
    ...syntheticAsset(caseId, {
      role,
      kind: 'figure',
      href: `assets/${caseId}-${role}.svg`,
      mediaType: 'image/svg+xml',
      includeBytes: false,
      fallback: 'asset',
    }),
    sha256: sha256HexSync(bytes),
    bytes,
  }
}

export function syntheticRelationship(
  caseId: string,
  options: SyntheticRelationshipOptions = {},
): StructRelationship {
  const role = options.role ?? 'relationship'
  const from = options.from ?? fixtureId(caseId, 'block')
  return {
    id: options.id ?? fixtureId(caseId, role),
    kind: options.kind ?? 'reading-order',
    from,
    to: [...(options.to ?? [from])],
    ...(options.label === undefined ? {} : { label: options.label }),
    status: options.status ?? 'matched',
    confidence: options.confidence ?? 1,
    evidence: copy(
      options.evidence ?? syntheticEvidence(caseId, 1, `${role}-evidence`),
    ),
    ...(options.candidates === undefined
      ? {}
      : { candidates: copy(options.candidates) }),
  }
}

export function syntheticDiagnostic(
  caseId: string,
  options: SyntheticDiagnosticOptions = {},
): StructDiagnostic {
  const role = options.role ?? 'diagnostic'
  return {
    id: options.id ?? fixtureId(caseId, role),
    severity: options.severity ?? 'info',
    category: options.category ?? 'layout',
    title: options.title ?? 'Synthetic layout notice',
    message: options.message ?? 'Invented evidence is ready for evaluation.',
    ...(options.action === undefined ? {} : { action: options.action }),
    pages: [...(options.pages ?? [1])],
    sourceIds:
      options.sourceIds === undefined
        ? [fixtureId(caseId, `${role}-observation`)]
        : [...options.sourceIds],
  }
}

function pageLayout(
  caseId: string,
  blocks: readonly StructBlock[],
  columns: StructPageLayout['columns'],
): StructPageLayout {
  return {
    page: 1,
    width: 480,
    height: 640,
    rotation: 0,
    blocks: blocks.map(({ id }) => id),
    columns: copy(columns),
  }
}

function setSinglePage(
  document: StructDocument,
  caseId: string,
  blocks: readonly StructBlock[],
): void {
  document.blocks = blocks.map((block, index) => ({
    ...copy(block),
    page: 1,
    order: index,
    column: 'single',
  }))
  document.pages = [
    pageLayout(caseId, document.blocks, [
      {
        id: fixtureId(caseId, 'single-column'),
        side: 'single',
        blockIds: document.blocks.map(({ id }) => id),
      },
    ]),
  ]
}

function setReviewRequired(
  document: StructDocument,
  caseId: string,
  category: StructDiagnostic['category'],
): void {
  document.diagnostics = [
    syntheticDiagnostic(caseId, {
      severity: 'warning',
      category,
      title: 'Synthetic review checkpoint',
      message: 'The invented fallback remains deliberately reviewable.',
      action: 'Review the synthetic semantic choice.',
    }),
  ]
  document.recovery = {
    status: 'review-required',
    title: 'Synthetic review required',
    summary: 'The invented case intentionally stops before publication.',
    issues: [
      {
        category,
        title: 'Synthetic ambiguity',
        count: 1,
        pages: [1],
        action: 'Review the synthetic semantic choice.',
      },
    ],
    userAction: 'Review the invented case.',
  }
}

function initialDocument(caseId: string): StructDocument {
  const sourceMarker = textEncoder.encode(`invented-layout-input:${caseId}`)
  const document: StructDocument = {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    documentId: fixtureId(caseId, 'document'),
    source: {
      format: 'unknown',
      fileName: SYNTHETIC_SOURCE_NAME,
      sha256: sha256HexSync(sourceMarker),
      byteLength: sourceMarker.byteLength,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: SYNTHETIC_TITLE,
      subtitle: 'Invented Test Edition',
      authors: [SYNTHETIC_AUTHOR],
      abstract: 'Invented prose for a public structural layout evaluation.',
      language: 'en',
      baseDirection: 'ltr',
      publicationDate: '2000-01-01',
      artifactModifiedAt: '2000-01-01T00:00:00Z',
      updated: '2000-01-01',
    },
    blocks: [],
    assets: [],
    relationships: [],
    pages: [],
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Synthetic case ready',
      summary: 'The invented fixture has a complete public fallback.',
      issues: [],
    },
    receipt: {
      schemaVersion: STRUCT_SCHEMA_VERSION,
      documentId: fixtureId(caseId, 'document'),
      sourceSha256: sha256HexSync(sourceMarker),
      blockCount: 0,
      assetCount: 0,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount: 0,
      conservation: {
        sourceNodeCount: 0,
        accountedSourceNodeCount: 0,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 0,
        accountedSourceAssetCount: 0,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 0,
        structBlockCount: 0,
        structAssetCount: 0,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: 0,
      },
      generatedSha256: syntheticHash(`${caseId}:unsealed`),
    },
  }
  setSinglePage(document, caseId, [syntheticBlock(caseId)])
  return document
}

function inlineCount(document: StructDocument): number {
  return document.blocks.reduce(
    (count, block) =>
      count +
      block.inline.length +
      (block.table?.cells.reduce(
        (cellCount, cell) => cellCount + cell.inline.length,
        0,
      ) ??
        0),
    0,
  )
}

export function resealSyntheticDocument(
  document: StructDocument,
): StructDocument {
  if (
    document.schemaVersion !== STRUCT_SCHEMA_VERSION ||
    document.documentId === undefined
  )
    throw new TypeError('synthetic fixtures require the current schema binding')
  const textCharacterCount = document.blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  const furniture = document.blocks.filter(({ kind }) => kind === 'furniture')
  const furnitureTextCharacterCount = furniture.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  const conservation = {
    sourceNodeCount: document.blocks.length,
    accountedSourceNodeCount: document.blocks.length,
    sourceRegionCount: document.assets.length,
    accountedSourceRegionCount: document.assets.length,
    sourceAnnotationCount: inlineCount(document),
    accountedSourceAnnotationCount: inlineCount(document),
    sourceAssetCount: document.assets.length,
    accountedSourceAssetCount: document.assets.length,
    sourceRelationshipCount: document.relationships.length,
    accountedSourceRelationshipCount: document.relationships.length,
    sourceDiagnosticCount: document.diagnostics.length,
    accountedSourceDiagnosticCount: document.diagnostics.length,
    sourceTextCharacterCount: textCharacterCount,
    structBlockCount: document.blocks.length,
    structAssetCount: document.assets.length,
    structRelationshipCount: document.relationships.length,
    structDiagnosticCount: document.diagnostics.length,
    structTextCharacterCount: textCharacterCount,
    ...(furniture.length === 0
      ? {}
      : {
          sourceFurnitureBlockCount: furniture.length,
          accountedFurnitureBlockCount: furniture.length,
          sourceFurnitureTextCharacterCount: furnitureTextCharacterCount,
          structFurnitureBlockCount: furniture.length,
          structFurnitureTextCharacterCount: furnitureTextCharacterCount,
          furnitureContaminationCount: 0,
        }),
  }
  document.receipt = {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    documentId: document.documentId,
    sourceSha256: document.source.sha256,
    blockCount: document.blocks.length,
    assetCount: document.assets.length,
    relationshipCount: document.relationships.length,
    diagnosticCount: document.diagnostics.length,
    textCharacterCount,
    conservation,
    generatedSha256: syntheticHash(`${document.documentId}:pending-seal`),
  }
  document.receipt.generatedSha256 = structReceiptDigest(document)
  return document
}

export function mutateSyntheticFixtureAfterSeal(
  document: StructDocument,
  mutation: (document: MutableStructDocument) => void,
): StructDocument {
  decodeStructDocument(document)
  const finalSeal = document.receipt.generatedSha256
  mutation(document as MutableStructDocument)
  if (document.receipt.generatedSha256 !== finalSeal)
    throw new Error('intentional invalid mutation must preserve the final seal')
  return document
}

function paragraphCase(document: StructDocument, caseId: string): void {
  const text = 'Invented alpha text uses bold and raised marks.'
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'paragraph',
      text,
      inline: [
        { start: 0, end: 8, bold: true },
        { start: 9, end: 19, italic: true },
        { start: 35, end: 41, verticalAlign: 'superscript' },
      ],
    }),
  ])
}

function hierarchyCase(document: StructDocument, caseId: string): void {
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'heading-one',
      kind: 'heading',
      text: 'Invented Root',
      attributes: { level: 1 },
    }),
    syntheticBlock(caseId, {
      role: 'heading-three',
      kind: 'heading',
      text: 'Invented Nested Topic',
      attributes: { level: 3 },
    }),
    syntheticBlock(caseId, {
      role: 'heading-two',
      kind: 'heading',
      text: 'Invented Sibling Topic',
      attributes: { level: 2 },
    }),
  ])
}

function tableCase(document: StructDocument, caseId: string): void {
  const table: StructTable = {
    rows: 2,
    columns: 3,
    cells: [
      syntheticTableCell(caseId, {
        role: 'header-cell',
        text: 'Invented heading',
        row: 0,
        column: 0,
        columnSpan: 2,
        headerScope: 'column',
      }),
      syntheticTableCell(caseId, {
        role: 'value-cell',
        text: 'Invented value',
        row: 1,
        column: 2,
      }),
    ],
    semantic: 'verified',
  }
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'table',
      kind: 'table',
      text: 'Invented sparse table.',
      label: 'Invented table values',
      table,
    }),
  ])
}

function figureCase(document: StructDocument, caseId: string): void {
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'figure',
      kind: 'figure',
      text: 'Invented figure placeholder.',
      label: 'Invented labeled figure',
    }),
    syntheticBlock(caseId, {
      role: 'caption',
      kind: 'caption',
      text: 'Invented caption text.',
    }),
  ])
}

function relationshipCase(
  document: StructDocument,
  caseId: string,
  kind: 'citation' | 'footnote' | 'cross-reference',
  status: 'matched' | 'ambiguous',
): void {
  const markerId = fixtureId(caseId, 'marker')
  const targetId = fixtureId(caseId, 'target')
  const relationshipId = fixtureId(caseId, 'semantic-relationship')
  const marker = kind === 'citation' ? '[A]' : kind === 'footnote' ? '*' : 'see'
  const semanticRole =
    kind === 'citation'
      ? 'citation'
      : kind === 'footnote'
        ? 'note-reference'
        : 'cross-reference'
  const targetKind = kind === 'footnote' ? 'footnote' : 'paragraph'
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      id: markerId,
      role: 'marker',
      text: marker,
      inline: [
        {
          start: 0,
          end: marker.length,
          relationshipId,
          targetIds: [targetId],
          semanticRole,
        },
      ],
    }),
    syntheticBlock(caseId, {
      id: targetId,
      role: 'target',
      kind: targetKind,
      text:
        kind === 'footnote'
          ? 'Invented note body.'
          : 'Invented semantic target.',
      ...(kind === 'citation'
        ? { attributes: { bibliographyEntry: true } }
        : {}),
    }),
  ])
  document.relationships = [
    syntheticRelationship(caseId, {
      id: relationshipId,
      role: 'semantic-relationship',
      kind,
      from: markerId,
      to: status === 'matched' ? [targetId] : [],
      label: 'Invented marker',
      status,
      confidence: status === 'matched' ? 1 : 0.5,
      ...(status === 'ambiguous'
        ? {
            candidates: [
              {
                target: targetId,
                confidence: 0.5,
                evidence: syntheticEvidence(caseId, 1, 'candidate-evidence'),
              },
            ],
          }
        : {}),
    }),
  ]
}

function multicolumnCase(document: StructDocument, caseId: string): void {
  const blocks = [
    syntheticBlock(caseId, {
      role: 'span-block',
      text: 'Invented spanning introduction.',
      column: 'span',
    }),
    syntheticBlock(caseId, {
      role: 'left-block',
      text: 'Invented left evidence.',
      column: 'left',
    }),
    syntheticBlock(caseId, {
      role: 'right-block',
      text: 'Invented right evidence.',
      column: 'right',
    }),
  ].map((block, index) => ({ ...block, order: index }))
  document.blocks = blocks
  document.pages = [
    pageLayout(caseId, blocks, [
      {
        id: fixtureId(caseId, 'span-column'),
        side: 'span',
        blockIds: [blocks[0]!.id],
      },
      {
        id: fixtureId(caseId, 'left-column'),
        side: 'left',
        blockIds: [blocks[1]!.id],
      },
      {
        id: fixtureId(caseId, 'right-column'),
        side: 'right',
        blockIds: [blocks[2]!.id],
      },
    ]),
  ]
}

function rtlCase(document: StructDocument, caseId: string): void {
  document.metadata.language = 'ar'
  document.metadata.baseDirection = 'rtl'
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'rtl-paragraph',
      text: 'مثال A1 للنص الاصطناعي.',
    }),
  ])
}

function navigationCase(document: StructDocument, caseId: string): void {
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'nav-root',
      kind: 'heading',
      text: 'Invented Contents Root',
      attributes: { level: 1 },
    }),
    syntheticBlock(caseId, {
      role: 'nav-child',
      kind: 'heading',
      text: 'Invented Contents Child',
      attributes: { level: 2 },
    }),
  ])
}

function assetCase(document: StructDocument, caseId: string): void {
  const asset = syntheticSvgAsset(caseId, 'runtime-asset')
  document.assets = [asset]
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'asset-fallback',
      kind: 'figure',
      text: 'Invented asset fallback text.',
      label: 'Invented asset label',
      fallbackAssetIds: [asset.id],
    }),
  ])
}

function metadataCase(document: StructDocument, caseId: string): void {
  document.metadata = {
    ...document.metadata,
    subtitle: 'Invented & Escaped <Edition>',
    abstract: 'Invented metadata stays generic & explicit.',
    affiliations: ['Example Institute'],
    authorAffiliations: [{ author: SYNTHETIC_AUTHOR, label: 'A' }],
  }
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'metadata-body',
      text: 'Invented metadata body.',
    }),
  ])
}

function malformedCase(document: StructDocument, caseId: string): void {
  document.diagnostics = [
    syntheticDiagnostic(caseId, {
      category: 'layout',
      message: 'Invented validation evidence remains closed.',
    }),
  ]
}

function boundsCase(document: StructDocument, caseId: string): void {
  const table: StructTable = {
    rows: 8,
    columns: 8,
    cells: [
      syntheticTableCell(caseId, { role: 'first-bound-cell' }),
      syntheticTableCell(caseId, {
        role: 'last-bound-cell',
        row: 7,
        column: 7,
      }),
    ],
    semantic: 'verified',
  }
  setSinglePage(document, caseId, [
    syntheticBlock(caseId, {
      role: 'bounded-table',
      kind: 'table',
      text: 'Invented sparse bounded table.',
      label: 'Invented bounded values',
      table,
    }),
  ])
}

const definitions: readonly FixtureDefinition[] = [
  {
    caseId: 'paragraph-positive',
    requiredCategories: ['paragraph'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => paragraphCase(document, 'paragraph-positive'),
  },
  {
    caseId: 'paragraph-negative',
    requiredCategories: ['paragraph'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'RANGE',
    configure: (document) => paragraphCase(document, 'paragraph-negative'),
    invalidate(document) {
      document.blocks[0]!.inline[0]!.end = document.blocks[0]!.text.length + 1
    },
  },
  {
    caseId: 'hierarchy-positive',
    requiredCategories: ['hierarchy'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => hierarchyCase(document, 'hierarchy-positive'),
  },
  {
    caseId: 'hierarchy-negative',
    requiredCategories: ['hierarchy'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'ATTRIBUTE',
    configure: (document) => hierarchyCase(document, 'hierarchy-negative'),
    invalidate(document) {
      document.blocks[0]!.attributes!.level = 7
    },
  },
  {
    caseId: 'tables-positive',
    requiredCategories: ['tables'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => tableCase(document, 'tables-positive'),
  },
  {
    caseId: 'tables-negative',
    requiredCategories: ['tables'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'TABLE_OVERLAP',
    configure(document) {
      const caseId = 'tables-negative'
      const table: StructTable = {
        rows: 1,
        columns: 2,
        cells: [
          syntheticTableCell(caseId, { role: 'left-cell' }),
          syntheticTableCell(caseId, {
            role: 'right-cell',
            column: 1,
          }),
        ],
        semantic: 'verified',
      }
      setSinglePage(document, caseId, [
        syntheticBlock(caseId, {
          role: 'table',
          kind: 'table',
          text: 'Invented overlap mutation table.',
          table,
        }),
      ])
    },
    invalidate(document) {
      document.blocks[0]!.table!.cells[1]!.column = 0
    },
  },
  {
    caseId: 'figures-positive',
    requiredCategories: ['figures'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => figureCase(document, 'figures-positive'),
  },
  {
    caseId: 'figures-negative',
    requiredCategories: ['figures'],
    scenario: 'negative',
    expectedDisposition: 'review-required-publication-refusal',
    configure(document) {
      figureCase(document, 'figures-negative')
      setReviewRequired(document, 'figures-negative', 'visuals')
    },
  },
  {
    caseId: 'citations-positive',
    requiredCategories: ['citations'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) =>
      relationshipCase(document, 'citations-positive', 'citation', 'matched'),
  },
  {
    caseId: 'citations-safe-ambiguity',
    requiredCategories: ['citations'],
    scenario: 'safe-ambiguity',
    expectedDisposition: 'render',
    configure: (document) =>
      relationshipCase(
        document,
        'citations-safe-ambiguity',
        'citation',
        'ambiguous',
      ),
  },
  {
    caseId: 'notes-positive',
    requiredCategories: ['notes'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) =>
      relationshipCase(document, 'notes-positive', 'footnote', 'matched'),
  },
  {
    caseId: 'notes-safe-ambiguity',
    requiredCategories: ['notes'],
    scenario: 'safe-ambiguity',
    expectedDisposition: 'render',
    configure: (document) =>
      relationshipCase(
        document,
        'notes-safe-ambiguity',
        'footnote',
        'ambiguous',
      ),
  },
  {
    caseId: 'multicolumn-positive',
    requiredCategories: ['multicolumn'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) =>
      multicolumnCase(document, 'multicolumn-positive'),
  },
  {
    caseId: 'multicolumn-negative',
    requiredCategories: ['multicolumn'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'PAGE_BINDING',
    configure: (document) =>
      multicolumnCase(document, 'multicolumn-negative'),
    invalidate(document) {
      document.pages[0]!.columns[2]!.blockIds = [
        document.blocks[1]!.id,
      ]
    },
  },
  {
    caseId: 'rtl-positive',
    requiredCategories: ['rtl'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => rtlCase(document, 'rtl-positive'),
  },
  {
    caseId: 'rtl-safe-ambiguity',
    requiredCategories: ['rtl'],
    scenario: 'safe-ambiguity',
    expectedDisposition: 'review-required-publication-refusal',
    configure(document) {
      rtlCase(document, 'rtl-safe-ambiguity')
      document.metadata.baseDirection = 'unknown'
      setReviewRequired(document, 'rtl-safe-ambiguity', 'layout')
    },
  },
  {
    caseId: 'navigation-positive',
    requiredCategories: ['navigation'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => navigationCase(document, 'navigation-positive'),
  },
  {
    caseId: 'navigation-safe-ambiguity',
    requiredCategories: ['navigation'],
    scenario: 'safe-ambiguity',
    expectedDisposition: 'render',
    configure(document) {
      const caseId = 'navigation-safe-ambiguity'
      setSinglePage(document, caseId, [
        syntheticBlock(caseId, {
          role: 'omitted-furniture',
          kind: 'furniture',
          text: 'Invented marginal label.',
        }),
        syntheticBlock(caseId, {
          role: 'visible-body',
          text: 'Invented body without a heading.',
        }),
      ])
    },
  },
  {
    caseId: 'assets-positive',
    requiredCategories: ['assets'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => assetCase(document, 'assets-positive'),
  },
  {
    caseId: 'assets-negative',
    requiredCategories: ['assets'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'BYTES_HASH',
    configure: (document) => assetCase(document, 'assets-negative'),
    invalidate(document) {
      document.assets[0]!.sha256 = '0'.repeat(64)
    },
  },
  {
    caseId: 'metadata-positive',
    requiredCategories: ['metadata'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => metadataCase(document, 'metadata-positive'),
  },
  {
    caseId: 'metadata-negative',
    requiredCategories: ['metadata'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'DATE',
    configure: (document) => metadataCase(document, 'metadata-negative'),
    invalidate(document) {
      document.metadata.publicationDate = '2000-02-30'
    },
  },
  {
    caseId: 'malformed-positive',
    requiredCategories: ['malformed'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => malformedCase(document, 'malformed-positive'),
  },
  {
    caseId: 'malformed-negative',
    requiredCategories: ['malformed'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'UNKNOWN_FIELD',
    configure: (document) => malformedCase(document, 'malformed-negative'),
    invalidate(document) {
      Object.assign(document.blocks[0]!, { undeclaredSyntheticField: true })
    },
  },
  {
    caseId: 'bounds-positive',
    requiredCategories: ['bounds'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) => boundsCase(document, 'bounds-positive'),
  },
  {
    caseId: 'bounds-negative',
    requiredCategories: ['bounds'],
    scenario: 'negative',
    expectedDisposition: 'codec-rejection',
    expectedCodecError: 'TABLE_BOUNDS',
    configure(document) {
      const caseId = 'bounds-negative'
      const table: StructTable = {
        rows: 1,
        columns: 1,
        cells: [syntheticTableCell(caseId)],
        semantic: 'verified',
      }
      setSinglePage(document, caseId, [
        syntheticBlock(caseId, {
          role: 'bounded-table',
          kind: 'table',
          text: 'Invented proxy bound table.',
          table,
        }),
      ])
    },
    invalidate(document) {
      const state = { cellStorageReads: 0 }
      const rejectStorageRead = () => {
        state.cellStorageReads += 1
        throw new Error('synthetic bound proxy storage was inspected')
      }
      document.blocks[0]!.table!.rows = MAX_TABLE_DIMENSION + 1
      document.blocks[0]!.table!.cells = new Proxy([], {
        get: rejectStorageRead,
        getOwnPropertyDescriptor: rejectStorageRead,
        has: rejectStorageRead,
        ownKeys: rejectStorageRead,
      })
      boundsProbes.set(document, state)
    },
  },
  {
    caseId: 'ambiguity-positive',
    requiredCategories: ['ambiguity'],
    scenario: 'positive',
    expectedDisposition: 'render',
    configure: (document) =>
      relationshipCase(
        document,
        'ambiguity-positive',
        'cross-reference',
        'matched',
      ),
  },
  {
    caseId: 'ambiguity-safe',
    requiredCategories: ['ambiguity'],
    scenario: 'safe-ambiguity',
    expectedDisposition: 'render',
    configure: (document) =>
      relationshipCase(
        document,
        'ambiguity-safe',
        'cross-reference',
        'ambiguous',
      ),
  },
]

function descriptor(definition: FixtureDefinition): SyntheticFixtureDescriptor {
  return {
    caseId: definition.caseId,
    requiredCategories: [...definition.requiredCategories],
    scenario: definition.scenario,
    expectedDisposition: definition.expectedDisposition,
    ...(definition.expectedCodecError === undefined
      ? {}
      : { expectedCodecError: definition.expectedCodecError }),
    goldenEntries:
      definition.expectedDisposition === 'render'
        ? [...REQUIRED_SYNTHETIC_GOLDEN_ENTRIES]
        : [],
    provenanceKey: `${definition.caseId}-origin`,
  }
}

function definitionFor(caseId: string): FixtureDefinition {
  const definition = definitions.find((candidate) => candidate.caseId === caseId)
  if (!definition) throw new RangeError('unknown synthetic fixture case')
  return definition
}

export function listSyntheticFixtureCases(): SyntheticFixtureDescriptor[] {
  return definitions.map(descriptor)
}

export function buildSealedSyntheticFixture(caseId: string): StructDocument {
  const definition = definitionFor(caseId)
  const document = initialDocument(caseId)
  definition.configure?.(document)
  resealSyntheticDocument(document)
  decodeStructDocument(document)
  return document
}

export function buildSyntheticFixture(caseId: string): StructDocument {
  const definition = definitionFor(caseId)
  const document = buildSealedSyntheticFixture(caseId)
  if (definition.invalidate)
    mutateSyntheticFixtureAfterSeal(document, definition.invalidate)
  return document
}

export function getSyntheticBoundsProbe(
  document: StructDocument,
): Readonly<BoundsProbeState> {
  const probe = boundsProbes.get(document)
  if (!probe) throw new RangeError('synthetic bounds probe is unavailable')
  return { ...probe }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  )
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    JSON.stringify(value) === JSON.stringify(expected)
  )
}

function catalogFailure(kind: 'fixture catalog' | 'golden' | 'provenance'): never {
  throw new Error(`synthetic ${kind} contract mismatch`)
}

export function assertSyntheticFixtureCatalog(
  manifest: unknown,
  provenance: unknown,
  goldenPaths: readonly string[],
): void {
  const expected = listSyntheticFixtureCases()
  if (
    !isRecord(manifest) ||
    !exactKeys(manifest, ['cases']) ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== expected.length
  )
    catalogFailure('fixture catalog')

  for (const [index, fixture] of expected.entries()) {
    const candidate = manifest.cases[index]
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        'caseId',
        'requiredCategories',
        'expectedDisposition',
        'goldenEntries',
        'provenanceKey',
      ]) ||
      candidate.caseId !== fixture.caseId ||
      !exactStrings(candidate.requiredCategories, fixture.requiredCategories) ||
      candidate.expectedDisposition !== fixture.expectedDisposition ||
      candidate.provenanceKey !== fixture.provenanceKey
    )
      catalogFailure('fixture catalog')
    if (!exactStrings(candidate.goldenEntries, fixture.goldenEntries))
      catalogFailure('golden')
  }

  if (
    !isRecord(provenance) ||
    !exactKeys(provenance, ['records']) ||
    !Array.isArray(provenance.records) ||
    provenance.records.length !== expected.length
  )
    catalogFailure('provenance')

  for (const [index, fixture] of expected.entries()) {
    const candidate = provenance.records[index]
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        'provenanceKey',
        'origin',
        'authoredOn',
        'license',
      ]) ||
      candidate.provenanceKey !== fixture.provenanceKey ||
      candidate.origin !== SYNTHETIC_PROVENANCE.origin ||
      candidate.authoredOn !== SYNTHETIC_PROVENANCE.authoredOn ||
      candidate.license !== SYNTHETIC_PROVENANCE.license
    )
      catalogFailure('provenance')
  }

  const seenGoldenPaths = new Set<string>()
  for (const path of goldenPaths) {
    if (seenGoldenPaths.has(path)) catalogFailure('golden')
    seenGoldenPaths.add(path)
    const segments = path.split('/')
    const fixture = expected.find(({ caseId }) => caseId === segments[0])
    if (
      segments.length !== 2 ||
      !fixture ||
      !fixture.goldenEntries.includes(segments[1] as SyntheticGoldenEntry)
    )
      catalogFailure('golden')
  }
}
