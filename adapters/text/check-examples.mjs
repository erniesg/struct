#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildStructEpub } from '../../dist/renderers/epub.js'
import { verifyStructReceipt } from '../../dist/receipt.js'
import { ingestText, inspectText } from './ingest.mjs'

const examplesRoot = fileURLToPath(new URL('./examples/', import.meta.url))
const exampleSlugs = ['total-eclipse', 'now-we-are-five']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message) { throw new Error(`Text example check failed: ${message}`) }
function assertKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} has invalid fields`)
}

export async function loadExampleManifest(path) {
  let manifest
  try { manifest = JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail(`cannot read manifest ${path}: ${error.message}`) }
  assertKeys(manifest, ['schemaVersion', 'slug', 'source', 'metadata', 'cleanupPlan', 'expected'], 'manifest')
  if (manifest.schemaVersion !== '1.0.0' || typeof manifest.slug !== 'string' || !/^[a-z0-9-]+$/.test(manifest.slug)) fail('manifest schema is invalid')
  assertKeys(manifest.source, ['sha256', 'nonblankLineCount'], 'manifest source')
  assertKeys(manifest.expected, ['visibleParagraphCount', 'visibleNoteCount', 'visibleNoteLineIds', 'visibleLineIds'], 'manifest expected')
  if (!/^[a-f0-9]{64}$/.test(manifest.source.sha256) || !Number.isInteger(manifest.source.nonblankLineCount) || manifest.source.nonblankLineCount < 1 || typeof manifest.metadata !== 'string' || typeof manifest.cleanupPlan !== 'string' || !/^[a-z0-9-]+\.json$/.test(manifest.metadata) || !/^[a-z0-9-]+\.json$/.test(manifest.cleanupPlan) || !Number.isInteger(manifest.expected.visibleParagraphCount) || !Number.isInteger(manifest.expected.visibleNoteCount) || !Array.isArray(manifest.expected.visibleLineIds) || !Array.isArray(manifest.expected.visibleNoteLineIds) || manifest.expected.visibleLineIds.length !== manifest.expected.visibleParagraphCount || manifest.expected.visibleNoteLineIds.length !== manifest.expected.visibleNoteCount || new Set(manifest.expected.visibleLineIds).size !== manifest.expected.visibleLineIds.length || manifest.expected.visibleLineIds.some((id) => !/^line-[1-9]\d*$/.test(id)) || manifest.expected.visibleNoteLineIds.some((id) => !manifest.expected.visibleLineIds.includes(id))) fail('manifest expectations are invalid')
  return manifest
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail(`cannot read ${label}: ${error.message}`) }
}

function defaultEntries() {
  return exampleSlugs.map((slug) => ({
    manifestPath: join(examplesRoot, slug, 'manifest.json'),
    sourcePath: join(examplesRoot, 'private', `${slug}.txt`),
  }))
}

async function sourceExists(path) { try { await access(path); return true } catch { return false } }

async function validateEntry({ manifestPath, sourcePath }) {
  const manifest = await loadExampleManifest(manifestPath)
  const base = dirname(manifestPath)
  let sourceInfo
  try { sourceInfo = await stat(sourcePath) } catch (error) { fail(`cannot stat source ${sourcePath}: ${error.message}`) }
  if (!sourceInfo.isFile() || sourceInfo.size > 1024 * 1024) fail(`${manifest.slug} source exceeds the 1 MiB input bound`)
  const [source, metadata, cleanupPlan] = await Promise.all([
    readFile(sourcePath),
    readJson(join(base, manifest.metadata), 'metadata'),
    readJson(join(base, manifest.cleanupPlan), 'cleanup plan'),
  ])
  if (sha256(source) !== manifest.source.sha256) fail(`${manifest.slug} source SHA-256 does not match its manifest`)
  const inspection = inspectText(source)
  if (inspection.blocks.length !== manifest.source.nonblankLineCount) fail(`${manifest.slug} source nonblank-line count does not match its manifest`)
  const sourceIds = new Set(inspection.blocks.map(({ id }) => id))
  const expectedIds = new Set(manifest.expected.visibleLineIds)
  const noteIds = new Set(manifest.expected.visibleNoteLineIds)
  if ([...expectedIds].some((id) => !sourceIds.has(id))) fail(`${manifest.slug} expected visible line is absent from source`)
  if (cleanupPlan.sourceSha256 !== manifest.source.sha256 || cleanupPlan.actor !== 'human' || !Array.isArray(cleanupPlan.decisions)) fail(`${manifest.slug} cleanup plan is not source-bound human metadata`)
  const removedIds = new Set(cleanupPlan.decisions.map(({ blockId, action, reason }) => {
    if (action !== 'remove' || typeof reason !== 'string' || reason.length === 0 || !sourceIds.has(blockId)) fail(`${manifest.slug} cleanup decision is invalid`)
    return blockId
  }))
  if (removedIds.size !== cleanupPlan.decisions.length || [...expectedIds].some((id) => removedIds.has(id)) || [...sourceIds].some((id) => !expectedIds.has(id) && !removedIds.has(id))) fail(`${manifest.slug} cleanup does not account for every nonblank line`)
  const { document, report } = await ingestText(source, { fileName: 'source.txt', metadata, cleanupPlan })
  if (!verifyStructReceipt(document)) fail(`${manifest.slug} has an invalid semantic receipt`)
  if (document.source.sha256 !== manifest.source.sha256 || report.sourceSha256 !== manifest.source.sha256) fail(`${manifest.slug} source receipt does not bind its input`)
  if (document.blocks.length !== inspection.blocks.length || document.blocks.some(({ id }) => !sourceIds.has(id))) fail(`${manifest.slug} did not retain every source line in the Struct graph`)
  const visible = document.blocks.filter(({ kind }) => kind === 'paragraph')
  if (visible.length !== manifest.expected.visibleParagraphCount || visible.some(({ id }) => !expectedIds.has(id)) || visible.some(({ text }, index) => text !== inspection.blocks.find(({ id }) => id === visible[index].id).text) || [...noteIds].some((id) => !visible.some((block) => block.id === id))) fail(`${manifest.slug} visible prose does not match independently selected source lines`)
  if (document.blocks.filter(({ kind }) => kind === 'furniture').length !== removedIds.size) fail(`${manifest.slug} omissions are not represented as furniture`)
  return { manifest, document, visibleParagraphCount: visible.length, totalBlockCount: document.blocks.length }
}

export async function checkExamples(entries = undefined, { out } = {}) {
  const selected = entries ?? defaultEntries()
  if (!Array.isArray(selected) || selected.length === 0) fail('at least one example is required')
  if (entries === undefined && !(await Promise.all(selected.map(({ sourcePath }) => sourceExists(sourcePath)))).every(Boolean)) return { skipped: 'private example sources are unavailable; populate adapters/text/examples/private to run the regression' }
  if (typeof out !== 'string' || out.length === 0) fail('an output directory is required')
  const target = resolve(out)
  if (await sourceExists(target)) fail(`output directory already exists: ${target}`)
  const results = await Promise.all(selected.map(validateEntry))
  const epubs = await Promise.all(results.map(async ({ manifest, document }) => ({ slug: manifest.slug, bytes: (await buildStructEpub(document)).bytes })))
  await mkdir(dirname(target), { recursive: true })
  const staging = await mkdtemp(join(dirname(target), '.struct-text-examples-'))
  try {
    await Promise.all(epubs.map(({ slug, bytes }) => writeFile(join(staging, `${slug}.epub`), bytes, { flag: 'wx' })))
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return results.map(({ manifest, visibleParagraphCount, totalBlockCount }) => ({ slug: manifest.slug, visibleParagraphCount, totalBlockCount }))
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--out') fail('usage: node adapters/text/check-examples.mjs --out DIR')
  const result = await checkExamples(undefined, { out: argv[1] })
  if (result.skipped) fail(result.skipped)
  for (const { slug, visibleParagraphCount, totalBlockCount } of result) process.stdout.write(`${slug}: ${visibleParagraphCount} visible paragraphs, ${totalBlockCount} retained source blocks\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
