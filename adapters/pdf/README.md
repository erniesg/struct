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
| text | `paragraph` | joined across column/page/float breaks only when the previous paragraph (or list item, or an unterminated figure caption) lacks terminal punctuation and the next starts lowercase; a trailing citation (`[85]`, `(Smith et al., 2020)`), an unclosed parenthesis, a decimal number, or a spaced-out formula tail (`κ = 0 . 946`, `Q Y ( j )`) does not end a sentence; listings, listing captions set as headings, and up to three complete paragraphs of another column's flow may lie between the halves, and a run of complete list items (a reference list, an enumerated block) may lie between them without spending that budget, since the eye skips such a run like a float; hyphens dropped only when the fused word occurs in the paper, and when two hyphen-ended halves compete for a continuation the one whose fusion the paper attests wins (`com-` + `plex` over the reference entry ending `higher-` that lay between); a paragraph standing inside a run of reference entries looks past the back-matter headings the layout model read between the two columns of one bibliography, but only to a hyphen-ended entry of that list; a stray word the layout model glued to the paragraph opening the next page (`and` between two display equations, `Corollary 4.35 …` overleaf) stays a paragraph of its own where it is; a paragraph the layout model continued into the narrow column beside it (a journal's first-page funding statement) ends where that column begins, and the cut words rejoin the still-open entry of that column; a complete paragraph in such a column between the halves does not spend the prose budget, a column being narrow when it is at most two thirds of the body's width and does not overlap it at all, which an ordinary second column never is; a running footer or chart label the layout model glued to the last line is cut; an item with several provenance boxes whose later box holds a `Figure N` caption is split into paragraph and caption; `term : definition` entries set in a monospace face become list items |
| bold / italic words | `inline` runs (`bold`, `italic`) | from the glyph faces under the block; a face covering the whole block is block styling, not a run |
| list_item | `list-item` + `attributes.ordered/listId` | struct groups them into `<ol>`/`<ul>` |
| picture + caption | `figure` (text = caption) + crop asset | caption-less pictures under 1% of the page are decorative; caption-less panels, sub-captions (`(a) …`), chart labels, short labels and monospace fragments stacked against a captioned figure fold into its crop, never across another caption; a `Figure N` line inside a crop is read back as the caption (the crop trimmed above it) or splits the crop into two figures; a caption-less figure adopts the nearest orphan `Figure N` caption in its column (geometry, not reading order); when the paper sets captions below figures, a picture whose attached caption sits above it gives that caption back and takes the orphan caption below; an orphan caption with no artwork recovers the framed region beside it (drawn rules, a rounded frame, a shaded box read from the page image) or the run of panels, labels and code beside it as a crop; a table item whose caption says `Figure N`, or a caption-less table item beside an orphan `Figure N` caption, is a figure; labels keep chapter numbering (`Fig. 2.3`) and a label never backtracks into a sentence's full stop |
| table + caption | `table` (cell grid, header scopes, spans, links and note references in cells; text = caption, rendered above the table) | a one-cell grid holding prose is a boxed text and stays a table; a grid less than 30 % filled falls back to a crop; a caption-less one- or two-column grid of prose cells (a bibliography) becomes a list of entries; a caption-less table adopts the `Table N` caption beside it, by geometry, or from the text layer; a caption-less table at the top of the next page with the same column count continues the previous table; a `Table N` caption with no table item reads the ruled box beside it (heavy rules close a booktabs box, a caption inside its own first row starts the box, a box that runs off the page reaches the page edge) and turns the text blocks inside into rows, one column per x-cluster; only when no frame exists does the band beside the caption become a crop |
| formula | `equation` + `attributes.mathml` (LaTeX via latex2mathml) or crop | `--formula` turns on Docling's formula enrichment |
| code | `code` with source line breaks | Docling `code` items are verified against glyph faces: math faces → equation crop, prose faces → paragraph; any paragraph set ≥80% in a monospace face over two or more lines is code; a listing split by a caption, footnote, furniture, or page break rejoins |
| footnote | `footnote` block + `note-reference` inline run + `footnote` relationship | markers are superscript glyph runs (small, raised) located in the host block (or table cell, or a paragraph that began on the previous page) by their left context, `∗` and `*` being one symbol; every reference links; the note moves to follow its first referencing block; a symbol note whose symbol appears nowhere else on the page, or a digit note with no raised run of its digit on its page or the page before, keeps the label in its text and is not a reference; two notes sharing a label on one page (an affiliation and a footnote) take successive markers in reading order; copyright, licence, ISSN/DOI and journal lines labelled as footnotes become furniture; a `Figure N` / `Table N` line labelled as a footnote or as page furniture is a caption |
| page_header / page_footer, edge page numbers, text repeated on ≥3 pages in an edge band, edge-band text equal to a heading or the title | `furniture` blocks with evidence | accounted, never rendered; a margin stamp the layout model glued in front of a paragraph's first line (a tiny edge box, far from the box carrying the prose, opening the text with a bare number) is cut, the mirror of the glued-tail rule |
| PDF link annotations (pypdf) + word boxes (pdftotext) | inline runs with `href` (paragraphs, notes, list items, code, table cells) | matched by rectangle overlap against every provenance box of an item (relative to the smaller box, so short table cells count), then by the words under the rectangle (a wrapped link's lines together, hyphens and quote glyphs tolerated) before the target's own spellings; two links with the same words take successive occurrences; targets are normalized the way a WHATWG parser serializes them (`normalize_uri`) |
| text-layer lines no layout item covers | `paragraph` with `text-layer-fallback` evidence | an author line, a reference entry or a whole page the layout model dropped comes back from `pdftotext -bbox-layout` with its own box, in the position its geometry dictates, unless a layout item already carries its words; a line inside a paragraph's own box whose words the item text lacks (an italic title, a URL line) is put back after the line above it, unless the item or a neighbour on the page already carries two thirds of its words (a line of mathematics whose symbols the text layer merely orders differently) |
| furniture layer | `furniture`, or `caption` / `paragraph` when the text is one | a `Figure N` / `Table N` line filed as page furniture is a caption; single-page prose of six or more words without journal or licence wording (a bold lead-in at the page foot) returns to the flow; a heading whose text is a caption is a caption |

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

# list the concrete failing objects behind each criterion (paragraphs, labels, notes, links, leaks)
python triage.py out/ --pdfs ~/Papers

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

### Beyond the command line

- [`service/`](service/README.md) — a token-gated HTTP front for the same
  pipeline: upload a PDF in a browser, get both EPUBs and the spec-052 criteria
  back. It wraps `pdf2epub.py` and changes nothing about the conversion.
- [`bench/`](bench/README.md) — what a bounded model adjudicator (spec 046) is
  worth: six models across three tiers on the caption-to-region residual, scored
  against ground truth that does not come from these rules, with token counts
  and dollars per call.

## Reader criteria measured by `evaluate.py`

Expectations come from the PDF, never from the adapter's output:

- figures: `Figure N` caption labels in the text layer (a line that is only `Figure N.` under an unterminated line is a sentence tail, and `Figure 15 shows …` is a sentence) vs `<figcaption>` labels of figures carrying an image; a caption-less figure counts against the document only when an orphan `Figure N` caption remains on its page or it stands against a captioned figure in the same column
- tables: `Table N` labels vs `<figcaption>` labels of rendered `<table>` elements (a crop counts as fallback, not structure)
- footnotes: footnote blocks with a marker vs matched note references (adapter count; documented limitation)
- links: URI annotations with visible words, outside running lines, edge bands, margin stamps and accounted edge furniture, vs `href`s anywhere in the EPUB including notes; icon glyphs (an envelope, an ORCID symbol), annotations nested inside another link, and targets compared after `normalize_uri` on both sides
- furniture: lines repeated in the top or bottom tenth of three or more pages, and page-edge numbers, must not appear as paragraphs (a bare number the draft places in the page body is content)
- prose continuity: word coverage ≥ 0.98 (words inside detected figures and edge or margin furniture excluded; small-caps runs, words broken at a line end and CJK text compared on equal terms) and no prose paragraph that begins with a plain lowercase word outside the bibliography, after a heading, after an equation, or after a colon-terminated lead-in (spec 052 counts every such paragraph)
- EPUBCheck errors
