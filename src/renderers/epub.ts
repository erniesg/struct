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
import { sha256HexSync } from '../sha256'
import { verifyStructReceipt } from '../receipt'
import { isPackagedAssetId } from './xhtml-plan'
import { renderPublicationXhtml } from './xhtml'
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
const MAX_STRUCT_EPUB_PROFILE_CSS_BYTES = 4 * 1024 * 1024
const MAX_STRUCT_EPUB_ARCHIVE_BYTES = 256 * 1024 * 1024
const ZIP_ARCHIVE_OVERHEAD_RESERVE = 64 * 1024

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
    const record = value as Record<string, unknown>
    return {
      id: record.id,
      version: record.version,
      fileName: record.fileName,
      pageProgressionDirection: record.pageProgressionDirection,
      renditionFlow: record.renditionFlow,
      configurationSha256: record.configurationSha256,
      css: record.css,
    }
  } catch {
    return undefined
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
    typeof profile.css === 'string' &&
    profile.css.length > 0 &&
    utf8ByteLength(profile.css) <= MAX_STRUCT_EPUB_PROFILE_CSS_BYTES &&
    !/[\u0000]/u.test(profile.css)
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

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;')
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

function artifactFileName(value: string) {
  return value.split(/[\\/]/u).at(-1) || 'source'
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
      throw new Error(`STRUCT EPUB asset ${asset.id} has an ambiguous href`)
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

function xhtmlAttributeValues(value: string, name: string) {
  const values: string[] = []
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  }).parse(value)
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
      if (XMLValidator.validate(value) !== true) {
        throw new Error(`STRUCT EPUB ${href} is not well-formed XHTML`)
      }
      const ids = xhtmlAttributeValues(value, 'id')
      if (new Set(ids).size !== ids.length) {
        throw new Error(`STRUCT EPUB ${href} contains duplicate ids`)
      }
      return [href, new Set(ids)]
    }),
  )
  for (const [documentHref, value] of documents) {
    for (const href of xhtmlAttributeValues(value, 'href')) {
      if (
        href !== href.trim() ||
        href.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(href)
      ) {
        throw new Error(`STRUCT EPUB ${documentHref} has unsafe href ${href}`)
      }
      const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]
      if (scheme) {
        if (!['http', 'https', 'mailto'].includes(scheme.toLowerCase())) {
          throw new Error(
            `STRUCT EPUB ${documentHref} has unsafe href scheme in ${href}`,
          )
        }
        continue
      }
      if (href.startsWith('//') || href.startsWith('/')) {
        throw new Error(`STRUCT EPUB ${documentHref} has unsafe href ${href}`)
      }
      const hashIndex = href.indexOf('#')
      const documentReference =
        hashIndex === -1 ? href : href.slice(0, hashIndex)
      const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1)
      const targetDocument = documentReference
        ? resolvedPackageHref(documentHref, documentReference)
        : documentHref
      if (!targetDocument) {
        throw new Error(`STRUCT EPUB ${documentHref} has unsafe href ${href}`)
      }
      if (!packagedHrefs.has(targetDocument)) {
        throw new Error(
          `STRUCT EPUB ${documentHref} has dangling internal reference ${href}`,
        )
      }
      if (
        fragment !== null &&
        (!fragment || !idsByDocument.get(targetDocument)?.has(fragment))
      ) {
        throw new Error(
          `STRUCT EPUB ${documentHref} has dangling internal reference ${href}`,
        )
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
      throw new Error('STRUCT EPUB has a dangling internal reference', {
        cause: error,
      })
    if (isRendererIngressCodecError(error) && error.code === 'URL')
      throw new Error('STRUCT EPUB has an unsafe href', { cause: error })
    throw error
  }
  assertBuilderScalars(document)
  assertNoSemanticZeroWidthRuns(document)
  if (!verifyStructReceipt(document))
    throw new Error('STRUCT_RECEIPT_BINDING_MISMATCH')
  if (document.recovery.status !== 'ready')
    throw new Error('STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED')
  assertNoNegativeZero(document)
  const requestedProfile = options.profile
  let profile: StructEpubProfile | undefined
  if (requestedProfile !== undefined) {
    const snapshot = snapshotProfile(requestedProfile)
    if (!snapshot || !validProfile(snapshot)) {
      throw new Error('STRUCT_EPUB_PROFILE_INVALID')
    }
    profile = snapshot
  }
  const retainedProfile = profile ? profileReceipt(profile) : undefined
  const identifier = `urn:sha256:${document.receipt.generatedSha256}${retainedProfile ? `:${retainedProfile.id}:${retainedProfile.version}:${retainedProfile.configurationSha256.slice(0, 16)}` : ''}`
  const language = document.metadata.language ?? 'und'
  const modified = (
    document.metadata.artifactModifiedAt ??
    `${document.metadata.updated ?? '1970-01-01'}T00:00:00Z`
  ).replace(/\.\d{3}Z$/, 'Z')
  const assets = document.assets.map((asset) => {
    if (!asset.bytes) {
      throw new Error(`STRUCT asset ${asset.id} has no packaged bytes.`)
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
      throw new Error(
        `STRUCT EPUB asset id is duplicate or reserved: ${asset.id}`,
      )
    }
    if (
      reservedHrefs.has(asset.href) ||
      assetHrefs.has(asset.href) ||
      asset.href !== asset.href.trim() ||
      /[\s#:]/u.test(asset.href) ||
      resolvedPackageHref('content.xhtml', asset.href) !== asset.href
    ) {
      throw new Error(
        `STRUCT EPUB asset href is duplicate, reserved, or unsafe: ${asset.href}`,
      )
    }
    assetIds.add(asset.id)
    assetHrefs.add(asset.href)
  }
  const assetItems = assets
    .map(
      (asset) =>
        `<item id="${attribute(asset.id)}" href="${attribute(asset.href)}" media-type="${attribute(asset.mediaType)}" />`,
    )
    .join('\n    ')
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${attribute(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${identifier}</dc:identifier>
    <dc:title>${text(document.metadata.title)}</dc:title>
    <dc:language>${text(language)}</dc:language>
    ${document.metadata.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    <meta property="dcterms:modified">${text(modified)}</meta>
    ${retainedProfile ? `<meta property="rendition:flow">${retainedProfile.renditionFlow}</meta>` : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="struct" href="struct.json" media-type="application/json" />
    ${retainedProfile ? '<item id="profile" href="profile.json" media-type="application/json" />' : ''}
    ${assetItems}
  </manifest>
  <spine${retainedProfile ? ` page-progression-direction="${retainedProfile.pageProgressionDirection}"` : ''}><itemref idref="content" /></spine>
</package>
`
  const headings = document.blocks.filter((block) => block.kind === 'heading')
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="content.xhtml">${text(document.metadata.title)}</a></li>${headings.map((block) => `<li><a href="content.xhtml#${attribute(block.id)}">${text(block.text)}</a></li>`).join('')}</ol></nav></body></html>
`
  const content = renderPublicationXhtml(document)
  const structArtifact = {
    schemaVersion: document.schemaVersion,
    source: {
      ...document.source,
      fileName: artifactFileName(document.source.fileName),
    },
    receipt: document.receipt,
  }
  const serializedStructArtifact = `${JSON.stringify(structArtifact)}\n`
  const serializedProfile = retainedProfile
    ? `${JSON.stringify(retainedProfile)}\n`
    : undefined
  const container =
    '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>'
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
  ])
  for (const asset of assets) {
    if (asset.mediaType === 'application/xhtml+xml') {
      xhtmlDocuments.set(asset.href, strFromU8(asset.bytes))
    }
  }
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
      `${slug(document.metadata.title)}-${document.receipt.generatedSha256.slice(0, 12)}.epub`,
    mediaType: EPUB_MIMETYPE,
    sha256: sha256HexSync(bytes),
    identifier,
    entries: Object.keys(archive),
    mode: 'publication' as const,
    ...(retainedProfile ? { profile: retainedProfile } : {}),
  }
}
