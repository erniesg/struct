const MATHML_OPEN = /^<math(?:\s[^<>]*)?>/u;

/**
 * Accept a MathML fragment only when it is a single `<math>` element with no
 * script or foreign-object payload; well-formedness is enforced by the EPUB
 * builder, which fails closed on any malformed XHTML.
 */
export function safeMathMl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === value &&
    MATHML_OPEN.test(trimmed) &&
    trimmed.endsWith("</math>") &&
    !/<\/math>[\s\S]*<math/u.test(trimmed) &&
    !/<(?:script|iframe|object|embed|style|link|meta)\b/iu.test(trimmed) &&
    !/\bon[a-z]+\s*=/iu.test(trimmed) &&
    !/javascript:/iu.test(trimmed)
  );
}
