import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import type { StructDocument } from '../../src/document/index'
import {
  buildStructEpub,
  type StructEpubExport,
} from '../../src/renderers/epub'
import { renderPublicationXhtml } from '../../src/renderers/xhtml'
import {
  buildSealedSyntheticFixture,
  listSyntheticFixtureCases,
  type SyntheticGoldenEntry,
} from './fixture-builder'
import {
  createArchiveManifest,
  inspectZipArchive,
  type SourceNeutralArchiveManifest,
  type ZipArchiveInspection,
} from './helpers/archive'

export const SYNTHETIC_GOLDEN_ROOT = fileURLToPath(
  new URL('../../evaluation/layout-epub-v2/goldens/', import.meta.url),
)

const goldenArchivePaths: Readonly<
  Record<Exclude<SyntheticGoldenEntry, 'archive.json'>, string>
> = Object.freeze({
  'container.xml': 'META-INF/container.xml',
  'content.xhtml': 'EPUB/content.xhtml',
  'nav.xhtml': 'EPUB/nav.xhtml',
  'package.opf': 'EPUB/package.opf',
  'styles.css': 'EPUB/styles.css',
})

type GoldenFiles = Record<SyntheticGoldenEntry, string>

export type SyntheticGoldenArchive = SourceNeutralArchiveManifest & {
  epubSha256: string
}

export type SyntheticGoldenArtifacts = {
  archiveBytes: Uint8Array
  archiveInspection: ZipArchiveInspection
  document: StructDocument
  epub: Omit<StructEpubExport, 'bytes'>
  files: GoldenFiles
}

export type SerializableSyntheticGoldenArtifacts = Omit<
  SyntheticGoldenArtifacts,
  'archiveBytes' | 'document'
> & {
  archiveBase64: string
  caseId: string
}

const syntheticCaseIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

function goldenFailure(caseId: string, code: string): never {
  const safeCaseId =
    syntheticCaseIdPattern.test(caseId) && caseId.length <= 128
      ? caseId
      : 'synthetic-case-invalid'
  throw new Error(`${safeCaseId}:golden-${code}`)
}

function renderDescriptor(caseId: string) {
  const descriptor = listSyntheticFixtureCases().find(
    (candidate) => candidate.caseId === caseId,
  )
  if (
    !descriptor ||
    descriptor.expectedDisposition !== 'render' ||
    descriptor.goldenEntries.length === 0
  )
    goldenFailure(caseId, 'case')
  return descriptor
}

function archiveText(
  caseId: string,
  reopened: Readonly<Record<string, Uint8Array>>,
  path: string,
): string {
  const value = reopened[path]
  if (!value) goldenFailure(caseId, 'entry')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    goldenFailure(caseId, 'text')
  }
}

function canonicalArchiveJson(
  archive: SyntheticGoldenArchive,
): string {
  return `${JSON.stringify(archive, null, 2)}\n`
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

export async function buildSyntheticGoldenArtifacts(
  caseId: string,
  input?: StructDocument,
): Promise<SyntheticGoldenArtifacts> {
  const descriptor = renderDescriptor(caseId)
  const document = input ?? buildSealedSyntheticFixture(caseId)
  const xhtml = renderPublicationXhtml(document)
  const built = await buildStructEpub(document)
  const archiveBytes = built.bytes
  const reopened = unzipSync(archiveBytes)
  const archiveInspection = inspectZipArchive(archiveBytes)
  const archiveManifest = createArchiveManifest(archiveBytes)
  const epubSha256 = createHash('sha256').update(archiveBytes).digest('hex')

  if (
    built.sha256 !== epubSha256 ||
    !sameStrings(
      built.entries,
      archiveManifest.entries.map(({ name }) => name),
    ) ||
    archiveText(caseId, reopened, goldenArchivePaths['content.xhtml']) !== xhtml
  )
    goldenFailure(caseId, 'render')

  const archive: SyntheticGoldenArchive = {
    epubSha256,
    entries: archiveManifest.entries,
  }
  const files = Object.fromEntries(
    descriptor.goldenEntries.map((entry) => [
      entry,
      entry === 'archive.json'
        ? canonicalArchiveJson(archive)
        : archiveText(caseId, reopened, goldenArchivePaths[entry]),
    ]),
  ) as GoldenFiles
  const { bytes: _bytes, ...epub } = built

  return {
    archiveBytes,
    archiveInspection,
    document,
    epub,
    files,
  }
}

export async function readSyntheticGoldenArtifacts(
  caseId: string,
): Promise<GoldenFiles> {
  const descriptor = renderDescriptor(caseId)
  const entries = await Promise.all(
    descriptor.goldenEntries.map(async (entry) => {
      try {
        return [entry, await readFile(join(SYNTHETIC_GOLDEN_ROOT, caseId, entry), 'utf8')]
      } catch {
        goldenFailure(caseId, 'missing')
      }
    }),
  )
  return Object.fromEntries(entries) as GoldenFiles
}

async function existingCaseEntries(caseId: string): Promise<string[]> {
  try {
    return await readdir(join(SYNTHETIC_GOLDEN_ROOT, caseId))
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return []
    goldenFailure(caseId, 'directory')
  }
}

async function writeExactText(path: string, value: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o644,
  )
  try {
    await handle.writeFile(value, 'utf8')
  } finally {
    await handle.close()
  }
}

export async function writeSyntheticGoldenArtifacts(
  caseId: string,
): Promise<void> {
  const descriptor = renderDescriptor(caseId)
  const current = await existingCaseEntries(caseId)
  if (
    current.some((entry) =>
      !descriptor.goldenEntries.includes(entry as SyntheticGoldenEntry),
    )
  )
    goldenFailure(caseId, 'undeclared')

  const artifacts = await buildSyntheticGoldenArtifacts(caseId)
  const directory = join(SYNTHETIC_GOLDEN_ROOT, caseId)
  await mkdir(directory, { recursive: true })
  for (const entry of descriptor.goldenEntries)
    await writeExactText(join(directory, entry), artifacts.files[entry])
}

export function serializeSyntheticGoldenArtifacts(
  caseId: string,
  artifacts: SyntheticGoldenArtifacts,
): SerializableSyntheticGoldenArtifacts {
  renderDescriptor(caseId)
  return {
    caseId,
    archiveBase64: Buffer.from(
      artifacts.archiveBytes.buffer,
      artifacts.archiveBytes.byteOffset,
      artifacts.archiveBytes.byteLength,
    ).toString('base64'),
    archiveInspection: artifacts.archiveInspection,
    epub: artifacts.epub,
    files: artifacts.files,
  }
}

export function reopenedSyntheticText(
  artifacts: SyntheticGoldenArtifacts,
  entry: Exclude<SyntheticGoldenEntry, 'archive.json'>,
): string {
  const reopened = unzipSync(artifacts.archiveBytes)
  return strFromU8(reopened[goldenArchivePaths[entry]]!)
}
