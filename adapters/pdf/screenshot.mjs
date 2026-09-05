#!/usr/bin/env node
// Raster a struct-rendered EPUB's content at a device-like viewport for
// visual evidence: `node screenshot.mjs <file.epub> --out <png> [--anchor <blockId>]
// [--profile paperPro|paperProMove] [--full] [--playwright-root <dir>]`.
//
// Unpacks the EPUB to a temporary directory and opens EPUB/content.xhtml in
// headless Chromium (Playwright from `--playwright-root`, default this
// repository, falling back to the sibling erniesg checkout). Nothing leaves
// the machine.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const HERE = dirname(fileURLToPath(import.meta.url))
// reMarkable Paper Pro: 1620×2160 device px at 229 ppi; Paper Pro Move: 954×1696 at 264 ppi
const PROFILES = {
  paperPro: { width: 1620, height: 2160, ppi: 229 },
  paperProMove: { width: 954, height: 1696, ppi: 264 },
}

function parseArguments(argv) {
  const args = { input: null, out: null, anchor: null, profile: 'paperPro', full: false, playwrightRoot: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--out') args.out = argv[++index]
    else if (value === '--anchor') args.anchor = argv[++index]
    else if (value === '--profile') args.profile = argv[++index]
    else if (value === '--full') args.full = true
    else if (value === '--playwright-root') args.playwrightRoot = argv[++index]
    else if (value.startsWith('--')) throw new Error(`unknown option ${value}`)
    else args.input = value
  }
  if (!args.input || !args.out) throw new Error('usage: screenshot.mjs <file.epub> --out <png> [--anchor <id>] [--profile paperPro] [--full]')
  if (!PROFILES[args.profile]) throw new Error(`unknown profile ${args.profile}`)
  return args
}

function loadPlaywright(root) {
  const candidates = [root, resolve(HERE, '../..'), resolve(homedir(), 'code/erniesg/erniesg')].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules/playwright/package.json'))) {
      return createRequire(join(candidate, 'package.json'))('playwright')
    }
  }
  throw new Error('playwright not found; pass --playwright-root <dir with node_modules/playwright>')
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const { chromium } = loadPlaywright(args.playwrightRoot)
  const archive = unzipSync(new Uint8Array(await readFile(args.input)))
  const directory = await mkdtemp(join(tmpdir(), 'struct-epub-'))
  try {
    for (const [name, bytes] of Object.entries(archive)) {
      const target = join(directory, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    const profile = PROFILES[args.profile]
    const scale = profile.ppi / 96
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: Math.round(profile.width / scale), height: Math.round(profile.height / scale) },
        deviceScaleFactor: scale,
      })
      await page.goto(pathToFileURL(join(directory, 'EPUB/content.xhtml')).href)
      await page.waitForLoadState('load')
      if (args.anchor) {
        const locator = page.locator(`[id="${args.anchor.replace(/"/g, '')}"]`)
        await locator.scrollIntoViewIfNeeded()
        await page.evaluate((id) => {
          const element = document.getElementById(id)
          if (element) window.scrollTo(0, Math.max(0, element.getBoundingClientRect().top + window.scrollY - 40))
        }, args.anchor)
      }
      await page.screenshot({ path: args.out, fullPage: args.full })
      process.stdout.write(`${JSON.stringify({ out: args.out, profile: args.profile, viewport: page.viewportSize(), anchor: args.anchor })}\n`)
    } finally {
      await browser.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})
