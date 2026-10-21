import type {
  StructBlock,
  StructDocument,
  StructTable,
  StructTableCell,
} from "../document/types";
import {
  buildRenderedPublicationPlan,
  emittedXhtmlIds,
  groupedCitationLinks,
  isPackagedAssetId,
  RenderedPublicationPlanError,
  resolveStructTarget,
  stableId,
  type EmittedXhtmlId,
  type RenderedCaptionPlan,
  type RenderedInlineSourcePlan,
  type RenderedPublicationPlan,
} from "./xhtml-plan";
import {
  planListContainers,
  planListItem,
  renderListContainer,
  type RenderedListItemEntry,
} from "./xhtml-lists";
import { normalizeStructDocumentForRenderer } from "./ingress";
import { verifyStructReceipt } from "../receipt";
import { mathMlForXhtml, safeMathMl } from "./xhtml-mathml";

export type StructXhtmlOptions = {
  embedStyles?: boolean;
  styles?: string;
};

const DEFAULT_STYLES = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }
figure.equation { text-align: center; }
ol, ul { margin: 0 0 1rem 1.5rem; padding: 0; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }`;

function text(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function attribute(value: string) {
  return text(value).replace(/"/g, "&quot;");
}

function renderInline(
  document: StructDocument,
  source: RenderedInlineSourcePlan,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const { value } = source;
  const plan = source.segments;
  if (plan.length === 0) return text(value);
  return plan
    .map((segment) => {
      const { start, end, owners } = segment;
      const segmentValue = value.slice(start, end);
      const styled = (content: string) => {
        let rendered = content;
        for (const run of owners) {
          // Inline code is applied first so it stays the innermost wrapper,
          // the way a Markdown source `**`code`**` nests. The content is
          // already escaped, so the element only wraps escaped text.
          if (run.code) rendered = `<code>${rendered}</code>`;
          if (run.bold) rendered = `<strong>${rendered}</strong>`;
          if (run.italic) rendered = `<em>${rendered}</em>`;
          if (run.verticalAlign === "superscript") {
            rendered = `<sup>${rendered}</sup>`;
          } else if (run.verticalAlign === "subscript") {
            rendered = `<sub>${rendered}</sub>`;
          }
        }
        return rendered;
      };
      let rendered = styled(text(segmentValue));
      const semanticOwnerIndex = owners.findIndex(
        (run) => run.semanticRole && run.relationshipId,
      );
      const semanticRun =
        semanticOwnerIndex >= 0 ? owners[semanticOwnerIndex] : undefined;
      const semantic =
        semanticOwnerIndex >= 0
          ? publicationPlan.semanticByOwnerKey.get(
              segment.ownerKeys[semanticOwnerIndex]!,
            )
          : undefined;
      if (semanticRun?.relationshipId && semanticRun.semanticRole && semantic) {
        const relationshipId = semantic.relationshipIdStable;
        const firstSegment = !emittedRelationshipIds.has(relationshipId);
        emittedRelationshipIds.add(relationshipId);
        const id = firstSegment ? ` id="${attribute(relationshipId)}"` : "";
        const targets = semantic.targets;
        const semanticAttributes = semantic.semanticAttributes;
        if (targets.length === 0) {
          rendered = `<span${id}${semanticAttributes}>${rendered}</span>`;
        } else {
          const epubRole = semantic.epubRole;
          if (targets.length === 1) {
            rendered = `<a${id} href="${attribute(targets[0]!.href)}"${epubRole}${semanticAttributes}>${rendered}</a>`;
          } else {
            const grouped =
              semanticRun.semanticRole === "citation"
                ? groupedCitationLinks(
                    segmentValue,
                    semantic.citationRanges,
                    semantic.targetById,
                    epubRole,
                    start - semanticRun.start!,
                  )
                : {
                    html: text(segmentValue),
                    linkedTargets: new Set<string>(),
                  };
            rendered = `<span${id}${semanticAttributes}>${styled(grouped!.html)}${firstSegment ? semantic.additionalTargets : ""}</span>`;
          }
        }
      } else {
        const hyperlinkOwnerIndex = owners.findIndex(
          (run) => run.href || run.targetIds?.length,
        );
        const hyperlink =
          hyperlinkOwnerIndex >= 0
            ? publicationPlan.hyperlinkByOwnerKey.get(
                segment.ownerKeys[hyperlinkOwnerIndex]!,
              )
            : undefined;
        if (hyperlink)
          rendered = `<a href="${attribute(hyperlink.href)}">${rendered}</a>`;
      }
      return rendered;
    })
    .join("");
}

function renderTable(
  document: StructDocument,
  table: StructTable,
  tableBlockId: string,
  blockIndex: number,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const rows = Array.from({ length: table.rows }, () => [] as string[]);
  const cells = new Map<string, { cell: StructTableCell; index: number }>(
    table.cells.map(
      (cell, index) => [`${cell.row}:${cell.column}`, { cell, index }] as const,
    ),
  );
  const occupied = new Set<string>();
  for (let row = 0; row < table.rows; row += 1) {
    for (let column = 0; column < table.columns; column += 1) {
      const coordinate = `${row}:${column}`;
      if (occupied.has(coordinate)) continue;
      const cellEntry = cells.get(coordinate);
      if (!cellEntry) {
        rows[row]!.push("<td></td>");
        continue;
      }
      const { cell, index: cellIndex } = cellEntry;
      const tag = cell.headerScope ? "th" : "td";
      const htmlScope =
        cell.headerScope === "column" ? "col" : cell.headerScope;
      const scope = htmlScope ? ` scope="${htmlScope}"` : "";
      const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : "";
      const columnSpan =
        cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : "";
      rows[row]!.push(
        `<${tag} id="${attribute(`${tableBlockId}-${cell.id}`)}"${scope}${rowSpan}${columnSpan}>${renderInline(
          document,
          publicationPlan.sourceByKey.get(`table:${blockIndex}:${cellIndex}`)!,
          emittedRelationshipIds,
          publicationPlan,
        )}</${tag}>`,
      );
      for (
        let occupiedRow = cell.row;
        occupiedRow < cell.row + cell.rowSpan;
        occupiedRow += 1
      )
        for (
          let occupiedColumn = cell.column;
          occupiedColumn < cell.column + cell.columnSpan;
          occupiedColumn += 1
        )
          occupied.add(`${occupiedRow}:${occupiedColumn}`);
    }
  }
  return `<table>${rows.map((row) => `<tr>${row.join("")}</tr>`).join("")}</table>`;
}

function renderAuthors(
  document: StructDocument,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  if (document.metadata.authors.length === 0) return "";
  const targetCache = new Map<string, ReturnType<typeof resolveStructTarget>>();
  for (const asset of document.assets)
    if (isPackagedAssetId(asset.id))
      targetCache.set(asset.id, {
        id: asset.id,
        href: asset.href,
        kind: "asset",
      });
  for (const block of document.blocks)
    if (block.kind !== "furniture" && !targetCache.has(block.id))
      targetCache.set(block.id, {
        id: block.id,
        href: `#${block.id}`,
        kind: "block",
      });
  const authors = document.metadata.authors
    .map((author) => {
      const references = (publicationPlan.authorNotesByAuthor.get(author) ?? [])
        .map((reference) => {
          const target =
            targetCache.get(reference.target) ??
            resolveStructTarget(document, reference.target);
          targetCache.set(reference.target, target);
          emittedRelationshipIds.add(stableId(reference.id));
          return `<sup><a id="${attribute(stableId(reference.id))}" href="${attribute(target.href)}" epub:type="noteref" role="doc-noteref">${text(reference.label)}</a></sup>`;
        })
        .join("");
      return `${text(author)}${references}`;
    })
    .join(", ");
  return `<p class="authors">${authors}</p>`;
}

function renderSourceObservationAnchors(block: StructBlock) {
  return (block.sourceObservationAnchorIds ?? [])
    .map(
      (anchorId) =>
        `<span id="${attribute(anchorId)}" class="visually-hidden source-observation-anchor" aria-hidden="true"></span>`,
    )
    .join("");
}

/**
 * Render a caption block that a matched `caption` relationship attaches to
 * a host block.
 *
 * The caption is published once, inside the host's `<figcaption>`, and the
 * caption block's own identifier and source anchors travel with it, so the
 * caption's anchor still resolves and the caption is not published twice.
 */
function renderAttachedCaption(
  document: StructDocument,
  caption: RenderedCaptionPlan,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const captionBlock = document.blocks[caption.captionBlockIndex]!;
  const id = attribute(captionBlock.id);
  const content = renderInline(
    document,
    publicationPlan.sourceByKey.get(`block:${caption.captionBlockIndex}`)!,
    emittedRelationshipIds,
    publicationPlan,
  );
  const sourceAnchors = renderSourceObservationAnchors(captionBlock);
  return `<figcaption id="${id}" data-struct-id="${id}" data-relationship-id="${attribute(
    caption.relationshipIdStable,
  )}">${sourceAnchors}${content}</figcaption>`;
}

/**
 * The caption of a host block.
 *
 * Precedence rule: an attached caption is the host's caption. When a caption
 * block is attached to the host by a matched `caption` relationship, the
 * caption's text is published inside the host's `<figcaption>` and the
 * host's own figcaption text is not published a second time. That is what
 * closes the duplication where the host carries its own copy of the caption
 * text. A host whose own caption text differs from the attached caption's
 * text is a document inconsistency and is refused while the publication is
 * planned, so the host's text is never silently dropped.
 *
 * Otherwise the host publishes its own text, or its label when it has no
 * text, exactly as before. No caption is ever chosen by comparing text: an
 * unlinked caption block stays its own paragraph.
 */
function renderFigcaption(
  document: StructDocument,
  block: StructBlock,
  content: string,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const attached = publicationPlan.captionsByHostBlockId.get(block.id);
  if (attached)
    return renderAttachedCaption(
      document,
      attached,
      emittedRelationshipIds,
      publicationPlan,
    );
  return `<figcaption>${content || text(block.label ?? "")}</figcaption>`;
}

function renderBlock(
  document: StructDocument,
  block: StructBlock,
  blockIndex: number,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  // Furniture remains queryable in STRUCT with its source evidence, but is
  // intentionally outside the publication reading flow.
  if (block.kind === "furniture") return "";
  const id = attribute(block.id);
  const sourceAnchors = renderSourceObservationAnchors(block);
  // A caption that is attached to a host block is published inside that
  // host's figcaption, so it is not published a second time here.
  if (
    block.kind === "caption" &&
    publicationPlan.attachedCaptionBlockIds.has(block.id)
  )
    return "";
  if (block.kind === "table" && block.table) {
    const figcaption = publicationPlan.captionsByHostBlockId.has(block.id)
      ? renderAttachedCaption(
          document,
          publicationPlan.captionsByHostBlockId.get(block.id)!,
          emittedRelationshipIds,
          publicationPlan,
        )
      : "";
    return `<figure id="${id}" data-struct-id="${id}">${sourceAnchors}${renderTable(document, block.table, block.id, blockIndex, emittedRelationshipIds, publicationPlan)}${figcaption}</figure>`;
  }
  const content = renderInline(
    document,
    publicationPlan.sourceByKey.get(`block:${blockIndex}`)!,
    emittedRelationshipIds,
    publicationPlan,
  );
  if (block.kind === "heading") {
    const level = Math.max(
      1,
      Math.min(6, Number(block.attributes?.level ?? 2)),
    );
    return `<h${level} id="${id}" data-struct-id="${id}">${sourceAnchors}${content}</h${level}>`;
  }
  if (block.kind === "quote") {
    return `<blockquote id="${id}" data-struct-id="${id}">${sourceAnchors}<p>${content}</p></blockquote>`;
  }
  if (block.kind === "equation" && safeMathMl(block.attributes?.mathml)) {
    return `<figure id="${id}" data-struct-id="${id}" class="equation">${sourceAnchors}${mathMlForXhtml(block.attributes!.mathml)}${renderFigcaption(document, block, content, emittedRelationshipIds, publicationPlan)}</figure>`;
  }
  if (
    block.kind === "figure" ||
    block.kind === "equation" ||
    block.kind === "table"
  ) {
    const assets = (block.fallbackAssetIds ?? [])
      .map((assetId) => document.assets.find((asset) => asset.id === assetId))
      .filter((asset) => asset !== undefined);
    const artwork = assets
      .map(
        (asset) =>
          `<img src="${attribute(asset.href)}" alt="${attribute(block.label ?? block.text)}" />`,
      )
      .join("");
    return `<figure id="${id}" data-struct-id="${id}">${sourceAnchors}${artwork}${renderFigcaption(document, block, content, emittedRelationshipIds, publicationPlan)}</figure>`;
  }
  if (block.kind === "caption") {
    return `<p id="${id}" data-struct-id="${id}" class="caption">${sourceAnchors}${content}</p>`;
  }
  if (block.kind === "footnote" || block.kind === "endnote") {
    const backlinks = (publicationPlan.backlinksByTarget.get(block.id) ?? [])
      .map(
        (relationship) =>
          `<a href="#${attribute(stableId(relationship.id))}" class="note-backlink" aria-label="Back to note reference">↩</a>`,
      )
      .join(" ");
    return `<aside id="${id}" data-struct-id="${id}" epub:type="${block.kind}" role="doc-footnote" data-note-kind="${block.kind}">${sourceAnchors}<p>${content}${backlinks ? ` ${backlinks}` : ""}</p></aside>`;
  }
  if (block.kind === "code") {
    return `<pre id="${id}" data-struct-id="${id}">${sourceAnchors}<code>${content}</code></pre>`;
  }
  const bibliographyEntry = block.attributes?.bibliographyEntry
    ? ' role="doc-biblioentry" data-semantic-role="bibliography-entry"'
    : "";
  return `<p id="${id}" data-struct-id="${id}"${bibliographyEntry}>${sourceAnchors}${content}</p>`;
}

/**
 * Render one contiguous run of list items as one or more lists.
 *
 * A contiguous run of list items is one list. A list item carries either the
 * flat list contract (a list identity, with the first item of the list
 * deciding whether it is ordered) or the nested list contract (a declared
 * level and ordering). When no item of the run declares the nested
 * contract, the run is published as one flat list per list identity. When
 * any item of the run declares the nested contract, the run is published as
 * nested `<ul>`/`<ol>` containers inside the parent `<li>`, and the items
 * that do not declare nesting are the outermost items of that list. A
 * change of the list identity is a hard boundary in both contracts: the
 * following list never joins the open list's container, and it keeps its own
 * declared nesting.
 */
function renderListRun(
  document: StructDocument,
  run: ReadonlyArray<{ block: StructBlock; blockIndex: number }>,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const items = run.map((entry) =>
    planListItem(entry.block, entry.blockIndex),
  );
  const containers = planListContainers(items);
  const renderItem = (
    entry: RenderedListItemEntry,
    indent: string,
  ): string => {
    const { block, blockIndex } = entry.item;
    const id = attribute(block.id);
    const sourceAnchors = renderSourceObservationAnchors(block);
    const content = renderInline(
      document,
      publicationPlan.sourceByKey.get(`block:${blockIndex}`)!,
      emittedRelationshipIds,
      publicationPlan,
    );
    const children = entry.children
      .map(
        (child) =>
          `\n${indent}  ${renderListContainer(child, renderItem, `${indent}    `)}`,
      )
      .join("");
    const closing = children ? `\n${indent}</li>` : "</li>";
    return `<li id="${id}" data-struct-id="${id}">${sourceAnchors}${content}${children}${closing}`;
  };
  return containers
    .map((container) => renderListContainer(container, renderItem, "  "))
    .join("\n  ");
}

/**
 * Render the document's blocks in reading order.
 *
 * Consecutive list items are grouped into lists: a change of the optional
 * `listId` attribute starts a new list and the first item decides
 * ordering, and a declared `listLevel` nests a list inside the item above
 * it. Furniture blocks render nothing and never split a list.
 */
function renderBlocks(
  document: StructDocument,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const rendered: string[] = [];
  let index = 0;
  while (index < document.blocks.length) {
    const block = document.blocks[index]!;
    if (block.kind === "furniture") {
      index += 1;
      continue;
    }
    if (block.kind === "list-item") {
      const run: Array<{ block: StructBlock; blockIndex: number }> = [];
      let cursor = index;
      while (cursor < document.blocks.length) {
        const candidate = document.blocks[cursor]!;
        if (candidate.kind === "furniture") {
          cursor += 1;
          continue;
        }
        if (candidate.kind !== "list-item") break;
        run.push({ block: candidate, blockIndex: cursor });
        cursor += 1;
      }
      rendered.push(
        renderListRun(document, run, emittedRelationshipIds, publicationPlan),
      );
      index = cursor;
      continue;
    }
    rendered.push(
      renderBlock(
        document,
        block,
        index,
        emittedRelationshipIds,
        publicationPlan,
      ),
    );
    index += 1;
  }
  return rendered.join("\n  ");
}

function assertUniqueEmittedIds(entries: readonly EmittedXhtmlId[]) {
  const seen = new Map<string, string>();
  for (const { id, path } of entries) {
    const previous = seen.get(id);
    if (previous)
      throw new RenderedPublicationPlanError(
        "DUPLICATE_IDENTIFIER",
        path,
        `emitted XHTML identifier ${id} is also used by ${previous}`,
      );
    seen.set(id, path);
  }
}

/** Render a source-agnostic STRUCT graph without consulting extractor state. */
export function renderPublicationXhtml(
  document: StructDocument,
  options: StructXhtmlOptions = {},
) {
  document = normalizeStructDocumentForRenderer(document);
  const publicationPlan = buildRenderedPublicationPlan(document);
  assertUniqueEmittedIds(emittedXhtmlIds(document, publicationPlan));
  if (!verifyStructReceipt(document))
    throw new Error("STRUCT_RECEIPT_BINDING_MISMATCH");
  const emittedRelationshipIds = new Set<string>();
  const language = document.metadata.language ?? "und";
  const direction =
    document.metadata.baseDirection === "ltr" ||
    document.metadata.baseDirection === "rtl"
      ? ` dir="${document.metadata.baseDirection}"`
      : "";
  const styles = options.styles ?? DEFAULT_STYLES;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}" lang="${attribute(language)}"${direction}>
<head>
  <meta charset="utf-8" />
  <title>${text(document.metadata.title)}</title>
  ${options.embedStyles ? `<style>${text(styles)}</style>` : '<link rel="stylesheet" type="text/css" href="styles.css" />'}
</head>
<body>
  <header><h1>${text(document.metadata.title)}</h1>${document.metadata.subtitle ? `<p>${text(document.metadata.subtitle)}</p>` : ""}${renderAuthors(document, emittedRelationshipIds, publicationPlan)}</header>
  ${renderBlocks(document, emittedRelationshipIds, publicationPlan)}
</body>
</html>
`;
}
