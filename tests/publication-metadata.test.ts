import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { decodeStructDocument } from '../src/document'
import { buildStructEpub } from '../src/renderers/epub'
import { seal, validDocument } from './codec-fixtures'

describe('publication metadata', () => {
  it('validates publisher and emits escaped publisher and publication date in OPF', async () => {
    const value = validDocument()
    const metadata = value.metadata as { publisher?: string }
    metadata.publisher = 'North & <South> Press'
    seal(value)

    const document = decodeStructDocument(value)
    const epub = await buildStructEpub(document)
    const packageDocument = strFromU8(unzipSync(epub.bytes)['EPUB/package.opf']!)

    expect(document.metadata.publisher).toBe('North & <South> Press')
    expect(packageDocument).toContain('<dc:date>2026-08-20</dc:date>')
    expect(packageDocument).toContain(
      '<dc:publisher>North &amp; &lt;South&gt; Press</dc:publisher>',
    )
  })

  it('rejects a non-string publisher at the codec boundary', () => {
    const value = validDocument()
    const metadata = value.metadata as { publisher?: unknown }
    metadata.publisher = 7
    seal(value)

    expect(() => decodeStructDocument(value)).toThrow(/metadata\.publisher/i)
  })

  it('emits an empty publisher when it is explicitly supplied', async () => {
    const value = validDocument()
    const metadata = value.metadata as { publisher?: string }
    metadata.publisher = ''
    seal(value)

    const epub = await buildStructEpub(decodeStructDocument(value))
    const packageDocument = strFromU8(unzipSync(epub.bytes)['EPUB/package.opf']!)

    expect(packageDocument).toContain('<dc:publisher></dc:publisher>')
  })

  it('continues to decode legacy documents that omit publisher', () => {
    const value = validDocument()

    expect(decodeStructDocument(value).metadata.publisher).toBeUndefined()
  })
})
