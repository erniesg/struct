// Shared S04 fixtures: source-neutral STRUCT documents that exercise the
// S04 compatibility matrix and renderer repeatability surface.
//
// These builders intentionally construct every accepted shape by hand from the
// published document contract so that a frozen baseline is an independent,
// reviewed input rather than a re-serialization of renderer output. The
// receipt and conservation counts are derived from the constructed arrays by
// `finalize` (never copied from renderer output).

import { structDigest } from '../../../src/identity'
import { legacyStructDigest } from '../../../src/legacy-digest'
import { sha256HexSync } from '../../../src/sha256'
import type {
  StructDocument,
  StructEvidence,
} from '../../../src/document/types'
import {
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
} from '../../../src/document/types'

export { LEGACY_STRUCT_SCHEMA_VERSION, STRUCT_SCHEMA_VERSION }

export type S04RenderVariant = 'typography' | 'assets-links' | 'order'

const SOURCE_SHA256 = 'b'.repeat(64)

function evidence(pages: number[] = [1]): StructEvidence {
  return {
    confidence: 1,
    pages,
    boxes: [{ page: pages[0] ?? 1, x: 0, y: 0, width: 10, height: 10, rotation: 0 }],
    sourceIds: ['s04-source-node'],
  }
}

function packagedBytes(values: number[]): {
  bytes: string
  sha256: string
} {
  const raw = new Uint8Array(values)
  return {
    bytes: Buffer.from(raw).toString('base64'),
    sha256: sha256HexSync(raw),
  }
}

function metadata(title: string) {
  return {
    title,
    subtitle: 'Repeatability fixture',
    authors: ['Ada Lovelace', 'Grace Hopper'],
    abstract: 'Frozen S04 renderer baseline fixture.',
    language: 'en',
    baseDirection: 'ltr' as const,
    publicationDate: '2026-10-20',
    artifactModifiedAt: '2026-10-20T00:00:00Z',
    updated: '2026-10-20',
    affiliations: ['Analytical Engine Laboratory'],
    authorAffiliations: [
      { author: 'Ada Lovelace', label: '1' },
      { author: 'Grace Hopper', label: '1' },
    ],
  }
}

function envelope(
  documentId: string,
  title: string,
  blocks: unknown[],
  assets: unknown[],
  relationships: unknown[],
  diagnostics: unknown[],
): StructDocument {
  return {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    documentId,
    source: {
      format: 'docx',
      fileName: 's04-fixture.docx',
      sha256: SOURCE_SHA256,
      byteLength: 4096,
      pageCount: 1,
      localOnly: true,
    },
    metadata: metadata(title),
    blocks,
    assets,
    relationships,
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: blocks.map((block: any) => block.id),
        columns: [
          {
            id: 'page-1-single',
            side: 'single',
            blockIds: blocks.map((block: any) => block.id),
          },
        ],
      },
    ],
    diagnostics,
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'No recovery required',
      issues: [],
    },
    receipt: {
      schemaVersion: STRUCT_SCHEMA_VERSION,
      sourceSha256: SOURCE_SHA256,
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
      generatedSha256: '0'.repeat(64),
    },
  } as unknown as StructDocument
}

// The three S04 cases all share `blocks[0].column === 'single'` and page 1 so
// the page-layout invariants hold. Array order is the renderer reading order.
function typographyBlocks() {
  return [
    {
      id: 's04-title',
      kind: 'heading',
      text: 'Typographic baseline',
      page: 1,
      order: 0,
      column: 'single',
      inline: [],
      evidence: evidence(),
      attributes: { level: 1 },
    },
    {
      id: 's04-emphasis',
      kind: 'paragraph',
      text: 'Bold italic super sub end.',
      page: 1,
      order: 1,
      column: 'single',
      inline: [
        { start: 0, end: 4, bold: true },
        { start: 5, end: 11, italic: true },
        { start: 12, end: 17, verticalAlign: 'superscript' },
        { start: 18, end: 21, verticalAlign: 'subscript' },
        { start: 22, end: 25, semanticRole: 'citation', relationshipId: 's04-rel-citation' },
      ],
      evidence: evidence(),
    },
    {
      id: 's04-quote',
      kind: 'quote',
      text: 'Quoted passage.',
      page: 1,
      order: 2,
      column: 'single',
      inline: [],
      evidence: evidence(),
    },
    {
      id: 's04-list-1',
      kind: 'list-item',
      text: 'First ordered item',
      page: 1,
      order: 3,
      column: 'single',
      inline: [],
      evidence: evidence(),
      attributes: { ordered: true, listId: 's04-list' },
    },
    {
      id: 's04-list-2',
      kind: 'list-item',
      text: 'Second ordered item',
      page: 1,
      order: 4,
      column: 'single',
      inline: [],
      evidence: evidence(),
      attributes: { ordered: true, listId: 's04-list' },
    },
    {
      id: 's04-code',
      kind: 'code',
      text: 'const x = 1',
      page: 1,
      order: 5,
      column: 'single',
      inline: [],
      evidence: evidence(),
    },
    {
      id: 's04-footnote',
      kind: 'footnote',
      text: 'Footnote body text',
      page: 1,
      order: 6,
      column: 'single',
      inline: [],
      evidence: evidence(),
    },
  ]
}

function typographyRelationships() {
  return [
    {
      id: 's04-rel-citation',
      kind: 'citation',
      from: 's04-emphasis',
      to: ['s04-footnote'],
      status: 'matched',
      confidence: 1,
      evidence: evidence(),
      label: '1',
    },
  ]
}

function assetsLinksBlocks() {
  return [
    {
      id: 's04-figure-intro',
      kind: 'paragraph',
      text: 'See figure one and the source.',
      page: 1,
      order: 0,
      column: 'single',
      inline: [
        { start: 4, end: 14, href: '#s04-figure', semanticRole: 'cross-reference', relationshipId: 's04-rel-figure' },
        { start: 23, end: 29, href: 'https://example.org/source' },
      ],
      evidence: evidence(),
    },
    {
      id: 's04-figure',
      kind: 'figure',
      text: '',
      page: 1,
      order: 1,
      column: 'single',
      label: 'Figure one',
      inline: [],
      evidence: evidence(),
      fallbackAssetIds: ['s04-asset-figure'],
      attributes: { objectType: 'figure' },
    },
    {
      id: 's04-caption',
      kind: 'caption',
      text: 'Measured figure caption',
      page: 1,
      order: 2,
      column: 'single',
      inline: [],
      evidence: evidence(),
    },
  ]
}

function assetsLinksAssets() {
  const figure = packagedBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01])
  return [
    {
      id: 's04-asset-figure',
      kind: 'figure',
      href: 'assets/s04-figure.png',
      mediaType: 'image/png',
      sha256: figure.sha256,
      width: 320,
      height: 200,
      bytes: figure.bytes,
      sourceObjectIds: ['s04-source-asset'],
      evidence: evidence(),
      fallback: 'asset',
    },
  ]
}

function assetsLinksRelationships() {
  return [
    {
      id: 's04-rel-figure',
      kind: 'caption',
      from: 's04-caption',
      to: ['s04-figure'],
      status: 'matched',
      confidence: 1,
      evidence: evidence(),
    },
  ]
}

function orderBlocks() {
  return [
    {
      id: 's04-left-1',
      kind: 'paragraph',
      text: 'Left column first.',
      page: 1,
      order: 0,
      column: 'left',
      inline: [],
      evidence: evidence(),
    },
    {
      id: 's04-left-2',
      kind: 'paragraph',
      text: 'Left column second.',
      page: 1,
      order: 1,
      column: 'left',
      inline: [],
      evidence: evidence(),
    },
    {
      id: 's04-right-1',
      kind: 'paragraph',
      text: 'Right column first.',
      page: 1,
      order: 2,
      column: 'right',
      inline: [],
      evidence: evidence(),
    },
    {
      id: 's04-span-1',
      kind: 'paragraph',
      text: 'Spanning paragraph.',
      page: 1,
      order: 3,
      column: 'span',
      inline: [],
      evidence: evidence(),
    },
  ]
}

function orderDiagnostics() {
  return [
    {
      id: 's04-diagnostic',
      severity: 'info',
      category: 'source',
      title: 'Fixture diagnostic',
      message: 'Constructor diagnostic for the S04 fixture.',
      pages: [1],
      sourceIds: ['s04-source-node'],
    },
  ]
}

/** Build one frozen S04 render input. */
export function buildS04Document(variant: S04RenderVariant): StructDocument {
  if (variant === 'typography') {
    return envelope(
      's04-typography',
      'Typographic baseline',
      typographyBlocks(),
      [],
      typographyRelationships(),
      [],
    )
  }
  if (variant === 'assets-links') {
    return envelope(
      's04-assets-links',
      'Assets and links baseline',
      assetsLinksBlocks(),
      assetsLinksAssets(),
      assetsLinksRelationships(),
      [],
    )
  }
  const blocks = orderBlocks()
  // The `order` variant exercises an explicit two-column page layout while the
  // renderer reads the block array in order; a diagnostic is attached so the
  // recovery/receipt surface is non-trivial.
  const document = envelope('s04-order', 'Reading order baseline', blocks, [], [], orderDiagnostics())
  document.pages = [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      blocks: blocks.map((block) => block.id),
      columns: [
        { id: 'page-1-left', side: 'left', blockIds: ['s04-left-1', 's04-left-2'] },
        { id: 'page-1-right', side: 'right', blockIds: ['s04-right-1'] },
        { id: 'page-1-span', side: 'span', blockIds: ['s04-span-1'] },
      ],
    },
  ]
  return document
}

function digestInput(document: any) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
  }
}

/**
 * Derive receipt counts/conservation from the constructed arrays, drop the
 * version-specific `documentId` requirement, then seal the semantic digest for
 * the requested schema version. No value is copied from renderer output.
 */
export function finalizeS04Document<S extends any>(
  source: S,
  version: typeof LEGACY_STRUCT_SCHEMA_VERSION | typeof STRUCT_SCHEMA_VERSION,
): StructDocument {
  const document = JSON.parse(JSON.stringify(source))
  if (version === LEGACY_STRUCT_SCHEMA_VERSION) {
    delete document.documentId
    delete document.receipt.documentId
  } else {
    document.receipt.documentId = document.documentId
  }
  const textCharacterCount = document.blocks.reduce(
    (count: number, block: any) => count + block.text.length,
    0,
  )
  document.schemaVersion = version
  document.receipt.schemaVersion = version
  document.receipt.sourceSha256 = document.source.sha256
  document.receipt.blockCount = document.blocks.length
  document.receipt.assetCount = document.assets.length
  document.receipt.relationshipCount = document.relationships.length
  document.receipt.diagnosticCount = document.diagnostics.length
  document.receipt.textCharacterCount = textCharacterCount
  const conservation = document.receipt.conservation
  conservation.sourceNodeCount = document.blocks.length
  conservation.accountedSourceNodeCount = document.blocks.length
  conservation.sourceRegionCount = 0
  conservation.accountedSourceRegionCount = 0
  conservation.sourceAnnotationCount = document.blocks.length
  conservation.accountedSourceAnnotationCount = document.blocks.length
  conservation.sourceAssetCount = document.assets.length
  conservation.accountedSourceAssetCount = document.assets.length
  conservation.sourceRelationshipCount = document.relationships.length
  conservation.accountedSourceRelationshipCount = document.relationships.length
  conservation.sourceDiagnosticCount = document.diagnostics.length
  conservation.accountedSourceDiagnosticCount = document.diagnostics.length
  conservation.sourceTextCharacterCount = textCharacterCount
  conservation.structBlockCount = document.blocks.length
  conservation.structAssetCount = document.assets.length
  conservation.structRelationshipCount = document.relationships.length
  conservation.structDiagnosticCount = document.diagnostics.length
  conservation.structTextCharacterCount = textCharacterCount
  document.receipt.generatedSha256 =
    version === LEGACY_STRUCT_SCHEMA_VERSION
      ? legacyStructDigest(digestInput(document))
      : structDigest(digestInput(document))
  return document as StructDocument
}

/** Frozen current-version fixture used by the compatibility matrix. */
export function currentDocument(): StructDocument {
  return finalizeS04Document(buildS04Document('typography'), STRUCT_SCHEMA_VERSION)
}

/** Frozen legacy-version fixture used by the compatibility matrix. */
export function legacyDocument(): StructDocument {
  return finalizeS04Document(buildS04Document('typography'), LEGACY_STRUCT_SCHEMA_VERSION)
}

/** A copy of `document` whose declared schema version is unsupported. */
export function unsupportedDocument(version: unknown): StructDocument {
  const document: any = JSON.parse(JSON.stringify(currentDocument()))
  delete document.documentId
  delete document.receipt.documentId
  document.schemaVersion = version
  document.receipt.schemaVersion = version
  return document as StructDocument
}
