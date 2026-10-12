import { mkdir, mkdtemp, writeFile, link, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Reserve a new output directory and publish without overwriting or rollback deletion. */
export async function saveNewDirectory(out, files) {
  for (const name of files.keys()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
      throw new Error('invalid output filename')
  }
  await mkdir(dirname(out), { recursive: true })
  const stage = await mkdtemp(join(dirname(out), '.struct-text-'))
  let reserved = false
  try {
    for (const [name, bytes] of files)
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o600 })
    await mkdir(out, { mode: 0o700 })
    reserved = true
    for (const name of files.keys()) await link(join(stage, name), join(out, name))
  } catch (error) {
    // Once the directory is public, a competing writer may have changed its
    // entries or replaced the directory. Preserve everything there on failure.
    if (reserved)
      throw new Error(`publication incomplete; destination preserved for inspection: ${out}`, { cause: error })
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
