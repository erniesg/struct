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
const temporary = await mkdtemp(join(tmpdir(), 'struct-public-consumer-'))
const consumer = join(temporary, 'consumer')

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
  } catch {
    return { head: null, dirty: null }
  }
}

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
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'],
    { cwd: consumer, stdio: 'inherit' },
  )
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
      source: sourceState(),
    })}\n`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
