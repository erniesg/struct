/**
 * Real OS binding for the resolver conformance lane.
 *
 * This module binds the *published* `StructResolverExecutorV1` and
 * `StructResolverHostSupervisorV1` ports to the sacrificial Linux user and
 * PID namespace harness, so the portable package driver
 * (`resolveStructResolverAssets`) can be exercised against a real host.
 *
 * Realm layout:
 *
 *   * the package driver, the package reference supervisor, the host slot
 *     ledger and the tombstone registry all live in this Node parent. This
 *     parent is never inside the host realm, so the lifecycle return value is
 *     always observable;
 *   * a dedicated Python OS host supervisor owns the host realms. It creates
 *     one user namespace plus PID namespace per execution, drops every
 *     capability in the host realm, and owns the pidfd, the lifetime pipe and
 *     the outer-visible namespace census;
 *   * the executor body itself is an untrusted Python process that runs as
 *     PID 1 of its own PID namespace.
 *
 * The parent talks to the executor body over a narrow line protocol carried
 * by four FIFOs. There is no ambient command API: the body understands only
 * `start`, `cleanup`, `terminate` and `revoke`, and every request is bound to
 * one reserved execution identifier.
 *
 * The revocation channel is deliberately separate from the event channel.
 * The published contract makes `revokeAndQuarantine()` synchronous, so the
 * parent has to finish one request/response round trip without depending on
 * the event loop.
 *
 * Nothing here grants transport authority. The body resolves bytes from an
 * in-memory content-addressed table and publishes an explicitly synthetic
 * `content-addressed` receipt; no socket, no filesystem locator and no store
 * is ever contacted.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

import { StructResolverProtocolError, validateStructResolverFailStopReceipt } from '../../../src/bundle/resolver-protocol'
import type {
  StructAssetResolutionRequest,
  StructAssetResolutionResult,
  StructResolverExecutorV1,
  StructResolverFailStopReason,
  StructResolverFailStopReceipt,
  StructResolverHostSupervisorV1,
  StructResolverRevocationReceipt,
  StructResolverTerminalReceipt,
} from '../../../src/bundle/resolver-protocol'
import { createStructResolverSupervisorV1 } from '../../../src/bundle/resolver-supervisor'
import type { StructResolverHostBindingV1, StructResolverSupervisor } from '../../../src/bundle/resolver-supervisor'

const here = dirname(fileURLToPath(import.meta.url))
const MANAGER = join(here, '..', 'resolver-host', 'real_host_manager.py')

/** Polling interval of the asynchronous event reader. */
const POLL_INTERVAL_MS = 2
/** Bounded wait for one FIFO write. */
const WRITE_TIMEOUT_MS = 10_000
/** Bounded wait for the synchronous revocation receipt. */
const REVOCATION_TIMEOUT_MS = 10_000
/** Bounded wait for one OS host supervisor request. */
const MANAGER_TIMEOUT_MS = 60_000

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

type FifoMessage = Record<string, unknown>

/** Reads whatever is available. Returns -1 for "nothing yet" and 0 for EOF. */
function readAvailable(fd: number, buffer: Buffer): number {
  try {
    return readSync(fd, buffer, 0, buffer.length, null)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'EAGAIN') return -1
    if (code === 'EOF') return 0
    throw error
  }
}

function writeAll(fd: number, text: string): void {
  const data = Buffer.from(text, 'utf8')
  let offset = 0
  const deadline = Date.now() + WRITE_TIMEOUT_MS
  while (offset < data.length) {
    try {
      offset += writeSync(fd, data, offset, data.length - offset)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'EAGAIN') throw error
      if (Date.now() > deadline) throw new Error('host channel write timed out')
      sleepSync(1)
    }
  }
}

/**
 * One executor-body channel.
 *
 * The event side is read asynchronously by a bounded polling loop; the
 * revocation side is read synchronously inside the parent's call.
 */
class HostChannel {
  readonly #fdIn: number
  readonly #fdOut: number
  readonly #fdRevIn: number
  readonly #fdRevOut: number
  readonly #readBuffer = Buffer.alloc(65536)
  readonly #decoder = new StringDecoder('utf8')
  readonly #revDecoder = new StringDecoder('utf8')
  #buffer = ''
  #revBuffer = ''
  #pending: FifoMessage[] = []
  #waiters: Array<{
    predicate: (message: FifoMessage) => boolean
    resolve: (message: FifoMessage) => void
    reject: (error: unknown) => void
  }> = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #eof = false
  #closed = false
  #lifecycle: Record<string, unknown> | undefined
  #ready: Record<string, unknown> | undefined

  constructor(paths: Readonly<Record<string, string>>) {
    this.#fdIn = openSync(paths.bodyIn!, fsConstants.O_RDWR | fsConstants.O_NONBLOCK)
    this.#fdOut = openSync(paths.bodyOut!, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    this.#fdRevIn = openSync(paths.revIn!, fsConstants.O_RDWR | fsConstants.O_NONBLOCK)
    this.#fdRevOut = openSync(paths.revOut!, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  }

  start(): void {
    if (this.#timer === undefined) this.#timer = setTimeout(this.#pump, 0)
  }

  #pump = (): void => {
    this.#timer = undefined
    if (this.#closed) return
    for (;;) {
      const count = readAvailable(this.#fdOut, this.#readBuffer)
      if (count < 0) break
      if (count === 0) {
        this.#eof = true
        this.#fail(new Error('host realm closed its channel'))
        break
      }
      this.#buffer += this.#decoder.write(this.#readBuffer.subarray(0, count))
      let index = this.#buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.#buffer.slice(0, index)
        this.#buffer = this.#buffer.slice(index + 1)
        if (line.trim() !== '') this.#dispatch(JSON.parse(line) as FifoMessage)
        index = this.#buffer.indexOf('\n')
      }
    }
    if (!this.#closed && !this.#eof)
      this.#timer = setTimeout(this.#pump, POLL_INTERVAL_MS)
  }

  #dispatch(message: FifoMessage): void {
    if (message.event === 'lifecycle')
      this.#lifecycle = message.stats as Record<string, unknown>
    if (message.event === 'ready') this.#ready = message
    for (let index = 0; index < this.#waiters.length; index += 1) {
      const waiter = this.#waiters[index]!
      if (!waiter.predicate(message)) continue
      this.#waiters.splice(index, 1)
      waiter.resolve(message)
      return
    }
    this.#pending.push(message)
  }

  #fail(error: unknown): void {
    const waiters = this.#waiters.splice(0, this.#waiters.length)
    for (const waiter of waiters) waiter.reject(error)
  }

  waitFor(predicate: (message: FifoMessage) => boolean): Promise<FifoMessage> {
    const index = this.#pending.findIndex(predicate)
    if (index >= 0) {
      const [message] = this.#pending.splice(index, 1)
      return Promise.resolve(message!)
    }
    if (this.#eof) return Promise.reject(new Error('host realm closed its channel'))
    return new Promise<FifoMessage>((resolve, reject) => {
      this.#waiters.push({ predicate, resolve, reject })
    })
  }

  send(message: Readonly<Record<string, unknown>>): void {
    writeAll(this.#fdIn, `${JSON.stringify(message)}\n`)
  }

  /**
   * One synchronous revocation round trip.
   *
   * The published contract makes revocation synchronous, so the parent has to
   * observe the host's own acknowledgment before it reports an accepted
   * revocation receipt.
   */
  revokeSync(executionId: string): FifoMessage {
    writeAll(this.#fdRevIn, `${JSON.stringify({ op: 'revoke', executionId })}\n`)
    const deadline = Date.now() + REVOCATION_TIMEOUT_MS
    for (;;) {
      const count = readAvailable(this.#fdRevOut, this.#readBuffer)
      if (count > 0) {
        this.#revBuffer += this.#revDecoder.write(this.#readBuffer.subarray(0, count))
        const index = this.#revBuffer.indexOf('\n')
        if (index >= 0) {
          const line = this.#revBuffer.slice(0, index)
          return JSON.parse(line) as FifoMessage
        }
        continue
      }
      if (count === 0) throw new Error('host realm closed before the revocation receipt')
      if (Date.now() > deadline) throw new Error('revocation receipt timed out')
      sleepSync(1)
    }
  }

  lifecycle(): Record<string, unknown> | undefined {
    return this.#lifecycle
  }

  ready(): Record<string, unknown> | undefined {
    return this.#ready
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#fail(new Error('host channel closed'))
    for (const fd of [this.#fdIn, this.#fdOut, this.#fdRevIn, this.#fdRevOut]) {
      try {
        closeSync(fd)
      } catch {
        // A descriptor that is already gone is not an error here.
      }
    }
  }
}

/** Narrow request/response client for the OS host supervisor. */
class ManagerClient {
  readonly #child: ChildProcess
  readonly #decoder = new StringDecoder('utf8')
  #buffer = ''
  #nextId = 1
  #pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void
    reject: (error: unknown) => void
  }>()
  #stderr = ''
  #closed = false

  constructor(rundir: string, python: string) {
    this.#child = spawn(python, [MANAGER, '--rundir', rundir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stdout?.on('data', (chunk: Buffer) => {
      this.#buffer += this.#decoder.write(chunk)
      let index = this.#buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.#buffer.slice(0, index)
        this.#buffer = this.#buffer.slice(index + 1)
        if (line.trim() !== '') this.#dispatch(JSON.parse(line) as Record<string, unknown>)
        index = this.#buffer.indexOf('\n')
      }
    })
    this.#child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.toString('utf8')
    })
    this.#child.on('error', (error) => {
      this.#fail(error)
    })
    this.#child.on('exit', (code) => {
      if (!this.#closed)
        this.#fail(new Error(`host supervisor exited with code ${code}: ${this.#stderr}`))
    })
  }

  #dispatch(message: Record<string, unknown>): void {
    const id = message.id
    if (typeof id !== 'number') return
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    pending.resolve(message)
  }

  #fail(error: unknown): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  request(
    payload: Readonly<Record<string, unknown>>,
    timeoutMs: number = MANAGER_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`host supervisor request timed out: ${String(payload.op)}`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.#child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`)
    })
  }

  stderrText(): string {
    return this.#stderr
  }

  async close(): Promise<void> {
    this.#closed = true
    try {
      this.#child.stdin?.end()
    } catch {
      // The pipe may already be gone.
    }
    this.#child.kill('SIGKILL')
  }
}

/** One outer host slot. The slot is owned by this parent, never by the host. */
type HostSlot = {
  index: number
  state: 'free' | 'held' | 'retired'
  executionId: string | undefined
  retiredReason: string | undefined
  supervisor: StructResolverSupervisor
}

export type RealHostSlotState = 'free' | 'held' | 'retired'

export type RealHostAsset = Readonly<{
  id: string
  sha256: string
  mediaType: string
  byteLength: number
}>

export type RealHostLedger = Readonly<{
  slots: ReadonlyArray<
    Readonly<{
      index: number
      state: RealHostSlotState
      executionId: string | undefined
      retiredReason: string | undefined
    }>
  >
  tombstones: Readonly<Record<string, string>>
  freeSlots: number
  heldSlots: number
  retiredSlots: number
}>

export type RealHostPoolOptions = Readonly<{
  /** Fixture behaviour of the executor body. */
  mode?: string | ((executionId: string, request: StructAssetResolutionRequest) => string)
  /** Number of outer host slots. The per-call profile concurrency stays 1. */
  slots?: number
  /** Python interpreter used for the OS host supervisor. */
  python?: string
  /** Conformance seam that forces a deterministic execution identifier. */
  executionIdSource?: () => string
}>

export type RealHostPool = Readonly<{
  executor: StructResolverExecutorV1
  hostSupervisor: StructResolverHostSupervisorV1
  /** Content-addressed fixture assets the host realm can resolve. */
  assets: readonly RealHostAsset[]
  ledger(): RealHostLedger
  failStopCalls(): readonly Readonly<{ executionId: string; reason: StructResolverFailStopReason }>[]
  /** Lifecycle counters the executor body published when it exited. */
  lifecycle(): Record<string, unknown> | undefined
  /** Identity the executor body published when its realm came up. */
  realm(): Record<string, unknown> | undefined
  /** Raw OS evidence the host supervisor produced for each fail-stop. */
  failStopProofs(): readonly Readonly<Record<string, unknown>>[]
  stderrText(): string
  /** Settles every held slot after a resolution outcome is known. */
  settle(outcome: 'completed' | 'failed'): void
  dispose(): Promise<void>
}>

/**
 * Creates a pool of real OS host slots bound to the published ports.
 *
 * The pool owns the identity mapping, the one-shot admission, the immutable
 * tombstones and the permanent retirement of an implicated capacity. The host
 * never owns any of that.
 */
export async function createRealHostPool(
  options: RealHostPoolOptions = {},
): Promise<RealHostPool> {
  const python = options.python ?? process.env.RESOLVER_HOST_PYTHON ?? 'python3'
  const slotCount = Math.max(1, options.slots ?? 1)
  const fixedMode = typeof options.mode === 'function' ? undefined : options.mode
  const modeSelector: (
    executionId: string,
    request: StructAssetResolutionRequest,
  ) => string =
    typeof options.mode === 'function'
      ? options.mode
      : (): string => fixedMode ?? 'conformant'
  const runDir = mkdtempSync(join(tmpdir(), 'resolver-real-conformance-'))
  const manager = new ManagerClient(join(runDir, 'run'), python)

  const manifest = await manager.request({ op: 'manifest' })
  const assets = (manifest.assets ?? []) as RealHostAsset[]

  const slots: HostSlot[] = []
  const tombstones = new Map<string, string>()
  const liveOwners = new Map<string, number>()
  const channels: HostChannel[] = []
  const receipts = new Map<string, StructResolverFailStopReceipt>()
  const proofs: Array<Record<string, unknown>> = []
  const failStopCalls: Array<{ executionId: string; reason: StructResolverFailStopReason }> = []

  const bindForSlot = (
    index: number,
    request: StructAssetResolutionRequest,
    executionId: string,
  ): StructResolverHostBindingV1 => {
    // One-shot admission. A tombstoned identifier and a live identifier are
    // both refused before any host realm is created.
    if (tombstones.has(executionId) || liveOwners.has(executionId))
      throw new StructResolverProtocolError('EXECUTION_ID', executionId)
    const slot = slots[index]!
    if (slot.state !== 'free')
      throw new StructResolverProtocolError('POLICY', executionId)
    slot.state = 'held'
    slot.executionId = executionId
    liveOwners.set(executionId, index)
    return createBinding(index, executionId, request)
  }

  const createBinding = (
    index: number,
    executionId: string,
    request: StructAssetResolutionRequest,
  ): StructResolverHostBindingV1 => {
    let channel: HostChannel | undefined
    const binding: StructResolverHostBindingV1 = {
      executionId,
      async start(): Promise<StructAssetResolutionResult> {
        const response = await manager.request({
          op: 'spawn',
          executionId,
          mode: modeSelector(executionId, request),
        })
        if (response.ok !== true)
          throw new Error(`host realm unavailable: ${String(response.blocker)}`)
        channel = new HostChannel(response.fifos as Record<string, string>)
        channels.push(channel)
        channel.start()
        channel.send({
          op: 'start',
          executionId,
          request: {
            protocolVersion: request.protocolVersion,
            logicalHref: request.logicalHref,
            resourceId: request.resourceId,
            expected: { ...request.expected },
            policy: request.policy,
            expectedPolicySha256: request.expectedPolicySha256,
            budget: { ...request.budget },
          },
        })
        const event = await channel.waitFor(
          (message) => message.event === 'result' || message.event === 'start-error',
        )
        if (event.event !== 'result')
          throw new Error('host realm could not resolve the content address')
        const payload = event.result as Record<string, unknown>
        // The transport receipt is passed through exactly as the host realm
        // published it. The IPC layer owns the identity binding (which
        // execution the receipt belongs to); the package's receipt projection
        // owns the policy and transport-identifier binding, so an aliasing
        // receipt is rejected by the package and not silently repaired here.
        return {
          protocolVersion: '1.0.0',
          resourceId: payload.resourceId as `sha256:${string}`,
          chunks: streamChunks(channel),
          transportReceipt: payload.transportReceipt as StructAssetResolutionResult['transportReceipt'],
          ...(payload.declaredByteLength === undefined
            ? {}
            : { declaredByteLength: payload.declaredByteLength as number }),
        }
      },
      revokeAndQuarantine(): StructResolverRevocationReceipt {
        // A revocation before the start right was consumed has no host realm
        // to acknowledge it: nothing was ever granted. The parent closes the
        // start right itself and records the fact.
        if (!channel)
          return { executionId, capabilitiesRevoked: true, quarantined: true }
        const message = channel.revokeSync(executionId)
        const receipt = message.receipt as Record<string, unknown>
        // The receipt is bound to the reserved identifier. A swapped, stale or
        // foreign identifier is never accepted.
        if (receipt.executionId !== executionId)
          throw new StructResolverProtocolError('REVOCATION', executionId)
        return receipt as unknown as StructResolverRevocationReceipt
      },
      async cleanup(): Promise<void> {
        if (!channel) return
        channel.send({ op: 'cleanup', executionId })
        await channel.waitFor((message) => message.event === 'cleanup-ack')
      },
      async terminateAndJoin(): Promise<StructResolverTerminalReceipt> {
        if (!channel) throw new Error('host realm was never started')
        channel.send({ op: 'terminate', executionId })
        const message = await channel.waitFor((event) => event.event === 'terminal')
        const receipt = message.receipt as Record<string, unknown>
        if (receipt.executionId !== executionId)
          throw new StructResolverProtocolError('TERMINAL', executionId)
        return receipt as unknown as StructResolverTerminalReceipt
      },
    }
    void index
    return binding
  }

  for (let index = 0; index < slotCount; index += 1) {
    slots.push({
      index,
      state: 'free',
      executionId: undefined,
      retiredReason: undefined,
      supervisor: createStructResolverSupervisorV1({
        bind: (request, executionId) => bindForSlot(index, request, executionId),
        ...(options.executionIdSource
          ? { executionIdSource: options.executionIdSource }
          : {}),
      }),
    })
  }

  const retireSlot = (executionId: string, reason: string): void => {
    const index = liveOwners.get(executionId)
    if (index === undefined) return
    const slot = slots[index]!
    slot.state = 'retired'
    slot.retiredReason = reason
    tombstones.set(executionId, reason)
    liveOwners.delete(executionId)
  }

  const executor: StructResolverExecutorV1 = {
    allocate(request: StructAssetResolutionRequest) {
      let firstError: unknown
      for (const slot of slots) {
        if (slot.state !== 'free') continue
        try {
          return slot.supervisor.executor.allocate(request)
        } catch (error) {
          if (firstError === undefined) firstError = error
        }
      }
      throw firstError ?? new StructResolverProtocolError('POLICY')
    },
  }

  const hostSupervisor: StructResolverHostSupervisorV1 = {
    protocolVersion: '1.0.0',
    async failStop(
      executionId: string,
      reason: StructResolverFailStopReason,
    ): Promise<StructResolverFailStopReceipt> {
      failStopCalls.push({ executionId, reason })
      const cached = receipts.get(executionId)
      if (cached) return cached
      const response = await manager.request({ op: 'failstop', executionId })
      if (response.ok !== true)
        throw new StructResolverProtocolError('FAIL_STOP', executionId)
      // The evidence is produced by the OS host supervisor from a real wait,
      // a real lifetime-pipe end-of-file and a real namespace census. It is
      // never a value the host declared about itself.
      const receipt = validateStructResolverFailStopReceipt(
        response.receipt,
        executionId,
      )
      proofs.push(response.proof as Record<string, unknown>)
      retireSlot(executionId, reason)
      receipts.set(executionId, receipt)
      return receipt
    },
  }

  const ledger = (): RealHostLedger => ({
    slots: slots.map((slot) => ({
      index: slot.index,
      state: slot.state,
      executionId: slot.executionId,
      retiredReason: slot.retiredReason,
    })),
    tombstones: Object.fromEntries(tombstones),
    freeSlots: slots.filter((slot) => slot.state === 'free').length,
    heldSlots: slots.filter((slot) => slot.state === 'held').length,
    retiredSlots: slots.filter((slot) => slot.state === 'retired').length,
  })

  let disposed = false
  return {
    executor,
    hostSupervisor,
    assets,
    ledger,
    failStopCalls: () => failStopCalls.map((call) => ({ ...call })),
    lifecycle: () => {
      for (let index = channels.length - 1; index >= 0; index -= 1) {
        const stats = channels[index]!.lifecycle()
        if (stats) return stats
      }
      return undefined
    },
    realm: () => {
      for (let index = channels.length - 1; index >= 0; index -= 1) {
        const ready = channels[index]!.ready()
        if (ready) return ready
      }
      return undefined
    },
    failStopProofs: () => proofs.map((proof) => ({ ...proof })),
    stderrText: () => manager.stderrText(),
    settle(outcome: 'completed' | 'failed'): void {
      for (const slot of slots) {
        if (slot.state !== 'held' || slot.executionId === undefined) continue
        const executionId = slot.executionId
        liveOwners.delete(executionId)
        if (outcome === 'completed') {
          slot.state = 'free'
          slot.executionId = undefined
          tombstones.set(executionId, 'TERMINAL_COMPLETED')
        } else {
          slot.state = 'retired'
          slot.retiredReason = 'RESOLUTION_FAILED'
          tombstones.set(executionId, 'RESOLUTION_FAILED')
        }
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      try {
        for (const channel of channels) channel.close()
        try {
          await manager.request({ op: 'shutdown' }, 15_000)
        } catch {
          // The supervisor is killed below in every case.
        }
        await manager.close()
      } finally {
        // The run directory is removed even when the supervisor could not be
        // shut down cleanly, so a failed case leaves no artefact behind.
        rmSync(runDir, { recursive: true, force: true })
      }
    },
  }
}

/** Turns the body chunk events into the bounded byte stream the driver reads. */
async function* streamChunks(channel: HostChannel): AsyncGenerator<Uint8Array> {
  for (;;) {
    const message = await channel.waitFor(
      (event) => event.event === 'chunk' || event.event === 'stream-end',
    )
    if (message.event === 'stream-end') return
    const encoded = message.bytesBase64 as string
    yield Uint8Array.from(Buffer.from(encoded, 'base64'))
  }
}
