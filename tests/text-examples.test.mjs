import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

import { checkExamples, loadExampleManifest } from '../adapters/text/check-examples.mjs'

const paths = []
afterEach(async () => Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

const root = fileURLToPath(new URL('../adapters/text/examples/', import.meta.url))

describe('text example regressions', () => {
  test('committed manifests describe source-bound, human cleanup decisions without prose', async () => {
    for (const slug of ['total-eclipse', 'now-we-are-five']) {
      const manifest = await loadExampleManifest(join(root, slug, 'manifest.json'))
      const plan = JSON.parse(await readFile(join(root, slug, 'cleanup-plan.json'), 'utf8'))
      expect(manifest).toMatchObject({ schemaVersion: '1.0.0', slug, source: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), nonblankLineCount: expect.any(Number) }, expected: { visibleParagraphCount: expect.any(Number), visibleNoteCount: expect.any(Number) } })
      expect(plan).toMatchObject({ schemaVersion: '1.0.0', sourceSha256: manifest.source.sha256, actor: 'human' })
      expect(plan.decisions).toHaveLength(manifest.source.nonblankLineCount - manifest.expected.visibleParagraphCount)
      expect(plan.decisions.every(({ action, reason }) => action === 'remove' && typeof reason === 'string' && reason.length > 0)).toBe(true)
    }
  })

  test('preserves a synthetic U+2028 paste artifact while independently validating cleanup and producing an EPUB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'struct-text-examples-')); paths.push(dir)
    const source = join(dir, 'source.txt'); const out = join(dir, 'out')
    const bytes = Buffer.from('Header\n\nIstayed\u2028unaltered\nFooter\n')
    await writeFile(source, bytes)
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    const metadataPath = join(dir, 'metadata.json'); const planPath = join(dir, 'cleanup.json'); const manifestPath = join(dir, 'manifest.json')
    await writeFile(metadataPath, JSON.stringify({ title: 'Fixture', subtitle: '', authors: [], abstract: '', language: 'en' }))
    await writeFile(planPath, JSON.stringify({ schemaVersion: '1.0.0', sourceSha256: sha256, actor: 'human', decisions: [{ blockId: 'line-1', action: 'remove', reason: 'header furniture' }, { blockId: 'line-4', action: 'remove', reason: 'footer furniture' }] }))
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: '1.0.0', slug: 'fixture', source: { sha256, nonblankLineCount: 3 }, metadata: 'metadata.json', cleanupPlan: 'cleanup.json', expected: { visibleParagraphCount: 1, visibleNoteCount: 0, visibleNoteLineIds: [], visibleLineIds: ['line-3'] } }))
    await expect(checkExamples([{ manifestPath, sourcePath: source }], { out })).resolves.toEqual([{ slug: 'fixture', visibleParagraphCount: 1, totalBlockCount: 3 }])
    await expect(readFile(join(out, 'fixture.epub'))).resolves.toBeInstanceOf(Buffer)
    await expect(checkExamples([{ manifestPath, sourcePath: source }], { out })).rejects.toThrow(/already exists/i)
  })

  test('skips the private fixtures with a clear reason when they are unavailable', async () => {
    try { await access(join(root, 'private', 'total-eclipse.txt')); return } catch {}
    await expect(checkExamples()).resolves.toMatchObject({ skipped: expect.stringMatching(/private/i) })
  })
})
