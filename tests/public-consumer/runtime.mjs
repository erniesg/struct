import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

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
// Every private module path must fail closed in the INSTALLED artifact, not
// only the three the public manifest lists. This is the committed backing for
// the nine-subpath matrix in docs/s04-release-matrix-2026-10-20.md.
const PRIVATE_MODULE_PATHS = [
  './core',
  './schema',
  './ids',
  './parsers',
  './sha256',
  './renderers',
  './bundle/canonical',
  './bundle/external',
  './bundle/facade',
]
for (const path of PRIVATE_MODULE_PATHS) {
  assert.equal(
    availablePaths.has(path),
    false,
    `${path} cannot be exported`,
  )
  await assert.rejects(
    import(`${manifest.packageName}/${path.slice(2)}`),
    (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    `${path} must fail closed in the installed artifact`,
  )
}
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

// The manifest-declared error type must be a real public class in the
// installed artifact, not merely a name in the export map.
assert.equal(typeof bundleModule.StructBundleError, 'function')
const bundleError = new bundleModule.StructBundleError('handle', 'FORGED')
assert.ok(bundleError instanceof Error)
assert.ok(bundleError instanceof bundleModule.StructBundleError)
assert.equal(bundleError.name, 'StructBundleError')
assert.equal(bundleError.stage, 'handle')
assert.equal(bundleError.code, 'FORGED')

// ---------------------------------------------------------------------------
// S-04 Bundle acceptance matrix against the installed packed artifact.
//
// Everything below runs INSIDE the temporary consumer, against the INSTALLED
// tarball, never against the producer source tree. It pins the packed
// `./bundle` acceptance surface: the exact public surface, the frozen limits
// profile, the create -> encode -> decode round trip, the version axis, the
// error hygiene of every rejection, the payload guards, the forged-handle
// guard, and the promise-only contract of the decode seam.
//
// The measured values are written to `bundle-acceptance.json` next to this
// file so that `scripts/test-packed-consumer.mjs` can fold them into the
// summary it prints, and so that a committed test can assert them.
// ---------------------------------------------------------------------------

/** The exact runtime exports the packed `./bundle` surface must publish. */
const BUNDLE_RUNTIME_EXPORTS = [
  'STRUCT_BUNDLE_LIMITS_PROFILE',
  'STRUCT_BUNDLE_LIMITS_PROFILE_VERSION',
  'StructBundleError',
  'createStructBundle',
  'decodeStructBundle',
  'encodeStructBundle',
  'verifyStructBundle',
]

/** The frozen public limits profile, spelled out value by value. */
const EXPECTED_LIMITS_PROFILE = {
  profileVersion: '1.0.0',
  maxRawBytes: 8388608,
  maxFieldBytes: 5600000,
  maxAssets: 256,
  maxAssetBytes: 4194304,
  maxTotalBytes: 4194304,
  maxDecodedBytes: 4194304,
  maxBase64Chars: 5592408,
  maxConcurrency: 1,
  maxDepth: 128,
  maxStringLength: 5592408,
  maxNodes: 1000000,
  maxResolverTimeoutMs: 120000,
}

/** The only own property names a public rejection may carry. */
const ERROR_OWN_PROPERTIES = ['code', 'message', 'name', 'stack', 'stage']

/**
 * The caller-supplied marker that must never reach an error object.
 *
 * The marker lives in the identity of the fixture document's asset, so every
 * rejected envelope derived from that document carries it.
 */
const MARKER = 's04-packed-marker-7c1f9ab2'

// (a) PUBLIC SURFACE: exactly the seven runtime exports, nothing else.
assert.deepEqual(
  Object.keys(bundleModule).sort(),
  BUNDLE_RUNTIME_EXPORTS,
  'the packed ./bundle surface must publish exactly the seven runtime exports',
)

// (b) PROFILE VALUES: the frozen profile, spelled out value by value.
assert.deepEqual(
  bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE,
  EXPECTED_LIMITS_PROFILE,
)
assert.equal(bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE_VERSION, '1.0.0')
assert.ok(Object.isFrozen(bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE))

/**
 * Canonical JSON text of one strict JSON value.
 *
 * The package's canonical form sorts object keys by code unit and spells
 * strings and numbers with `JSON.stringify`. The runtime reimplements that
 * form so it can derive a mutated canonical wire envelope from the bytes the
 * package itself produced; the two assertions below prove that the
 * reimplementation agrees with the package on the real envelope and that it
 * reproduces the package's own document digest.
 */
function canonicalText(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalText(value[key])}`)
    .join(',')}}`
}

const canonicalBytes = (value) =>
  new TextEncoder().encode(canonicalText(value))

const sha256Hex = (bytes) =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * Every rejection this runtime observed.
 *
 * The list is the measured evidence for the error-hygiene summary below: the
 * own property names and the marker check are computed from the rejections
 * themselves, not from the expectations.
 */
const rejections = []

/**
 * Runs one public entry point and returns the failure it produced.
 *
 * A call that returns a value instead of failing is a test failure: no entry
 * point may publish a handle on a rejected input.
 */
async function captureFailure(run) {
  let value
  try {
    value = run()
  } catch (error) {
    rejections.push(error)
    return error
  }
  if (value instanceof Promise) {
    try {
      await value
    } catch (error) {
      rejections.push(error)
      return error
    }
  }
  throw new Error('unexpected acceptance: a handle was returned')
}

/**
 * Asserts that a failure carries only static facts.
 *
 * Every rejection must be a `StructBundleError`, must be frozen, must not
 * carry a `cause`, must expose no own property outside the fixed set, and
 * must not echo the caller-supplied marker in its message, in its JSON
 * serialization, or in its stack.
 */
function assertStaticHygiene(error) {
  assert.ok(error instanceof Error, 'a rejection must be an Error')
  assert.ok(
    error instanceof bundleModule.StructBundleError,
    'a rejection must be a StructBundleError',
  )
  assert.equal(error.name, 'StructBundleError')
  assert.ok(Object.isFrozen(error), 'a rejection must be frozen')
  assert.equal(
    Object.hasOwn(error, 'cause'),
    false,
    'a rejection must not carry a cause',
  )
  for (const key of Object.getOwnPropertyNames(error)) {
    assert.ok(
      ERROR_OWN_PROPERTIES.includes(key),
      `a rejection must not expose the own property ${key}`,
    )
    assert.ok(
      !String(error[key]).includes(MARKER),
      `a rejection leaked the marker in ${key}`,
    )
  }
  assert.ok(!error.message.includes(MARKER))
  assert.ok(!JSON.stringify(error).includes(MARKER))
  assert.ok(!String(error.stack).includes(MARKER))
}

/** Asserts the stage, the code, and the static shape of one rejection. */
function assertStaticFailure(error, stage, code) {
  assertStaticHygiene(error)
  assert.equal(error.stage, stage)
  assert.equal(error.code, code)
}

/** The measured stage and code of one rejection. */
function failureFacts(error) {
  return { stage: error.stage, code: error.code }
}

// (c) CREATE -> ENCODE -> DECODE round trip on a minimal embedded document.
//
// The fixture document is a frozen current-schema (0.2.0) document with one
// embedded asset whose bytes travel as a base64 carrier.
const fixtureDocument = JSON.parse(
  await readFile(new URL('./document.json', import.meta.url), 'utf8'),
)
assert.equal(fixtureDocument.schemaVersion, '0.2.0')
assert.ok(
  fixtureDocument.assets.some((asset) => typeof asset.bytes === 'string'),
  'the fixture document must carry an embedded asset',
)
assert.ok(
  JSON.stringify(fixtureDocument).includes(MARKER),
  'the fixture document must carry the caller-supplied marker',
)

const handle = bundleModule.createStructBundle({ document: fixtureDocument })
assert.match(handle.documentSha256, /^[0-9a-f]{64}$/u)
assert.match(handle.bundleSha256, /^[0-9a-f]{64}$/u)
assert.equal(typeof handle.documentSnapshot, 'function')
assert.equal(typeof handle.assetIds, 'function')
assert.equal(typeof handle.assetBytes, 'function')

const encoded = bundleModule.encodeStructBundle(handle)
assert.ok(encoded instanceof Uint8Array)
assert.ok(encoded.byteLength > 0)

const decoded = await bundleModule.decodeStructBundle(encoded, {
  expectedBundleSha256: handle.bundleSha256,
})
assert.equal(decoded.documentSha256, handle.documentSha256)
assert.equal(decoded.bundleSha256, handle.bundleSha256)
assert.deepEqual([...decoded.assetIds()], [...handle.assetIds()])

const assetId = handle.assetIds()[0]
assert.ok(assetId, 'the fixture document must publish one asset id')
const originalAsset = handle.assetBytes(assetId)
const decodedAsset = decoded.assetBytes(assetId)
assert.ok(originalAsset instanceof Uint8Array)
assert.ok(decodedAsset instanceof Uint8Array)
assert.equal(decodedAsset.byteLength, originalAsset.byteLength)
assert.deepEqual(
  Array.from(decodedAsset),
  Array.from(originalAsset),
  'the asset bytes must survive the round trip byte for byte',
)

// The snapshot is the byte-free document projection: no asset byte carrier.
const snapshot = decoded.documentSnapshot()
assert.equal(snapshot.schemaVersion, '0.2.0')
for (const asset of snapshot.assets) {
  assert.equal(
    Object.hasOwn(asset, 'bytes'),
    false,
    'the document snapshot must not carry the asset byte carrier',
  )
}

// The canonical envelope of the encoded bundle, as the package spelled it.
const canonicalEnvelopeText = new TextDecoder().decode(encoded)
const canonicalEnvelope = JSON.parse(canonicalEnvelopeText)
assert.equal(
  canonicalText(canonicalEnvelope),
  canonicalEnvelopeText,
  'the runtime canonical form must agree with the package canonical form',
)
assert.equal(
  sha256Hex(canonicalBytes(canonicalEnvelope.document)),
  canonicalEnvelope.documentSha256,
  'the runtime canonical form must reproduce the package document digest',
)

/** A deep copy of the canonical envelope with one mutation applied. */
function mutatedEnvelope(mutate) {
  const envelope = JSON.parse(canonicalEnvelopeText)
  mutate(envelope)
  return envelope
}

// (d) VERSION AXIS.
//
// The accepted envelope carries bundleVersion "1.0.0" and schemaVersion
// "0.2.0"; every other version spelling is refused at stage `canonical` with
// code `TYPE`. The same refusals are checked on the in-memory value seam
// (`verifyStructBundle`) and on the wire seam (`decodeStructBundle`).
const versionAxis = {}

const acceptedEnvelope = mutatedEnvelope(() => {})
const acceptedHandle = bundleModule.verifyStructBundle(acceptedEnvelope)
assert.equal(acceptedHandle.bundleVersion, '1.0.0')
assert.equal(acceptedHandle.schemaVersion, '0.2.0')
versionAxis.accepted = {
  bundleVersion: acceptedHandle.bundleVersion,
  schemaVersion: acceptedHandle.schemaVersion,
  accepted: true,
}

const versionCases = [
  ['bundleVersion2.0.0', (envelope) => { envelope.bundleVersion = '2.0.0' }],
  ['bundleVersionNotAString', (envelope) => { envelope.bundleVersion = 2 }],
  ['schemaVersion0.9.9', (envelope) => { envelope.schemaVersion = '0.9.9' }],
  ['schemaVersionNotAString', (envelope) => { envelope.schemaVersion = 2 }],
]

for (const [name, mutate] of versionCases) {
  const envelope = mutatedEnvelope(mutate)
  const verifyError = await captureFailure(() =>
    bundleModule.verifyStructBundle(envelope),
  )
  assertStaticFailure(verifyError, 'canonical', 'TYPE')
  const wire = canonicalBytes(envelope)
  assert.equal(
    canonicalText(JSON.parse(new TextDecoder().decode(wire))),
    new TextDecoder().decode(wire),
  )
  const decodeError = await captureFailure(() =>
    bundleModule.decodeStructBundle(wire),
  )
  assertStaticFailure(decodeError, 'canonical', 'TYPE')
  versionAxis[name] = {
    ...failureFacts(verifyError),
    verify: failureFacts(verifyError),
    decode: failureFacts(decodeError),
  }
}

// (f) PAYLOAD GUARDS.
//
// Every case is a canonical envelope whose single asset payload was tampered
// with. The refusal is checked on both public seams.
const payloadGuards = {}

const payloadCases = [
  [
    'nonCanonicalBase64',
    (envelope) => { envelope.assets[0].payload.base64 = `!!${MARKER}!!` },
    'assets',
    'BASE64',
  ],
  [
    'declaredLengthMismatch',
    (envelope) => { envelope.assets[0].byteLength += 1 },
    'assets',
    'BASE64',
  ],
  [
    'digestMismatch',
    (envelope) => { envelope.assets[0].payload.base64 = 'iVBORw0KGgoAAAAC' },
    'assets',
    'DIGEST',
  ],
  [
    'declaredByteLengthOverCap',
    (envelope) => {
      envelope.assets[0].byteLength =
        bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE.maxAssetBytes + 1
    },
    'assets',
    'LIMIT',
  ],
  [
    // The base64 payload is longer than the profile's base64 cap. The
    // profile's string cap has the same bound, and it is charged before the
    // asset caps, so this refusal lands on stage `canonical`.
    'oversizedBase64Payload',
    (envelope) => {
      const cap = bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE.maxBase64Chars
      envelope.assets[0].payload.base64 = 'A'.repeat(cap + 1)
      envelope.assets[0].byteLength = Math.floor(((cap + 1) / 4) * 3)
    },
    'canonical',
    'LIMIT',
  ],
]

for (const [name, mutate, stage, code] of payloadCases) {
  const envelope = mutatedEnvelope(mutate)
  const verifyError = await captureFailure(() =>
    bundleModule.verifyStructBundle(envelope),
  )
  assertStaticFailure(verifyError, stage, code)
  const wire = canonicalBytes(envelope)
  const decodeError = await captureFailure(() =>
    bundleModule.decodeStructBundle(wire),
  )
  assertStaticFailure(decodeError, stage, code)
  payloadGuards[name] = {
    ...failureFacts(verifyError),
    verify: failureFacts(verifyError),
    decode: failureFacts(decodeError),
  }
}

// (g) A FORGED HANDLE is refused.
const forgedError = await captureFailure(() =>
  bundleModule.encodeStructBundle({ not: 'a handle' }),
)
assertStaticFailure(forgedError, 'handle', 'FORGED')
const markedForgedError = await captureFailure(() =>
  bundleModule.encodeStructBundle({ not: 'a handle', marker: MARKER }),
)
assertStaticFailure(markedForgedError, 'handle', 'FORGED')

// (h) `decodeStructBundle` NEVER throws synchronously.
const hostileInputs = [
  ['not-bytes', 'not bytes'],
  ['empty', new Uint8Array(0)],
  ['garbage', new Uint8Array([1, 2, 3, 4])],
  ['null', null],
  ['undefined', undefined],
  ['number', 42],
  ['object', {}],
]
const decodeAsync = []
for (const [name, input] of hostileInputs) {
  let pending
  assert.doesNotThrow(() => {
    pending = bundleModule.decodeStructBundle(input)
  }, `decodeStructBundle threw synchronously for ${name}`)
  assert.equal(
    typeof pending?.then,
    'function',
    `decodeStructBundle did not return a thenable for ${name}`,
  )
  const error = await captureFailure(() => pending)
  assertStaticHygiene(error)
  decodeAsync.push({ input: name, stage: error.stage, code: error.code })
}

// The measured summary the packed-consumer script folds into its own output.
const observedErrorProperties = [
  ...new Set(rejections.flatMap((error) => Object.getOwnPropertyNames(error))),
].sort()
const markerEchoed = rejections.some((error) =>
  Object.getOwnPropertyNames(error).some((key) =>
    String(error[key]).includes(MARKER),
  ) ||
  error.message.includes(MARKER) ||
  JSON.stringify(error).includes(MARKER) ||
  String(error.stack).includes(MARKER),
)

const bundleAcceptance = {
  publicSurface: {
    exports: Object.keys(bundleModule).sort(),
    expectedExports: BUNDLE_RUNTIME_EXPORTS,
    exact: true,
  },
  profile: {
    values: bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE,
    version: bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE_VERSION,
    frozen: Object.isFrozen(bundleModule.STRUCT_BUNDLE_LIMITS_PROFILE),
  },
  roundTrip: {
    documentSha256: handle.documentSha256,
    bundleSha256: handle.bundleSha256,
    encodedBytes: encoded.byteLength,
    assetIds: [...handle.assetIds()],
    assetByteLength: originalAsset.byteLength,
    assetBytesPreserved: true,
    documentSnapshotIsByteFree: true,
  },
  versionAxis,
  errorHygiene: {
    allowedOwnProperties: ERROR_OWN_PROPERTIES,
    observedOwnProperties: observedErrorProperties,
    checkedRejections: rejections.length,
    frozen: rejections.every((error) => Object.isFrozen(error)),
    causeAbsent: rejections.every(
      (error) => Object.hasOwn(error, 'cause') === false,
    ),
    markerEchoed,
    marker: MARKER,
  },
  payloadGuards,
  forgedHandle: failureFacts(forgedError),
  decodeNeverThrowsSynchronously: {
    inputs: decodeAsync.map((entry) => entry.input),
    outcomes: decodeAsync,
    allThenable: true,
  },
}

await writeFile(
  new URL('./bundle-acceptance.json', import.meta.url),
  `${JSON.stringify(bundleAcceptance, null, 2)}\n`,
)
