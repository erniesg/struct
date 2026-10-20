#!/usr/bin/env node
// Focused driver for the sacrificial resolver verification host harness.
//
// This driver owns no protocol. It runs the parent-side supervisor harness,
// captures the machine-readable evidence it produces, and re-emits it on
// stdout. The harness itself is the source of truth: every assertion it
// records comes from a real process, a real signal, or a real /proc
// observation.
//
// Usage:
//   node scripts/test-resolver-host.mjs [--case <name>]... [--python <bin>] [--keep]
//
// Exit codes:
//   0  every requested case passed
//   1  at least one case failed
//   2  the harness could not be executed at all

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const harness = join(here, '..', 'tests', 'fixtures', 'resolver-host', 'parent_harness.py')

function parseArgs(argv) {
  const options = { cases: [], python: process.env.RESOLVER_HOST_PYTHON ?? 'python3', keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--case' && index + 1 < argv.length) {
      options.cases.push(argv[index + 1])
      index += 1
    } else if (arg === '--python' && index + 1 < argv.length) {
      options.python = argv[index + 1]
      index += 1
    } else if (arg === '--keep') {
      options.keep = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const rundir = mkdtempSync(join(tmpdir(), 'resolver-host-'))
  const outPath = join(rundir, 'harness-evidence.json')
  const args = [harness, '--rundir', join(rundir, 'run'), '--out', outPath]
  for (const name of options.cases) args.push('--case', name)

  let run
  try {
    run = spawnSync(options.python, args, {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    process.stderr.write(`failed to launch the harness: ${error.message}\n`)
    return 2
  }

  let evidence
  try {
    evidence = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch {
    process.stderr.write(
      `the harness produced no machine-readable evidence\n` +
        `python: ${options.python}\n` +
        `status: ${run.status}\n` +
        `stderr:\n${run.stderr ?? ''}\n`,
    )
    if (!options.keep) rmSync(rundir, { recursive: true, force: true })
    return 2
  }

  if (!options.keep) rmSync(rundir, { recursive: true, force: true })

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)

  const blockers = evidence.capability_blockers ?? []
  if (blockers.length > 0) {
    process.stderr.write(`capability blockers: ${blockers.join(', ')}\n`)
    return 1
  }
  return evidence.summary?.all_passed ? 0 : 1
}

process.exit(main())
