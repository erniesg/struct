import {
  credentialShapedValue,
  legacyStructDigest,
  legacyStructDigestMatches,
  SAFE_ID,
  structDigest,
} from './identity'
import { fail, utf8ByteLength } from './document/codec/primitives'
import {
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
  type StructConsultationReceipt,
  type StructDocument,
} from './document/types'

export type { StructConsultationReceipt } from './document/types'

const HASH = /^[a-f0-9]{64}$/u
const STRUCT_CONSULTATION_RECEIPT_SCHEMA_VERSION = '1.0.0'
const MAX_DEPTH = 128
const MAX_NODES = 100_000
/** Bounds shared by generic receipt validation and its canonical snapshot. */
export const MAX_STRUCT_RECEIPT_JSON_STRING_BYTES = 1024 * 1024
export const MAX_STRUCT_RECEIPT_JSON_TOTAL_BYTES = 8 * 1024 * 1024
const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'documentId',
  'sourceSha256',
  'consultations',
  'decisions',
  'metrics',
  'semanticStateSha256',
] as const
const FORBIDDEN_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'credential',
  'password',
  'privatekey',
  'secret',
  'token',
] as const

function normalizedKey(key: string) {
  return key
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]/gu, '')
    .toLowerCase()
}

function forbiddenKey(key: string) {
  const normalized = normalizedKey(key)
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  )
}

function canonicalJson(
  value: unknown,
  active: WeakSet<object>,
  state: { nodes: number; stringBytes: number; budgetExceeded: boolean },
  depth: number,
): value is
  Record<string, unknown> | unknown[] | string | number | boolean | null {
  if (depth > MAX_DEPTH) {
    state.budgetExceeded = true
    return false
  }
  state.nodes += 1
  if (state.nodes > MAX_NODES) {
    state.budgetExceeded = true
    return false
  }
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') {
    const bytes = utf8ByteLength(value)
    if (bytes > MAX_STRUCT_RECEIPT_JSON_STRING_BYTES) {
      state.budgetExceeded = true
      return false
    }
    state.stringBytes += bytes
    if (state.stringBytes > MAX_STRUCT_RECEIPT_JSON_TOTAL_BYTES) {
      state.budgetExceeded = true
      return false
    }
    return !credentialShapedValue(value)
  }
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || active.has(value)) return false

  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_NODES - state.nodes
      ) {
        if (Number.isSafeInteger(length) && length > MAX_NODES - state.nodes)
          state.budgetExceeded = true
        return false
      }
      const keys = Reflect.ownKeys(value)
      if (
        keys.length !== length + 1 ||
        !keys.includes('length') ||
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && !/^\d+$/u.test(key)),
        )
      )
        return false
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          !canonicalJson(descriptor.value, active, state, depth + 1)
        )
          return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_NODES - state.nodes) {
      state.budgetExceeded = true
      return false
    }
    for (const key of keys) {
      if (typeof key !== 'string' || !SAFE_ID.test(key) || forbiddenKey(key))
        return false
      const keyBytes = utf8ByteLength(key)
      if (keyBytes > MAX_STRUCT_RECEIPT_JSON_STRING_BYTES) {
        state.budgetExceeded = true
        return false
      }
      state.stringBytes += keyBytes
      if (state.stringBytes > MAX_STRUCT_RECEIPT_JSON_TOTAL_BYTES) {
        state.budgetExceeded = true
        return false
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        !canonicalJson(descriptor.value, active, state, depth + 1)
      )
        return false
    }
    return true
  } finally {
    active.delete(value)
  }
}

function exactTopLevelKeys(value: Record<string, unknown>) {
  const keys = Object.keys(value).sort()
  const allowed = TOP_LEVEL_KEYS.filter((key) =>
    Object.hasOwn(value, key),
  ).sort()
  return JSON.stringify(keys) === JSON.stringify(allowed)
}

/** Validate only the generic closed receipt envelope. */
function validateStructConsultationReceiptUnsafe(
  value: unknown,
): value is StructConsultationReceipt {
  if (
    !canonicalJson(
      value,
      new WeakSet<object>(),
      { nodes: 0, stringBytes: 0, budgetExceeded: false },
      0,
    )
  )
    return false
  if (!value || Array.isArray(value) || typeof value !== 'object') return false
  const receipt = value as Record<string, unknown>
  if (!exactTopLevelKeys(receipt)) return false
  if (
    typeof receipt.schemaVersion !== 'string' ||
    receipt.schemaVersion !== STRUCT_CONSULTATION_RECEIPT_SCHEMA_VERSION ||
    typeof receipt.documentId !== 'string' ||
    !SAFE_ID.test(receipt.documentId) ||
    (receipt.sourceSha256 !== null &&
      (typeof receipt.sourceSha256 !== 'string' ||
        !HASH.test(receipt.sourceSha256))) ||
    !Array.isArray(receipt.consultations) ||
    !Array.isArray(receipt.decisions) ||
    !receipt.metrics ||
    typeof receipt.metrics !== 'object' ||
    Array.isArray(receipt.metrics) ||
    (receipt.semanticStateSha256 !== undefined &&
      (typeof receipt.semanticStateSha256 !== 'string' ||
        !HASH.test(receipt.semanticStateSha256)))
  )
    return false
  for (const member of [...receipt.consultations, ...receipt.decisions]) {
    if (
      !member ||
      typeof member !== 'object' ||
      Array.isArray(member) ||
      (Object.getPrototypeOf(member) !== Object.prototype &&
        Object.getPrototypeOf(member) !== null)
    )
      return false
  }
  return true
}

/** Reject bounded receipt ingress before a consumer snapshots its JSON tree. */
export function preflightStructConsultationReceipt(
  value: unknown,
  path: string,
) {
  const state = { nodes: 0, stringBytes: 0, budgetExceeded: false }
  let valid = false
  try {
    valid = canonicalJson(value, new WeakSet<object>(), state, 0)
  } catch {
    return false
  }
  if (state.budgetExceeded)
    fail('BUDGET', path, 'consultation receipt exceeds the resource bound')
  return valid && validateStructConsultationReceiptUnsafe(value)
}

export function validateStructConsultationReceipt(
  value: unknown,
): value is StructConsultationReceipt {
  try {
    return validateStructConsultationReceiptUnsafe(value)
  } catch {
    return false
  }
}

function semanticReceiptInput(document: StructDocument) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    ...(document.receipt.modelConsultations
      ? { modelConsultations: document.receipt.modelConsultations }
      : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  }
}

/** Compute the authoritative semantic receipt digest for a decoded document. */
export function structReceiptDigest(document: StructDocument) {
  const input = semanticReceiptInput(document)
  return document.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION
    ? legacyStructDigest(input)
    : structDigest(input)
}

function verifyStructReceiptUnsafe(document: StructDocument) {
  const receipt = document.receipt
  const legacy = document.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION
  const bindingMatches = legacy
    ? document.documentId === undefined &&
      receipt.documentId === undefined &&
      receipt.modelConsultations === undefined &&
      receipt.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION
    : document.schemaVersion === STRUCT_SCHEMA_VERSION &&
      receipt.schemaVersion === STRUCT_SCHEMA_VERSION &&
      typeof document.documentId === 'string' &&
      document.documentId.length > 0 &&
      receipt.documentId === document.documentId
  if (
    !bindingMatches ||
    receipt.sourceSha256 !== document.source.sha256 ||
    receipt.blockCount !== document.blocks.length ||
    receipt.assetCount !== document.assets.length ||
    receipt.relationshipCount !== document.relationships.length ||
    receipt.diagnosticCount !== document.diagnostics.length ||
    receipt.textCharacterCount !== receipt.conservation.sourceTextCharacterCount
  )
    return false
  if (
    receipt.modelConsultations !== undefined &&
    (!validateStructConsultationReceipt(receipt.modelConsultations) ||
      receipt.modelConsultations.sourceSha256 !== document.source.sha256 ||
      receipt.modelConsultations.documentId !== document.documentId)
  )
    return false
  const input = semanticReceiptInput(document)
  return legacy
    ? legacyStructDigestMatches(input, document.receipt.generatedSha256)
    : structDigest(input) === document.receipt.generatedSha256
}

/** Verify the semantic receipt without coercing or changing document versions. */
export function verifyStructReceipt(document: StructDocument) {
  try {
    return verifyStructReceiptUnsafe(document)
  } catch {
    return false
  }
}
