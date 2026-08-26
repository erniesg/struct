import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const forbidden = [
  /from-reconstruction/iu,
  /model-consultation-receipt/iu,
  /(?:^|['"/])research(?:['"/]|$)/iu,
  /ResearchPaper/u,
  /Astro/u,
  /BookWorld/u,
  /provider/iu,
  /(?:^|['"/])study(?:['"/]|$)/iu,
]

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  }))).flat()
}

const violations = []
for (const file of await files(fileURLToPath(new URL('../src/', import.meta.url)))) {
  if (!file.endsWith('.ts')) continue
  const contents = await readFile(file, 'utf8')
  if (forbidden.some((pattern) => pattern.test(contents))) violations.push(file)
}
if (violations.length) {
  throw new Error(`Forbidden app boundary reference: ${violations.join(', ')}`)
}
