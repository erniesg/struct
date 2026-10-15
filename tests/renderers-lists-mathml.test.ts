import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildStructEpub } from "../src/renderers/epub";
import { renderPublicationXhtml } from "../src/renderers/xhtml";
import { safeMathMl } from "../src/renderers/xhtml-mathml";
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
    expect(safeMathMl("<math><mi>x</mi></math>")).toBe(true);
    expect(
      safeMathMl(
        '<math xmlns="http://www.w3.org/1998/Math/Math&#x4d;L"><mi>x</mi></math>',
      ),
    ).toBe(true);
    expect(
      safeMathMl(
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><m:mi xmlns:m="http://www.w3.org/1998/Math/MathML">x</m:mi></math>',
      ),
    ).toBe(true);
    expect(
      safeMathMl(
        '<m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><mi>x</mi></m:math>',
      ),
    ).toBe(true);
    expect(safeMathMl(`${mathml}${mathml}`)).toBe(false);
    expect(safeMathMl("<math><mi></math>")).toBe(false);
    expect(safeMathMl("<math><mi>\u0001</mi></math>")).toBe(false);
    expect(safeMathMl("<math><mi>\u000b</mi></math>")).toBe(false);
    expect(safeMathMl('<math><mi data-x="\u000c">x</mi></math>')).toBe(
      false,
    );
    expect(
      safeMathMl(
        '<math><foreignObject xmlns="http://www.w3.org/1999/xhtml"><p>not MathML</p></foreignObject></math>',
      ),
    ).toBe(false);
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

  it("adds the MathML namespace when rendering a valid unqualified fragment", async () => {
    const bareMathml = "<math><mi>x</mi></math>";
    const document = documentWith([
      block("eq-1", "equation", "x", 0, { mathml: bareMathml }),
    ]);
    const expectedMathml =
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>';
    expect(renderPublicationXhtml(document)).toContain(expectedMathml);
    const exported = await buildStructEpub(document);
    const entries = unzipSync(exported.bytes);
    expect(strFromU8(entries["EPUB/content.xhtml"]!)).toContain(expectedMathml);
    expect(strFromU8(entries["EPUB/package.opf"]!)).toContain(
      'href="content.xhtml" media-type="application/xhtml+xml" properties="mathml"',
    );

    const prefixedMathml =
      '<m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><mi>x</mi></m:math>';
    const prefixedDocument = documentWith([
      block("eq-1", "equation", "x", 0, { mathml: prefixedMathml }),
    ]);
    const expectedPrefixedMathml =
      '<m:math xmlns="http://www.w3.org/1998/Math/MathML" xmlns:m="http://www.w3.org/1998/Math/MathML"><mi>x</mi></m:math>';
    expect(renderPublicationXhtml(prefixedDocument)).toContain(
      expectedPrefixedMathml,
    );
    const prefixedExport = await buildStructEpub(prefixedDocument);
    expect(
      strFromU8(unzipSync(prefixedExport.bytes)["EPUB/content.xhtml"]!),
    ).toContain(expectedPrefixedMathml);
    expect(
      strFromU8(unzipSync(prefixedExport.bytes)["EPUB/package.opf"]!),
    ).toContain(
      'href="content.xhtml" media-type="application/xhtml+xml" properties="mathml"',
    );
  });

  it("preserves valid numeric entities, escaped ampersands, and CDATA text", async () => {
    const entityMathml =
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>&#x1D6FC;</mi><mi>α</mi><mtext>&amp;missing;</mtext><mtext><![CDATA[&missing;]]></mtext></math>';
    expect(safeMathMl(entityMathml)).toBe(true);
    const document = documentWith([
      block("eq-1", "equation", "alpha", 0, { mathml: entityMathml }),
    ]);
    expect(renderPublicationXhtml(document)).toContain(entityMathml);
    const exported = await buildStructEpub(document);
    expect(strFromU8(unzipSync(exported.bytes)["EPUB/content.xhtml"]!)).toContain(
      entityMathml,
    );
  });

  it.each([
    "<math><script>1</script></math>",
    "<math><mi></math>",
    '<math><foreignObject xmlns="http://www.w3.org/1999/xhtml"><p>not MathML</p></foreignObject></math>',
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi href="jav&#x61;script:alert(1)">x</mi></math>',
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi xlink:href="jav&#x61;script:alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink">x</mi></math>',
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mglyph src="java&#x73;cript:alert(1)" /></math>',
    '<math altimg="https://example.test/math.svg"><mi>x</mi></math>',
    '<math cdgroup="https://example.test/group"><mi>x</mi></math>',
    '<math macros="https://example.test/macros"><mi>x</mi></math>',
    '<math><annotation definitionURL="https://example.test/symbol">x</annotation></math>',
    '<math xml:base="https://example.test/"><mi>x</mi></math>',
    '<math style="background-image:url(https://example.test/math.svg)"><mi>x</mi></math>',
    '<math xmlns="http://www.w3.org/1999/xhtml"><mi>x</mi></math>',
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi xmlns="http://www.w3.org/1999/xhtml">x</mi></math>',
    "<math><:mi>x</:mi></math>",
    '<math xmlns:a="http://www.w3.org/1998/Math/MathML"><a:b:mi>x</a:b:mi></math>',
    '<math xmlns:xml="http://www.w3.org/1998/Math/MathML"><xml:mi>x</xml:mi></math>',
    '<math><mi xmlns:a="urn:foreign" a:bar="x">x</mi></math>',
    "<math><mi>]]></mi></math>",
    "<math><!-- a--b --><mi>x</mi></math>",
    "<?unsafe x?><math><mi>x</mi></math>",
    "<!DOCTYPE math><math><mi>x</mi></math>",
    "<!--x><script>alert(1)</script></math>junk--><math><mi>x</mi></math>",
    "<math><mi>&missing;</mi></math>",
    "<math><mi>&#0;</mi></math>",
    "<math><mi>&#xD800;</mi></math>",
  ])("falls back when the MathML attribute is unsafe: %s", async (mathml) => {
    const document = documentWith([
      block("eq-1", "equation", "x", 0, {
        mathml,
      }),
    ]);
    const xhtml = renderPublicationXhtml(document);
    expect(xhtml).not.toContain("<script>");
    expect(xhtml).not.toContain(mathml);
    expect(xhtml).toContain(
      '<figure id="eq-1" data-struct-id="eq-1"><figcaption>x</figcaption></figure>',
    );
    const exported = await buildStructEpub(document);
    expect(strFromU8(unzipSync(exported.bytes)["EPUB/content.xhtml"]!)).not.toContain(
      mathml,
    );
  });
});
