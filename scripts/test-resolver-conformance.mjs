#!/usr/bin/env node
// Focused driver for the real resolver OS conformance lane.
//
// This driver owns no protocol and it fabricates no evidence. It runs two
// independent suites and reports exactly what they observed:
//
//   1. the reviewed sacrificial host harness (scripts/test-resolver-host.mjs,
//      five cases, unmodified), which proves the OS substrate in isolation;
//   2. the real conformance suite (tests/bundle-resolver-real-conformance.test.ts),
//      which binds the published StructResolverExecutorV1 and
//      StructResolverHostSupervisorV1 surfaces to that host and drives them
//      through the portable package driver resolveStructResolverAssets.
//
// The second suite needs the TypeScript sources of the package, so it runs
// through the repository's own vitest installation with a JSON reporter. The
// driver reads that report and re-emits it as machine-readable evidence.
//
// Usage:
//   node scripts/test-resolver-conformance.mjs [--python <bin>] [--out <file>] [--keep]
//
// Exit codes:
//   0  both suites passed
//   1  at least one suite failed
//   2  a suite could not be executed at all

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const hostDriver = join(root, 'scripts', 'test-resolver-host.mjs')
const conformanceSuite = join(root, 'tests', 'bundle-resolver-real-conformance.test.ts')
const vitestBin = join(root, 'node_modules', '.bin', 'vitest')

function parseArgs(argv) {
  const options = {
    python: process.env.RESOLVER_HOST_PYTHON ?? 'python3',
    out: undefined,
    keep: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--python' && index + 1 < argv.length) {
      options.python = argv[index + 1]
      index += 1
    } else if (arg === '--out' && index + 1 < argv.length) {
      options.out = argv[index + 1]
      index += 1
    } else if (arg === '--keep') {
      options.keep = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function runHostHarness(python) {
  const run = spawnSync(process.execPath, [hostDriver, '--python', python], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  let evidence
  try {
    evidence = JSON.parse(run.stdout)
  } catch {
    return {
      suite: 'sacrificial-host-harness',
      executed: false,
      passed: false,
      reason: 'the harness produced no machine-readable evidence',
      status: run.status,
      stderr: run.stderr ?? '',
    }
  }
  return {
    suite: 'sacrificial-host-harness',
    executed: true,
    passed: Boolean(evidence.summary?.all_passed),
    cases: evidence.cases?.map((entry) => ({
      case: entry.case,
      pass: Boolean(entry.pass),
      blocker: entry.blocker ?? null,
      wall_s: entry.wall_s ?? null,
    })) ?? [],
    capabilityBlockers: evidence.capability_blockers ?? [],
    finalCleanup: evidence.final_cleanup ?? null,
    status: run.status,
  }
}

function runConformanceSuite(outDir) {
  if (!existsSync(vitestBin)) {
    return {
      suite: 'real-resolver-conformance',
      executed: false,
      passed: false,
      reason: `the repository vitest installation is missing at ${vitestBin}`,
    }
  }
  const reportPath = join(outDir, 'conformance-vitest.json')
  const evidencePath = join(outDir, 'conformance-cases.json')
  const run = spawnSync(
    vitestBin,
    [
      'run',
      conformanceSuite,
      '--maxWorkers=1',
      '--testTimeout=120000',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      cwd: root,
      env: { ...process.env, RESOLVER_CONFORMANCE_EVIDENCE: evidencePath },
    },
  )
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    return {
      suite: 'real-resolver-conformance',
      executed: false,
      passed: false,
      reason: 'the conformance suite produced no machine-readable report',
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
    }
  }
  const tests = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      tests.push({
        name: assertion.title ?? assertion.fullName ?? 'unnamed',
        file: file.name ?? null,
        status: assertion.status,
        durationMs: assertion.duration ?? null,
        failureMessages: assertion.failureMessages ?? [],
      })
    }
  }
  let caseEvidence = null
  try {
    caseEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  } catch {
    caseEvidence = null
  }
  return {
    suite: 'real-resolver-conformance',
    executed: true,
    passed: Number(report.numFailedTests ?? 0) === 0 && Number(report.numPendingTests ?? 0) === 0,
    total: report.numTotalTests ?? tests.length,
    passedCount: report.numPassedTests ?? 0,
    failedCount: report.numFailedTests ?? 0,
    tests,
    caseEvidence,
    status: run.status,
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const probe = spawnSync(options.python, ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    process.stderr.write(`the python interpreter ${options.python} is not usable\n`)
    return 2
  }

  const outDir = mkdtempSync(join(tmpdir(), 'resolver-conformance-'))
  let host
  let conformance
  try {
    host = runHostHarness(options.python)
    conformance = runConformanceSuite(outDir)
  } finally {
    if (!options.keep) rmSync(outDir, { recursive: true, force: true })
  }

  const evidence = {
    kind: 'struct-resolver-real-conformance',
    generatedAtUtc: new Date().toISOString(),
    python: options.python,
    node: process.version,
    hostHarness: host,
    conformance: conformance,
    summary: {
      hostHarnessPassed: Boolean(host.passed),
      conformancePassed: Boolean(conformance.passed),
      allPassed: Boolean(host.passed) && Boolean(conformance.passed),
    },
    notClaimed: [
      'not S-03 completion',
      'not S-04 completion',
      'no transport behaviour is exercised',
      'the conformance fixture never grants transport authority',
      'not an independent review',
    ],
  }

  const text = `${JSON.stringify(evidence, null, 2)}\n`
  process.stdout.write(text)
  if (options.out) writeFileSync(options.out, text)

  return evidence.summary.allPassed ? 0 : 1
}

process.exit(main())
