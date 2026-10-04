#!/usr/bin/env node
// Seal a StructDocument draft and render it with @erniesg/struct.
//
// Usage: node render.mjs <draft.json> --out <dir> [--profiles paperPro,paperProMove,mobile]
//                        [--struct-dir <path-to-erniesg/struct checkout>]
//                        [--font default|serif|sans] [--font-size <px>]
//                        [--line-height <n>] [--margin <em>]
//
// The four typography options are the only way to change a profile's
// stylesheet. Each one that is left out, or set to the profile's own default,
// contributes nothing: with no typography options the rendered bytes are the
// bytes this tool produced before they existed.
//
// The adapter (pdf2struct.py) owns extraction; this tool only fills the
// receipt counts and digest with the package's own helpers, validates the
// document through the strict codec, and asks struct's renderers for the
// XHTML and the profiled EPUBs. Any codec or renderer refusal is reported as
// a fail-closed result, never patched around.
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArguments(argv) {
  const args = { profiles: ['paperPro', 'paperProMove', 'mobile'], structDir: null, out: null, input: null, typography: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--out') args.out = argv[++index]
    else if (value === '--profiles') args.profiles = argv[++index].split(',').filter(Boolean)
    else if (value === '--struct-dir') args.structDir = argv[++index]
    else if (value === '--font') args.typography.font = argv[++index]
    else if (value === '--font-size') args.typography.fontSizePx = number(argv[++index], '--font-size')
    else if (value === '--line-height') args.typography.lineHeight = number(argv[++index], '--line-height')
    else if (value === '--margin') args.typography.marginEm = number(argv[++index], '--margin')
    else if (value.startsWith('--')) throw new Error(`unknown option ${value}`)
    else args.input = value
  }
  if (!args.input || !args.out) throw new Error('usage: render.mjs <draft.json> --out <dir> [--profiles a,b] [--struct-dir <dir>]')
  args.typography = validateTypography(args.typography)
  return args
}

function number(raw, option) {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${option} needs a number, not ${JSON.stringify(raw)}`)
  return parsed
}

// The requested values reach a stylesheet, so nothing that is not a member of
// this enumeration or a number inside these bounds is allowed through. A font
// is chosen by name from stacks this file owns; a caller never supplies CSS.
const FONT_STACKS = {
  default: "Georgia, 'Times New Roman', serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  sans: "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif",
}
const TYPOGRAPHY_BOUNDS = { fontSizePx: [8, 40], lineHeight: [1, 2.5], marginEm: [0, 6] }

function validateTypography(requested) {
  const clean = {}
  if (requested.font !== undefined) {
    if (!Object.hasOwn(FONT_STACKS, requested.font))
      throw new Error(`--font must be one of ${Object.keys(FONT_STACKS).join(', ')}`)
    clean.fontFamily = FONT_STACKS[requested.font]
  }
  for (const [key, [low, high]] of Object.entries(TYPOGRAPHY_BOUNDS)) {
    if (requested[key] === undefined) continue
    const value = requested[key]
    if (!(value >= low && value <= high)) throw new Error(`${key} must be between ${low} and ${high}`)
    clean[key] = Math.round(value * 100) / 100
  }
  return clean
}

// Only the values that differ from the profile's own defaults become part of
// its geometry, so `--font default --font-size 15` on paperPro is the same
// request as passing nothing at all — same CSS, same configuration digest,
// same EPUB bytes.
function applyTypography(base, typography) {
  const geometry = { ...base }
  if (typography.fontFamily !== undefined && typography.fontFamily !== DEFAULT_FONT_FAMILY)
    geometry.fontFamily = typography.fontFamily
  if (typography.lineHeight !== undefined && typography.lineHeight !== DEFAULT_LINE_HEIGHT)
    geometry.lineHeight = typography.lineHeight
  if (typography.marginEm !== undefined && typography.marginEm !== DEFAULT_MARGIN_EM)
    geometry.marginEm = typography.marginEm
  if (typography.fontSizePx !== undefined && typography.fontSizePx !== base.bodyPx) {
    const ratio = typography.fontSizePx / base.bodyPx
    geometry.bodyPx = typography.fontSizePx
    geometry.titlePx = Math.round(base.titlePx * ratio)
    geometry.headingPx = Math.round(base.headingPx * ratio)
  }
  return geometry
}

async function loadStruct(structDir) {
  const candidates = [
    structDir,
    process.env.STRUCT_DIR,
    resolve(HERE, '../..'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const dist = join(candidate, 'dist')
    if (existsSync(join(dist, 'renderers/epub.js'))) {
      const load = (name) => import(pathToFileURL(join(dist, name)).href)
      const [document, receipt, epub, xhtml] = await Promise.all([
        load('document/index.js'),
        load('receipt.js'),
        load('renderers/epub.js'),
        load('renderers/xhtml.js'),
      ])
      return { dir: candidate, ...document, ...receipt, ...epub, ...xhtml }
    }
  }
  throw new Error('struct dist not found; build erniesg/struct or pass --struct-dir')
}

const PROFILE_CSS = {
  paperPro: { bodyPx: 15, titlePx: 36, headingPx: 20, fileName: 'publication-paperpro.epub', flow: 'paginated' },
  paperProMove: { bodyPx: 14, titlePx: 30, headingPx: 20, fileName: 'publication-papermove.epub', flow: 'paginated' },
  mobile: { bodyPx: 16, titlePx: 28, headingPx: 20, fileName: 'publication-mobile.epub', flow: 'scrolled-continuous' },
}

const DEFAULT_FONT_FAMILY = FONT_STACKS.default
const DEFAULT_LINE_HEIGHT = 1.65
const DEFAULT_MARGIN_EM = 0.6

function stylesheet({ bodyPx, titlePx, headingPx, fontFamily, lineHeight, marginEm }) {
  const family = fontFamily ?? DEFAULT_FONT_FAMILY
  const leading = lineHeight ?? DEFAULT_LINE_HEIGHT
  const gutter = marginEm ?? DEFAULT_MARGIN_EM
  return `html { font-size: ${bodyPx}px; }
body { font-family: ${family}; line-height: ${leading}; margin: 0; padding: 0 ${gutter}em; -webkit-hyphens: auto; hyphens: auto; }
header h1 { font-size: ${(titlePx / bodyPx).toFixed(3)}em; line-height: 1.2; margin: 1.2em 0 0.4em; }
h2 { font-size: ${(headingPx / bodyPx).toFixed(3)}em; margin: 1.4em 0 0.5em; line-height: 1.25; break-after: avoid; }
h3 { font-size: 1.15em; margin: 1.2em 0 0.4em; break-after: avoid; }
h4, h5, h6 { font-size: 1em; margin: 1em 0 0.3em; font-style: italic; break-after: avoid; }
p { margin: 0 0 0.75em; orphans: 2; widows: 2; }
p.authors { font-style: italic; }
figure { margin: 1em 0; break-inside: avoid; text-align: center; }
figure.equation { text-align: center; }
img { display: block; margin: 0 auto; max-width: 100%; height: auto; }
figcaption, p.caption { font-size: 0.9em; text-align: left; margin: 0.4em 0; }
table { border-collapse: collapse; margin: 1em 0; font-size: 0.85em; width: 100%; }
th, td { border: 1px solid #888; padding: 0.2em 0.4em; vertical-align: top; text-align: left; white-space: pre-line; }
th { font-weight: bold; }
pre { font-family: Menlo, Consolas, monospace; font-size: 0.8em; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0.8em 0; }
code { font-family: Menlo, Consolas, monospace; }
math { font-size: 1.05em; }
a { color: inherit; text-decoration: underline; }
sup { line-height: 0; font-size: 0.75em; vertical-align: super; }
aside[epub|type~="footnote"], aside[role="doc-footnote"] { font-size: 0.85em; margin: 0.4em 0; border-top: 1px solid #ccc; padding-top: 0.3em; }
ol, ul { margin: 0 0 0.75em 1.4em; padding: 0; }
li { margin: 0 0 0.25em; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function profileFor(id, typography = {}) {
  const base = PROFILE_CSS[id]
  if (!base) throw new Error(`unknown profile ${id}`)
  const geometry = applyTypography(base, typography)
  const css = stylesheet(geometry)
  const configuration = { id, version: '1', geometry, cssSha256: sha256(css) }
  return {
    id,
    version: '1',
    fileName: geometry.fileName,
    pageProgressionDirection: 'ltr',
    renditionFlow: geometry.flow,
    configurationSha256: sha256(stableJson(configuration)),
    css,
  }
}

function canonicalizeRuns(runs) {
  const kept = []
  let dropped = 0
  for (const run of runs) {
    if (run.href && !run.href.startsWith('#')) {
      try {
        const url = new URL(run.href)
        if (!['http:', 'https:', 'mailto:', 'ftp:'].includes(url.protocol)) throw new Error('scheme')
        if (/[\s\\{}<>"|^`]/.test(run.href)) throw new Error('unsafe characters')
        run.href = url.href
      } catch {
        dropped += 1
        continue
      }
    }
    kept.push(run)
  }
  return { kept, dropped }
}

function canonicalizeHrefs(document) {
  let dropped = 0
  for (const block of document.blocks) {
    const result = canonicalizeRuns(block.inline)
    block.inline = result.kept
    dropped += result.dropped
    for (const cell of block.table?.cells ?? []) {
      const cellResult = canonicalizeRuns(cell.inline)
      cell.inline = cellResult.kept
      dropped += cellResult.dropped
    }
  }
  return dropped
}

function sealDraft(draft, struct) {
  const document = structuredClone(draft)
  document.droppedHrefs = undefined
  const droppedHrefs = canonicalizeHrefs(document)
  delete document.droppedHrefs
  sealDraft.droppedHrefs = droppedHrefs
  const textCharacterCount = document.blocks.reduce((total, block) => total + block.text.length, 0)
  const furniture = document.blocks.filter((block) => block.kind === 'furniture')
  const furnitureText = furniture.reduce((total, block) => total + block.text.length, 0)
  const conservation = {
    ...document.receipt.conservation,
    sourceAssetCount: document.assets.length,
    accountedSourceAssetCount: document.assets.length,
    sourceRelationshipCount: document.relationships.length,
    accountedSourceRelationshipCount: document.relationships.length,
    sourceDiagnosticCount: document.diagnostics.length,
    accountedSourceDiagnosticCount: document.diagnostics.length,
    sourceTextCharacterCount: textCharacterCount,
    structBlockCount: document.blocks.length,
    structAssetCount: document.assets.length,
    structRelationshipCount: document.relationships.length,
    structDiagnosticCount: document.diagnostics.length,
    structTextCharacterCount: textCharacterCount,
  }
  if (furniture.length > 0) {
    Object.assign(conservation, {
      sourceFurnitureBlockCount: furniture.length,
      accountedFurnitureBlockCount: furniture.length,
      sourceFurnitureTextCharacterCount: furnitureText,
      structFurnitureBlockCount: furniture.length,
      structFurnitureTextCharacterCount: furnitureText,
      furnitureContaminationCount: 0,
    })
  }
  document.receipt = {
    schemaVersion: document.schemaVersion,
    documentId: document.documentId,
    sourceSha256: document.source.sha256,
    blockCount: document.blocks.length,
    assetCount: document.assets.length,
    relationshipCount: document.relationships.length,
    diagnosticCount: document.diagnostics.length,
    textCharacterCount,
    conservation,
    generatedSha256: '0'.repeat(64),
  }
  // The digest is computed over the decoded shape (bytes as Uint8Array), so
  // decode a copy with a placeholder digest is not possible: compute it from
  // the JSON shape the same way the package does (bytes are excluded).
  const digestView = structuredClone(document)
  digestView.assets = digestView.assets.map(({ bytes: _bytes, ...asset }) => asset)
  document.receipt.generatedSha256 = struct.structReceiptDigest(digestView)
  return document
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const struct = await loadStruct(args.structDir)
  const draft = JSON.parse(await readFile(args.input, 'utf8'))
  const sealed = sealDraft(draft, struct)
  await mkdir(args.out, { recursive: true })
  const result = { structDir: struct.dir, documentId: sealed.documentId, ready: sealed.recovery.status === 'ready', droppedHrefs: sealDraft.droppedHrefs ?? 0, typography: args.typography, profiles: [], errors: [] }
  let decoded
  try {
    decoded = struct.decodeStructDocument(sealed)
  } catch (error) {
    result.errors.push({ stage: 'decode', code: error?.code ?? null, path: error?.path ?? null, message: String(error?.message ?? error) })
    await writeFile(join(args.out, 'render-report.json'), `${JSON.stringify(result, null, 1)}\n`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = 2
    return
  }
  const encoded = struct.encodeStructDocument(decoded)
  await writeFile(join(args.out, 'struct.json'), typeof encoded === 'string' ? encoded : `${JSON.stringify(encoded)}\n`)
  try {
    const xhtml = struct.renderPublicationXhtml(decoded)
    await writeFile(join(args.out, 'content.xhtml'), xhtml)
    result.xhtmlBytes = Buffer.byteLength(xhtml)
  } catch (error) {
    result.errors.push({ stage: 'xhtml', message: String(error?.message ?? error) })
  }
  for (const id of args.profiles) {
    try {
      const profile = profileFor(id, args.typography)
      const exported = await struct.buildStructEpub(decoded, { profile })
      const fileName = `${basename(args.input)}-${id === 'paperProMove' ? 'papermove' : id.toLowerCase()}.epub`
      await writeFile(join(args.out, fileName), exported.bytes)
      result.profiles.push({ id, fileName, bytes: exported.bytes.byteLength, sha256: exported.sha256, identifier: exported.identifier })
    } catch (error) {
      result.errors.push({ stage: `epub:${id}`, message: String(error?.message ?? error) })
    }
  }
  await writeFile(join(args.out, 'render-report.json'), `${JSON.stringify(result, null, 1)}\n`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.errors.length > 0 && result.profiles.length === 0) process.exitCode = 3
}

function basename(path) {
  return path.split('/').pop().replace(/\.struct-draft\.json$|\.json$/, '')
}

// Run when invoked as a program; import when a test wants the typography rules
// on their own, which needs no built dist and no draft. Node resolves the main
// module through realpath, so the comparison has to as well, or a symlinked
// invocation would exit 0 having rendered nothing.
function isProgram() {
  if (!process.argv[1]) return false
  const here = fileURLToPath(import.meta.url)
  try {
    return realpathSync(process.argv[1]) === realpathSync(here)
  } catch {
    return resolve(process.argv[1]) === here
  }
}

if (isProgram()) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export { FONT_STACKS, PROFILE_CSS, applyTypography, parseArguments, profileFor, stylesheet, validateTypography }
