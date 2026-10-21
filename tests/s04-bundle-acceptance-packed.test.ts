/**
 * S-04 packed-artifact Bundle acceptance matrix.
 *
 * `docs/s04-release-matrix-2026-10-20.md` claims a "Bundle acceptance/version
 * matrix (packed artifact)". This file is the committed proof of that claim:
 * it packs the package, installs the tarball into a temporary consumer, runs
 * `tests/public-consumer/runtime.mjs` against the INSTALLED artifact, and
 * asserts the measured acceptance values the runtime reports.
 *
 * The measured values are not copied from the expectations: the runtime
 * measures them inside the consumer and writes them to `bundle-acceptance.json`,
 * and this test asserts that measurement. A mismatch between the package and
 * the expectation therefore fails here rather than passing silently.
 *
 * Precondition: the package must be built (`npm run build`), exactly as
 * `scripts/build-release-packet.mjs` does before it runs the suite. The
 * packed artifact is the built `dist/` tree, so an unbuilt tree cannot be
 * measured. The test refuses to run rather than measuring a stale artifact.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))

/** The exact runtime exports the packed `./bundle` surface must publish. */
const EXPECTED_EXPORTS = [
  'STRUCT_BUNDLE_LIMITS_PROFILE',
  'STRUCT_BUNDLE_LIMITS_PROFILE_VERSION',
  'StructBundleError',
  'createStructBundle',
  'decodeStructBundle',
  'encodeStructBundle',
  'verifyStructBundle',
]

/** The frozen public limits profile, spelled out value by value. */
const EXPECTED_PROFILE = {
  profileVersion: '1.0.0',
  maxRawBytes: 8388608,
  maxFieldBytes: 5600000,
  maxAssets: 256,
  maxAssetBytes: 4194304,
  maxTotalBytes: 4194304,
  maxDecodedBytes: 4194304,
  maxBase64Chars: 5592408,
  maxConcurrency: 1,
  maxDepth: 128,
  maxStringLength: 5592408,
  maxNodes: 1000000,
  maxResolverTimeoutMs: 120000,
}

/** The own property names a public rejection is allowed to expose. */
const ALLOWED_ERROR_PROPERTIES = ['code', 'message', 'name', 'stack', 'stage']

/**
 * Extracts the summary the packed-consumer script prints.
 *
 * The script prints progress output before the summary, so the summary is the
 * last line that starts with `{` and parses as the documented object.
 */
function parseSummary(stdout: string): any {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (!line.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'bundleAcceptance' in (parsed as Record<string, unknown>)
    )
      return parsed
  }
  throw new Error(
    'the packed consumer did not print a summary JSON line:\n' +
      lines.slice(-5).join('\n'),
  )
}

describe('S-04 packed Bundle acceptance matrix', () => {
  let artifactDirectory = ''
  let summary: any

  beforeAll(async () => {
    await access(join(repository, 'dist/bundle/index.js')).catch(() => {
      throw new Error(
        'the packed artifact is measured from dist/: run `npm run build` first',
      )
    })
    artifactDirectory = await mkdtemp(
      join(tmpdir(), 'struct-s04-acceptance-'),
    )
    const run = spawnSync(
      process.execPath,
      ['scripts/test-packed-consumer.mjs'],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          STRUCT_PACKED_CONSUMER_ARTIFACT_DIR: artifactDirectory,
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    if (run.status !== 0)
      throw new Error(
        `the packed consumer failed with exit code ${run.status}\n` +
          `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      )
    summary = parseSummary(run.stdout)
  }, 600_000)

  afterAll(async () => {
    if (artifactDirectory)
      await rm(artifactDirectory, { recursive: true, force: true })
  })

  it('the packed consumer exits 0 and prints its summary', () => {
    expect(summary.schemaVersion).toBe('1.0.0')
    expect(summary.bundleAcceptance).toBeDefined()
    expect(summary.tarball.sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('retains the measured tarball outside the repository', async () => {
    const retained = await readFile(
      join(artifactDirectory, summary.tarball.filename),
    )
    expect(createHash('sha256').update(retained).digest('hex')).toBe(
      summary.tarball.sha256,
    )
  })

  it('publishes exactly the seven runtime exports', () => {
    expect(summary.bundleAcceptance.publicSurface.exports).toEqual(
      EXPECTED_EXPORTS,
    )
    expect(summary.bundleAcceptance.publicSurface.exact).toBe(true)
  })

  it('publishes the frozen limits profile', () => {
    expect(summary.bundleAcceptance.profile.values).toEqual(EXPECTED_PROFILE)
    expect(summary.bundleAcceptance.profile.version).toBe('1.0.0')
    expect(summary.bundleAcceptance.profile.frozen).toBe(true)
  })

  it('round trips create -> encode -> decode with an embedded asset', () => {
    const roundTrip = summary.bundleAcceptance.roundTrip
    expect(roundTrip.documentSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(roundTrip.bundleSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(roundTrip.encodedBytes).toBeGreaterThan(0)
    expect(roundTrip.assetIds).toEqual([
      'asset-s04-packed-marker-7c1f9ab2',
    ])
    expect(roundTrip.assetByteLength).toBe(12)
    expect(roundTrip.assetBytesPreserved).toBe(true)
    expect(roundTrip.documentSnapshotIsByteFree).toBe(true)
  })

  it('accepts the current version axis and refuses every other spelling', () => {
    const versionAxis = summary.bundleAcceptance.versionAxis
    expect(versionAxis.accepted).toEqual({
      bundleVersion: '1.0.0',
      schemaVersion: '0.2.0',
      accepted: true,
    })
    for (const name of [
      'bundleVersion2.0.0',
      'bundleVersionNotAString',
      'schemaVersion0.9.9',
      'schemaVersionNotAString',
    ]) {
      expect(versionAxis[name].verify).toEqual({
        stage: 'canonical',
        code: 'TYPE',
      })
      expect(versionAxis[name].decode).toEqual({
        stage: 'canonical',
        code: 'TYPE',
      })
    }
  })

  it('keeps every rejection free of caller input', () => {
    const hygiene = summary.bundleAcceptance.errorHygiene
    expect(hygiene.allowedOwnProperties).toEqual(ALLOWED_ERROR_PROPERTIES)
    expect(hygiene.observedOwnProperties).toEqual([
      'code',
      'message',
      'name',
      'stack',
      'stage',
    ])
    expect(hygiene.checkedRejections).toBeGreaterThan(0)
    expect(hygiene.frozen).toBe(true)
    expect(hygiene.causeAbsent).toBe(true)
    expect(hygiene.markerEchoed).toBe(false)
    expect(hygiene.marker).toBe('s04-packed-marker-7c1f9ab2')
  })

  it('refuses every tampered asset payload', () => {
    const guards = summary.bundleAcceptance.payloadGuards
    expect(guards.nonCanonicalBase64.verify).toEqual({
      stage: 'assets',
      code: 'BASE64',
    })
    expect(guards.nonCanonicalBase64.decode).toEqual({
      stage: 'assets',
      code: 'BASE64',
    })
    expect(guards.declaredLengthMismatch.verify).toEqual({
      stage: 'assets',
      code: 'BASE64',
    })
    expect(guards.declaredLengthMismatch.decode).toEqual({
      stage: 'assets',
      code: 'BASE64',
    })
    expect(guards.digestMismatch.verify).toEqual({
      stage: 'assets',
      code: 'DIGEST',
    })
    expect(guards.digestMismatch.decode).toEqual({
      stage: 'assets',
      code: 'DIGEST',
    })
    expect(guards.declaredByteLengthOverCap.verify).toEqual({
      stage: 'assets',
      code: 'LIMIT',
    })
    expect(guards.declaredByteLengthOverCap.decode).toEqual({
      stage: 'assets',
      code: 'LIMIT',
    })
    // A base64 payload longer than the profile's base64 cap is refused by the
    // profile's string cap, which has the same bound and is charged before
    // the asset caps. The measured stage is `canonical`, not `assets`.
    expect(guards.oversizedBase64Payload.verify).toEqual({
      stage: 'canonical',
      code: 'LIMIT',
    })
    expect(guards.oversizedBase64Payload.decode).toEqual({
      stage: 'canonical',
      code: 'LIMIT',
    })
  })

  it('refuses a forged handle', () => {
    expect(summary.bundleAcceptance.forgedHandle).toEqual({
      stage: 'handle',
      code: 'FORGED',
    })
  })

  it('never throws synchronously from the decode seam', () => {
    const decode = summary.bundleAcceptance.decodeNeverThrowsSynchronously
    expect(decode.allThenable).toBe(true)
    expect(decode.inputs).toEqual([
      'not-bytes',
      'empty',
      'garbage',
      'null',
      'undefined',
      'number',
      'object',
    ])
    for (const outcome of decode.outcomes) {
      expect(typeof outcome.stage).toBe('string')
      expect(typeof outcome.code).toBe('string')
    }
  })
})
