# adapters/pdf: any scholarly PDF → StructDocument → EPUB

The reference PDF adapter for `@erniesg/struct` ([ADR-0002](../../docs/adr/0002-pdf-adapter-in-repository.md)).
It extracts with Docling, reads typography straight from the PDF's glyphs,
maps everything into a `StructDocument`, and asks the package to render the
EPUBs. Nothing here writes XHTML or packages an EPUB; nothing leaves the machine.

```
PDF ──Docling (local layout model)──────────────▶ DoclingDocument
    ──docling-parse glyphs (pdf_text.py)────────▶ superscripts, bold/italic, monospace, math faces, source lines
    ──pypdf annotations + pdftotext (pdf_links.py)▶ link rectangles, word boxes, page text
    ──pdf2struct.py──────────────────────────────▶ StructDocument draft (blocks, assets, relationships, pages, diagnostics)
    ──render.mjs (@erniesg/struct)───────────────▶ sealed receipt, strict codec, XHTML, one EPUB per device profile
    ──evaluate.py────────────────────────────────▶ source-derived reader criteria (corpus-audit document shape)
    ──scorecard.mjs──────────────────────────────▶ per-criterion, per-stratum scorecard
```

## What the adapter maps

| Source | STRUCT | Rule |
| --- | --- | --- |
| title / first page-1 heading | `metadata.title` | rendered as the publication header |
| section_header | `heading` + `attributes.level` | level from numbering (`3.1` → h3), known names (`References`) → h2; a "heading" over 110 characters or with sentence punctuation is a bold lead-in paragraph |
| text | `paragraph` | joined across column/page/float breaks only when the previous paragraph lacks terminal punctuation and the next starts lowercase; hyphens dropped only when the fused word occurs in the paper |
| bold / italic words | `inline` runs (`bold`, `italic`) | from the glyph faces under the block; a face covering the whole block is block styling, not a run |
| list_item | `list-item` + `attributes.ordered/listId` | struct groups them into `<ol>`/`<ul>` |
| picture + caption | `figure` (text = caption) + crop asset | caption-less pictures under 1% of the page are decorative; consecutive caption-less panels on a page merge into one figure (union crop); a caption-less figure adopts the nearest orphan `Figure N` caption in its column (geometry, not reading order) or reads the caption back from the text layer inside its crop; an orphan caption with no artwork recovers the page band above it as a crop |
| table + caption | `table` (cell grid, header scopes, spans, links in cells; text = caption, rendered above the table) | a single cell or a mostly empty grid falls back to a crop; a caption-less table adopts the `Table N` caption beside it, by geometry, or from the text layer; a caption-less table at the top of the next page with the same column count continues the previous table; a `Table N` caption with no table crops the band beside it (row-like text blocks absorbed, blank bands and bands claimed by another caption refused) |
| formula | `equation` + `attributes.mathml` (LaTeX via latex2mathml) or crop | `--formula` turns on Docling's formula enrichment |
| code | `code` with source line breaks | Docling `code` items are verified against glyph faces: math faces → equation crop, prose faces → paragraph; any paragraph set ≥80% in a monospace face over two or more lines is code; a listing split by a caption, footnote, furniture, or page break rejoins |
| footnote | `footnote` block + `note-reference` inline run + `footnote` relationship | markers are superscript glyph runs (small, raised) located in the host block by their left context; every reference links; the note moves to follow its first referencing block; copyright, licence, ISSN/DOI and journal lines labelled as footnotes become furniture |
| page_header / page_footer, edge page numbers, text repeated on ≥3 pages in an edge band, edge-band text equal to a heading or the title | `furniture` blocks with evidence | accounted, never rendered |
| PDF link annotations (pypdf) + word boxes (pdftotext) | inline runs with `href` (paragraphs, notes, table cells) | matched by rectangle overlap, whitespace-insensitive URL/text match |

Chart tick labels the layout model left outside a picture (three or more
number-only lines in a row) are dropped as figure content. Pages the layout
model dropped are recovered from the text layer. The graph is compacted for
struct's node budget and dangling references are pruned.

## Usage

```bash
# once: Python 3.12 venv with Docling, and the package built
uv venv --python 3.12 ~/.venvs/docling && source ~/.venvs/docling/bin/activate
uv pip install docling==2.126.0 latex2mathml pypdf
(cd ../.. && npm ci && npm run build)

# convert one or many PDFs (directories are scanned for *.pdf)
python pdf2epub.py paper.pdf --out out/ --profiles paperPro,paperProMove
python pdf2epub.py ~/Papers --out out/ --workers 2

# re-run only the adapter over an earlier Docling extraction (~10 s/paper)
python pdf2epub.py ~/Papers --out out/ --reuse-json --workers 4

# score a run on the nine reader criteria (spec 052)
node scorecard.mjs out/corpus-report.json --strata strata.json --markdown

# visual evidence: raster a block at Paper Pro geometry
node screenshot.mjs out/<stem>/<stem>-paperpro.epub --out page.png --anchor <blockId>
```

Outputs per PDF: `<stem>.docling.json`, `<stem>.struct-draft.json`, the sealed
`struct.json`, struct's `content.xhtml`, one EPUB per profile, and
`<stem>.report.json`. EPUBCheck runs when it is on `PATH`.

Requires `pdftotext` (poppler) and `node` ≥ 20. Docling uses the GPU (MPS on
Apple silicon); run one or two workers for fresh extraction, four for
`--reuse-json`. `screenshot.mjs` needs Playwright with Chromium (from this
repository's `node_modules` or the sibling `erniesg` checkout).

## Reader criteria measured by `evaluate.py`

Expectations come from the PDF, never from the adapter's output:

- figures: `Figure N` caption labels in the text layer vs `<figcaption>` labels of figures carrying an image
- tables: `Table N` labels vs `<figcaption>` labels of rendered `<table>` elements (a crop counts as fallback, not structure)
- footnotes: footnote blocks with a marker vs matched note references (adapter count; documented limitation)
- links: URI annotations with visible text, outside running lines, edge bands, and margin stamps, vs `href`s anywhere in the EPUB including notes (icon links excluded)
- furniture: lines repeated in the top or bottom tenth of three or more pages, and page-edge numbers, must not appear as paragraphs
- prose continuity: word coverage ≥ 0.98 (words inside detected figures excluded) and ≤ 2% lowercase-starting prose paragraphs outside the bibliography and after equations
- EPUBCheck errors
