/**
 * S-04 three-run renderer goldens against the PACKED artifact.
 *
 * This script runs in a consumer directory where @erniesg/struct is installed
 * from the tarball. It replicates the three S04 render fixtures using only
 * public exports and Node's crypto, then runs three independent renders per
 * variant and compares to the frozen baselines.
 */

import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'

// Import from the installed package
const structIdentity = await import('@erniesg/struct/identity')
const renderersXhtml = await import('@erniesg/struct/renderers/xhtml')
const renderersEpub = await import('@erniesg/struct/renderers/epub')

const { structDigest } = structIdentity
const { renderPublicationXhtml } = renderersXhtml
const { buildStructEpub } = renderersEpub

const STRUCT_SCHEMA_VERSION = '0.2.0'
const SOURCE_SHA256 = 'b'.repeat(64)

function sha256HexSync(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Utf8(value) {
  return sha256HexSync(new TextEncoder().encode(value))
}

function evidence(pages) {
  pages = pages || [1]
  return {
    confidence: 1,
    pages,
    boxes: [{ page: pages[0] ?? 1, x: 0, y: 0, width: 10, height: 10, rotation: 0 }],
    sourceIds: ['s04-source-node'],
  }
}

function packagedBytes(values) {
  const raw = new Uint8Array(values)
  return {
    bytes: Buffer.from(raw).toString('base64'),
    sha256: sha256HexSync(raw),
  }
}

function metadata(title) {
  return {
    title,
    subtitle: 'Repeatability fixture',
    authors: ['Ada Lovelace', 'Grace Hopper'],
    abstract: 'Frozen S04 renderer baseline fixture.',
    language: 'en',
    baseDirection: 'ltr',
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

function envelope(documentId, title, blocks, assets, relationships, diagnostics) {
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
        blocks: blocks.map((block) => block.id),
        columns: [
          {
            id: 'page-1-single',
            side: 'single',
            blockIds: blocks.map((block) => block.id),
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
  }
}

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

function buildS04Document(variant) {
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

function digestInput(document) {
  const { receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    assets: document.assets.map(({ bytes, ...asset }) => asset),
  }
}

function finalizeS04Document(source, version) {
  const document = JSON.parse(JSON.stringify(source))
  document.schemaVersion = version
  document.receipt.schemaVersion = version
  document.receipt.sourceSha256 = document.source.sha256
  document.receipt.blockCount = document.blocks.length
  document.receipt.assetCount = document.assets.length
  document.receipt.relationshipCount = document.relationships.length
  document.receipt.diagnosticCount = document.diagnostics.length
  const textCharacterCount = document.blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
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
  // Current version requires matching documentId in receipt
  document.receipt.documentId = document.documentId
  document.receipt.generatedSha256 = structDigest(digestInput(document))
  return document
}

function normalizedEpubContentSha256(bytes) {
  const entries = unzipSync(bytes)
  const lines = Object.keys(entries)
    .sort()
    .map((name) => `${name}\u0000${sha256HexSync(entries[name])}`)
  return sha256HexSync(new TextEncoder().encode(lines.join('\n')))
}

const FROZEN_BASELINES = {
  typography: {
    xhtmlSha256: 'dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30',
    epubContentSha256: '4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67',
    epubArchiveSha256: '8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908',
  },
  'assets-links': {
    xhtmlSha256: '01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa',
    epubContentSha256: 'e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365',
    epubArchiveSha256: '3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f',
  },
  order: {
    xhtmlSha256: '36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b',
    epubContentSha256: '6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289',
    epubArchiveSha256: '2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839',
  },
}

async function runOnce(variant) {
  // Each run creates a fresh document from the fixture
  const document = finalizeS04Document(buildS04Document(variant), STRUCT_SCHEMA_VERSION)
  const xhtml = renderPublicationXhtml(document)
  const epub = await buildStructEpub(document)
  return {
    xhtml,
    xhtmlSha256: sha256Utf8(xhtml),
    epubContentSha256: normalizedEpubContentSha256(epub.bytes),
    epubArchiveSha256: epub.sha256,
    epubEntryNames: Object.keys(unzipSync(epub.bytes)).sort(),
  }
}

async function main() {
  const variants = ['typography', 'assets-links', 'order']
  const allResults = {}

  for (const variant of variants) {
    console.log(`\n=== ${variant} ===`)
    const runs = []
    for (let index = 0; index < 3; index += 1) {
      const result = await runOnce(variant)
      runs.push(result)
      console.log(`Run ${index + 1}: xhtml=${result.xhtmlSha256} epubContent=${result.epubContentSha256} epubArchive=${result.epubArchiveSha256}`)
    }

    const [first, second, third] = runs
    // Cross-run identity
    if (second.xhtmlSha256 !== first.xhtmlSha256) throw new Error(`${variant}: run 2 xhtml differs from run 1`)
    if (third.xhtmlSha256 !== first.xhtmlSha256) throw new Error(`${variant}: run 3 xhtml differs from run 1`)
    if (second.epubContentSha256 !== first.epubContentSha256) throw new Error(`${variant}: run 2 epubContent differs from run 1`)
    if (third.epubContentSha256 !== first.epubContentSha256) throw new Error(`${variant}: run 3 epubContent differs from run 1`)
    if (second.epubArchiveSha256 !== first.epubArchiveSha256) throw new Error(`${variant}: run 2 epubArchive differs from run 1`)
    if (third.epubArchiveSha256 !== first.epubArchiveSha256) throw new Error(`${variant}: run 3 epubArchive differs from run 1`)
    if (second.xhtml !== first.xhtml) throw new Error(`${variant}: run 2 xhtml bytes differ from run 1`)
    if (third.xhtml !== first.xhtml) throw new Error(`${variant}: run 3 xhtml bytes differ from run 1`)
    if (JSON.stringify(second.epubEntryNames) !== JSON.stringify(first.epubEntryNames)) throw new Error(`${variant}: run 2 epub entries differ from run 1`)
    if (JSON.stringify(third.epubEntryNames) !== JSON.stringify(first.epubEntryNames)) throw new Error(`${variant}: run 3 epub entries differ from run 1`)

    // Frozen baseline match
    const frozen = FROZEN_BASELINES[variant]
    if (first.xhtmlSha256 !== frozen.xhtmlSha256) throw new Error(`${variant}: xhtmlSha256 differs from frozen baseline: got ${first.xhtmlSha256}, expected ${frozen.xhtmlSha256}`)
    if (first.epubContentSha256 !== frozen.epubContentSha256) throw new Error(`${variant}: epubContentSha256 differs from frozen baseline: got ${first.epubContentSha256}, expected ${frozen.epubContentSha256}`)
    if (first.epubArchiveSha256 !== frozen.epubArchiveSha256) throw new Error(`${variant}: epubArchiveSha256 differs from frozen baseline: got ${first.epubArchiveSha256}, expected ${frozen.epubArchiveSha256}`)

    console.log(`✓ ${variant}: all three runs match each other and frozen baseline`)

    allResults[variant] = {
      run1: { xhtmlSha256: first.xhtmlSha256, epubContentSha256: first.epubContentSha256, epubArchiveSha256: first.epubArchiveSha256 },
      run2: { xhtmlSha256: second.xhtmlSha256, epubContentSha256: second.epubContentSha256, epubArchiveSha256: second.epubArchiveSha256 },
      run3: { xhtmlSha256: third.xhtmlSha256, epubContentSha256: third.epubContentSha256, epubArchiveSha256: third.epubArchiveSha256 },
      frozen: frozen,
    }
  }

  console.log('\n=== ALL GOLDENS VERIFIED ===')
  console.log(JSON.stringify(allResults, null, 2))
  return allResults
}

main().catch((error) => {
  console.error('GOLDEN FAILURE:', error)
  process.exit(1)
})