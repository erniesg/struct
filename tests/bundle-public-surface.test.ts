import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import vectors from './fixtures/bundle-canonical/vectors.json'
import * as bundle from '../src/bundle/index'
import {
  StructBundleError,
  decodeStructBundle,
  encodeStructBundle,
} from '../src/bundle/index'

const utf8 = (value: string) => new TextEncoder().encode(value)
const current = vectors.find((value) => value.name === 'current:envelope')!

describe('public ./bundle surface', () => {
  it('accepts frozen canonical wire bytes and re-encodes them exactly', async () => {
    const handle = await decodeStructBundle(utf8(current.canonical))
    expect(handle.bundleSha256).toBe(current.sha256)
    expect(encodeStructBundle(handle)).toEqual(utf8(current.canonical))
  })

  it('checks the expected bundle digest before parsing', async () => {
    await expect(
      decodeStructBundle(utf8('{bad'), {
        expectedBundleSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({
      name: 'StructBundleError',
      stage: 'digest',
      code: 'MISMATCH',
    })
  })

  it('rejects forged handles and keeps verified content immutable', async () => {
    const handle = await decodeStructBundle(utf8(current.canonical))
    let forged: unknown
    try {
      encodeStructBundle({ ...handle })
    } catch (error) {
      forged = error
    }
    expect(forged).toBeInstanceOf(StructBundleError)
    expect(forged).toMatchObject({ stage: 'handle', code: 'FORGED' })
    const snapshot = handle.documentSnapshot()
    expect(() => {
      ;(snapshot as any).documentId = 'mutated'
    }).toThrow()
    const bytes = handle.assetBytes('asset-1')!
    bytes.fill(0)
    expect(handle.assetBytes('asset-1')).toEqual(
      new Uint8Array([0, 255, 128]),
    )
  })

  it('fails closed on external payloads without a resolver', async () => {
    const value = JSON.parse(current.canonical)
    value.assets[0].payload = {
      kind: 'external',
      resourceId: `sha256:${value.assets[0].sha256}`,
    }
    const canonical = JSON.stringify(value)
    await expect(decodeStructBundle(utf8(canonical))).rejects.toMatchObject({
      stage: 'assets',
      code: 'UNRESOLVED',
    })
  })

  it('is listed in the export manifest', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const manifest = JSON.parse(await readFile('API_MANIFEST.json', 'utf8'))
    expect(pkg.exports['./bundle']).toEqual({
      types: './dist/bundle/index.d.ts',
      import: './dist/bundle/index.js',
    })
    expect(manifest.exportPaths).toContain('./bundle')
    expect(manifest.unavailablePaths).not.toContain('./bundle')
    // The coordinator owns the package/export-manifest integration lane. This
    // test pins the recorded manifest without editing it from this worktree.
    expect(manifest.runtimeExports['./bundle']).toEqual([
      'STRUCT_BUNDLE_LIMITS_PROFILE',
      'STRUCT_BUNDLE_LIMITS_PROFILE_VERSION',
      'createStructBundle',
      'decodeStructBundle',
      'encodeStructBundle',
      'verifyStructBundle',
    ])
  })

  it('exposes the embedded create/value facade in addition to wire ingress', () => {
    expect(Object.keys(bundle).sort()).toEqual([
      'STRUCT_BUNDLE_LIMITS_PROFILE',
      'STRUCT_BUNDLE_LIMITS_PROFILE_VERSION',
      'StructBundleError',
      'createStructBundle',
      'decodeStructBundle',
      'encodeStructBundle',
      'verifyStructBundle',
    ])
  })
})
