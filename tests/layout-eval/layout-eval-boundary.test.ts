import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const guardPath = fileURLToPath(
  new URL('../../scripts/check-layout-eval-boundary.mjs', import.meta.url),
)
const evaluationRoot = 'evaluation/layout-epub-v2'
const inventedSecret = 'invented-private-sentinel-text'
const redactedPathToken = '<redacted-relative-path>'
const traversalTestSeamEnvironment =
  'STRUCT_LAYOUT_EVAL_BOUNDARY_TEST_SEAM'
const traversalTestSeamValue = 'post-validation-intermediate-swap'
const traversalTestReadyMessage = 'intermediate-directory-validated'
const traversalTestContinueMessage = 'intermediate-substitution-complete'
const temporaryDirectories: string[] = []

type GuardResult = {
  status: number | null
  stderr: string
  stdout: string
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'struct-layout-boundary-'))
  temporaryDirectories.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  await writeRepositoryFile(
    root,
    'package.json',
    `${JSON.stringify({ license: 'MIT' }, null, 2)}\n`,
  )
  await writeRepositoryFile(root, 'README.md', 'Invented boundary sentinel.\n')
  stageRepository(root)
  return root
}

async function writeRepositoryFile(
  root: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const target = join(root, ...relativePath.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

function stageRepository(root: string): void {
  execFileSync('git', ['add', '--all'], { cwd: root })
}

function runGuard(root: string): GuardResult {
  const environment = { ...process.env }
  delete environment[traversalTestSeamEnvironment]
  const result = spawnSync(process.execPath, [guardPath], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
  })
  return {
    status: result.status,
    stderr: result.stderr?.toString() ?? '',
    stdout: result.stdout?.toString() ?? '',
  }
}

async function runGuardWithIntermediateSymlinkSubstitution(
  root: string,
  outside: string,
): Promise<{ result: GuardResult; substitutionOccurred: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [guardPath], {
      cwd: root,
      env: {
        ...process.env,
        [traversalTestSeamEnvironment]: traversalTestSeamValue,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stderr = ''
    let stdout = ''
    let substitutionOccurred = false
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('boundary traversal test seam timed out'))
    }, 10_000)

    function finish(error?: Error, status: number | null = null): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise({
        result: { status, stderr, stdout },
        substitutionOccurred,
      })
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('message', async (message) => {
      if (message !== traversalTestReadyMessage || substitutionOccurred) return
      try {
        await rename(join(root, 'linked'), join(root, 'linked-before-swap'))
        await symlink(outside, join(root, 'linked'), 'dir')
        substitutionOccurred = true
        child.send(traversalTestContinueMessage)
      } catch (error) {
        child.kill()
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.on('close', (status) => finish(undefined, status))
  })
}

function expectContentFreeFailureOutput(result: GuardResult): string {
  expect(result.stdout).toBe('')
  expect(result.stderr).not.toBe('')
  expect(result.stderr.endsWith('\n')).toBe(true)
  for (const line of result.stderr.trimEnd().split('\n'))
    expect(line).toMatch(/^[a-z0-9-]+: <redacted-relative-path>$/u)
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function expectPolicyFailure(
  result: GuardResult,
  policy: string,
  relativePath: string,
): void {
  const output = expectContentFreeFailureOutput(result)
  expect(result.status).toBe(1)
  expect(output).toContain(`${policy}: ${redactedPathToken}`)
  expect(output).not.toContain(relativePath)
  expect(output).not.toContain(inventedSecret)
}

function syntheticManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cases: [
      {
        caseId: 'paragraph-01',
        requiredCategories: ['paragraph'],
        expectedDisposition: 'render',
        goldenEntries: ['content.xhtml', 'container.xml', 'archive.json'],
        provenanceKey: 'paragraph-01-origin',
      },
    ],
    ...overrides,
  }
}

function syntheticProvenance(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    records: [
      {
        provenanceKey: 'paragraph-01-origin',
        origin: 'synthetic',
        authoredOn: '2026-08-30',
        license: 'MIT',
        ...overrides,
      },
    ],
  }
}

async function installSyntheticEvaluation(root: string): Promise<void> {
  await writeRepositoryFile(
    root,
    `${evaluationRoot}/fixtures/manifest.json`,
    `${JSON.stringify(syntheticManifest(), null, 2)}\n`,
  )
  await writeRepositoryFile(
    root,
    `${evaluationRoot}/fixtures/provenance.json`,
    `${JSON.stringify(syntheticProvenance(), null, 2)}\n`,
  )
  await writeRepositoryFile(
    root,
    `${evaluationRoot}/fixtures/paragraph-01.json`,
    '{"invented":true}\n',
  )
  await writeRepositoryFile(
    root,
    `${evaluationRoot}/goldens/paragraph-01/content.xhtml`,
    '<p>Wholly invented public text.</p>\n',
  )
  await writeRepositoryFile(
    root,
    `${evaluationRoot}/goldens/paragraph-01/container.xml`,
    '<container/>\n',
  )
  await writeRepositoryFile(
    root,
    `${evaluationRoot}/goldens/paragraph-01/archive.json`,
    '{"entries":[]}\n',
  )
  stageRepository(root)
}

describe('layout evaluation tracked-file and output boundary', () => {
  it('accepts tracked text and declared synthetic golden expansions', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)

    const result = runGuard(root)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('layout-eval-boundary: ok\n')
  })

  it('inspects staged bytes even when the worktree copy is safe', async () => {
    const root = await createRepository()
    const relativePath = 'sentinels/staged-document.txt'
    await writeRepositoryFile(
      root,
      relativePath,
      Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        Buffer.from(inventedSecret),
      ]),
    )
    stageRepository(root)
    await writeRepositoryFile(root, relativePath, 'Safe invented replacement.\n')

    expectPolicyFailure(
      runGuard(root),
      'forbidden-media-magic',
      relativePath,
    )
  })

  it('inspects unstaged bytes for every tracked worktree file', async () => {
    const root = await createRepository()
    const relativePath = 'sentinels/worktree-document.txt'
    await writeRepositoryFile(root, relativePath, 'Safe invented value.\n')
    stageRepository(root)
    await writeRepositoryFile(
      root,
      relativePath,
      Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        Buffer.from(inventedSecret),
      ]),
    )

    expectPolicyFailure(
      runGuard(root),
      'forbidden-media-magic',
      relativePath,
    )
  })

  it.each(['document.PDF', 'image.PnG'])(
    'rejects prohibited corpus extension %s',
    async (fileName) => {
      const root = await createRepository()
      const relativePath = `sentinels/${fileName}`
      await writeRepositoryFile(root, relativePath, inventedSecret)
      stageRepository(root)

      expectPolicyFailure(
        runGuard(root),
        'forbidden-media-extension',
        relativePath,
      )
    },
  )

  it('never echoes an invented sentinel embedded in a prohibited filename', async () => {
    const root = await createRepository()
    const relativePath = `sentinels/${inventedSecret}.PDF`
    await writeRepositoryFile(root, relativePath, 'Invented public placeholder.\n')
    stageRepository(root)

    const result = runGuard(root)

    expectPolicyFailure(result, 'forbidden-media-extension', relativePath)
    expect(result.stdout).not.toContain(inventedSecret)
    expect(result.stderr).not.toContain(inventedSecret)
  })

  it.each([
    ['portable-document', [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ['portable-network-graphic', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['joint-photographic-experts-group', [0xff, 0xd8, 0xff, 0xe0]],
  ])('rejects %s magic in a text-named file', async (name, magic) => {
    const root = await createRepository()
    const relativePath = `sentinels/${name}.txt`
    await writeRepositoryFile(
      root,
      relativePath,
      Buffer.concat([Buffer.from(magic as number[]), Buffer.from(inventedSecret)]),
    )
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'forbidden-media-magic',
      relativePath,
    )
  })

  it('rejects archive or publication-container extensions', async () => {
    const root = await createRepository()
    const relativePath = 'sentinels/publication.epub'
    await writeRepositoryFile(root, relativePath, inventedSecret)
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'forbidden-archive-extension',
      relativePath,
    )
  })

  it('rejects archive magic hidden behind a text extension', async () => {
    const root = await createRepository()
    const relativePath = 'sentinels/archive.txt'
    await writeRepositoryFile(
      root,
      relativePath,
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from(inventedSecret),
      ]),
    )
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'forbidden-archive-magic',
      relativePath,
    )
  })

  it('inspects ignored evaluation output before it can be staged', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/goldens/paragraph-01/publication.epub`
    await writeRepositoryFile(root, '.gitignore', '*.epub\n')
    stageRepository(root)
    await writeRepositoryFile(root, relativePath, inventedSecret)

    expectPolicyFailure(
      runGuard(root),
      'forbidden-archive-extension',
      relativePath,
    )
  })

  it('rejects oversized evaluation fixture or golden output', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/goldens/paragraph-01/content.xhtml`
    await writeRepositoryFile(root, relativePath, 'Q'.repeat(256 * 1024 + 1))
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'oversized-evaluation-file',
      relativePath,
    )
  })

  it('allows only textual UTF-8 files in the evaluation tree', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/fixtures/paragraph-01.json`
    await writeRepositoryFile(
      root,
      relativePath,
      Buffer.from([0x00, 0xfe, 0x01, 0xfd]),
    )
    stageRepository(root)

    expectPolicyFailure(runGuard(root), 'evaluation-text-only', relativePath)
  })

  it('rejects a suspicious long encoded payload without echoing it', async () => {
    const root = await createRepository()
    const relativePath = 'sentinels/encoded.txt'
    await writeRepositoryFile(
      root,
      relativePath,
      `invented-prefix:${'Q'.repeat(4096)}:${inventedSecret}`,
    )
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'suspicious-encoded-payload',
      relativePath,
    )
  })

  it('rejects absolute home or workspace paths without echoing contents', async () => {
    const root = await createRepository()
    const relativePath = 'sentinels/location.txt'
    const inventedAbsolutePath = posix.join(
      '/',
      'home',
      'invented-user',
      'workspace',
      inventedSecret,
    )
    await writeRepositoryFile(root, relativePath, inventedAbsolutePath)
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'absolute-workspace-path',
      relativePath,
    )
  })

  it('rejects a fixture absent from manifest and provenance', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/fixtures/orphan-01.json`
    await writeRepositoryFile(root, relativePath, '{"invented":true}\n')
    stageRepository(root)

    expectPolicyFailure(runGuard(root), 'undeclared-fixture', relativePath)
  })

  it('rejects a golden directory not linked to exactly one declared case', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/goldens/orphan-01/content.xhtml`
    await writeRepositoryFile(root, relativePath, '<p>Invented orphan.</p>\n')
    stageRepository(root)

    expectPolicyFailure(runGuard(root), 'undeclared-golden', relativePath)
  })

  it.each([
    ['derived', 'MIT'],
    ['synthetic', 'Invented-Other-License'],
  ])(
    'rejects provenance outside the synthetic repository-license allowlist',
    async (origin, license) => {
      const root = await createRepository()
      await installSyntheticEvaluation(root)
      const relativePath = `${evaluationRoot}/fixtures/provenance.json`
      await writeRepositoryFile(
        root,
        relativePath,
        `${JSON.stringify(syntheticProvenance({ origin, license }), null, 2)}\n`,
      )
      stageRepository(root)

      expectPolicyFailure(runGuard(root), 'invalid-provenance', relativePath)
    },
  )

  it('keeps provenance records closed to non-identifying fields', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/fixtures/provenance.json`
    await writeRepositoryFile(
      root,
      relativePath,
      `${JSON.stringify(
        syntheticProvenance({ annotation: inventedSecret }),
        null,
        2,
      )}\n`,
    )
    stageRepository(root)

    expectPolicyFailure(runGuard(root), 'invalid-provenance', relativePath)
  })

  it('keeps fixture manifests closed to declared contract fields', async () => {
    const root = await createRepository()
    await installSyntheticEvaluation(root)
    const relativePath = `${evaluationRoot}/fixtures/manifest.json`
    await writeRepositoryFile(
      root,
      relativePath,
      `${JSON.stringify(
        syntheticManifest({ annotation: inventedSecret }),
        null,
        2,
      )}\n`,
    )
    stageRepository(root)

    expectPolicyFailure(
      runGuard(root),
      'invalid-evaluation-manifest',
      relativePath,
    )
  })

  it('rejects a symlinked component without following it', async () => {
    const root = await createRepository()
    const outside = await mkdtemp(join(tmpdir(), 'struct-layout-outside-'))
    temporaryDirectories.push(outside)
    const relativePath = 'linked/sentinel.txt'
    await writeRepositoryFile(root, relativePath, 'Safe staged sentinel.\n')
    stageRepository(root)
    await rm(join(root, 'linked'), { recursive: true })
    await writeFile(
      join(outside, 'sentinel.txt'),
      Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        Buffer.from(inventedSecret),
      ]),
    )
    await symlink(outside, join(root, 'linked'), 'dir')

    const result = runGuard(root)
    expectPolicyFailure(result, 'unsafe-symlink', 'linked')
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toContain(
      'forbidden-media-magic',
    )
  })

  it('rejects an intermediate symlink substituted after descriptor validation', async () => {
    const root = await createRepository()
    const outside = await mkdtemp(join(tmpdir(), 'struct-layout-outside-'))
    temporaryDirectories.push(outside)
    const relativePath = 'linked/sentinel.txt'
    await writeRepositoryFile(root, relativePath, 'Safe staged sentinel.\n')
    stageRepository(root)
    await writeFile(
      join(outside, 'sentinel.txt'),
      Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        Buffer.from(inventedSecret),
      ]),
    )

    const { result, substitutionOccurred } =
      await runGuardWithIntermediateSymlinkSubstitution(root, outside)

    expect(substitutionOccurred).toBe(true)
    expectPolicyFailure(result, 'unsafe-symlink', relativePath)
    expect(result.stderr).toBe(`unsafe-symlink: ${redactedPathToken}\n`)
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toContain(
      'forbidden-media-magic',
    )
  })

  it('rejects an indexed symlink without reading its invented target', async () => {
    const root = await createRepository()
    const outside = await mkdtemp(join(tmpdir(), 'struct-layout-outside-'))
    temporaryDirectories.push(outside)
    const relativePath = 'sentinel-link'
    await writeFile(
      join(outside, 'target.txt'),
      Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
        Buffer.from(inventedSecret),
      ]),
    )
    await symlink(join(outside, 'target.txt'), join(root, relativePath), 'file')
    stageRepository(root)

    const result = runGuard(root)
    expectPolicyFailure(result, 'unsafe-symlink', relativePath)
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toContain(
      'forbidden-media-magic',
    )
  })

  it('keeps internal repository failures content-free', async () => {
    const root = await mkdtemp(join(tmpdir(), `${inventedSecret}-`))
    temporaryDirectories.push(root)

    const result = runGuard(root)
    const output = expectContentFreeFailureOutput(result)

    expect(result.status).toBe(1)
    expect(result.stderr).toBe(
      `layout-eval-boundary-internal-error: ${redactedPathToken}\n`,
    )
    expect(output).not.toContain(inventedSecret)
    expect(output).not.toContain(root)
  })
})
