import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const EVALUATION_ROOT = 'evaluation/layout-epub-v2'
const FIXTURE_ROOT = `${EVALUATION_ROOT}/fixtures`
const GOLDEN_ROOT = `${EVALUATION_ROOT}/goldens`
const MANIFEST_PATH = `${FIXTURE_ROOT}/manifest.json`
const PROVENANCE_PATH = `${FIXTURE_ROOT}/provenance.json`
const REPOSITORY_LICENSE = 'MIT'
const MAX_EVALUATION_FILE_BYTES = 256 * 1024
const MAX_TRACKED_FILE_BYTES = 8 * 1024 * 1024
const MAX_GIT_LIST_BYTES = 8 * 1024 * 1024
const LONG_ENCODED_RUN = 2048
const LONG_HEX_RUN = 1024

const mediaExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jfif',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
])

const archiveExtensions = new Set([
  '.7z',
  '.bz2',
  '.cbz',
  '.docx',
  '.epub',
  '.gz',
  '.jar',
  '.odp',
  '.ods',
  '.odt',
  '.pptx',
  '.rar',
  '.tar',
  '.tgz',
  '.war',
  '.xlsx',
  '.xz',
  '.zip',
])

const reviewedGoldenEntries = new Set([
  'archive.json',
  'container.xml',
  'content.xhtml',
  'nav.xhtml',
  'package.opf',
  'profile.json',
  'styles.css',
])

const evaluationTopLevelFiles = new Set([
  'README.md',
  'aggregate-report.schema.json',
  'protocol.json',
])

const requiredCategories = new Set([
  'ambiguity',
  'assets',
  'bounds',
  'citations',
  'figures',
  'hierarchy',
  'malformed',
  'metadata',
  'multicolumn',
  'navigation',
  'notes',
  'paragraph',
  'rtl',
  'tables',
])

const expectedDispositions = new Set([
  'codec-rejection',
  'render',
  'renderer-rejection',
  'review-required-publication-refusal',
])
const regularFileModes = new Set(['100644', '100755'])

const mediaMagic = [
  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0xff, 0xd8, 0xff]),
]

const archiveMagic = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from([0x42, 0x5a, 0x68]),
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
]

const tarMagic = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72])
const manifestRootKeys = ['cases']
const manifestCaseKeys = [
  'caseId',
  'expectedDisposition',
  'goldenEntries',
  'provenanceKey',
  'requiredCategories',
]
const provenanceRootKeys = ['records']
const provenanceRecordKeys = [
  'authoredOn',
  'license',
  'origin',
  'provenanceKey',
]
const syntheticIdentifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const safeDisplayPathPattern = /^[A-Za-z0-9._/ -]{1,240}$/u
const absolutePosixHomePattern =
  /(?:^|[\s"'`=(:,])\/(?:home|Users)\/[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?/mu
const absolutePosixWorkspacePattern =
  /(?:^|[\s"'`=(:,])\/(?:root|workspaces?)(?:\/[^\s"'`<>]*)?/mu
const absoluteMountedHomePattern =
  /(?:^|[\s"'`=(:,])\/mnt\/[A-Za-z]\/Users\/[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?/mu
const absoluteWindowsHomePattern =
  /(?:^|[\s"'`=(:,])(?:[A-Za-z]:[\\/])(?:Users|workspaces?)[\\/][^\s"'`<>]*/mu
const dataUriPayloadPattern = new RegExp(
  'data:[A-Za-z0-9.+-]{1,64}' +
    '(?:/[A-Za-z0-9.+-]{1,64})?' +
    '(?:;[A-Za-z0-9.+-]{1,32}){0,8}' +
    ';base64,[A-Za-z0-9+/_-]{64,}={0,2}',
  'iu',
)
const longEncodedPayloadPattern = new RegExp(
  `(?:^|[^A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{${LONG_ENCODED_RUN},}` +
    '={0,2}(?:$|[^A-Za-z0-9+/_=-])',
  'u',
)
const longHexPayloadPattern = new RegExp(
  `(?:^|[^A-Fa-f0-9])[A-Fa-f0-9]{${LONG_HEX_RUN},}(?:$|[^A-Fa-f0-9])`,
  'u',
)
const forbiddenTextControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

class ViolationCollector {
  #violations = new Map()

  add(policy, repositoryPath) {
    const displayPath = safeDisplayPath(repositoryPath)
    this.#violations.set(`${policy}\u0000${displayPath}`, {
      policy,
      path: displayPath,
    })
  }

  sorted() {
    return [...this.#violations.values()].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.policy.localeCompare(right.policy),
    )
  }
}

function safeDisplayPath(repositoryPath) {
  return safeDisplayPathPattern.test(repositoryPath) &&
    !repositoryPath.split('/').some((segment) => segment === '..')
    ? repositoryPath
    : '<redacted-relative-path>'
}

function git(root, args, maxBuffer = MAX_GIT_LIST_BYTES) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function splitNul(buffer) {
  const values = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    if (index > start) values.push(buffer.subarray(start, index).toString('utf8'))
    start = index + 1
  }
  if (start < buffer.length) values.push(buffer.subarray(start).toString('utf8'))
  return values
}

function validRepositoryPath(root, repositoryPath) {
  if (
    repositoryPath.length === 0 ||
    repositoryPath.includes('\\') ||
    repositoryPath.includes('\u0000') ||
    isAbsolute(repositoryPath) ||
    repositoryPath.split('/').some((segment) => !segment || segment === '..')
  )
    return false
  const target = resolve(root, ...repositoryPath.split('/'))
  const fromRoot = relative(root, target)
  return (
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  )
}

function parseIndexEntries(root, collector) {
  const entries = new Map()
  const records = splitNul(git(root, ['ls-files', '--stage', '-z']))
  for (const record of records) {
    const tab = record.indexOf('\t')
    if (tab < 0) {
      collector.add('invalid-git-index', 'repository-index')
      continue
    }
    const [mode, objectId, stage] = record.slice(0, tab).split(' ')
    const repositoryPath = record.slice(tab + 1)
    if (!validRepositoryPath(root, repositoryPath)) {
      collector.add('unsafe-repository-path', repositoryPath)
      continue
    }
    if (stage !== '0') {
      collector.add('unmerged-index', repositoryPath)
      continue
    }
    if (mode === '120000') {
      collector.add('unsafe-symlink', repositoryPath)
      entries.set(repositoryPath, { bytes: null, size: 0 })
      continue
    }
    if (!regularFileModes.has(mode)) {
      collector.add('unsupported-index-entry', repositoryPath)
      entries.set(repositoryPath, { bytes: null, size: 0 })
      continue
    }
    if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
      collector.add('invalid-git-index', repositoryPath)
      continue
    }
    const sizeText = git(root, ['cat-file', '-s', objectId], 1024)
      .toString('ascii')
      .trim()
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0) {
      collector.add('invalid-git-index', repositoryPath)
      continue
    }
    if (size > MAX_TRACKED_FILE_BYTES) {
      collector.add('oversized-tracked-file', repositoryPath)
      entries.set(repositoryPath, { bytes: null, size })
      continue
    }
    const bytes = git(root, ['cat-file', 'blob', objectId], size + 1)
    entries.set(repositoryPath, { bytes, size })
  }
  return entries
}

async function readWorktreeEntry(root, repositoryPath, collector) {
  const segments = repositoryPath.split('/')
  let target = root
  for (let index = 0; index < segments.length; index += 1) {
    target = join(target, segments[index])
    let metadata
    try {
      metadata = await lstat(target)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return null
      collector.add('unreadable-tracked-file', repositoryPath)
      return null
    }
    if (metadata.isSymbolicLink()) {
      collector.add('unsafe-symlink', segments.slice(0, index + 1).join('/'))
      return null
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      collector.add('unsafe-worktree-entry', repositoryPath)
      return null
    }
    if (index === segments.length - 1 && !metadata.isFile()) {
      collector.add('unsafe-worktree-entry', repositoryPath)
      return null
    }
  }

  let handle
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      collector.add('unsafe-worktree-entry', repositoryPath)
      return null
    }
    if (metadata.size > MAX_TRACKED_FILE_BYTES) {
      collector.add('oversized-tracked-file', repositoryPath)
      return { bytes: null, size: metadata.size }
    }
    const bytes = await handle.readFile()
    return { bytes, size: metadata.size }
  } catch {
    collector.add('unreadable-tracked-file', repositoryPath)
    return null
  } finally {
    await handle?.close()
  }
}

function untrackedEvaluationPaths(root, collector) {
  const paths = splitNul(
    git(root, [
      'ls-files',
      '--others',
      '-z',
      '--',
      EVALUATION_ROOT,
    ]),
  )
  return paths.filter((repositoryPath) => {
    if (validRepositoryPath(root, repositoryPath)) return true
    collector.add('unsafe-repository-path', repositoryPath)
    return false
  })
}

async function readWorktreeSnapshot(root, trackedPaths, collector) {
  const entries = new Map()
  const repositoryPaths = new Set([
    ...trackedPaths,
    ...untrackedEvaluationPaths(root, collector),
  ])
  for (const repositoryPath of [...repositoryPaths].sort()) {
    const entry = await readWorktreeEntry(root, repositoryPath, collector)
    if (entry !== null) entries.set(repositoryPath, entry)
  }
  return entries
}

function includesSequence(bytes, sequence) {
  return bytes.indexOf(sequence) >= 0
}

function hasMediaMagic(bytes) {
  return mediaMagic.some((magic) => includesSequence(bytes, magic))
}

function hasArchiveMagic(bytes) {
  return (
    archiveMagic.some((magic) => includesSequence(bytes, magic)) ||
    (bytes.length >= 262 && bytes.subarray(257, 262).equals(tarMagic))
  )
}

function decodeUtf8(bytes) {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return null
  }
}

function isEvaluationArtifact(repositoryPath) {
  return (
    repositoryPath.startsWith(`${FIXTURE_ROOT}/`) ||
    repositoryPath.startsWith(`${GOLDEN_ROOT}/`)
  )
}

function containsAbsoluteWorkspacePath(text, root) {
  const normalizedRoot = root.replaceAll('\\', '/')
  return (
    text.includes(normalizedRoot) ||
    absolutePosixHomePattern.test(text) ||
    absolutePosixWorkspacePattern.test(text) ||
    absoluteMountedHomePattern.test(text) ||
    absoluteWindowsHomePattern.test(text)
  )
}

function hasSuspiciousEncodedPayload(text) {
  return (
    dataUriPayloadPattern.test(text) ||
    longEncodedPayloadPattern.test(text) ||
    longHexPayloadPattern.test(text)
  )
}

function scanSnapshot(root, snapshot, collector) {
  for (const [repositoryPath, entry] of snapshot) {
    const extension = extname(repositoryPath).toLowerCase()
    if (mediaExtensions.has(extension))
      collector.add('forbidden-media-extension', repositoryPath)
    if (archiveExtensions.has(extension))
      collector.add('forbidden-archive-extension', repositoryPath)
    if (
      isEvaluationArtifact(repositoryPath) &&
      entry.size > MAX_EVALUATION_FILE_BYTES
    )
      collector.add('oversized-evaluation-file', repositoryPath)
    if (entry.bytes === null) continue
    if (hasMediaMagic(entry.bytes))
      collector.add('forbidden-media-magic', repositoryPath)
    if (hasArchiveMagic(entry.bytes))
      collector.add('forbidden-archive-magic', repositoryPath)

    const text = decodeUtf8(entry.bytes)
    if (repositoryPath.startsWith(`${EVALUATION_ROOT}/`)) {
      if (text === null || (text !== null && forbiddenTextControls.test(text)))
        collector.add('evaluation-text-only', repositoryPath)
    }
    if (text === null) continue
    if (containsAbsoluteWorkspacePath(text, root))
      collector.add('absolute-workspace-path', repositoryPath)
    if (hasSuspiciousEncodedPayload(text))
      collector.add('suspicious-encoded-payload', repositoryPath)
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, expectedKeys) {
  return (
    isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  )
}

function parseJson(snapshot, repositoryPath, policy, collector) {
  const entry = snapshot.get(repositoryPath)
  if (!entry?.bytes) {
    collector.add(policy, repositoryPath)
    return null
  }
  const text = decodeUtf8(entry.bytes)
  if (text === null) {
    collector.add(policy, repositoryPath)
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    collector.add(policy, repositoryPath)
    return null
  }
}

function isUniqueStringArray(value, allowedValues, allowEmpty = false) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        allowedValues.has(entry) &&
        value.indexOf(entry) === value.lastIndexOf(entry),
    )
  )
}

function validAuthoredDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function readManifest(snapshot, collector) {
  const value = parseJson(
    snapshot,
    MANIFEST_PATH,
    'invalid-evaluation-manifest',
    collector,
  )
  const cases = new Map()
  let valid = hasExactKeys(value, manifestRootKeys) && Array.isArray(value?.cases)
  if (!valid) {
    collector.add('invalid-evaluation-manifest', MANIFEST_PATH)
    return cases
  }

  for (const candidate of value.cases) {
    const candidateValid =
      hasExactKeys(candidate, manifestCaseKeys) &&
      typeof candidate.caseId === 'string' &&
      candidate.caseId.length <= 64 &&
      syntheticIdentifierPattern.test(candidate.caseId) &&
      isUniqueStringArray(candidate.requiredCategories, requiredCategories) &&
      typeof candidate.expectedDisposition === 'string' &&
      expectedDispositions.has(candidate.expectedDisposition) &&
      isUniqueStringArray(candidate.goldenEntries, reviewedGoldenEntries, true) &&
      typeof candidate.provenanceKey === 'string' &&
      candidate.provenanceKey.length <= 64 &&
      syntheticIdentifierPattern.test(candidate.provenanceKey)
    if (!candidateValid) {
      valid = false
      continue
    }
    const current = cases.get(candidate.caseId) ?? []
    current.push(candidate)
    cases.set(candidate.caseId, current)
  }
  if (!valid || [...cases.values()].some((candidates) => candidates.length !== 1))
    collector.add('invalid-evaluation-manifest', MANIFEST_PATH)
  return cases
}

function readProvenance(snapshot, collector) {
  const value = parseJson(
    snapshot,
    PROVENANCE_PATH,
    'invalid-provenance',
    collector,
  )
  const records = new Map()
  let valid = hasExactKeys(value, provenanceRootKeys) && Array.isArray(value?.records)
  if (!valid) {
    collector.add('invalid-provenance', PROVENANCE_PATH)
    return records
  }

  for (const candidate of value.records) {
    const candidateValid =
      hasExactKeys(candidate, provenanceRecordKeys) &&
      typeof candidate.provenanceKey === 'string' &&
      candidate.provenanceKey.length <= 64 &&
      syntheticIdentifierPattern.test(candidate.provenanceKey) &&
      candidate.origin === 'synthetic' &&
      candidate.license === REPOSITORY_LICENSE &&
      validAuthoredDate(candidate.authoredOn)
    if (!candidateValid) {
      valid = false
      continue
    }
    const current = records.get(candidate.provenanceKey) ?? []
    current.push(candidate)
    records.set(candidate.provenanceKey, current)
  }
  if (!valid || [...records.values()].some((candidates) => candidates.length !== 1))
    collector.add('invalid-provenance', PROVENANCE_PATH)
  return records
}

function validateEvaluationSnapshot(snapshot, collector) {
  const evaluationPaths = [...snapshot.keys()].filter((repositoryPath) =>
    repositoryPath.startsWith(`${EVALUATION_ROOT}/`),
  )
  const artifactPaths = evaluationPaths.filter(isEvaluationArtifact)
  if (artifactPaths.length === 0) return

  const cases = readManifest(snapshot, collector)
  const provenance = readProvenance(snapshot, collector)
  const referencedProvenance = new Map()
  for (const candidates of cases.values())
    for (const candidate of candidates) {
      const references = referencedProvenance.get(candidate.provenanceKey) ?? 0
      referencedProvenance.set(candidate.provenanceKey, references + 1)
      if ((provenance.get(candidate.provenanceKey)?.length ?? 0) !== 1)
        collector.add('invalid-provenance', PROVENANCE_PATH)
    }
  for (const provenanceKey of provenance.keys())
    if (referencedProvenance.get(provenanceKey) !== 1)
      collector.add('invalid-provenance', PROVENANCE_PATH)

  for (const repositoryPath of evaluationPaths) {
    const relativeEvaluationPath = repositoryPath.slice(
      EVALUATION_ROOT.length + 1,
    )
    if (evaluationTopLevelFiles.has(relativeEvaluationPath)) continue
    if (
      relativeEvaluationPath === 'fixtures/manifest.json' ||
      relativeEvaluationPath === 'fixtures/provenance.json'
    )
      continue

    const segments = relativeEvaluationPath.split('/')
    if (segments[0] === 'fixtures') {
      const fileName = segments[1] ?? ''
      const caseId = fileName.endsWith('.json')
        ? fileName.slice(0, -'.json'.length)
        : ''
      const caseCandidates = cases.get(caseId) ?? []
      const provenanceCount =
        caseCandidates.length === 1
          ? provenance.get(caseCandidates[0].provenanceKey)?.length ?? 0
          : 0
      if (
        segments.length !== 2 ||
        !syntheticIdentifierPattern.test(caseId) ||
        caseCandidates.length !== 1 ||
        provenanceCount !== 1
      )
        collector.add('undeclared-fixture', repositoryPath)
      continue
    }

    if (segments[0] === 'goldens') {
      const caseId = segments[1] ?? ''
      const entryName = segments[2] ?? ''
      const caseCandidates = cases.get(caseId) ?? []
      const provenanceCount =
        caseCandidates.length === 1
          ? provenance.get(caseCandidates[0].provenanceKey)?.length ?? 0
          : 0
      if (
        segments.length !== 3 ||
        caseCandidates.length !== 1 ||
        provenanceCount !== 1 ||
        !reviewedGoldenEntries.has(entryName) ||
        !caseCandidates[0].goldenEntries.includes(entryName)
      )
        collector.add('undeclared-golden', repositoryPath)
      continue
    }

    collector.add('undeclared-evaluation-file', repositoryPath)
  }
}

async function repositoryRoot() {
  const discovered = git(process.cwd(), ['rev-parse', '--show-toplevel'], 1024)
    .toString('utf8')
    .trim()
  if (!discovered) throw new Error('repository root unavailable')
  return realpath(discovered)
}

async function checkBoundary() {
  const root = await repositoryRoot()
  const collector = new ViolationCollector()
  const indexSnapshot = parseIndexEntries(root, collector)
  const worktreeSnapshot = await readWorktreeSnapshot(
    root,
    indexSnapshot.keys(),
    collector,
  )

  scanSnapshot(root, indexSnapshot, collector)
  scanSnapshot(root, worktreeSnapshot, collector)
  validateEvaluationSnapshot(indexSnapshot, collector)
  validateEvaluationSnapshot(worktreeSnapshot, collector)
  return collector.sorted()
}

try {
  const violations = await checkBoundary()
  if (violations.length === 0) {
    process.stdout.write('layout-eval-boundary: ok\n')
  } else {
    process.stderr.write('layout-eval-boundary: failed\n')
    for (const violation of violations)
      process.stderr.write(`${violation.policy}: ${violation.path}\n`)
    process.exitCode = 1
  }
} catch {
  process.stderr.write('layout-eval-boundary-internal-error: repository\n')
  process.exitCode = 1
}
