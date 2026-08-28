import { execFileSync } from 'node:child_process'
import {
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
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
  const tarball = join(temporary, packed[0].filename)
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
} finally {
  await rm(temporary, { recursive: true, force: true })
}
