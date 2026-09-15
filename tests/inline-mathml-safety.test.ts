import { renderedInlinePlan } from '../src/renderers/xhtml-plan'
import { describe, expect, it } from 'vitest'
import { validateInlineMathMl, MAX_INLINE_MATHML_BYTES, MAX_INLINE_MATHML_DEPTH, MAX_INLINE_MATHML_NODES } from '../src/document/mathml'
const math = (body: string) => `<math xmlns="http://www.w3.org/1998/Math/MathML">${body}</math>`
describe('bounded presentation MathML', () => {
  it('accepts fractions and radicals without rewriting their bytes', () => {
    expect(() => validateInlineMathMl(math('<mfrac><mi>x</mi><msqrt><mn>2</mn></msqrt></mfrac>'), '$.mathml')).not.toThrow()
  })
  it.each([
    '<math><mi>x</mi></math>',
    math('<mfrac><mi>x</mi></mfrac>'),
    math('<mi xmlns="http://www.w3.org/1999/xhtml">x</mi>'),
    math('<mi href="https://example.com">x</mi>'),
    math('<mi style="color:red">x</mi>'),
    math('<script>alert(1)</script>'),
    math('<annotation-xml><p>foreign</p></annotation-xml>'),
    math('<mi>&arbitrary;</mi>'),
    math('<mi>&#0;</mi>'),
    math('<mi>&#xD800;</mi>'),
    math('<mi>x</mi>') + math('<mi>y</mi>'),
    '<?xml version="1.0"?>' + math('<mi>x</mi>'),
    '<!DOCTYPE math [<!ENTITY a "a">]>' + math('<mi>&a;</mi>'),
    math('<mi onload="x">x</mi>'),
    math('<mi id="foreign-id">x</mi>'),
    math('<mrow>unstructured text</mrow>'),
    math('<mi><mi>x</mi></mi>'),
  ])('rejects unsupported or unsafe markup: %s', (value) => {
    expect(() => validateInlineMathMl(value, '$.mathml')).toThrow()
  })
  it('enforces byte, depth and node bounds', () => {
    expect(() => validateInlineMathMl(math(`<mtext>${'x'.repeat(MAX_INLINE_MATHML_BYTES)}</mtext>`), '$.mathml')).toThrow()
    expect(() => validateInlineMathMl(math('<mrow>'.repeat(MAX_INLINE_MATHML_DEPTH) + '<mi>x</mi>' + '</mrow>'.repeat(MAX_INLINE_MATHML_DEPTH)), '$.mathml')).toThrow()
    expect(() => validateInlineMathMl(math('<mi>x</mi>'.repeat(MAX_INLINE_MATHML_NODES)), '$.mathml')).toThrow()
  })
})


describe('inline MathML output accounting', () => {
  it('charges UTF-8 bytes of each atom before materializing publication segments', () => {
    const mathml = math(`<mtext>${'π'.repeat(125_000)}</mtext>`)
    const runs = Array.from({ length: 65 }, (_, start) => ({ start, end: start + 1, mathml }))
    expect(() => renderedInlinePlan('x'.repeat(runs.length), runs)).toThrow(/BUDGET|budget/)
  })
  it('accepts the declared byte, node and depth boundaries', () => {
    const emptyText = math('<mtext></mtext>')
    expect(() => validateInlineMathMl(math(`<mtext>${'x'.repeat(MAX_INLINE_MATHML_BYTES - emptyText.length)}</mtext>`), '$.mathml')).not.toThrow()
    expect(() => validateInlineMathMl(math('<mrow>'.repeat(MAX_INLINE_MATHML_DEPTH - 2) + '<mi>x</mi>' + '</mrow>'.repeat(MAX_INLINE_MATHML_DEPTH - 2)), '$.mathml')).not.toThrow()
    expect(() => validateInlineMathMl(math('<mi>x</mi>'.repeat(MAX_INLINE_MATHML_NODES - 1)), '$.mathml')).not.toThrow()
  })
})

it('rejects an unterminated tag flood within the atom input bound', () => {
  expect(() => validateInlineMathMl('<'.repeat(200_000), '$.mathml')).toThrow()
})
