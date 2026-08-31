import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  bcp47Language,
  mediaType,
  rfc3339Date,
  rfc3339DateTime,
} from '../document/codec/standards'
import {
  MAX_STRUCT_STRING_BYTES,
  stringValue,
} from '../document/codec/primitives'
import { structDigest } from '../identity'
import { sha256HexSync } from '../sha256'
import { verifyStructReceipt } from '../receipt'
import {
  isPackagedAssetId,
  MAX_RENDERED_INLINE_SEGMENTS,
} from './xhtml-plan'
import { renderPublicationXhtml } from './xhtml'
import {
  buildPublicationNavigationPlan,
  type PublicationNavigationItem,
} from './navigation-plan'
import type { StructDocument } from '../document/types'
import {
  isRendererIngressCodecError,
  normalizeStructDocumentForRenderer,
} from './ingress'

const EPUB_MIMETYPE = 'application/epub+zip' as const
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }`
const MAX_STRUCT_EPUB_ARCHIVE_BYTES = 256 * 1024 * 1024
const ZIP_ARCHIVE_OVERHEAD_RESERVE = 64 * 1024
const MAX_STRUCT_EPUB_XHTML_BYTES = MAX_STRUCT_STRING_BYTES
const MAX_STRUCT_EPUB_XHTML_DEPTH = 128
const MAX_STRUCT_EPUB_XHTML_ELEMENTS = MAX_RENDERED_INLINE_SEGMENTS
const PUBLICATION_SOURCE_FILE_NAME = 'source'
const PROFILE_KEYS = [
  'id',
  'version',
  'fileName',
  'pageProgressionDirection',
  'renditionFlow',
  'configurationSha256',
  'css',
] as const
const PROFILE_KEY_SET = new Set<string>(PROFILE_KEYS)

/** Reject post-compression archives that exceed the package resource ceiling. */
export function assertStructEpubArchiveByteLength(
  bytes: Uint8Array,
  maximumBytes = MAX_STRUCT_EPUB_ARCHIVE_BYTES,
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    bytes.byteLength > maximumBytes
  )
    throw new Error('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
}

export type StructEpubProfile = {
  id: string
  version: string
  fileName: string
  pageProgressionDirection: 'ltr' | 'rtl'
  renditionFlow: 'paginated' | 'scrolled-continuous'
  configurationSha256: string
  css: string
}

export type StructEpubOptions = {
  profile?: StructEpubProfile
}

export type StructEpubExport = {
  bytes: Uint8Array
  fileName: string
  mediaType: typeof EPUB_MIMETYPE
  sha256: string
  identifier: string
  entries: string[]
  mode: 'publication'
  profile?: ReturnType<typeof profileReceipt>
}

export type UnprofiledStructEpubExport = Omit<StructEpubExport, 'profile'>

type StructEpubProfileSnapshot = Record<keyof StructEpubProfile, unknown>

function snapshotProfile(
  value: unknown,
): StructEpubProfileSnapshot | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== PROFILE_KEYS.length ||
      keys.some(
        (key) => typeof key !== 'string' || !PROFILE_KEY_SET.has(key),
      )
    )
      return undefined
    const snapshot = Object.create(null) as StructEpubProfileSnapshot
    for (const key of PROFILE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        return undefined
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return undefined
  }
}

function validProfileCss(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return stringValue(value, '$.options.profile.css') === value
  } catch {
    return false
  }
}

function validProfile(
  profile: StructEpubProfileSnapshot,
): profile is StructEpubProfile {
  return (
    typeof profile.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile.id) &&
    typeof profile.version === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile.version) &&
    typeof profile.fileName === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.epub$/u.test(profile.fileName) &&
    (profile.pageProgressionDirection === 'ltr' ||
      profile.pageProgressionDirection === 'rtl') &&
    (profile.renditionFlow === 'paginated' ||
      profile.renditionFlow === 'scrolled-continuous') &&
    typeof profile.configurationSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(profile.configurationSha256) &&
    validProfileCss(profile.css)
  )
}

function profileReceipt(profile: StructEpubProfile) {
  return {
    schemaVersion: '1.0.0' as const,
    id: profile.id,
    version: profile.version,
    fileName: profile.fileName,
    pageProgressionDirection: profile.pageProgressionDirection,
    renditionFlow: profile.renditionFlow,
    configurationSha256: profile.configurationSha256,
    cssSha256: sha256HexSync(profile.css),
  }
}

function snapshotEpubProfileOption(value: unknown): StructEpubProfile | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error()
    const keys = Reflect.ownKeys(value)
    if (
      keys.some((key) => typeof key !== 'string' || key !== 'profile') ||
      keys.length > 1
    )
      throw new Error()
    if (keys.length === 0) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, 'profile')
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new Error()
    if (descriptor.value === undefined) return undefined
    const snapshot = snapshotProfile(descriptor.value)
    if (!snapshot || !validProfile(snapshot))
      throw new Error('STRUCT_EPUB_PROFILE_INVALID')
    return snapshot
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'STRUCT_EPUB_PROFILE_INVALID'
    )
      throw error
    throw new Error('STRUCT_EPUB_OPTIONS_INVALID')
  }
}

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;')
}

function renderNavigationItems(
  items: readonly PublicationNavigationItem[],
): string {
  return items
    .map(
      (item) =>
        `<li><a href="content.xhtml#${attribute(item.id)}">${text(item.label)}</a>${item.children.length > 0 ? `<ol>${renderNavigationItems(item.children)}</ol>` : ''}</li>`,
    )
    .join('')
}

function entry(value: string, level: 0 | 6 = 6): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

function binaryEntry(value: Uint8Array): [Uint8Array, ZipOptions] {
  return [value, { level: 6, mtime: ZIP_MTIME }]
}

function utf8ByteLength(value: string) {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!
    if (codePoint <= 0x7f) length += 1
    else if (codePoint <= 0x7ff) length += 2
    else if (codePoint <= 0xffff) length += 3
    else {
      length += 4
      index += 1
    }
  }
  return length
}

function publicationDigest(document: StructDocument) {
  const { receipt, source, ...withoutReceiptAndSource } = document
  return structDigest({
    ...withoutReceiptAndSource,
    source: { ...source, fileName: PUBLICATION_SOURCE_FILE_NAME },
    conservation: receipt.conservation,
    ...(receipt.modelConsultations
      ? { modelConsultations: receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
}

function canonicalModifiedTime(document: StructDocument) {
  if (document.metadata.artifactModifiedAt !== undefined)
    return new Date(document.metadata.artifactModifiedAt)
      .toISOString()
      .replace(/\.\d{3}Z$/u, 'Z')
  return `${document.metadata.updated ?? '1970-01-01'}T00:00:00Z`
}

function assertBuilderScalars(document: StructDocument) {
  const { language, publicationDate, artifactModifiedAt, updated } =
    document.metadata
  if (language !== undefined) bcp47Language(language, '$.metadata.language')
  if (publicationDate !== undefined)
    rfc3339Date(publicationDate, '$.metadata.publicationDate')
  if (updated !== undefined) rfc3339Date(updated, '$.metadata.updated')
  if (artifactModifiedAt !== undefined)
    rfc3339DateTime(artifactModifiedAt, '$.metadata.artifactModifiedAt')
  for (const asset of document.assets) {
    mediaType(asset.mediaType, '$.assets.mediaType')
    if (asset.href.includes('%'))
      throw new Error('STRUCT_EPUB_ASSET_HREF_INVALID')
  }
}

function assertNoNegativeZero(value: unknown, seen = new WeakSet<object>()) {
  if (typeof value === 'number') {
    if (Object.is(value, -0))
      throw new Error('STRUCT EPUB input contains negative zero')
    return
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ArrayBuffer.isView(value) ||
    seen.has(value)
  )
    return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw new Error('STRUCT EPUB input must contain data properties')
    assertNoNegativeZero(descriptor.value, seen)
  }
}

function assertNoSemanticZeroWidthRuns(document: StructDocument) {
  for (const block of document.blocks) {
    for (const runs of [
      block.inline,
      ...(block.table?.cells.map((cell) => cell.inline) ?? []),
    ])
      for (const run of runs)
        if (
          run.start === run.end &&
          Object.keys(run).some((key) => key !== 'start' && key !== 'end')
        )
          throw new Error(
            'STRUCT EPUB input contains a semantic zero-width inline run',
          )
  }
}

function slug(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'publication'
  )
}

function xmlMarkupEnd(value: string, start: number) {
  let quote: '"' | "'" | undefined
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '>') return index
  }
  return -1
}

function assertXhtmlLexicalBounds(value: string) {
  let cursor = 0
  let depth = 0
  let elements = 0
  while (cursor < value.length) {
    const opening = value.indexOf('<', cursor)
    if (opening === -1) break
    if (value.startsWith('<!--', opening)) {
      const closing = value.indexOf('-->', opening + 4)
      if (closing === -1) throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
      cursor = closing + 3
      continue
    }
    if (value.startsWith('<![CDATA[', opening)) {
      const closing = value.indexOf(']]>', opening + 9)
      if (closing === -1) throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
      cursor = closing + 3
      continue
    }
    if (value.startsWith('<?', opening)) {
      const closing = value.indexOf('?>', opening + 2)
      if (closing === -1) throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
      if (
        opening !== 0 ||
        value.slice(opening, closing + 2) !==
          '<?xml version="1.0" encoding="UTF-8"?>'
      )
        throw new Error('STRUCT_EPUB_XHTML_FORBIDDEN_DECLARATION')
      cursor = closing + 2
      continue
    }
    const closing = xmlMarkupEnd(value, opening + 1)
    if (closing === -1) throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
    const markup = value.slice(opening, closing + 1)
    if (/^<!DOCTYPE\b/iu.test(markup)) {
      if (!/^<!DOCTYPE\s+html\s*>$/iu.test(markup))
        throw new Error('STRUCT_EPUB_XHTML_FORBIDDEN_DECLARATION')
      cursor = closing + 1
      continue
    }
    if (markup.startsWith('<!'))
      throw new Error('STRUCT_EPUB_XHTML_FORBIDDEN_DECLARATION')
    if (/^<\//u.test(markup)) {
      depth -= 1
      if (depth < 0) throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
    } else {
      elements += 1
      if (elements > MAX_STRUCT_EPUB_XHTML_ELEMENTS)
        throw new Error('STRUCT_EPUB_XHTML_RESOURCE_LIMIT')
      if (!/\/\s*>$/u.test(markup)) {
        depth += 1
        if (depth > MAX_STRUCT_EPUB_XHTML_DEPTH)
          throw new Error('STRUCT_EPUB_XHTML_RESOURCE_LIMIT')
      }
    }
    cursor = closing + 1
  }
}

function assertXhtmlDocumentSyntax(value: string, maximumBytes?: number) {
  if (
    maximumBytes !== undefined &&
    utf8ByteLength(value) > maximumBytes
  )
    throw new Error('STRUCT_EPUB_XHTML_RESOURCE_LIMIT')
  assertXhtmlLexicalBounds(value)
  if (XMLValidator.validate(value) !== true)
    throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
  const ids = xhtmlAttributeValues(value, 'id')
  if (new Set(ids).size !== ids.length)
    throw new Error('STRUCT_EPUB_XHTML_DUPLICATE_IDS')
}

function decodePackagedXhtml(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_STRUCT_EPUB_XHTML_BYTES)
    throw new Error('STRUCT_EPUB_XHTML_RESOURCE_LIMIT')
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
  }
  assertXhtmlDocumentSyntax(value, MAX_STRUCT_EPUB_XHTML_BYTES)
  return value
}

function xhtmlAttributeValues(value: string, name: string) {
  const values: string[] = []
  let parsed: unknown
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      maxNestedTags: MAX_STRUCT_EPUB_XHTML_DEPTH,
    }).parse(value)
  } catch {
    throw new Error('STRUCT_EPUB_XHTML_NOT_WELL_FORMED')
  }
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      const attributeName = key.startsWith('@_') ? key.slice(2) : null
      if (attributeName === name || attributeName?.endsWith(`:${name}`)) {
        values.push(String(child))
      } else if (!key.startsWith('@_')) visit(child)
    }
  }
  visit(parsed)
  return values
}

function resolvedPackageHref(currentDocument: string, reference: string) {
  if (
    !reference ||
    reference.startsWith('/') ||
    reference.includes('\\') ||
    reference.includes('?') ||
    /[\u0000-\u001f\u007f]/u.test(reference)
  ) {
    return null
  }
  const base = currentDocument.split('/')
  base.pop()
  const resolved: string[] = []
  for (const segment of [...base, ...reference.split('/')]) {
    if (segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}

function assertXhtmlHrefIntegrity(
  documents: ReadonlyMap<string, string>,
  packagedHrefs: ReadonlySet<string>,
) {
  const idsByDocument = new Map(
    [...documents].map(([href, value]) => {
      assertXhtmlDocumentSyntax(value)
      const ids = xhtmlAttributeValues(value, 'id')
      return [href, new Set(ids)]
    }),
  )
  for (const [documentHref, value] of documents) {
    const references = [
      ...xhtmlAttributeValues(value, 'href'),
      ...xhtmlAttributeValues(value, 'src'),
    ]
    for (const href of references) {
      if (
        href !== href.trim() ||
        href.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(href)
      ) {
        throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
      }
      const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]
      if (scheme) {
        if (!['http', 'https', 'mailto'].includes(scheme.toLowerCase())) {
          throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
        }
        let url: URL
        try {
          url = new URL(href)
        } catch {
          throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
        }
        if (url.username || url.password || url.href !== href)
          throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
        continue
      }
      if (/[?%\p{White_Space}]/u.test(href))
        throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
      if (href.startsWith('//') || href.startsWith('/')) {
        throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
      }
      const hashIndex = href.indexOf('#')
      const documentReference =
        hashIndex === -1 ? href : href.slice(0, hashIndex)
      const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1)
      const targetDocument = documentReference
        ? resolvedPackageHref(documentHref, documentReference)
        : documentHref
      if (!targetDocument) {
        throw new Error('STRUCT_EPUB_XHTML_UNSAFE_HREF')
      }
      if (!packagedHrefs.has(targetDocument)) {
        throw new Error('STRUCT_EPUB_XHTML_DANGLING_INTERNAL_REFERENCE')
      }
      if (
        fragment !== null &&
        (!fragment || !idsByDocument.get(targetDocument)?.has(fragment))
      ) {
        throw new Error('STRUCT_EPUB_XHTML_DANGLING_INTERNAL_REFERENCE')
      }
    }
  }
}

/** Assemble a deterministic EPUB using only the canonical STRUCT contract. */
export function buildStructEpub(
  document: StructDocument,
): Promise<UnprofiledStructEpubExport>
export function buildStructEpub(
  document: StructDocument,
  options: StructEpubOptions,
): Promise<StructEpubExport>
export async function buildStructEpub(
  document: StructDocument,
  options: StructEpubOptions = {},
): Promise<StructEpubExport> {
  const profile = snapshotEpubProfileOption(options)
  try {
    document = normalizeStructDocumentForRenderer(document)
  } catch (error) {
    if (
      isRendererIngressCodecError(error) &&
      ((error.code === 'BUDGET' && error.path === '$.assets') ||
        error.code === 'ASSET_BOUNDS' ||
        (error.path.startsWith('$.assets[') &&
          error.path.endsWith('.bytes') &&
          (error.code === 'BYTES' || error.code === 'TYPE')))
    )
      throw new Error('STRUCT_EPUB_ASSET_RESOURCE_LIMIT', { cause: error })
    if (
      isRendererIngressCodecError(error) &&
      error.path.startsWith('$.receipt.modelConsultations')
    )
      throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT', { cause: error })
    if (
      isRendererIngressCodecError(error) &&
      (error.code === 'SCHEMA_VERSION' ||
        error.code === 'MIGRATION' ||
        error.code === 'BINDING' ||
        error.path === '$.documentId' ||
        error.path === '$.receipt.documentId')
    )
      throw new Error('STRUCT_RECEIPT_BINDING_MISMATCH', { cause: error })
    if (isRendererIngressCodecError(error) && error.code === 'DIGEST')
      throw new Error('STRUCT_RECEIPT_DIGEST_MISMATCH', { cause: error })
    if (isRendererIngressCodecError(error) && error.code === 'REFERENCE')
      throw new Error('STRUCT_EPUB_DANGLING_INTERNAL_REFERENCE', {
        cause: error,
      })
    if (isRendererIngressCodecError(error) && error.code === 'URL')
      throw new Error('STRUCT_EPUB_UNSAFE_HREF', { cause: error })
    throw error
  }
  assertBuilderScalars(document)
  assertNoSemanticZeroWidthRuns(document)
  if (!verifyStructReceipt(document))
    throw new Error('STRUCT_RECEIPT_BINDING_MISMATCH')
  if (document.recovery.status !== 'ready')
    throw new Error('STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED')
  assertNoNegativeZero(document)
  const documentDirection =
    document.metadata.baseDirection === 'ltr' ||
    document.metadata.baseDirection === 'rtl'
      ? document.metadata.baseDirection
      : undefined
  if (
    profile &&
    documentDirection &&
    profile.pageProgressionDirection !== documentDirection
  )
    throw new Error('STRUCT_EPUB_PROFILE_DIRECTION_MISMATCH')
  const retainedProfile = profile ? profileReceipt(profile) : undefined
  const publicationSha256 = publicationDigest(document)
  const identifier = `urn:sha256:${publicationSha256}${retainedProfile ? `:${retainedProfile.id}:${retainedProfile.version}:${retainedProfile.configurationSha256.slice(0, 16)}` : ''}`
  const language = document.metadata.language ?? 'und'
  const modified = canonicalModifiedTime(document)
  const assets = document.assets.map((asset) => {
    if (!asset.bytes) {
      throw new Error('STRUCT_EPUB_ASSET_BYTES_MISSING')
    }
    return asset as typeof asset & { bytes: Uint8Array }
  })
  const assetBytes = assets.reduce(
    (total, asset) => total + asset.bytes.byteLength,
    0,
  )
  const reservedHrefs = new Set([
    'package.opf',
    'nav.xhtml',
    'content.xhtml',
    'styles.css',
    'struct.json',
    'profile.json',
  ])
  const assetIds = new Set<string>()
  const assetHrefs = new Set<string>()
  for (const asset of assets) {
    if (assetIds.has(asset.id) || !isPackagedAssetId(asset.id)) {
      throw new Error('STRUCT_EPUB_ASSET_ID_INVALID')
    }
    if (
      reservedHrefs.has(asset.href) ||
      assetHrefs.has(asset.href) ||
      asset.href !== asset.href.trim() ||
      /[\s#:]/u.test(asset.href) ||
      resolvedPackageHref('content.xhtml', asset.href) !== asset.href
    ) {
      throw new Error('STRUCT_EPUB_ASSET_HREF_INVALID')
    }
    assetIds.add(asset.id)
    assetHrefs.add(asset.href)
  }
  const packagedXhtmlAssets = new Map<string, string>()
  for (const asset of assets)
    if (asset.mediaType.toLowerCase() === 'application/xhtml+xml')
      packagedXhtmlAssets.set(asset.href, decodePackagedXhtml(asset.bytes))
  const assetItems = assets
    .map(
      (asset) =>
        `<item id="${attribute(asset.id)}" href="${attribute(asset.href)}" media-type="${attribute(asset.mediaType)}" />`,
    )
    .join('\n    ')
  const metadataEntries = [
    `<dc:identifier id="publication-id">${text(identifier)}</dc:identifier>`,
    `<dc:title id="publication-title">${text(document.metadata.title)}</dc:title>`,
    '<meta refines="#publication-title" property="title-type">main</meta>',
    ...(document.metadata.subtitle.length > 0
      ? [
          `<dc:title id="publication-subtitle">${text(document.metadata.subtitle)}</dc:title>`,
          '<meta refines="#publication-subtitle" property="title-type">subtitle</meta>',
        ]
      : []),
    `<dc:language>${text(language)}</dc:language>`,
    ...document.metadata.authors.map(
      (author) => `<dc:creator>${text(author)}</dc:creator>`,
    ),
    ...(document.metadata.abstract.length > 0
      ? [`<dc:description>${text(document.metadata.abstract)}</dc:description>`]
      : []),
    ...(document.metadata.publicationDate === undefined
      ? []
      : [`<dc:date>${text(document.metadata.publicationDate)}</dc:date>`]),
    `<meta property="dcterms:modified">${text(modified)}</meta>`,
    ...(retainedProfile
      ? [
          `<meta property="rendition:flow">${retainedProfile.renditionFlow}</meta>`,
        ]
      : []),
  ].join('\n    ')
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${attribute(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metadataEntries}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="struct" href="struct.json" media-type="application/json" />
    ${retainedProfile ? '<item id="profile" href="profile.json" media-type="application/json" />' : ''}
    ${assetItems}
  </manifest>
  <spine${retainedProfile ? ` page-progression-direction="${retainedProfile.pageProgressionDirection}"` : documentDirection === 'rtl' ? ' page-progression-direction="rtl"' : ''}><itemref idref="content" /></spine>
</package>
`
  const navigationItems = buildPublicationNavigationPlan(document.blocks)
  const navigationDirection = documentDirection
    ? ` dir="${documentDirection}"`
    : ''
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}" lang="${attribute(language)}"${navigationDirection}><head><title>${text(document.metadata.title)}</title></head><body><nav epub:type="toc" aria-label="${attribute(document.metadata.title)}"><ol>${renderNavigationItems(navigationItems)}</ol></nav></body></html>
`
  const content = renderPublicationXhtml(document)
  const structArtifact = {
    schemaVersion: document.schemaVersion,
    source: {
      ...document.source,
      fileName: PUBLICATION_SOURCE_FILE_NAME,
    },
    receipt: {
      ...document.receipt,
      generatedSha256: publicationSha256,
    },
  }
  const serializedStructArtifact = `${JSON.stringify(structArtifact)}\n`
  const serializedProfile = retainedProfile
    ? `${JSON.stringify(retainedProfile)}\n`
    : undefined
  const container =
    '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>'
  if (
    XMLValidator.validate(container) !== true ||
    XMLValidator.validate(packageDocument) !== true
  )
    throw new Error('STRUCT_EPUB_PACKAGE_XML_INVALID')
  const archiveBytes =
    utf8ByteLength(EPUB_MIMETYPE) +
    utf8ByteLength(container) +
    utf8ByteLength(packageDocument) +
    utf8ByteLength(nav) +
    utf8ByteLength(content) +
    utf8ByteLength(profile?.css ?? EPUB_CSS) +
    utf8ByteLength(serializedStructArtifact) +
    (serializedProfile ? utf8ByteLength(serializedProfile) : 0) +
    assetBytes
  if (
    archiveBytes >
    MAX_STRUCT_EPUB_ARCHIVE_BYTES - ZIP_ARCHIVE_OVERHEAD_RESERVE
  )
    throw new Error('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(container),
    'EPUB/package.opf': entry(packageDocument),
    'EPUB/nav.xhtml': entry(nav),
    'EPUB/content.xhtml': entry(content),
    'EPUB/styles.css': entry(profile?.css ?? EPUB_CSS),
    'EPUB/struct.json': entry(serializedStructArtifact),
    ...(retainedProfile
      ? {
          'EPUB/profile.json': entry(serializedProfile!),
        }
      : {}),
    ...Object.fromEntries(
      assets.map((asset) => [`EPUB/${asset.href}`, binaryEntry(asset.bytes)]),
    ),
  }
  const xhtmlDocuments = new Map<string, string>([
    ['nav.xhtml', nav],
    ['content.xhtml', content],
    ...packagedXhtmlAssets,
  ])
  assertXhtmlHrefIntegrity(
    xhtmlDocuments,
    new Set(
      Object.keys(archive)
        .filter((href) => href.startsWith('EPUB/'))
        .map((href) => href.slice('EPUB/'.length)),
    ),
  )
  const bytes = zipSync(archive)
  assertStructEpubArchiveByteLength(bytes)
  if (retainedProfile) {
    const reopened = unzipSync(bytes)
    const reopenedProfile = reopened['EPUB/profile.json']
    const reopenedCss = reopened['EPUB/styles.css']
    if (
      !reopenedProfile ||
      !reopenedCss ||
      strFromU8(reopenedProfile) !== serializedProfile ||
      sha256HexSync(reopenedCss) !== retainedProfile.cssSha256
    ) {
      throw new Error('STRUCT_EPUB_PROFILE_REOPEN_MISMATCH')
    }
  }
  return {
    bytes,
    fileName:
      retainedProfile?.fileName ??
      `${slug(document.metadata.title)}-${publicationSha256.slice(0, 12)}.epub`,
    mediaType: EPUB_MIMETYPE,
    sha256: sha256HexSync(bytes),
    identifier,
    entries: Object.keys(archive),
    mode: 'publication' as const,
    ...(retainedProfile ? { profile: retainedProfile } : {}),
  }
}
