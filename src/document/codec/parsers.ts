import {
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
  type StructAsset,
  type StructBlock,
  type StructBox,
  type StructDiagnostic,
  type StructDocument,
  type StructEvidence,
  type StructFurnitureEvidence,
  type StructFurnitureReview,
  type StructInline,
  type StructMetadata,
  type StructPageLayout,
  type StructReceipt,
  type StructRecovery,
  type StructRelationship,
  type StructRelationshipCandidate,
  type StructSource,
  type StructTable,
  type StructTableCell,
} from '../types'
import {
  array,
  booleanValue,
  copyRecord,
  dataEntries,
  type DataObject,
  enumValue,
  fail,
  finiteNumber,
  hash,
  has,
  identifier,
  identifierList,
  integer,
  isStructCodecError,
  nonNegativeInteger,
  nullable,
  object,
  positiveInteger,
  positiveNumber,
  reference,
  referenceList,
  rotation,
  stringValue,
  utf8ByteLength,
  unique,
  unitInterval,
} from './primitives'
import {
  bytesToBase64,
  MAX_STRUCT_ASSET_BYTES,
  preflightBytes,
  parseBytes,
} from './bytes'
import { copyCanonicalJson, validateConsultationReceipt } from './model'
import {
  bcp47Language,
  mediaType,
  rfc3339Date,
  rfc3339DateTime,
} from './standards'
import { validateStructDocument } from './invariants'
import { sha256HexSync } from '../../sha256'

export { StructCodecError } from './primitives'

export type StructDocumentJson = Omit<StructDocument, 'assets'> & {
  assets: Array<Omit<StructAsset, 'bytes'> & { bytes?: string }>
}

const SOURCE_FORMATS = ['pdf', 'docx', 'html', 'image', 'unknown'] as const
const URL_CONTROL = /[\u0000-\u001f\u007f]/u
const BLOCK_KINDS = [
  'heading',
  'paragraph',
  'quote',
  'list-item',
  'figure',
  'table',
  'equation',
  'caption',
  'footnote',
  'endnote',
  'code',
  'furniture',
  'unknown',
] as const
const FURNITURE_CLASSIFICATIONS = [
  'repeated-text',
  'incrementing-numeral',
  'rotated-margin',
  'separator-rule',
  'explicit-paratext',
] as const
const BANDS = ['top', 'bottom', 'left', 'right'] as const
const VERTICAL_ALIGNS = ['superscript', 'subscript'] as const
const SEMANTIC_ROLES = [
  'citation',
  'cross-reference',
  'note-reference',
  'affiliation-marker',
  'bibliography-entry',
] as const
const BASE_DIRECTIONS = ['ltr', 'rtl', 'unknown'] as const
const HEADER_SCOPES = ['column', 'row', 'colgroup', 'rowgroup'] as const
const TABLE_SEMANTICS = ['verified', 'source-preserved', 'unresolved'] as const
const ASSET_KINDS = [
  'figure',
  'diagram',
  'table',
  'equation',
  'page-region',
  'unknown',
] as const
const ASSET_FALLBACKS = ['asset', 'source-region', 'text'] as const
const RELATIONSHIP_KINDS = [
  'caption',
  'figure',
  'table',
  'equation',
  'footnote',
  'endnote',
  'citation',
  'cross-reference',
  'hyperlink',
  'reading-order',
] as const
const RELATIONSHIP_STATUSES = [
  'matched',
  'ambiguous',
  'unresolved',
  'source-preserved',
] as const
const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'] as const
const DIAGNOSTIC_CATEGORIES = [
  'text',
  'layout',
  'visuals',
  'tables',
  'equations',
  'links',
  'notes',
  'source',
] as const
const COLUMN_SIDES = ['single', 'left', 'right', 'span'] as const
const RECOVERY_STATUSES = ['ready', 'review-required'] as const
/** Keep table-derived work within the existing 100,000-node structural budget. */
export const MAX_TABLE_DIMENSION = 100_000
export const MAX_TABLE_AREA = 100_000
export const MAX_STRUCT_ASSETS = 512
export const MAX_STRUCT_ASSET_BYTES_TOTAL = 128 * 1024 * 1024
export const MAX_STRUCT_RECOVERY_ISSUES = 10_000
export const MAX_STRUCT_RECOVERY_PAGES = 100_000
export const MAX_STRUCT_DOCUMENT_ITEMS = 1_000_000
const MAX_STRUCT_PUBLICATION_TEXT_BYTES = 16 * 1024 * 1024
const NODE_BOUND_MESSAGE =
  'publication input exceeds the structural node bound'

function parseBox(value: unknown, path: string): StructBox {
  const parsed = object(value, path, [
    'page',
    'x',
    'y',
    'width',
    'height',
    'rotation',
  ])
  return {
    page: positiveInteger(parsed.page, `${path}.page`),
    x: finiteNumber(parsed.x, `${path}.x`),
    y: finiteNumber(parsed.y, `${path}.y`),
    width: positiveNumber(parsed.width, `${path}.width`),
    height: positiveNumber(parsed.height, `${path}.height`),
    rotation: rotation(parsed.rotation, `${path}.rotation`),
  }
}

function parseEvidence(value: unknown, path: string): StructEvidence {
  const parsed = object(
    value,
    path,
    ['confidence', 'pages', 'boxes', 'sourceIds'],
    ['signals'],
  )
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    positiveInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  const sourceIds = identifierList(parsed.sourceIds, `${path}.sourceIds`)
  return {
    confidence: unitInterval(parsed.confidence, `${path}.confidence`),
    pages,
    boxes: array(parsed.boxes, `${path}.boxes`).map((box, index) =>
      parseBox(box, `${path}.boxes[${index}]`),
    ),
    sourceIds,
    ...(has(parsed, 'signals')
      ? {
          signals: array(parsed.signals, `${path}.signals`).map(
            (signal, index) => stringValue(signal, `${path}.signals[${index}]`),
          ),
        }
      : {}),
  }
}

function parseInline(value: unknown, path: string): StructInline {
  const parsed = object(
    value,
    path,
    ['start', 'end'],
    [
      'href',
      'annotationId',
      'relationshipId',
      'targetIds',
      'bold',
      'italic',
      'verticalAlign',
      'compactMathAtom',
      'semanticRole',
    ],
  )
  const start = nonNegativeInteger(parsed.start, `${path}.start`)
  const end = nonNegativeInteger(parsed.end, `${path}.end`)
  if (end < start) fail('RANGE', path, 'inline end must not precede start')
  if (
    start === end &&
    [
      'href',
      'annotationId',
      'relationshipId',
      'targetIds',
      'bold',
      'italic',
      'verticalAlign',
      'compactMathAtom',
      'semanticRole',
    ].some((key) => has(parsed, key))
  )
    fail(
      'RANGE',
      path,
      'zero-width inline runs cannot carry formatting or semantic data',
    )
  return {
    start,
    end,
    ...(has(parsed, 'href')
      ? { href: parseHref(parsed.href, `${path}.href`) }
      : {}),
    ...(has(parsed, 'annotationId')
      ? {
          annotationId: identifier(parsed.annotationId, `${path}.annotationId`),
        }
      : {}),
    ...(has(parsed, 'relationshipId')
      ? {
          relationshipId: identifier(
            parsed.relationshipId,
            `${path}.relationshipId`,
          ),
        }
      : {}),
    ...(has(parsed, 'targetIds')
      ? { targetIds: identifierList(parsed.targetIds, `${path}.targetIds`) }
      : {}),
    ...(has(parsed, 'bold')
      ? { bold: booleanValue(parsed.bold, `${path}.bold`) }
      : {}),
    ...(has(parsed, 'italic')
      ? { italic: booleanValue(parsed.italic, `${path}.italic`) }
      : {}),
    ...(has(parsed, 'verticalAlign')
      ? {
          verticalAlign: enumValue(
            parsed.verticalAlign,
            `${path}.verticalAlign`,
            VERTICAL_ALIGNS,
          ),
        }
      : {}),
    ...(has(parsed, 'compactMathAtom')
      ? {
          compactMathAtom: booleanValue(
            parsed.compactMathAtom,
            `${path}.compactMathAtom`,
          ),
        }
      : {}),
    ...(has(parsed, 'semanticRole')
      ? {
          semanticRole: enumValue(
            parsed.semanticRole,
            `${path}.semanticRole`,
            SEMANTIC_ROLES,
          ),
        }
      : {}),
  }
}

function parseInlineList(value: unknown, path: string, text: string) {
  const inline = array(value, path).map((entry, index) =>
    parseInline(entry, `${path}[${index}]`),
  )
  for (const [index, run] of inline.entries()) {
    if (run.end > text.length)
      fail(
        'RANGE',
        `${path}[${index}]`,
        'inline end must not exceed text length',
      )
  }
  return inline
}

function parseHref(value: unknown, path: string) {
  const parsed = stringValue(value, path)
  if (URL_CONTROL.test(parsed))
    fail('URL', path, 'href must not contain control characters')
  if (/^#[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(parsed)) return parsed
  try {
    const url = new URL(parsed)
    if (
      !['http:', 'https:', 'mailto:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error()
    if (url.href !== parsed) throw new Error()
    return parsed
  } catch {
    fail('URL', path, 'href must be a safe fragment or URL')
  }
}

function parseMetadata(value: unknown, path: string): StructMetadata {
  const parsed = object(
    value,
    path,
    ['title', 'subtitle', 'authors', 'abstract'],
    [
      'language',
      'baseDirection',
      'publicationDate',
      'artifactModifiedAt',
      'updated',
      'affiliations',
      'authorAffiliations',
      'authorNotes',
    ],
  )
  const authors = array(parsed.authors, `${path}.authors`).map(
    (author, index) => stringValue(author, `${path}.authors[${index}]`),
  )
  return {
    title: stringValue(parsed.title, `${path}.title`),
    subtitle: stringValue(parsed.subtitle, `${path}.subtitle`),
    authors,
    abstract: stringValue(parsed.abstract, `${path}.abstract`),
    ...(has(parsed, 'language')
      ? { language: bcp47Language(parsed.language, `${path}.language`) }
      : {}),
    ...(has(parsed, 'baseDirection')
      ? {
          baseDirection: enumValue(
            parsed.baseDirection,
            `${path}.baseDirection`,
            BASE_DIRECTIONS,
          ),
        }
      : {}),
    ...(has(parsed, 'publicationDate')
      ? {
          publicationDate: rfc3339Date(
            parsed.publicationDate,
            `${path}.publicationDate`,
          ),
        }
      : {}),
    ...(has(parsed, 'artifactModifiedAt')
      ? {
          artifactModifiedAt: rfc3339DateTime(
            parsed.artifactModifiedAt,
            `${path}.artifactModifiedAt`,
          ),
        }
      : {}),
    ...(has(parsed, 'updated')
      ? { updated: rfc3339Date(parsed.updated, `${path}.updated`) }
      : {}),
    ...(has(parsed, 'affiliations')
      ? {
          affiliations: array(parsed.affiliations, `${path}.affiliations`).map(
            (affiliation, index) =>
              stringValue(affiliation, `${path}.affiliations[${index}]`),
          ),
        }
      : {}),
    ...(has(parsed, 'authorAffiliations')
      ? {
          authorAffiliations: array(
            parsed.authorAffiliations,
            `${path}.authorAffiliations`,
          ).map((affiliation, index) => {
            const entry = object(
              affiliation,
              `${path}.authorAffiliations[${index}]`,
              ['author', 'label'],
            )
            return {
              author: stringValue(
                entry.author,
                `${path}.authorAffiliations[${index}].author`,
              ),
              label: stringValue(
                entry.label,
                `${path}.authorAffiliations[${index}].label`,
              ),
            }
          }),
        }
      : {}),
    ...(has(parsed, 'authorNotes')
      ? {
          authorNotes: (() => {
            const notes = array(parsed.authorNotes, `${path}.authorNotes`).map(
              (note, index) => {
                const entry = object(note, `${path}.authorNotes[${index}]`, [
                  'id',
                  'author',
                  'label',
                  'target',
                ])
                return {
                  id: identifier(entry.id, `${path}.authorNotes[${index}].id`),
                  author: stringValue(
                    entry.author,
                    `${path}.authorNotes[${index}].author`,
                  ),
                  label: stringValue(
                    entry.label,
                    `${path}.authorNotes[${index}].label`,
                  ),
                  target: identifier(
                    entry.target,
                    `${path}.authorNotes[${index}].target`,
                  ),
                }
              },
            )
            unique(
              notes.map((note) => note.id),
              `${path}.authorNotes`,
              'author note id',
            )
            return notes
          })(),
        }
      : {}),
  }
}

function parseFurnitureEvidence(
  value: unknown,
  path: string,
): StructFurnitureEvidence {
  const parsed = object(
    value,
    path,
    ['classification', 'band', 'pages', 'boxes', 'evidence'],
    ['normalizedText', 'sequence', 'sourceRunIndexes'],
  )
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    positiveInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  return {
    classification: enumValue(
      parsed.classification,
      `${path}.classification`,
      FURNITURE_CLASSIFICATIONS,
    ),
    band: enumValue(parsed.band, `${path}.band`, BANDS),
    pages,
    boxes: array(parsed.boxes, `${path}.boxes`).map((box, index) =>
      parseBox(box, `${path}.boxes[${index}]`),
    ),
    evidence: array(parsed.evidence, `${path}.evidence`).map((entry, index) =>
      stringValue(entry, `${path}.evidence[${index}]`),
    ),
    ...(has(parsed, 'normalizedText')
      ? {
          normalizedText: stringValue(
            parsed.normalizedText,
            `${path}.normalizedText`,
          ),
        }
      : {}),
    ...(has(parsed, 'sequence')
      ? {
          sequence: array(parsed.sequence, `${path}.sequence`).map(
            (entry, index) =>
              nonNegativeInteger(entry, `${path}.sequence[${index}]`),
          ),
        }
      : {}),
    ...(has(parsed, 'sourceRunIndexes')
      ? {
          sourceRunIndexes: array(
            parsed.sourceRunIndexes,
            `${path}.sourceRunIndexes`,
          ).map((entry, index) =>
            nonNegativeInteger(entry, `${path}.sourceRunIndexes[${index}]`),
          ),
        }
      : {}),
  }
}

function parseFurnitureReview(
  value: unknown,
  path: string,
): StructFurnitureReview {
  const parsed = object(value, path, [
    'reason',
    'band',
    'pages',
    'boxes',
    'evidence',
  ])
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    positiveInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  return {
    reason: enumValue(parsed.reason, `${path}.reason`, [
      'single-occurrence-margin',
    ] as const),
    band: enumValue(parsed.band, `${path}.band`, BANDS),
    pages,
    boxes: array(parsed.boxes, `${path}.boxes`).map((box, index) =>
      parseBox(box, `${path}.boxes[${index}]`),
    ),
    evidence: array(parsed.evidence, `${path}.evidence`).map((entry, index) =>
      stringValue(entry, `${path}.evidence[${index}]`),
    ),
  }
}

function parseAttributes(
  value: unknown,
  path: string,
): Record<string, string | number | boolean> {
  const entries: Array<[string, string | number | boolean]> = []
  for (const [key, child] of dataEntries(value, path).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (
      !key ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    )
      fail('FIELD', `${path}.${key}`, 'attribute key is not safe')
    if (typeof child === 'string')
      entries.push([key, stringValue(child, `${path}.${key}`)])
    else if (typeof child === 'boolean') entries.push([key, child])
    else if (typeof child === 'number')
      entries.push([key, finiteNumber(child, `${path}.${key}`)])
    else
      fail(
        'TYPE',
        `${path}.${key}`,
        'attribute value must be a string, number, or boolean',
      )
  }
  return copyRecord(entries) as Record<string, string | number | boolean>
}

function parseTableCell(value: unknown, path: string): StructTableCell {
  const parsed = object(value, path, [
    'id',
    'text',
    'row',
    'column',
    'rowSpan',
    'columnSpan',
    'headerScope',
    'inline',
    'evidence',
  ])
  const text = stringValue(parsed.text, `${path}.text`)
  return {
    id: identifier(parsed.id, `${path}.id`),
    text,
    row: nonNegativeInteger(parsed.row, `${path}.row`),
    column: nonNegativeInteger(parsed.column, `${path}.column`),
    rowSpan: integer(parsed.rowSpan, `${path}.rowSpan`, 1),
    columnSpan: integer(parsed.columnSpan, `${path}.columnSpan`, 1),
    headerScope:
      parsed.headerScope === null
        ? null
        : enumValue(parsed.headerScope, `${path}.headerScope`, HEADER_SCOPES),
    inline: parseInlineList(parsed.inline, `${path}.inline`, text),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
  }
}

export function validateStructTableBounds(value: unknown, path: string) {
  const parsed = object(value, path, ['rows', 'columns', 'cells', 'semantic'])
  const rows = nonNegativeInteger(parsed.rows, `${path}.rows`)
  const columns = nonNegativeInteger(parsed.columns, `${path}.columns`)
  if (
    rows > MAX_TABLE_DIMENSION ||
    columns > MAX_TABLE_DIMENSION ||
    rows * columns > MAX_TABLE_AREA
  )
    fail(
      'TABLE_BOUNDS',
      path,
      `table dimensions must fit within ${MAX_TABLE_DIMENSION} rows/columns and ${MAX_TABLE_AREA} cells`,
    )
  const cellsPath = `${path}.cells`
  let cells: unknown[]
  try {
    cells = array(parsed.cells, cellsPath, rows * columns)
  } catch (error) {
    if (
      isStructCodecError(error) &&
      error.code === 'BUDGET' &&
      error.path === cellsPath
    )
      fail(
        'TABLE_BOUNDS',
        cellsPath,
        'table cell count cannot exceed the declared table area',
      )
    throw error
  }
  return { rows, columns, cells, semantic: parsed.semantic }
}

/** Enforce renderer allocation bounds on direct STRUCT documents. */
export function validateStructDocumentTableBounds(value: unknown) {
  const document = copyRecord(dataEntries(value, '$'))
  if (!has(document, 'blocks'))
    fail('REQUIRED', '$.blocks', 'field is required')
  const blocks = array(document.blocks, '$.blocks', MAX_STRUCT_DOCUMENT_ITEMS)
  for (const [index, block] of blocks.entries()) {
    const path = `$.blocks[${index}]`
    const parsed = copyRecord(dataEntries(block, path))
    if (parsed.kind === 'table' && has(parsed, 'table'))
      validateStructTableBounds(parsed.table, `${path}.table`)
  }
}

function parseTable(value: unknown, path: string): StructTable {
  const parsed = validateStructTableBounds(value, path)
  const { rows, columns } = parsed
  const rawCells = parsed.cells
  const cells = rawCells.map((cell, index) =>
    parseTableCell(cell, `${path}.cells[${index}]`),
  )
  unique(
    cells.map((cell) => cell.id),
    `${path}.cells`,
    'table cell id',
  )
  for (const [index, cell] of cells.entries()) {
    if (cell.row >= rows || cell.row + cell.rowSpan > rows)
      fail(
        'TABLE_BOUNDS',
        `${path}.cells[${index}].row`,
        'cell row and rowSpan must fit within table rows',
      )
    if (cell.column >= columns || cell.column + cell.columnSpan > columns)
      fail(
        'TABLE_BOUNDS',
        `${path}.cells[${index}].column`,
        'cell column and columnSpan must fit within table columns',
      )
  }
  const occupied = new Set<string>()
  for (const [index, cell] of cells.entries()) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (
        let column = cell.column;
        column < cell.column + cell.columnSpan;
        column += 1
      ) {
        const coordinate = `${row}:${column}`
        if (occupied.has(coordinate))
          fail(
            'TABLE_OVERLAP',
            `${path}.cells[${index}]`,
            'table cells cannot overlap occupied coordinates',
          )
        occupied.add(coordinate)
      }
    }
  }
  return {
    rows,
    columns,
    cells,
    semantic: enumValue(parsed.semantic, `${path}.semantic`, TABLE_SEMANTICS),
  }
}

function parseBlock(value: unknown, path: string): StructBlock {
  const parsed = object(
    value,
    path,
    ['id', 'kind', 'text', 'page', 'order', 'column', 'inline', 'evidence'],
    [
      'label',
      'sourceObservationAnchorIds',
      'table',
      'fallbackAssetIds',
      'furniture',
      'furnitureReview',
      'attributes',
    ],
  )
  const text = stringValue(parsed.text, `${path}.text`)
  const kind = enumValue(parsed.kind, `${path}.kind`, BLOCK_KINDS)
  const attributes = has(parsed, 'attributes')
    ? parseAttributes(parsed.attributes, `${path}.attributes`)
    : undefined
  if (
    kind === 'heading' &&
    attributes?.level !== undefined &&
    (typeof attributes.level !== 'number' ||
      !Number.isInteger(attributes.level) ||
      attributes.level < 1 ||
      attributes.level > 6)
  )
    fail(
      'ATTRIBUTE',
      `${path}.attributes.level`,
      'heading level must be an integer from 1 through 6',
    )
  return {
    id: identifier(parsed.id, `${path}.id`),
    kind,
    text,
    ...(has(parsed, 'label')
      ? { label: stringValue(parsed.label, `${path}.label`) }
      : {}),
    page: nullable(parsed.page, `${path}.page`, (entry, entryPath) =>
      positiveInteger(entry, entryPath),
    ),
    order: nonNegativeInteger(parsed.order, `${path}.order`),
    column:
      parsed.column === null
        ? null
        : enumValue(parsed.column, `${path}.column`, COLUMN_SIDES),
    inline: parseInlineList(parsed.inline, `${path}.inline`, text),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
    ...(has(parsed, 'sourceObservationAnchorIds')
      ? {
          sourceObservationAnchorIds: identifierList(
            parsed.sourceObservationAnchorIds,
            `${path}.sourceObservationAnchorIds`,
          ),
        }
      : {}),
    ...(has(parsed, 'table')
      ? { table: parseTable(parsed.table, `${path}.table`) }
      : {}),
    ...(has(parsed, 'fallbackAssetIds')
      ? {
          fallbackAssetIds: identifierList(
            parsed.fallbackAssetIds,
            `${path}.fallbackAssetIds`,
          ),
        }
      : {}),
    ...(has(parsed, 'furniture')
      ? {
          furniture: parseFurnitureEvidence(
            parsed.furniture,
            `${path}.furniture`,
          ),
        }
      : {}),
    ...(has(parsed, 'furnitureReview')
      ? {
          furnitureReview: parseFurnitureReview(
            parsed.furnitureReview,
            `${path}.furnitureReview`,
          ),
        }
      : {}),
    ...(attributes ? { attributes } : {}),
  }
}

function snapshotAsset(value: unknown, path: string) {
  return copyRecord(dataEntries(value, path))
}

const ASSET_REQUIRED_FIELDS = [
  'id',
  'kind',
  'href',
  'mediaType',
  'sha256',
  'width',
  'height',
  'sourceObjectIds',
  'evidence',
  'fallback',
] as const
const ASSET_OPTIONAL_FIELDS = ['bytes'] as const
const ASSET_FIELDS = [...ASSET_REQUIRED_FIELDS, ...ASSET_OPTIONAL_FIELDS]
const ASSET_FIELD_SET = new Set<string>(ASSET_FIELDS)

function validateAssetSnapshot(value: DataObject, path: string) {
  for (const key of ASSET_REQUIRED_FIELDS) {
    if (!has(value, key))
      fail('REQUIRED', `${path}.${key}`, 'field is required')
  }
  for (const key of Object.keys(value)) {
    if (!ASSET_FIELD_SET.has(key))
      fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is not declared')
  }
  return copyRecord(
    ASSET_FIELDS.filter((key) => has(value, key)).map((key) => [
      key,
      value[key],
    ]),
  )
}

function parseAsset(
  parsed: DataObject,
  path: string,
  maximumBytes: number,
): StructAsset {
  const href = stringValue(parsed.href, `${path}.href`)
  if (URL_CONTROL.test(href))
    fail(
      'HREF',
      `${path}.href`,
      'asset href must not contain control characters',
    )
  if (
    !href ||
    href.trim() !== href ||
    href.startsWith('/') ||
    href.includes('\\') ||
    href.includes('?') ||
    href.includes('#') ||
    href.includes(':') ||
    href.includes('%') ||
    /\s/u.test(href) ||
    /(?:^|\/)\.(?:\.?)(?:\/|$)/u.test(href)
  )
    fail('HREF', `${path}.href`, 'asset href must be a canonical EPUB path')
  if (
    href
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  )
    fail('HREF', `${path}.href`, 'asset href must have canonical path segments')
  if (
    new Set([
      'package.opf',
      'nav.xhtml',
      'content.xhtml',
      'styles.css',
      'struct.json',
      'profile.json',
    ]).has(href)
  )
    fail('HREF', `${path}.href`, 'asset href is reserved by the EPUB package')
  const sha256 = hash(parsed.sha256, `${path}.sha256`)
  const bytes = has(parsed, 'bytes')
    ? parseBytes(parsed.bytes, `${path}.bytes`, maximumBytes)
    : undefined
  if (bytes && sha256HexSync(bytes) !== sha256)
    fail(
      'BYTES_HASH',
      `${path}.bytes`,
      'asset bytes do not match the declared SHA-256 digest',
    )
  return {
    id: identifier(parsed.id, `${path}.id`),
    kind: enumValue(parsed.kind, `${path}.kind`, ASSET_KINDS),
    href,
    mediaType: mediaType(parsed.mediaType, `${path}.mediaType`),
    sha256,
    width: positiveNumber(parsed.width, `${path}.width`),
    height: positiveNumber(parsed.height, `${path}.height`),
    ...(bytes ? { bytes } : {}),
    sourceObjectIds: identifierList(
      parsed.sourceObjectIds,
      `${path}.sourceObjectIds`,
    ),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
    fallback: enumValue(parsed.fallback, `${path}.fallback`, ASSET_FALLBACKS),
  }
}

function parseRelationshipCandidate(
  value: unknown,
  path: string,
): StructRelationshipCandidate {
  const parsed = object(value, path, ['target', 'confidence', 'evidence'])
  return {
    target: reference(parsed.target, `${path}.target`),
    confidence: unitInterval(parsed.confidence, `${path}.confidence`),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
  }
}

function parseRelationship(value: unknown, path: string): StructRelationship {
  const parsed = object(
    value,
    path,
    ['id', 'kind', 'from', 'to', 'status', 'confidence', 'evidence'],
    ['label', 'candidates'],
  )
  const candidates = has(parsed, 'candidates')
    ? array(parsed.candidates, `${path}.candidates`).map((candidate, index) =>
        parseRelationshipCandidate(candidate, `${path}.candidates[${index}]`),
      )
    : undefined
  if (candidates)
    unique(
      candidates.map((candidate) => candidate.target),
      `${path}.candidates`,
      'candidate target',
    )
  return {
    id: identifier(parsed.id, `${path}.id`),
    kind: enumValue(parsed.kind, `${path}.kind`, RELATIONSHIP_KINDS),
    from: identifier(parsed.from, `${path}.from`),
    to: referenceList(parsed.to, `${path}.to`),
    ...(has(parsed, 'label')
      ? { label: stringValue(parsed.label, `${path}.label`) }
      : {}),
    status: enumValue(parsed.status, `${path}.status`, RELATIONSHIP_STATUSES),
    confidence: unitInterval(parsed.confidence, `${path}.confidence`),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
    ...(candidates ? { candidates } : {}),
  }
}

function parseDiagnostic(value: unknown, path: string): StructDiagnostic {
  const parsed = object(
    value,
    path,
    ['id', 'severity', 'category', 'title', 'message', 'pages', 'sourceIds'],
    ['action'],
  )
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    positiveInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  return {
    id: identifier(parsed.id, `${path}.id`),
    severity: enumValue(
      parsed.severity,
      `${path}.severity`,
      DIAGNOSTIC_SEVERITIES,
    ),
    category: enumValue(
      parsed.category,
      `${path}.category`,
      DIAGNOSTIC_CATEGORIES,
    ),
    title: stringValue(parsed.title, `${path}.title`),
    message: stringValue(parsed.message, `${path}.message`),
    ...(has(parsed, 'action')
      ? { action: stringValue(parsed.action, `${path}.action`) }
      : {}),
    pages,
    sourceIds: identifierList(parsed.sourceIds, `${path}.sourceIds`),
  }
}

function parsePage(value: unknown, path: string): StructPageLayout {
  const parsed = object(value, path, [
    'page',
    'width',
    'height',
    'rotation',
    'blocks',
    'columns',
  ])
  const columns = array(parsed.columns, `${path}.columns`).map(
    (column, index) => {
      const entry = object(column, `${path}.columns[${index}]`, [
        'id',
        'side',
        'blockIds',
      ])
      return {
        id: identifier(entry.id, `${path}.columns[${index}].id`),
        side: enumValue(
          entry.side,
          `${path}.columns[${index}].side`,
          COLUMN_SIDES,
        ),
        blockIds: identifierList(
          entry.blockIds,
          `${path}.columns[${index}].blockIds`,
        ),
      }
    },
  )
  unique(
    columns.map((column) => column.id),
    `${path}.columns`,
    'column id',
  )
  return {
    page: positiveInteger(parsed.page, `${path}.page`),
    width: positiveNumber(parsed.width, `${path}.width`),
    height: positiveNumber(parsed.height, `${path}.height`),
    rotation: rotation(parsed.rotation, `${path}.rotation`),
    blocks: identifierList(parsed.blocks, `${path}.blocks`),
    columns,
  }
}

function parseRecovery(value: unknown, path: string): StructRecovery {
  const parsed = object(
    value,
    path,
    ['status', 'title', 'summary', 'issues'],
    ['userAction'],
  )
  let remainingPages = MAX_STRUCT_RECOVERY_PAGES
  const issues = array(
    parsed.issues,
    `${path}.issues`,
    MAX_STRUCT_RECOVERY_ISSUES,
  ).map((issue, index) => {
    const entry = object(
      issue,
      `${path}.issues[${index}]`,
      ['category', 'title', 'count', 'pages'],
      ['action'],
    )
    const pages = array(
      entry.pages,
      `${path}.issues[${index}].pages`,
      remainingPages,
    ).map((page, pageIndex) =>
      positiveInteger(page, `${path}.issues[${index}].pages[${pageIndex}]`),
    )
    remainingPages -= pages.length
    unique(pages.map(String), `${path}.issues[${index}].pages`, 'page')
    return {
      category: enumValue(
        entry.category,
        `${path}.issues[${index}].category`,
        DIAGNOSTIC_CATEGORIES,
      ),
      title: stringValue(entry.title, `${path}.issues[${index}].title`),
      count: nonNegativeInteger(entry.count, `${path}.issues[${index}].count`),
      pages,
      ...(has(entry, 'action')
        ? {
            action: stringValue(
              entry.action,
              `${path}.issues[${index}].action`,
            ),
          }
        : {}),
    }
  })
  return {
    status: enumValue(parsed.status, `${path}.status`, RECOVERY_STATUSES),
    title: stringValue(parsed.title, `${path}.title`),
    summary: stringValue(parsed.summary, `${path}.summary`),
    issues,
    ...(has(parsed, 'userAction')
      ? { userAction: stringValue(parsed.userAction, `${path}.userAction`) }
      : {}),
  }
}

const CONSERVATION_REQUIRED = [
  'sourceNodeCount',
  'accountedSourceNodeCount',
  'sourceRegionCount',
  'accountedSourceRegionCount',
  'sourceAnnotationCount',
  'accountedSourceAnnotationCount',
  'sourceAssetCount',
  'accountedSourceAssetCount',
  'sourceRelationshipCount',
  'accountedSourceRelationshipCount',
  'sourceDiagnosticCount',
  'accountedSourceDiagnosticCount',
  'sourceTextCharacterCount',
  'structBlockCount',
  'structAssetCount',
  'structRelationshipCount',
  'structDiagnosticCount',
  'structTextCharacterCount',
] as const
const CONSERVATION_OPTIONAL = [
  'sourceFurnitureBlockCount',
  'accountedFurnitureBlockCount',
  'sourceFurnitureTextCharacterCount',
  'structFurnitureBlockCount',
  'structFurnitureTextCharacterCount',
  'furnitureContaminationCount',
] as const

function parseConservation(
  value: unknown,
  path: string,
): StructReceipt['conservation'] {
  const parsed = object(
    value,
    path,
    CONSERVATION_REQUIRED,
    CONSERVATION_OPTIONAL,
  )
  const result = copyRecord(
    [...CONSERVATION_REQUIRED, ...CONSERVATION_OPTIONAL]
      .filter((key) => has(parsed, key))
      .map((key) => [key, nonNegativeInteger(parsed[key], `${path}.${key}`)]),
  )
  return result as StructReceipt['conservation']
}

function parseReceipt(value: unknown, path: string): StructReceipt {
  const parsed = object(
    value,
    path,
    [
      'schemaVersion',
      'sourceSha256',
      'blockCount',
      'assetCount',
      'relationshipCount',
      'diagnosticCount',
      'textCharacterCount',
      'conservation',
      'generatedSha256',
    ],
    ['documentId', 'modelConsultations'],
  )
  let modelConsultations: StructReceipt['modelConsultations']
  if (has(parsed, 'modelConsultations')) {
    validateConsultationReceipt(
      parsed.modelConsultations,
      `${path}.modelConsultations`,
    )
    const copied = copyCanonicalJson(
      parsed.modelConsultations,
      `${path}.modelConsultations`,
    )
    validateConsultationReceipt(copied, `${path}.modelConsultations`)
    modelConsultations = copied as StructReceipt['modelConsultations']
  }
  return {
    schemaVersion: parseSchemaVersion(
      parsed.schemaVersion,
      `${path}.schemaVersion`,
    ),
    ...(has(parsed, 'documentId')
      ? { documentId: identifier(parsed.documentId, `${path}.documentId`) }
      : {}),
    sourceSha256: hash(parsed.sourceSha256, `${path}.sourceSha256`),
    ...(modelConsultations ? { modelConsultations } : {}),
    blockCount: nonNegativeInteger(parsed.blockCount, `${path}.blockCount`),
    assetCount: nonNegativeInteger(parsed.assetCount, `${path}.assetCount`),
    relationshipCount: nonNegativeInteger(
      parsed.relationshipCount,
      `${path}.relationshipCount`,
    ),
    diagnosticCount: nonNegativeInteger(
      parsed.diagnosticCount,
      `${path}.diagnosticCount`,
    ),
    textCharacterCount: nonNegativeInteger(
      parsed.textCharacterCount,
      `${path}.textCharacterCount`,
    ),
    conservation: parseConservation(
      parsed.conservation,
      `${path}.conservation`,
    ),
    generatedSha256: hash(parsed.generatedSha256, `${path}.generatedSha256`),
  }
}

function parseSource(value: unknown, path: string): StructSource {
  const parsed = object(value, path, [
    'format',
    'fileName',
    'sha256',
    'byteLength',
    'pageCount',
    'localOnly',
  ])
  return {
    format: enumValue(parsed.format, `${path}.format`, SOURCE_FORMATS),
    fileName: stringValue(parsed.fileName, `${path}.fileName`),
    sha256: hash(parsed.sha256, `${path}.sha256`),
    byteLength: nonNegativeInteger(parsed.byteLength, `${path}.byteLength`),
    pageCount: nonNegativeInteger(parsed.pageCount, `${path}.pageCount`),
    localOnly: booleanValue(parsed.localOnly, `${path}.localOnly`),
  }
}

function parseSchemaVersion(value: unknown, path: string) {
  if (value !== LEGACY_STRUCT_SCHEMA_VERSION && value !== STRUCT_SCHEMA_VERSION)
    fail(
      'SCHEMA_VERSION',
      path,
      `unsupported schema version ${schemaVersionDescription(value)}`,
    )
  return value
}

function schemaVersionDescription(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return `<${typeof value}>`
}

function parseDocument(value: unknown): StructDocument {
  const parsed = object(
    value,
    '$',
    [
      'schemaVersion',
      'source',
      'metadata',
      'blocks',
      'assets',
      'relationships',
      'pages',
      'diagnostics',
      'recovery',
      'receipt',
    ],
    ['documentId'],
  )
  const schemaVersion = parseSchemaVersion(
    parsed.schemaVersion,
    '$.schemaVersion',
  )
  const blocks = array(
    parsed.blocks,
    '$.blocks',
    MAX_STRUCT_DOCUMENT_ITEMS,
  ).map((block, index) => parseBlock(block, `$.blocks[${index}]`))
  const assets = parseStructAssets(parsed.assets)
  const relationships = array(
    parsed.relationships,
    '$.relationships',
    MAX_STRUCT_DOCUMENT_ITEMS,
  ).map((relationship, index) =>
    parseRelationship(relationship, `$.relationships[${index}]`),
  )
  const pages = array(parsed.pages, '$.pages', MAX_STRUCT_DOCUMENT_ITEMS).map(
    (page, index) => parsePage(page, `$.pages[${index}]`),
  )
  const diagnostics = array(
    parsed.diagnostics,
    '$.diagnostics',
    MAX_STRUCT_DOCUMENT_ITEMS,
  ).map((diagnostic, index) =>
    parseDiagnostic(diagnostic, `$.diagnostics[${index}]`),
  )
  unique(
    blocks.map((block) => block.id),
    '$.blocks',
    'block id',
  )
  unique(
    assets.map((asset) => asset.id),
    '$.assets',
    'asset id',
  )
  unique(
    relationships.map((relationship) => relationship.id),
    '$.relationships',
    'relationship id',
  )
  unique(
    diagnostics.map((diagnostic) => diagnostic.id),
    '$.diagnostics',
    'diagnostic id',
  )
  unique(
    pages.map((page) => String(page.page)),
    '$.pages',
    'page number',
  )
  const document: StructDocument = {
    schemaVersion,
    ...(has(parsed, 'documentId')
      ? { documentId: identifier(parsed.documentId, '$.documentId') }
      : {}),
    source: parseSource(parsed.source, '$.source'),
    metadata: parseMetadata(parsed.metadata, '$.metadata'),
    blocks,
    assets,
    relationships,
    pages,
    diagnostics,
    recovery: parseRecovery(parsed.recovery, '$.recovery'),
    receipt: parseReceipt(parsed.receipt, '$.receipt'),
  }
  validateStructDocument(document, parsed)
  return document
}

/** Snapshot and validate bounded STRUCT assets before any consumer packages them. */
export function parseStructAssets(value: unknown): StructAsset[] {
  const rawAssets = array(value, '$.assets', MAX_STRUCT_ASSETS)
  const assetSnapshots: DataObject[] = []
  let remainingBytes = MAX_STRUCT_ASSET_BYTES_TOTAL
  for (const [index, rawAsset] of rawAssets.entries()) {
    const path = `$.assets[${index}]`
    const snapshot = snapshotAsset(rawAsset, path)
    const length = has(snapshot, 'bytes')
      ? preflightBytes(snapshot.bytes, `${path}.bytes`, MAX_STRUCT_ASSET_BYTES)
      : 0
    if (length > remainingBytes)
      fail('ASSET_BOUNDS', '$.assets', 'asset bytes exceed the resource bound')
    assetSnapshots.push(validateAssetSnapshot(snapshot, path))
    remainingBytes -= length
  }
  let decodeRemaining = MAX_STRUCT_ASSET_BYTES_TOTAL
  return assetSnapshots.map((asset, index) => {
    const parsedAsset = parseAsset(
      asset,
      `$.assets[${index}]`,
      Math.min(MAX_STRUCT_ASSET_BYTES, decodeRemaining),
    )
    decodeRemaining -= parsedAsset.bytes?.byteLength ?? 0
    return parsedAsset
  })
}

type PublicationSnapshotState = {
  active: WeakSet<object>
  nodes: number
  textBytes: number
}

function preflightPublicationReceipt(value: unknown, path: string) {
  const modelConsultations = dataEntries(value, path).find(
    ([key]) => key === 'modelConsultations',
  )?.[1]
  if (modelConsultations !== undefined)
    validateConsultationReceipt(
      modelConsultations,
      `${path}.modelConsultations`,
    )
}

function snapshotPublicationReceipt(
  value: unknown,
  path: string,
  state: PublicationSnapshotState,
) {
  return copyRecord(
    dataEntries(value, path, MAX_STRUCT_DOCUMENT_ITEMS - state.nodes).map(
      ([key, entry]) => [
        key,
        key === 'modelConsultations'
          ? copyCanonicalJson(entry, `${path}.${key}`)
          : snapshotPublicationValue(entry, `${path}.${key}`, state, 1),
      ],
    ),
  )
}

function chargePublicationString(
  value: string,
  path: string,
  state: PublicationSnapshotState,
) {
  const parsed = stringValue(value, path)
  state.textBytes += utf8ByteLength(parsed)
  if (state.textBytes > MAX_STRUCT_PUBLICATION_TEXT_BYTES)
    fail(
      'BUDGET',
      path,
      'publication text exceeds the aggregate resource bound',
    )
  return parsed
}

function preflightPublicationText(
  value: unknown,
  path: string,
  state: PublicationSnapshotState,
  depth = 0,
) {
  if (depth > 128)
    fail('BUDGET', path, 'publication input nesting exceeds the depth bound')
  state.nodes += 1
  if (state.nodes > MAX_STRUCT_DOCUMENT_ITEMS)
    fail('BUDGET', path, 'publication input exceeds the structural node bound')
  if (typeof value === 'string') {
    chargePublicationString(value, path, state)
    return
  }
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return
  if (state.active.has(value))
    fail('OBJECT', path, 'cycles are not permitted in publication input')
  state.active.add(value)
  try {
    if (Array.isArray(value)) {
      for (const [index, entry] of array(
        value,
        path,
        MAX_STRUCT_DOCUMENT_ITEMS - state.nodes,
        NODE_BOUND_MESSAGE,
      ).entries())
        preflightPublicationText(entry, `${path}[${index}]`, state, depth + 1)
      return
    }
    for (const [key, entry] of dataEntries(
      value,
      path,
      MAX_STRUCT_DOCUMENT_ITEMS - state.nodes,
      NODE_BOUND_MESSAGE,
    )) {
      if (key === 'bytes') continue
      preflightPublicationText(entry, `${path}.${key}`, state, depth + 1)
    }
  } finally {
    state.active.delete(value)
  }
}

function snapshotPublicationValue(
  value: unknown,
  path: string,
  state: PublicationSnapshotState,
  depth: number,
): unknown {
  if (depth > 128)
    fail('BUDGET', path, 'publication input nesting exceeds the depth bound')
  state.nodes += 1
  if (state.nodes > MAX_STRUCT_DOCUMENT_ITEMS)
    fail('BUDGET', path, 'publication input exceeds the structural node bound')
  if (typeof value === 'string') {
    return chargePublicationString(value, path, state)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('NUMBER', path, 'number must be finite')
    if (Object.is(value, -0))
      fail('NUMBER', path, 'negative zero is not canonical')
    return value
  }
  if (!value || typeof value !== 'object') return value
  if (state.active.has(value))
    fail('OBJECT', path, 'cycles are not permitted in publication input')
  state.active.add(value)
  try {
    if (Array.isArray(value))
      return array(
        value,
        path,
        MAX_STRUCT_DOCUMENT_ITEMS - state.nodes,
        NODE_BOUND_MESSAGE,
      ).map(
        (entry, index) =>
          snapshotPublicationValue(
            entry,
            `${path}[${index}]`,
            state,
            depth + 1,
          ),
      )
    return copyRecord(
      dataEntries(
        value,
        path,
        MAX_STRUCT_DOCUMENT_ITEMS - state.nodes,
        NODE_BOUND_MESSAGE,
      ).map(([key, entry]) => [
        key,
        snapshotPublicationValue(entry, `${path}.${key}`, state, depth + 1),
      ]),
    )
  } finally {
    state.active.delete(value)
  }
}

/** Bound and snapshot renderer ingress without retaining caller objects. */
export function snapshotStructDocumentForRenderer(
  value: unknown,
): StructDocument {
  const root = dataEntries(value, '$')
  const state: PublicationSnapshotState = {
    active: new WeakSet<object>(),
    nodes: 1,
    textBytes: 0,
  }
  return copyRecord(
    root.map(([key, entry]) => [
      key,
      key === 'assets'
        ? (preflightPublicationText(entry, '$.assets', state),
          parseStructAssets(entry))
        : key === 'recovery'
          ? (preflightPublicationText(entry, '$.recovery', state),
            parseRecovery(entry, '$.recovery'))
          : key === 'receipt'
            ? (preflightPublicationReceipt(entry, '$.receipt'),
              snapshotPublicationReceipt(entry, '$.receipt', state))
            : snapshotPublicationValue(entry, `$.${key}`, state, 1),
    ]),
  ) as StructDocument
}

/** Decode a JSON-safe or in-memory STRUCT document without coercion. */
export function decodeStructDocument(input: unknown): StructDocument {
  return parseDocument(input)
}

/**
 * Decode any declared compatible STRUCT schema without changing its version.
 */
export function decodeCompatibleStructDocument(input: unknown): StructDocument {
  return decodeStructDocument(input)
}

/**
 * @deprecated Use decodeCompatibleStructDocument. This prerelease alias performs
 * decode compatibility, not migration, and will be removed after 2026-11-30.
 */
export const migrateStructDocument = decodeCompatibleStructDocument

function toJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesToBase64(value)
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (value && typeof value === 'object') {
    const source = value as DataObject
    return copyRecord(
      Object.keys(source)
        .sort()
        .map((key) => [key, toJsonValue(source[key])]),
    )
  }
  return value
}

/** Encode a validated STRUCT document with base64 asset bytes for JSON. */
export function encodeStructDocument(
  document: StructDocument,
): StructDocumentJson {
  return toJsonValue(decodeStructDocument(document)) as StructDocumentJson
}
