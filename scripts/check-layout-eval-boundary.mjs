import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

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
const REDACTED_PATH_TOKEN = '<redacted-relative-path>'
const DESCRIPTOR_DIRECTORY = '/proc/self/fd'
const READ_CHUNK_BYTES = 64 * 1024
const TRAVERSAL_TEST_SEAM_ENVIRONMENT =
  'STRUCT_LAYOUT_EVAL_BOUNDARY_TEST_SEAM'
const TRAVERSAL_TEST_SEAM_VALUE = 'post-validation-intermediate-swap'
const TRAVERSAL_TEST_READY_MESSAGE = 'intermediate-directory-validated'
const TRAVERSAL_TEST_CONTINUE_MESSAGE = 'intermediate-substitution-complete'

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
  #policies = new Set()

  add(policy) {
    this.#policies.add(policy)
  }

  sorted() {
    return [...this.#policies]
      .sort((left, right) => left.localeCompare(right))
      .map((policy) => ({ policy, path: REDACTED_PATH_TOKEN }))
  }
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
    repositoryPath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
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

function descriptorChildPath(directoryHandle, segment) {
  // The held descriptor pins the parent directory; only the appended component
  // is resolved, and every such open below uses O_NOFOLLOW.
  return `${DESCRIPTOR_DIRECTORY}/${directoryHandle.fd}/${segment}`
}

function descriptorOpenFlags(directory) {
  if (
    !Number.isInteger(constants.O_NOFOLLOW) ||
    (directory && !Number.isInteger(constants.O_DIRECTORY))
  )
    throw new Error('safe descriptor traversal unavailable')
  return (
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    (constants.O_NONBLOCK ?? 0) |
    (directory ? constants.O_DIRECTORY : 0)
  )
}

function errorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : null
}

async function recordDescriptorOpenFailure(
  error,
  directoryHandle,
  segment,
  repositoryPath,
  collector,
) {
  if (errorCode(error) === 'ENOENT') return 'missing'

  if (errorCode(error) === 'ELOOP' || errorCode(error) === 'ENOTDIR') {
    try {
      const metadata = await lstat(
        descriptorChildPath(directoryHandle, segment),
        { bigint: true },
      )
      collector.add(
        metadata.isSymbolicLink()
          ? 'unsafe-symlink'
          : 'unsafe-worktree-entry',
        repositoryPath,
      )
      return 'rejected'
    } catch (classificationError) {
      if (errorCode(classificationError) === 'ENOENT') return 'missing'
    }
  }

  collector.add('unreadable-tracked-file', repositoryPath)
  return 'rejected'
}

function sameDescriptorIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertDescriptorTraversalAvailable(rootHandle, rootMetadata) {
  let aliasHandle
  try {
    aliasHandle = await open(
      `${DESCRIPTOR_DIRECTORY}/${rootHandle.fd}/.`,
      descriptorOpenFlags(true),
    )
    const aliasMetadata = await aliasHandle.stat({ bigint: true })
    if (!sameDescriptorIdentity(rootMetadata, aliasMetadata))
      throw new Error('safe descriptor traversal unavailable')
  } finally {
    await aliasHandle?.close()
  }
}

async function descriptorBindingIsStable(
  directoryHandle,
  entryMetadata,
  segment,
  repositoryPath,
  directory,
  collector,
) {
  let reboundHandle
  try {
    reboundHandle = await open(
      descriptorChildPath(directoryHandle, segment),
      descriptorOpenFlags(directory),
    )
    const reboundMetadata = await reboundHandle.stat({ bigint: true })
    if (!sameDescriptorIdentity(entryMetadata, reboundMetadata)) {
      collector.add('unsafe-worktree-entry', repositoryPath)
      return false
    }
    return true
  } catch (error) {
    await recordDescriptorOpenFailure(
      error,
      directoryHandle,
      segment,
      repositoryPath,
      collector,
    )
    return false
  } finally {
    await reboundHandle?.close()
  }
}

let traversalTestSeamUsed = false

async function pauseAtTraversalTestSeam(repositoryPath, segmentIndex) {
  if (
    traversalTestSeamUsed ||
    process.env[TRAVERSAL_TEST_SEAM_ENVIRONMENT] !==
      TRAVERSAL_TEST_SEAM_VALUE ||
    typeof process.send !== 'function' ||
    !repositoryPath.includes('/') ||
    segmentIndex !== 0
  )
    return

  traversalTestSeamUsed = true
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error('traversal test seam timed out'))
    }, 5_000)

    function cleanup() {
      clearTimeout(timeout)
      process.off('message', onMessage)
      process.off('disconnect', onDisconnect)
    }

    function onMessage(message) {
      if (message !== TRAVERSAL_TEST_CONTINUE_MESSAGE) return
      cleanup()
      resolvePromise()
    }

    function onDisconnect() {
      cleanup()
      rejectPromise(new Error('traversal test seam disconnected'))
    }

    process.on('message', onMessage)
    process.on('disconnect', onDisconnect)
    process.send(TRAVERSAL_TEST_READY_MESSAGE)
  })
}

async function readBoundedFile(handle) {
  const chunks = []
  let size = 0
  while (size <= MAX_TRACKED_FILE_BYTES) {
    const remaining = MAX_TRACKED_FILE_BYTES + 1 - size
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    size += bytesRead
  }
  return {
    bytes:
      size > MAX_TRACKED_FILE_BYTES ? null : Buffer.concat(chunks, size),
    size,
  }
}

async function readWorktreeEntry(rootHandle, repositoryPath, collector) {
  const segments = repositoryPath.split('/')
  const openedHandles = []
  let directoryHandle = rootHandle

  try {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      const directory = index < segments.length - 1
      let entryHandle
      try {
        entryHandle = await open(
          descriptorChildPath(directoryHandle, segment),
          descriptorOpenFlags(directory),
        )
      } catch (error) {
        await recordDescriptorOpenFailure(
          error,
          directoryHandle,
          segment,
          repositoryPath,
          collector,
        )
        return null
      }
      openedHandles.push(entryHandle)

      let metadata
      try {
        metadata = await entryHandle.stat({ bigint: true })
      } catch {
        collector.add('unreadable-tracked-file', repositoryPath)
        return null
      }
      if (directory ? !metadata.isDirectory() : !metadata.isFile()) {
        collector.add('unsafe-worktree-entry', repositoryPath)
        return null
      }

      await pauseAtTraversalTestSeam(repositoryPath, index)
      if (
        !(await descriptorBindingIsStable(
          directoryHandle,
          metadata,
          segment,
          repositoryPath,
          directory,
          collector,
        ))
      )
        return null

      if (directory) {
        directoryHandle = entryHandle
        continue
      }

      if (metadata.size > BigInt(MAX_TRACKED_FILE_BYTES)) {
        collector.add('oversized-tracked-file', repositoryPath)
        return { bytes: null, size: MAX_TRACKED_FILE_BYTES + 1 }
      }
      const entry = await readBoundedFile(entryHandle)
      if (entry.bytes === null)
        collector.add('oversized-tracked-file', repositoryPath)
      return entry
    }
  } catch {
    collector.add('unreadable-tracked-file', repositoryPath)
    return null
  } finally {
    for (const handle of openedHandles.reverse()) await handle.close()
  }

  collector.add('unsafe-worktree-entry', repositoryPath)
  return null
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
  let rootHandle
  try {
    rootHandle = await open(root, descriptorOpenFlags(true))
    const rootMetadata = await rootHandle.stat({ bigint: true })
    if (!rootMetadata.isDirectory()) throw new Error('repository root unavailable')
    await assertDescriptorTraversalAvailable(rootHandle, rootMetadata)
    for (const repositoryPath of [...repositoryPaths].sort()) {
      const entry = await readWorktreeEntry(
        rootHandle,
        repositoryPath,
        collector,
      )
      if (entry !== null) entries.set(repositoryPath, entry)
    }
  } finally {
    await rootHandle?.close()
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
    for (const violation of violations)
      process.stderr.write(`${violation.policy}: ${violation.path}\n`)
    process.exitCode = 1
  }
} catch {
  process.stderr.write(
    `layout-eval-boundary-internal-error: ${REDACTED_PATH_TOKEN}\n`,
  )
  process.exitCode = 1
}
