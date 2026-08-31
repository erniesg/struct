import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { StructBlock, StructDocument } from '../../src/document/index'
import {
  buildSealedSyntheticFixture,
  listSyntheticFixtureCases,
} from './fixture-builder'
import {
  buildSyntheticGoldenArtifacts,
  readSyntheticGoldenArtifacts,
  reopenedSyntheticText,
  serializeSyntheticGoldenArtifacts,
  writeSyntheticGoldenArtifacts,
  type SerializableSyntheticGoldenArtifacts,
  type SyntheticGoldenArtifacts,
} from './golden-artifacts'
import {
  assertAccessibilityLinks,
  assertArchiveCanonicalOrder,
  assertArchiveCompression,
  assertArchiveFirstEntry,
  assertArchiveTimestamps,
  assertNavigationHierarchy,
  assertNavigationTargets,
  assertNoArchiveDuplicates,
  assertNoHiddenSemanticTextDuplicates,
  assertOpfManifestLinks,
  assertOpfMetadataLinks,
  assertOpfSpineLinks,
  assertSemanticLinks,
  assertTableLinks,
  type ExpectedNavigationItem,
} from './helpers/assertions'
import {
  inspectNavigation,
  inspectOpf,
  inspectXhtml,
  parseXmlDocument,
} from './helpers/xml'
import { createArchiveManifest } from './helpers/archive'

const WORKER_AUTHORIZATION = 'verify-layout-goldens-v1'
const workerMode = process.env.STRUCT_LAYOUT_GOLDEN_WORKER_MODE
const workerAuthorization = process.env.STRUCT_LAYOUT_GOLDEN_WORKER_AUTH
const workerCaseId = process.env.STRUCT_LAYOUT_GOLDEN_CASE_ID
const workerOutputPath = process.env.STRUCT_LAYOUT_GOLDEN_OUTPUT_PATH
const testPath = fileURLToPath(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const verifierScript = fileURLToPath(
  new URL('../../scripts/verify-layout-goldens.mjs', import.meta.url),
)
const vitestPath = fileURLToPath(
  new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')),
)
const renderCases = listSyntheticFixtureCases().filter(
  ({ expectedDisposition }) => expectedDisposition === 'render',
)

function reproducibilityFailure(caseId: string, code: string): never {
  throw new Error(`${caseId}:reproducibility-${code}`)
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

function assertSame(
  caseId: string,
  code: string,
  left: unknown,
  right: unknown,
): void {
  if (canonical(left) !== canonical(right))
    reproducibilityFailure(caseId, code)
}

function assertSameBytes(
  caseId: string,
  left: Uint8Array,
  right: Uint8Array,
): void {
  if (
    left.byteLength !== right.byteLength ||
    left.some((value, index) => value !== right[index])
  )
    reproducibilityFailure(caseId, 'epub-bytes')
}

function expectedArchiveOrder(document: StructDocument): string[] {
  return [
    'mimetype',
    'META-INF/container.xml',
    'EPUB/package.opf',
    'EPUB/nav.xhtml',
    'EPUB/content.xhtml',
    'EPUB/styles.css',
    'EPUB/struct.json',
    ...document.assets.map(({ href }) => `EPUB/${href}`),
  ]
}

type ExpectedNavigationStackItem = ExpectedNavigationItem & { level: number }

function independentNavigationPlan(
  blocks: readonly StructBlock[],
): ExpectedNavigationItem[] {
  const roots: ExpectedNavigationStackItem[] = []
  const stack: ExpectedNavigationStackItem[] = []
  for (const block of blocks) {
    if (block.kind !== 'heading') continue
    const item: ExpectedNavigationStackItem = {
      children: [],
      href: `content.xhtml#${block.id}`,
      label: block.text,
      level: Number(block.attributes?.level ?? 2),
    }
    while (stack.length > 0 && stack.at(-1)!.level >= item.level) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(item)
    else roots.push(item)
    stack.push(item)
  }
  return roots
}

function assertCanonicalPublication(
  caseId: string,
  artifacts: SyntheticGoldenArtifacts,
): void {
  const order = expectedArchiveOrder(artifacts.document)
  const content = inspectXhtml(artifacts.files['content.xhtml'])
  const navigation = inspectNavigation(artifacts.files['nav.xhtml'])
  const opf = inspectOpf(artifacts.files['package.opf'])
  const container = parseXmlDocument(artifacts.files['container.xml'])
  const archive = JSON.parse(artifacts.files['archive.json']) as {
    entries?: unknown
    epubSha256?: unknown
  }

  if (
    container.root.localName !== 'container' ||
    container.root.namespaceUri !==
      'urn:oasis:names:tc:opendocument:xmlns:container'
  )
    reproducibilityFailure(caseId, 'container')
  assertSame(caseId, 'archive-json-keys', Object.keys(archive), [
    'epubSha256',
    'entries',
  ])
  const epubSha256 = createHash('sha256')
    .update(artifacts.archiveBytes)
    .digest('hex')
  assertSame(
    caseId,
    'archive-json',
    archive,
    { epubSha256, ...createArchiveManifest(artifacts.archiveBytes) },
  )
  if (
    artifacts.files['archive.json'] !==
    `${JSON.stringify(archive, null, 2)}\n`
  )
    reproducibilityFailure(caseId, 'archive-json-format')

  assertAccessibilityLinks(caseId, content)
  assertNoHiddenSemanticTextDuplicates(caseId, content)
  assertSemanticLinks(caseId, content)
  assertTableLinks(caseId, content)
  assertOpfMetadataLinks(caseId, opf)
  assertOpfManifestLinks(
    caseId,
    opf,
    'EPUB/package.opf',
    new Set(
      order.filter(
        (entry) => entry.startsWith('EPUB/') && entry !== 'EPUB/package.opf',
      ),
    ),
  )
  assertOpfSpineLinks(caseId, opf)
  assertNavigationHierarchy(
    caseId,
    navigation,
    independentNavigationPlan(artifacts.document.blocks),
  )
  assertNavigationTargets(
    caseId,
    navigation,
    'EPUB/nav.xhtml',
    new Map([['EPUB/content.xhtml', new Set(content.ids)]]),
  )
  assertArchiveFirstEntry(caseId, artifacts.archiveInspection, 'mimetype', 0)
  assertArchiveCanonicalOrder(caseId, artifacts.archiveInspection, order)
  assertNoArchiveDuplicates(caseId, artifacts.archiveInspection)
  assertArchiveCompression(
    caseId,
    artifacts.archiveInspection,
    new Map([['mimetype', 0]]),
  )
  assertArchiveTimestamps(caseId, artifacts.archiveInspection, 33, 0)

  for (const entry of [
    'container.xml',
    'content.xhtml',
    'nav.xhtml',
    'package.opf',
    'styles.css',
  ] as const)
    if (reopenedSyntheticText(artifacts, entry) !== artifacts.files[entry])
      reproducibilityFailure(caseId, 'entry-text')
}

async function checkedFreshOutputPath(path: string): Promise<string> {
  if (basename(path) !== 'fresh-process.json')
    reproducibilityFailure('synthetic-worker', 'output-path')
  const [temporaryRoot, outputParent] = await Promise.all([
    realpath(tmpdir()),
    realpath(dirname(resolve(path))),
  ])
  const child = relative(temporaryRoot, outputParent)
  if (!child || child.startsWith('..') || isAbsolute(child))
    reproducibilityFailure('synthetic-worker', 'output-path')
  return join(outputParent, 'fresh-process.json')
}

async function writeFreshProcessResult(path: string): Promise<void> {
  const checkedPath = await checkedFreshOutputPath(path)
  const records: SerializableSyntheticGoldenArtifacts[] = []
  for (const { caseId } of renderCases) {
    const artifacts = await buildSyntheticGoldenArtifacts(caseId)
    records.push(serializeSyntheticGoldenArtifacts(caseId, artifacts))
  }
  const handle = await open(
    checkedPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(JSON.stringify(records), 'utf8')
  } finally {
    await handle.close()
  }
}

async function freshProcessRecords(): Promise<
  Map<string, SerializableSyntheticGoldenArtifacts>
> {
  const directory = await mkdtemp(join(tmpdir(), 'struct-layout-repro-'))
  const outputPath = join(directory, 'fresh-process.json')
  try {
    const environment = { ...process.env }
    delete environment.STRUCT_LAYOUT_GOLDEN_CASE_ID
    environment.STRUCT_LAYOUT_GOLDEN_WORKER_AUTH = WORKER_AUTHORIZATION
    environment.STRUCT_LAYOUT_GOLDEN_WORKER_MODE = 'fresh'
    environment.STRUCT_LAYOUT_GOLDEN_OUTPUT_PATH = outputPath
    const result = spawnSync(
      process.execPath,
      [vitestPath, 'run', testPath, '--maxWorkers=1', '--reporter=dot'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      },
    )
    if (result.status !== 0)
      reproducibilityFailure('synthetic-worker', 'fresh-process')
    const value = JSON.parse(await readFile(outputPath, 'utf8')) as unknown
    if (!Array.isArray(value) || value.length !== renderCases.length)
      reproducibilityFailure('synthetic-worker', 'fresh-result')
    const records = new Map<string, SerializableSyntheticGoldenArtifacts>()
    for (const candidate of value) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        !('caseId' in candidate) ||
        typeof candidate.caseId !== 'string' ||
        records.has(candidate.caseId)
      )
        reproducibilityFailure('synthetic-worker', 'fresh-result')
      records.set(
        candidate.caseId,
        candidate as SerializableSyntheticGoldenArtifacts,
      )
    }
    return records
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

function runInvalidVerifier(
  arguments_: readonly string[],
  expectedCode: string,
): void {
  const result = spawnSync(process.execPath, [verifierScript, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
  })
  expect(result.status).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`layout-goldens:${expectedCode}\n`)
}

if (workerMode === 'fresh') {
  describe('fresh-process synthetic golden worker', () => {
    it(
      'builds every declared render case in one isolated process',
      async () => {
        if (
          workerAuthorization !== WORKER_AUTHORIZATION ||
          !workerOutputPath ||
          workerCaseId !== undefined
        )
          reproducibilityFailure('synthetic-worker', 'authorization')
        await writeFreshProcessResult(workerOutputPath)
      },
      30_000,
    )
  })
} else if (workerMode === 'update') {
  describe('single-case synthetic golden writer', () => {
    it('writes only the explicitly selected declared case', async () => {
      if (
        workerAuthorization !== WORKER_AUTHORIZATION ||
        !workerCaseId ||
        workerOutputPath !== undefined
      )
        reproducibilityFailure('synthetic-worker', 'authorization')
      await writeSyntheticGoldenArtifacts(workerCaseId)
    })
  })
} else if (workerMode !== undefined) {
  describe('synthetic golden worker authorization', () => {
    it('rejects an unknown worker mode', () => {
      reproducibilityFailure('synthetic-worker', 'authorization')
    })
  })
} else {
  let retainedFreshRecords:
    | Promise<Map<string, SerializableSyntheticGoldenArtifacts>>
    | undefined
  const freshRecords = () =>
    (retainedFreshRecords ??= freshProcessRecords())

  describe('source-neutral golden reproducibility', () => {
    it.each(renderCases)(
      'pins exact synthetic output for $caseId',
      async ({ caseId }) => {
        const document = buildSealedSyntheticFixture(caseId)
        const before = structuredClone(document)
        const builds: SyntheticGoldenArtifacts[] = []
        for (let run = 0; run < 3; run += 1)
          builds.push(await buildSyntheticGoldenArtifacts(caseId, document))

        if (!isDeepStrictEqual(document, before))
          reproducibilityFailure(caseId, 'input-mutation')
        for (const build of builds.slice(1)) {
          assertSameBytes(caseId, builds[0]!.archiveBytes, build.archiveBytes)
          assertSame(
            caseId,
            'same-process',
            serializeSyntheticGoldenArtifacts(caseId, builds[0]!),
            serializeSyntheticGoldenArtifacts(caseId, build),
          )
        }

        assertSame(
          caseId,
          'golden-files',
          builds[0]!.files,
          await readSyntheticGoldenArtifacts(caseId),
        )
        const fresh = (await freshRecords()).get(caseId)
        if (!fresh) reproducibilityFailure(caseId, 'fresh-result')
        assertSame(
          caseId,
          'fresh-process',
          serializeSyntheticGoldenArtifacts(caseId, builds[0]!),
          fresh,
        )
        assertCanonicalPublication(caseId, builds[0]!)
      },
    )

    it('keeps update mode explicit, single-case, and path-free', () => {
      runInvalidVerifier(['--update'], 'invalid-arguments')
      runInvalidVerifier(['--root', 'invented'], 'invalid-arguments')
      runInvalidVerifier(
        ['--update', '--case', '../invented'],
        'invalid-case',
      )
      runInvalidVerifier(['--update', '--case', 'all'], 'unknown-case')
    })
  })
}
