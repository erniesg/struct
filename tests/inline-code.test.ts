import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import {
  decodeStructDocument,
  encodeStructDocument,
} from '../src/document/index'
import { buildStructEpub } from '../src/renderers/epub'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import { seal, validDocument } from './codec-fixtures'

/**
 * A document whose first block carries exactly one paragraph of text and one
 * inline run, so a test can state the span it means.
 */
function documentWithRun(
  text: string,
  run: Record<string, unknown>,
): ReturnType<typeof validDocument> {
  const value = validDocument() as any
  value.blocks[0].text = text
  value.blocks[0].inline = [{ start: 0, end: text.length, ...run }]
  value.receipt.textCharacterCount = text.length
  value.receipt.conservation.sourceTextCharacterCount = text.length
  value.receipt.conservation.structTextCharacterCount = text.length
  seal(value)
  return value
}

describe('STRUCT inline code', () => {
  it('round-trips the optional inline code flag through encode and decode', () => {
    const value = documentWithRun('main', { code: true })
    const decoded = decodeStructDocument(value)

    expect(decoded.blocks[0]?.inline[0]).toMatchObject({
      start: 0,
      end: 4,
      code: true,
    })

    const encoded = encodeStructDocument(decoded)

    expect(encoded.blocks[0]?.inline[0]).toMatchObject({ code: true })
    expect(decodeStructDocument(encoded).blocks[0]?.inline[0]).toMatchObject({
      code: true,
    })
  })

  it('accepts a document that omits the inline code flag', () => {
    const value = documentWithRun('main', { bold: true })
    const decoded = decodeStructDocument(value)

    expect(decoded.blocks[0]?.inline[0]).not.toHaveProperty('code')
  })

  it('rejects a non-boolean inline code flag', () => {
    const value = documentWithRun('main', { code: 'yes' })

    expect(() => decodeStructDocument(value)).toThrow(/code/i)
  })

  it('rejects a zero-width inline run that carries the inline code flag', () => {
    const value = validDocument() as any
    value.blocks[0].inline = [{ start: 0, end: 0, code: true }]
    seal(value)

    expect(() => decodeStructDocument(value)).toThrow(/zero-width/i)
  })

  it('still refuses an unknown inline field next to the inline code flag', () => {
    const value = documentWithRun('main', { code: true, monospace: true })

    expect(() => decodeStructDocument(value)).toThrow(/unknown field/i)
  })

  it('renders the inline code span as an HTML code element', () => {
    const value = documentWithRun('main', { code: true })
    const xhtml = renderPublicationXhtml(decodeStructDocument(value))

    expect(xhtml).toContain('<code>main</code>')
  })

  it('escapes the text inside the inline code element', () => {
    const value = documentWithRun('a<b&c', { code: true })
    const xhtml = renderPublicationXhtml(decodeStructDocument(value))

    expect(xhtml).toContain('<code>a&lt;b&amp;c</code>')
    expect(xhtml).not.toContain('<code>a<b&c</code>')
  })

  it('nests the inline code element inside the emphasis elements', () => {
    const value = documentWithRun('main', { code: true, bold: true })
    const decoded = decodeStructDocument(value)
    const xhtml = renderPublicationXhtml(decoded)

    expect(xhtml).toContain('<strong><code>main</code></strong>')

    const italic = documentWithRun('main', { code: true, italic: true })

    expect(renderPublicationXhtml(decodeStructDocument(italic))).toContain(
      '<em><code>main</code></em>',
    )

    const subscript = documentWithRun('main', {
      code: true,
      verticalAlign: 'subscript',
    })

    expect(renderPublicationXhtml(decodeStructDocument(subscript))).toContain(
      '<sub><code>main</code></sub>',
    )
  })

  it('renders the inline code element through the EPUB content document', async () => {
    const value = documentWithRun('main', { code: true })
    const epub = await buildStructEpub(decodeStructDocument(value))
    const content = strFromU8(unzipSync(epub.bytes)['EPUB/content.xhtml']!)

    expect(content).toContain('<code>main</code>')
  })
})
