import { SaxesParser, type SaxesTagNS } from "saxes";

const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const MATHML_ELEMENTS = new Set([
  "math", "mi", "mn", "mo", "mtext", "mspace", "ms", "mglyph", "mrow",
  "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded", "mphantom",
  "mfenced", "menclose", "msub", "msup", "msubsup", "munder", "mover",
  "munderover", "mmultiscripts", "mprescripts", "none", "mtable", "mtr",
  "mlabeledtr", "mtd", "maligngroup", "malignmark", "mstack", "mlongdiv",
  "msrow", "mscarries", "mscarry", "msline", "maction", "semantics",
  "annotation", "annotation-xml",
]);
const XML_ATTRIBUTES = new Set(["id", "lang", "space"]);
// MathML URI references and inline CSS can load resources outside the package.
const RESOURCE_ATTRIBUTES = new Set([
  "altimg", "cdgroup", "definitionurl", "href", "macros", "src", "style",
]);

type MathMlValidation = {
  rootHasDefaultNamespace: boolean;
  rootName: string;
};

function hasSafeMathMlAttributes(tag: SaxesTagNS) {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.uri === XMLNS_NAMESPACE) {
      if (
        attribute.value !== MATHML_NAMESPACE ||
        attribute.name === "xmlns:xml" ||
        attribute.name === "xmlns:xmlns"
      )
        return false;
      continue;
    }
    if (attribute.uri === "") {
      if (
        RESOURCE_ATTRIBUTES.has(attribute.local.toLowerCase()) ||
        attribute.local.toLowerCase().startsWith("on")
      )
        return false;
      continue;
    }
    if (
      attribute.uri === XML_NAMESPACE &&
      XML_ATTRIBUTES.has(attribute.local)
    )
      continue;
    return false;
  }
  return true;
}

function validateMathMlFragment(value: string): MathMlValidation | undefined {
  let valid = true;
  let rootHasDefaultNamespace = false;
  let rootName = "";
  let elementCount = 0;
  let depth = 0;
  const parser = new SaxesParser({
    xmlns: true,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  parser.on("xmldecl", () => {
    valid = false;
  });
  parser.on("doctype", () => {
    valid = false;
  });
  parser.on("processinginstruction", () => {
    valid = false;
  });
  parser.on("comment", () => {
    if (depth === 0) valid = false;
  });
  parser.on("text", () => {
    if (depth === 0) valid = false;
  });
  parser.on("opentag", (tag) => {
    elementCount += 1;
    depth += 1;
    const hasDefaultNamespace = Object.hasOwn(tag.attributes, "xmlns");
    if (elementCount === 1) {
      rootHasDefaultNamespace = hasDefaultNamespace;
      rootName = tag.name;
      if (tag.local !== "math" || tag.isSelfClosing) valid = false;
    }
    if (
      !MATHML_ELEMENTS.has(tag.local) ||
      !hasSafeMathMlAttributes(tag) ||
      (tag.uri !== MATHML_NAMESPACE &&
        !(tag.uri === "" && tag.prefix === "" && !hasDefaultNamespace))
    )
      valid = false;
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  try {
    parser.write(value).close();
  } catch {
    return undefined;
  }
  const rootStart = `<${rootName}`;
  const rootDelimiter = value[rootStart.length];
  return (
    valid &&
    elementCount > 0 &&
    (rootDelimiter === ">" || /\s/u.test(rootDelimiter ?? "")) &&
    value.startsWith(rootStart)
      ? { rootHasDefaultNamespace, rootName }
      : undefined
  );
}

export function mathMlForXhtml(value: string) {
  const validation = validateMathMlFragment(value);
  if (!validation || validation.rootHasDefaultNamespace) return value;
  return `<${validation.rootName} xmlns="${MATHML_NAMESPACE}"${value.slice(validation.rootName.length + 1)}`;
}

/** Accept a single safe MathML element for direct XHTML emission. */
export function safeMathMl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    validateMathMlFragment(value) !== undefined
  );
}
