import type {
  StructDiagnostic,
  StructDiagnosticSeverity,
  StructRecovery,
} from './document/types'

export type RecoveryDiagnosticInput = {
  code: string
  severity: StructDiagnosticSeverity
  message: string
  page?: number
  pages?: number[]
  automaticRecovery?: boolean
}

export type StructRecoveryFact = Pick<
  StructDiagnostic,
  'category' | 'title' | 'message'
>

const DIAGNOSTIC_CATEGORIES: Record<
  string,
  StructDiagnostic['category']
> = {
  OCR_REQUIRED: 'text',
  LOW_CONFIDENCE_OCR: 'text',
  AMBIGUOUS_READING_ORDER: 'layout',
  READING_ORDER_CYCLE: 'layout',
  UNRESOLVED_VISUAL_OBJECT: 'visuals',
  UNREFERENCED_VISUAL_ASSET: 'visuals',
  AMBIGUOUS_VISUAL_MATCH: 'visuals',
  INCOMPLETE_ASSET_COVERAGE: 'visuals',
  INCOMPLETE_SEMANTIC_TABLE_COVERAGE: 'tables',
  BOUNDED_TABLE_FALLBACK: 'tables',
  UNRESOLVED_EQUATION_TRANSCRIPT: 'equations',
  UNRESOLVED_HYPERLINK: 'links',
  INCOMPLETE_RELATIONSHIP_COVERAGE: 'links',
  AMBIGUOUS_NOTE_MATCH: 'notes',
  UNRESOLVED_NOTE_REFERENCE: 'notes',
  UNREFERENCED_NOTE: 'notes',
  DANGLING_NOTE_REFERENCE: 'notes',
  UNRESOLVED_CITATION_REFERENCE: 'links',
  UNRESOLVED_SCHOLARLY_CROSS_REFERENCE: 'links',
  UNMAPPED_CITATION_ANCHOR: 'links',
  MISSING_SOURCE_REGION: 'source',
  MISSING_IMAGE_PART: 'visuals',
  MISSING_IMAGE_CAPTION: 'visuals',
  NO_RECONSTRUCTABLE_TEXT: 'text',
  ISOLATED_PROSE_GLYPH: 'text',
  INCOMPLETE_TEXT_COVERAGE: 'text',
  FURNITURE_REVIEW_REQUIRED: 'layout',
  FURNITURE_CONTAMINATION: 'layout',
  UNRESOLVED_CORRUPTING_JOIN: 'text',
  UNRESOLVED_SEMANTIC_OBJECTS: 'source',
  UNRESOLVED_FRONT_MATTER: 'layout',
  INCOMPLETE_INLINE_STYLE_COVERAGE: 'text',
  DANGLING_EPUB_INTERNAL_REFERENCE: 'links',
  UNRESOLVED_ALGORITHM_BLOCK: 'source',
  UNRESOLVED_ALGORITHM_TRANSCRIPT: 'source',
  UNRESOLVED_PREFORMATTED_BLOCK: 'source',
  UNRESOLVED_PREFORMATTED_TRANSCRIPT: 'source',
}

function titleFromCode(code: string) {
  const words = code.toLowerCase().replace(/_/gu, ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** Return only source-neutral facts; applications own explanatory copy. */
export function recoveryFact(
  code: string,
  message: string,
): StructRecoveryFact {
  return {
    category: DIAGNOSTIC_CATEGORIES[code] ?? 'source',
    title: titleFromCode(code),
    message,
  }
}

export function diagnosticCategory(code: string): StructDiagnostic['category'] {
  return DIAGNOSTIC_CATEGORIES[code] ?? 'source'
}

export function toStructDiagnostic(input: {
  id?: string
  code: string
  severity: StructDiagnosticSeverity
  message: string
  page?: number
  sourceIds?: string[]
}) {
  const fact = recoveryFact(input.code, input.message)
  return {
    id: input.id ?? `${input.code}-${input.page ?? 'document'}`,
    severity: input.severity,
    ...fact,
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
  const actionable = input.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity !== 'info' &&
      diagnostic.automaticRecovery !== true &&
      (blocking.size === 0 || blocking.has(diagnostic.code)),
  )
  const groups = new Map<
    string,
    {
      category: StructDiagnostic['category']
      title: string
      pages: Set<number>
      unpagedCount: number
    }
  >()
  for (const diagnostic of actionable) {
    const fact = recoveryFact(diagnostic.code, diagnostic.message)
    const key = `${fact.category}\u0000${fact.title}`
    const previous = groups.get(key)
    const pages = previous?.pages ?? new Set<number>()
    const diagnosticPages = diagnostic.pages?.length
      ? diagnostic.pages
      : diagnostic.page === undefined
        ? []
        : [diagnostic.page]
    for (const page of diagnosticPages) pages.add(page)
    groups.set(key, {
      category: fact.category,
      title: fact.title,
      pages,
      unpagedCount:
        (previous?.unpagedCount ?? 0) + (diagnosticPages.length === 0 ? 1 : 0),
    })
  }
  const issues = [...groups.values()].map((group) => {
    const pages = [...group.pages].sort((left, right) => left - right)
    return {
      category: group.category,
      title: group.title,
      count: pages.length > 0 ? pages.length : Math.min(group.unpagedCount, 1),
      pages,
    }
  })
  const issueCount = issues.reduce((total, issue) => total + issue.count, 0)
  return {
    status: input.ready ? 'ready' : 'review-required',
    title: input.ready
      ? 'Recovery status: ready'
      : 'Recovery status: review required',
    summary:
      issueCount === 0
        ? 'No unresolved recovery issues.'
        : `${issueCount} unresolved recovery ${issueCount === 1 ? 'issue' : 'issues'}.`,
    issues,
  }
}

export function hasActionableRecovery(
  recovery: StructRecovery | undefined,
): recovery is StructRecovery & { userAction: string } {
  return Boolean(recovery?.userAction)
}
