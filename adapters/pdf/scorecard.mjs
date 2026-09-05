#!/usr/bin/env node
// Reader-facing success scorecard for PDF-to-EPUB reconstruction.
//
// The corpus audit answers one binary question per document ("ready" or not)
// and nothing has ever passed it. This tool re-reads the same privacy-safe
// audit reports and answers the questions a reader actually asks, one
// criterion at a time, per document and per corpus stratum, so progress on any
// single criterion is visible before the binary gate flips.
//
// Input reports are `pdf-corpus-audit` JSON (schema 1.x). Output contains
// basenames, hashes, counts, and diagnostic codes only.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const SCORECARD_SCHEMA_VERSION = '1.0.0'

const CRASH_CODES = new Set([
  'AUDIT_FAILED',
  'PDF_PARSE_FAILED',
  'PDF_DOCUMENT_TIMEOUT',
  'PDF_DOCUMENT_STALLED',
  'PDF_DOCUMENT_WORKER_FAILED',
  'IMPORT_CANCELLED',
  'OVERSIZED_PDF',
])

const count = (document, code) => document.diagnosticCounts?.[code] ?? 0
const anyOf = (document, codes) =>
  codes.filter((code) => count(document, code) > 0)
const objects = (document) => document.completeness?.unresolvedObjects ?? {}

function blockersFrom(document, codes, extra = []) {
  return [...new Set([...anyOf(document, codes), ...extra])].sort()
}

/**
 * Each criterion states what a reader notices, which diagnostic codes and
 * completeness counters decide it, when it applies to a document, and the
 * degenerate-answer guard that stops an empty or silent pipeline from
 * scoring a pass.
 */
export const SUCCESS_CRITERIA = [
  {
    id: 'pipeline-completes',
    title: 'Reconstruction completes without crashing',
    guard:
      'A crash, timeout, or parse failure fails every other criterion too.',
    evaluate(document) {
      const crashed = Boolean(document.code) && CRASH_CODES.has(document.code)
      return {
        applicable: true,
        pass: !crashed,
        blockers: crashed ? [document.code] : [],
        metrics: {},
      }
    },
  },
  {
    id: 'prose-continuity',
    title: 'Text is continuous and flows naturally',
    guard:
      'Text coverage alone is not enough; reading-order, join, ledger, and provenance counters must all be clean.',
    codes: [
      'AMBIGUOUS_READING_ORDER',
      'READING_ORDER_CYCLE',
      'CANONICAL_FLOW_ORDER_VIOLATION',
      'CANONICAL_VISUAL_ORDER_VIOLATION',
      'UNRESOLVED_CORRUPTING_JOIN',
      'ISOLATED_PROSE_GLYPH',
      'INCOMPLETE_TEXT_COVERAGE',
      'MISSING_SOURCE_REGION',
      'UNPROVENANCED_RENDERED_UNIT',
      'DUPLICATE_CANONICAL_SPAN',
      'DUPLICATE_CANONICAL_ROLE',
      'EPUB_TEXT_SANITIZATION_LOSS',
      'INVALID_LINE_BOUNDARY_LEDGER',
      'INVALID_SOURCE_SEMANTIC_FLOW_BOUNDARY_LEDGER',
      'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
      'LOW_CONFIDENCE_BLOCK',
      'NO_RECONSTRUCTABLE_TEXT',
    ],
    evaluate(document) {
      const completeness = document.completeness ?? {}
      const extra = []
      if ((completeness.textCoverage ?? 0) < 0.98)
        extra.push('TEXT_COVERAGE_BELOW_0.98')
      if ((completeness.unresolvedCorruptingJoinCount ?? 0) > 0) {
        extra.push('UNRESOLVED_CORRUPTING_JOIN')
      }
      if ((completeness.readingOrderDiagnostics ?? 0) > 0) {
        extra.push('AMBIGUOUS_READING_ORDER')
      }
      const blockers = blockersFrom(document, this.codes, extra)
      return {
        applicable: (completeness.sourceTextCharacters ?? 0) > 0,
        pass: blockers.length === 0,
        blockers,
        metrics: {
          textCoverage: completeness.textCoverage ?? null,
          unresolvedCorruptingJoinCount:
            completeness.unresolvedCorruptingJoinCount ?? null,
          readingOrderDiagnostics: completeness.readingOrderDiagnostics ?? null,
        },
      }
    },
  },
  {
    id: 'figures-and-captions',
    title: 'Every figure and diagram is extracted and owns its caption',
    guard:
      'Only documents with at least one source asset count; a document with no figures cannot pass this criterion by omission.',
    codes: [
      'UNRESOLVED_VISUAL_OBJECT',
      'UNREFERENCED_VISUAL_ASSET',
      'AMBIGUOUS_VISUAL_MATCH',
      'INCOMPLETE_ASSET_COVERAGE',
      'MISSING_IMAGE_CAPTION',
    ],
    evaluate(document) {
      const completeness = document.completeness ?? {}
      const extra = []
      if ((objects(document).assets ?? 0) > 0)
        extra.push('UNRESOLVED_ASSET_OBJECTS')
      if ((objects(document).captions ?? 0) > 0)
        extra.push('UNRESOLVED_CAPTIONS')
      if (
        completeness.assetCoverage !== undefined &&
        completeness.assetCoverage < 1
      ) {
        extra.push('INCOMPLETE_ASSET_COVERAGE')
      }
      const blockers = blockersFrom(document, this.codes, extra)
      return {
        applicable:
          (completeness.sourceAssetCount ?? 0) > 0 || blockers.length > 0,
        pass: blockers.length === 0,
        blockers,
        metrics: {
          sourceAssetCount: completeness.sourceAssetCount ?? null,
          exportedAssetCount: completeness.exportedAssetCount ?? null,
          assetCoverage: completeness.assetCoverage ?? null,
        },
      }
    },
  },
  {
    id: 'footnotes-and-notes',
    title: 'Footnotes and endnotes are extracted and linked both ways',
    guard:
      'Applies only when the source shows note markers or note objects; silence about notes is not a pass.',
    codes: [
      'UNRESOLVED_NOTE_REFERENCE',
      'UNREFERENCED_NOTE',
      'AMBIGUOUS_NOTE_MATCH',
      'DANGLING_NOTE_REFERENCE',
    ],
    evaluate(document) {
      const extra = []
      if ((objects(document).footnotes ?? 0) > 0)
        extra.push('UNRESOLVED_FOOTNOTES')
      if ((objects(document).footnoteReferences ?? 0) > 0) {
        extra.push('UNRESOLVED_FOOTNOTE_REFERENCES')
      }
      const blockers = blockersFrom(document, this.codes, extra)
      const evidence = count(document, 'CLASSIFIED_NOTE_MARKER') > 0
      return {
        applicable: evidence || blockers.length > 0,
        pass: blockers.length === 0,
        blockers,
        metrics: {
          classifiedNoteMarkers: count(document, 'CLASSIFIED_NOTE_MARKER'),
        },
      }
    },
  },
  {
    id: 'formatting-and-structure',
    title:
      'Inline formatting, headings, tables, equations, and listings are kept as structure',
    guard:
      'Applies when the source has inline styles, tables, equations, or listings; an image of a table or formula is fallback, not structure.',
    codes: [
      'INCOMPLETE_INLINE_STYLE_COVERAGE',
      'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
      'BOUNDED_TABLE_FALLBACK',
      'UNRESOLVED_EQUATION_TRANSCRIPT',
      'UNRESOLVED_PREFORMATTED_BLOCK',
      'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
      'UNRESOLVED_ALGORITHM_BLOCK',
      'UNRESOLVED_ALGORITHM_TRANSCRIPT',
      'UNRESOLVED_FRONT_MATTER',
    ],
    evaluate(document) {
      const completeness = document.completeness ?? {}
      const extra = []
      if ((objects(document).tables ?? 0) > 0) extra.push('UNRESOLVED_TABLES')
      if ((objects(document).equations ?? 0) > 0)
        extra.push('UNRESOLVED_EQUATIONS')
      if (
        completeness.inlineSpanCoverage !== undefined &&
        completeness.inlineSpanCoverage < 1
      ) {
        extra.push('INCOMPLETE_INLINE_STYLE_COVERAGE')
      }
      if (
        completeness.semanticTableCoverage !== undefined &&
        (completeness.expectedSemanticTableCount ?? 0) > 0 &&
        completeness.semanticTableCoverage < 1
      ) {
        extra.push('INCOMPLETE_SEMANTIC_TABLE_COVERAGE')
      }
      const blockers = blockersFrom(document, this.codes, extra)
      const applicable =
        (completeness.expectedInlineSpanCount ?? 0) > 0 ||
        (completeness.expectedSemanticTableCount ?? 0) > 0 ||
        blockers.length > 0
      return {
        applicable,
        pass: blockers.length === 0,
        blockers,
        metrics: {
          inlineSpanCoverage: completeness.inlineSpanCoverage ?? null,
          semanticTableCoverage: completeness.semanticTableCoverage ?? null,
          expectedSemanticTableCount:
            completeness.expectedSemanticTableCount ?? null,
        },
      }
    },
  },
  {
    id: 'hyperlinks-and-references',
    title:
      'Hyperlinks, citations, and cross-references resolve to real targets',
    guard:
      'Applies when the source carries link annotations or scholarly relationships; unresolved links stay visible as text and count as failures.',
    codes: [
      'UNRESOLVED_HYPERLINK',
      'UNRESOLVED_CITATION_REFERENCE',
      'UNMAPPED_CITATION_ANCHOR',
      'UNRESOLVED_SCHOLARLY_CROSS_REFERENCE',
      'AMBIGUOUS_SCHOLARLY_CROSS_REFERENCE',
      'UNMAPPED_SCHOLARLY_CROSS_REFERENCE_ANCHOR',
      'DANGLING_EPUB_INTERNAL_REFERENCE',
      'INCOMPLETE_RELATIONSHIP_COVERAGE',
    ],
    evaluate(document) {
      const completeness = document.completeness ?? {}
      const extra = []
      if ((objects(document).citations ?? 0) > 0)
        extra.push('UNRESOLVED_CITATIONS')
      if (
        completeness.hyperlinkCoverage !== undefined &&
        (completeness.expectedHyperlinkCount ?? 0) > 0 &&
        completeness.hyperlinkCoverage < 1
      ) {
        extra.push('UNRESOLVED_HYPERLINK')
      }
      if (
        completeness.relationshipCoverage !== undefined &&
        (completeness.expectedRelationshipCount ?? 0) > 0 &&
        completeness.relationshipCoverage < 1
      ) {
        extra.push('INCOMPLETE_RELATIONSHIP_COVERAGE')
      }
      const blockers = blockersFrom(document, this.codes, extra)
      const applicable =
        (completeness.expectedHyperlinkCount ?? 0) > 0 ||
        (completeness.expectedRelationshipCount ?? 0) > 0 ||
        blockers.length > 0
      return {
        applicable,
        pass: blockers.length === 0,
        blockers,
        metrics: {
          hyperlinkCoverage: completeness.hyperlinkCoverage ?? null,
          expectedHyperlinkCount: completeness.expectedHyperlinkCount ?? null,
          relationshipCoverage: completeness.relationshipCoverage ?? null,
        },
      }
    },
  },
  {
    id: 'page-furniture-excluded',
    title:
      'Running heads, journal names, page numbers, and margin stamps stay out of the flow',
    guard:
      'A multi-page document passes only when furniture was actually accounted for; a pipeline that never classifies furniture cannot pass by silence.',
    codes: ['FURNITURE_CONTAMINATION', 'FURNITURE_REVIEW_REQUIRED'],
    evaluate(document) {
      const completeness = document.completeness ?? {}
      const pageCount = document.pageCount ?? 0
      const extra = []
      if ((completeness.furnitureContaminationCount ?? 0) > 0) {
        extra.push('FURNITURE_CONTAMINATION')
      }
      const blockers = blockersFrom(document, this.codes, extra)
      const accounted =
        (completeness.furnitureExcludedRunCount ?? 0) > 0 ||
        count(document, 'REPEATED_MARGIN_TEXT') > 0
      const applicable = pageCount > 1
      const pass = blockers.length === 0 && (accounted || pageCount <= 2)
      if (applicable && !pass && blockers.length === 0) {
        blockers.push('NO_FURNITURE_ACCOUNTED')
      }
      return {
        applicable,
        pass,
        blockers,
        metrics: {
          furnitureExcludedRunCount:
            completeness.furnitureExcludedRunCount ?? null,
          furnitureContaminationCount:
            completeness.furnitureContaminationCount ?? null,
        },
      }
    },
  },
  {
    id: 'scanned-pages-recovered',
    title: 'Scanned or image-only pages are recovered rather than skipped',
    guard: 'Applies only to documents that needed OCR on at least one page.',
    codes: [
      'OCR_REQUIRED',
      'LOW_CONFIDENCE_OCR',
      'MIXED_OCR_CONFLICT',
      'OCR_LANGUAGE_UNAVAILABLE',
      'OCR_NETWORK_FORBIDDEN',
      'NO_RECONSTRUCTABLE_TEXT',
    ],
    evaluate(document, strata) {
      const pages = document.completeness?.ocrRequiredPages ?? []
      const blockers = blockersFrom(
        document,
        this.codes,
        pages.length ? ['OCR_REQUIRED'] : [],
      )
      const applicable = strata?.kind === 'scanned' || blockers.length > 0
      return {
        applicable,
        pass: blockers.length === 0,
        blockers,
        metrics: { ocrRequiredPageCount: pages.length },
      }
    },
  },
  {
    id: 'publication-ready',
    title: 'Document passes the fail-closed publication gate',
    guard:
      'This is the existing binary gate; it is reported last, not instead of the criteria above.',
    evaluate(document) {
      const ready = Boolean(document.readiness?.ready)
      return {
        applicable: true,
        pass: ready,
        blockers: ready
          ? []
          : (document.readiness?.blockingDiagnosticCodes ?? []),
        metrics: {},
      }
    },
  },
]

export function scoreDocument(document, strata = null) {
  const crashed = Boolean(document.code) && CRASH_CODES.has(document.code)
  const criteria = {}
  for (const criterion of SUCCESS_CRITERIA) {
    if (crashed && criterion.id !== 'pipeline-completes') {
      criteria[criterion.id] = {
        applicable: true,
        pass: false,
        blockers: [document.code],
        metrics: {},
      }
      continue
    }
    criteria[criterion.id] = criterion.evaluate(document, strata)
  }
  return {
    basename: document.basename,
    sha256: document.sha256 ?? null,
    pageCount: document.pageCount ?? null,
    strata: strata ?? null,
    criteria,
  }
}

function rate(passed, applicable) {
  return applicable === 0 ? null : Number((passed / applicable).toFixed(4))
}

function summarize(scored) {
  const criteria = SUCCESS_CRITERIA.map((criterion) => {
    const blockers = new Map()
    let applicable = 0
    let passed = 0
    for (const document of scored) {
      const result = document.criteria[criterion.id]
      if (!result.applicable) continue
      applicable += 1
      if (result.pass) passed += 1
      for (const code of result.blockers) {
        blockers.set(code, (blockers.get(code) ?? 0) + 1)
      }
    }
    return {
      id: criterion.id,
      title: criterion.title,
      guard: criterion.guard,
      applicable,
      passed,
      passRate: rate(passed, applicable),
      topBlockers: [...blockers]
        .sort(
          (left, right) =>
            right[1] - left[1] || left[0].localeCompare(right[0]),
        )
        .slice(0, 6)
        .map(([code, documents]) => ({ code, documents })),
    }
  })
  return criteria
}

function summarizeStrata(scored, keys) {
  const strata = {}
  for (const key of keys) {
    const groups = new Map()
    for (const document of scored) {
      const value = document.strata?.[key] ?? 'unknown'
      const group = groups.get(value) ?? []
      group.push(document)
      groups.set(value, group)
    }
    strata[key] = Object.fromEntries(
      [...groups]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([value, documents]) => [
          value,
          {
            documents: documents.length,
            criteria: Object.fromEntries(
              summarize(documents).map((criterion) => [
                criterion.id,
                {
                  applicable: criterion.applicable,
                  passed: criterion.passed,
                  passRate: criterion.passRate,
                },
              ]),
            ),
          },
        ]),
    )
  }
  return strata
}

export function buildScorecard(reports, { strataManifest = null } = {}) {
  const documents = reports.flatMap((report) => report.documents ?? [])
  const scored = documents.map((document) =>
    scoreDocument(
      document,
      strataManifest?.documents?.[document.basename] ?? null,
    ),
  )
  const strataKeys = strataManifest ? ['layout', 'source', 'kind'] : []
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    privacy: 'basenames-hashes-counts-diagnostic-codes-only',
    documents: scored.length,
    criteria: summarize(scored),
    strata: summarizeStrata(scored, strataKeys),
    perDocument: scored.map((document) => ({
      basename: document.basename,
      strata: document.strata,
      criteria: Object.fromEntries(
        Object.entries(document.criteria).map(([id, result]) => [
          id,
          result.applicable ? (result.pass ? 'pass' : 'fail') : 'n/a',
        ]),
      ),
    })),
  }
}

export function renderMarkdown(scorecard) {
  const percent = (value) =>
    value === null ? 'n/a' : `${Math.round(value * 100)}%`
  const lines = [
    `# PDF-to-EPUB success scorecard (${scorecard.documents} documents)`,
    '',
    '| Criterion | Applicable | Passed | Pass rate | Top blockers |',
    '| --- | ---: | ---: | ---: | --- |',
  ]
  for (const criterion of scorecard.criteria) {
    lines.push(
      `| ${criterion.title} | ${criterion.applicable} | ${criterion.passed} | ${percent(criterion.passRate)} | ${criterion.topBlockers
        .slice(0, 3)
        .map((blocker) => `${blocker.code} (${blocker.documents})`)
        .join(', ')} |`,
    )
  }
  for (const [key, groups] of Object.entries(scorecard.strata)) {
    lines.push('', `## By ${key}`, '')
    const ids = scorecard.criteria.map((criterion) => criterion.id)
    lines.push(`| ${key} | docs | ${ids.join(' | ')} |`)
    lines.push(`| --- | ---: | ${ids.map(() => '---:').join(' | ')} |`)
    for (const [value, group] of Object.entries(groups)) {
      lines.push(
        `| ${value} | ${group.documents} | ${ids
          .map((id) => percent(group.criteria[id]?.passRate ?? null))
          .join(' | ')} |`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

function usage() {
  return 'Usage: node tools/pdf-success-scorecard.mjs <corpus-audit.json>... [--strata <manifest.json>] [--out <scorecard.json>] [--markdown]\n'
}

export async function readReport(path) {
  const text = await readFile(path, 'utf8')
  const start = text.indexOf('{')
  if (start < 0) throw new Error(`No JSON object in ${path}`)
  return JSON.parse(text.slice(start))
}

async function main(args) {
  const inputs = []
  let strataPath = null
  let out = null
  let markdown = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--strata') {
      strataPath = args[index + 1] ?? null
      index += 1
    } else if (argument === '--out') {
      out = args[index + 1] ?? null
      index += 1
    } else if (argument === '--markdown') {
      markdown = true
    } else if (argument.startsWith('--')) {
      throw new Error('INVALID_USAGE')
    } else {
      inputs.push(argument)
    }
  }
  if (inputs.length === 0) throw new Error('INVALID_USAGE')
  const reports = await Promise.all(inputs.map(readReport))
  const strataManifest = strataPath ? await readReport(strataPath) : null
  const scorecard = buildScorecard(reports, { strataManifest })
  if (out) await writeFile(out, `${JSON.stringify(scorecard, null, 2)}\n`)
  process.stdout.write(
    markdown
      ? renderMarkdown(scorecard)
      : `${JSON.stringify(scorecard, null, 2)}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      error instanceof Error && error.message === 'INVALID_USAGE'
        ? usage()
        : `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
