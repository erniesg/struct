import { spawnSync } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER_AUTHORIZATION = 'verify-layout-goldens-v1'
const EVALUATION_ROOT = 'evaluation/layout-epub-v2'
const MANIFEST_PATH = `${EVALUATION_ROOT}/fixtures/manifest.json`
const PROVENANCE_PATH = `${EVALUATION_ROOT}/fixtures/provenance.json`
const BOUNDARY_SCRIPT = 'scripts/check-layout-eval-boundary.mjs'
const GOLDEN_TEST = 'tests/layout-eval/reproducibility-goldens.test.ts'
const FIXTURE_TEST = 'tests/layout-eval/fixture-contract.test.ts'
const GOLDEN_ENTRIES = [
  'content.xhtml',
  'nav.xhtml',
  'package.opf',
  'container.xml',
  'styles.css',
  'archive.json',
]
const SYNTHETIC_CASE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

class GoldenCliError extends Error {
  constructor(code) {
    super(code)
    this.name = 'GoldenCliError'
    this.code = code
  }
}

function fail(code) {
  throw new GoldenCliError(code)
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  )
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 1024 * 1024,
    timeout: options.timeout ?? 60_000,
  })
  if (result.error || result.status !== 0) fail(options.failure ?? 'command')
  return result
}

function argumentsMode(arguments_) {
  if (arguments_.length === 0) return { mode: 'verify' }
  if (
    arguments_.length !== 3 ||
    arguments_[0] !== '--update' ||
    arguments_[1] !== '--case'
  )
    fail('invalid-arguments')
  const caseId = arguments_[2]
  if (
    typeof caseId !== 'string' ||
    caseId.length > 64 ||
    !SYNTHETIC_CASE_ID.test(caseId)
  )
    fail('invalid-case')
  return { caseId, mode: 'update' }
}

async function repositoryRoot() {
  const scriptRoot = await realpath(
    dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
  )
  const discovered = run(
    'git',
    ['rev-parse', '--show-toplevel'],
    { cwd: scriptRoot, failure: 'repository' },
  ).stdout.trim()
  if (!discovered || (await realpath(discovered)) !== scriptRoot)
    fail('repository')
  return scriptRoot
}

function assertClean(root) {
  const status = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root, failure: 'repository' },
  ).stdout
  if (status !== '') fail('dirty-worktree')
}

function runBoundary(root) {
  run(process.execPath, [join(root, BOUNDARY_SCRIPT)], {
    cwd: root,
    failure: 'privacy-boundary',
  })
}

async function readJson(root, path) {
  try {
    return JSON.parse(await readFile(join(root, path), 'utf8'))
  } catch {
    fail('fixture-contract')
  }
}

async function selectedCase(root, caseId) {
  const [manifest, provenance] = await Promise.all([
    readJson(root, MANIFEST_PATH),
    readJson(root, PROVENANCE_PATH),
  ])
  if (
    !exactKeys(manifest, ['cases']) ||
    !Array.isArray(manifest.cases) ||
    !exactKeys(provenance, ['records']) ||
    !Array.isArray(provenance.records)
  )
    fail('fixture-contract')
  const matches = manifest.cases.filter(
    (candidate) => candidate?.caseId === caseId,
  )
  if (matches.length !== 1) fail('unknown-case')
  const candidate = matches[0]
  if (
    !exactKeys(candidate, [
      'caseId',
      'requiredCategories',
      'expectedDisposition',
      'goldenEntries',
      'provenanceKey',
    ]) ||
    candidate.expectedDisposition !== 'render' ||
    JSON.stringify(candidate.goldenEntries) !== JSON.stringify(GOLDEN_ENTRIES)
  )
    fail('fixture-contract')
  const origins = provenance.records.filter(
    (record) => record?.provenanceKey === candidate.provenanceKey,
  )
  if (
    origins.length !== 1 ||
    !exactKeys(origins[0], [
      'provenanceKey',
      'origin',
      'authoredOn',
      'license',
    ]) ||
    origins[0].origin !== 'synthetic' ||
    origins[0].license !== 'MIT'
  )
    fail('fixture-contract')
}

function runGoldenTest(root, environment = {}, includeFixtureContract = false) {
  const vitest = join(root, 'node_modules/vitest/vitest.mjs')
  const workerEnvironment = { ...process.env }
  delete workerEnvironment.STRUCT_LAYOUT_GOLDEN_CASE_ID
  delete workerEnvironment.STRUCT_LAYOUT_GOLDEN_OUTPUT_PATH
  delete workerEnvironment.STRUCT_LAYOUT_GOLDEN_WORKER_AUTH
  delete workerEnvironment.STRUCT_LAYOUT_GOLDEN_WORKER_MODE
  Object.assign(workerEnvironment, environment)
  run(
    process.execPath,
    [
      vitest,
      'run',
      GOLDEN_TEST,
      ...(includeFixtureContract ? [FIXTURE_TEST] : []),
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      env: workerEnvironment,
      failure: 'verification',
      timeout: 120_000,
    },
  )
}

async function main() {
  const mode = argumentsMode(process.argv.slice(2))
  const root = await repositoryRoot()
  if (mode.mode === 'update') {
    await selectedCase(root, mode.caseId)
    assertClean(root)
  }
  runBoundary(root)

  if (mode.mode === 'verify') {
    runGoldenTest(root, {}, true)
    process.stdout.write('layout-goldens:verified\n')
    return
  }

  runGoldenTest(root, {
    STRUCT_LAYOUT_GOLDEN_CASE_ID: mode.caseId,
    STRUCT_LAYOUT_GOLDEN_WORKER_AUTH: WORKER_AUTHORIZATION,
    STRUCT_LAYOUT_GOLDEN_WORKER_MODE: 'update',
  })
  runBoundary(root)
  process.stdout.write(`layout-goldens:updated:${mode.caseId}\n`)
}

try {
  await main()
} catch (error) {
  const code = error instanceof GoldenCliError ? error.code : 'internal-error'
  process.stderr.write(`layout-goldens:${code}\n`)
  process.exitCode = 1
}
