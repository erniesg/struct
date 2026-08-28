import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const acceptedExports = [
  '.',
  './document',
  './identity',
  './ordering',
  './receipt',
  './recovery',
  './renderers/xhtml',
  './renderers/epub',
]

const stableIdentityExports = [
  'CREDENTIAL_SHAPED_ID_PATTERNS',
  'SAFE_ID',
  'SAFE_ID_FORMAT',
  'credentialShapedValue',
  'structDigest',
  'structId',
]

describe('STRUCT package API manifest', () => {
  it('exposes only the accepted S-02 package subpaths', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
    expect(Object.keys(packageJson.exports)).toEqual(acceptedExports)
  })

  it('records the deterministic API and bounded migration alias', async () => {
    const manifest = JSON.parse(await readFile('API_MANIFEST.json', 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: '1.0.0',
      packageName: '@erniesg/struct',
      exportPaths: acceptedExports,
      deprecated: {
        migrateStructDocument: {
          replacement: 'decodeCompatibleStructDocument',
          removalDate: '2026-11-30',
          behavior: 'decode-compatibility',
        },
      },
    })
    expect(manifest.runtimeExports['./identity']).toEqual(
      stableIdentityExports,
    )
  })
})
