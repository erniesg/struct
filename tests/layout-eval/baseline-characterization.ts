import { strFromU8, unzipSync } from 'fflate'
import { expect } from 'vitest'
import {
  decodeStructDocument,
  type StructDocument,
} from '../../src/index'
import {
  buildStructEpub,
  type StructEpubExport,
  type StructEpubOptions,
} from '../../src/renderers/epub'
import { normalizeStructDocumentForRenderer } from '../../src/renderers/ingress'
import { renderPublicationXhtml } from '../../src/renderers/xhtml'
import {
  buildSealedSyntheticFixture,
  buildSyntheticFixture,
} from './fixture-builder'

export type BaselinePublication = {
  decoded: StructDocument
  epub: StructEpubExport
  normalized: StructDocument
  reopened: Record<string, Uint8Array>
  xhtml: string
}

/** Exercise the four Stage 2.1 boundaries against one already sealed value. */
export async function characterizeSealedDocument(
  input: StructDocument,
  options: StructEpubOptions = {},
): Promise<BaselinePublication> {
  const before = structuredClone(input)
  const decoded = decodeStructDocument(input)
  const normalized = normalizeStructDocumentForRenderer(decoded)

  expect(decoded).toEqual(before)
  expect(normalized).toEqual(decoded)
  expect(decoded).not.toBe(input)
  expect(normalized).not.toBe(decoded)

  const xhtml = renderPublicationXhtml(decoded)
  const epub = await buildStructEpub(decoded, options)
  const reopened = unzipSync(epub.bytes)

  expect(input).toEqual(before)
  expect(strFromU8(reopened['EPUB/content.xhtml']!)).toBe(xhtml)

  return { decoded, epub, normalized, reopened, xhtml }
}

export function characterizeRenderedCase(
  caseId: string,
  options: StructEpubOptions = {},
): Promise<BaselinePublication> {
  return characterizeSealedDocument(
    buildSealedSyntheticFixture(caseId),
    options,
  )
}

function expectStructCodecError(
  run: () => unknown,
  code: string,
): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ name: 'StructCodecError', code })
}

/** Pin the same stable codec rejection at every direct publication boundary. */
export async function characterizeCodecRejection(
  caseId: string,
  code: string,
): Promise<StructDocument> {
  const invalid = buildSyntheticFixture(caseId)
  expectStructCodecError(() => decodeStructDocument(invalid), code)
  expectStructCodecError(
    () => normalizeStructDocumentForRenderer(invalid),
    code,
  )
  expectStructCodecError(() => renderPublicationXhtml(invalid), code)
  await expect(buildStructEpub(invalid)).rejects.toMatchObject({
    name: 'StructCodecError',
    code,
  })
  return invalid
}

/** XHTML remains inspectable, while publication stops at the recovery gate. */
export async function characterizeReviewRefusal(
  caseId: string,
): Promise<Omit<BaselinePublication, 'epub' | 'reopened'>> {
  const input = buildSealedSyntheticFixture(caseId)
  const before = structuredClone(input)
  const decoded = decodeStructDocument(input)
  const normalized = normalizeStructDocumentForRenderer(decoded)
  const xhtml = renderPublicationXhtml(decoded)

  expect(decoded).toEqual(before)
  expect(normalized).toEqual(decoded)
  expect(() => renderPublicationXhtml(decoded)).not.toThrow()
  await expect(buildStructEpub(decoded)).rejects.toThrow(
    'STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED',
  )
  expect(input).toEqual(before)

  return { decoded, normalized, xhtml }
}

export function reopenedText(
  publication: Pick<BaselinePublication, 'reopened'>,
  path: string,
): string {
  const bytes = publication.reopened[path]
  expect(bytes, `missing synthetic EPUB entry ${path}`).toBeDefined()
  return strFromU8(bytes!)
}
