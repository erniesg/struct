/**
 * S-04 release packet evidence tests.
 *
 * These tests verify properties of the PACKED artifact (the tarball) directly,
 * without needing to install it in a consumer. The full consumer verification
 * is done by scripts/test-packed-consumer.mjs which is run separately and
 * its output is recorded in the packet.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  readFile,
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  copyFile,
} from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(
  await readFile(join(repository, 'package.json'), 'utf8'),
)

/**
 * The frozen renderer baselines. They are literals in
 * `scripts/s04-goldens-packed.mjs` and in `tests/renderer-repeatability.test.ts`
 * and they are never regenerated to make a red suite green.
 */
const FROZEN_BASELINES = {
  typography: {
    xhtmlSha256: 'dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30',
    epubContentSha256: '4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67',
    epubArchiveSha256: '8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908',
  },
  'assets-links': {
    xhtmlSha256: '01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa',
    epubContentSha256: 'e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365',
    epubArchiveSha256: '3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f',
  },
  order: {
    xhtmlSha256: '36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b',
    epubContentSha256: '6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289',
    epubArchiveSha256: '2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839',
  },
} as const

/** The packed tarball built once for this file and kept until the file ends. */
let packedTemporary: string | undefined
let packedTarballPath: string | undefined
let packedTarballSha256: string | undefined

afterAll(async () => {
  if (packedTemporary) {
    await rm(packedTemporary, { recursive: true, force: true })
    packedTemporary = undefined
  }
})

describe('S-04 release packet: tarball integrity', () => {
  let tarballPath: string
  let tarballSha256: string
  let packedMetadata: any

  beforeAll(async () => {
    // Build `dist/` first so the packed file list is deterministic.
    // `npm pack` does not run a build: it packs whatever `dist/` happens to
    // contain. Without this step the packed file list depends on the state of
    // a previous build, and a concurrent or interrupted `tsup --clean` can
    // produce a tarball that is missing an export target. This mirrors
    // scripts/build-release-packet.mjs, which builds before it packs.
    execFileSync('npm', ['run', 'build'], { cwd: repository, stdio: 'inherit' })

    // Build the tarball
    const temporary = await mkdtemp(join(tmpdir(), 'struct-pack-'))
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
        cwd: repository,
        encoding: 'utf8',
      }),
    )
    const metadata = packed[0]
    if (!metadata) throw new Error('npm pack returned no package metadata')

    tarballPath = join(temporary, metadata.filename)
    tarballSha256 = createHash('sha256')
      .update(await readFile(tarballPath))
      .digest('hex')
    packedMetadata = metadata

    // The tarball is kept until the end of this file: the golden and
    // regenerability checks below measure this exact artifact.
    packedTemporary = temporary
    packedTarballPath = tarballPath
    packedTarballSha256 = tarballSha256
    // The build takes longer than vitest's default 10s hook timeout.
  }, 300_000)

  it('tarball has correct package identity', () => {
    expect(packedMetadata.name).toBe(packageJson.name)
    expect(packedMetadata.version).toBe(packageJson.version)
  })

  it('tarball SHA-256 is recorded', () => {
    expect(tarballSha256).toMatch(/^[0-9a-f]{64}$/)
    // This exact value is recorded in the packet report
    console.log(`[S04-TARBALL] filename=${packedMetadata.filename} sha256=${tarballSha256}`)
  })

  it('tarball file list matches package.json files declaration', () => {
    // The file list is verified by scripts/test-packed-consumer.mjs which extracts
    // the tarball and validates against package.json files declaration.
    // The packed metadata includes the file list.
    expect(packedMetadata.files).toBeDefined()
    expect(Array.isArray(packedMetadata.files)).toBe(true)
    expect(packedMetadata.files.length).toBeGreaterThan(0)

    const filePaths = packedMetadata.files.map((f: any) => f.path)

    // Verify required files are in the packed file list
    const requiredFiles = [
      'package.json',
      'API_MANIFEST.json',
      'README.md',
      'LICENSE',
      'CONTRACT.md',
      'MIGRATION.md',
      'API.md',
      'NOTICE',
    ]
    for (const file of requiredFiles) {
      expect(filePaths).toContain(file)
    }

    // Verify all export targets are present
    const exportTargets = [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/document/index.js',
      'dist/document/index.d.ts',
      'dist/identity.js',
      'dist/identity.d.ts',
      'dist/ordering.js',
      'dist/ordering.d.ts',
      'dist/receipt.js',
      'dist/receipt.d.ts',
      'dist/recovery.js',
      'dist/recovery.d.ts',
      'dist/renderers/xhtml.js',
      'dist/renderers/xhtml.d.ts',
      'dist/renderers/epub.js',
      'dist/renderers/epub.d.ts',
      'dist/bundle/index.js',
      'dist/bundle/index.d.ts',
    ]
    for (const target of exportTargets) {
      expect(filePaths).toContain(target)
    }

    console.log(`[S04-FILELIST] ${packedMetadata.files.length} files in tarball`)
    for (const file of packedMetadata.files) {
      console.log(`  ${file.path} (${file.size} bytes)`)
    }
  })
})

describe('S-04 release packet: API manifest consistency', () => {
  let manifest: any

  beforeAll(async () => {
    const manifestPath = join(repository, 'API_MANIFEST.json')
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  })

  it('exportPaths matches package.json exports keys', () => {
    const exportKeys = Object.keys(packageJson.exports).sort()
    expect(manifest.exportPaths.sort()).toEqual(exportKeys)
  })

  it('runtimeExports has entries for all exportPaths', () => {
    for (const path of manifest.exportPaths) {
      expect(manifest.runtimeExports).toHaveProperty(path)
      expect(Array.isArray(manifest.runtimeExports[path])).toBe(true)
      expect(manifest.runtimeExports[path].length).toBeGreaterThan(0)
    }
  })

  it('unavailablePaths are not in exportPaths', () => {
    for (const path of manifest.unavailablePaths) {
      expect(manifest.exportPaths).not.toContain(path)
    }
  })

  it('deprecated migrateStructDocument has removalDate 2026-11-30', () => {
    expect(manifest.deprecated.migrateStructDocument.removalDate).toBe('2026-11-30')
    expect(manifest.deprecated.migrateStructDocument.replacement).toBe('decodeCompatibleStructDocument')
  })
})

describe('S-04 release packet: three-run renderer goldens (packed artifact)', () => {
  it('reproduces the frozen baselines three times per variant against the packed artifact', async () => {
    if (!packedTemporary || !packedTarballPath) {
      throw new Error('the packed tarball was not built')
    }
    // The consumer must sit next to the tarball: the `file:` specifier
    // resolves relative to the consumer directory, so a consumer elsewhere
    // would silently install a different (stale) artifact.
    const consumer = join(packedTemporary, 'goldens-consumer')
    await mkdir(consumer, { recursive: true })
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify(
        {
          name: 'struct-s04-goldens',
          private: true,
          type: 'module',
          dependencies: {
            '@erniesg/struct': `file:../${basename(packedTarballPath)}`,
            fflate: '0.8.3',
          },
        },
        null,
        2,
      )}\n`,
    )
    await copyFile(
      join(repository, 'scripts/s04-goldens-packed.mjs'),
      join(consumer, 's04-goldens-packed.mjs'),
    )
    execFileSync(
      'pnpm',
      ['install', '--ignore-scripts', '--offline', '--no-frozen-lockfile'],
      { cwd: consumer, stdio: 'inherit' },
    )
    // The installed artifact must be the artifact that was built above.
    const installedManifestSha256 = createHash('sha256')
      .update(
        await readFile(
          join(consumer, 'node_modules', '@erniesg', 'struct', 'package.json'),
        ),
      )
      .digest('hex')
    const builtManifestSha256 = createHash('sha256')
      .update(await readFile(join(repository, 'package.json')))
      .digest('hex')
    expect(installedManifestSha256).toBe(builtManifestSha256)

    const output = execFileSync(
      process.execPath,
      ['s04-goldens-packed.mjs'],
      { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
    // The script prints its result as a pretty-printed JSON object after the
    // "ALL GOLDENS VERIFIED" marker.
    const marker = '=== ALL GOLDENS VERIFIED ==='
    const markerIndex = output.lastIndexOf(marker)
    const jsonText =
      markerIndex >= 0
        ? output.slice(markerIndex + marker.length).trim()
        : output.slice(output.lastIndexOf('{')).trim()
    if (!jsonText.startsWith('{')) {
      throw new Error('the packed goldens script printed no JSON result')
    }
    const results = JSON.parse(jsonText)

    for (const [variant, frozen] of Object.entries(FROZEN_BASELINES)) {
      const measured = results[variant]
      expect(measured, `variant ${variant} was not measured`).toBeDefined()
      for (const run of ['run1', 'run2', 'run3'] as const) {
        expect(measured[run].xhtmlSha256, `${variant} ${run} xhtml`).toBe(
          frozen.xhtmlSha256,
        )
        expect(measured[run].epubContentSha256, `${variant} ${run} epub`).toBe(
          frozen.epubContentSha256,
        )
        expect(measured[run].epubArchiveSha256, `${variant} ${run} archive`).toBe(
          frozen.epubArchiveSha256,
        )
      }
    }
  }, 600_000)
})

describe('S-04 release packet: regenerability proof', () => {
  it('two independent tarball builds produce identical SHA-256', async () => {
    if (!packedTemporary || !packedTarballSha256) {
      throw new Error('the packed tarball was not built')
    }
    const second = await mkdtemp(join(tmpdir(), 'struct-pack-regen-'))
    try {
      const packed = JSON.parse(
        execFileSync(
          'npm',
          ['pack', '--json', '--pack-destination', second],
          { cwd: repository, encoding: 'utf8' },
        ),
      )
      const metadata = packed[0]
      if (!metadata) throw new Error('npm pack returned no package metadata')
      const secondSha256 = createHash('sha256')
        .update(await readFile(join(second, metadata.filename)))
        .digest('hex')
      expect(secondSha256).toBe(packedTarballSha256)
      expect(secondSha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await rm(second, { recursive: true, force: true })
    }
  }, 300_000)
})
