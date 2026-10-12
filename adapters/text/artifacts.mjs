import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./publish_directory.py', import.meta.url))
function publish(stage, out) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]))
    execFile('python3', ['-I', '-S', helper, stage, out],
      { env, timeout: 10_000, maxBuffer: 8192 }, (error, stdout) => {
        let result
        try { result = JSON.parse(stdout) } catch {}
        if (!error && result?.ok === true) return resolve()
        const failure = new Error('atomic output publication failed; destination preserved (requires Python 3 and a supported local filesystem)')
        if (result?.ok === false && /^[A-Z][A-Z0-9_]{1,30}$/.test(result.code)) failure.code = result.code
        reject(failure)
      })
  })
}

/** Publish a completed directory with the OS atomic no-replace operation. */
export async function saveNewDirectory(out, files) {
  for (const name of files.keys()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
      throw new Error('invalid output filename')
  }
  await mkdir(dirname(out), { recursive: true })
  const stage = await mkdtemp(join(dirname(out), '.struct-text-'))
  try {
    for (const [name, bytes] of files)
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o600 })
    await publish(stage, out)
  } finally {
    // The private stage is absent after successful publication. The public
    // destination is never unlinked, replaced, or recursively cleaned up.
    await rm(stage, { recursive: true, force: true })
  }
}
