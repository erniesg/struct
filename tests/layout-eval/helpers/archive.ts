import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

export type ArchiveHelperErrorCode =
  | 'ARCHIVE_FORMAT'
  | 'ARCHIVE_INPUT_TYPE'
  | 'ARCHIVE_INTEGRITY'
  | 'ARCHIVE_RESOURCE_LIMIT'
  | 'ARCHIVE_UNSUPPORTED'

export class ArchiveHelperError extends Error {
  readonly code: ArchiveHelperErrorCode

  constructor(code: ArchiveHelperErrorCode) {
    super(code)
    this.name = 'ArchiveHelperError'
    this.code = code
  }
}

export class PackagePathError extends Error {
  constructor() {
    super('PACKAGE_PATH')
    this.name = 'PackagePathError'
  }
}

export type ArchiveInspectionLimits = {
  maximumArchiveBytes: number
  maximumCentralDirectoryBytes: number
  maximumEntries: number
  maximumEntryNameBytes: number
  maximumEntryUncompressedBytes: number
  maximumMetadataBytes: number
  maximumTotalUncompressedBytes: number
}

export const DEFAULT_ARCHIVE_INSPECTION_LIMITS: Readonly<ArchiveInspectionLimits> =
  Object.freeze({
    maximumArchiveBytes: 256 * 1024 * 1024,
    maximumCentralDirectoryBytes: 8 * 1024 * 1024,
    maximumEntries: 4096,
    maximumEntryNameBytes: 4096,
    maximumEntryUncompressedBytes: 64 * 1024 * 1024,
    maximumMetadataBytes: 8 * 1024 * 1024,
    maximumTotalUncompressedBytes: 256 * 1024 * 1024,
  })

export type ZipEntryInspection = {
  centralOrder: number
  compressedLength: number
  crc32: string
  dataOffset: number
  dosDate: number
  dosTime: number
  flags: number
  localHeaderOffset: number
  method: number
  name: string
  order: number
  uncompressedLength: number
}

export type ZipArchiveInspection = {
  centralDirectoryOffset: number
  centralDirectorySize: number
  commentLength: number
  duplicateNames: string[]
  entries: ZipEntryInspection[]
  localOrderMatchesCentral: boolean
}

export type SourceNeutralArchiveManifest = {
  entries: Array<{
    name: string
    method: number
    uncompressedLength: number
    crc32: string
    sha256: string
    order: number
  }>
}

type CentralEntry = {
  centralOrder: number
  compressedLength: number
  crc32: number
  dosDate: number
  dosTime: number
  externalAttributes: number
  flags: number
  localHeaderOffset: number
  method: number
  name: string
  uncompressedLength: number
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const UNSUPPORTED_ZIP_FLAGS = (1 << 0) | (1 << 5) | (1 << 6) | (1 << 13)

function archiveError(code: ArchiveHelperErrorCode): never {
  throw new ArchiveHelperError(code)
}

function checkedLimits(
  overrides: Partial<ArchiveInspectionLimits> | undefined,
): ArchiveInspectionLimits {
  const limits = { ...DEFAULT_ARCHIVE_INSPECTION_LIMITS, ...overrides }
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
  return limits
}

function uint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) archiveError('ARCHIVE_FORMAT')
  return view.getUint16(offset, true)
}

function uint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) archiveError('ARCHIVE_FORMAT')
  return view.getUint32(offset, true)
}

function addWithinBounds(...values: number[]): number {
  let result = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0)
      archiveError('ARCHIVE_FORMAT')
    result += value
    if (!Number.isSafeInteger(result)) archiveError('ARCHIVE_FORMAT')
  }
  return result
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f))
    archiveError('ARCHIVE_UNSUPPORTED')
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    archiveError('ARCHIVE_FORMAT')
  }
  if (!name || name.includes('\u0000')) archiveError('ARCHIVE_FORMAT')
  return name
}

function hexadecimal32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

function findEndOfCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
): number {
  if (bytes.byteLength < 22) archiveError('ARCHIVE_FORMAT')
  const earliest = Math.max(0, bytes.byteLength - 22 - 0xffff)
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (uint32(view, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue
    const commentLength = uint16(view, offset + 20)
    if (offset + 22 + commentLength === bytes.byteLength) return offset
  }
  archiveError('ARCHIVE_FORMAT')
}

function centralEntries(
  bytes: Uint8Array,
  view: DataView,
  centralOffset: number,
  centralSize: number,
  entryCount: number,
  limits: ArchiveInspectionLimits,
): CentralEntry[] {
  const result: CentralEntry[] = []
  let cursor = centralOffset
  let metadataBytes = 0
  const centralEnd = addWithinBounds(centralOffset, centralSize)
  for (let centralOrder = 0; centralOrder < entryCount; centralOrder += 1) {
    if (
      cursor + 46 > centralEnd ||
      uint32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE
    )
      archiveError('ARCHIVE_FORMAT')
    const flags = uint16(view, cursor + 8)
    const method = uint16(view, cursor + 10)
    const dosTime = uint16(view, cursor + 12)
    const dosDate = uint16(view, cursor + 14)
    const crc32 = uint32(view, cursor + 16)
    const compressedLength = uint32(view, cursor + 20)
    const uncompressedLength = uint32(view, cursor + 24)
    const nameLength = uint16(view, cursor + 28)
    const extraLength = uint16(view, cursor + 30)
    const commentLength = uint16(view, cursor + 32)
    const diskStart = uint16(view, cursor + 34)
    const externalAttributes = uint32(view, cursor + 38)
    const localHeaderOffset = uint32(view, cursor + 42)
    if (
      diskStart !== 0 ||
      compressedLength === 0xffffffff ||
      uncompressedLength === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    )
      archiveError('ARCHIVE_UNSUPPORTED')
    if (flags & UNSUPPORTED_ZIP_FLAGS)
      archiveError('ARCHIVE_UNSUPPORTED')
    if (nameLength < 1 || nameLength > limits.maximumEntryNameBytes)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
    metadataBytes = addWithinBounds(
      metadataBytes,
      nameLength,
      extraLength,
      commentLength,
    )
    if (metadataBytes > limits.maximumMetadataBytes)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
    const recordEnd = addWithinBounds(
      cursor,
      46,
      nameLength,
      extraLength,
      commentLength,
    )
    if (recordEnd > centralEnd) archiveError('ARCHIVE_FORMAT')
    const name = decodeEntryName(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      Boolean(flags & 0x800),
    )
    result.push({
      centralOrder,
      compressedLength,
      crc32,
      dosDate,
      dosTime,
      externalAttributes,
      flags,
      localHeaderOffset,
      method,
      name,
      uncompressedLength,
    })
    cursor = recordEnd
  }
  if (cursor !== centralEnd) archiveError('ARCHIVE_FORMAT')
  return result
}

function verifyDataDescriptor(
  view: DataView,
  offset: number,
  end: number,
  central: CentralEntry,
): void {
  const length = end - offset
  const signed = length === 16 && uint32(view, offset) === DATA_DESCRIPTOR_SIGNATURE
  if ((!signed && length !== 12) || (signed && length !== 16))
    archiveError('ARCHIVE_FORMAT')
  const valuesOffset = offset + (signed ? 4 : 0)
  if (
    uint32(view, valuesOffset) !== central.crc32 ||
    uint32(view, valuesOffset + 4) !== central.compressedLength ||
    uint32(view, valuesOffset + 8) !== central.uncompressedLength
  )
    archiveError('ARCHIVE_INTEGRITY')
}

function inspectLocalEntries(
  bytes: Uint8Array,
  view: DataView,
  central: readonly CentralEntry[],
  centralOffset: number,
  limits: ArchiveInspectionLimits,
): ZipEntryInspection[] {
  const offsets = new Set<number>()
  for (const entry of central) {
    if (offsets.has(entry.localHeaderOffset))
      archiveError('ARCHIVE_INTEGRITY')
    offsets.add(entry.localHeaderOffset)
  }
  const inLocalOrder = [...central].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  )
  if (inLocalOrder[0]?.localHeaderOffset !== 0)
    archiveError('ARCHIVE_FORMAT')
  const result: ZipEntryInspection[] = []
  let metadataBytes = 0
  for (let order = 0; order < inLocalOrder.length; order += 1) {
    const entry = inLocalOrder[order]!
    const offset = entry.localHeaderOffset
    const nextOffset =
      inLocalOrder[order + 1]?.localHeaderOffset ?? centralOffset
    if (
      offset + 30 > centralOffset ||
      uint32(view, offset) !== LOCAL_HEADER_SIGNATURE
    )
      archiveError('ARCHIVE_FORMAT')
    const flags = uint16(view, offset + 6)
    const method = uint16(view, offset + 8)
    const dosTime = uint16(view, offset + 10)
    const dosDate = uint16(view, offset + 12)
    const crc32 = uint32(view, offset + 14)
    const compressedLength = uint32(view, offset + 18)
    const uncompressedLength = uint32(view, offset + 22)
    const nameLength = uint16(view, offset + 26)
    const extraLength = uint16(view, offset + 28)
    if (nameLength < 1 || nameLength > limits.maximumEntryNameBytes)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
    metadataBytes = addWithinBounds(metadataBytes, nameLength, extraLength)
    if (metadataBytes > limits.maximumMetadataBytes)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
    const dataOffset = addWithinBounds(offset, 30, nameLength, extraLength)
    const dataEnd = addWithinBounds(dataOffset, entry.compressedLength)
    if (dataEnd > nextOffset || dataEnd > centralOffset)
      archiveError('ARCHIVE_FORMAT')
    const name = decodeEntryName(
      bytes.subarray(offset + 30, offset + 30 + nameLength),
      Boolean(flags & 0x800),
    )
    if (
      name !== entry.name ||
      flags !== entry.flags ||
      method !== entry.method ||
      dosTime !== entry.dosTime ||
      dosDate !== entry.dosDate
    )
      archiveError('ARCHIVE_INTEGRITY')
    if (flags & 0x8) {
      if (
        (crc32 !== 0 && crc32 !== entry.crc32) ||
        (compressedLength !== 0 &&
          compressedLength !== entry.compressedLength) ||
        (uncompressedLength !== 0 &&
          uncompressedLength !== entry.uncompressedLength)
      )
        archiveError('ARCHIVE_INTEGRITY')
      verifyDataDescriptor(view, dataEnd, nextOffset, entry)
    } else {
      if (
        crc32 !== entry.crc32 ||
        compressedLength !== entry.compressedLength ||
        uncompressedLength !== entry.uncompressedLength ||
        dataEnd !== nextOffset
      )
        archiveError('ARCHIVE_INTEGRITY')
    }
    result.push({
      centralOrder: entry.centralOrder,
      compressedLength: entry.compressedLength,
      crc32: hexadecimal32(entry.crc32),
      dataOffset,
      dosDate,
      dosTime,
      flags,
      localHeaderOffset: offset,
      method,
      name,
      order,
      uncompressedLength: entry.uncompressedLength,
    })
  }
  return result
}

function duplicateNames(entries: readonly ZipEntryInspection[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) duplicates.add(entry.name)
    else seen.add(entry.name)
  }
  return [...duplicates]
}

export function inspectZipArchive(
  value: Uint8Array,
  limitOverrides?: Partial<ArchiveInspectionLimits>,
): ZipArchiveInspection {
  const limits = checkedLimits(limitOverrides)
  if (!(value instanceof Uint8Array)) archiveError('ARCHIVE_INPUT_TYPE')
  if (value.byteLength > limits.maximumArchiveBytes)
    archiveError('ARCHIVE_RESOURCE_LIMIT')
  const bytes = value
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = findEndOfCentralDirectory(bytes, view)
  const disk = uint16(view, endOffset + 4)
  const centralDisk = uint16(view, endOffset + 6)
  const diskEntries = uint16(view, endOffset + 8)
  const entryCount = uint16(view, endOffset + 10)
  const centralDirectorySize = uint32(view, endOffset + 12)
  const centralDirectoryOffset = uint32(view, endOffset + 16)
  const commentLength = uint16(view, endOffset + 20)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  )
    archiveError('ARCHIVE_UNSUPPORTED')
  if (entryCount < 1 || entryCount > limits.maximumEntries)
    archiveError('ARCHIVE_RESOURCE_LIMIT')
  if (centralDirectorySize > limits.maximumCentralDirectoryBytes)
    archiveError('ARCHIVE_RESOURCE_LIMIT')
  if (
    addWithinBounds(centralDirectoryOffset, centralDirectorySize) !== endOffset
  )
    archiveError('ARCHIVE_FORMAT')
  const central = centralEntries(
    bytes,
    view,
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount,
    limits,
  )
  const entries = inspectLocalEntries(
    bytes,
    view,
    central,
    centralDirectoryOffset,
    limits,
  )
  return {
    centralDirectoryOffset,
    centralDirectorySize,
    commentLength,
    duplicateNames: duplicateNames(entries),
    entries,
    localOrderMatchesCentral: entries.every(
      (entry) => entry.order === entry.centralOrder,
    ),
  }
}

let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let remainder = value
    for (let bit = 0; bit < 8; bit += 1)
      remainder =
        remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1
    return remainder >>> 0
  })
  let remainder = 0xffffffff
  for (const byte of bytes)
    remainder = crcTable[(remainder ^ byte) & 0xff]! ^ (remainder >>> 8)
  return (remainder ^ 0xffffffff) >>> 0
}

function reopenEntry(
  archive: Uint8Array,
  entry: ZipEntryInspection,
  limits: ArchiveInspectionLimits,
): Uint8Array {
  if (entry.uncompressedLength > limits.maximumEntryUncompressedBytes)
    archiveError('ARCHIVE_RESOURCE_LIMIT')
  const compressed = archive.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedLength,
  )
  let reopened: Uint8Array
  if (entry.method === 0) {
    if (entry.compressedLength !== entry.uncompressedLength)
      archiveError('ARCHIVE_INTEGRITY')
    reopened = compressed
  } else if (entry.method === 8) {
    try {
      reopened = new Uint8Array(
        inflateRawSync(
          Buffer.from(
            compressed.buffer,
            compressed.byteOffset,
            compressed.byteLength,
          ),
          {
            maxOutputLength: Math.max(
              1,
              Math.min(
                limits.maximumEntryUncompressedBytes,
                entry.uncompressedLength + 1,
              ),
            ),
          },
        ),
      )
    } catch {
      archiveError('ARCHIVE_INTEGRITY')
    }
  } else archiveError('ARCHIVE_UNSUPPORTED')
  if (
    reopened.byteLength !== entry.uncompressedLength ||
    hexadecimal32(crc32(reopened)) !== entry.crc32
  )
    archiveError('ARCHIVE_INTEGRITY')
  return reopened
}

export function createArchiveManifest(
  archive: Uint8Array,
  limitOverrides?: Partial<ArchiveInspectionLimits>,
): SourceNeutralArchiveManifest {
  const limits = checkedLimits(limitOverrides)
  const inspection = inspectZipArchive(archive, limits)
  let totalUncompressedBytes = 0
  for (const entry of inspection.entries) {
    if (entry.uncompressedLength > limits.maximumEntryUncompressedBytes)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
    totalUncompressedBytes = addWithinBounds(
      totalUncompressedBytes,
      entry.uncompressedLength,
    )
    if (totalUncompressedBytes > limits.maximumTotalUncompressedBytes)
      archiveError('ARCHIVE_RESOURCE_LIMIT')
  }
  return {
    entries: inspection.entries.map((entry) => {
      const bytes = reopenEntry(archive, entry, limits)
      return {
        name: entry.name,
        method: entry.method,
        uncompressedLength: entry.uncompressedLength,
        crc32: entry.crc32,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        order: entry.order,
      }
    }),
  }
}

function hasUnsafePackageCharacters(value: string): boolean {
  return (
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /\p{White_Space}/u.test(value)
  )
}

function safeCanonicalPackagePath(path: string): boolean {
  if (
    !path ||
    path !== path.trim() ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('%') ||
    path.includes('?') ||
    path.includes('#') ||
    hasUnsafePackageCharacters(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  )
    return false
  const segments = path.split('/')
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  )
}

export type PackageReferenceResolution =
  | {
      fragment: string | null
      kind: 'internal'
      path: string
    }
  | {
      href: string
      kind: 'external'
      scheme: 'http' | 'https' | 'mailto'
    }

export function resolvePackageReference(
  currentDocument: string,
  reference: string,
): PackageReferenceResolution {
  if (
    typeof currentDocument !== 'string' ||
    typeof reference !== 'string' ||
    !safeCanonicalPackagePath(currentDocument) ||
    !reference ||
    reference !== reference.trim() ||
    reference.includes('\\') ||
    hasUnsafePackageCharacters(reference)
  )
    throw new PackagePathError()
  const schemeMatch = reference.match(/^([A-Za-z][A-Za-z0-9+.-]*):/u)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto')
      throw new PackagePathError()
    if (scheme === 'http' || scheme === 'https') {
      try {
        const url = new URL(reference)
        if (
          url.protocol !== `${scheme}:` ||
          !url.hostname ||
          url.username ||
          url.password
        )
          throw new PackagePathError()
      } catch (error) {
        if (error instanceof PackagePathError) throw error
        throw new PackagePathError()
      }
    }
    return {
      kind: 'external',
      href: reference,
      scheme,
    }
  }
  if (
    reference.startsWith('/') ||
    reference.startsWith('//') ||
    reference.includes('?') ||
    reference.includes('%')
  )
    throw new PackagePathError()
  const firstHash = reference.indexOf('#')
  if (firstHash !== -1 && reference.indexOf('#', firstHash + 1) !== -1)
    throw new PackagePathError()
  const pathReference =
    firstHash === -1 ? reference : reference.slice(0, firstHash)
  const fragment = firstHash === -1 ? null : reference.slice(firstHash + 1)
  if (
    fragment !== null &&
    (!fragment || hasUnsafePackageCharacters(fragment))
  )
    throw new PackagePathError()
  const resolved = currentDocument.split('/')
  resolved.pop()
  if (pathReference) {
    for (const segment of pathReference.split('/')) {
      if (!segment || hasUnsafePackageCharacters(segment))
        throw new PackagePathError()
      if (segment === '.') continue
      if (segment === '..') {
        if (resolved.length === 0) throw new PackagePathError()
        resolved.pop()
      } else resolved.push(segment)
    }
  } else resolved.push(currentDocument.split('/').at(-1)!)
  const path = resolved.join('/')
  if (!safeCanonicalPackagePath(path)) throw new PackagePathError()
  return { kind: 'internal', path, fragment }
}
