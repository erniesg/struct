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
import { canonicalBundleDocumentBytes } from '../src/bundle/canonical'
import { structReceiptDigest } from '../src/receipt'
import { sha256HexSync } from '../src/sha256'

const utf8 = (value: string) => new TextEncoder().encode(value)
const current = vectors.find((value) => value.name === 'current:envelope')!
const envelope = () => JSON.parse(current.canonical)

function createInput() {
  const document = structuredClone(envelope().document)
  document.assets[0].bytes = new Uint8Array([0, 255, 128])
  return { document }
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('unexpected acceptance')
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('unexpected acceptance')
}

describe('public embedded facade contract', () => {
  it('returns genuine handles instead of result objects', () => {
    const created = createStructBundle(createInput())
    expect(typeof created.documentSnapshot).toBe('function')
    expect(Object.hasOwn(created, 'ok')).toBe(false)
    const verified = verifyStructBundle(envelope())
    expect(typeof verified.documentSnapshot).toBe('function')
    expect(Object.hasOwn(verified, 'ok')).toBe(false)
    expect(encodeStructBundle(verified)).toBeInstanceOf(Uint8Array)
  })

  it('decodes through a promise and never throws synchronously', async () => {
    const pending = decodeStructBundle(utf8(current.canonical))
    expect(pending).toBeInstanceOf(Promise)
    const handle = await pending
    expect(handle.bundleSha256).toBe(current.sha256)

    let rejected: Promise<unknown> | undefined
    expect(() => {
      rejected = decodeStructBundle(utf8('{bad'))
    }).not.toThrow()
    expect(rejected).toBeInstanceOf(Promise)
    const error = await rejectedBy(() => rejected!)
    expect(error).toBeInstanceOf(StructBundleError)
    expect((error as StructBundleError).stage).toBe('canonical')
  })

  it('throws a static structured error that retains no caller input', () => {
    const hostile = envelope()
    hostile.document.metadata.title = 'HOSTILE-CONTENT-MARKER'
    const error = thrownBy(() => verifyStructBundle(hostile)) as StructBundleError
    expect(error).toBeInstanceOf(StructBundleError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('StructBundleError')
    expect(['input', 'digest', 'canonical', 'assets', 'handle']).toContain(error.stage)
    expect(typeof error.code).toBe('string')
    expect(error.message).not.toContain('HOSTILE-CONTENT-MARKER')
    expect(JSON.stringify({ stage: error.stage, code: error.code, message: error.message }))
      .not.toContain('HOSTILE-CONTENT-MARKER')
    expect(Object.hasOwn(error, 'input')).toBe(false)
    expect(Object.hasOwn(error, 'value')).toBe(false)
    expect(Object.hasOwn(error, 'cause')).toBe(false)
    expect(Object.isFrozen(error)).toBe(true)
  })

  it('reports a fixed stage and code taxonomy for each failure class', async () => {
    const forged = thrownBy(() => encodeStructBundle({ bundleVersion: '1.0.0' })) as StructBundleError
    expect(forged.stage).toBe('handle')
    expect(forged.code).toBe('FORGED')

    const digest = await rejectedBy(() => decodeStructBundle(utf8('{bad'), {
      expectedBundleSha256: '0'.repeat(64),
    })) as StructBundleError
    expect(digest.stage).toBe('digest')
    expect(digest.code).toBe('MISMATCH')

    const options = thrownBy(() => verifyStructBundle(envelope(), {
      expectedBundleSha256: current.sha256,
    } as never)) as StructBundleError
    expect(options.stage).toBe('input')
    expect(options.code).toBe('OPTIONS')

    const executor = thrownBy(() => verifyStructBundle(envelope(), {
      resolverExecutor: {},
    } as never)) as StructBundleError
    expect(executor.stage).toBe('input')
    expect(executor.code).toBe('OPTIONS')

    const external = envelope()
    external.assets[0].payload = {
      kind: 'external',
      resourceId: `sha256:${external.assets[0].sha256}`,
    }
    const unresolved = thrownBy(() => verifyStructBundle(external)) as StructBundleError
    expect(unresolved.stage).toBe('assets')
    expect(unresolved.code).toBe('UNRESOLVED')
  })

  it('keeps the published nesting cap at N-1/N/N+1 nested containers', () => {
    const outcome = (depth: number) => thrownBy(() => verifyStructBundle(
      JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`),
    )) as StructBundleError
    expect(outcome(127).code).toBe('TYPE')
    expect(outcome(128).code).toBe('TYPE')
    expect(outcome(129).code).toBe('LIMIT')
    expect(outcome(130).code).toBe('LIMIT')
  })

  it('enforces the profile against the accepted canonical bytes', () => {
    const base = envelope()
    const longDocument = structuredClone(base.document)
    longDocument.metadata.title = 't'.repeat(3_000_000)
    longDocument.metadata.abstract = 'a'.repeat(3_000_000)
    longDocument.receipt.generatedSha256 = structReceiptDigest(longDocument as never)
    const longEnvelope = {
      ...base,
      documentSha256: sha256HexSync(canonicalBundleDocumentBytes(longDocument)),
      document: longDocument,
      receipt: longDocument.receipt,
    }
    const fieldBytes = canonicalBundleDocumentBytes(longDocument).byteLength
    expect(fieldBytes).toBeGreaterThan(STRUCT_BUNDLE_LIMITS_PROFILE.maxFieldBytes)
    expect(fieldBytes).toBeLessThan(STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes)

    const stable = thrownBy(() => verifyStructBundle(longEnvelope)) as StructBundleError
    expect(stable.stage).toBe('canonical')
    expect(stable.code).toBe('LIMIT')

    // A caller proxy may present a different document view to each traversal.
    // The accepted bytes must still obey the published profile.
    let views = 0
    const unstable = new Proxy(longEnvelope, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        if (property !== 'document' || !descriptor || !('value' in descriptor)) {
          return descriptor
        }
        views += 1
        return { ...descriptor, value: views <= 2 ? base.document : longDocument }
      },
    })
    const bypass = thrownBy(() => verifyStructBundle(unstable)) as StructBundleError
    expect(bypass.stage).toBe('canonical')
    expect(bypass.code).toBe('LIMIT')
  })
})
