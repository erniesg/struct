import { describe, expect, it } from "vitest";
import { renderPublicationXhtml } from "../src/renderers/xhtml";
import { evidence, seal, validDocument } from "./codec-fixtures";

function cell(id: string, text: string, column: number) {
  return {
    id,
    text,
    row: 0,
    column,
    rowSpan: 1,
    columnSpan: 1,
    headerScope: "column",
    inline: [],
    evidence: evidence(),
  };
}

function table(id: string, text: string, inline: any[] = []) {
  return {
    id,
    kind: "table",
    text,
    page: 1,
    order: 0,
    column: "single",
    inline,
    evidence: evidence(),
    table: {
      rows: 1,
      columns: 2,
      cells: [cell("c0-0", "A", 0), cell("c0-1", "B", 1)],
      semantic: "verified",
    },
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
        { id: "column-1", side: "single", blockIds: blocks.map((entry) => entry.id) },
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

describe("table captions", () => {
  it("renders the table block text as a figcaption above the table", () => {
    const xhtml = renderPublicationXhtml(
      documentWith([table("t-1", "Table 1 Results")]),
    );
    expect(xhtml).toContain(
      '<figure id="t-1" data-struct-id="t-1"><figcaption>Table 1 Results</figcaption><table>',
    );
  });

  it("omits the figcaption for a caption-less table", () => {
    const xhtml = renderPublicationXhtml(documentWith([table("t-2", "")]));
    expect(xhtml).toContain('<figure id="t-2" data-struct-id="t-2"><table>');
    expect(xhtml).not.toContain("<figcaption>");
  });

  it("renders inline runs inside the caption", () => {
    const xhtml = renderPublicationXhtml(
      documentWith([
        table("t-3", "Table 2 Ablations", [{ start: 0, end: 7, bold: true }]),
      ]),
    );
    expect(xhtml).toContain(
      "<figcaption><strong>Table 2</strong> Ablations</figcaption><table>",
    );
  });
});

describe("footnote labels", () => {
  it("leads a labelled footnote with its label", () => {
    const note = {
      id: "fn-1",
      kind: "footnote",
      text: "Equal contribution.",
      label: "1",
      page: 1,
      order: 0,
      column: "single",
      inline: [],
      evidence: evidence(),
    };
    const xhtml = renderPublicationXhtml(documentWith([note]));
    expect(xhtml).toContain(
      '<p><span class="note-label">1</span> Equal contribution.</p></aside>',
    );
  });

  it("renders an unlabelled footnote without a label span", () => {
    const note = {
      id: "fn-2",
      kind: "footnote",
      text: "Unlabelled.",
      page: 1,
      order: 0,
      column: "single",
      inline: [],
      evidence: evidence(),
    };
    const xhtml = renderPublicationXhtml(documentWith([note]));
    expect(xhtml).toContain("<p>Unlabelled.</p></aside>");
    expect(xhtml).not.toContain("note-label");
  });
});
