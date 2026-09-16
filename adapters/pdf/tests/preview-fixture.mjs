#!/usr/bin/env node
// Build a finished pdf2epub job directory without running Docling.
//
//   node preview-fixture.mjs --out <data-dir> [--struct-dir <checkout>]
//
// Extraction takes minutes per paper and the preview does not depend on it, so
// the fixture writes its own two-page PDF and its own StructDocument draft by
// hand and asks render.mjs for the rest. What comes out is the shape the
// service produces after a real conversion — <job>/<stem>.pdf, <job>/job.json
// and <job>/work/<stem>/ with the draft, struct.json and one EPUB per profile
// — so the route tests and the Playwright test can point the service at it.
//
// Prints the job id on stdout.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = resolve(HERE, '..')
const STEM = 'preview-fixture'
const PROFILES = [
  { id: 'paperPro', suffix: 'paperpro', label: 'reMarkable Paper Pro' },
  { id: 'paperProMove', suffix: 'papermove', label: 'reMarkable Paper Pro Move' },
]

// --------------------------------------------------------------- the source PDF

/** A two-page PDF assembled here so the repository carries no opaque binary. */
function buildPdf (pages) {
  const objects = []
  const add = (body) => { objects.push(body); return `${objects.length} 0 R` }
  const contents = pages.map((lines) => {
    const stream = ['BT', '/F1 16 Tf', '72 700 Td', '20 TL']
      .concat(lines.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`))
      .concat(['ET']).join('\n')
    return add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  })
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageRefs = []
  // The catalog and the page tree are written last so their object numbers are
  // known; placeholders keep the reference syntax honest meanwhile.
  const pagesRef = `${objects.length + pages.length + 1} 0 R`
  for (const content of contents) {
    pageRefs.push(add(`<< /Type /Page /Parent ${pagesRef} /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${font} >> >> /Contents ${content} >>`))
  }
  const tree = add(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${tree} >>`)

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const startxref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const PAGE_TEXT = [
  ['A Short Paper for the Preview Fixture', '', 'Abstract', '',
   'This document exists so the preview can be driven without', 'a Docling run behind it.'],
  ['1  Introduction', '', 'The second page carries one heading and one', 'paragraph, both mapped back to this page.'],
]

// ------------------------------------------------------------------- the draft

function block (index, kind, text, page, box, attributes) {
  return {
    id: `b-${String(index).padStart(4, '0')}-${kind}`,
    kind,
    text,
    page,
    order: index - 1,
    column: 'single',
    inline: [],
    ...(attributes ? { attributes } : {}),
    evidence: {
      confidence: 1,
      pages: [page],
      boxes: [{ page, rotation: 0, ...box }],
      sourceIds: [`texts-${index - 1}`],
      signals: ['fixture'],
    },
  }
}

function buildDraft (sha256, byteLength) {
  const blocks = [
    block(1, 'heading', 'Abstract', 1, { x: 0.117, y: 0.128, width: 0.16, height: 0.021 }, { level: 2 }),
    block(2, 'paragraph', 'This document exists so the preview can be driven without a Docling run behind it.',
      1, { x: 0.117, y: 0.178, width: 0.62, height: 0.05 }),
    block(3, 'heading', '1 Introduction', 2, { x: 0.117, y: 0.103, width: 0.3, height: 0.021 }, { level: 2 }),
    block(4, 'paragraph', 'The second page carries one heading and one paragraph, both mapped back to this page.',
      2, { x: 0.117, y: 0.153, width: 0.62, height: 0.05 }),
  ]
  const text = blocks.reduce((total, one) => total + one.text.length, 0)
  return {
    schemaVersion: '0.2.0',
    documentId: `doc-${sha256.slice(0, 24)}`,
    source: { format: 'pdf', fileName: `${STEM}.pdf`, sha256, byteLength, pageCount: 2, localOnly: true },
    metadata: {
      title: 'A Short Paper for the Preview Fixture',
      subtitle: '',
      authors: [],
      abstract: blocks[1].text,
    },
    blocks,
    assets: [],
    relationships: [],
    pages: [1, 2].map((page) => ({
      page,
      width: 612,
      height: 792,
      rotation: 0,
      blocks: blocks.filter((one) => one.page === page).map((one) => one.id),
      columns: [{
        id: `p${page}-single`,
        side: 'single',
        blockIds: blocks.filter((one) => one.page === page).map((one) => one.id),
      }],
    })),
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Fixture draft',
      summary: `${blocks.length} blocks, 0 assets, 0 relationships, 0 diagnostics.`,
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: `doc-${sha256.slice(0, 24)}`,
      sourceSha256: sha256,
      conservation: {
        sourceNodeCount: blocks.length,
        accountedSourceNodeCount: blocks.length,
        sourceRegionCount: blocks.length,
        accountedSourceRegionCount: blocks.length,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceTextCharacterCount: text,
      },
    },
  }
}

// -------------------------------------------------------------------- assembly

function main () {
  const argv = process.argv.slice(2)
  let out = null
  let structDir = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') out = argv[++index]
    else if (argv[index] === '--struct-dir') structDir = argv[++index]
    else throw new Error(`unknown option ${argv[index]}`)
  }
  if (!out) throw new Error('usage: preview-fixture.mjs --out <data-dir> [--struct-dir <dir>]')

  const pdf = buildPdf(PAGE_TEXT)
  const sha256 = createHash('sha256').update(pdf).digest('hex')
  // Deterministic, so a rebuilt fixture reuses the same job id and URL.
  const jobId = createHash('sha256').update(`preview-fixture:${sha256}`).digest('hex').slice(0, 32)
  const root = join(resolve(out), jobId)
  const work = join(root, 'work', STEM)
  mkdirSync(work, { recursive: true })
  writeFileSync(join(root, `${STEM}.pdf`), pdf)
  const draftPath = join(work, `${STEM}.struct-draft.json`)
  writeFileSync(draftPath, JSON.stringify(buildDraft(sha256, pdf.byteLength)))

  const command = ['--out', work, '--profiles', PROFILES.map((one) => one.id).join(',')]
  if (structDir) command.push('--struct-dir', structDir)
  const rendered = spawnSync('node', [join(ADAPTER, 'render.mjs'), draftPath, ...command], { encoding: 'utf8' })
  if (rendered.status !== 0) {
    throw new Error(`render.mjs failed (${rendered.status}): ${rendered.stdout}${rendered.stderr}`)
  }
  const report = JSON.parse(rendered.stdout.trim().split('\n').pop())
  if (report.errors?.length) throw new Error(`render.mjs refused the fixture draft: ${JSON.stringify(report.errors)}`)

  const stamp = '2026-01-01T00:00:00+00:00'
  writeFileSync(join(root, 'run.log'), 'fixture job: render.mjs only, no extraction\n')
  writeFileSync(join(root, 'job.json'), JSON.stringify({
    id: jobId,
    originalName: `${STEM}.pdf`,
    storedName: `${STEM}.pdf`,
    stem: STEM,
    sha256,
    bytes: pdf.byteLength,
    pages: 2,
    profiles: PROFILES.map((one) => one.id),
    status: 'done',
    createdAt: stamp,
    startedAt: stamp,
    finishedAt: stamp,
    seconds: 0,
    files: PROFILES.map((one) => ({
      profile: one.id,
      label: one.label,
      name: `${STEM}-${one.suffix}.epub`,
      bytes: statSync(join(work, `${STEM}-${one.suffix}.epub`)).size,
    })),
    summary: null,
  }, null, 1))
  process.stdout.write(`${jobId}\n`)
}

main()
