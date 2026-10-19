import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageRoot = new URL('./node_modules/@erniesg/struct/', import.meta.url)

const manifest = JSON.parse(
  await readFile(new URL('API_MANIFEST.json', packageRoot), 'utf8'),
)
const installedPackage = JSON.parse(
  await readFile(new URL('package.json', packageRoot), 'utf8'),
)

assert.equal(installedPackage.name, manifest.packageName)
assert.deepEqual(
  Object.keys(installedPackage.exports).sort(),
  [...manifest.exportPaths].sort(),
  'package.json exports and API_MANIFEST exportPaths must be changed deliberately together',
)
assert.deepEqual(
  Object.keys(manifest.runtimeExports).sort(),
  [...manifest.exportPaths].sort(),
)
assert.equal(new Set(manifest.exportPaths).size, manifest.exportPaths.length)

const modules = new Map()
for (const path of manifest.exportPaths) {
  const specifier =
    path === '.'
      ? manifest.packageName
      : `${manifest.packageName}/${path.slice(2)}`
  modules.set(path, await import(specifier))
}
for (const [path, module] of modules) {
  assert.deepEqual(
    Object.keys(module).sort(),
    [...manifest.runtimeExports[path]].sort(),
  )
}

const availablePaths = new Set(manifest.exportPaths)
for (const path of manifest.unavailablePaths) {
  assert.equal(
    availablePaths.has(path),
    false,
    `${path} cannot be both exported and unavailable`,
  )
  assert.match(path, /^\.\//u)
  await assert.rejects(
    import(`${manifest.packageName}/${path.slice(2)}`),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  )
}

assert.equal(
  modules.get('.').decodeCompatibleStructDocument,
  modules.get('./document').decodeCompatibleStructDocument,
)
assert.equal(
  manifest.deprecated.migrateStructDocument.removalDate,
  '2026-11-30',
)
assert.equal('legacyStructDigest' in modules.get('./identity'), false)
assert.equal('legacyStructDigestMatches' in modules.get('./identity'), false)
assert.equal('legacyStructDigests' in modules.get('./identity'), false)

const bundleModule = modules.get('./bundle')
assert.equal(typeof bundleModule.createStructBundle, 'function')
assert.equal(typeof bundleModule.decodeStructBundle, 'function')
assert.equal(typeof bundleModule.verifyStructBundle, 'function')
assert.equal(typeof bundleModule.encodeStructBundle, 'function')
assert.equal(typeof bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE, 'object')
assert.equal(typeof bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE_VERSION, 'string')
