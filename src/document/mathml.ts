import { XMLValidator } from 'fast-xml-parser'
import { fail, utf8ByteLength } from './codec/primitives'

export const MAX_INLINE_MATHML_BYTES = 256 * 1024
export const MAX_INLINE_MATHML_DEPTH = 64
export const MAX_INLINE_MATHML_NODES = 4096
const NAMESPACE = 'http://www.w3.org/1998/Math/MathML'
const TOKENS = new Set(['mi', 'mn', 'mo', 'mtext', 'ms'])
const ELEMENTS = new Set([
  'math', ...TOKENS, 'mrow', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup',
  'msubsup', 'munder', 'mover', 'munderover', 'mspace', 'mstyle', 'mpadded',
  'mphantom', 'mfenced', 'menclose', 'mtable', 'mtr', 'mtd',
])
const ARITY: Record<string, number> = {
  mfrac: 2, mroot: 2, msub: 2, msup: 2, munder: 2, mover: 2,
  msubsup: 3, munderover: 3, mspace: 0,
}
const BOOLEAN_ATTRIBUTES = new Set([
  'displaystyle', 'stretchy', 'symmetric', 'fence', 'separator', 'largeop',
  'movablelimits', 'accent', 'accentunder', 'equalrows', 'equalcolumns', 'bevelled',
])
const LENGTH_ATTRIBUTES = new Set([
  'lspace', 'rspace', 'width', 'height', 'depth', 'voffset', 'linethickness',
  'minsize', 'maxsize', 'columnspacing', 'rowspacing',
])
function safeAttribute(name: string, value: string, root: boolean) {
  if (name === 'xmlns') return root && value === NAMESPACE
  if (name === 'display') return root && value === 'inline'
  if (BOOLEAN_ATTRIBUTES.has(name)) return /^(?:true|false)$/u.test(value)
  if (LENGTH_ATTRIBUTES.has(name))
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?$/u.test(value)
  if (name === 'scriptlevel') return /^[+-]?\d{1,2}$/u.test(value)
  if (name === 'mathvariant')
    return /^(?:normal|bold|italic|bold-italic|double-struck|bold-fraktur|script|bold-script|fraktur|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace|initial|tailed|looped|stretched)$/u.test(value)
  if (name === 'form') return /^(?:prefix|infix|postfix)$/u.test(value)
  if (name === 'rowalign') return /^(?:top|bottom|center|baseline|axis)(?: (?:top|bottom|center|baseline|axis))*$/u.test(value)
  if (name === 'columnalign') return /^(?:left|center|right)(?: (?:left|center|right))*$/u.test(value)
  if (name === 'notation') return /^(?:longdiv|actuarial|radical|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike)(?: (?:longdiv|actuarial|radical|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike))*$/u.test(value)
  // Delimiters are inert text. XML entity syntax is validated separately.
  return ['open', 'close', 'separators', 'lquote', 'rquote'].includes(name) && value.length <= 32
}

type Element = { name: string; children: number }

/** Validate a bounded presentation-only XML atom without changing its bytes. */
export function validateInlineMathMl(value: string, path: string) {
  const invalid = () => fail('ATTRIBUTE', path, 'inline mathml must be safe presentation MathML')
  if (utf8ByteLength(value) > MAX_INLINE_MATHML_BYTES)
    fail('BUDGET', path, 'inline MathML exceeds the byte bound')
  if (value !== value.trim() || /<!|<\?/u.test(value)) invalid()
  // Only XML predefined and valid numeric character references are allowed.
  for (const match of value.matchAll(/&([^;\s<&]*);?/gu)) {
    const entity = match[1]!
    if (!match[0].endsWith(';')) invalid()
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(entity)) continue
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/u.test(entity)) invalid()
    const point = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    if (!(point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) invalid()
  }
  const stack: Element[] = []
  let nodes = 0
  let roots = 0
  let cursor = 0
  const finish = (entry: Element) => {
    if (ARITY[entry.name] !== undefined && entry.children !== ARITY[entry.name]) invalid()
    if (TOKENS.has(entry.name) && entry.children !== 0) invalid()
    if (entry.name === 'math' && entry.children === 0) invalid()
  }
  // Bound structure before handing XML to the dependency validator.
  while (cursor < value.length) {
    const isTag = value[cursor] === '<'
    let end = value.indexOf(isTag ? '>' : '<', cursor + 1)
    if (isTag && end === -1) invalid()
    end = end === -1 ? value.length : end + (isTag ? 1 : 0)
    const token = value.slice(cursor, end)
    cursor = end
    if (!isTag) {
      if (token.trim() && (!stack.length || !TOKENS.has(stack[stack.length - 1]!.name))) invalid()
      continue
    }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/u.exec(token)
    if (!tag) invalid()
    const [, closing, name, rawAttributes, selfClosing] = tag!
    if (!ELEMENTS.has(name!)) invalid()
    if (closing) {
      if (rawAttributes!.trim() || selfClosing || stack.at(-1)?.name !== name) invalid()
      finish(stack.pop()!)
      continue
    }
    nodes += 1
    if (nodes > MAX_INLINE_MATHML_NODES || stack.length >= MAX_INLINE_MATHML_DEPTH)
      fail('BUDGET', path, 'inline MathML exceeds the structural bound')
    const root = stack.length === 0
    if (root ? name !== 'math' || ++roots !== 1 : name === 'math') invalid()
    const parent = stack.at(-1)
    if (parent) {
      parent.children += 1
      if (TOKENS.has(parent.name) || parent.name === 'mspace') invalid()
      if ((parent.name === 'mtable' && name !== 'mtr') || (parent.name === 'mtr' && name !== 'mtd') || (name === 'mtr' && parent.name !== 'mtable') || (name === 'mtd' && parent.name !== 'mtr')) invalid()
    }
    let rest = rawAttributes!
    const attributes = new Set<string>()
    while (rest.trim()) {
      const attribute = /^\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/u.exec(rest)
      if (!attribute) invalid()
      const key = attribute![1]!
      const content = attribute![2] ?? attribute![3]!
      if (attributes.has(key) || !safeAttribute(key, content, root)) invalid()
      attributes.add(key)
      rest = rest.slice(attribute![0].length)
    }
    if (root && !attributes.has('xmlns')) invalid()
    const element = { name: name!, children: 0 }
    if (selfClosing) finish(element)
    else stack.push(element)
  }
  if (cursor !== value.length || stack.length || roots !== 1 || XMLValidator.validate(value) !== true) invalid()
}

/** Atomic replacements cannot be sliced by another inline owner's boundaries. */
export function validateMathMlInlineRanges(
  runs: readonly import('./types').StructInline[],
  text: string,
  path: string,
) {
  const atoms = runs.map((run, index) => ({ run, index }))
    .filter(({ run }) => run.mathml !== undefined)
    .sort((a, b) => a.run.start - b.run.start)
  if (!atoms.length) return
  const splitSurrogate = (offset: number) => offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!)
  for (const [index, { run, index: originalIndex }] of atoms.entries()) {
    if (splitSurrogate(run.start) || splitSurrogate(run.end))
      fail('RANGE', `${path}[${originalIndex}]`, 'math atom cannot split a surrogate pair')
    if (index > 0 && atoms[index - 1]!.run.end > run.start)
      fail('RANGE', `${path}[${originalIndex}]`, 'math atoms cannot overlap')
  }
  // Binary searches avoid quadratic work for many atoms under enclosing styles.
  for (const [index, run] of runs.entries()) {
    if (run.end <= run.start) continue
    let low = 0
    let high = atoms.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (atoms[middle]!.run.end <= run.start) low = middle + 1
      else high = middle
    }
    const first = atoms[low]?.run
    if (!first || first.start >= run.end) continue
    if (run.semanticRole !== undefined || run.relationshipId !== undefined)
      fail('RANGE', `${path}[${index}]`, 'math atoms cannot intersect semantic relationship spans')
    high = atoms.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (atoms[middle]!.run.start < run.end) low = middle + 1
      else high = middle
    }
    const last = atoms[low - 1]!.run
    if (run.start > first.start || run.end < last.end)
      fail('RANGE', `${path}[${index}]`, 'inline boundaries cannot split a math atom')
  }
}
