import type {
  StructDiagnostic,
  StructDiagnosticSeverity,
  StructRecovery,
} from './types'

type DiagnosticCopy = Pick<
  StructDiagnostic,
  'category' | 'title' | 'message'
> & { action?: string }

export type RecoveryDiagnosticInput = {
  code: string
  severity: StructDiagnosticSeverity
  message: string
  page?: number
  pages?: number[]
  automaticRecovery?: boolean
}

/**
 * Internal diagnostics stay machine-readable, but users need to know what
 * survived, what was preserved as source material, and whether they need to
 * do anything. Keep this table deliberately source-agnostic.
 */
const DIAGNOSTIC_COPY: Record<string, DiagnosticCopy> = {
  OCR_REQUIRED: {
    category: 'text',
    title: 'Some pages needed OCR',
    message: 'Text was recovered from page images instead of embedded text.',
  },
  LOW_CONFIDENCE_OCR: {
    category: 'text',
    title: 'Some scanned text may need a quick check',
    message:
      'The readable export keeps the scanned page content while OCR confidence is lower than usual.',
    action:
      'Compare the marked page with the source only if a word looks wrong.',
  },
  AMBIGUOUS_READING_ORDER: {
    category: 'layout',
    title: 'A multi-column reading order was uncertain',
    message:
      'The export keeps the source order and preserves the affected page region so no text is silently discarded.',
    action:
      'Check the affected page in the preview if paragraph order matters.',
  },
  READING_ORDER_CYCLE: {
    category: 'layout',
    title: 'A page layout could not be fully ordered',
    message:
      'The source layout is preserved for the affected region instead of inventing a paragraph order.',
    action:
      'Use the preview to confirm the page reads in the intended direction.',
  },
  UNRESOLVED_VISUAL_OBJECT: {
    category: 'visuals',
    title: 'A figure or diagram is missing from the readable export',
    message:
      'No packaged source visual could be proven for this figure or diagram.',
    action:
      'Open the marked page and confirm the figure is visible. If it is absent, keep the source PDF instead of publishing this EPUB.',
  },
  UNREFERENCED_VISUAL_ASSET: {
    category: 'visuals',
    title: 'An image could not be placed in the EPUB',
    message:
      'The PDF reports an image that the importer could not bind to source geometry and a rendered EPUB node.',
    action:
      'Open the marked page and confirm every image is visible. If one is absent, keep the source PDF instead of publishing this EPUB.',
  },
  AMBIGUOUS_VISUAL_MATCH: {
    category: 'visuals',
    title: 'A visual had more than one possible match',
    message:
      'The export keeps the source visual and caption rather than attaching it to the wrong paragraph.',
  },
  INCOMPLETE_ASSET_COVERAGE: {
    category: 'visuals',
    title: 'Some source artwork could not be packaged',
    message:
      'The importer preserved the source page region where an individual asset could not be extracted.',
    action:
      'If the preview still shows a blank region, keep the original PDF alongside the EPUB.',
  },
  INCOMPLETE_SEMANTIC_TABLE_COVERAGE: {
    category: 'tables',
    title: 'A table stayed source-preserved',
    message:
      'The original table is included as artwork or a bounded text fallback instead of being flattened into unrelated headings.',
  },
  BOUNDED_TABLE_FALLBACK: {
    category: 'tables',
    title: 'A table uses a safe fallback',
    message:
      'The table stays together with its caption and source evidence because its rows or columns were not unambiguous.',
  },
  UNRESOLVED_EQUATION_TRANSCRIPT: {
    category: 'equations',
    title: 'An equation remains as source artwork',
    message:
      'The original equation image is retained; no unverified transcription is substituted.',
  },
  UNRESOLVED_HYPERLINK: {
    category: 'links',
    title: 'Some links could not be matched',
    message:
      'Links with verified destinations remain clickable; uncertain links are kept as visible source text.',
  },
  INCOMPLETE_RELATIONSHIP_COVERAGE: {
    category: 'links',
    title: 'Some document connections stayed source-preserved',
    message:
      'Captions, notes, citations, or cross-references without a verified destination remain visible without being linked to the wrong target.',
  },
  AMBIGUOUS_NOTE_MATCH: {
    category: 'notes',
    title: 'A note had more than one possible reference',
    message:
      'The note and its marker remain readable without inventing a link between them.',
  },
  UNRESOLVED_NOTE_REFERENCE: {
    category: 'notes',
    title: 'A note marker could not be matched safely',
    message:
      'The marker and note text remain visible; only verified note destinations become links.',
  },
  UNREFERENCED_NOTE: {
    category: 'notes',
    title: 'A note had no reliable marker',
    message:
      'The note remains in the export instead of being discarded or attached to unrelated text.',
  },
  DANGLING_NOTE_REFERENCE: {
    category: 'notes',
    title: 'A note link had no verified destination',
    message: 'The note marker remains visible as text without a broken link.',
  },
  UNRESOLVED_CITATION_REFERENCE: {
    category: 'links',
    title: 'A citation could not be matched safely',
    message:
      'The citation text remains in place instead of linking to the wrong reference.',
  },
  UNRESOLVED_SCHOLARLY_CROSS_REFERENCE: {
    category: 'links',
    title: 'A figure, table, or section reference was uncertain',
    message:
      'The reference text is preserved; only verified destinations become links.',
  },
  UNMAPPED_CITATION_ANCHOR: {
    category: 'links',
    title: 'A citation anchor was not mapped',
    message:
      'The citation remains readable as text and is not pointed at an unrelated bibliography entry.',
  },
  MISSING_SOURCE_REGION: {
    category: 'source',
    title: 'A source region was unavailable',
    message:
      'The exporter records the gap and keeps the nearest recoverable source content.',
    action:
      'Retain the original file if this page is important to the publication.',
  },
  MISSING_IMAGE_PART: {
    category: 'visuals',
    title: 'An embedded image could not be opened',
    message:
      'The export keeps its caption and source position so the missing artwork is explicit.',
    action: 'Check the affected image in the preview before publishing.',
  },
  MISSING_IMAGE_CAPTION: {
    category: 'visuals',
    title: 'An image had no reliable caption',
    message:
      'The image remains in its source position without an invented description.',
  },
  NO_RECONSTRUCTABLE_TEXT: {
    category: 'text',
    title: 'Text could not be recovered from a page',
    message:
      'The source page must be preserved or rescanned because a readable text layer was not available.',
    action: 'Check the marked page or provide a clearer source file.',
  },
  ISOLATED_PROSE_GLYPH: {
    category: 'text',
    title: 'A character could not be joined to surrounding prose',
    message:
      'The character remains source-preserved rather than being inserted into the wrong word.',
  },
  INCOMPLETE_TEXT_COVERAGE: {
    category: 'text',
    title: 'Some source text was not recoverable',
    message:
      'The readable export is available for review, but it should not be treated as a final publication.',
    action: 'Check the affected pages against the source before publishing.',
  },
  FURNITURE_REVIEW_REQUIRED: {
    category: 'layout',
    title: 'A page-margin run needs a quick source check',
    message:
      'A single-occurrence margin run remains in the readable flow because repetition did not prove it was page furniture.',
    action:
      'Check the marked page before publishing. The run remains visible and was not silently discarded.',
  },
  FURNITURE_CONTAMINATION: {
    category: 'layout',
    title: 'Page furniture entered the reading flow',
    message:
      'The export found a repeated margin run inside canonical body flow and stopped publication until its source geometry is reviewed.',
    action: 'Compare the marked page with the source PDF before publishing.',
  },
  UNRESOLVED_CORRUPTING_JOIN: {
    category: 'text',
    title: 'A line break could not be joined safely',
    message:
      'The original line break is retained rather than merging two words incorrectly.',
  },
  UNRESOLVED_SEMANTIC_OBJECTS: {
    category: 'source',
    title: 'Some structure remains source-preserved',
    message:
      'Uncertain objects stay attached to their source region instead of being guessed.',
  },
  UNRESOLVED_FRONT_MATTER: {
    category: 'layout',
    title: 'Front matter stayed in its source layout',
    message:
      'The affected title, author, or publication details remain together without being guessed into the wrong fields.',
  },
  INCOMPLETE_INLINE_STYLE_COVERAGE: {
    category: 'text',
    title: 'Some inline formatting stayed source-preserved',
    message:
      'Text remains readable while uncertain emphasis, superscripts, or subscripts are kept with their source evidence.',
  },
  DANGLING_EPUB_INTERNAL_REFERENCE: {
    category: 'links',
    title: 'An internal link had no verified destination',
    message:
      'The reference remains visible as text without a broken EPUB link.',
  },
  UNRESOLVED_ALGORITHM_BLOCK: {
    category: 'source',
    title: 'An algorithm stayed in its source layout',
    message:
      'The complete bounded algorithm region is preserved instead of being flattened into unrelated paragraphs.',
  },
  UNRESOLVED_ALGORITHM_TRANSCRIPT: {
    category: 'source',
    title: 'An algorithm transcript was uncertain',
    message:
      'The source algorithm remains available without an unverified text transcription.',
  },
  UNRESOLVED_PREFORMATTED_BLOCK: {
    category: 'source',
    title: 'A preformatted block stayed in its source layout',
    message:
      'Spacing and line structure are preserved instead of being promoted to headings or ordinary prose.',
  },
  UNRESOLVED_PREFORMATTED_TRANSCRIPT: {
    category: 'source',
    title: 'A preformatted transcript was uncertain',
    message:
      'The bounded source block remains available without an invented structure.',
  },
}

const FALLBACK_COPY: DiagnosticCopy = {
  category: 'source',
  title: 'The importer could not verify part of this file',
  message:
    'The readable export preserves the recoverable source content and avoids making an unsupported structural guess.',
  action:
    'Try again with a clearer original file. If it still fails, keep the source file instead of publishing this EPUB.',
}

export function diagnosticCopy(
  code: string,
  _originalMessage?: string,
): DiagnosticCopy {
  return DIAGNOSTIC_COPY[code] ?? FALLBACK_COPY
}

export function diagnosticCategory(code: string): StructDiagnostic['category'] {
  return diagnosticCopy(code).category
}

export function toStructDiagnostic(input: {
  id?: string
  code: string
  severity: StructDiagnosticSeverity
  message: string
  page?: number
  sourceIds?: string[]
}) {
  const copy = diagnosticCopy(input.code, input.message)
  return {
    id: input.id ?? `${input.code}-${input.page ?? 'document'}`,
    severity: input.severity,
    category: copy.category,
    title: copy.title,
    message: copy.message,
    ...(copy.action ? { action: copy.action } : {}),
    pages: input.page === undefined ? [] : [input.page],
    sourceIds: input.sourceIds ?? [],
  } satisfies StructDiagnostic
}

type RecoveryInput = {
  ready: boolean
  diagnostics: ReadonlyArray<RecoveryDiagnosticInput>
  blockingCodes?: readonly string[]
  textCoverage?: number
  assetCoverage?: number
  relationshipCoverage?: number
  unresolvedObjectCount?: number
}

export function recoverySummary(input: RecoveryInput): StructRecovery {
  const blocking = new Set(input.blockingCodes ?? [])
  const relevant = input.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity !== 'info' &&
      (blocking.size === 0 || blocking.has(diagnostic.code)),
  )
  // A source-preserved fallback is an automatic recovery only when the adapter
  // proves it. Unclassified and future blocker codes fail closed so a genuinely
  // missing object can never be mislabeled as ready.
  const actionable = relevant.filter(
    (diagnostic) => diagnostic.automaticRecovery !== true,
  )
  const groups = new Map<
    string,
    {
      category: StructDiagnostic['category']
      title: string
      pages: Set<number>
      unknownCount: number
      action: string
    }
  >()
  for (const diagnostic of actionable) {
    const copy = diagnosticCopy(diagnostic.code, diagnostic.message)
    const action = copy.action ?? FALLBACK_COPY.action!
    const groupKey = `${copy.category}\u0000${copy.title}\u0000${action}`
    const previous = groups.get(groupKey)
    const pages = previous?.pages ?? new Set<number>()
    const diagnosticPages = diagnostic.pages?.length
      ? diagnostic.pages
      : diagnostic.page === undefined
        ? []
        : [diagnostic.page]
    for (const page of diagnosticPages) pages.add(page)
    groups.set(groupKey, {
      category: copy.category,
      title: copy.title,
      pages,
      unknownCount:
        (previous?.unknownCount ?? 0) + (diagnosticPages.length === 0 ? 1 : 0),
      action,
    })
  }
  const issues = [...groups.values()].map((group) => {
    const pages = [...group.pages].sort((left, right) => left - right)
    return {
      category: group.category,
      title: group.title,
      count: pages.length > 0 ? pages.length : Math.min(group.unknownCount, 1),
      pages,
      action: group.action,
    }
  })
  if (input.ready) {
    return {
      status: 'ready',
      title: 'Your EPUB is ready to read.',
      summary:
        'Text, links, notes, and source visuals passed the reconstruction checks. The file stays on this device.',
      issues,
    }
  }
  const fallbackAvailable =
    (input.textCoverage ?? 0) > 0 &&
    (input.assetCoverage ?? 0) >= 0 &&
    (input.relationshipCoverage ?? 0) >= 0
  if (!fallbackAvailable && issues.length === 0) {
    issues.push({
      category: FALLBACK_COPY.category,
      title: FALLBACK_COPY.title,
      count: 1,
      pages: [],
      action: FALLBACK_COPY.action!,
    })
  }
  return {
    status: 'review-required',
    title:
      fallbackAvailable && issues.length === 0
        ? 'Your EPUB is ready to read.'
        : fallbackAvailable
          ? 'Your EPUB is readable, but not publication-ready yet.'
          : 'This file needs a source check before it can be exported.',
    summary: fallbackAvailable
      ? issues.length === 0
        ? 'The importer reconstructed what it could prove and kept source-preserved figures, tables, equations, notes, and uncertain links in place. Nothing needs your attention to read this file, and nothing was uploaded.'
        : 'You can read the local fallback now. Recoverable text, captions, links, and source-preserved visuals were kept wherever a safe semantic reconstruction was not possible. Nothing was uploaded.'
      : 'The importer could not recover enough source content to make a trustworthy EPUB. Nothing was uploaded.',
    issues,
    userAction:
      issues.length > 0
        ? `Open the preview and check ${issues
            .flatMap((issue) => issue.pages)
            .filter((page, index, pages) => pages.indexOf(page) === index)
            .sort((left, right) => left - right)
            .map((page) => `page ${page}`)
            .join(
              ', ',
            )}${issues.some((issue) => issue.pages.length === 0) ? (issues.some((issue) => issue.pages.length > 0) ? ', and any unnumbered item' : 'the affected item') : ''}.`
        : undefined,
  }
}

export function hasActionableRecovery(
  recovery: StructRecovery | undefined,
): recovery is StructRecovery & { userAction: string } {
  return Boolean(recovery?.userAction)
}
