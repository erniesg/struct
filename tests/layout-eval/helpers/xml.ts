const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const EPUB_NAMESPACE = 'http://www.idpf.org/2007/ops'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const OPF_NAMESPACE = 'http://www.idpf.org/2007/opf'
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/'

export const XML_NAMESPACES = Object.freeze({
  dc: DC_NAMESPACE,
  epub: EPUB_NAMESPACE,
  opf: OPF_NAMESPACE,
  xhtml: XHTML_NAMESPACE,
  xlink: XLINK_NAMESPACE,
  xml: XML_NAMESPACE,
  xmlns: XMLNS_NAMESPACE,
})

export type XmlHelperErrorCode =
  | 'XML_CHARACTER'
  | 'XML_DOCUMENT'
  | 'XML_FORBIDDEN_DECLARATION'
  | 'XML_FORBIDDEN_ENTITY'
  | 'XML_INPUT_TYPE'
  | 'XML_INVALID_SYNTAX'
  | 'XML_NAMESPACE'
  | 'XML_RESOURCE_LIMIT'

export class XmlHelperError extends Error {
  readonly code: XmlHelperErrorCode

  constructor(code: XmlHelperErrorCode) {
    super(code)
    this.name = 'XmlHelperError'
    this.code = code
  }
}

export type XmlTraversalLimits = {
  maximumAttributes: number
  maximumBytes: number
  maximumDepth: number
  maximumNodes: number
  maximumTextBytes: number
}

export const DEFAULT_XML_TRAVERSAL_LIMITS: Readonly<XmlTraversalLimits> =
  Object.freeze({
    maximumAttributes: 100_000,
    maximumBytes: 8 * 1024 * 1024,
    maximumDepth: 128,
    maximumNodes: 100_000,
    maximumTextBytes: 8 * 1024 * 1024,
  })

export type XmlQualifiedName = {
  localName: string
  namespaceUri: string | null
  prefix: string | null
  qualifiedName: string
}

export type XmlAttribute = XmlQualifiedName & {
  value: string
}

export type XmlText = {
  type: 'text'
  value: string
}

export type XmlElement = XmlQualifiedName & {
  type: 'element'
  attributes: XmlAttribute[]
  children: XmlNode[]
}

export type XmlNode = XmlElement | XmlText

export type XmlDocument = {
  attributeCount: number
  doctype?: string
  nodeCount: number
  root: XmlElement
  textByteCount: number
}

type RawAttribute = {
  qualifiedName: string
  value: string
}

const xmlDeclarationPattern =
  /^<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(?:"1\.0"|'1\.0')(?:[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[\t\n\r ]+standalone[\t\n\r ]*=[\t\n\r ]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\n\r ]*\?>$/u

function checkedLimits(
  overrides: Partial<XmlTraversalLimits> | undefined,
): XmlTraversalLimits {
  const limits = { ...DEFAULT_XML_TRAVERSAL_LIMITS, ...overrides }
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new XmlHelperError('XML_RESOURCE_LIMIT')
  return limits
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  )
}

function assertXmlCharacters(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!
    if (!isXmlCharacter(codePoint))
      throw new XmlHelperError('XML_CHARACTER')
    if (codePoint > 0xffff) index += 1
  }
}

function splitQualifiedName(qualifiedName: string): {
  localName: string
  prefix: string | null
} {
  const pieces = qualifiedName.split(':')
  if (pieces.length > 2 || pieces.some((piece) => piece.length === 0))
    throw new XmlHelperError('XML_NAMESPACE')
  return pieces.length === 1
    ? { localName: pieces[0]!, prefix: null }
    : { localName: pieces[1]!, prefix: pieces[0]! }
}

class BoundedXmlParser {
  private index = 0
  private documentStartIndex = 0
  private nodeCount = 0
  private attributeCount = 0
  private textByteCount = 0
  private doctype: string | undefined
  private xmlDeclarationSeen = false

  constructor(
    private readonly xml: string,
    private readonly limits: XmlTraversalLimits,
  ) {}

  parse(): XmlDocument {
    if (this.xml.charCodeAt(0) === 0xfeff) {
      this.index = 1
      this.documentStartIndex = 1
    }
    this.parseMisc(true)
    if (this.index >= this.xml.length || !this.xml.startsWith('<', this.index))
      this.fail('XML_DOCUMENT')
    const namespaces = new Map<string, string>([['xml', XML_NAMESPACE]])
    const root = this.parseElement(1, namespaces)
    this.parseMisc(false)
    if (this.index !== this.xml.length) this.fail('XML_DOCUMENT')
    return {
      attributeCount: this.attributeCount,
      ...(this.doctype === undefined ? {} : { doctype: this.doctype }),
      nodeCount: this.nodeCount,
      root,
      textByteCount: this.textByteCount,
    }
  }

  private fail(code: XmlHelperErrorCode): never {
    throw new XmlHelperError(code)
  }

  private consumeNode(): void {
    this.nodeCount += 1
    if (this.nodeCount > this.limits.maximumNodes)
      this.fail('XML_RESOURCE_LIMIT')
  }

  private consumeAttributes(count: number): void {
    this.attributeCount += count
    if (this.attributeCount > this.limits.maximumAttributes)
      this.fail('XML_RESOURCE_LIMIT')
  }

  private consumeText(value: string): void {
    this.textByteCount += utf8ByteLength(value)
    if (this.textByteCount > this.limits.maximumTextBytes)
      this.fail('XML_RESOURCE_LIMIT')
  }

  private skipWhitespace(): void {
    while (
      this.index < this.xml.length &&
      /[\t\n\r ]/u.test(this.xml[this.index]!)
    )
      this.index += 1
  }

  private parseMisc(allowDoctype: boolean): void {
    for (;;) {
      this.skipWhitespace()
      if (this.xml.startsWith('<!--', this.index)) {
        this.parseComment()
        continue
      }
      if (this.xml.startsWith('<?', this.index)) {
        this.parseProcessingInstruction()
        continue
      }
      if (this.xml.startsWith('<!DOCTYPE', this.index)) {
        if (!allowDoctype || this.doctype !== undefined)
          this.fail('XML_FORBIDDEN_DECLARATION')
        this.parseDoctype()
        continue
      }
      break
    }
  }

  private parseComment(): void {
    const end = this.xml.indexOf('-->', this.index + 4)
    if (end === -1) this.fail('XML_INVALID_SYNTAX')
    if (this.xml.slice(this.index + 4, end).includes('--'))
      this.fail('XML_INVALID_SYNTAX')
    this.consumeNode()
    this.index = end + 3
  }

  private parseProcessingInstruction(): void {
    const end = this.xml.indexOf('?>', this.index + 2)
    if (end === -1) this.fail('XML_INVALID_SYNTAX')
    const instruction = this.xml.slice(this.index + 2, end)
    const instructionMatch = instruction.match(
      /^([A-Za-z_:][A-Za-z0-9_.:-]*)(?:[\t\n\r ]+[\s\S]*)?$/u,
    )
    if (!instructionMatch) this.fail('XML_INVALID_SYNTAX')
    const target = instructionMatch[1]!
    if (target.toLowerCase() === 'xml') {
      if (
        target !== 'xml' ||
        this.index !== this.documentStartIndex ||
        this.xmlDeclarationSeen ||
        !xmlDeclarationPattern.test(this.xml.slice(this.index, end + 2))
      )
        this.fail('XML_INVALID_SYNTAX')
      this.xmlDeclarationSeen = true
    }
    this.consumeNode()
    this.index = end + 2
  }

  private parseDoctype(): void {
    const end = this.xml.indexOf('>', this.index + 9)
    if (end === -1) this.fail('XML_FORBIDDEN_DECLARATION')
    const declaration = this.xml.slice(this.index, end + 1)
    const match = declaration.match(
      /^<!DOCTYPE[\t\n\r ]+([A-Za-z_:][A-Za-z0-9_.:-]*)[\t\n\r ]*>$/u,
    )
    if (!match) this.fail('XML_FORBIDDEN_DECLARATION')
    splitQualifiedName(match[1]!)
    this.doctype = match[1]!
    this.consumeNode()
    this.index = end + 1
  }

  private parseElement(
    depth: number,
    inheritedNamespaces: ReadonlyMap<string, string>,
  ): XmlElement {
    if (depth > this.limits.maximumDepth)
      this.fail('XML_RESOURCE_LIMIT')
    if (this.xml[this.index] !== '<') this.fail('XML_INVALID_SYNTAX')
    this.index += 1
    if (
      this.xml[this.index] === '/' ||
      this.xml[this.index] === '!' ||
      this.xml[this.index] === '?'
    )
      this.fail('XML_INVALID_SYNTAX')
    const qualifiedName = this.readName()
    const rawAttributes: RawAttribute[] = []
    const rawNames = new Set<string>()
    let selfClosing = false
    for (;;) {
      this.skipWhitespace()
      if (this.xml.startsWith('/>', this.index)) {
        this.index += 2
        selfClosing = true
        break
      }
      if (this.xml[this.index] === '>') {
        this.index += 1
        break
      }
      const attributeName = this.readName()
      if (rawNames.has(attributeName)) this.fail('XML_INVALID_SYNTAX')
      rawNames.add(attributeName)
      this.consumeAttributes(1)
      this.skipWhitespace()
      if (this.xml[this.index] !== '=') this.fail('XML_INVALID_SYNTAX')
      this.index += 1
      this.skipWhitespace()
      const quote = this.xml[this.index]
      if (quote !== '"' && quote !== "'") this.fail('XML_INVALID_SYNTAX')
      this.index += 1
      const start = this.index
      while (
        this.index < this.xml.length &&
        this.xml[this.index] !== quote
      ) {
        if (this.xml[this.index] === '<') this.fail('XML_INVALID_SYNTAX')
        this.index += 1
      }
      if (this.index >= this.xml.length) this.fail('XML_INVALID_SYNTAX')
      const value = this.decodeReferences(this.xml.slice(start, this.index))
      this.consumeText(value)
      rawAttributes.push({ qualifiedName: attributeName, value })
      this.index += 1
    }

    const namespaces = new Map(inheritedNamespaces)
    for (const attribute of rawAttributes) {
      if (attribute.qualifiedName === 'xmlns') {
        if (
          attribute.value === XML_NAMESPACE ||
          attribute.value === XMLNS_NAMESPACE
        )
          this.fail('XML_NAMESPACE')
        if (attribute.value) namespaces.set('', attribute.value)
        else namespaces.delete('')
        continue
      }
      if (!attribute.qualifiedName.startsWith('xmlns:')) continue
      const prefix = attribute.qualifiedName.slice('xmlns:'.length)
      if (!prefix || prefix === 'xmlns' || !attribute.value)
        this.fail('XML_NAMESPACE')
      if (prefix === 'xml') {
        if (attribute.value !== XML_NAMESPACE) this.fail('XML_NAMESPACE')
      } else if (
        attribute.value === XML_NAMESPACE ||
        attribute.value === XMLNS_NAMESPACE
      )
        this.fail('XML_NAMESPACE')
      namespaces.set(prefix, attribute.value)
    }

    const elementName = this.resolveName(qualifiedName, namespaces, false)
    if (elementName.prefix === 'xmlns') this.fail('XML_NAMESPACE')
    const attributes: XmlAttribute[] = []
    const expandedAttributeNames = new Set<string>()
    for (const raw of rawAttributes) {
      let name: XmlQualifiedName
      if (raw.qualifiedName === 'xmlns') {
        name = {
          localName: 'xmlns',
          namespaceUri: XMLNS_NAMESPACE,
          prefix: null,
          qualifiedName: raw.qualifiedName,
        }
      } else if (raw.qualifiedName.startsWith('xmlns:')) {
        name = {
          localName: raw.qualifiedName.slice('xmlns:'.length),
          namespaceUri: XMLNS_NAMESPACE,
          prefix: 'xmlns',
          qualifiedName: raw.qualifiedName,
        }
      } else name = this.resolveName(raw.qualifiedName, namespaces, true)
      const expandedName = `${name.namespaceUri ?? ''}\u0000${name.localName}`
      if (expandedAttributeNames.has(expandedName))
        this.fail('XML_INVALID_SYNTAX')
      expandedAttributeNames.add(expandedName)
      attributes.push({ ...name, value: raw.value })
    }

    const element: XmlElement = {
      ...elementName,
      type: 'element',
      attributes,
      children: [],
    }
    this.consumeNode()
    if (selfClosing) return element

    for (;;) {
      if (this.index >= this.xml.length) this.fail('XML_INVALID_SYNTAX')
      if (this.xml.startsWith(`</`, this.index)) {
        this.index += 2
        const closingName = this.readName()
        this.skipWhitespace()
        if (this.xml[this.index] !== '>' || closingName !== qualifiedName)
          this.fail('XML_INVALID_SYNTAX')
        this.index += 1
        return element
      }
      if (this.xml.startsWith('<!--', this.index)) {
        this.parseComment()
        continue
      }
      if (this.xml.startsWith('<?', this.index)) {
        this.parseProcessingInstruction()
        continue
      }
      if (this.xml.startsWith('<![CDATA[', this.index)) {
        const end = this.xml.indexOf(']]>', this.index + 9)
        if (end === -1) this.fail('XML_INVALID_SYNTAX')
        const value = this.xml.slice(this.index + 9, end)
        assertXmlCharacters(value)
        this.appendText(element, value)
        this.index = end + 3
        continue
      }
      if (this.xml.startsWith('<!', this.index))
        this.fail('XML_FORBIDDEN_DECLARATION')
      if (this.xml[this.index] === '<') {
        element.children.push(this.parseElement(depth + 1, namespaces))
        continue
      }
      const next = this.xml.indexOf('<', this.index)
      if (next === -1) this.fail('XML_INVALID_SYNTAX')
      const rawText = this.xml.slice(this.index, next)
      if (rawText.includes(']]>')) this.fail('XML_INVALID_SYNTAX')
      const value = this.decodeReferences(rawText)
      this.appendText(element, value)
      this.index = next
    }
  }

  private appendText(element: XmlElement, value: string): void {
    if (!value) return
    this.consumeText(value)
    const previous = element.children.at(-1)
    if (previous?.type === 'text') {
      previous.value += value
      return
    }
    this.consumeNode()
    element.children.push({ type: 'text', value })
  }

  private readName(): string {
    const start = this.index
    if (
      this.index >= this.xml.length ||
      !/[A-Za-z_:]/u.test(this.xml[this.index]!)
    )
      this.fail('XML_INVALID_SYNTAX')
    this.index += 1
    while (
      this.index < this.xml.length &&
      /[A-Za-z0-9_.:-]/u.test(this.xml[this.index]!)
    )
      this.index += 1
    const name = this.xml.slice(start, this.index)
    splitQualifiedName(name)
    return name
  }

  private resolveName(
    qualifiedName: string,
    namespaces: ReadonlyMap<string, string>,
    attribute: boolean,
  ): XmlQualifiedName {
    const { localName, prefix } = splitQualifiedName(qualifiedName)
    const namespaceUri =
      prefix === null
        ? attribute
          ? null
          : (namespaces.get('') ?? null)
        : namespaces.get(prefix)
    if (prefix !== null && namespaceUri === undefined)
      this.fail('XML_NAMESPACE')
    return {
      localName,
      namespaceUri: namespaceUri ?? null,
      prefix,
      qualifiedName,
    }
  }

  private decodeReferences(value: string): string {
    if (!value.includes('&')) {
      assertXmlCharacters(value)
      return value
    }
    let decoded = ''
    let cursor = 0
    while (cursor < value.length) {
      const ampersand = value.indexOf('&', cursor)
      if (ampersand === -1) {
        decoded += value.slice(cursor)
        break
      }
      decoded += value.slice(cursor, ampersand)
      const semicolon = value.indexOf(';', ampersand + 1)
      if (semicolon === -1 || semicolon - ampersand > 16)
        this.fail('XML_FORBIDDEN_ENTITY')
      const reference = value.slice(ampersand + 1, semicolon)
      const predefined: Readonly<Record<string, string>> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        quot: '"',
      }
      if (Object.hasOwn(predefined, reference)) decoded += predefined[reference]
      else if (/^#[0-9]+$/u.test(reference)) {
        decoded += this.numericReference(reference.slice(1), 10)
      } else if (/^#x[0-9A-Fa-f]+$/u.test(reference)) {
        decoded += this.numericReference(reference.slice(2), 16)
      } else this.fail('XML_FORBIDDEN_ENTITY')
      cursor = semicolon + 1
    }
    assertXmlCharacters(decoded)
    return decoded
  }

  private numericReference(digits: string, radix: 10 | 16): string {
    const codePoint = Number.parseInt(digits, radix)
    if (!Number.isSafeInteger(codePoint) || !isXmlCharacter(codePoint))
      this.fail('XML_CHARACTER')
    return String.fromCodePoint(codePoint)
  }
}

export function parseXmlDocument(
  source: string | Uint8Array,
  limitOverrides?: Partial<XmlTraversalLimits>,
): XmlDocument {
  const limits = checkedLimits(limitOverrides)
  let xml: string
  if (typeof source === 'string') {
    if (utf8ByteLength(source) > limits.maximumBytes)
      throw new XmlHelperError('XML_RESOURCE_LIMIT')
    xml = source
  } else if (source instanceof Uint8Array) {
    if (source.byteLength > limits.maximumBytes)
      throw new XmlHelperError('XML_RESOURCE_LIMIT')
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(source)
    } catch {
      throw new XmlHelperError('XML_CHARACTER')
    }
  } else throw new XmlHelperError('XML_INPUT_TYPE')
  assertXmlCharacters(xml)
  return new BoundedXmlParser(xml.replace(/\r\n?/gu, '\n'), limits).parse()
}

export function xmlAttribute(
  element: XmlElement,
  localName: string,
  namespaceUri: string | null = null,
): string | undefined {
  return element.attributes.find(
    (attribute) =>
      attribute.localName === localName &&
      attribute.namespaceUri === namespaceUri,
  )?.value
}

export function xmlElementText(element: XmlElement): string {
  let value = ''
  const stack: XmlNode[] = [...element.children].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'text') value += node.value
    else
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        stack.push(node.children[index]!)
  }
  return value
}

export function xmlElements(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = []
  const stack = [root]
  while (stack.length > 0) {
    const element = stack.pop()!
    result.push(element)
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index]!
      if (child.type === 'element') stack.push(child)
    }
  }
  return result
}

function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => child.type === 'element',
  )
}

function directChildren(
  element: XmlElement,
  namespaceUri: string,
  localName: string,
): XmlElement[] {
  return childElements(element).filter(
    (child) =>
      child.namespaceUri === namespaceUri && child.localName === localName,
  )
}

function oneDirectChild(
  element: XmlElement,
  namespaceUri: string,
  localName: string,
): XmlElement {
  const children = directChildren(element, namespaceUri, localName)
  if (children.length !== 1) throw new XmlHelperError('XML_DOCUMENT')
  return children[0]!
}

export function xmlTextTokens(value: string): string[] {
  return value.match(/[^\t\n\r ]+/gu) ?? []
}

export type XmlAttributeReference = {
  attributeName: string
  elementId?: string
  elementName: string
  namespaceUri: string | null
  value: string
}

export type XhtmlTextRun = {
  focusable: boolean
  hidden: boolean
  kind: 'citation' | 'note'
  tokens: string[]
  value: string
}

export type XhtmlSemantics = {
  ariaReferences: Array<{
    attributeName: string
    sourceId?: string
    targetIds: string[]
  }>
  document: XmlDocument
  duplicateIds: string[]
  epubTypes: Array<{ elementName: string; id?: string; tokens: string[] }>
  headings: Array<{
    id?: string
    level: number
    text: string
    textTokens: string[]
  }>
  hrefs: XmlAttributeReference[]
  ids: string[]
  namespacedHrefs: XmlAttributeReference[]
  roles: Array<{ elementName: string; id?: string; tokens: string[] }>
  rootDirection?: string
  rootLanguage: { html?: string; xml?: string }
  semanticTextRuns: XhtmlTextRun[]
  srcs: XmlAttributeReference[]
  tables: Array<{
    ariaLabel?: string
    ariaLabelledBy: string[]
    captions: Array<{ id?: string; text: string }>
    cells: Array<{
      headers: string[]
      id?: string
      kind: 'td' | 'th'
      scope?: string
      text: string
    }>
    id?: string
  }>
  visibleTextSegments: string[]
  visibleTextTokens: string[]
}

const hiddenClassNames = new Set([
  'additional-semantic-reference',
  'sr-only',
  'visually-hidden',
])
const nonRenderedElements = new Set(['head', 'script', 'style', 'template'])
const ariaReferenceAttributes = new Set([
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-labelledby',
  'aria-owns',
  'for',
])

function tokensAttribute(value: string | undefined): string[] {
  return value?.match(/[^\t\n\r ]+/gu) ?? []
}

function isHiddenElement(element: XmlElement): boolean {
  if (xmlAttribute(element, 'hidden') !== undefined) return true
  if (xmlAttribute(element, 'aria-hidden')?.toLowerCase() === 'true') return true
  if (
    tokensAttribute(xmlAttribute(element, 'class')).some((token) =>
      hiddenClassNames.has(token),
    )
  )
    return true
  const style = xmlAttribute(element, 'style')
  return (
    style !== undefined &&
    /(?:^|;)[\t\n\r ]*(?:display[\t\n\r ]*:[\t\n\r ]*none|visibility[\t\n\r ]*:[\t\n\r ]*(?:hidden|collapse))(?:[\t\n\r ]*!important)?[\t\n\r ]*(?:;|$)/iu.test(
      style,
    )
  )
}

function isFocusableElement(element: XmlElement): boolean {
  const tabindex = xmlAttribute(element, 'tabindex')
  if (tabindex !== undefined && /^\+?[0-9]+$/u.test(tabindex)) return true
  if (
    element.namespaceUri === XHTML_NAMESPACE &&
    ['button', 'input', 'select', 'summary', 'textarea'].includes(
      element.localName,
    )
  )
    return xmlAttribute(element, 'disabled') === undefined
  if (
    element.namespaceUri === XHTML_NAMESPACE &&
    ['a', 'area'].includes(element.localName)
  )
    return xmlAttribute(element, 'href') !== undefined
  return false
}

function semanticKinds(element: XmlElement): Set<'citation' | 'note'> {
  const values = [
    ...tokensAttribute(xmlAttribute(element, 'role')),
    ...tokensAttribute(xmlAttribute(element, 'type', EPUB_NAMESPACE)),
  ]
  const kinds = new Set<'citation' | 'note'>()
  if (values.some((value) => ['bibliography', 'biblioref', 'doc-bibliography', 'doc-biblioref'].includes(value)))
    kinds.add('citation')
  if (
    values.some((value) =>
      [
        'doc-endnote',
        'doc-footnote',
        'doc-noteref',
        'endnote',
        'footnote',
        'noteref',
      ].includes(value),
    )
  )
    kinds.add('note')
  return kinds
}

function elementVisibleText(element: XmlElement): string {
  let value = ''
  const visit = (current: XmlElement, hidden: boolean): void => {
    const nextHidden = hidden || isHiddenElement(current)
    if (
      current.namespaceUri === XHTML_NAMESPACE &&
      nonRenderedElements.has(current.localName)
    )
      return
    for (const child of current.children) {
      if (child.type === 'text') {
        if (!nextHidden) value += child.value
      } else visit(child, nextHidden)
    }
  }
  visit(element, false)
  return value
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicateSet = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicateSet.add(value)
    else seen.add(value)
  }
  return [...duplicateSet]
}

export function inspectXhtml(
  source: string | Uint8Array,
  limitOverrides?: Partial<XmlTraversalLimits>,
): XhtmlSemantics {
  const document = parseXmlDocument(source, limitOverrides)
  const root = document.root
  if (
    root.namespaceUri !== XHTML_NAMESPACE ||
    root.localName !== 'html'
  )
    throw new XmlHelperError('XML_DOCUMENT')
  const body = oneDirectChild(root, XHTML_NAMESPACE, 'body')
  const elements = xmlElements(root)
  const ids: string[] = []
  const hrefs: XmlAttributeReference[] = []
  const namespacedHrefs: XmlAttributeReference[] = []
  const srcs: XmlAttributeReference[] = []
  const roles: XhtmlSemantics['roles'] = []
  const epubTypes: XhtmlSemantics['epubTypes'] = []
  const ariaReferences: XhtmlSemantics['ariaReferences'] = []
  for (const element of elements) {
    const id = xmlAttribute(element, 'id') ?? xmlAttribute(element, 'id', XML_NAMESPACE)
    if (id !== undefined) ids.push(id)
    const roleTokens = tokensAttribute(xmlAttribute(element, 'role'))
    if (roleTokens.length > 0)
      roles.push({
        elementName: element.localName,
        ...(id === undefined ? {} : { id }),
        tokens: roleTokens,
      })
    const typeTokens = tokensAttribute(xmlAttribute(element, 'type', EPUB_NAMESPACE))
    if (typeTokens.length > 0)
      epubTypes.push({
        elementName: element.localName,
        ...(id === undefined ? {} : { id }),
        tokens: typeTokens,
      })
    for (const attribute of element.attributes) {
      const reference = {
        attributeName: attribute.qualifiedName,
        ...(id === undefined ? {} : { elementId: id }),
        elementName: element.localName,
        namespaceUri: attribute.namespaceUri,
        value: attribute.value,
      }
      if (attribute.localName === 'href') {
        if (attribute.namespaceUri === null) hrefs.push(reference)
        else if (attribute.namespaceUri !== XMLNS_NAMESPACE)
          namespacedHrefs.push(reference)
      }
      if (attribute.localName === 'src' && attribute.namespaceUri === null)
        srcs.push(reference)
      if (
        attribute.namespaceUri === null &&
        ariaReferenceAttributes.has(attribute.localName)
      )
        ariaReferences.push({
          attributeName: attribute.localName,
          ...(id === undefined ? {} : { sourceId: id }),
          targetIds: tokensAttribute(attribute.value),
        })
    }
  }

  const visibleTextSegments: string[] = []
  const semanticTextRuns: XhtmlTextRun[] = []
  const traverseText = (
    element: XmlElement,
    hidden: boolean,
    focusable: boolean,
    inheritedKinds: ReadonlySet<'citation' | 'note'>,
  ): void => {
    if (
      element.namespaceUri === XHTML_NAMESPACE &&
      nonRenderedElements.has(element.localName)
    )
      return
    const nextHidden = hidden || isHiddenElement(element)
    const nextFocusable = focusable || isFocusableElement(element)
    const nextKinds = new Set(inheritedKinds)
    for (const kind of semanticKinds(element)) nextKinds.add(kind)
    for (const child of element.children) {
      if (child.type === 'text') {
        if (!nextHidden) visibleTextSegments.push(child.value)
        const textTokens = xmlTextTokens(child.value)
        if (textTokens.length > 0)
          for (const kind of nextKinds)
            semanticTextRuns.push({
              focusable: nextFocusable,
              hidden: nextHidden,
              kind,
              tokens: textTokens,
              value: child.value,
            })
      } else traverseText(child, nextHidden, nextFocusable, nextKinds)
    }
  }
  traverseText(body, false, false, new Set())

  const bodyElements = xmlElements(body)
  const headings = bodyElements
    .filter(
      (element) =>
        element.namespaceUri === XHTML_NAMESPACE &&
        /^h[1-6]$/u.test(element.localName),
    )
    .map((element) => {
      const id = xmlAttribute(element, 'id')
      const text = elementVisibleText(element)
      return {
        ...(id === undefined ? {} : { id }),
        level: Number(element.localName.slice(1)),
        text,
        textTokens: xmlTextTokens(text),
      }
    })

  const tables = bodyElements
    .filter(
      (element) =>
        element.namespaceUri === XHTML_NAMESPACE &&
        element.localName === 'table',
    )
    .map((table) => {
      const tableId = xmlAttribute(table, 'id')
      const captions = directChildren(table, XHTML_NAMESPACE, 'caption').map(
        (caption) => {
          const id = xmlAttribute(caption, 'id')
          return {
            ...(id === undefined ? {} : { id }),
            text: elementVisibleText(caption),
          }
        },
      )
      const cells: XhtmlSemantics['tables'][number]['cells'] = []
      const visitCells = (element: XmlElement): void => {
        for (const child of childElements(element)) {
          if (
            child !== table &&
            child.namespaceUri === XHTML_NAMESPACE &&
            child.localName === 'table'
          )
            continue
          if (
            child.namespaceUri === XHTML_NAMESPACE &&
            (child.localName === 'td' || child.localName === 'th')
          ) {
            const id = xmlAttribute(child, 'id')
            const scope = xmlAttribute(child, 'scope')
            cells.push({
              headers: tokensAttribute(xmlAttribute(child, 'headers')),
              ...(id === undefined ? {} : { id }),
              kind: child.localName,
              ...(scope === undefined ? {} : { scope }),
              text: elementVisibleText(child),
            })
          }
          visitCells(child)
        }
      }
      visitCells(table)
      const ariaLabel = xmlAttribute(table, 'aria-label')
      return {
        ...(ariaLabel === undefined ? {} : { ariaLabel }),
        ariaLabelledBy: tokensAttribute(xmlAttribute(table, 'aria-labelledby')),
        captions,
        cells,
        ...(tableId === undefined ? {} : { id: tableId }),
      }
    })

  const htmlLanguage = xmlAttribute(root, 'lang')
  const xmlLanguage = xmlAttribute(root, 'lang', XML_NAMESPACE)
  const rootDirection = xmlAttribute(root, 'dir')
  return {
    ariaReferences,
    document,
    duplicateIds: duplicates(ids),
    epubTypes,
    headings,
    hrefs,
    ids,
    namespacedHrefs,
    roles,
    ...(rootDirection === undefined ? {} : { rootDirection }),
    rootLanguage: {
      ...(htmlLanguage === undefined ? {} : { html: htmlLanguage }),
      ...(xmlLanguage === undefined ? {} : { xml: xmlLanguage }),
    },
    semanticTextRuns,
    srcs,
    tables,
    visibleTextSegments,
    visibleTextTokens: visibleTextSegments.flatMap(xmlTextTokens),
  }
}

export type OpfSemantics = {
  document: XmlDocument
  language?: string
  manifest: Array<{
    fallback?: string
    href?: string
    id?: string
    mediaOverlay?: string
    mediaType?: string
    properties: string[]
  }>
  metadata: Array<{
    id?: string
    localName: string
    namespaceUri: string | null
    property?: string
    refines?: string
    value: string
  }>
  spine: {
    items: Array<{
      idref?: string
      linear?: string
      properties: string[]
    }>
    pageProgressionDirection?: string
    toc?: string
  }
  uniqueIdentifier?: string
  version?: string
}

export function inspectOpf(
  source: string | Uint8Array,
  limitOverrides?: Partial<XmlTraversalLimits>,
): OpfSemantics {
  const document = parseXmlDocument(source, limitOverrides)
  const root = document.root
  if (root.namespaceUri !== OPF_NAMESPACE || root.localName !== 'package')
    throw new XmlHelperError('XML_DOCUMENT')
  const metadataElement = oneDirectChild(root, OPF_NAMESPACE, 'metadata')
  const manifestElement = oneDirectChild(root, OPF_NAMESPACE, 'manifest')
  const spineElement = oneDirectChild(root, OPF_NAMESPACE, 'spine')
  const metadata = childElements(metadataElement).map((element) => {
    const id = xmlAttribute(element, 'id')
    const property = xmlAttribute(element, 'property')
    const refines = xmlAttribute(element, 'refines')
    return {
      ...(id === undefined ? {} : { id }),
      localName: element.localName,
      namespaceUri: element.namespaceUri,
      ...(property === undefined ? {} : { property }),
      ...(refines === undefined ? {} : { refines }),
      value: xmlElementText(element),
    }
  })
  const manifest = directChildren(manifestElement, OPF_NAMESPACE, 'item').map(
    (item) => {
      const fallback = xmlAttribute(item, 'fallback')
      const href = xmlAttribute(item, 'href')
      const id = xmlAttribute(item, 'id')
      const mediaOverlay = xmlAttribute(item, 'media-overlay')
      const mediaType = xmlAttribute(item, 'media-type')
      return {
        ...(fallback === undefined ? {} : { fallback }),
        ...(href === undefined ? {} : { href }),
        ...(id === undefined ? {} : { id }),
        ...(mediaOverlay === undefined ? {} : { mediaOverlay }),
        ...(mediaType === undefined ? {} : { mediaType }),
        properties: tokensAttribute(xmlAttribute(item, 'properties')),
      }
    },
  )
  const spineItems = directChildren(spineElement, OPF_NAMESPACE, 'itemref').map(
    (item) => {
      const idref = xmlAttribute(item, 'idref')
      const linear = xmlAttribute(item, 'linear')
      return {
        ...(idref === undefined ? {} : { idref }),
        ...(linear === undefined ? {} : { linear }),
        properties: tokensAttribute(xmlAttribute(item, 'properties')),
      }
    },
  )
  const language = xmlAttribute(root, 'lang', XML_NAMESPACE)
  const pageProgressionDirection = xmlAttribute(
    spineElement,
    'page-progression-direction',
  )
  const toc = xmlAttribute(spineElement, 'toc')
  const uniqueIdentifier = xmlAttribute(root, 'unique-identifier')
  const version = xmlAttribute(root, 'version')
  return {
    document,
    ...(language === undefined ? {} : { language }),
    manifest,
    metadata,
    spine: {
      items: spineItems,
      ...(pageProgressionDirection === undefined
        ? {}
        : { pageProgressionDirection }),
      ...(toc === undefined ? {} : { toc }),
    },
    ...(uniqueIdentifier === undefined ? {} : { uniqueIdentifier }),
    ...(version === undefined ? {} : { version }),
  }
}

export type NavigationItem = {
  children: NavigationItem[]
  href: string | null
  label: string
  labelTokens: string[]
}

export type NavigationSemantics = {
  document: XhtmlSemantics
  tocs: Array<{
    ariaLabel?: string
    items: NavigationItem[]
  }>
}

function directFirst(
  element: XmlElement,
  namespaceUri: string,
  localNames: readonly string[],
): XmlElement | undefined {
  return childElements(element).find(
    (child) =>
      child.namespaceUri === namespaceUri &&
      localNames.includes(child.localName),
  )
}

function navigationItems(list: XmlElement): NavigationItem[] {
  return directChildren(list, XHTML_NAMESPACE, 'li').map((item) => {
    const labelElement = directFirst(item, XHTML_NAMESPACE, ['a', 'span'])
    const nestedList = directFirst(item, XHTML_NAMESPACE, ['ol'])
    const label = labelElement ? elementVisibleText(labelElement) : ''
    return {
      children: nestedList ? navigationItems(nestedList) : [],
      href:
        labelElement?.localName === 'a'
          ? (xmlAttribute(labelElement, 'href') ?? null)
          : null,
      label,
      labelTokens: xmlTextTokens(label),
    }
  })
}

export function inspectNavigation(
  source: string | Uint8Array,
  limitOverrides?: Partial<XmlTraversalLimits>,
): NavigationSemantics {
  const document = inspectXhtml(source, limitOverrides)
  const navigations = xmlElements(document.document.root).filter(
    (element) =>
      element.namespaceUri === XHTML_NAMESPACE && element.localName === 'nav',
  )
  const tocs = navigations
    .filter((navigation) =>
      tokensAttribute(xmlAttribute(navigation, 'type', EPUB_NAMESPACE)).includes(
        'toc',
      ),
    )
    .map((navigation) => {
      const ariaLabel = xmlAttribute(navigation, 'aria-label')
      const list = directFirst(navigation, XHTML_NAMESPACE, ['ol'])
      return {
        ...(ariaLabel === undefined ? {} : { ariaLabel }),
        items: list ? navigationItems(list) : [],
      }
    })
  return { document, tocs }
}
