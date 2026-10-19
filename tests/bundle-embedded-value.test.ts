import { describe, expect, it } from 'vitest'
import vectors from './fixtures/bundle-canonical/vectors.json'
import {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  StructBundleError,
  createStructBundle,
  decodeStructBundle,
  encodeStructBundle,
  verifyStructBundle,
} from '../src/bundle/index'

const utf8 = (value: string) => new TextEncoder().encode(value)
const current = vectors.find((value) => value.name === 'current:envelope')!
const envelope = () => JSON.parse(current.canonical)

function createInput() {
  const document = structuredClone(envelope().document)
  document.assets[0].bytes = new Uint8Array([0, 255, 128])
  return { document }
}

function accepted<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    throw new Error(`unexpected failure: ${String(error)}`)
  }
}

function rejects(run: () => unknown, stage: string, code: string): void {
  let error: unknown
  try {
    run()
  } catch (thrown) {
    error = thrown
  }
  expect(error).toBeInstanceOf(StructBundleError)
  expect((error as StructBundleError).stage).toBe(stage)
  expect((error as StructBundleError).code).toBe(code)
}

describe('embedded Bundle creation pilot', () => {
  it('creates the exact frozen canonical envelope from a runtime document', () => {
    const bundle = accepted(() => createStructBundle(createInput()))
    expect(bundle.bundleSha256).toBe(current.sha256)
    expect(encodeStructBundle(bundle)).toEqual(utf8(current.canonical))
    expect(bundle.documentSnapshot()).toEqual(envelope().document)
  })

  it('isolates the created handle from every later input mutation', () => {
    const input = createInput()
    const bundle = accepted(() => createStructBundle(input))
    input.document.metadata.title = 'mutated'
    input.document.assets[0].sha256 = '0'.repeat(64)
    input.document.assets[0].bytes.fill(0)
    input.document.assets.push({ ...input.document.assets[0], id: 'later' })
    expect(bundle.documentSnapshot().metadata.title).toBe('Fixture')
    expect(bundle.assetIds()).toEqual(['asset-1'])
    expect(bundle.assetBytes('asset-1')).toEqual(new Uint8Array([0, 255, 128]))
    expect(encodeStructBundle(bundle)).toEqual(utf8(current.canonical))
  })

  it.each([
    ['missing bytes', (input: any) => { delete input.document.assets[0].bytes }, 'assets', 'SET'],
    ['digest mismatch', (input: any) => {
      input.document.assets[0].bytes = new Uint8Array([1, 2, 3])
    }, 'input', 'TYPE'],
  ])('fails closed on %s', (_name, mutate, stage, code) => {
    const input: any = createInput()
    mutate(input)
    rejects(() => createStructBundle(input), stage, code)
  })

  it('rejects capability-bearing and unknown create options/inputs', () => {
    rejects(
      () => createStructBundle(createInput() as never, {
        expectedBundleSha256: current.sha256,
      } as never),
      'input',
      'OPTIONS',
    )
    rejects(
      () => createStructBundle({ ...createInput(), resolverExecutor: {} } as never),
      'input',
      'TYPE',
    )
  })
})

describe('embedded Bundle in-memory value verification', () => {
  it('accepts a strict embedded value and returns a genuine handle', () => {
    const value = envelope()
    const bundle = accepted(() => verifyStructBundle(value))
    expect(bundle.bundleSha256).toBe(current.sha256)
    expect(encodeStructBundle(bundle)).toEqual(utf8(current.canonical))
    expect(bundle.documentSnapshot()).toEqual(value.document)
  })

  it('does not expose expected-digest or executor options on the value API', () => {
    for (const options of [
      { expectedBundleSha256: current.sha256 },
      { resolverExecutor: {} },
      { limitsProfile: '2.0.0' },
      { limitsProfile: '1.0.0', expectedBundleSha256: current.sha256 },
    ]) {
      rejects(() => verifyStructBundle(envelope(), options as never), 'input', 'OPTIONS')
    }
    rejects(() => verifyStructBundle(utf8(current.canonical) as never), 'canonical', 'TYPE')
  })

  it('rejects external payloads without invoking a resolver', () => {
    const value = envelope()
    value.assets[0].payload = {
      kind: 'external',
      resourceId: `sha256:${value.assets[0].sha256}`,
    }
    rejects(() => verifyStructBundle(value), 'assets', 'UNRESOLVED')
  })

  it.each([
    ['missing asset', (value: any) => { value.assets = [] }, 'assets', 'SET'],
    ['extra asset', (value: any) => {
      value.assets.push({ ...value.assets[0], id: 'asset-extra' })
    }, 'assets', 'SET'],
    ['duplicate asset', (value: any) => {
      value.assets.push(value.assets[0])
    }, 'canonical', 'TYPE'],
    ['media metadata mismatch', (value: any) => {
      value.assets[0].mediaType = 'image/png'
    }, 'assets', 'METADATA'],
    ['asset digest mismatch', (value: any) => {
      value.assets[0].sha256 = '0'.repeat(64)
    }, 'assets', 'METADATA'],
    ['noncanonical base64', (value: any) => {
      value.assets[0].payload.base64 = 'AP+A\n'
    }, 'assets', 'BASE64'],
    ['declared length mismatch', (value: any) => {
      value.assets[0].byteLength = 2
    }, 'assets', 'BASE64'],
    ['payload digest mismatch', (value: any) => {
      value.assets[0].payload.base64 = 'AAAA'
    }, 'assets', 'DIGEST'],
  ])('fails closed on %s in a value', (_name, mutate, stage, code) => {
    const value = envelope()
    mutate(value)
    rejects(() => verifyStructBundle(value), stage, code)
  })

  it.each([
    ['unknown top-level key', (value: any) => { value.extra = true }],
    ['embedded document bytes', (value: any) => {
      value.document.assets[0].bytes = 'AP+A'
    }],
    ['unknown document key', (value: any) => { value.document.extra = true }],
    ['unknown asset key', (value: any) => { value.assets[0].extra = true }],
    ['unequal outer receipt', (value: any) => {
      value.receipt = JSON.parse(
        vectors.find((entry) => entry.name === 'current-title:envelope')!.canonical,
      ).receipt
    }],
    ['wrong media type', (value: any) => {
      value.mediaType = 'application/json'
    }],
    ['wrong bundle version', (value: any) => { value.bundleVersion = '2.0.0' }],
    ['wrong document digest', (value: any) => {
      value.documentSha256 = '0'.repeat(64)
    }],
  ])('fails closed on %s in a value', (_name, mutate) => {
    const value = envelope()
    mutate(value)
    rejects(() => verifyStructBundle(value), 'canonical', 'TYPE')
  })

  it('rejects hostile in-memory objects without invoking accessors', () => {
    const getter = () => { throw new Error('must not execute') }
    const value = envelope()
    const hostile = Object.defineProperty(value, 'document', {
      enumerable: true,
      get: getter,
    })
    rejects(() => verifyStructBundle(hostile), 'canonical', 'TYPE')

    const cycle: any = envelope()
    cycle.document.metadata.self = cycle
    rejects(() => verifyStructBundle(cycle), 'canonical', 'TYPE')

    const surrogate = envelope()
    surrogate.document.metadata.title = '\ud800'
    rejects(() => verifyStructBundle(surrogate), 'canonical', 'TYPE')

    const unsafe = envelope()
    unsafe.document.metadata.order = Number.MAX_SAFE_INTEGER + 1
    rejects(() => verifyStructBundle(unsafe), 'canonical', 'TYPE')
  })

  it('isolates the handle from later value and returned byte mutation', () => {
    const value = envelope()
    const bundle = accepted(() => verifyStructBundle(value))
    value.document.metadata.title = 'mutated'
    value.assets[0].payload.base64 = 'AAAA'
    value.assets.push({ ...value.assets[0], id: 'later' })
    bundle.assetBytes('asset-1')!.fill(0)
    expect(bundle.documentSnapshot().metadata.title).toBe('Fixture')
    expect(bundle.assetBytes('asset-1')).toEqual(new Uint8Array([0, 255, 128]))
    expect(() => { (bundle.documentSnapshot() as any).documentId = 'changed' })
      .toThrow()
    rejects(() => encodeStructBundle({ ...bundle }), 'handle', 'FORGED')
    expect(encodeStructBundle(bundle)).toEqual(utf8(current.canonical))
  })

  it('enforces the profile string cap before semantic normalization', () => {
    const value = envelope()
    value.document.metadata.title =
      'x'.repeat(STRUCT_BUNDLE_LIMITS_PROFILE.maxStringLength + 1)
    rejects(() => verifyStructBundle(value), 'canonical', 'LIMIT')
  })

  it('keeps bytes ingress canonical even with the same embedded verifier', async () => {
    const noncanonical = current.canonical.replace(
      '"bundleVersion":"1.0.0"',
      '"bundleVersion":"1.0.0" ',
    )
    await expect(decodeStructBundle(utf8(noncanonical))).rejects.toMatchObject({
      stage: 'canonical',
      code: 'NONCANONICAL',
    })
  })
})
