import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildStructEpub } from "../src/renderers/epub";
import { renderPublicationXhtml, safeMathMl } from "../src/renderers/xhtml";
import { evidence, seal, validDocument } from "./codec-fixtures";

function block(
  id: string,
  kind: string,
  text: string,
  order: number,
  attributes?: Record<string, string | number | boolean>,
) {
  return {
    id,
    kind,
    text,
    page: 1,
    order,
    column: "single",
    inline: [],
    evidence: evidence(),
    ...(attributes ? { attributes } : {}),
  };
}

function documentWith(blocks: any[]) {
  const document: any = validDocument();
  document.blocks = blocks;
  document.pages = [
    {
      page: 1,
      width: 100,
      height: 100,
      rotation: 0,
      blocks: blocks.map((entry) => entry.id),
      columns: [
        {
          id: "column-1",
          side: "single",
          blockIds: blocks.map((entry) => entry.id),
        },
      ],
    },
  ];
  document.relationships = [];
  document.metadata.authorNotes = [];
  document.assets = [];
  const text = blocks.reduce((total, entry) => total + entry.text.length, 0);
  document.receipt = {
    ...document.receipt,
    blockCount: blocks.length,
    assetCount: 0,
    relationshipCount: 0,
    diagnosticCount: document.diagnostics.length,
    textCharacterCount: text,
    conservation: {
      ...document.receipt.conservation,
      sourceAssetCount: 0,
      accountedSourceAssetCount: 0,
      sourceRelationshipCount: 0,
      accountedSourceRelationshipCount: 0,
      sourceTextCharacterCount: text,
      structBlockCount: blocks.length,
      structAssetCount: 0,
      structRelationshipCount: 0,
      structTextCharacterCount: text,
    },
  };
  return seal(document);
}

describe("list grouping", () => {
  it("wraps consecutive list items in one list and starts a new list per listId", () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        block("p-1", "paragraph", "Intro", 0),
        block("li-1", "list-item", "first", 1, { ordered: true, listId: "a" }),
        block("li-2", "list-item", "second", 2, { ordered: true, listId: "a" }),
        block("li-3", "list-item", "bullet", 3, {
          ordered: false,
          listId: "b",
        }),
        block("p-2", "paragraph", "Outro", 4),
      ]),
    );
    expect(xhtml).toContain(
      '<ol>\n  <li id="li-1" data-struct-id="li-1">first</li>\n  <li id="li-2" data-struct-id="li-2">second</li>\n  </ol>',
    );
    expect(xhtml).toContain(
      '<ul>\n  <li id="li-3" data-struct-id="li-3">bullet</li>\n  </ul>',
    );
    expect(xhtml.indexOf('<p id="p-1"')).toBeLessThan(xhtml.indexOf("<ol>"));
    expect(xhtml.indexOf("</ul>")).toBeLessThan(xhtml.indexOf('<p id="p-2"'));
  });

  it("does not let furniture split a list", () => {
    const furniture = {
      ...block("f-1", "furniture", "Running head", 1),
      furniture: {
        classification: "repeated-text",
        band: "top",
        pages: [1],
        boxes: [],
        evidence: ["fixture"],
      },
    };
    const document: any = documentWith([
      block("li-1", "list-item", "first", 0, { ordered: false }),
      furniture,
      block("li-2", "list-item", "second", 2, { ordered: false }),
    ]);
    document.receipt.conservation = {
      ...document.receipt.conservation,
      sourceFurnitureBlockCount: 1,
      accountedFurnitureBlockCount: 1,
      sourceFurnitureTextCharacterCount: "Running head".length,
      structFurnitureBlockCount: 1,
      structFurnitureTextCharacterCount: "Running head".length,
    };
    seal(document);
    const xhtml = renderPublicationXhtml(document);
    expect(xhtml.match(/<ul>/g)).toHaveLength(1);
    expect(xhtml).not.toContain("Running head");
  });
});

describe("MathML equations", () => {
  const mathml =
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math>';

  it("accepts a single math element and rejects scripts or multiple roots", () => {
    expect(safeMathMl(mathml)).toBe(true);
    expect(safeMathMl(`${mathml}${mathml}`)).toBe(false);
    expect(safeMathMl("<math><script>alert(1)</script></math>")).toBe(false);
    expect(safeMathMl('<math onload="x">x</math>')).toBe(false);
    expect(safeMathMl(" <math></math>")).toBe(false);
    expect(safeMathMl(42)).toBe(false);
  });

  it("renders the equation inline and declares the mathml manifest property", async () => {
    const document = documentWith([
      block("eq-1", "equation", "E = mc^2", 0, { mathml }),
    ]);
    const xhtml = renderPublicationXhtml(document);
    expect(xhtml).toContain(
      `<figure id="eq-1" data-struct-id="eq-1" class="equation">${mathml}<figcaption>E = mc^2</figcaption></figure>`,
    );
    const exported = await buildStructEpub(document);
    const entries = unzipSync(exported.bytes);
    expect(strFromU8(entries["EPUB/package.opf"]!)).toContain(
      'href="content.xhtml" media-type="application/xhtml+xml" properties="mathml"',
    );
    expect(strFromU8(entries["EPUB/content.xhtml"]!)).toContain("<msup>");
  });

  it("falls back to the asset figure when the attribute is not safe MathML", () => {
    const document = documentWith([
      block("eq-1", "equation", "x", 0, {
        mathml: "<math><script>1</script></math>",
      }),
    ]);
    const xhtml = renderPublicationXhtml(document);
    expect(xhtml).not.toContain("<script>");
    expect(xhtml).toContain(
      '<figure id="eq-1" data-struct-id="eq-1"><figcaption>x</figcaption></figure>',
    );
  });
});
