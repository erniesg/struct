import {
  array,
  fail,
  integer,
  isStructCodecError,
  stringValue,
} from './primitives'

/** Bound decoded binary data before allocating an output buffer. */
export const MAX_STRUCT_ASSET_BYTES = 128 * 1024 * 1024
const MAX_STRUCT_ASSET_BASE64_LENGTH = Math.ceil(MAX_STRUCT_ASSET_BYTES / 3) * 4

const uint8ArrayPrototype = Uint8Array.prototype
const typedArrayPrototype = Object.getPrototypeOf(uint8ArrayPrototype)
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length',
)?.get

function canonicalUint8ArrayLength(value: unknown): number | undefined {
  if (!ArrayBuffer.isView(value)) return undefined
  const bytes = value as Uint8Array
  if (
    typedArrayTagGetter === undefined ||
    Reflect.apply(typedArrayTagGetter, bytes, []) !== 'Uint8Array' ||
    typedArrayLengthGetter === undefined ||
    Object.getPrototypeOf(bytes) !== uint8ArrayPrototype ||
    Object.getOwnPropertyDescriptor(bytes, 'length') !== undefined
  )
    return undefined
  return Reflect.apply(typedArrayLengthGetter, bytes, [])
}

function copyCanonicalUint8Array(
  value: unknown,
  maximumBytes: number,
): Uint8Array | undefined {
  const bytes = value as Uint8Array
  const length = canonicalUint8ArrayLength(bytes)
  if (length === undefined || length > maximumBytes) return undefined
  let snapshot: Uint8Array
  try {
    snapshot = new Uint8Array(bytes)
  } catch {
    return undefined
  }
  return snapshot
}

function arrayByteLength(value: unknown, path: string) {
  if (!Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = descriptor?.value
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, 'value') ||
    !Number.isSafeInteger(length) ||
    length < 0
  )
    fail('BYTES', path, 'byte array length is not a safe integer')
  return length as number
}

function encodedByteLength(value: unknown, path: string) {
  const encoded = stringValue(value, path)
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  )
    fail('BYTES', path, 'bytes must use canonical base64')
  return {
    encoded,
    length:
      (encoded.length / 4) * 3 -
      (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0),
  }
}

/** Inspect a byte carrier's intrinsic size without decoding or copying it. */
export function preflightBytes(
  value: unknown,
  path: string,
  maximumBytes = MAX_STRUCT_ASSET_BYTES,
): number {
  try {
    if (ArrayBuffer.isView(value)) {
      const length = canonicalUint8ArrayLength(value)
      if (length === undefined)
        fail('BYTES', path, 'bytes must be a canonical Uint8Array')
      if (length > maximumBytes)
        fail('BYTES', path, 'bytes exceed the per-asset resource bound')
      return length
    }
    const arrayLength = arrayByteLength(value, path)
    if (arrayLength !== undefined) {
      if (arrayLength > maximumBytes)
        fail('BYTES', path, 'bytes exceed the per-asset resource bound')
      return arrayLength
    }
    if (typeof value !== 'string')
      fail('TYPE', path, 'expected a string or canonical byte carrier')
    const maximumEncodedLength = Math.min(
      MAX_STRUCT_ASSET_BASE64_LENGTH,
      Math.ceil(maximumBytes / 3) * 4,
    )
    if (value.length > maximumEncodedLength)
      fail('BYTES', path, 'bytes exceed the per-asset resource bound')
    if (value.length % 4 !== 0)
      fail('BYTES', path, 'bytes must use canonical base64')
    const decodedLength =
      (value.length / 4) * 3 -
      (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
    if (decodedLength > maximumBytes)
      fail('BYTES', path, 'bytes exceed the per-asset resource bound')
    const { length } = encodedByteLength(value, path)
    return length
  } catch (error) {
    if (isStructCodecError(error)) throw error
    fail('BYTES', path, 'bytes cannot be inspected safely')
  }
}

export function parseBytes(
  value: unknown,
  path: string,
  maximumBytes = MAX_STRUCT_ASSET_BYTES,
): Uint8Array {
  try {
    const decodedLength = preflightBytes(value, path, maximumBytes)
    if (ArrayBuffer.isView(value)) {
      const bytes = copyCanonicalUint8Array(value, maximumBytes)
      if (bytes === undefined)
        fail('BYTES', path, 'bytes must be a canonical Uint8Array')
      return bytes
    }
    if (Array.isArray(value)) {
      const bytes = array(value, path, maximumBytes).map((entry, index) => {
        const byte = integer(entry, `${path}[${index}]`, 0)
        if (byte > 255)
          fail('BYTES', `${path}[${index}]`, 'byte must be between 0 and 255')
        return byte
      })
      return new Uint8Array(bytes)
    }
    const { encoded } = encodedByteLength(value, path)
    if (encoded.length === 0) return new Uint8Array()
    const output = new Uint8Array(decodedLength)
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let offset = 0
    for (let index = 0; index < encoded.length; index += 4) {
      const first = alphabet.indexOf(encoded[index]!)
      const second = alphabet.indexOf(encoded[index + 1]!)
      const third =
        encoded[index + 2] === '=' ? 0 : alphabet.indexOf(encoded[index + 2]!)
      const fourth =
        encoded[index + 3] === '=' ? 0 : alphabet.indexOf(encoded[index + 3]!)
      if (first < 0 || second < 0 || third < 0 || fourth < 0)
        fail('BYTES', path, 'bytes must use canonical base64')
      if (
        (encoded[index + 2] === '=' && (second & 0x0f) !== 0) ||
        (encoded[index + 3] === '=' &&
          encoded[index + 2] !== '=' &&
          (third & 0x03) !== 0)
      )
        fail('BYTES', path, 'bytes must use canonical base64')
      const word = (first << 18) | (second << 12) | (third << 6) | fourth
      if (offset < output.length) output[offset++] = (word >> 16) & 0xff
      if (offset < output.length) output[offset++] = (word >> 8) & 0xff
      if (offset < output.length) output[offset++] = word & 0xff
    }
    return output
  } catch (error) {
    if (isStructCodecError(error)) throw error
    fail('BYTES', path, 'bytes cannot be inspected safely')
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = index + 1 < bytes.length ? bytes[index + 1]! : 0
    const third = index + 2 < bytes.length ? bytes[index + 2]! : 0
    const word = (first << 16) | (second << 8) | third
    encoded += alphabet[(word >> 18) & 0x3f]
    encoded += alphabet[(word >> 12) & 0x3f]
    encoded += index + 1 < bytes.length ? alphabet[(word >> 6) & 0x3f] : '='
    encoded += index + 2 < bytes.length ? alphabet[word & 0x3f] : '='
  }
  return encoded
}
