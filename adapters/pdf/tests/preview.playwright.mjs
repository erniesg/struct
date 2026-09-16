#!/usr/bin/env node
// The preview, driven end to end in a real browser.
//
//   node preview.playwright.mjs [--playwright-root <dir with node_modules/playwright>]
//                               [--struct-dir <erniesg/struct checkout>]
//                               [--shots <dir>] [--keep]
//                               [--base <url> --job <id>]   # drive a running service
//
// With no --base it builds a fixture job (preview-fixture.mjs: a two-page PDF
// and a five-block draft, no Docling) and starts its own uvicorn on a free
// loopback port. With --base and --job it drives a service that is already
// running, which is how a deployment is smoke-tested against a job that
// finished before the deployment; the token then comes from PDF2EPUB_TOKEN in
// this process's environment and is never put on a command line.
//
// What it asserts, in the order the issue asks for it:
//   1. both panes render;
//   2. changing the font size and the device preset reflows the rendition
//      with no network request at all;
//   3. selecting a paragraph moves the PDF pane to that paragraph's source
//      page and outlines its evidence box;
//   4. a PDF page control moves the rendition to the first block from there;
//   5. exporting with the chosen settings passes EPUBCheck with 0 errors and
//      the downloaded stylesheet carries the chosen size.
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = resolve(HERE, '..')
const REPO = resolve(ADAPTER, '../..')

function parseArguments (argv) {
  const args = { playwrightRoot: null, structDir: REPO, shots: null, base: null, job: null, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--playwright-root') args.playwrightRoot = argv[++index]
    else if (value === '--struct-dir') args.structDir = argv[++index]
    else if (value === '--shots') args.shots = argv[++index]
    else if (value === '--base') args.base = argv[++index].replace(/\/$/, '')
    else if (value === '--job') args.job = argv[++index]
    else if (value === '--keep') args.keep = true
    else throw new Error(`unknown option ${value}`)
  }
  if (Boolean(args.base) !== Boolean(args.job)) throw new Error('--base and --job go together')
  return args
}

/** The same search screenshot.mjs does. */
function loadPlaywright (root) {
  const candidates = [root, REPO, resolve(homedir(), 'code/erniesg/erniesg')].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules/playwright/package.json'))) {
      return createRequire(join(candidate, 'package.json'))('playwright')
    }
  }
  throw new Error('playwright not found; pass --playwright-root <dir with node_modules/playwright>')
}

const checks = []
function check (name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : ` — ${detail}`}\n`)
}

// --------------------------------------------------------------- a local service

function freePort () {
  // uvicorn binds it a moment later; a collision on loopback is a retry, not a
  // correctness problem, and the caller can always pass --base instead.
  return 8900 + Math.floor(Math.random() * 600)
}

function startService (structDir) {
  const data = mkdtempSync(join(tmpdir(), 'pdf2epub-preview-'))
  const built = spawnSync('node', [join(HERE, 'preview-fixture.mjs'), '--out', data, '--struct-dir', structDir], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`the fixture could not be built: ${built.stderr}`)
  const job = built.stdout.trim()
  const port = freePort()
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const python = process.env.PDF2EPUB_PYTHON || join(homedir(), '.venvs/docling/bin/python')
  const service = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(ADAPTER, 'service'),
    env: { ...process.env, PDF2EPUB_TOKEN: token, PDF2EPUB_DATA: data, PDF2EPUB_STRUCT_DIR: structDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  service.stderr.on('data', (chunk) => { if (process.env.PREVIEW_TEST_VERBOSE) process.stderr.write(chunk) })
  return { base: `http://127.0.0.1:${port}`, job, token, data, service }
}

async function waitForHealth (base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`)
      if (response.ok) return
    } catch { /* not up yet */ }
    await new Promise((resolve_) => setTimeout(resolve_, 500))
  }
  throw new Error(`${base}/health never answered`)
}

// ---------------------------------------------------------------------- the run

async function main () {
  const args = parseArguments(process.argv.slice(2))
  const { chromium } = loadPlaywright(args.playwrightRoot)
  let started = null
  let base = args.base
  let job = args.job
  let token = process.env.PDF2EPUB_TOKEN || ''
  if (!base) {
    started = startService(args.structDir)
    ;({ base, job, token } = started)
  }
  if (args.shots) mkdirSync(args.shots, { recursive: true })

  const browser = await chromium.launch()
  try {
    await waitForHealth(base)
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // The token rides as a header, so it is never in a URL, a screenshot or
      // a shell history line.
      extraHTTPHeaders: token ? { 'X-Auth-Token': token } : {},
    })
    const page = await context.newPage()
    const failures = []
    page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
    page.on('console', (message) => { if (message.type() === 'error') failures.push(`console: ${message.text()}`) })

    await page.goto(`${base}/jobs/${job}/preview`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.documentElement.dataset.previewReady === 'true', null, { timeout: 60000 })
    await page.waitForTimeout(500)

    // 1 — both panes render
    const pdfPane = await page.evaluate(() => {
      const image = document.querySelector('#page-image')
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }
    })
    check('the PDF pane shows a rendered source page', pdfPane.complete && pdfPane.width > 100, JSON.stringify(pdfPane))
    const renditionBlocks = await page.evaluate(() =>
      document.querySelector('#frame').contentDocument.querySelectorAll('[data-struct-id]').length)
    check('the rendition pane shows the EPUB body', renditionBlocks > 0, `${renditionBlocks} blocks`)
    if (args.shots) await page.screenshot({ path: join(args.shots, 'preview-default.png') })

    // 1a — the two sanitisers, exercised on the page that owns them. The
    // stylesheet one is the only place attacker-shaped text is spliced into a
    // raw-text element, and an escape that runs too early can be undone by a
    // later pass that deletes characters.
    const sanitised = await page.evaluate(() => ({
      spliced: window.sanitizeCss('<@import ;/style><img src=x onerror=alert(1)>', new Map()),
      remote: window.sanitizeCss('@import url(http://example.invalid/x.css);\nbody { color: red }', new Map()),
      unresolved: window.sanitizeCss('body { background: url(images/nope.png) }', new Map()),
      resolved: window.sanitizeCss('body { background: url(images/yes.png) }', new Map([['images/yes.png', 'blob:fake']])),
    }))
    check('the stylesheet sanitiser cannot be made to close its own element',
      !/<\/\s*style/i.test(sanitised.spliced), sanitised.spliced)
    check('a stylesheet cannot pull in a remote sheet',
      !sanitised.remote.includes('example.invalid') && sanitised.remote.includes('color: red'), sanitised.remote)
    check('a reference the page did not resolve is dropped',
      sanitised.unresolved.includes('none') && !sanitised.unresolved.includes('images/nope'), sanitised.unresolved)
    check('a reference the page did resolve becomes its blob',
      sanitised.resolved.includes('url("blob:fake")'), sanitised.resolved)

    // 2 — typography and device changes reflow with no request
    const before = await page.evaluate(() => {
      const frame = document.querySelector('#frame').contentDocument
      return { width: frame.body.getBoundingClientRect().width, size: frame.defaultView.getComputedStyle(frame.body).fontSize }
    })
    const requests = []
    const record = (request) => requests.push(request.url())
    page.on('request', record)
    await page.$eval('#font-size', (element) => {
      element.value = '24'
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.selectOption('#device', 'paperProMove')
    await page.waitForTimeout(1200)
    page.off('request', record)
    const after = await page.evaluate(() => {
      const frame = document.querySelector('#frame').contentDocument
      return { width: frame.body.getBoundingClientRect().width, size: frame.defaultView.getComputedStyle(frame.body).fontSize }
    })
    check('the font size reaches the rendition', after.size === '24px', `${before.size} -> ${after.size}`)
    check('the device preset resizes the rendition', after.width < before.width, `${before.width} -> ${after.width}`)
    check('no request was made to reflow', requests.length === 0, requests.join(', '))
    if (args.shots) await page.screenshot({ path: join(args.shots, 'preview-changed.png') })

    // back to a readable page for the rest
    await page.selectOption('#device', 'paperPro')
    await page.$eval('#font-size', (element) => {
      element.value = '15'
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(400)

    // 3 — selecting a paragraph moves the PDF pane to its source page
    const target = await page.evaluate(() => {
      const frame = document.querySelector('#frame').contentDocument
      const wanted = [...frame.querySelectorAll('[data-struct-id]')]
      return wanted.length ? wanted[Math.min(2, wanted.length - 1)].getAttribute('data-struct-id') : null
    })
    await page.evaluate((id) => {
      const frame = document.querySelector('#frame').contentDocument
      frame.querySelector(`[data-struct-id="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, target)
    await page.waitForTimeout(1200)
    const selection = await page.evaluate(() => ({
      label: document.querySelector('#selection').textContent,
      page: document.querySelector('#page-number').value,
      boxes: document.querySelectorAll('#evidence-layer .evidence').length,
      marked: document.querySelector('#frame').contentDocument.querySelectorAll('.struct-preview-selected').length,
    }))
    const blocks = await (await fetch(`${base}/api/jobs/${job}/blocks`, { headers: token ? { 'X-Auth-Token': token } : {} })).json()
    const source = blocks.blocks.find((one) => one.id === target)
    const sourcePage = source?.boxes?.[0]?.page ?? source?.page
    check('selecting a block marks it in the rendition', selection.marked === 1, JSON.stringify(selection))
    check('the PDF pane goes to that block\'s source page', Number(selection.page) === sourcePage,
      `${selection.page} vs ${sourcePage} for ${target}`)
    check('its evidence box is outlined', selection.boxes > 0, `${selection.boxes} boxes`)
    if (args.shots) await page.screenshot({ path: join(args.shots, 'preview-selected.png') })

    // 4 — the PDF page control moves the rendition
    const jumped = await page.evaluate(async () => {
      const input = document.querySelector('#page-number')
      input.value = '2'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve_) => setTimeout(resolve_, 600))
      return {
        selected: document.querySelector('#frame').contentDocument
          .querySelector('.struct-preview-selected')?.getAttribute('data-struct-id') ?? null,
        label: document.querySelector('#selection').textContent,
      }
    })
    // the first block from page 2 a reader can see: furniture such as a running
    // head is in struct.json but deliberately left out of the rendition
    const rendered = new Set(await page.evaluate(() => [...document.querySelector('#frame').contentDocument
      .querySelectorAll('[data-struct-id]')].map((element) => element.getAttribute('data-struct-id'))))
    const firstOnPageTwo = blocks.blocks.find((one) =>
      (one.boxes?.[0]?.page ?? one.page) === 2 && rendered.has(one.id))?.id
    check('a PDF page jumps the rendition to the first block from there',
      firstOnPageTwo ? jumped.selected === firstOnPageTwo : jumped.selected !== null,
      `${jumped.selected} vs ${firstOnPageTwo}`)

    // 5 — export with the chosen settings
    await page.$eval('#font-size', (element) => {
      element.value = '21'
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.selectOption('#font', 'sans')
    await page.waitForTimeout(300)
    await page.click('#export')
    await page.waitForFunction(() => /EPUBCheck|not installed|error/i.test(document.querySelector('#export-result').textContent),
      null, { timeout: 180000 })
    const result = await page.textContent('#export-result')
    check('the export reports an EPUBCheck verdict', /EPUBCheck: 0 errors/.test(result), result)
    const href = await page.getAttribute('#export-result a', 'href')
    check('the export offers a download', Boolean(href), result)
    if (href) {
      const downloaded = await fetch(`${base}${href}`, { headers: token ? { 'X-Auth-Token': token } : {} })
      const archive = unzipSync(new Uint8Array(await downloaded.arrayBuffer()))
      const css = new TextDecoder().decode(archive['EPUB/styles.css'])
      check('the downloaded stylesheet carries the chosen size', css.includes('font-size: 21px;'), css.split('\n')[0])
      check('the downloaded stylesheet carries the chosen family', css.includes('Helvetica'), css.split('\n')[1]?.slice(0, 80))
    }
    if (args.shots) {
      await page.screenshot({ path: join(args.shots, 'preview-exported.png') })
      const narrow = await context.newPage()
      await narrow.setViewportSize({ width: 390, height: 844 })
      await narrow.goto(`${base}/jobs/${job}/preview`, { waitUntil: 'load' })
      await narrow.waitForFunction(() => document.documentElement.dataset.previewReady === 'true', null, { timeout: 60000 })
      await narrow.waitForTimeout(800)
      await narrow.screenshot({ path: join(args.shots, 'preview-390.png'), fullPage: true })
      await narrow.close()
    }

    check('the page logged no errors', failures.length === 0, failures.join(' | '))
  } finally {
    await browser.close()
    if (started) {
      started.service.kill('SIGTERM')
      if (!args.keep) rmSync(started.data, { recursive: true, force: true })
    }
  }

  const failed = checks.filter((one) => !one.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})
