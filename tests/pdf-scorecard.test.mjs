import { describe, expect, it } from 'vitest'
import {
  SUCCESS_CRITERIA,
  buildScorecard,
  renderMarkdown,
  scoreDocument,
} from '../adapters/pdf/scorecard.mjs'

function completeness(overrides = {}) {
  return {
    sourceTextCharacters: 10000,
    textCoverage: 1,
    missingSourceRegionCount: 0,
    unresolvedCorruptingJoinCount: 0,
    readingOrderDiagnostics: 0,
    expectedInlineSpanCount: 12,
    inlineSpanCoverage: 1,
    expectedHyperlinkCount: 4,
    hyperlinkCoverage: 1,
    sourceAssetCount: 2,
    exportedAssetCount: 2,
    assetCoverage: 1,
    expectedRelationshipCount: 3,
    relationshipCoverage: 1,
    expectedSemanticTableCount: 1,
    semanticTableCoverage: 1,
    unresolvedObjects: {
      assets: 0,
      captions: 0,
      tables: 0,
      equations: 0,
      citations: 0,
      footnoteReferences: 0,
      footnotes: 0,
    },
    ocrRequiredPages: [],
    furnitureExcludedRunCount: 6,
    furnitureContaminationCount: 0,
    ...overrides,
  }
}

const readyDocument = {
  basename: 'ready.pdf',
  sha256: 'a'.repeat(64),
  pageCount: 8,
  completeness: completeness(),
  readiness: { status: 'ready', ready: true, blockingDiagnosticCodes: [] },
  diagnosticCounts: { CLASSIFIED_NOTE_MARKER: 3, REPEATED_MARGIN_TEXT: 1 },
}

const reviewDocument = {
  basename: 'review.pdf',
  sha256: 'b'.repeat(64),
  pageCount: 12,
  completeness: completeness({
    textCoverage: 0.97,
    unresolvedCorruptingJoinCount: 2,
    assetCoverage: 0.5,
    exportedAssetCount: 1,
    hyperlinkCoverage: 0.25,
    unresolvedObjects: {
      assets: 1,
      captions: 0,
      tables: 0,
      equations: 4,
      citations: 0,
      footnoteReferences: 1,
      footnotes: 0,
    },
  }),
  readiness: {
    status: 'review-required',
    ready: false,
    blockingDiagnosticCodes: [
      'UNRESOLVED_VISUAL_OBJECT',
      'FURNITURE_CONTAMINATION',
    ],
  },
  diagnosticCounts: {
    UNRESOLVED_VISUAL_OBJECT: 1,
    UNRESOLVED_CORRUPTING_JOIN: 2,
    UNRESOLVED_NOTE_REFERENCE: 1,
    UNRESOLVED_EQUATION_TRANSCRIPT: 4,
    UNRESOLVED_HYPERLINK: 3,
    FURNITURE_CONTAMINATION: 1,
  },
}

const crashedDocument = {
  basename: 'crashed.pdf',
  sha256: null,
  code: 'AUDIT_FAILED',
  message:
    'The PDF could not be audited; local path and document details were suppressed.',
}

describe('PDF success scorecard', () => {
  it('names every reader-facing criterion with a degenerate-answer guard', () => {
    expect(SUCCESS_CRITERIA.map((criterion) => criterion.id)).toEqual([
      'pipeline-completes',
      'prose-continuity',
      'figures-and-captions',
      'footnotes-and-notes',
      'formatting-and-structure',
      'hyperlinks-and-references',
      'page-furniture-excluded',
      'scanned-pages-recovered',
      'publication-ready',
    ])
    for (const criterion of SUCCESS_CRITERIA) {
      expect(criterion.guard.length).toBeGreaterThan(20)
    }
  })

  it('passes a clean document on every applicable criterion', () => {
    const scored = scoreDocument(readyDocument, { kind: 'born-digital' })
    const verdicts = Object.fromEntries(
      Object.entries(scored.criteria).map(([id, result]) => [
        id,
        result.applicable ? result.pass : 'n/a',
      ]),
    )
    expect(verdicts).toEqual({
      'pipeline-completes': true,
      'prose-continuity': true,
      'figures-and-captions': true,
      'footnotes-and-notes': true,
      'formatting-and-structure': true,
      'hyperlinks-and-references': true,
      'page-furniture-excluded': true,
      'scanned-pages-recovered': 'n/a',
      'publication-ready': true,
    })
  })

  it('attributes each failure to the criterion a reader would notice', () => {
    const scored = scoreDocument(reviewDocument, { kind: 'born-digital' })
    expect(scored.criteria['prose-continuity']).toMatchObject({
      pass: false,
      blockers: expect.arrayContaining([
        'TEXT_COVERAGE_BELOW_0.98',
        'UNRESOLVED_CORRUPTING_JOIN',
      ]),
    })
    expect(scored.criteria['figures-and-captions'].blockers).toEqual(
      expect.arrayContaining([
        'UNRESOLVED_VISUAL_OBJECT',
        'UNRESOLVED_ASSET_OBJECTS',
      ]),
    )
    expect(scored.criteria['footnotes-and-notes'].blockers).toEqual(
      expect.arrayContaining([
        'UNRESOLVED_NOTE_REFERENCE',
        'UNRESOLVED_FOOTNOTE_REFERENCES',
      ]),
    )
    expect(scored.criteria['formatting-and-structure'].blockers).toEqual(
      expect.arrayContaining([
        'UNRESOLVED_EQUATION_TRANSCRIPT',
        'UNRESOLVED_EQUATIONS',
      ]),
    )
    expect(scored.criteria['hyperlinks-and-references'].blockers).toContain(
      'UNRESOLVED_HYPERLINK',
    )
    expect(scored.criteria['page-furniture-excluded']).toMatchObject({
      pass: false,
      blockers: ['FURNITURE_CONTAMINATION'],
    })
    expect(scored.criteria['publication-ready'].pass).toBe(false)
  })

  it('fails every criterion for a crashed document instead of skipping it', () => {
    const scored = scoreDocument(crashedDocument)
    for (const [id, result] of Object.entries(scored.criteria)) {
      expect(result.applicable, id).toBe(true)
      expect(result.pass, id).toBe(false)
      expect(result.blockers, id).toEqual(['AUDIT_FAILED'])
    }
  })

  it('does not let silence score a pass', () => {
    const silent = {
      basename: 'silent.pdf',
      sha256: 'c'.repeat(64),
      pageCount: 20,
      completeness: completeness({
        sourceAssetCount: 0,
        exportedAssetCount: 0,
        expectedHyperlinkCount: 0,
        expectedRelationshipCount: 0,
        expectedInlineSpanCount: 0,
        expectedSemanticTableCount: 0,
        furnitureExcludedRunCount: 0,
      }),
      readiness: { status: 'ready', ready: true, blockingDiagnosticCodes: [] },
      diagnosticCounts: {},
    }
    const scored = scoreDocument(silent, { kind: 'born-digital' })
    expect(scored.criteria['figures-and-captions'].applicable).toBe(false)
    expect(scored.criteria['footnotes-and-notes'].applicable).toBe(false)
    expect(scored.criteria['hyperlinks-and-references'].applicable).toBe(false)
    expect(scored.criteria['formatting-and-structure'].applicable).toBe(false)
    expect(scored.criteria['page-furniture-excluded']).toMatchObject({
      applicable: true,
      pass: false,
      blockers: ['NO_FURNITURE_ACCOUNTED'],
    })
  })

  it('aggregates pass rates per criterion and per stratum without document content', () => {
    const scorecard = buildScorecard(
      [
        { documents: [readyDocument, reviewDocument] },
        { documents: [crashedDocument] },
      ],
      {
        strataManifest: {
          documents: {
            'ready.pdf': {
              layout: 'one-column',
              source: 'latex',
              kind: 'born-digital',
            },
            'review.pdf': {
              layout: 'two-column',
              source: 'publisher',
              kind: 'born-digital',
            },
          },
        },
      },
    )
    expect(scorecard.documents).toBe(3)
    const byId = Object.fromEntries(
      scorecard.criteria.map((criterion) => [criterion.id, criterion]),
    )
    expect(byId['pipeline-completes']).toMatchObject({
      applicable: 3,
      passed: 2,
    })
    expect(byId['publication-ready']).toMatchObject({
      applicable: 3,
      passed: 1,
    })
    expect(byId['figures-and-captions'].topBlockers[0]).toEqual({
      code: 'AUDIT_FAILED',
      documents: 1,
    })
    expect(
      scorecard.strata.layout['two-column'].criteria['prose-continuity'],
    ).toMatchObject({
      applicable: 1,
      passed: 0,
      passRate: 0,
    })
    expect(scorecard.strata.layout.unknown.documents).toBe(1)
    expect(
      scorecard.perDocument.map(
        (document) => document.criteria['publication-ready'],
      ),
    ).toEqual(['pass', 'fail', 'fail'])
    const serialized = JSON.stringify(scorecard)
    expect(serialized).not.toContain('suppressed')
    expect(serialized).not.toContain('/Users/')

    const markdown = renderMarkdown(scorecard)
    expect(markdown).toContain(
      '| Reconstruction completes without crashing | 3 | 2 | 67% |',
    )
    expect(markdown).toContain('## By layout')
  })
})
