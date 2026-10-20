import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { validatePackedPayload } from './packed-payload.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(
  await readFile(join(repository, 'package.json'), 'utf8'),
)

function commandVersion(command) {
  return execFileSync(command, ['--version'], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function selectInstaller() {
  const requested = process.env.STRUCT_PACKED_CONSUMER_INSTALLER
  if (requested !== undefined && requested !== 'pnpm' && requested !== 'npm')
    throw new Error(
      `unknown STRUCT_PACKED_CONSUMER_INSTALLER: ${requested}`,
    )
  if (requested) return { name: requested, version: commandVersion(requested) }
  try {
    return { name: 'pnpm', version: commandVersion('pnpm') }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { name: 'npm', version: commandVersion('npm') }
  }
}

function sourceState() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim()
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      { cwd: repository, encoding: 'utf8' },
    )
    return { head, dirty: status.trim().length > 0 }
  } catch (error) {
    throw new Error(
      `source Git binding unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

const source = sourceState()
const installer = selectInstaller()
const installArguments =
  installer.name === 'pnpm'
    ? ['install', '--ignore-scripts', '--offline', '--no-frozen-lockfile']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline']
const installEnvironment =
  installer.name === 'npm'
    ? { ...process.env, RUCKSACK_NPM_SHIM: 'passthrough' }
    : process.env
const temporary = await mkdtemp(join(tmpdir(), 'struct-public-consumer-'))
const consumer = join(temporary, 'consumer')

try {
  const packed = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', temporary],
      { cwd: repository, encoding: 'utf8' },
    ),
  )
  const metadata = packed[0]
  if (!metadata) throw new Error('npm pack returned no package metadata')
  if (
    metadata.name !== packageJson.name ||
    metadata.version !== packageJson.version
  )
    throw new Error(
      `packed package identity mismatch: ${metadata.name}@${metadata.version}`,
    )

  const tarball = join(temporary, metadata.filename)
  const { files: packedFiles } = validatePackedPayload({
    packageJson,
    files: metadata.files ?? [],
  })
  const tarballSha256 = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex')

  await mkdir(consumer)
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'struct-packed-consumer',
        private: true,
        type: 'module',
        dependencies: { '@erniesg/struct': `file:../${basename(tarball)}` },
      },
      null,
      2,
    )}\n`,
  )
  await copyFile(
    join(repository, 'tests/public-consumer/runtime.mjs'),
    join(consumer, 'runtime.mjs'),
  )
  await copyFile(
    join(repository, 'tests/public-consumer/types.ts'),
    join(consumer, 'types.ts'),
  )
  const resolutionPaths =
    createRequire(join(consumer, 'runtime.mjs')).resolve.paths(
      '__struct_isolation_probe__',
    ) ?? []
  if (resolutionPaths.includes(join(repository, 'node_modules')))
    throw new Error('packed consumer can resolve producer node_modules')
  execFileSync(installer.name, installArguments, {
    cwd: consumer,
    stdio: 'inherit',
    env: installEnvironment,
  })
  execFileSync(process.execPath, ['runtime.mjs'], {
    cwd: consumer,
    stdio: 'inherit',
  })
  execFileSync(
    process.execPath,
    [
      join(repository, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--strict',
      'types.ts',
    ],
    { cwd: consumer, stdio: 'inherit' },
  )

  const finalSource = sourceState()
  if (
    finalSource.head !== source.head ||
    finalSource.dirty !== source.dirty
  )
    throw new Error('source Git state changed during packed-consumer verification')

  // Optional outside-repo artifact retention (honest identity, no hiding dirty).
  const artifactDir = process.env.STRUCT_PACKED_CONSUMER_ARTIFACT_DIR
  if (artifactDir) {
    const artifactPath = join(artifactDir)
    await mkdir(artifactPath, { recursive: true })
    const retainedTarball = join(artifactPath, metadata.filename)
    await copyFile(tarball, retainedTarball)
    const retainedTarballSha256 = createHash('sha256')
      .update(await readFile(retainedTarball))
      .digest('hex')
    if (retainedTarballSha256 !== tarballSha256)
      throw new Error('retained tarball digest mismatch')
    const proofRecord = {
      schemaVersion: '1.0.0',
      package: { name: packageJson.name, version: packageJson.version },
      source: finalSource,
      tarball: {
        filename: metadata.filename,
        sha256: tarballSha256,
        retainedPath: retainedTarball,
        retainedDigestVerified: retainedTarballSha256 === tarballSha256,
      },
      packedFiles,
      installer: { ...installer, arguments: installArguments },
      note: 'interim proof only; coordinator owns final release/evidence. Dirty identity preserved honestly.',
    }
    await writeFile(
      join(artifactPath, `proof-${finalSource.head}.json`),
      `${JSON.stringify(proofRecord, null, 2)}\n`,
    )
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      package: { name: packageJson.name, version: packageJson.version },
      exportPaths: Object.keys(packageJson.exports),
      packedFiles,
      tarball: {
        filename: metadata.filename,
        sha256: tarballSha256,
      },
      installer: { ...installer, arguments: installArguments },
      source: finalSource,
    })}\n`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
