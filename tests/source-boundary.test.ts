import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const checker = fileURLToPath(
  new URL('../scripts/check-source-boundary.mjs', import.meta.url),
)

function checkFixture(name: string) {
  const root = fileURLToPath(
    new URL(`./source-boundary-fixtures/${name}/`, import.meta.url),
  )
  return spawnSync(process.execPath, [checker, '--root', root], {
    encoding: 'utf8',
  })
}

describe('source-boundary enforcement', () => {
  it('rejects document imports from renderers', () => {
    const result = checkFixture('document-imports-renderer')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/document.*renderer/i)
  })

  it('rejects strongly connected source components', () => {
    const result = checkFixture('source-cycle')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/cycle|strongly connected/i)
  })

  it('rejects a singleton source component with a self-edge', () => {
    const result = checkFixture('source-self-cycle')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/cycle|strongly connected/i)
  })
})
