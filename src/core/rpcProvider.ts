import {
  AbstractProvider,
  FetchRequest,
  JsonRpcProvider,
  Network,
  assertArgument,
  isHexString,
  makeError,
  type PerformActionRequest,
  type TransactionReceipt
} from 'ethers'
import { abortError, assertReadActive, ReadTimeoutError, withReadDeadline } from './readDeadline'
import {
  isRpcReadCancelled,
  rpcFailureKind,
  rpcRetryAfterMs,
  RpcReadInvalidatedError,
  RpcRateLimitError
} from './rpcPolicy'

const REQUEST_TIMEOUT_MS = 12_000
const STALL_TIMEOUT_MS = 2_500
const MAX_COOLDOWN_MS = 60_000
const READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_call',
  'eth_estimateGas',
  'eth_getLogs'
])

async function readOnExpectedNetwork<T>(
  provider: JsonRpcProvider,
  read: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  // Start both together for batching, but a wrong-chain error must not define
  // transaction semantics before the expected network has been validated.
  const [, result] = await Promise.all([
    provider.getNetwork(),
    read().then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
  ])
  assertReadActive(signal)
  if ('error' in result) throw result.error
  return result.value
}

class EndpointProvider extends JsonRpcProvider {
  startupError: unknown

  constructor(request: FetchRequest, network: Network) {
    super(request, network, { batchMaxCount: 3 })
    // ethers otherwise retries failed initial network discovery indefinitely in the background.
    void this.on('error', (error) => {
      if (error?.event !== 'initial-network-discovery') return
      this.startupError = error.info?.error ?? error
      this.destroy()
    })
  }
}

interface Endpoint {
  request: FetchRequest
  provider: EndpointProvider
  blockedUntil: number
  blockedAt: number
}

class ReadEndpointPool {
  readonly endpoints: Endpoint[]
  readonly active = new Set<() => void>()
  preferred = 0
  retired = false
  destroyed = false
  private onDrained?: () => void
  private readonly leases = new Map<AbortSignal, AbortController>()

  constructor(
    readonly network: Network,
    urls: string[]
  ) {
    this.endpoints = urls.map((url) => {
      const request = new FetchRequest(url)
      request.timeout = REQUEST_TIMEOUT_MS
      // Bounded application retries and confirmation polls own backoff, not the SDK.
      request.retryFunc = async () => false
      const provider = new EndpointProvider(request, network)
      return { request, provider, blockedUntil: 0, blockedAt: 0 }
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const controller of this.leases.values()) controller.abort(new RpcReadInvalidatedError())
    for (const cancel of [...this.active]) cancel()
    for (const { provider } of this.endpoints) provider.destroy()
  }

  retire(onDrained: () => void): void {
    this.retired = true
    this.onDrained = onDrained
    this.drainIfIdle()
  }

  private drainIfIdle(): void {
    if (this.retired && !this.destroyed && !this.active.size && !this.leases.size)
      this.onDrained?.()
  }

  refreshHealth(startedAt: number): void {
    for (const endpoint of this.endpoints) {
      if (endpoint.blockedAt <= startedAt) endpoint.blockedUntil = 0
    }
    this.preferred = 0
  }

  retain(): { signal: AbortSignal; release: () => void } {
    if (this.retired || this.destroyed) throw new RpcReadInvalidatedError()
    const controller = new AbortController()
    this.leases.set(controller.signal, controller)
    return {
      signal: controller.signal,
      release: () => {
        this.leases.delete(controller.signal)
        this.drainIfIdle()
      }
    }
  }

  run<T>(
    read: (provider: JsonRpcProvider, attempt: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    promote = true,
    lease?: AbortSignal
  ): Promise<T> {
    assertReadActive(signal)
    if (this.destroyed || (this.retired && (!lease || !this.leases.has(lease))))
      return Promise.reject(new RpcReadInvalidatedError())
    const ordered = this.endpoints.map(
      (_, offset) => (this.preferred + offset) % this.endpoints.length
    )
    const delay = Math.min(STALL_TIMEOUT_MS, Math.floor(11_000 / ordered.length))
    return new Promise<T>((resolve, reject) => {
      const attempt = new AbortController()
      let settled = false
      let next = 0
      let running = 0
      let lastError: unknown
      let nonRetryableError: unknown
      let skippedUntil = Infinity
      const stalls = new Set<ReturnType<typeof setTimeout>>()
      const finish = (result: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        for (const timer of stalls) clearTimeout(timer)
        signal?.removeEventListener('abort', cancelled)
        this.active.delete(invalidated)
        attempt.abort()
        result()
        this.drainIfIdle()
      }
      const invalidated = () => finish(() => reject(new RpcReadInvalidatedError()))
      const cancelled = () => finish(() => reject(signal?.reason ?? abortError()))
      const deadline = setTimeout(
        () => finish(() => reject(new ReadTimeoutError('RPC read', REQUEST_TIMEOUT_MS))),
        REQUEST_TIMEOUT_MS
      )
      this.active.add(invalidated)
      signal?.addEventListener('abort', cancelled, { once: true })
      const launch = () => {
        if (settled) return
        if (signal?.aborted) return cancelled()
        if (this.destroyed) return invalidated()
        let index: number | undefined
        while (next < ordered.length) {
          const candidate = ordered[next++]
          const endpoint = this.endpoints[candidate]
          if (endpoint.blockedUntil > Date.now()) {
            skippedUntil = Math.min(skippedUntil, endpoint.blockedUntil)
            continue
          }
          index = candidate
          break
        }
        if (index === undefined) {
          if (!running)
            finish(() =>
              reject(
                nonRetryableError ??
                  lastError ??
                  (Number.isFinite(skippedUntil)
                    ? new RpcRateLimitError(Math.max(0, skippedUntil - Date.now()))
                    : new Error('RPC endpoints unavailable'))
              )
            )
          return
        }
        const selected = index
        const endpoint = this.endpoints[selected]
        if (endpoint.provider.destroyed)
          endpoint.provider = new EndpointProvider(endpoint.request, this.network)
        const provider = endpoint.provider
        running += 1
        // Every endpoint is used at most once per read. A stalled attempt may still win,
        // but a late response cannot trigger more requests or replace the settled result.
        const timer = setTimeout(() => {
          stalls.delete(timer)
          launch()
        }, delay)
        stalls.add(timer)
        Promise.resolve()
          .then(() => {
            assertReadActive(signal)
            if (this.destroyed) throw new RpcReadInvalidatedError()
            assertReadActive(attempt.signal)
            return read(provider, attempt.signal).catch((error: unknown) => {
              throw provider.startupError ?? error
            })
          })
          .then(
            (value) => {
              if (settled) return
              if (signal?.aborted) return cancelled()
              if (promote) this.preferred = selected
              finish(() => resolve(value))
            },
            (error: unknown) => {
              running -= 1
              clearTimeout(timer)
              stalls.delete(timer)
              if (settled) return
              lastError = error
              const kind = rpcFailureKind(error)
              if (kind === 'permanent') return finish(() => reject(error))
              // Replaying the same oversized body cannot fix a capacity rejection.
              if (kind === 'capacity' || kind === 'endpoint') nonRetryableError = error
              if (kind === 'rate-limit') {
                const wait = rpcRetryAfterMs(error) ?? 1_000
                endpoint.blockedAt = Date.now()
                endpoint.blockedUntil = endpoint.blockedAt + Math.min(wait, MAX_COOLDOWN_MS)
              }
              launch()
            }
          )
      }
      launch()
    })
  }
}

/** A read-only provider with explicit bounded failover, never a wallet transport. */
export class ReadRpcProvider extends AbstractProvider {
  private readonly pool: ReadEndpointPool
  private readonly scopedCancellation = new AbortController()
  private readonly ownsPool: boolean
  private readonly signal?: AbortSignal

  constructor(
    network: Network,
    urls: string[],
    signal?: AbortSignal,
    pool?: ReadEndpointPool,
    private readonly lease?: AbortSignal
  ) {
    super(network, { cacheTimeout: signal ? -1 : 250 })
    this.ownsPool = !pool
    this.signal = signal ? AbortSignal.any([signal, this.scopedCancellation.signal]) : undefined
    this.pool = pool ?? new ReadEndpointPool(network, urls)
  }

  withSignal(signal: AbortSignal): ReadRpcProvider {
    return new ReadRpcProvider(
      this.pool.network,
      [],
      this.signal ? AbortSignal.any([signal, this.signal]) : signal,
      this.pool,
      this.lease
    )
  }

  /** Clear temporary endpoint penalties only after a fresh successful health check. */
  refreshHealth(startedAt: number): void {
    this.pool.refreshHealth(startedAt)
  }

  override _detectNetwork(): Promise<Network> {
    return this.pool.run((provider) => provider.getNetwork(), this.signal, false, this.lease)
  }

  override async _perform<T = unknown>(req: PerformActionRequest): Promise<T> {
    if (req.method === 'broadcastTransaction') {
      throw makeError('Configured RPCs are read-only', 'UNSUPPORTED_OPERATION', {
        operation: 'broadcastTransaction'
      })
    }
    return this.pool.run(
      async (provider, attempt) => {
        // Check the actual endpoint again, not just the pool's initial health result.
        assertReadActive(attempt)
        const result = await readOnExpectedNetwork(provider, () => provider._perform(req), attempt)
        // Validate before promoting the endpoint; malformed receipts must also fail over.
        if (req.method === 'getTransactionReceipt' && result !== null) {
          try {
            this._wrapTransactionReceipt(result, this.pool.network)
          } catch {
            throw makeError('Invalid RPC receipt response', 'BAD_DATA', { value: result })
          }
        }
        return result
      },
      this.signal,
      true,
      this.lease
    )
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    if (!READ_METHODS.has(method)) {
      throw makeError('Configured RPCs are read-only', 'UNSUPPORTED_OPERATION', {
        operation: method
      })
    }
    return this.pool.run(
      async (provider, attempt) => {
        assertReadActive(attempt)
        return readOnExpectedNetwork(provider, () => provider.send(method, params), attempt)
      },
      this.signal,
      true,
      this.lease
    )
  }

  override async waitForTransaction(
    hash: string,
    confirms = 1,
    timeout = 180_000
  ): Promise<TransactionReceipt | null> {
    assertArgument(isHexString(hash, 32), 'invalid transaction hash', 'hash', hash)
    assertArgument(
      Number.isSafeInteger(confirms) && confirms >= 0,
      'invalid confirmations',
      'confirms',
      confirms
    )
    if (confirms === 0) return this.getTransactionReceipt(hash)
    assertArgument(
      Number.isSafeInteger(timeout) && timeout >= 0,
      'invalid timeout',
      'timeout',
      timeout
    )
    const lease = this.pool.retain()
    const deadline = new AbortController()
    const signal = AbortSignal.any([
      lease.signal,
      deadline.signal,
      this.scopedCancellation.signal,
      ...(this.signal ? [this.signal] : [])
    ])
    const reader = new ReadRpcProvider(this.pool.network, [], signal, this.pool, lease.signal)
    const timer = setTimeout(
      () => deadline.abort(makeError('timeout', 'TIMEOUT', { reason: 'timeout' })),
      timeout
    )
    try {
      // Confirmation owns its pool until completion. Health replacement may drain it,
      // but explicit configuration changes abort it without clearing transaction evidence.
      for (;;) {
        assertReadActive(signal)
        let delay = this.pollingInterval
        try {
          const receipt = await reader.getTransactionReceipt(hash)
          if (receipt && (confirms === 1 || (await receipt.confirmations()) >= confirms))
            return this._wrapTransactionReceipt(receipt, this.pool.network)
        } catch (error) {
          assertReadActive(signal)
          if (isRpcReadCancelled(error)) throw error
          // A read failure is not transaction evidence. Keep the bounded confirmation
          // lease alive even if a node returns an unclassified receipt error.
          delay = Math.max(delay, Math.min(rpcRetryAfterMs(error) ?? 0, MAX_COOLDOWN_MS))
        }
        let poll: ReturnType<typeof setTimeout> | undefined
        try {
          await withReadDeadline(
            () =>
              new Promise<void>((resolve) => {
                poll = setTimeout(resolve, delay)
              }),
            'Confirmation poll',
            { signal, timeoutMs: timeout }
          )
        } finally {
          clearTimeout(poll)
        }
      }
    } finally {
      clearTimeout(timer)
      reader.destroy()
      lease.release()
    }
  }

  retire(onDrained?: () => void): void {
    const dispose = () => {
      this.destroy()
      onDrained?.()
    }
    if (this.ownsPool) this.pool.retire(dispose)
    else dispose()
  }

  override destroy(): void {
    if (this.ownsPool) this.pool.destroy()
    else this.scopedCancellation.abort()
    super.destroy()
  }
}
