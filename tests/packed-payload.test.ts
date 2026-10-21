import { describe, expect, it } from 'vitest'
// @ts-expect-error package-proof helper is untyped ESM script code
import { validatePackedPayload } from '../scripts/packed-payload.mjs'

const packageJson = {
  name: '@erniesg/struct',
  version: '0.0.0',
  files: [
    'dist',
    'LICENSE',
    'README.md',
    'CONTRACT.md',
    'MIGRATION.md',
    'API.md',
    'API_MANIFEST.json',
    'NOTICE',
  ],
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
    './document': {
      types: './dist/document/index.d.ts',
      import: './dist/document/index.js',
    },
  },
  main: './dist/index.js',
  types: './dist/index.d.ts',
}

const packedFiles = [
  'API.md',
  'API_MANIFEST.json',
  'CONTRACT.md',
  'LICENSE',
  'MIGRATION.md',
  'NOTICE',
  'README.md',
  'dist/chunk-ABC123.js',
  'dist/document/index.d.ts',
  'dist/document/index.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/types-ABC123.d.ts',
  'package.json',
]

function validate(files: string[]) {
  return validatePackedPayload({ packageJson, files })
}

function validateWith(
  overrides: Partial<typeof packageJson>,
  files: string[],
) {
  return validatePackedPayload({
    packageJson: { ...packageJson, ...overrides },
    files,
  })
}

describe('packed payload proof', () => {
  it('accepts declared docs, export targets, and dist chunks', () => {
    expect(validate(packedFiles)).toEqual({ files: packedFiles })
  })

  it('rejects a payload missing a required legal document', () => {
    expect(() =>
      validate(packedFiles.filter((path) => path !== 'LICENSE')),
    ).toThrow(/LICENSE/u)
  })

  it('rejects a payload missing a declared export target', () => {
    expect(() =>
      validate(packedFiles.filter((path) => path !== 'dist/document/index.js')),
    ).toThrow(/dist\/document\/index\.js/u)
  })

  it.each([
    'src/index.ts',
    'tests/public-consumer/runtime.mjs',
    'scripts/test-packed-consumer.mjs',
    '.env.local',
  ])('rejects source, test, script, or private debris: %s', (path) => {
    expect(() => validate([...packedFiles, path])).toThrow(
      /unexpected packed path/u,
    )
  })

  it.each([
    'src/leak.ts',
    'tests/leak.js',
    'scripts/leak.mjs',
    'private-notes.txt',
  ])('rejects unapproved package.json files declaration: %s', (path) => {
    expect(() =>
      validateWith({ files: [...packageJson.files, path] }, packedFiles),
    ).toThrow(/unexpected package\.json files entry/u)
  })

  it('rejects a payload missing package.json', () => {
    expect(() =>
      validate(packedFiles.filter((path) => path !== 'package.json')),
    ).toThrow(/package\.json/u)
  })

  it.each([
    '../outside.js',
    '/etc/passwd',
    'dist/../../outside.js',
    'dist\\index.js',
  ])('rejects unsafe packed path: %s', (path) => {
    expect(() => validate([...packedFiles, path])).toThrow(
      /unsafe packed path/u,
    )
  })

  it('rejects unexpected declared-directory content such as source in dist', () => {
    expect(() => validate([...packedFiles, 'dist/index.ts'])).toThrow(
      /unexpected packed path/u,
    )
  })

  it.each([
    'dist/probe.test.js',
    'dist/probe.spec.d.ts',
    'dist/__tests__/probe.js',
    'dist/fixtures/probe.js',
    'dist/src/index.js',
    'dist/test.js',
    'dist/fixture.js',
    'dist/src.js',
    'dist/source.d.ts',
    'dist/tests.js.map',
    'dist/nested/spec.js',
    'dist/__mocks__.js',
  ])('rejects compiled test/spec/fixture/source debris under dist: %s', (path) => {
    expect(() => validate([...packedFiles, path])).toThrow(
      /unexpected packed path/u,
    )
  })
})
