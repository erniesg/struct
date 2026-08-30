import {
  resolvePackageReference,
  type ZipArchiveInspection,
} from './archive'
import {
  XML_NAMESPACES,
  xmlAttribute,
  xmlElements,
  xmlElementText,
  xmlTextTokens,
  type NavigationItem,
  type NavigationSemantics,
  type OpfSemantics,
  type XhtmlSemantics,
} from './xml'

export const CLOSED_LAYOUT_ASSERTIONS = Object.freeze([
  'accessibility-links',
  'archive-compression',
  'archive-duplicates',
  'archive-first-entry',
  'archive-order',
  'archive-timestamps',
  'hidden-semantic-text',
  'manifest-links',
  'metadata-links',
  'navigation-hierarchy',
  'navigation-links',
  'semantic-links',
  'spine-links',
  'synthetic-case-id',
  'table-links',
  'visible-text',
] as const)

export type ClosedLayoutAssertion =
  (typeof CLOSED_LAYOUT_ASSERTIONS)[number]

const syntheticCaseIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const invalidSyntheticCaseId = 'synthetic-case-invalid'

export class LayoutAssertionError extends Error {
  readonly assertion: ClosedLayoutAssertion
  readonly caseId: string

  constructor(caseId: string, assertion: ClosedLayoutAssertion) {
    const safeCaseId =
      typeof caseId === 'string' &&
      caseId.length <= 128 &&
      syntheticCaseIdPattern.test(caseId)
      ? caseId
      : invalidSyntheticCaseId
    const message = `${safeCaseId}:${assertion}`
    super(message)
    this.name = 'LayoutAssertionError'
    this.assertion = assertion
    this.caseId = safeCaseId
    this.stack = `${this.name}: ${message}`
  }
}

function checkedCaseId(caseId: string): string {
  if (
    typeof caseId !== 'string' ||
    caseId.length > 128 ||
    !syntheticCaseIdPattern.test(caseId)
  )
    throw new LayoutAssertionError(
      invalidSyntheticCaseId,
      'synthetic-case-id',
    )
  return caseId
}

function assertClosed(
  caseId: string,
  assertion: ClosedLayoutAssertion,
  check: () => boolean,
): void {
  const safeCaseId = checkedCaseId(caseId)
  let accepted = false
  try {
    accepted = check()
  } catch {
    accepted = false
  }
  if (!accepted) throw new LayoutAssertionError(safeCaseId, assertion)
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function containsTokenSequence(
  complete: readonly string[],
  candidate: readonly string[],
): boolean {
  if (candidate.length === 0 || candidate.length > complete.length) return false
  for (let start = 0; start <= complete.length - candidate.length; start += 1)
    if (candidate.every((token, index) => token === complete[start + index]))
      return true
  return false
}

export function assertExactVisibleTextTokens(
  caseId: string,
  xhtml: XhtmlSemantics,
  expected: readonly string[],
): void {
  assertClosed(caseId, 'visible-text', () =>
    sameStrings(xhtml.visibleTextTokens, expected),
  )
}

export function assertNoHiddenSemanticTextDuplicates(
  caseId: string,
  xhtml: XhtmlSemantics,
): void {
  assertClosed(caseId, 'hidden-semantic-text', () =>
    xhtml.semanticTextRuns
      .filter((run) => run.hidden && run.tokens.length > 0)
      .every(
        (run) =>
          !containsTokenSequence(xhtml.visibleTextTokens, run.tokens),
      ),
  )
}

function attributeTokens(value: string | undefined): string[] {
  return value?.match(/[^\t\n\r ]+/gu) ?? []
}

function pairedSemanticToken(
  roles: readonly string[],
  types: readonly string[],
  role: string,
  type: string,
): boolean {
  return roles.includes(role) === types.includes(type)
}

export function assertSemanticLinks(
  caseId: string,
  xhtml: XhtmlSemantics,
): void {
  assertClosed(caseId, 'semantic-links', () => {
    const ids = new Set(xhtml.ids)
    for (const element of xmlElements(xhtml.document.root)) {
      const roles = attributeTokens(xmlAttribute(element, 'role'))
      const types = attributeTokens(
        xmlAttribute(element, 'type', XML_NAMESPACES.epub),
      )
      if (
        !pairedSemanticToken(
          roles,
          types,
          'doc-biblioref',
          'biblioref',
        ) ||
        !pairedSemanticToken(roles, types, 'doc-noteref', 'noteref') ||
        !pairedSemanticToken(
          roles,
          types,
          'doc-bibliography',
          'bibliography',
        ) ||
        !pairedSemanticToken(roles, types, 'doc-footnote', 'footnote') ||
        !pairedSemanticToken(roles, types, 'doc-endnote', 'endnote')
      )
        return false
      const isReference =
        types.includes('biblioref') || types.includes('noteref')
      if (!isReference) continue
      const href = xmlAttribute(element, 'href')
      if (!href) return false
      if (href.startsWith('#')) {
        const target = href.slice(1)
        if (!target || !ids.has(target)) return false
      }
    }
    return true
  })
}

export function assertAccessibilityLinks(
  caseId: string,
  xhtml: XhtmlSemantics,
): void {
  assertClosed(caseId, 'accessibility-links', () => {
    if (xhtml.duplicateIds.length > 0) return false
    const ids = new Set(xhtml.ids)
    if (
      xhtml.ariaReferences.some(
        (reference) =>
          reference.targetIds.length === 0 ||
          reference.targetIds.some((target) => !ids.has(target)),
      )
    )
      return false
    return !xhtml.semanticTextRuns.some(
      (run) => run.hidden && run.focusable && run.tokens.length > 0,
    )
  })
}

export function assertTableLinks(
  caseId: string,
  xhtml: XhtmlSemantics,
): void {
  assertClosed(caseId, 'table-links', () => {
    const elementsById = new Map(
      xmlElements(xhtml.document.root)
        .map((element) => [xmlAttribute(element, 'id'), element] as const)
        .filter(
          (entry): entry is readonly [string, (typeof entry)[1]] =>
            entry[0] !== undefined,
        ),
    )
    const validScopes = new Set(['col', 'colgroup', 'row', 'rowgroup'])
    for (const table of xhtml.tables) {
      if (table.captions.length > 1) return false
      const hasCaption = table.captions.some(
        (caption) => xmlTextTokens(caption.text).length > 0,
      )
      const hasAriaLabel =
        table.ariaLabel !== undefined &&
        xmlTextTokens(table.ariaLabel).length > 0
      const hasLabelledBy =
        table.ariaLabelledBy.length > 0 &&
        table.ariaLabelledBy.every((target) => {
          const element = elementsById.get(target)
          return element !== undefined && xmlTextTokens(xmlElementText(element)).length > 0
        })
      if (!hasCaption && !hasAriaLabel && !hasLabelledBy) return false
      const headerIds = new Set(
        table.cells
          .filter((cell) => cell.kind === 'th' && cell.id !== undefined)
          .map((cell) => cell.id!),
      )
      for (const cell of table.cells) {
        if (cell.kind === 'td' && cell.scope !== undefined) return false
        if (
          cell.kind === 'th' &&
          cell.scope !== undefined &&
          !validScopes.has(cell.scope)
        )
          return false
        if (cell.headers.some((header) => !headerIds.has(header))) return false
      }
    }
    return true
  })
}

function uniqueNonempty(values: readonly (string | undefined)[]): boolean {
  if (values.some((value) => value === undefined || value.length === 0))
    return false
  return new Set(values).size === values.length
}

export function assertOpfMetadataLinks(
  caseId: string,
  opf: OpfSemantics,
): void {
  assertClosed(caseId, 'metadata-links', () => {
    if (!opf.uniqueIdentifier) return false
    const ids = opf.metadata
      .map((entry) => entry.id)
      .filter((id): id is string => id !== undefined)
    if (!uniqueNonempty(ids)) return false
    const identifiers = opf.metadata.filter(
      (entry) =>
        entry.namespaceUri === XML_NAMESPACES.dc &&
        entry.localName === 'identifier' &&
        entry.id === opf.uniqueIdentifier,
    )
    if (
      identifiers.length !== 1 ||
      xmlTextTokens(identifiers[0]!.value).length === 0
    )
      return false
    const idSet = new Set(ids)
    for (const entry of opf.metadata) {
      if (entry.refines === undefined) continue
      if (
        !entry.refines.startsWith('#') ||
        entry.refines.length === 1 ||
        entry.refines.slice(1).includes('#') ||
        !idSet.has(entry.refines.slice(1)) ||
        !entry.property
      )
        return false
    }
    return true
  })
}

export function assertOpfManifestLinks(
  caseId: string,
  opf: OpfSemantics,
  packageDocumentPath: string,
  publicationEntries: ReadonlySet<string>,
): void {
  assertClosed(caseId, 'manifest-links', () => {
    const ids = opf.manifest.map((item) => item.id)
    const hrefs = opf.manifest.map((item) => item.href)
    const mediaTypes = opf.manifest.map((item) => item.mediaType)
    if (
      !uniqueNonempty(ids) ||
      !uniqueNonempty(hrefs) ||
      mediaTypes.some((value) => !value)
    )
      return false
    const idSet = new Set(ids as string[])
    const resolvedEntries = new Set<string>()
    let navCount = 0
    for (const item of opf.manifest) {
      const resolution = resolvePackageReference(
        packageDocumentPath,
        item.href!,
      )
      if (
        resolution.kind !== 'internal' ||
        resolution.fragment !== null ||
        !publicationEntries.has(resolution.path) ||
        resolvedEntries.has(resolution.path)
      )
        return false
      resolvedEntries.add(resolution.path)
      if (item.properties.includes('nav')) {
        navCount += 1
        if (item.mediaType !== 'application/xhtml+xml') return false
      }
      if (item.fallback !== undefined && !idSet.has(item.fallback)) return false
      if (item.mediaOverlay !== undefined && !idSet.has(item.mediaOverlay))
        return false
    }
    return (
      navCount === 1 &&
      resolvedEntries.size === publicationEntries.size &&
      [...publicationEntries].every((entry) => resolvedEntries.has(entry))
    )
  })
}

export function assertOpfSpineLinks(
  caseId: string,
  opf: OpfSemantics,
): void {
  assertClosed(caseId, 'spine-links', () => {
    const manifest = new Map(
      opf.manifest
        .filter((item) => item.id !== undefined)
        .map((item) => [item.id!, item] as const),
    )
    const seen = new Set<string>()
    for (const item of opf.spine.items) {
      if (!item.idref || seen.has(item.idref)) return false
      seen.add(item.idref)
      const manifestItem = manifest.get(item.idref)
      if (
        manifestItem?.mediaType !== 'application/xhtml+xml' ||
        (item.linear !== undefined &&
          item.linear !== 'yes' &&
          item.linear !== 'no')
      )
        return false
    }
    if (opf.spine.items.length === 0) return false
    return opf.spine.toc === undefined || manifest.has(opf.spine.toc)
  })
}

export type ExpectedNavigationItem = {
  children: ExpectedNavigationItem[]
  href: string | null
  label: string
}

function sameNavigationItems(
  actual: readonly NavigationItem[],
  expected: readonly ExpectedNavigationItem[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((item, index) => {
      const expectedItem = expected[index]!
      return (
        item.href === expectedItem.href &&
        item.label === expectedItem.label &&
        sameNavigationItems(item.children, expectedItem.children)
      )
    })
  )
}

export function assertNavigationHierarchy(
  caseId: string,
  navigation: NavigationSemantics,
  expected: readonly ExpectedNavigationItem[],
): void {
  assertClosed(
    caseId,
    'navigation-hierarchy',
    () =>
      navigation.tocs.length === 1 &&
      sameNavigationItems(navigation.tocs[0]!.items, expected),
  )
}

function flattenNavigationItems(
  items: readonly NavigationItem[],
): NavigationItem[] {
  const flattened: NavigationItem[] = []
  const stack = [...items].reverse()
  while (stack.length > 0) {
    const item = stack.pop()!
    flattened.push(item)
    for (let index = item.children.length - 1; index >= 0; index -= 1)
      stack.push(item.children[index]!)
  }
  return flattened
}

export function assertNavigationTargets(
  caseId: string,
  navigation: NavigationSemantics,
  navigationDocumentPath: string,
  targetIdsByDocument: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  assertClosed(caseId, 'navigation-links', () => {
    if (navigation.tocs.length !== 1) return false
    for (const item of flattenNavigationItems(navigation.tocs[0]!.items)) {
      if (!item.href || xmlTextTokens(item.label).length === 0) return false
      const resolution = resolvePackageReference(
        navigationDocumentPath,
        item.href,
      )
      if (resolution.kind !== 'internal') return false
      const ids = targetIdsByDocument.get(resolution.path)
      if (!ids) return false
      if (resolution.fragment !== null && !ids.has(resolution.fragment))
        return false
    }
    return true
  })
}

export function assertArchiveFirstEntry(
  caseId: string,
  archive: ZipArchiveInspection,
  expectedName: string,
  expectedMethod: number,
): void {
  assertClosed(caseId, 'archive-first-entry', () => {
    const first = archive.entries[0]
    return (
      first !== undefined &&
      first.order === 0 &&
      first.localHeaderOffset === 0 &&
      first.name === expectedName &&
      first.method === expectedMethod
    )
  })
}

export function assertArchiveCanonicalOrder(
  caseId: string,
  archive: ZipArchiveInspection,
  expectedNames: readonly string[],
): void {
  assertClosed(
    caseId,
    'archive-order',
    () =>
      archive.localOrderMatchesCentral &&
      sameStrings(
        archive.entries.map((entry) => entry.name),
        expectedNames,
      ),
  )
}

export function assertNoArchiveDuplicates(
  caseId: string,
  archive: ZipArchiveInspection,
): void {
  assertClosed(
    caseId,
    'archive-duplicates',
    () => archive.duplicateNames.length === 0,
  )
}

export function assertArchiveCompression(
  caseId: string,
  archive: ZipArchiveInspection,
  expectedMethods: ReadonlyMap<string, number>,
): void {
  assertClosed(caseId, 'archive-compression', () => {
    if (archive.entries.some((entry) => entry.method !== 0 && entry.method !== 8))
      return false
    const byName = new Map(archive.entries.map((entry) => [entry.name, entry]))
    return [...expectedMethods].every(
      ([name, method]) => byName.get(name)?.method === method,
    )
  })
}

export function assertArchiveTimestamps(
  caseId: string,
  archive: ZipArchiveInspection,
  expectedDosDate: number,
  expectedDosTime: number,
): void {
  assertClosed(caseId, 'archive-timestamps', () =>
    archive.entries.every(
      (entry) =>
        entry.dosDate === expectedDosDate && entry.dosTime === expectedDosTime,
    ),
  )
}
