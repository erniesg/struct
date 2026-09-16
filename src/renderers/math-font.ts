import { STIX_TWO_MATH_BASE64, STIX_TWO_MATH_LICENSE } from './fonts/stix-two-math'

export const MATH_FONT_HREF = 'fonts/struct-stix-two-math.woff2'
export const MATH_FONT_CSS_HREF = 'struct-math.css'
export const MATH_FONT_ID = 'struct-math-font'
export const MATH_FONT_CSS_ID = 'struct-math-styles'

/** Renderer resources are independent of document assets and semantic receipts. */
export function mathFontStyles(mode: 'embedded' | 'external') {
  const href = mode === 'embedded'
    ? `data:font/woff2;base64,${STIX_TWO_MATH_BASE64}`
    : MATH_FONT_HREF
  return `/* STIX Two Math v2.13b171. Original font bytes.\nUpstream: https://github.com/stipub/stixfonts/tree/744a22a4dd626cd14d75728aef34fc8ad7c85db0\nWOFF2 SHA-256: 094191335def3f0452c81ec0713cfc2f29bb6af8cecbf79b60881fbf2db97562\n${STIX_TWO_MATH_LICENSE}*/
@font-face { font-family: "Struct STIX Two Math"; src: url("${href}") format("woff2"); font-weight: normal; font-style: normal; }
math { font-family: "Struct STIX Two Math", math; }`
}

/** Return a fresh copy; callers cannot mutate subsequent publications. */
export function mathFontBytes() {
  const binary = atob(STIX_TWO_MATH_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}
