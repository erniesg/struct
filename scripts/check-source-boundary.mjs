import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootArgument = args.indexOf('--root')
const root = resolve(
  rootArgument >= 0
    ? args[rootArgument + 1]
    : fileURLToPath(new URL('../src/', import.meta.url)),
)

const forbiddenContent = [
  /from-reconstruction/iu,
  /model-consultation-receipt/iu,
  /(?:^|['"/])research(?:['"/]|$)/iu,
  /ResearchPaper/u,
  /Astro/u,
  /BookWorld/u,
  /provider/iu,
  /(?:^|['"/])study(?:['"/]|$)/iu,
]
const applicationSegments = new Set([
  'app',
  'application',
  'provider',
  'providers',
  'release',
  'releases',
  'storage',
  'test',
  'tests',
  'transport',
  'transports',
  'ui',
])
const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      }),
    )
  ).flat()
}

async function existing(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function resolveImport(source, specifier) {
  if (!specifier.startsWith('.')) return null
  const candidate = resolve(dirname(source), specifier)
  for (const path of [
    candidate,
    `${candidate}.ts`,
    join(candidate, 'index.ts'),
  ])
    if (extname(path) === '.ts' && (await existing(path))) return path
  return null
}

function segments(path) {
  return relative(root, path).split(sep).map((segment) => segment.toLowerCase())
}

function stronglyConnectedComponents(graph) {
  let index = 0
  const indexes = new Map()
  const lowLinks = new Map()
  const active = []
  const onStack = new Set()
  const components = []

  function visit(node) {
    indexes.set(node, index)
    lowLinks.set(node, index)
    index += 1
    active.push(node)
    onStack.add(node)
    for (const target of graph.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target)
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)))
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return
    const component = []
    let member
    do {
      member = active.pop()
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    components.push(component)
  }

  for (const node of graph.keys()) if (!indexes.has(node)) visit(node)
  return components
}

const sourceFiles = (await files(root)).filter((file) => file.endsWith('.ts'))
const sourceSet = new Set(sourceFiles)
const graph = new Map(sourceFiles.map((file) => [file, new Set()]))
const violations = []

for (const file of sourceFiles) {
  const contents = await readFile(file, 'utf8')
  if (forbiddenContent.some((pattern) => pattern.test(contents)))
    violations.push(
      `forbidden application boundary reference in ${relative(root, file)}`,
    )
  const sourceSegments = segments(file)
  const sourceIsDocument = sourceSegments.includes('document')
  const sourceIsRenderer = sourceSegments.includes('renderers')
  for (const match of contents.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2]
    const target = await resolveImport(file, specifier)
    if (target && sourceSet.has(target)) graph.get(file).add(target)
    const targetSegments = target
      ? segments(target)
      : specifier.split('/').map((segment) => segment.toLowerCase())
    if (
      sourceIsDocument &&
      (targetSegments.includes('renderers') ||
        targetSegments.some((segment) => applicationSegments.has(segment)))
    )
      violations.push(
        `document import crosses renderer/application boundary: ${relative(root, file)} -> ${specifier}`,
      )
    if (
      sourceIsRenderer &&
      targetSegments.some((segment) => applicationSegments.has(segment))
    )
      violations.push(
        `renderer import crosses application boundary: ${relative(root, file)} -> ${specifier}`,
      )
  }
}

for (const component of stronglyConnectedComponents(graph))
  if (
    component.length > 1 ||
    (component.length === 1 && graph.get(component[0])?.has(component[0]))
  )
    violations.push(
      `strongly connected source cycle: ${component
        .map((file) => relative(root, file))
        .sort()
        .join(' -> ')}`,
    )

if (violations.length) throw new Error(violations.sort().join('\n'))
