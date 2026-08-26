import { legacyStructDigest, structDigest } from '../src/core/ids'
import { sha256HexSync } from '../src/core/sha256'

export const hash = 'a'.repeat(64)
export const assetBytesHash = sha256HexSync(new Uint8Array([0, 255, 128]))

export function evidence() {
  return {
    confidence: 1,
    pages: [1],
    boxes: [
      {
        page: 1,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ],
    sourceIds: ['source-node'],
    signals: ['fixture'],
  }
}

export function digestInput(document: any) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    ...(document.receipt.modelConsultations
      ? { modelConsultations: document.receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
  }
}

export function seal<T extends Record<string, any>>(document: T): T {
  document.receipt.generatedSha256 =
    document.schemaVersion === '0.1.0'
      ? legacyStructDigest(digestInput(document))
      : structDigest(digestInput(document))
  return document
}

export function validDocument() {
  const sharedEvidence = evidence()
  return seal({
    schemaVersion: '0.1.0',
    source: {
      format: 'docx',
      fileName: 'fixture.docx',
      sha256: hash,
      byteLength: 3,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'Fixture',
      subtitle: '',
      authors: ['Author'],
      abstract: 'Abstract',
      language: 'en',
      baseDirection: 'ltr',
      publicationDate: '2026-08-20',
      artifactModifiedAt: '2026-08-20T00:00:00Z',
      updated: '2026-08-20',
      affiliations: ['Example University'],
      authorAffiliations: [{ author: 'Author', label: '1' }],
      authorNotes: [
        {
          id: 'author-note-1',
          author: 'Author',
          label: '1',
          target: 'block-1',
        },
      ],
    },
    blocks: [
      {
        id: 'block-1',
        kind: 'paragraph',
        text: 'Hello',
        label: 'Body',
        page: 1,
        order: 0,
        column: 'single',
        inline: [
          {
            start: 0,
            end: 5,
            href: '#block-1',
            annotationId: 'annotation-1',
            relationshipId: 'relationship-1',
            targetIds: ['block-1'],
            bold: true,
            italic: false,
            verticalAlign: 'superscript',
            compactMathAtom: false,
            semanticRole: 'cross-reference',
          },
        ],
        evidence: sharedEvidence,
        sourceObservationAnchorIds: ['anchor-1'],
        table: {
          rows: 1,
          columns: 1,
          cells: [
            {
              id: 'cell-1',
              text: 'Cell',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence: sharedEvidence,
            },
          ],
          semantic: 'verified',
        },
        furniture: {
          classification: 'repeated-text',
          band: 'top',
          pages: [1],
          boxes: [],
          evidence: ['fixture-furniture'],
          normalizedText: 'Header',
          sequence: [1],
          sourceRunIndexes: [0],
        },
        furnitureReview: {
          reason: 'single-occurrence-margin',
          band: 'right',
          pages: [1],
          boxes: [],
          evidence: ['fixture-review'],
        },
        fallbackAssetIds: ['asset-1'],
        attributes: { level: 1, bibliographyEntry: false, objectType: 'body' },
      },
    ],
    assets: [
      {
        id: 'asset-1',
        kind: 'figure',
        href: 'assets/asset-1.bin',
        mediaType: 'application/octet-stream',
        sha256: assetBytesHash,
        width: 10,
        height: 10,
        bytes: 'AP+A',
        sourceObjectIds: ['source-asset'],
        evidence: sharedEvidence,
        fallback: 'asset',
      },
    ],
    relationships: [
      {
        id: 'relationship-1',
        kind: 'reading-order',
        from: 'block-1',
        to: ['block-1'],
        label: 'next',
        status: 'matched',
        confidence: 1,
        evidence: sharedEvidence,
        candidates: [
          { target: 'block-1', confidence: 1, evidence: sharedEvidence },
        ],
      },
    ],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['block-1'],
        columns: [{ id: 'column-1', side: 'single', blockIds: ['block-1'] }],
      },
    ],
    diagnostics: [
      {
        id: 'diagnostic-1',
        severity: 'info',
        category: 'source',
        title: 'Fixture',
        message: 'Fixture diagnostic',
        action: 'Continue',
        pages: [1],
        sourceIds: ['source-node'],
      },
    ],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'No recovery required',
      issues: [
        {
          category: 'source',
          title: 'None',
          count: 0,
          pages: [],
          action: 'None',
        },
      ],
      userAction: 'None',
    },
    receipt: {
      schemaVersion: '0.1.0',
      sourceSha256: hash,
      blockCount: 1,
      assetCount: 1,
      relationshipCount: 1,
      diagnosticCount: 1,
      textCharacterCount: 5,
      conservation: {
        sourceNodeCount: 1,
        accountedSourceNodeCount: 1,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 1,
        accountedSourceAnnotationCount: 1,
        sourceAssetCount: 1,
        accountedSourceAssetCount: 1,
        sourceRelationshipCount: 1,
        accountedSourceRelationshipCount: 1,
        sourceDiagnosticCount: 1,
        accountedSourceDiagnosticCount: 1,
        sourceTextCharacterCount: 5,
        structBlockCount: 1,
        structAssetCount: 1,
        structRelationshipCount: 1,
        structDiagnosticCount: 1,
        structTextCharacterCount: 5,
        sourceFurnitureBlockCount: 0,
        accountedFurnitureBlockCount: 0,
        sourceFurnitureTextCharacterCount: 0,
        structFurnitureBlockCount: 0,
        structFurnitureTextCharacterCount: 0,
        furnitureContaminationCount: 0,
      },
      generatedSha256: hash,
    },
  })
}
