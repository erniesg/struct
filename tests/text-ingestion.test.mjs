import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'

import {
  ingestText,
  inspectText,
  validateCleanupPlan,
} from '../adapters/text/ingest.mjs'

const utf8 = new TextEncoder()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const metadata = {
  title: 'Line fixture',
  subtitle: '',
  authors: [],
  abstract: '',
  language: 'en',
}

describe('text ingestion adapter', () => {
  test('inspects exact Unicode CRLF physical lines and structural whitespace', () => {
    const bytes = utf8.encode('A😀\r\n \r\nβ\n')
    expect(inspectText(bytes)).toEqual({
      schemaVersion: '1.0.0',
      sourceSha256: sha256(bytes),
      byteLength: bytes.byteLength,
      textCharacterCount: 10,
      blocks: [
        { id: 'line-1', text: 'A😀', start: 0, end: 3, line: 1 },
        { id: 'line-3', text: 'β', start: 8, end: 9, line: 3 },
      ],
      whitespace: [
        { start: 3, end: 5 },
        { start: 5, end: 8 },
        { start: 9, end: 10 },
      ],
    })
  })

  test('retains a UTF-8 BOM in exact source offsets and raw conservation', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0a, 0x42])
    expect(inspectText(bytes)).toMatchObject({
      sourceSha256: sha256(bytes), textCharacterCount: 4,
      blocks: [
        { id: 'line-1', text: '\uFEFFA', start: 0, end: 2, line: 1 },
        { id: 'line-2', text: 'B', start: 3, end: 4, line: 2 },
      ],
      whitespace: [{ start: 2, end: 3 }],
    })
    const { report } = await ingestText(bytes, { fileName: 'bom.txt', metadata })
    expect(report).toMatchObject({
      rawSourceTextCharacterCount: 4, structuralWhitespaceCharacterCount: 1,
      conservation: { sourceTextCharacterCount: 3, structTextCharacterCount: 3 },
    })
  })

  test('rejects empty, malformed UTF-8, and resource-exhausting input', () => {
    expect(() => inspectText(new Uint8Array())).toThrow(/nonblank/i)
    expect(() => inspectText(new Uint8Array([0xc3, 0x28]))).toThrow(/utf-8/i)
    expect(() => inspectText(new Uint8Array(1024 * 1024 + 1).fill(0x61))).toThrow(
      /1 MiB|bound/i,
    )
  })

  test('validates sparse cleanup plans and rejects stale, duplicate, unknown, and invalid fields', () => {
    const sourceBytes = utf8.encode('keep\nremove\nreview')
    const request = inspectText(sourceBytes)
    const plan = {
      schemaVersion: '1.0.0',
      sourceSha256: request.sourceSha256,
      actor: 'human',
      decisions: [{ blockId: 'line-2', action: 'remove', reason: 'masthead' }],
    }
    expect(validateCleanupPlan(plan, request)).toEqual(plan)

    for (const invalid of [
      { ...plan, sourceSha256: '0'.repeat(64) },
      { ...plan, decisions: [...plan.decisions, ...plan.decisions] },
      { ...plan, decisions: [{ ...plan.decisions[0], blockId: 'line-9' }] },
      { ...plan, decisions: [{ ...plan.decisions[0], action: 'rewrite' }] },
      { ...plan, decisions: [{ ...plan.decisions[0], reason: '' }] },
      { ...plan, decisions: [{ ...plan.decisions[0], reason: '   ' }] },
      { ...plan, decisions: [{ ...plan.decisions[0], reason: 'a'.repeat(4097) }] },
      { ...plan, extra: true },
    ])
      expect(() => validateCleanupPlan(invalid, request)).toThrow()
  })

  test('rejects model plans without a source-bound consultation and non-data plan fields', () => {
    const request = inspectText(utf8.encode('line'))
    expect(() => validateCleanupPlan({
      schemaVersion: '1.0.0', sourceSha256: request.sourceSha256,
      actor: 'claude', decisions: [],
    }, request)).toThrow(/consultation/i)
    const plan = {
      schemaVersion: '1.0.0', sourceSha256: request.sourceSha256,
      actor: 'human', decisions: [],
    }
    Object.defineProperty(plan, 'actor', { enumerable: true, get: () => 'human' })
    expect(() => validateCleanupPlan(plan, request)).toThrow(/data|accessor/i)
  })

  test('preserves text and source anchors while representing removals as furniture', async () => {
    const bytes = utf8.encode('Article\nMasthead\nBody')
    const { document, report } = await ingestText(bytes, {
      fileName: 'essay.txt',
      metadata,
      cleanupPlan: {
        schemaVersion: '1.0.0',
        sourceSha256: sha256(bytes),
        actor: 'human',
        decisions: [
          { blockId: 'line-2', action: 'remove', reason: 'masthead furniture' },
        ],
      },
    })
    expect(document.source).toMatchObject({
      format: 'unknown', fileName: 'essay.txt', pageCount: 0,
      sha256: sha256(bytes), byteLength: bytes.byteLength,
    })
    expect(document.blocks.map(({ id, kind, text, attributes }) => ({ id, kind, text, attributes }))).toEqual([
      { id: 'line-1', kind: 'paragraph', text: 'Article', attributes: { sourceStart: 0, sourceEnd: 7, sourceLine: 1 } },
      { id: 'line-2', kind: 'furniture', text: 'Masthead', attributes: { sourceStart: 8, sourceEnd: 16, sourceLine: 2 } },
      { id: 'line-3', kind: 'paragraph', text: 'Body', attributes: { sourceStart: 17, sourceEnd: 21, sourceLine: 3 } },
    ])
    expect(document.metadata.artifactModifiedAt).toBe('1970-01-01T00:00:00Z')
    expect(report.decisions).toEqual([{ blockId: 'line-2', action: 'remove', reason: 'masthead furniture' }])
    expect(report.whitespace).toEqual([{ start: 7, end: 8 }, { start: 16, end: 17 }])
    expect(report.conservation.sourceTextCharacterCount).toBe(19)
    expect(report.conservation.structTextCharacterCount).toBe(19)
  })

  test('keeps review text visible, emits recovery diagnostics, and binds model consultations in the receipt', async () => {
    const bytes = utf8.encode('uncertain')
    const { document, report } = await ingestText(bytes, {
      fileName: 'review.txt',
      metadata,
      cleanupPlan: {
        schemaVersion: '1.0.0', sourceSha256: sha256(bytes), actor: 'codex',
        decisions: [{ blockId: 'line-1', action: 'review', reason: 'uncertain furniture' }],
        consultation: { promptSha256: 'a'.repeat(64), model: 'test-model' },
      },
    })
    expect(document.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'uncertain' })
    expect(document.recovery.status).toBe('review-required')
    expect(document.diagnostics).toMatchObject([{ category: 'source', action: 'review-required' }])
    expect(document.receipt.modelConsultations).toMatchObject({
      sourceSha256: sha256(bytes), documentId: document.documentId,
      consultations: [{ actor: 'codex', promptSha256: 'a'.repeat(64), model: 'test-model' }],
      decisions: [{ blockId: 'line-1', action: 'review', reason: 'uncertain furniture' }],
    })
    expect(document.source.localOnly).toBe(false)
    expect(report.decisions).toEqual([{ blockId: 'line-1', action: 'review', reason: 'uncertain furniture' }])
    expect(report.cleanupPlan).toMatchObject({ actor: 'codex', decisions: report.decisions })
    expect(report.modelSourceTransmission).toEqual({ transmitted: true, localityProven: false })
  })

  test('seals codec-safe deterministic documents', async () => {
    const bytes = utf8.encode('same\nbytes')
    const first = await ingestText(bytes, { fileName: 'same.txt', metadata })
    const second = await ingestText(bytes, { fileName: 'same.txt', metadata })
    expect(first.document).toEqual(second.document)
    const { decodeStructDocument, encodeStructDocument } = await import('../dist/document/index.js')
    const { verifyStructReceipt } = await import('../dist/receipt.js')
    const { renderPublicationXhtml } = await import('../dist/renderers/xhtml.js')
    const decoded = decodeStructDocument(first.document)
    expect(verifyStructReceipt(decoded)).toBe(true)
    expect(encodeStructDocument(decoded)).toEqual(encodeStructDocument(second.document))
    expect(renderPublicationXhtml(decoded)).toBe(renderPublicationXhtml(second.document))
  })
})
