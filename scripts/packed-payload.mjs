const requiredDocuments = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'CONTRACT.md',
  'API.md',
  'MIGRATION.md',
  'API_MANIFEST.json',
]

const distFilePattern = /^dist\/.+\.(?:js|d\.ts)(?:\.map)?$/u
const distDebrisPathPattern =
  /^dist\/(?:.*\/)?(?:test|tests|__tests__|spec|specs|fixtures?|__fixtures__|mocks|__mocks__|src|source)(?:\/|\.(?:js|d\.ts)(?:\.map)?$|$)/u
const distDebrisFilePattern = /\.(?:test|spec|fixture)\.(?:js|d\.ts)(?:\.map)?$/u
const unsafeControlPattern = /[\u0000-\u001f]/u
const drivePathPattern = /^[A-Za-z]:/u

function allowedDistPath(path) {
  return (
    distFilePattern.test(path) &&
    !distDebrisPathPattern.test(path) &&
    !distDebrisFilePattern.test(path)
  )
}

function packedPath(value, label, { allowCurrentDirectory = false } = {}) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string`)
  if (unsafeControlPattern.test(value) || value.includes('\\'))
    throw new Error(`unsafe packed path: ${value}`)
  if (value.startsWith('/') || drivePathPattern.test(value))
    throw new Error(`unsafe packed path: ${value}`)

  const path = allowCurrentDirectory ? value.replace(/^\.\//u, '') : value
  const segments = path.split('/')
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '..' ||
        (!allowCurrentDirectory && segment === '.'),
    )
  )
    throw new Error(`unsafe packed path: ${value}`)
  return path
}

function exportTargets(packageJson) {
  const targets = new Set()

  function visit(value) {
    if (typeof value === 'string') {
      targets.add(value)
      return
    }
    if (value && typeof value === 'object')
      for (const nested of Object.values(value)) visit(nested)
  }

  visit(packageJson.exports)
  for (const field of ['main', 'types'])
    if (typeof packageJson[field] === 'string')
      targets.add(packageJson[field])
  return [...targets]
}

export function validatePackedPayload({ packageJson, files }) {
  if (!packageJson || typeof packageJson !== 'object')
    throw new Error('package.json metadata is required')
  if (!Array.isArray(files))
    throw new Error('npm pack file list metadata is required')

  const declared = Array.isArray(packageJson.files) ? packageJson.files : []
  const exactPaths = new Set(['package.json', ...requiredDocuments])
  const directoryPaths = new Set()

  for (const entry of declared) {
    const path = packedPath(entry, 'package.json files entry')
    if (path === 'dist') directoryPaths.add(path)
    else if (!requiredDocuments.includes(path))
      throw new Error(`unexpected package.json files entry: ${path}`)
  }

  const packed = files.map((file) =>
    packedPath(typeof file === 'string' ? file : file?.path, 'packed path'),
  )

  for (const path of packed) {
    const declaredFile = exactPaths.has(path)
    const declaredDirectory = [...directoryPaths].some(
      (directory) =>
        path.startsWith(`${directory}/`) && allowedDistPath(path),
    )
    if (!declaredFile && !declaredDirectory)
      throw new Error(`unexpected packed path: ${path}`)
  }

  const packedSet = new Set(packed)
  if (!packedSet.has('package.json'))
    throw new Error('packed payload missing required file: package.json')
  for (const document of requiredDocuments)
    if (!packedSet.has(document))
      throw new Error(`packed payload missing required document: ${document}`)

  const targets = exportTargets(packageJson)
    .map((target) =>
      packedPath(target, 'package export target', {
        allowCurrentDirectory: true,
      }),
    )
    .sort()
  for (const target of targets)
    if (!packedSet.has(target))
      throw new Error(`packed payload missing export target: ${target}`)

  return { files: [...packed].sort() }
}
