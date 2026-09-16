import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  createArchiveManifest,
  inspectZipArchive,
  PackagePathError,
  resolvePackageReference,
} from './helpers/archive'
import {
  assertAccessibilityLinks,
  assertArchiveCanonicalOrder,
  assertArchiveCompression,
  assertArchiveFirstEntry,
  assertArchiveTimestamps,
  assertExactVisibleTextTokens,
  assertNavigationHierarchy,
  assertNavigationTargets,
  assertNoArchiveDuplicates,
  assertNoHiddenSemanticTextDuplicates,
  assertOpfManifestLinks,
  assertOpfMetadataLinks,
  assertOpfSpineLinks,
  assertSemanticLinks,
  assertTableLinks,
  CLOSED_LAYOUT_ASSERTIONS,
  LayoutAssertionError,
} from './helpers/assertions'
import {
  inspectNavigation,
  inspectOpf,
  inspectXhtml,
  parseXmlDocument,
  XmlHelperError,
} from './helpers/xml'

const fixedZipTime = new Date(1980, 0, 1, 0, 0, 0)

function syntheticArchive(
  secondTimestamp = fixedZipTime,
): Uint8Array {
  return zipSync({
    mimetype: [
      strToU8('application/epub+zip'),
      { level: 0, mtime: fixedZipTime },
    ],
    'META-INF/container.xml': [
      strToU8('<container/>'),
      { level: 6, mtime: secondTimestamp },
    ],
    'EPUB/content.xhtml': [
      strToU8(`<p>${'invented '.repeat(64)}</p>`),
      { level: 6, mtime: fixedZipTime },
    ],
    'EPUB/other.txt': [
      strToU8('other invented value'),
      { level: 6, mtime: fixedZipTime },
    ],
    'EPUB/check.txt': [strToU8('123456789'), { level: 0, mtime: fixedZipTime }],
  })
}

function duplicateSyntheticEntry(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice()
  const from = strToU8('EPUB/check.txt')
  const to = strToU8('EPUB/other.txt')
  expect(from.byteLength).toBe(to.byteLength)
  let replacements = 0
  for (let index = 0; index <= result.byteLength - from.byteLength; index += 1) {
    if (from.every((value, offset) => result[index + offset] === value)) {
      result.set(to, index)
      replacements += 1
      index += from.byteLength - 1
    }
  }
  expect(replacements).toBe(2)
  return result
}

function littleUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function littleUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function syntheticCentralDirectoryOffset(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1)
    if (littleUint32(bytes, offset) === 0x06054b50)
      return littleUint32(bytes, offset + 16)
  throw new Error('synthetic ZIP has no central directory')
}

function reorderLastTwoCentralEntries(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice()
  const centralOffset = syntheticCentralDirectoryOffset(result)
  const records: Array<{ end: number; start: number }> = []
  let cursor = centralOffset
  while (littleUint32(result, cursor) === 0x02014b50) {
    const length =
      46 +
      littleUint16(result, cursor + 28) +
      littleUint16(result, cursor + 30) +
      littleUint16(result, cursor + 32)
    records.push({ start: cursor, end: cursor + length })
    cursor += length
  }
  const left = records.at(-2)!
  const right = records.at(-1)!
  expect(left.end - left.start).toBe(right.end - right.start)
  const leftBytes = result.slice(left.start, left.end)
  const rightBytes = result.slice(right.start, right.end)
  result.set(rightBytes, left.start)
  result.set(leftBytes, right.start)
  return result
}

function mismatchFirstCentralMethod(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice()
  const centralOffset = syntheticCentralDirectoryOffset(result)
  result[centralOffset + 10] = 8
  result[centralOffset + 11] = 0
  return result
}

function expectClosedFailure(
  run: () => void,
  caseId: string,
  assertion: (typeof CLOSED_LAYOUT_ASSERTIONS)[number],
  prohibitedText?: string,
): void {
  try {
    run()
    throw new Error('expected a closed layout assertion failure')
  } catch (error) {
    expect(error).toBeInstanceOf(LayoutAssertionError)
    expect((error as LayoutAssertionError).message).toBe(
      `${caseId}:${assertion}`,
    )
    expect((error as LayoutAssertionError).caseId).toBe(caseId)
    expect((error as LayoutAssertionError).assertion).toBe(assertion)
    if (prohibitedText !== undefined)
      expect((error as LayoutAssertionError).message).not.toContain(
        prohibitedText,
      )
  }
}

describe('bounded XML helper self-tests', () => {
  it('collects XHTML structure without losing namespaces or exact text segments', () => {
    const xhtml = inspectXhtml(`<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      xmlns:xlink="http://www.w3.org/1999/xlink"
      xml:lang="en" lang="en" dir="ltr">
  <head><title>Excluded title</title><style>.invented { display: none; }</style></head>
  <body>
    <h2 id="heading-a">Alpha &amp; Beta</h2>
    <p id="paragraph-a">Invented <em>inline</em> text &#x26; detail.</p>
    <a id="citation-a" href="#reference-a" epub:type="biblioref" role="doc-biblioref">[1]</a>
    <img id="image-a" src="images/shape.svg" xlink:href="images/fallback.svg" alt="Invented shape" />
    <table id="table-a" aria-labelledby="caption-a">
      <caption id="caption-a">Invented totals</caption>
      <tr><th id="header-a" scope="col">Label</th><td headers="header-a">7</td></tr>
    </table>
    <span class="visually-hidden">Excluded helper text</span>
    <aside id="reference-a" epub:type="bibliography" role="doc-bibliography">Reference A</aside>
  </body>
</html>`)

    expect(xhtml.rootLanguage).toEqual({ xml: 'en', html: 'en' })
    expect(xhtml.rootDirection).toBe('ltr')
    expect(xhtml.ids).toEqual([
      'heading-a',
      'paragraph-a',
      'citation-a',
      'image-a',
      'table-a',
      'caption-a',
      'header-a',
      'reference-a',
    ])
    expect(xhtml.hrefs.map(({ value }) => value)).toEqual(['#reference-a'])
    expect(xhtml.srcs.map(({ value }) => value)).toEqual([
      'images/shape.svg',
    ])
    expect(
      xhtml.namespacedHrefs.map(({ namespaceUri, value }) => ({
        namespaceUri,
        value,
      })),
    ).toEqual([
      {
        namespaceUri: 'http://www.w3.org/1999/xlink',
        value: 'images/fallback.svg',
      },
    ])
    expect(xhtml.headings).toEqual([
      {
        id: 'heading-a',
        level: 2,
        text: 'Alpha & Beta',
        textTokens: ['Alpha', '&', 'Beta'],
      },
    ])
    expect(xhtml.visibleTextTokens).toEqual([
      'Alpha',
      '&',
      'Beta',
      'Invented',
      'inline',
      'text',
      '&',
      'detail.',
      '[1]',
      'Invented',
      'totals',
      'Label',
      '7',
      'Reference',
      'A',
    ])
    expect(xhtml.visibleTextSegments.join('')).not.toContain('Excluded')
    expect(xhtml.roles.map(({ tokens }) => tokens)).toEqual([
      ['doc-biblioref'],
      ['doc-bibliography'],
    ])
    expect(xhtml.epubTypes.map(({ tokens }) => tokens)).toEqual([
      ['biblioref'],
      ['bibliography'],
    ])
    expect(xhtml.tables).toEqual([
      {
        ariaLabel: undefined,
        ariaLabelledBy: ['caption-a'],
        captions: [{ id: 'caption-a', text: 'Invented totals' }],
        cells: [
          {
            headers: [],
            id: 'header-a',
            kind: 'th',
            scope: 'col',
            text: 'Label',
          },
          {
            headers: ['header-a'],
            id: undefined,
            kind: 'td',
            scope: undefined,
            text: '7',
          },
        ],
        id: 'table-a',
      },
    ])
  })

  it('accepts only predefined and numeric references and never expands declared entities', () => {
    expect(
      parseXmlDocument(
        '\uFEFF<?xml version="1.0" encoding="UTF-8"?><root />',
      ).root.qualifiedName,
    ).toBe('root')
    expect(
      parseXmlDocument('<root value="&quot;">&lt;&amp;&#65;&#x42;</root>')
        .root.children,
    ).toEqual([{ type: 'text', value: '<&AB' }])

    for (const xml of [
      '<!DOCTYPE root [<!ENTITY private "invented-secret">]><root>&private;</root>',
      '<!DOCTYPE root SYSTEM "invented-secret"><root/>',
      '<root>&private;</root>',
    ]) {
      try {
        parseXmlDocument(xml)
        throw new Error('expected forbidden entity rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(XmlHelperError)
        expect((error as XmlHelperError).code).toMatch(
          /^XML_FORBIDDEN_(?:DECLARATION|ENTITY)$/u,
        )
        expect((error as Error).message).not.toContain('invented-secret')
        expect((error as Error).message).not.toContain('private')
      }
    }
  })

  it('rejects malformed XML declarations with closed syntax errors', () => {
    expect(
      parseXmlDocument(
        `<?xml version = '1.0' encoding="UTF-8" standalone = 'yes'?><root />`,
      ).root.qualifiedName,
    ).toBe('root')

    for (const xml of [
      '<?xml arbitrary?><root />',
      '<?xml?><root />',
      '<?xml encoding="UTF-8" version="1.0"?><root />',
      '<?xml version="1.0" invented="detail"?><root />',
      '<?xml version="2.0"?><root />',
      '<?xml version="1.0" encoding="8UTF"?><root />',
      '<?xml version="1.0" standalone="sometimes"?><root />',
    ]) {
      try {
        parseXmlDocument(xml)
        throw new Error('expected malformed declaration rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(XmlHelperError)
        expect((error as XmlHelperError).code).toBe('XML_INVALID_SYNTAX')
        expect((error as Error).message).toBe('XML_INVALID_SYNTAX')
        expect((error as Error).message).not.toContain(xml)
      }
    }
  })

  it('fails closed on malformed XML and namespace misuse', () => {
    for (const xml of [
      '<root><child></root>',
      '<root><unknown:item /></root>',
      '<root xmlns:a="urn:a" xmlns:b="urn:a" a:key="1" b:key="2" />',
      '<root>\u0000</root>',
    ])
      expect(() => parseXmlDocument(xml)).toThrow(XmlHelperError)
  })

  it('bounds bytes, depth, nodes, attributes, and decoded text traversal', () => {
    expect(parseXmlDocument('<a/>', { maximumBytes: 4 }).root.localName).toBe(
      'a',
    )
    expect(
      parseXmlDocument('<a><b/></a>', { maximumDepth: 2 }).nodeCount,
    ).toBe(2)
    expect(
      parseXmlDocument('<a><b/></a>', { maximumNodes: 2 }).nodeCount,
    ).toBe(2)
    expect(
      parseXmlDocument('<a x="1" />', { maximumAttributes: 1 })
        .attributeCount,
    ).toBe(1)
    expect(
      parseXmlDocument('<a>AB</a>', { maximumTextBytes: 2 }).textByteCount,
    ).toBe(2)
    const cases: Array<[
      string,
      Parameters<typeof parseXmlDocument>[1],
    ]> = [
      ['<root>abcd</root>', { maximumBytes: 8 }],
      ['<a><b><c /></b></a>', { maximumDepth: 2 }],
      ['<a><b /><c /></a>', { maximumNodes: 2 }],
      ['<a x="1" y="2" />', { maximumAttributes: 1 }],
      ['<a>&#65;&#66;&#67;</a>', { maximumTextBytes: 2 }],
    ]
    for (const [xml, limits] of cases) {
      try {
        parseXmlDocument(xml, limits)
        throw new Error('expected XML resource rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(XmlHelperError)
        expect((error as XmlHelperError).code).toBe('XML_RESOURCE_LIMIT')
      }
    }
  })

  it('parses OPF metadata, manifest, and spine fields in document order', () => {
    const opf = inspectOpf(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         version="3.0" unique-identifier="publication-id" xml:lang="en">
  <metadata>
    <dc:identifier id="publication-id">urn:synthetic:one</dc:identifier>
    <dc:title id="title-a">Invented &amp; Exact</dc:title>
    <dc:language>en</dc:language>
    <dc:creator id="creator-a">Author A</dc:creator>
    <meta refines="#creator-a" property="role">aut</meta>
    <meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav scripted" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine page-progression-direction="ltr">
    <itemref idref="content" linear="yes" />
  </spine>
</package>`)

    expect(opf.version).toBe('3.0')
    expect(opf.uniqueIdentifier).toBe('publication-id')
    expect(opf.language).toBe('en')
    expect(
      opf.metadata.map(({ id, localName, namespaceUri, property, refines, value }) => ({
        id,
        localName,
        namespaceUri,
        property,
        refines,
        value,
      })),
    ).toEqual([
      {
        id: 'publication-id',
        localName: 'identifier',
        namespaceUri: 'http://purl.org/dc/elements/1.1/',
        property: undefined,
        refines: undefined,
        value: 'urn:synthetic:one',
      },
      {
        id: 'title-a',
        localName: 'title',
        namespaceUri: 'http://purl.org/dc/elements/1.1/',
        property: undefined,
        refines: undefined,
        value: 'Invented & Exact',
      },
      {
        id: undefined,
        localName: 'language',
        namespaceUri: 'http://purl.org/dc/elements/1.1/',
        property: undefined,
        refines: undefined,
        value: 'en',
      },
      {
        id: 'creator-a',
        localName: 'creator',
        namespaceUri: 'http://purl.org/dc/elements/1.1/',
        property: undefined,
        refines: undefined,
        value: 'Author A',
      },
      {
        id: undefined,
        localName: 'meta',
        namespaceUri: 'http://www.idpf.org/2007/opf',
        property: 'role',
        refines: '#creator-a',
        value: 'aut',
      },
      {
        id: undefined,
        localName: 'meta',
        namespaceUri: 'http://www.idpf.org/2007/opf',
        property: 'dcterms:modified',
        refines: undefined,
        value: '2000-01-01T00:00:00Z',
      },
    ])
    expect(opf.manifest).toEqual([
      {
        fallback: undefined,
        href: 'nav.xhtml',
        id: 'nav',
        mediaOverlay: undefined,
        mediaType: 'application/xhtml+xml',
        properties: ['nav', 'scripted'],
      },
      {
        fallback: undefined,
        href: 'content.xhtml',
        id: 'content',
        mediaOverlay: undefined,
        mediaType: 'application/xhtml+xml',
        properties: [],
      },
    ])
    expect(opf.spine).toEqual({
      items: [{ idref: 'content', linear: 'yes', properties: [] }],
      pageProgressionDirection: 'ltr',
      toc: undefined,
    })
  })

  it('collects a nested EPUB navigation hierarchy without flattening it', () => {
    const navigation = inspectNavigation(`<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc" aria-label="Invented contents">
      <ol>
        <li><a href="content.xhtml#one">One &amp; first</a>
          <ol><li><a href="content.xhtml#two"><span>Two</span> nested</a></li></ol>
        </li>
        <li><a href="content.xhtml#three">Three</a></li>
      </ol>
    </nav>
  </body>
</html>`)

    expect(navigation.tocs).toEqual([
      {
        ariaLabel: 'Invented contents',
        items: [
          {
            children: [
              {
                children: [],
                href: 'content.xhtml#two',
                label: 'Two nested',
                labelTokens: ['Two', 'nested'],
              },
            ],
            href: 'content.xhtml#one',
            label: 'One & first',
            labelTokens: ['One', '&', 'first'],
          },
          {
            children: [],
            href: 'content.xhtml#three',
            label: 'Three',
            labelTokens: ['Three'],
          },
        ],
      },
    ])
  })
})

describe('independent ZIP and package-path helper self-tests', () => {
  it('reads local and central headers, methods, timestamps, and physical order', () => {
    const archive = inspectZipArchive(syntheticArchive())

    expect(archive.entries.map(({ name }) => name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'EPUB/content.xhtml',
      'EPUB/other.txt',
      'EPUB/check.txt',
    ])
    expect(archive.entries.map(({ centralOrder }) => centralOrder)).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect(archive.entries[0]).toMatchObject({
      method: 0,
      dosDate: 33,
      dosTime: 0,
      uncompressedLength: 20,
    })
    expect(archive.entries[2]!.method).toBe(8)
    expect(archive.duplicateNames).toEqual([])
    expect(archive.localOrderMatchesCentral).toBe(true)
  })

  it('creates a closed source-neutral manifest from independently reopened bytes', () => {
    const manifest = createArchiveManifest(syntheticArchive())
    expect(Object.keys(manifest)).toEqual(['entries'])
    expect(manifest.entries.map((entry) => Object.keys(entry))).toEqual(
      Array.from({ length: 5 }, () => [
        'name',
        'method',
        'uncompressedLength',
        'crc32',
        'sha256',
        'order',
      ]),
    )
    expect(manifest.entries[4]).toEqual({
      name: 'EPUB/check.txt',
      method: 0,
      uncompressedLength: 9,
      crc32: 'cbf43926',
      sha256: '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225',
      order: 4,
    })
    expect(JSON.stringify(manifest)).not.toMatch(
      /(?:source|input|fileName|modifiedAt|absolutePath)/u,
    )
    expect(manifest.entries[0]!.sha256).toBe(
      createHash('sha256').update('application/epub+zip').digest('hex'),
    )
  })

  it('preserves duplicate central and local names for an independent assertion', () => {
    const duplicated = duplicateSyntheticEntry(syntheticArchive())
    const archive = inspectZipArchive(duplicated)
    expect(archive.duplicateNames).toEqual(['EPUB/other.txt'])
    expect(archive.entries.at(-1)?.name).toBe('EPUB/other.txt')
  })

  it('distinguishes physical local order from independently encoded central order', () => {
    const archive = inspectZipArchive(
      reorderLastTwoCentralEntries(syntheticArchive()),
    )
    expect(archive.entries.map(({ name }) => name).slice(-2)).toEqual([
      'EPUB/other.txt',
      'EPUB/check.txt',
    ])
    expect(archive.entries.map(({ centralOrder }) => centralOrder).slice(-2)).toEqual([
      4, 3,
    ])
    expect(archive.localOrderMatchesCentral).toBe(false)
  })

  it('rejects malformed, over-bound, and integrity-invalid ZIP structures', () => {
    expect(
      inspectZipArchive(syntheticArchive(), { maximumEntries: 5 }).entries,
    ).toHaveLength(5)
    expect(() => inspectZipArchive(syntheticArchive().subarray(0, 20))).toThrow(
      /ARCHIVE_FORMAT/u,
    )
    expect(() =>
      inspectZipArchive(syntheticArchive(), { maximumEntries: 3 }),
    ).toThrow(/ARCHIVE_RESOURCE_LIMIT/u)
    const boundedArchive = syntheticArchive()
    const declaredTotal = inspectZipArchive(boundedArchive).entries.reduce(
      (total, entry) => total + entry.uncompressedLength,
      0,
    )
    expect(
      createArchiveManifest(boundedArchive, {
        maximumTotalUncompressedBytes: declaredTotal,
      }).entries,
    ).toHaveLength(5)
    expect(() =>
      createArchiveManifest(boundedArchive, {
        maximumTotalUncompressedBytes: declaredTotal - 1,
      }),
    ).toThrow(/ARCHIVE_RESOURCE_LIMIT/u)
    expect(() =>
      inspectZipArchive(mismatchFirstCentralMethod(syntheticArchive())),
    ).toThrow(/ARCHIVE_INTEGRITY/u)
    const corrupted = syntheticArchive()
    const checkEntry = inspectZipArchive(corrupted).entries.at(-1)!
    corrupted[checkEntry.dataOffset] ^= 0xff
    expect(() => createArchiveManifest(corrupted)).toThrow(
      /ARCHIVE_INTEGRITY/u,
    )
  })

  it('resolves canonical internal references and classifies allowlisted external links', () => {
    expect(
      resolvePackageReference(
        'EPUB/navigation/nav.xhtml',
        '../chapters/./content.xhtml#heading-a',
      ),
    ).toEqual({
      kind: 'internal',
      path: 'EPUB/chapters/content.xhtml',
      fragment: 'heading-a',
    })
    expect(resolvePackageReference('EPUB/nav.xhtml', '#heading-a')).toEqual({
      kind: 'internal',
      path: 'EPUB/nav.xhtml',
      fragment: 'heading-a',
    })
    expect(
      resolvePackageReference('EPUB/nav.xhtml', 'https://example.test/item'),
    ).toEqual({
      kind: 'external',
      href: 'https://example.test/item',
      scheme: 'https',
    })
  })

  it.each([
    ['EPUB/nav.xhtml', '../../outside.xhtml'],
    ['EPUB/nav.xhtml', '/absolute.xhtml'],
    ['EPUB/nav.xhtml', '//authority.example/item'],
    ['EPUB/nav.xhtml', 'content.xhtml?query=1'],
    ['EPUB/nav.xhtml', 'content%2exhtml'],
    ['EPUB/nav.xhtml', 'folder\\content.xhtml'],
    ['EPUB/nav.xhtml', ' content.xhtml'],
    ['EPUB/nav.xhtml', 'javascript:invented'],
    ['../EPUB/nav.xhtml', 'content.xhtml'],
  ])('rejects unsafe package reference %s / %s', (base, reference) => {
    try {
      resolvePackageReference(base, reference)
      throw new Error('expected unsafe path rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(PackagePathError)
      expect((error as Error).message).toBe('PACKAGE_PATH')
      expect((error as Error).message).not.toContain(reference)
    }
  })

  it.each([
    ['base-nbsp', 'EPUB/nav\u00a0.xhtml', 'content.xhtml'],
    ['segment-em-space', 'EPUB/nav.xhtml', 'chapters/content\u2003.xhtml'],
    ['fragment-line-separator', 'EPUB/nav.xhtml', '#heading\u2028a'],
  ])(
    'rejects Unicode whitespace in package reference case %s',
    (_caseId, base, reference) => {
      try {
        resolvePackageReference(base, reference)
        throw new Error('expected Unicode whitespace rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(PackagePathError)
        expect((error as Error).message).toBe('PACKAGE_PATH')
        expect((error as Error).message).not.toContain(base)
        expect((error as Error).message).not.toContain(reference)
      }
    },
  )
})

describe('closed semantic assertion helper self-tests', () => {
  it('compares visible tokens exactly and hides all dynamic failure details', () => {
    const xhtml = inspectXhtml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Invented &amp; exact.</p></body></html>',
    )
    assertExactVisibleTextTokens('paragraph-positive', xhtml, [
      'Invented',
      '&',
      'exact.',
    ])
    expectClosedFailure(
      () =>
        assertExactVisibleTextTokens('paragraph-negative', xhtml, [
          'private-dynamic-sentinel',
        ]),
      'paragraph-negative',
      'visible-text',
      'private-dynamic-sentinel',
    )
  })

  it('detects hidden duplicate citation and note text but permits distinct helper labels', () => {
    for (const [caseId, markup, sentinel] of [
      [
        'citations-safe-ambiguity',
        '<a href="#reference" epub:type="biblioref" role="doc-biblioref">[7]</a><a href="#reference" epub:type="biblioref" role="doc-biblioref" class="visually-hidden">[7]</a><aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
        '[7]',
      ],
      [
        'notes-safe-ambiguity',
        '<a href="#note" epub:type="noteref" role="doc-noteref">note-a</a><span epub:type="noteref" role="doc-noteref" hidden="hidden">note-a</span><aside id="note" epub:type="footnote" role="doc-footnote">Note</aside>',
        'note-a',
      ],
    ] as const) {
      const duplicated = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${markup}</body></html>`)
      expectClosedFailure(
        () => assertNoHiddenSemanticTextDuplicates(caseId, duplicated),
        caseId,
        'hidden-semantic-text',
        sentinel,
      )
    }

    const distinct = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <a href="#reference" epub:type="biblioref" role="doc-biblioref">[7]</a>
  <a href="#reference" epub:type="biblioref" role="doc-biblioref" class="visually-hidden">Additional target</a>
  <aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>
</body></html>`)
    assertNoHiddenSemanticTextDuplicates('citations-positive', distinct)
  })

  it('checks paired citation/note roles and local semantic targets', () => {
    const valid = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <a href="#reference" epub:type="biblioref" role="doc-biblioref">[1]</a>
  <a href="#note" epub:type="noteref" role="doc-noteref">a</a>
  <a href="#endnote" epub:type="noteref" role="doc-noteref">b</a>
  <aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>
  <aside id="note" epub:type="footnote" role="doc-footnote">Note</aside>
  <aside id="endnote" epub:type="endnote" role="doc-endnote">Endnote</aside>
</body></html>`)
    assertSemanticLinks('citations-positive', valid)

    const invalid = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <a href="#tempting-private-target" epub:type="biblioref">[1]</a>
</body></html>`)
    expectClosedFailure(
      () => assertSemanticLinks('citations-safe-ambiguity', invalid),
      'citations-safe-ambiguity',
      'semantic-links',
      'tempting-private-target',
    )
  })

  it('rejects semantic targets duplicated across id and xml:id', () => {
    const ambiguous = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <a href="#two" epub:type="biblioref" role="doc-biblioref">[2]</a>
  <aside id="one" xml:id="two" epub:type="bibliography" role="doc-bibliography">Reference one</aside>
  <aside id="two" epub:type="bibliography" role="doc-bibliography">Reference two</aside>
</body></html>`)
    expectClosedFailure(
      () => assertSemanticLinks('citations-mixed-id-duplicate-negative', ambiguous),
      'citations-mixed-id-duplicate-negative',
      'semantic-links',
      'two',
    )
  })

  it.each([
    [
      'citations-mixed-reference-kinds-negative',
      '<a href="#link-destination" epub:type="biblioref noteref" role="doc-biblioref doc-noteref">Link</a>',
      '<aside id="link-destination" epub:type="bibliography footnote" role="doc-bibliography doc-footnote">Target</aside>',
    ],
    [
      'citations-mixed-bibliography-footnote-target-negative',
      '<a href="#link-destination" epub:type="biblioref" role="doc-biblioref">Link</a>',
      '<aside id="link-destination" epub:type="bibliography footnote" role="doc-bibliography doc-footnote">Target</aside>',
    ],
    [
      'citations-mixed-bibliography-endnote-target-negative',
      '<a href="#link-destination" epub:type="biblioref" role="doc-biblioref">Link</a>',
      '<aside id="link-destination" epub:type="bibliography endnote" role="doc-bibliography doc-endnote">Target</aside>',
    ],
  ])(
    'rejects mixed semantic kinds for %s',
    (caseId, referenceMarkup, targetMarkup) => {
      const xhtml = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  ${referenceMarkup}
  ${targetMarkup}
</body></html>`)
      expectClosedFailure(
        () => assertSemanticLinks(caseId, xhtml),
        caseId,
        'semantic-links',
        'link-destination',
      )
    },
  )

  it.each([
    [
      'citations-external-negative',
      'biblioref',
      'doc-biblioref',
      'https://example.test/reference#reference',
      '<aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
    ],
    [
      'citations-relative-negative',
      'biblioref',
      'doc-biblioref',
      'other.xhtml#reference',
      '<aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
    ],
    [
      'citations-fragmentless-negative',
      'biblioref',
      'doc-biblioref',
      'reference',
      '<aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
    ],
    [
      'citations-empty-fragment-negative',
      'biblioref',
      'doc-biblioref',
      '#',
      '<aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
    ],
    [
      'citations-dangling-negative',
      'biblioref',
      'doc-biblioref',
      '#missing-reference',
      '<aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
    ],
    [
      'citations-generic-target-negative',
      'biblioref',
      'doc-biblioref',
      '#generic-target',
      '<span id="generic-target">Generic target</span>',
    ],
    [
      'citations-wrong-kind-negative',
      'biblioref',
      'doc-biblioref',
      '#note',
      '<aside id="note" epub:type="footnote" role="doc-footnote">Note</aside>',
    ],
    [
      'notes-wrong-kind-negative',
      'noteref',
      'doc-noteref',
      '#reference',
      '<aside id="reference" epub:type="bibliography" role="doc-bibliography">Reference</aside>',
    ],
  ])(
    'rejects unproven semantic link case %s',
    (caseId, referenceType, referenceRole, href, targetMarkup) => {
      const xhtml = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <a href="${href}" epub:type="${referenceType}" role="${referenceRole}">Link</a>
  ${targetMarkup}
</body></html>`)
      expectClosedFailure(
        () => assertSemanticLinks(caseId, xhtml),
        caseId,
        'semantic-links',
        href,
      )
    },
  )

  it('checks ARIA and table header references plus accessible table names', () => {
    const valid = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <p id="description">Invented description</p>
  <div aria-describedby="description">Subject</div>
  <table aria-label="Invented values"><tr>
    <th id="column-a" scope="col">A</th><td headers="column-a">1</td>
  </tr></table>
</body></html>`)
    assertAccessibilityLinks('tables-positive', valid)
    assertTableLinks('tables-positive', valid)

    const danglingAria = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <div aria-labelledby="private-missing-label">Subject</div>
</body></html>`)
    expectClosedFailure(
      () => assertAccessibilityLinks('metadata-negative', danglingAria),
      'metadata-negative',
      'accessibility-links',
      'private-missing-label',
    )

    const invalidTable = inspectXhtml(`
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <table><tr><th id="heading" scope="invented-bad">A</th><td headers="missing">1</td></tr></table>
</body></html>`)
    expectClosedFailure(
      () => assertTableLinks('tables-negative', invalidTable),
      'tables-negative',
      'table-links',
      'invented-bad',
    )
  })

  it('checks OPF identifier refinements, manifest conservation, and spine links', () => {
    const valid = inspectOpf(`
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="publication-id">
  <metadata>
    <dc:identifier id="publication-id">urn:synthetic:one</dc:identifier>
    <dc:creator id="creator-a">Author A</dc:creator>
    <meta property="role" refines="#creator-a">aut</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine><itemref idref="content" /></spine>
</package>`)
    assertOpfMetadataLinks('metadata-positive', valid)
    assertOpfManifestLinks(
      'assets-positive',
      valid,
      'EPUB/package.opf',
      new Set(['EPUB/nav.xhtml', 'EPUB/content.xhtml']),
    )
    assertOpfSpineLinks('navigation-positive', valid)

    const badMetadata = inspectOpf(`
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="private-missing-id">
  <metadata><dc:identifier id="other">urn:synthetic:one</dc:identifier><meta property="role" refines="#private-missing-refinement">aut</meta></metadata>
  <manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml" /></manifest>
  <spine><itemref idref="content" /></spine>
</package>`)
    expectClosedFailure(
      () => assertOpfMetadataLinks('metadata-negative', badMetadata),
      'metadata-negative',
      'metadata-links',
      'private-missing-id',
    )

    const badManifest = inspectOpf(`
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="publication-id">
  <metadata><dc:identifier id="publication-id">urn:synthetic:one</dc:identifier></metadata>
  <manifest>
    <item id="nav-a" href="private-missing.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="nav-b" href="other.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine><itemref idref="private-missing-spine" /></spine>
</package>`)
    expectClosedFailure(
      () =>
        assertOpfManifestLinks(
          'assets-negative',
          badManifest,
          'EPUB/package.opf',
          new Set(['EPUB/other.xhtml']),
        ),
      'assets-negative',
      'manifest-links',
      'private-missing.xhtml',
    )
    expectClosedFailure(
      () => assertOpfSpineLinks('navigation-safe-ambiguity', badManifest),
      'navigation-safe-ambiguity',
      'spine-links',
      'private-missing-spine',
    )
  })

  it('checks exact nav nesting and every target against packaged document IDs', () => {
    const navigation = inspectNavigation(`
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="toc"><ol>
    <li><a href="content.xhtml#one">One</a><ol><li><a href="content.xhtml#two">Two</a></li></ol></li>
  </ol></nav>
</body></html>`)
    const expected = [
      {
        href: 'content.xhtml#one',
        label: 'One',
        children: [
          { href: 'content.xhtml#two', label: 'Two', children: [] },
        ],
      },
    ]
    assertNavigationHierarchy('navigation-positive', navigation, expected)
    assertNavigationTargets(
      'navigation-positive',
      navigation,
      'EPUB/nav.xhtml',
      new Map([['EPUB/content.xhtml', new Set(['one', 'two'])]]),
    )

    expectClosedFailure(
      () =>
        assertNavigationHierarchy('navigation-safe-ambiguity', navigation, [
          {
            href: 'content.xhtml#one',
            label: 'private-wrong-label',
            children: [],
          },
        ]),
      'navigation-safe-ambiguity',
      'navigation-hierarchy',
      'private-wrong-label',
    )
    expectClosedFailure(
      () =>
        assertNavigationTargets(
          'navigation-safe-ambiguity',
          navigation,
          'EPUB/nav.xhtml',
          new Map([['EPUB/content.xhtml', new Set(['one'])]]),
        ),
      'navigation-safe-ambiguity',
      'navigation-links',
      'two',
    )
  })

  it('checks archive order, duplicates, compression, and fixed timestamps independently', () => {
    const expectedOrder = [
      'mimetype',
      'META-INF/container.xml',
      'EPUB/content.xhtml',
      'EPUB/other.txt',
      'EPUB/check.txt',
    ]
    const archive = inspectZipArchive(syntheticArchive())
    assertArchiveFirstEntry('assets-positive', archive, 'mimetype', 0)
    assertArchiveCanonicalOrder('assets-positive', archive, expectedOrder)
    assertNoArchiveDuplicates('assets-positive', archive)
    assertArchiveCompression(
      'assets-positive',
      archive,
      new Map([
        ['mimetype', 0],
        ['EPUB/content.xhtml', 8],
      ]),
    )
    assertArchiveTimestamps('assets-positive', archive, 33, 0)

    const duplicate = inspectZipArchive(
      duplicateSyntheticEntry(syntheticArchive()),
    )
    expectClosedFailure(
      () => assertNoArchiveDuplicates('assets-negative', duplicate),
      'assets-negative',
      'archive-duplicates',
    )

    const changedTimestamp = inspectZipArchive(
      syntheticArchive(new Date(2002, 1, 3, 4, 6, 8)),
    )
    expectClosedFailure(
      () =>
        assertArchiveTimestamps('metadata-negative', changedTimestamp, 33, 0),
      'metadata-negative',
      'archive-timestamps',
    )

    expectClosedFailure(
      () =>
        assertArchiveCanonicalOrder('assets-negative', archive, [
          ...expectedOrder.slice(1),
          expectedOrder[0]!,
        ]),
      'assets-negative',
      'archive-order',
    )
    expectClosedFailure(
      () =>
        assertArchiveCanonicalOrder(
          'assets-negative',
          inspectZipArchive(
            reorderLastTwoCentralEntries(syntheticArchive()),
          ),
          expectedOrder,
        ),
      'assets-negative',
      'archive-order',
    )
  })

  it('replaces an invalid caller case ID with a fixed synthetic diagnostic ID', () => {
    const xhtml = inspectXhtml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body /></html>',
    )
    expectClosedFailure(
      () =>
        assertExactVisibleTextTokens(
          'private/path/value',
          xhtml,
          ['private-dynamic-sentinel'],
        ),
      'synthetic-case-invalid',
      'synthetic-case-id',
      'private/path/value',
    )
  })
})
