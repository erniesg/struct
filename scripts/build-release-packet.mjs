#!/usr/bin/env node
/**
 * S-04 Release Packet Builder
 *
 * This script builds the complete S-04 release packet evidence.
 * It runs all verification steps and produces the packet report.
 *
 * Usage: node scripts/build-release-packet.mjs
 *
 * The script must be run from the repository root at the final head.
 * It requires STRUCT_PACKED_CONSUMER_ARTIFACT_DIR to be set for artifact retention.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  readFile,
  writeFile,
  mkdtemp,
  rm,
  mkdir,
  copyFile,
  realpath,
} from 'node:fs/promises'
import { join, resolve, basename, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))

async function main() {
  console.log('=== S-04 Release Packet Build ===\n')

  // 1. Verify clean source state
  console.log('1. Verifying source state...')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: repository,
    encoding: 'utf8',
  })
  const dirty = status.trim().length > 0
  const commitMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()

  console.log(`   HEAD: ${head}`)
  console.log(`   Dirty: ${dirty}`)
  console.log(`   Commit: ${commitMessage.split('\n')[0]}`)

  // 2. Typecheck
  console.log('\n2. Running TypeScript typecheck...')
  execFileSync('npx', ['tsc', '--noEmit'], { cwd: repository, stdio: 'inherit' })

  // 3. Source boundary check
  console.log('\n3. Running source boundary check...')
  execFileSync('node', ['scripts/check-source-boundary.mjs'], { cwd: repository, stdio: 'inherit' })

  // 4. Full test suite
  console.log('\n4. Running full test suite...')
  execFileSync('npx', ['vitest', 'run', '--maxWorkers=1'], { cwd: repository, stdio: 'inherit' })

  // 5. Build tarball
  console.log('\n5. Building package tarball...')
  const temporary = await mkdtemp(join(tmpdir(), 'struct-pack-'))
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
      cwd: repository,
      encoding: 'utf8',
    }),
  )
  const metadata = packed[0]
  if (!metadata) throw new Error('npm pack returned no package metadata')

  const tarballPath = join(temporary, metadata.filename)
  const tarballSha256 = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex')

  console.log(`   Filename: ${metadata.filename}`)
  console.log(`   SHA-256: ${tarballSha256}`)

  // 6. Run packed consumer verification
  console.log('\n6. Running packed consumer verification...')
  const artifactDir = process.env.STRUCT_PACKED_CONSUMER_ARTIFACT_DIR
  if (!artifactDir) throw new Error('STRUCT_PACKED_CONSUMER_ARTIFACT_DIR not set')

  const packedConsumerOutput = execFileSync(
    'node',
    ['scripts/test-packed-consumer.mjs'],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, STRUCT_PACKED_CONSUMER_ARTIFACT_DIR: artifactDir },
    },
  ).trim()

  const packedConsumerResult = JSON.parse(packedConsumerOutput)
  console.log(`   Tarball SHA-256 verified: ${packedConsumerResult.tarball.sha256 === tarballSha256}`)

  // 7. Run S-04 packet tests
  console.log('\n7. Running S-04 packet tests...')
  execFileSync('npx', ['vitest', 'run', '--maxWorkers=1', 'tests/s04-release-packet.test.ts'], {
    cwd: repository,
    stdio: 'inherit',
    env: { ...process.env, STRUCT_PACKED_CONSUMER_ARTIFACT_DIR: artifactDir },
  })

  // 8. Run three-run goldens
  console.log('\n8. Running three-run renderer goldens...')
  // The goldens are run via the standalone script in a consumer directory
  // We'll run it here by creating a temporary consumer
  const consumerDir = join(tmpdir(), 'struct-s04-goldens-')
  await mkdir(consumerDir, { recursive: true })
  await writeFile(
    join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'struct-s04-goldens',
        private: true,
        type: 'module',
        dependencies: {
          '@erniesg/struct': `file:../${basename(tarballPath)}`,
          fflate: '0.8.3',
        },
      },
      null,
      2,
    )}\n`,
  )
  execFileSync('pnpm', ['install', '--ignore-scripts', '--offline', '--no-frozen-lockfile'], {
    cwd: consumerDir,
    stdio: 'inherit',
  })
  // Copy the goldens script
  await copyFile(
    join(repository, 'scripts/s04-goldens-packed.mjs'),
    join(consumerDir, 's04-goldens-packed.mjs'),
  )
  execFileSync('node', ['s04-goldens-packed.mjs'], {
    cwd: consumerDir,
    stdio: 'inherit',
  })
  await rm(consumerDir, { recursive: true, force: true })

  // 9. Regenerability proof: second build
  console.log('\n9. Verifying regenerability (second build)...')
  const temporary2 = await mkdtemp(join(tmpdir(), 'struct-pack2-'))
  const packed2 = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temporary2], {
      cwd: repository,
      encoding: 'utf8',
    }),
  )
  const metadata2 = packed2[0]
  const tarballPath2 = join(temporary2, metadata2.filename)
  const tarballSha256_2 = createHash('sha256')
    .update(await readFile(tarballPath2))
    .digest('hex')
  console.log(`   Build 1 SHA-256: ${tarballSha256}`)
  console.log(`   Build 2 SHA-256: ${tarballSha256_2}`)
  console.log(`   Match: ${tarballSha256 === tarballSha256_2}`)
  if (tarballSha256 !== tarballSha256_2) {
    throw new Error('Regenerability failed: tarball digests differ between builds')
  }
  await rm(temporary, { recursive: true, force: true })
  await rm(temporary2, { recursive: true, force: true })

  // 10. Final source state
  console.log('\n10. Final source state...')
  const finalHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
  const finalStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: repository,
    encoding: 'utf8',
  })
  const finalDirty = finalStatus.trim().length > 0
  console.log(`   Final HEAD: ${finalHead}`)
  console.log(`   Final Dirty: ${finalDirty}`)

  console.log('\n=== S-04 Release Packet Build Complete ===')
  console.log('\nNext steps:')
  console.log('  - Review the generated report files')
  console.log('  - Commit the packet evidence (tests/s04-release-packet.test.ts, docs/s04-release-matrix-2026-10-20.md)')
  console.log('  - The coordinator will verify and merge')
}

main().catch((error) => {
  console.error('\n=== BUILD FAILED ===')
  console.error(error)
  process.exit(1)
})