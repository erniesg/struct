import {
  LEGACY_STRUCT_SCHEMA_VERSION,
  type StructDocument,
  type StructInline,
  type StructReceipt,
} from '../types'
import { legacyStructDigestMatches, structDigest } from '../ids'
import { SAFE_ID } from '../ids'
import {
  emittedXhtmlIds,
  isPackagedAssetId,
  RenderedPublicationPlanError,
} from '../emitted-ids'
import { fail, type DataObject, unique } from './primitives'

const CONSULTATION_RECEIPT_BINDING =
  'consultation receipt must match the enclosing document and source'

function digestInput(document: StructDocument) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    ...(document.receipt.modelConsultations
      ? { modelConsultations: document.receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  }
}

function validateDigest(document: StructDocument) {
  const input = digestInput(document)
  const matches =
    document.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION
      ? legacyStructDigestMatches(input, document.receipt.generatedSha256)
      : structDigest(input) === document.receipt.generatedSha256
  if (!matches)
    fail(
      'DIGEST',
      '$.receipt.generatedSha256',
      `generatedSha256 does not match the canonical ${document.schemaVersion} digest`,
    )
}

function addCategoryIds(
  seen: Map<string, string>,
  ids: readonly string[],
  category: string,
) {
  for (const id of ids) {
    const previous = seen.get(id)
    if (previous)
      fail(
        'DUPLICATE_IDENTIFIER',
        `$.${category}`,
        `identifier ${id} is also used by ${previous}`,
      )
    seen.set(id, category)
  }
}

function assertLocalTarget(
  value: string,
  path: string,
  nodeIds: ReadonlySet<string>,
) {
  const id = value.startsWith('#') ? value.slice(1) : value
  if (SAFE_ID.test(id) && !nodeIds.has(id))
    fail('REFERENCE', path, `dangling local reference ${value}`)
}

function assertInlineTargets(
  inline: StructInline,
  path: string,
  nodeIds: ReadonlySet<string>,
  relationshipIds: ReadonlySet<string>,
) {
  if (inline.href?.startsWith('#'))
    assertLocalTarget(inline.href, `${path}.href`, nodeIds)
  for (const [index, target] of (inline.targetIds ?? []).entries()) {
    if (!nodeIds.has(target))
      fail(
        'REFERENCE',
        `${path}.targetIds[${index}]`,
        `dangling target ${target}`,
      )
  }
  if (inline.relationshipId && !relationshipIds.has(inline.relationshipId))
    fail(
      'REFERENCE',
      `${path}.relationshipId`,
      `dangling relationship ${inline.relationshipId}`,
    )
}

function validateEvidencePages(
  evidence: { pages: number[]; boxes: Array<{ page: number }> },
  path: string,
  pageNumbers: ReadonlySet<number>,
) {
  for (const [index, page] of evidence.pages.entries()) {
    if (!pageNumbers.has(page))
      fail(
        'PAGE_BINDING',
        `${path}.pages[${index}]`,
        'page must have a corresponding document.pages layout',
      )
  }
  for (const [index, box] of evidence.boxes.entries()) {
    if (!pageNumbers.has(box.page))
      fail(
        'PAGE_BINDING',
        `${path}.boxes[${index}].page`,
        'box page must have a corresponding document.pages layout',
      )
    if (!evidence.pages.includes(box.page))
      fail(
        'PAGE_BINDING',
        `${path}.boxes[${index}].page`,
        'box page must be listed in evidence.pages',
      )
  }
}

function validateConservation(document: StructDocument) {
  const receipt = document.receipt
  const conservation = receipt.conservation
  const textCharacterCount = document.blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  if (
    receipt.blockCount !== document.blocks.length ||
    receipt.assetCount !== document.assets.length ||
    receipt.relationshipCount !== document.relationships.length ||
    receipt.diagnosticCount !== document.diagnostics.length
  )
    fail('COUNT', '$.receipt', 'receipt counts must match document arrays')
  if (receipt.textCharacterCount !== textCharacterCount)
    fail(
      'COUNT',
      '$.receipt.textCharacterCount',
      'receipt text count must match block text',
    )
  if (receipt.textCharacterCount !== conservation.sourceTextCharacterCount)
    fail(
      'COUNT',
      '$.receipt.conservation.sourceTextCharacterCount',
      'receipt text count must match source text count',
    )

  const structCounts: Array<[keyof StructReceipt['conservation'], number]> = [
    ['structBlockCount', document.blocks.length],
    ['structAssetCount', document.assets.length],
    ['structRelationshipCount', document.relationships.length],
    ['structDiagnosticCount', document.diagnostics.length],
    ['structTextCharacterCount', textCharacterCount],
  ]
  for (const [key, expected] of structCounts) {
    if (conservation[key] !== expected)
      fail(
        'COUNT',
        `$.receipt.conservation.${key}`,
        `${key} must match document output`,
      )
  }

  const bounded: Array<
    [keyof StructReceipt['conservation'], keyof StructReceipt['conservation']]
  > = [
    ['accountedSourceNodeCount', 'sourceNodeCount'],
    ['accountedSourceRegionCount', 'sourceRegionCount'],
    ['accountedSourceAnnotationCount', 'sourceAnnotationCount'],
    ['accountedSourceAssetCount', 'sourceAssetCount'],
    ['accountedSourceRelationshipCount', 'sourceRelationshipCount'],
    ['accountedSourceDiagnosticCount', 'sourceDiagnosticCount'],
  ]
  for (const [accountedKey, sourceKey] of bounded) {
    const accounted = conservation[accountedKey]!
    const source = conservation[sourceKey]!
    if (accounted > source)
      fail(
        'CONSERVATION',
        `$.receipt.conservation.${accountedKey}`,
        `${accountedKey} cannot exceed ${sourceKey}`,
      )
  }
  const accountedOutput: Array<[keyof StructReceipt['conservation'], number]> =
    [
      ['accountedSourceAssetCount', document.assets.length],
      ['accountedSourceRelationshipCount', document.relationships.length],
      ['accountedSourceDiagnosticCount', document.diagnostics.length],
    ]
  for (const [key, expected] of accountedOutput) {
    if (conservation[key] !== expected)
      fail(
        'CONSERVATION',
        `$.receipt.conservation.${key}`,
        `${key} must match accounted output`,
      )
  }
  if (
    conservation.structTextCharacterCount >
    conservation.sourceTextCharacterCount
  )
    fail(
      'CONSERVATION',
      '$.receipt.conservation.structTextCharacterCount',
      'STRUCT text cannot exceed source text',
    )

  const furniture = document.blocks.filter(
    (block) => block.kind === 'furniture',
  )
  const furnitureKeys = [
    'sourceFurnitureBlockCount',
    'accountedFurnitureBlockCount',
    'sourceFurnitureTextCharacterCount',
    'structFurnitureBlockCount',
    'structFurnitureTextCharacterCount',
  ] as const
  const furniturePresent = furnitureKeys.some(
    (key) => conservation[key] !== undefined,
  )
  if (
    furniturePresent &&
    furnitureKeys.some((key) => conservation[key] === undefined)
  )
    fail(
      'CONSERVATION',
      '$.receipt.conservation',
      'furniture counts must be provided together',
    )
  if (furniturePresent) {
    const sourceBlocks = conservation.sourceFurnitureBlockCount!
    const accountedBlocks = conservation.accountedFurnitureBlockCount!
    const sourceText = conservation.sourceFurnitureTextCharacterCount!
    const structBlocks = conservation.structFurnitureBlockCount!
    const structText = conservation.structFurnitureTextCharacterCount!
    if (accountedBlocks > sourceBlocks)
      fail(
        'CONSERVATION',
        '$.receipt.conservation.accountedFurnitureBlockCount',
        'accounted furniture cannot exceed source furniture',
      )
    if (
      structBlocks !== furniture.length ||
      accountedBlocks !== furniture.length
    )
      fail(
        'CONSERVATION',
        '$.receipt.conservation.structFurnitureBlockCount',
        'furniture block counts must match furniture output',
      )
    const expectedText = furniture.reduce(
      (count, block) => count + block.text.length,
      0,
    )
    if (structText !== expectedText)
      fail(
        'CONSERVATION',
        '$.receipt.conservation.structFurnitureTextCharacterCount',
        'furniture text count must match furniture output',
      )
    if (structText > sourceText)
      fail(
        'CONSERVATION',
        '$.receipt.conservation.structFurnitureTextCharacterCount',
        'STRUCT furniture text cannot exceed source furniture text',
      )
  } else if (furniture.length > 0) {
    fail(
      'CONSERVATION',
      '$.receipt.conservation',
      'furniture output requires furniture conservation counts',
    )
  }
  if (
    conservation.furnitureContaminationCount !== undefined &&
    conservation.furnitureContaminationCount >
      conservation.sourceTextCharacterCount
  )
    fail(
      'CONSERVATION',
      '$.receipt.conservation.furnitureContaminationCount',
      'furniture contamination cannot exceed source text',
    )
}

function validateReferences(document: StructDocument) {
  const ids = new Map<string, string>()
  const authors = new Set(document.metadata.authors)
  addCategoryIds(
    ids,
    document.blocks.map(({ id }) => id),
    'blocks',
  )
  addCategoryIds(
    ids,
    document.assets.map(({ id }) => id),
    'assets',
  )
  addCategoryIds(
    ids,
    document.relationships.map(({ id }) => id),
    'relationships',
  )
  addCategoryIds(
    ids,
    document.diagnostics.map(({ id }) => id),
    'diagnostics',
  )
  for (const [index, note] of (document.metadata.authorNotes ?? []).entries()) {
    if (!authors.has(note.author))
      fail(
        'REFERENCE',
        `$.metadata.authorNotes[${index}].author`,
        `author note author ${note.author} must be listed in metadata.authors`,
      )
    const previous = ids.get(note.id)
    if (!previous) {
      ids.set(note.id, 'metadata.authorNotes')
      continue
    }
    const relationship = document.relationships.find(
      (entry) => entry.id === note.id,
    )
    if (
      previous !== 'relationships' ||
      relationship?.status !== 'matched' ||
      (relationship.kind !== 'footnote' && relationship.kind !== 'endnote') ||
      !relationship.to.includes(note.target)
    )
      fail(
        'DUPLICATE_IDENTIFIER',
        `$.metadata.authorNotes[${index}].id`,
        `identifier ${note.id} is also used by ${previous}`,
      )
  }
  addCategoryIds(
    ids,
    document.blocks.flatMap((block) => block.sourceObservationAnchorIds ?? []),
    'blocks.sourceObservationAnchorIds',
  )
  const emittedIds = new Map<string, string>()
  let emittedEntries
  try {
    emittedEntries = emittedXhtmlIds(document)
  } catch (error) {
    if (error instanceof RenderedPublicationPlanError)
      fail(error.code, error.path, error.message)
    throw error
  }
  for (const { id, path } of emittedEntries) {
    const previous = emittedIds.get(id)
    if (previous)
      fail(
        'DUPLICATE_IDENTIFIER',
        path,
        `emitted XHTML identifier ${id} is also used by ${previous}`,
      )
    emittedIds.set(id, path)
  }
  if (document.documentId && ids.has(document.documentId))
    fail(
      'DUPLICATE_IDENTIFIER',
      '$.documentId',
      `document identifier ${document.documentId} is also used by ${ids.get(document.documentId)}`,
    )

  const nodeIds = new Set(
    [...document.blocks, ...document.assets].map(({ id }) => id),
  )
  const relationshipIds = new Set(document.relationships.map(({ id }) => id))
  unique(
    document.assets.map(({ href }) => href),
    '$.assets',
    'asset href',
  )
  for (const [index, asset] of document.assets.entries())
    if (!isPackagedAssetId(asset.id))
      fail(
        'IDENTIFIER',
        `$.assets[${index}].id`,
        `asset id is not a valid EPUB manifest id: ${asset.id}`,
      )

  for (const [index, relationship] of document.relationships.entries()) {
    if (!nodeIds.has(relationship.from))
      fail(
        'REFERENCE',
        `$.relationships[${index}].from`,
        `dangling local reference ${relationship.from}`,
      )
    for (const [targetIndex, target] of relationship.to.entries())
      assertLocalTarget(
        target,
        `$.relationships[${index}].to[${targetIndex}]`,
        nodeIds,
      )
    for (const [candidateIndex, candidate] of (
      relationship.candidates ?? []
    ).entries())
      assertLocalTarget(
        candidate.target,
        `$.relationships[${index}].candidates[${candidateIndex}].target`,
        nodeIds,
      )
  }
  for (const [blockIndex, block] of document.blocks.entries()) {
    for (const [fallbackIndex, assetId] of (
      block.fallbackAssetIds ?? []
    ).entries()) {
      if (!document.assets.some(({ id }) => id === assetId))
        fail(
          'REFERENCE',
          `$.blocks[${blockIndex}].fallbackAssetIds[${fallbackIndex}]`,
          `dangling asset ${assetId}`,
        )
    }
    for (const [inlineIndex, inline] of block.inline.entries())
      assertInlineTargets(
        inline,
        `$.blocks[${blockIndex}].inline[${inlineIndex}]`,
        nodeIds,
        relationshipIds,
      )
    if (block.table) {
      for (const [cellIndex, cell] of block.table.cells.entries()) {
        for (const [inlineIndex, inline] of cell.inline.entries())
          assertInlineTargets(
            inline,
            `$.blocks[${blockIndex}].table.cells[${cellIndex}].inline[${inlineIndex}]`,
            nodeIds,
            relationshipIds,
          )
      }
    }
  }
  for (const [pageIndex, page] of document.pages.entries()) {
    for (const [blockIndex, blockId] of page.blocks.entries()) {
      if (!document.blocks.some(({ id }) => id === blockId))
        fail(
          'REFERENCE',
          `$.pages[${pageIndex}].blocks[${blockIndex}]`,
          `dangling block ${blockId}`,
        )
    }
    for (const [columnIndex, column] of page.columns.entries()) {
      for (const [blockIndex, blockId] of column.blockIds.entries()) {
        if (!document.blocks.some(({ id }) => id === blockId))
          fail(
            'REFERENCE',
            `$.pages[${pageIndex}].columns[${columnIndex}].blockIds[${blockIndex}]`,
            `dangling block ${blockId}`,
          )
      }
    }
  }
  for (const [index, note] of (document.metadata.authorNotes ?? []).entries()) {
    if (!nodeIds.has(note.target))
      fail(
        'REFERENCE',
        `$.metadata.authorNotes[${index}].target`,
        `dangling target ${note.target}`,
      )
  }
}

function validatePages(document: StructDocument) {
  if (document.pages.length > document.source.pageCount)
    fail(
      'PAGE_BINDING',
      '$.pages',
      'page layouts cannot exceed source.pageCount',
    )
  const pagesByNumber = new Map(document.pages.map((page) => [page.page, page]))
  const pageNumbers = new Set(pagesByNumber.keys())
  const checkPage = (page: number, path: string) => {
    if (!pagesByNumber.has(page))
      fail('PAGE_BINDING', path, 'page exceeds source.pageCount')
  }
  const blocksById = new Map(document.blocks.map((block) => [block.id, block]))
  const pageBlockIds = new Map(
    document.pages.map((page) => [page.page, new Set(page.blocks)]),
  )
  for (const [index, page] of document.pages.entries()) {
    if (page.page > document.source.pageCount)
      fail(
        'PAGE_BINDING',
        `$.pages[${index}].page`,
        'page exceeds source.pageCount',
      )
    checkPage(page.page, `$.pages[${index}].page`)
    const seenColumnSides = new Set<string>()
    for (const [columnIndex, column] of page.columns.entries()) {
      if (seenColumnSides.has(column.side))
        fail(
          'PAGE_BINDING',
          `$.pages[${index}].columns[${columnIndex}].side`,
          `duplicate ${column.side} column sides are not permitted`,
        )
      seenColumnSides.add(column.side)
      for (const [blockIndex, blockId] of column.blockIds.entries()) {
        const block = blocksById.get(blockId)
        const expectedSide = block?.column ?? 'single'
        if (expectedSide !== column.side)
          fail(
            'PAGE_BINDING',
            `$.pages[${index}].columns[${columnIndex}].blockIds[${blockIndex}]`,
            'column side must match the member block column',
          )
      }
    }
    const columnBlockIds = page.columns.flatMap((column) => column.blockIds)
    const columnBlockIdSet = new Set(columnBlockIds)
    if (new Set(columnBlockIds).size !== columnBlockIds.length)
      fail(
        'PAGE_BINDING',
        `$.pages[${index}].columns`,
        'a block cannot belong to multiple columns on the same page',
      )
    if (
      columnBlockIds.length !== page.blocks.length ||
      !page.blocks.every((blockId) => columnBlockIdSet.has(blockId))
    )
      fail(
        'PAGE_BINDING',
        `$.pages[${index}]`,
        'page.blocks and page.columns block membership must agree',
      )
    for (const [blockIndex, blockId] of page.blocks.entries()) {
      const block = blocksById.get(blockId)
      if (block?.page !== page.page)
        fail(
          'PAGE_BINDING',
          `$.pages[${index}].blocks[${blockIndex}]`,
          'page block must carry the same page number as its layout',
        )
    }
  }
  for (const [index, block] of document.blocks.entries()) {
    if (block.page !== null) {
      checkPage(block.page, `$.blocks[${index}].page`)
      if (!block.evidence.pages.includes(block.page))
        fail(
          'PAGE_BINDING',
          `$.blocks[${index}].page`,
          'block page must be listed in block.evidence.pages',
        )
      if (!pageBlockIds.get(block.page)?.has(block.id))
        fail(
          'PAGE_BINDING',
          `$.blocks[${index}].page`,
          'block page must list the block in page.blocks',
        )
    }
    validateEvidencePages(
      block.evidence,
      `$.blocks[${index}].evidence`,
      pageNumbers,
    )
    if (block.table)
      for (const [cellIndex, cell] of block.table.cells.entries())
        validateEvidencePages(
          cell.evidence,
          `$.blocks[${index}].table.cells[${cellIndex}].evidence`,
          pageNumbers,
        )
    if (block.furniture)
      validateEvidencePages(
        block.furniture,
        `$.blocks[${index}].furniture`,
        pageNumbers,
      )
    if (block.furnitureReview)
      validateEvidencePages(
        block.furnitureReview,
        `$.blocks[${index}].furnitureReview`,
        pageNumbers,
      )
  }
  for (const [index, asset] of document.assets.entries())
    validateEvidencePages(
      asset.evidence,
      `$.assets[${index}].evidence`,
      pageNumbers,
    )
  for (const [index, relationship] of document.relationships.entries()) {
    validateEvidencePages(
      relationship.evidence,
      `$.relationships[${index}].evidence`,
      pageNumbers,
    )
    for (const [candidateIndex, candidate] of (
      relationship.candidates ?? []
    ).entries())
      validateEvidencePages(
        candidate.evidence,
        `$.relationships[${index}].candidates[${candidateIndex}].evidence`,
        pageNumbers,
      )
  }
  for (const [index, diagnostic] of document.diagnostics.entries())
    for (const [pageIndex, page] of diagnostic.pages.entries())
      checkPage(page, `$.diagnostics[${index}].pages[${pageIndex}]`)
  for (const [index, issue] of document.recovery.issues.entries())
    for (const [pageIndex, page] of issue.pages.entries())
      checkPage(page, `$.recovery.issues[${index}].pages[${pageIndex}]`)
}

function validateConsultationBinding(document: StructDocument) {
  const receipt = document.receipt.modelConsultations
  if (!receipt) return
  if (
    receipt.documentId !== document.documentId ||
    receipt.sourceSha256 !== document.source.sha256
  )
    fail(
      'BINDING',
      '$.receipt.modelConsultations',
      CONSULTATION_RECEIPT_BINDING,
    )
}

export function validateStructDocument(
  document: StructDocument,
  _input: DataObject,
) {
  const receipt = document.receipt
  if (receipt.schemaVersion !== document.schemaVersion)
    fail(
      'SCHEMA_VERSION',
      '$.receipt.schemaVersion',
      'receipt and document versions must match',
    )
  if (receipt.sourceSha256 !== document.source.sha256)
    fail(
      'BINDING',
      '$.receipt.sourceSha256',
      'receipt source hash must match source',
    )
  if (document.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION) {
    if (
      document.documentId !== undefined ||
      receipt.documentId !== undefined ||
      receipt.modelConsultations !== undefined
    )
      fail(
        'MIGRATION',
        '$',
        '0.1.0 documents cannot contain document bindings or model consultations',
      )
  } else if (
    document.documentId === undefined ||
    receipt.documentId !== document.documentId
  ) {
    fail(
      'BINDING',
      '$.documentId',
      'current documents require matching document bindings',
    )
  }
  validateConservation(document)
  validateReferences(document)
  validatePages(document)
  validateConsultationBinding(document)
  validateDigest(document)
}
