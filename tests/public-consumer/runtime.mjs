import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const modules = {
  '.': await import('@erniesg/struct'),
  './document': await import('@erniesg/struct/document'),
  './identity': await import('@erniesg/struct/identity'),
  './ordering': await import('@erniesg/struct/ordering'),
  './receipt': await import('@erniesg/struct/receipt'),
  './recovery': await import('@erniesg/struct/recovery'),
  './renderers/xhtml': await import('@erniesg/struct/renderers/xhtml'),
  './renderers/epub': await import('@erniesg/struct/renderers/epub'),
}

const manifest = JSON.parse(
  await readFile(
    new URL(
      './node_modules/@erniesg/struct/API_MANIFEST.json',
      import.meta.url,
    ),
    'utf8',
  ),
)

assert.deepEqual(manifest.exportPaths, Object.keys(modules))
for (const [path, module] of Object.entries(modules)) {
  assert.deepEqual(Object.keys(module).sort(), manifest.runtimeExports[path])
}

for (const subpath of ['core', 'schema', 'ids', 'bundle']) {
  await assert.rejects(
    import(`@erniesg/struct/${subpath}`),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  )
}

assert.equal(
  modules['.'].decodeCompatibleStructDocument,
  modules['./document'].decodeCompatibleStructDocument,
)
assert.equal(
  manifest.deprecated.migrateStructDocument.removalDate,
  '2026-11-30',
)
