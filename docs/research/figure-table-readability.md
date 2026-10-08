# Figure and table readability across reading dimensions

Figures and tables should remain readable as the available reading area and reader typography change. Their proportion relative to surrounding text is a design preference constrained by legibility, content completeness and asset quality. A successful conversion or a complete figure inventory does not establish readable output.

## Observed problems

[arXiv HTML feedback issue 7080](https://github.com/arXiv/html_feedback/issues/7080) reports that Figure 1 of [QTIP](https://arxiv.org/html/2406.11235v4) is illegible because the HTML rendition displays it too small on desktop, while the PDF looks fine. This is a relevant external regression example; the report does not establish its underlying cause.

Struct's earlier Attention paper demo also exposed a wide table: at the mobile preview setting of 26 px text and zero custom margin, Table 3 measured approximately 852 CSS px across a 388 CSS px body. Required columns extended beyond the reading area. The comparison was a browser preview, rather than a physical EPUB reader test.

The current renderer styles apply `max-width: 100%` and automatic height to images, and a border to every semantic table cell. The PDF profile stylesheet repeats those rules. It also gives tables full width and a text size of 0.85 em. These rules do not specify a preferred figure display size, a minimum legible figure label size, or source table ruling styles. See [XHTML styles](../../src/renderers/xhtml.ts), [EPUB styles](../../src/renderers/epub.ts) and [PDF profile styles](../../adapters/pdf/render.mjs).

The current PDF adapter records PNG pixel dimensions in asset width and height fields and retains normalized source geometry. The source-neutral asset model does not declare dimension units and also permits non-raster assets, so these fields cannot universally be interpreted as raster resolution. [The table model](../../src/document/types.ts) has no dedicated representation of border or ruling appearance. Removing all borders globally would lose information for tables whose rules express groups or boundaries.

## Adaptive figure sizing

Choose a figure's display size from the actual content area, its aspect ratio, source placement or authored preference, internal detail, reader text size and available asset quality. The content area accounts for margins and any annotation rail; device screen width alone is insufficient.

A figure may use 80 percent of a narrow reading area and 50 percent of a wider one when both remain legible. Those percentages are examples, rather than fixed presets. A narrow but densely labelled diagram may need the full reading width on both. A simple small graphic may remain compact.

Keep three quantities distinct: source raster pixels determine available detail; CSS pixels describe browser layout; proportions describe occupancy of the current reading area. Source PDF dimensions and device pixels are not interchangeable with these quantities. A source width ratio can guide presentation, but must not force unreadably small labels.

For an illustrative raster measurement, a label 12 pixels high in a 1200-pixel-wide image becomes approximately 6 CSS px high when the image renders at 600 CSS px. The estimate requires a measured label size; asset width alone cannot supply it. Increasing surrounding text should trigger a readability reassessment rather than leaving figure labels effectively much smaller.

Preserve aspect ratio and complete figure content. Prefer a vector or higher-resolution original when available. When a dense figure cannot be legible at the available width, offer an accessible expanded view or another explicitly permitted presentation. Keep the caption, panel relationships and return path intact. Flag insufficient source resolution or unavailable alternatives rather than treating geometric fit as a readability pass.

## Wide table access

Keep every column and its header association accessible. Do not shrink text below the reader's chosen size merely to make the table fit. Use suitable wrapping or a semantic alternative where appropriate. Otherwise provide a clearly indicated, keyboard-accessible horizontal scroll region or expanded view. Adaptation must preserve merged-cell meaning, units, notes and reading order.

Contain necessary table overflow without causing unrelated prose to overflow or concealing columns. Scrolling is a fallback for access, not proof that a table is comfortable to read. Validate EPUB behavior in representative reading systems separately from the web preview.

## Table ruling fidelity

Preserve borderless, horizontal-rule, grid and mixed-rule treatments when supported by source evidence or explicit authoring. Retain significant header and group separators, including rules around merged cells. Separate these presentation facts from the semantic row, column and header structure.

Distinguish a known borderless table from unknown styling. For unknown styling, apply a documented fallback treatment without claiming it reproduces the source. Any optional reader contrast treatment should remain an explicit presentation choice.

## Acceptance and evaluation

Start with 3 to 5 representative fixtures covering a small simple figure, a densely labelled diagram, a wide table, a borderless table and a table with selective rules; combine cases where useful. Keep the arXiv report as an external reference and use redistributable fixtures for checked-in regressions.

- Exercise narrow and wide reading areas, portrait and landscape, default and enlarged text, and changing margins or annotation-rail occupancy.
- Check actual rendered label and cell legibility, complete content access, aspect ratio, caption association and significant table rules. Use human review for readability; element counts and overflow measurements alone are insufficient.
- Compare preview and downloaded editions from the same content revision and profile, accounting for reader overrides. Include representative EPUB reading systems.
- Inspect individual failures alongside aggregate results. A proportion that looks balanced must not outweigh illegible labels, inaccessible columns or invented table rules.

This work gives the representation discussion concrete requirements: distinguish source evidence, presentation preferences and readability constraints so a renderer can explain when a preferred treatment needs another size or presentation. The requirements do not themselves establish a novel representation or an implemented adaptive renderer.
