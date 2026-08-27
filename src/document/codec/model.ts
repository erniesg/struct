import {
  copyRecord,
  fail,
  finiteNumber,
  isStructCodecError,
  stringValue,
  utf8ByteLength,
} from './primitives'
import {
  MAX_STRUCT_RECEIPT_JSON_STRING_BYTES,
  MAX_STRUCT_RECEIPT_JSON_TOTAL_BYTES,
  preflightStructConsultationReceipt,
} from '../../receipt'

const MAX_CANONICAL_DEPTH = 128
const MAX_CANONICAL_NODES = 100_000

type CopyState = {
  active: WeakSet<object>
  nodes: number
  stringBytes: number
}

function chargeReceiptText(value: string, path: string, state: CopyState) {
  const parsed = stringValue(value, path)
  const bytes = utf8ByteLength(parsed)
  if (bytes > MAX_STRUCT_RECEIPT_JSON_STRING_BYTES)
    fail(
      'BUDGET',
      path,
      'consultation receipt string exceeds the resource bound',
    )
  state.stringBytes += bytes
  if (state.stringBytes > MAX_STRUCT_RECEIPT_JSON_TOTAL_BYTES)
    fail('BUDGET', path, 'consultation receipt exceeds the resource bound')
  return parsed
}

/**
 * Snapshot a receipt only after its original object graph passes validation. This
 * rejects accessors/proxies, detects cycles, and bounds recursive input while
 * preserving the adapter-owned receipt contents as intentionally closed JSON.
 */
export function copyCanonicalJson(
  value: unknown,
  path: string,
  state: CopyState = {
    active: new WeakSet<object>(),
    nodes: 0,
    stringBytes: 0,
  },
  depth = 0,
): unknown {
  if (depth > MAX_CANONICAL_DEPTH)
    fail('MODEL_RECEIPT', path, 'canonical JSON nesting is too deep')
  state.nodes += 1
  if (state.nodes > MAX_CANONICAL_NODES)
    fail('MODEL_RECEIPT', path, 'canonical JSON exceeds the node bound')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return chargeReceiptText(value, path, state)
  if (typeof value === 'number') return finiteNumber(value, path)
  if (typeof value !== 'object')
    fail(
      'TYPE',
      path,
      'consultation receipt must contain canonical JSON values',
    )
  if (state.active.has(value))
    fail(
      'MODEL_RECEIPT',
      path,
      'cycles are not permitted in consultation receipts',
    )
  state.active.add(value)
  try {
    let isArray = false
    try {
      isArray = Array.isArray(value)
    } catch {
      fail(
        'MODEL_RECEIPT',
        path,
        'model receipt object cannot be inspected safely',
      )
    }
    if (isArray) {
      let prototype: object | null
      try {
        prototype = Object.getPrototypeOf(value)
      } catch {
        fail(
          'MODEL_RECEIPT',
          path,
          'model receipt array cannot be inspected safely',
        )
      }
      if (prototype !== Array.prototype)
        fail(
          'MODEL_RECEIPT',
          path,
          'model receipt arrays must use the canonical Array.prototype',
        )
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        fail('MODEL_RECEIPT', path, 'model receipt array length is invalid')
      if (length > MAX_CANONICAL_NODES - state.nodes)
        fail('MODEL_RECEIPT', path, 'canonical JSON exceeds the node bound')
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
        fail(
          'MODEL_RECEIPT',
          path,
          'model receipt array contains invalid fields',
        )
      const copied: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          fail('MODEL_RECEIPT', `${path}[${index}]`, 'array item is not data')
        copied.push(
          copyCanonicalJson(
            descriptor.value,
            `${path}[${index}]`,
            state,
            depth + 1,
          ),
        )
      }
      return copied
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      fail('MODEL_RECEIPT', path, 'model receipt object must be plain')
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_CANONICAL_NODES - state.nodes)
      fail('MODEL_RECEIPT', path, 'canonical JSON exceeds the node bound')
    if (keys.some((key) => typeof key !== 'string'))
      fail('MODEL_RECEIPT', path, 'model receipt object contains symbol fields')
    const entries: Array<[string, unknown]> = []
    for (const key of (keys as string[]).sort()) {
      chargeReceiptText(key, `${path}.${key}`, state)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail('MODEL_RECEIPT', `${path}.${key}`, 'object field is not data')
      entries.push([
        key,
        copyCanonicalJson(descriptor.value, `${path}.${key}`, state, depth + 1),
      ])
    }
    return copyRecord(entries)
  } catch (error) {
    if (isStructCodecError(error)) throw error
    fail(
      'MODEL_RECEIPT',
      path,
      'model receipt object cannot be inspected safely',
    )
  } finally {
    state.active.delete(value)
  }
}

export function validateConsultationReceipt(value: unknown, path: string) {
  try {
    if (!preflightStructConsultationReceipt(value, path))
      fail('MODEL_RECEIPT', path, 'invalid closed consultation receipt')
  } catch (error) {
    if (isStructCodecError(error)) throw error
    fail('MODEL_RECEIPT', path, 'invalid model consultation receipt')
  }
}
