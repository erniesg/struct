import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { buildStructEpub } from '../src/renderers/epub'
import { renderPublicationXhtml } from '../src/renderers/xhtml'
import { sha256HexSync } from '../src/sha256'
import { seal, validDocument } from './codec-fixtures'

function documentWithMath(enabled = true): any {
  const document: any = validDocument()
  document.metadata.authorNotes = []
  document.assets = []
  document.relationships = []
  document.blocks[0].inline = []
  document.blocks[0].fallbackAssetIds = []
  if (enabled) {
    document.blocks[0].kind = 'equation'
    document.blocks[0].attributes = {
      mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mo stretchy="true">(</mo><mtable><mtr><mtd><mn>1</mn></mtd></mtr><mtr><mtd><mn>2</mn></mtd></mtr><mtr><mtd><mn>3</mn></mtd></mtr></mtable><mo stretchy="true">)</mo></mrow></math>',
    }
  }
  Object.assign(document.receipt, { assetCount: 0, relationshipCount: 0 })
  Object.assign(document.receipt.conservation, { sourceAssetCount: 0, accountedSourceAssetCount: 0, structAssetCount: 0, sourceRelationshipCount: 0, accountedSourceRelationshipCount: 0, structRelationshipCount: 0 })
  return seal(document)
}

const profile = (id: string) => ({ id, version: '1.0.0', fileName: `${id}.epub`, pageProgressionDirection: 'ltr' as const, renditionFlow: 'paginated' as const, configurationSha256: 'c'.repeat(64), css: 'body { font-family: serif; } math { font-size: 24px; }' })

describe('portable native math font', () => {
  it('embeds the font and license in standalone XHTML without local or network dependencies', () => {
    const xhtml = renderPublicationXhtml(documentWithMath())
    expect(xhtml).toContain('data:font/woff2;base64,')
    expect(xhtml).toContain('font-family: "Struct STIX Two Math"')
    expect(xhtml).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(xhtml).not.toContain('src: local(')
    expect(xhtml).not.toContain('url("https://')
  })

  it.each(['paperpro', 'papermove'])('packages one exact font for %s without changing profile or semantic receipts', async id => {
    const document = documentWithMath()
    const before = structuredClone(document)
    const requested = profile(id)
    const result = await buildStructEpub(document, { profile: requested })
    const entries = unzipSync(result.bytes)
    const font = entries['EPUB/fonts/struct-stix-two-math.woff2']
    expect(font).toBeDefined()
    expect(String.fromCharCode(...font!.slice(0, 4))).toBe('wOF2')
    expect(sha256HexSync(font!)).toBe('094191335def3f0452c81ec0713cfc2f29bb6af8cecbf79b60881fbf2db97562')
    expect(strFromU8(entries['EPUB/package.opf']!)).toContain('href="fonts/struct-stix-two-math.woff2" media-type="font/woff2"')
    expect(strFromU8(entries['EPUB/content.xhtml']!)).toContain('href="struct-math.css"')
    expect(strFromU8(entries['EPUB/content.xhtml']!)).not.toContain('data:font/')
    expect(strFromU8(entries['EPUB/struct-math.css']!)).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(strFromU8(entries['EPUB/struct-math.css']!)).toContain('url("fonts/struct-stix-two-math.woff2")')
    expect(strFromU8(entries['EPUB/styles.css']!)).toBe(requested.css)
    expect(result.profile!.cssSha256).toBe(sha256HexSync(requested.css))
    expect(document).toEqual(before)
    expect((await buildStructEpub(document, { profile: requested })).bytes).toEqual(result.bytes)
  })

  it('adds no font resources or styles when the publication has no MathML', async () => {
    const document = documentWithMath(false)
    expect(renderPublicationXhtml(document)).not.toContain('Struct STIX')
    const result = await buildStructEpub(document)
    expect(result.entries.some(path => /math|woff/.test(path))).toBe(false)
  })
})


it.each([
  { id: 'struct-math-font', href: 'assets/collision.bin' },
  { id: 'struct-math-styles', href: 'assets/collision.bin' },
  { id: 'asset-collision', href: 'fonts/struct-stix-two-math.woff2' },
  { id: 'asset-collision', href: 'struct-math.css' },
])('rejects a document asset collision with renderer resources: %j', async identity => {
  const document = documentWithMath()
  document.assets = [{ ...validDocument().assets[0], ...identity }]
  document.receipt.assetCount = 1
  Object.assign(document.receipt.conservation, { sourceAssetCount: 1, accountedSourceAssetCount: 1, structAssetCount: 1 })
  seal(document)
  await expect(buildStructEpub(document)).rejects.toThrow(/collides.*math font resource/)
})
