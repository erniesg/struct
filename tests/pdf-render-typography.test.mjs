import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FONT_STACKS,
  PROFILE_CSS,
  applyTypography,
  parseArguments,
  profileFor,
  stylesheet,
  validateTypography,
} from '../adapters/pdf/render.mjs'

// The stylesheet these four options move is baked into every EPUB the adapter
// ships, so the property that matters is not what a changed value renders but
// that an unchanged one renders nothing new: same CSS, same configuration
// digest, same bytes. Everything below is about holding that line.

const parse = (...argv) => parseArguments(['draft.json', '--out', 'out', ...argv])

describe('typography options', () => {
  it('reads the four options and leaves the rest of the command alone', () => {
    const args = parse('--font', 'sans', '--font-size', '18', '--line-height', '1.8', '--margin', '2')
    expect(args.input).toBe('draft.json')
    expect(args.out).toBe('out')
    expect(args.typography).toEqual({
      fontFamily: FONT_STACKS.sans,
      fontSizePx: 18,
      lineHeight: 1.8,
      marginEm: 2,
    })
  })

  it('takes a font by name only', () => {
    expect(validateTypography({ font: 'serif' })).toEqual({ fontFamily: FONT_STACKS.serif })
    expect(() => validateTypography({ font: 'Georgia; } body { color: red' })).toThrow(/--font must be one of/)
    expect(() => validateTypography({ font: 'cursive' })).toThrow(/--font must be one of/)
  })

  it('refuses a number outside its range and a value that is not a number', () => {
    expect(() => validateTypography({ fontSizePx: 400 })).toThrow(/between 8 and 40/)
    expect(() => validateTypography({ fontSizePx: 0 })).toThrow(/between 8 and 40/)
    expect(() => validateTypography({ lineHeight: 9 })).toThrow(/between 1 and 2.5/)
    expect(() => validateTypography({ marginEm: -1 })).toThrow(/between 0 and 6/)
    expect(() => parse('--font-size', 'huge')).toThrow(/--font-size needs a number/)
    expect(() => validateTypography({ fontSizePx: Number.NaN })).toThrow(/between 8 and 40/)
  })
})

describe('the default is not a setting', () => {
  it('contributes nothing to a profile when no option is given', () => {
    for (const id of Object.keys(PROFILE_CSS)) {
      expect(profileFor(id, {})).toEqual(profileFor(id))
      expect(applyTypography(PROFILE_CSS[id], {})).toEqual(PROFILE_CSS[id])
    }
  })

  it('contributes nothing when the options restate the profile defaults', () => {
    for (const [id, base] of Object.entries(PROFILE_CSS)) {
      const restated = validateTypography({
        font: 'default',
        fontSizePx: base.bodyPx,
        lineHeight: 1.65,
        marginEm: 0.6,
      })
      expect(applyTypography(base, restated)).toEqual(base)
      // The configuration digest is part of the EPUB's identifier, so equal
      // geometry is what makes the bytes equal.
      expect(profileFor(id, restated).configurationSha256).toBe(profileFor(id).configurationSha256)
      expect(profileFor(id, restated).css).toBe(profileFor(id).css)
    }
  })

  it('keeps the stylesheet the renderer shipped before the options existed', () => {
    const before = `html { font-size: 15px; }
body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.65; margin: 0; padding: 0 0.6em; -webkit-hyphens: auto; hyphens: auto; }`
    expect(stylesheet(PROFILE_CSS.paperPro).startsWith(before)).toBe(true)
  })
})

describe('a changed value reaches the stylesheet', () => {
  it('moves the family, the leading and the gutter', () => {
    const css = profileFor('paperPro', validateTypography({ font: 'sans', lineHeight: 2, marginEm: 1.5 })).css
    expect(css).toContain(`font-family: ${FONT_STACKS.sans};`)
    expect(css).toContain('line-height: 2;')
    expect(css).toContain('padding: 0 1.5em;')
  })

  it('carries the headings with the body size, so the hierarchy survives', () => {
    const base = PROFILE_CSS.paperPro
    const geometry = applyTypography(base, validateTypography({ fontSizePx: 30 }))
    expect(geometry.bodyPx).toBe(30)
    expect(geometry.titlePx).toBe(Math.round(base.titlePx * 2))
    expect(geometry.headingPx).toBe(Math.round(base.headingPx * 2))
    // The ratio the stylesheet prints is what a reader sees, and it holds.
    expect(profileFor('paperPro', validateTypography({ fontSizePx: 30 })).css)
      .toContain(`header h1 { font-size: ${(base.titlePx / base.bodyPx).toFixed(3)}em;`)
  })

  it('gives a changed profile a different configuration digest', () => {
    const changed = profileFor('paperPro', validateTypography({ fontSizePx: 22 }))
    expect(changed.configurationSha256).not.toBe(profileFor('paperPro').configurationSha256)
    expect(changed.fileName).toBe(PROFILE_CSS.paperPro.fileName)
  })

  it('cannot smuggle a declaration through a font stack', () => {
    for (const stack of Object.values(FONT_STACKS)) {
      expect(stack).not.toMatch(/[;{}]|url\(/)
    }
  })
})

describe('the program guard', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../adapters/pdf/render.mjs')

  // Importing this module must not run it, and invoking it must — including
  // through a symlink, which is how a deployed copy is often reached.
  it('runs when it is the program, directly or through a symlink', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'render-link-')), 'render.mjs')
    symlinkSync(script, link)
    for (const path of [script, link]) {
      const ran = spawnSync('node', [path], { encoding: 'utf8' })
      expect(ran.stderr, path).toMatch(/usage: render\.mjs/)
    }
  })
})
