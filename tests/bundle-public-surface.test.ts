import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import vectors from './fixtures/bundle-canonical/vectors.json'
import {
  decodeStructBundle,
  encodeStructBundle,
} from '../src/bundle/index'

const utf8 = (value: string) => new TextEncoder().encode(value)
const current = vectors.find((value) => value.name === 'current:envelope')!

describe('public ./bundle surface', () => {
  it('accepts frozen canonical wire bytes and re-encodes them exactly', () => {
    const result = decodeStructBundle(utf8(current.canonical))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.bundle.bundleSha256).toBe(current.sha256)
    expect(encodeStructBundle(result.bundle)).toEqual({
      ok: true,
      bytes: utf8(current.canonical),
    })
  })

  it('checks the expected bundle digest before parsing', () => {
    expect(
      decodeStructBundle(utf8('{bad'), {
        expectedBundleSha256: '0'.repeat(64),
      }),
    ).toEqual({ ok: false, error: { stage: 'digest', code: 'MISMATCH' } })
  })

  it('rejects forged handles and keeps verified content immutable', () => {
    const result = decodeStructBundle(utf8(current.canonical))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(encodeStructBundle({ ...result.bundle })).toEqual({
      ok: false,
      error: { stage: 'handle', code: 'FORGED' },
    })
    const snapshot = result.bundle.documentSnapshot()
    expect(() => {
      ;(snapshot as any).documentId = 'mutated'
    }).toThrow()
    const bytes = result.bundle.assetBytes('asset-1')!
    bytes.fill(0)
    expect(result.bundle.assetBytes('asset-1')).toEqual(
      new Uint8Array([0, 255, 128]),
    )
  })

  it('fails closed on external payloads without a resolver', () => {
    const value = JSON.parse(current.canonical)
    value.assets[0].payload = {
      kind: 'external',
      resourceId: `sha256:${value.assets[0].sha256}`,
    }
    const canonical = JSON.stringify(value)
    const result = decodeStructBundle(utf8(canonical))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unexpected acceptance')
    expect(result.error.stage).toBe('assets')
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
    expect(manifest.runtimeExports['./bundle']).toEqual([
      'decodeStructBundle',
      'encodeStructBundle',
    ])
  })
})
