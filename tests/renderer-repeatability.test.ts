// S04 renderer repeatability: three independent runs per representative case
// must produce identical XHTML bytes and identical normalized EPUB entry
// content hashes, and those values must equal a frozen, reviewed baseline.
//
// Baseline provenance (frozen literals below):
//   * Source commit: 049f96ae6a8303dc0e00b92527da8df68f29fbd5
//     ("fix: reject standalone compiled test and source debris")
//   * Inputs: tests/fixtures/s04/documents.ts (hand-built STRUCT documents).
//     No fixture value is copied from renderer output; receipt counts and
//     conservation counts are derived from the constructed arrays and the
//     semantic digest is computed by the package digest primitives.
//   * Generation: the fixture was rendered once at that commit and the
//     resulting digests were frozen here as literals.
//   * Independent re-verification on the VM: `sha256sum` over the emitted
//     XHTML file and Python `zipfile` + `hashlib` over the emitted EPUB
//     reproduced every frozen digest exactly.
//   * See docs/s04-release-matrix-2026-10-20.md for the full procedure.
//
// A change to any frozen digest is renderer drift, not a silent baseline
// refresh: update the literals and the documentation together, in a reviewed
// change, or the S04 gate fails.

import { describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { sha256HexSync } from '../src/sha256'
import {
  buildS04Document,
  finalizeS04Document,
  STRUCT_SCHEMA_VERSION,
  type S04RenderVariant,
} from './fixtures/s04/documents'

const FROZEN_BASELINES: Record<
  S04RenderVariant,
  {
    /** SHA-256 over the UTF-8 bytes of the rendered XHTML document. */
    xhtmlSha256: string
    /** SHA-256 over the normalized EPUB entry content-hash listing. */
    epubContentSha256: string
    /** SHA-256 over the raw EPUB archive bytes. */
    epubArchiveSha256: string
  }
> = {
  typography: {
    xhtmlSha256:
      'dca6647dae2ef2daca2505269dd0a3ab0c86d82c9891c9f7bcfdb1f05a2e3c30',
    epubContentSha256:
      '4c71a76c6eae54fa42dc9064369a1b87274476919fb78b86806dcbe4e76eab67',
    epubArchiveSha256:
      '8fbb10831935ef9154e92151eaa19522c3381ab4bebcbd23a85e2cd61598b908',
  },
  'assets-links': {
    xhtmlSha256:
      '01916b4859b1e9d2495cbbf0e18e7fc2313109e9d4050436982e7f0b0cb4f4fa',
    epubContentSha256:
      'e9afb1434ca464a6d367fe03ba233ea564357eced1596a82afac74acbccba365',
    epubArchiveSha256:
      '3fc3f3952e3449bc067beaaf17cebbf37669c95a3deea0fd1977b0a2c6b95d2f',
  },
  order: {
    xhtmlSha256:
      '36e097ab8626c2ba7bdfddf7484a4018b12329cd21f644845fd04c2530c2ba6b',
    epubContentSha256:
      '6bef8f24acef00d0fc404caa9a9423a461b1b6ce745bed5ea978a5882fe15289',
    epubArchiveSha256:
      '2f9472210f882db32482be80a4419d64bf3c770efaa45cc93f40479139711839',
  },
}

/**
 * Normalized EPUB content hash.
 *
 * The archive container (compression, ordering, local headers) is not part of
 * the artifact contract, so the normalized form is computed over the archive
 * *content*: every entry name, sorted by byte order, paired with the SHA-256
 * of the entry bytes, joined by U+0000 within a line and LF between lines.
 */
function normalizedEpubContentSha256(bytes: Uint8Array): string {
  const entries = unzipSync(bytes)
  const lines = Object.keys(entries)
    .sort()
    .map((name) => `${name}\u0000${sha256HexSync(entries[name]!)}`)
  return sha256HexSync(new TextEncoder().encode(lines.join('\n')))
}

function sha256Utf8(value: string): string {
  return sha256HexSync(new TextEncoder().encode(value))
}

type RunResult = {
  xhtml: string
  xhtmlSha256: string
  epubContentSha256: string
  epubArchiveSha256: string
  epubEntryNames: string[]
}

/**
 * One independent run.
 *
 * The module registry is reset and the renderers are re-imported, so each run
 * executes against a freshly loaded module graph, and the input document is
 * rebuilt from the fixture rather than reused.
 */
async function runOnce(variant: S04RenderVariant): Promise<RunResult> {
  vi.resetModules()
  const { renderPublicationXhtml } = await import('../src/renderers/xhtml')
  const { buildStructEpub } = await import('../src/renderers/epub')
  const document = finalizeS04Document(
    buildS04Document(variant),
    STRUCT_SCHEMA_VERSION,
  )
  const xhtml = renderPublicationXhtml(document)
  const epub = await buildStructEpub(document)
  return {
    xhtml,
    xhtmlSha256: sha256Utf8(xhtml),
    epubContentSha256: normalizedEpubContentSha256(epub.bytes),
    epubArchiveSha256: epub.sha256,
    epubEntryNames: Object.keys(unzipSync(epub.bytes)).sort(),
  }
}

const VARIANTS: S04RenderVariant[] = ['typography', 'assets-links', 'order']

describe('S04 renderer repeatability', () => {
  it.each(VARIANTS)(
    'produces byte-identical XHTML and identical normalized EPUB content hashes across three independent runs (%s)',
    async (variant) => {
      // Sequential on purpose: the runs must not interleave their module
      // registry resets, so each run is independent of the others.
      const runs: RunResult[] = []
      for (let index = 0; index < 3; index += 1) runs.push(await runOnce(variant))
      const [first, second, third] = runs
      expect(second.xhtmlSha256).toBe(first.xhtmlSha256)
      expect(third.xhtmlSha256).toBe(first.xhtmlSha256)
      expect(second.epubContentSha256).toBe(first.epubContentSha256)
      expect(third.epubContentSha256).toBe(first.epubContentSha256)
      expect(second.epubArchiveSha256).toBe(first.epubArchiveSha256)
      expect(third.epubArchiveSha256).toBe(first.epubArchiveSha256)
      expect(second.xhtml).toBe(first.xhtml)
      expect(third.xhtml).toBe(first.xhtml)
      expect(second.epubEntryNames).toEqual(first.epubEntryNames)
      expect(third.epubEntryNames).toEqual(first.epubEntryNames)

      const frozen = FROZEN_BASELINES[variant]
      expect(first.xhtmlSha256).toBe(frozen.xhtmlSha256)
      expect(first.epubContentSha256).toBe(frozen.epubContentSha256)
      expect(first.epubArchiveSha256).toBe(frozen.epubArchiveSha256)
    },
  )

  it('renders the frozen typography baseline with the expected semantic markup', async () => {
    const { xhtml, epubEntryNames } = await runOnce('typography')
    expect(xhtml).toContain('<h1 id="s04-title" data-struct-id="s04-title">')
    expect(xhtml).toContain('<strong>Bold</strong>')
    expect(xhtml).toContain('<em>italic</em>')
    expect(xhtml).toContain('<sup>super</sup>')
    expect(xhtml).toContain('<sub>sub</sub>')
    expect(xhtml).toContain('<blockquote id="s04-quote"')
    expect(xhtml).toContain('<ol>')
    expect(xhtml).toContain('<pre id="s04-code" data-struct-id="s04-code"><code>')
    expect(xhtml).toContain('epub:type="footnote"')
    expect(xhtml).toContain(
      'href="#s04-footnote" epub:type="biblioref" role="doc-biblioref"',
    )
    expect(epubEntryNames).toEqual([
      'EPUB/content.xhtml',
      'EPUB/nav.xhtml',
      'EPUB/package.opf',
      'EPUB/struct.json',
      'EPUB/styles.css',
      'META-INF/container.xml',
      'mimetype',
    ])
  })

  it('renders the frozen assets-and-links baseline with packaged assets and both link kinds', async () => {
    const { xhtml, epubEntryNames } = await runOnce('assets-links')
    expect(xhtml).toContain('<img src="assets/s04-figure.png" alt="Figure one" />')
    expect(xhtml).toContain('href="#s04-figure"')
    expect(xhtml).toContain('data-semantic-role="cross-reference"')
    expect(xhtml).toContain('<a href="https://example.org/source">source</a>')
    expect(xhtml).toContain('<figcaption>Figure one</figcaption>')
    expect(epubEntryNames).toContain('EPUB/assets/s04-figure.png')
    expect(epubEntryNames).toEqual([
      'EPUB/assets/s04-figure.png',
      'EPUB/content.xhtml',
      'EPUB/nav.xhtml',
      'EPUB/package.opf',
      'EPUB/struct.json',
      'EPUB/styles.css',
      'META-INF/container.xml',
      'mimetype',
    ])
  })

  it('renders the frozen reading-order baseline in declared block order', async () => {
    const { xhtml } = await runOnce('order')
    const emitted = [...xhtml.matchAll(/<p id="(s04-[a-z0-9-]+)"/g)].map(
      (match) => match[1],
    )
    expect(emitted).toEqual([
      's04-left-1',
      's04-left-2',
      's04-right-1',
      's04-span-1',
    ])
  })
})
