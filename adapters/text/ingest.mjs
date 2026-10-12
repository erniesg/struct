import { createHash } from 'node:crypto'

import { decodeStructDocument, encodeStructDocument } from '../../dist/document/index.js'
import { structReceiptDigest } from '../../dist/receipt.js'

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_BLOCKS = 10_000
const MAX_REASON_CHARACTERS = 4096
const HASH = /^[a-f0-9]{64}$/u
const PLAN_KEYS = ['schemaVersion', 'sourceSha256', 'actor', 'decisions', 'consultation']
const DECISION_KEYS = ['blockId', 'action', 'reason']
const CONSULTATION_KEYS = ['promptSha256', 'model']

function fail(message) {
  throw new TypeError(`text ingestion: ${message}`)
}

function plainObject(value, name) {
  let prototype
  let keys
  try {
    prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
    keys = value && typeof value === 'object' ? Reflect.ownKeys(value) : []
  } catch {
    fail(`${name} must be a plain data object`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (prototype !== Object.prototype && prototype !== null))
    fail(`${name} must be a plain object`)
  for (const key of keys) {
    if (typeof key !== 'string') fail(`${name} must not contain symbol fields`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail(`${name}.${key} must be a data field`)
  }
  return value
}

function exactKeys(value, allowed, required, name) {
  const object = plainObject(value, name)
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`${name} has unknown field ${key}`)
  for (const key of required) if (!Object.hasOwn(object, key)) fail(`${name}.${key} is required`)
  return object
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeUtf8(sourceBytes) {
  if (!(sourceBytes instanceof Uint8Array)) fail('source bytes must be a Uint8Array')
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) fail('source exceeds the 1 MiB bound')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceBytes)
  } catch {
    fail('source must be strict UTF-8')
  }
}

/** Inspect physical UTF-8 lines without altering their content or line endings. */
export function inspectText(sourceBytes) {
  const text = decodeUtf8(sourceBytes)
  const blocks = []
  const whitespace = []
  let line = 1
  let start = 0
  while (start < text.length) {
    let end = start
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1
    let terminatorEnd = end
    if (text[end] === '\r' && text[end + 1] === '\n') terminatorEnd += 2
    else if (end < text.length) terminatorEnd += 1
    const lineText = text.slice(start, end)
    if (/^\s*$/u.test(lineText)) {
      if (start !== terminatorEnd) whitespace.push({ start, end: terminatorEnd })
    } else {
      if (blocks.length === MAX_BLOCKS) fail(`source exceeds the ${MAX_BLOCKS} block bound`)
      blocks.push({ id: `line-${line}`, text: lineText, start, end, line })
      if (end !== terminatorEnd) whitespace.push({ start: end, end: terminatorEnd })
    }
    start = terminatorEnd
    line += 1
  }
  if (blocks.length === 0) fail('source must contain at least one nonblank line')
  return {
    schemaVersion: '1.0.0',
    sourceSha256: sha256(sourceBytes),
    byteLength: sourceBytes.byteLength,
    textCharacterCount: text.length,
    blocks,
    whitespace,
  }
}

/** Validate the closed, source-bound cleanup ledger; omissions mean keep. */
export function validateCleanupPlan(plan, request) {
  const requestObject = exactKeys(
    request,
    ['schemaVersion', 'sourceSha256', 'byteLength', 'textCharacterCount', 'blocks', 'whitespace'],
    ['schemaVersion', 'sourceSha256', 'blocks'],
    'request',
  )
  if (requestObject.schemaVersion !== '1.0.0' || typeof requestObject.sourceSha256 !== 'string' || !HASH.test(requestObject.sourceSha256))
    fail('request is not a text inspection')
  const parsed = exactKeys(plan, PLAN_KEYS, ['schemaVersion', 'sourceSha256', 'actor', 'decisions'], 'cleanup plan')
  if (parsed.schemaVersion !== '1.0.0') fail('cleanup plan schemaVersion must be 1.0.0')
  if (parsed.sourceSha256 !== requestObject.sourceSha256) fail('cleanup plan sourceSha256 is stale')
  if (!['human', 'codex', 'claude'].includes(parsed.actor)) fail('cleanup plan actor is invalid')
  if (!Array.isArray(parsed.decisions)) fail('cleanup plan decisions must be an array')
  const sourceIds = new Set(requestObject.blocks.map((block) => block?.id))
  if (parsed.decisions.length > sourceIds.size) fail('cleanup plan has too many decisions')
  const seen = new Set()
  const decisions = parsed.decisions.map((decision, index) => {
    const entry = exactKeys(decision, DECISION_KEYS, DECISION_KEYS, `cleanup plan.decisions[${index}]`)
    if (typeof entry.blockId !== 'string' || !sourceIds.has(entry.blockId)) fail(`cleanup plan decision has unknown blockId ${String(entry.blockId)}`)
    if (seen.has(entry.blockId)) fail(`cleanup plan has duplicate decision for ${entry.blockId}`)
    seen.add(entry.blockId)
    if (!['keep', 'remove', 'review'].includes(entry.action)) fail('cleanup plan decision action is invalid')
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) fail('cleanup plan decision reason is required')
    if (entry.reason.length > MAX_REASON_CHARACTERS) fail(`cleanup plan decision reason exceeds the ${MAX_REASON_CHARACTERS} character bound`)
    return { blockId: entry.blockId, action: entry.action, reason: entry.reason }
  })
  let consultation
  if (Object.hasOwn(parsed, 'consultation')) {
    const entry = exactKeys(parsed.consultation, CONSULTATION_KEYS, CONSULTATION_KEYS, 'cleanup plan.consultation')
    if (typeof entry.promptSha256 !== 'string' || !HASH.test(entry.promptSha256) || typeof entry.model !== 'string' || entry.model.length === 0)
      fail('cleanup plan consultation is invalid')
    consultation = { promptSha256: entry.promptSha256, model: entry.model }
  }
  if (parsed.actor !== 'human' && !consultation)
    fail('cleanup plan consultation is required for model actors')
  return {
    schemaVersion: '1.0.0', sourceSha256: parsed.sourceSha256, actor: parsed.actor,
    decisions, ...(consultation ? { consultation } : {}),
  }
}

function sourceConservation(blocks, furniture, diagnosticCount) {
  const textCharacterCount = blocks.reduce((count, block) => count + block.text.length, 0)
  const furnitureTextCharacterCount = furniture.reduce((count, block) => count + block.text.length, 0)
  return {
    sourceNodeCount: blocks.length, accountedSourceNodeCount: blocks.length,
    sourceRegionCount: 0, accountedSourceRegionCount: 0,
    sourceAnnotationCount: 0, accountedSourceAnnotationCount: 0,
    sourceAssetCount: 0, accountedSourceAssetCount: 0,
    sourceRelationshipCount: 0, accountedSourceRelationshipCount: 0,
    sourceDiagnosticCount: diagnosticCount, accountedSourceDiagnosticCount: diagnosticCount,
    sourceTextCharacterCount: textCharacterCount,
    structBlockCount: blocks.length, structAssetCount: 0,
    structRelationshipCount: 0, structDiagnosticCount: diagnosticCount,
    structTextCharacterCount: textCharacterCount,
    sourceFurnitureBlockCount: furniture.length,
    accountedFurnitureBlockCount: furniture.length,
    sourceFurnitureTextCharacterCount: furnitureTextCharacterCount,
    structFurnitureBlockCount: furniture.length,
    structFurnitureTextCharacterCount: furnitureTextCharacterCount,
    furnitureContaminationCount: 0,
  }
}

/** Convert inspected text into a sealed, public STRUCT document and an adapter report. */
export async function ingestText(sourceBytes, { fileName, metadata, cleanupPlan } = {}) {
  const inspection = inspectText(sourceBytes)
  if (typeof fileName !== 'string' || fileName.length === 0) fail('fileName is required')
  const plan = cleanupPlan === undefined ? undefined : validateCleanupPlan(cleanupPlan, inspection)
  const decisions = new Map((plan?.decisions ?? []).map((decision) => [decision.blockId, decision]))
  const furniture = []
  const blocks = inspection.blocks.map((source, order) => {
    const decision = decisions.get(source.id)
    const removed = decision?.action === 'remove'
    const block = {
      id: source.id, kind: removed ? 'furniture' : 'paragraph', text: source.text,
      page: null, order, column: null, inline: [],
      evidence: {
        confidence: 1, pages: [], boxes: [], sourceIds: [source.id],
        ...(removed ? { signals: ['explicit-paratext'] } : {}),
      },
      attributes: { sourceStart: source.start, sourceEnd: source.end, sourceLine: source.line },
    }
    if (removed) furniture.push(block)
    return block
  })
  const reviewDecisions = (plan?.decisions ?? []).filter((decision) => decision.action === 'review')
  const diagnostics = reviewDecisions.map((decision) => ({
    id: `review-${decision.blockId}`, severity: 'warning', category: 'source',
    title: 'Cleanup review required', message: decision.reason, action: 'review-required', pages: [], sourceIds: [decision.blockId],
  }))
  const conservation = sourceConservation(blocks, furniture, diagnostics.length)
  const documentId = `text-${inspection.sourceSha256.slice(0, 24)}`
  const modelConsultations = plan?.consultation ? {
    schemaVersion: '1.0.0', documentId, sourceSha256: inspection.sourceSha256,
    consultations: [{ actor: plan.actor, promptSha256: plan.consultation.promptSha256, model: plan.consultation.model }],
    decisions: plan.decisions, metrics: { consultationCount: 1, decisionCount: plan.decisions.length },
  } : undefined
  const document = {
    schemaVersion: '0.2.0', documentId,
    source: { format: 'unknown', fileName, sha256: inspection.sourceSha256, byteLength: inspection.byteLength, pageCount: 0, localOnly: plan?.actor === 'codex' || plan?.actor === 'claude' ? false : true },
    metadata: { ...metadata, artifactModifiedAt: metadata?.artifactModifiedAt ?? '1970-01-01T00:00:00Z' },
    blocks, assets: [], relationships: [], pages: [], diagnostics,
    recovery: reviewDecisions.length === 0
      ? { status: 'ready', title: 'Ready', summary: 'No cleanup review required', issues: [] }
      : { status: 'review-required', title: 'Cleanup review required', summary: 'One or more text lines require review', issues: reviewDecisions.map((decision) => ({ category: 'source', title: 'Cleanup review required', count: 1, pages: [], action: 'review-required' })), userAction: 'Resolve review decisions before EPUB production' },
    receipt: {
      schemaVersion: '0.2.0', documentId, sourceSha256: inspection.sourceSha256,
      ...(modelConsultations ? { modelConsultations } : {}),
      blockCount: blocks.length, assetCount: 0, relationshipCount: 0, diagnosticCount: diagnostics.length,
      textCharacterCount: conservation.structTextCharacterCount, conservation, generatedSha256: '',
    },
  }
  document.receipt.generatedSha256 = structReceiptDigest(document)
  const sealed = decodeStructDocument(document)
  const encoded = encodeStructDocument(sealed)
  const strictDocument = decodeStructDocument(encoded)
  return {
    document: strictDocument,
    report: {
      schemaVersion: '1.0.0', sourceSha256: inspection.sourceSha256,
      byteLength: inspection.byteLength, rawSourceTextCharacterCount: inspection.textCharacterCount,
      structuralWhitespaceCharacterCount: inspection.whitespace.reduce((count, range) => count + range.end - range.start, 0),
      blocks: inspection.blocks, whitespace: inspection.whitespace,
      decisions: plan?.decisions ?? [], ...(plan ? { cleanupPlan: plan } : {}),
      ...(plan?.actor === 'codex' || plan?.actor === 'claude'
        ? { modelSourceTransmission: { transmitted: true, localityProven: false } }
        : {}),
      conservation,
    },
  }
}
