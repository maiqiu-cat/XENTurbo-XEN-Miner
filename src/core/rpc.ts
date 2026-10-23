import { JsonRpcProvider, FallbackProvider, FetchRequest, Network } from 'ethers'
import {
  CHAINS,
  getRpcUrls,
  normalizeHttpsRpcUrl,
  normalizeRpcUrls,
  MAX_RPC_ENDPOINTS,
  type ChainKey
} from '@/config/chains'
import { CONTRACTS } from '@/config/contracts'
import { ReadTimeoutError, withReadDeadline } from './readDeadline'
import { mapWithConcurrency } from '@/utils/concurrency'

export type ReadProvider = JsonRpcProvider | FallbackProvider

export class RpcConfigurationError extends Error {
  constructor(chain: ChainKey, reason: string) {
    super(`RPC_UNAVAILABLE: ${CHAINS[chain].name} RPC configuration is invalid: ${reason}`)
    this.name = 'RpcConfigurationError'
  }
}

/** Format only locally validated configuration errors, never remote RPC diagnostics. */
export function rpcConfigurationMessage(message: string): string {
  return `${message.replace(/^RPC_UNAVAILABLE:\s*/, '')}. Your RPC list was not changed. Open the RPC settings to correct the configuration or reset to defaults. Chain reads and transactions remain blocked until validation succeeds.`
}

export interface RpcHealthFailure {
  url: string
  message: string
}

export interface RpcHealthState {
  chain: ChainKey
  checking: boolean
  checkedAt: number | null
  totalUrls: number
  healthyUrls: string[]
  failures: RpcHealthFailure[]
  error: string | null
  errorKind?: 'configuration' | 'network' | null
}

export type RpcHealthListener = (chain: ChainKey, state: RpcHealthState) => void

// A provider is published only after every configured endpoint has been
// probed. The provider itself contains only endpoints that passed that probe.
const providerCache = new Map<ChainKey, ReadProvider>()
const providerSignatures = new Map<ChainKey, string>()
const providerGenerations = new Map<ChainKey, number>()
const healthStates = new Map<ChainKey, RpcHealthState>()
const healthListeners = new Set<RpcHealthListener>()
const healthFlights = new Map<ChainKey, { generation: number; promise: Promise<ReadProvider> }>()

const RPC_HEALTH_TIMEOUT_MS = 2_500

function evictProvider(chain: ChainKey): ReadProvider | undefined {
  const provider = providerCache.get(chain)
  providerCache.delete(chain)
  providerSignatures.delete(chain)
  if (provider) {
    try {
      provider.destroy()
    } catch {
      // Cache invalidation must succeed even if provider cleanup fails.
    }
  }
  return provider
}

function emptyHealthState(chain: ChainKey): RpcHealthState {
  return {
    chain,
    checking: false,
    checkedAt: null,
    totalUrls: 0,
    healthyUrls: [],
    failures: [],
    error: null,
    errorKind: null
  }
}

function cloneHealthState(state: RpcHealthState): RpcHealthState {
  return {
    ...state,
    healthyUrls: [...state.healthyUrls],
    failures: state.failures.map((failure) => ({ ...failure }))
  }
}

function publishHealthState(chain: ChainKey, state: RpcHealthState): void {
  const stored = cloneHealthState(state)
  healthStates.set(chain, stored)
  for (const listener of healthListeners) {
    try {
      listener(chain, cloneHealthState(stored))
    } catch {
      // Health reporting must never prevent a validated provider from being used.
    }
  }
}

export function getRpcHealthState(chain: ChainKey): RpcHealthState {
  return cloneHealthState(healthStates.get(chain) ?? emptyHealthState(chain))
}

export function onRpcHealthChange(listener: RpcHealthListener): () => void {
  healthListeners.add(listener)
  return () => healthListeners.delete(listener)
}

function buildReadProvider(key: ChainKey, urls: string[]): ReadProvider {
  const network = Network.from(CHAINS[key].chainId)
  const endpoint = (url: string) => {
    const request = new FetchRequest(url)
    request.timeout = 12_000
    return new JsonRpcProvider(request, network)
  }
  if (urls.length === 1) return endpoint(urls[0])

  const configs = urls.map((url, index) => ({
    provider: endpoint(url),
    priority: index + 1,
    stallTimeout: 2500,
    weight: 1
  }))
  return new FallbackProvider(configs, network, { quorum: 1 })
}

export function getReadProvider(key: ChainKey): ReadProvider {
  const cached = providerCache.get(key)
  if (cached) return cached
  throw new Error(
    `RPC_NOT_VALIDATED: ${CHAINS[key].name} RPC endpoints must pass a health check before use.`
  )
}

export function getRpcGeneration(key: ChainKey): number {
  return providerGenerations.get(key) ?? 0
}

/** Drop cached providers (call after the user edits custom RPC URLs). */
export function resetProviders(key?: ChainKey): void {
  const keys = key ? [key] : (Object.keys(CHAINS) as ChainKey[])
  for (const chain of keys) {
    evictProvider(chain)
    providerGenerations.set(chain, (providerGenerations.get(chain) ?? 0) + 1)
    healthFlights.delete(chain)
    publishHealthState(chain, emptyHealthState(chain))
  }
}

export interface RpcValidationResult {
  url: string
  chainId: number
  checkedAt: number
}

export type RpcChainIdRequest = (url: string) => Promise<unknown>

async function requestChainId(url: string, timeoutMs = 8_000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`)
    const payload = (await response.json()) as {
      result?: unknown
      error?: { message?: string }
    }
    if (payload.error) throw new Error(payload.error.message || 'RPC returned an error')
    return payload.result
  } finally {
    clearTimeout(timer)
  }
}

const requestHealthChainId: RpcChainIdRequest = async (url) => {
  const chainId = await requestChainId(url, RPC_HEALTH_TIMEOUT_MS)
  const chain = (Object.keys(CHAINS) as ChainKey[]).find(
    (key) => CHAINS[key].chainId === parseRpcChainId(chainId)
  )
  if (!chain) throw new Error('Unsupported RPC chain')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'eth_call',
          params: [{ to: CONTRACTS[chain].factory, data: '0xc57981b5' }, 'latest']
        }
      ]),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`)
    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) throw new Error('RPC did not return health probe results')
    const block = payload.find((item) => item?.id === 2)?.result
    const fee = payload.find((item) => item?.id === 3)?.result
    if (
      !block ||
      !/^0x[0-9a-f]+$/i.test(block.number) ||
      !/^0x[0-9a-f]+$/i.test(block.timestamp) ||
      !/^0x[0-9a-f]{64}$/i.test(block.hash)
    ) {
      throw new Error('RPC cannot read the latest block')
    }
    if (typeof fee !== 'string' || !/^0x[0-9a-f]{64}$/i.test(fee))
      throw new Error('RPC cannot read the miner contract')
    return chainId
  } finally {
    clearTimeout(timer)
  }
}

function parseRpcChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error('RPC returned an invalid chain id')
  }
  const parsed = Number(BigInt(value))
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('RPC returned an invalid chain id')
  }
  return parsed
}

/** Validate a custom RPC before it is persisted or used. */
export async function validateRpcEndpoint(
  input: string,
  expectedChainId: number,
  request: RpcChainIdRequest = requestChainId
): Promise<RpcValidationResult> {
  const url = normalizeHttpsRpcUrl(input)
  const chainId = parseRpcChainId(await request(url))
  if (chainId !== expectedChainId) {
    throw new Error(`RPC expected chain ${expectedChainId} but returned ${chainId}`)
  }
  return { url, chainId, checkedAt: Date.now() }
}

function healthFailure(url: string, error: unknown): RpcHealthFailure {
  const message = error instanceof Error ? error.message : String(error)
  return { url, message: message.slice(0, 200) }
}

/**
 * Recheck every configured endpoint before a high-level chain operation and
 * publish a provider containing only endpoints that are currently responsive
 * on the expected chain. Concurrent operations share one in-flight check.
 */
export function ensureHealthyReadProvider(
  key: ChainKey,
  request: RpcChainIdRequest = requestHealthChainId
): Promise<ReadProvider> {
  const generation = providerGenerations.get(key) ?? 0
  const existingFlight = healthFlights.get(key)
  if (existingFlight?.generation === generation) return existingFlight.promise

  const promise = (async () => {
    let urls: string[]
    try {
      urls = normalizeRpcUrls(getRpcUrls(key))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = new RpcConfigurationError(key, message)
      const state: RpcHealthState = {
        ...emptyHealthState(key),
        checkedAt: Date.now(),
        errorKind: 'configuration',
        error: failure.message
      }
      if ((providerGenerations.get(key) ?? 0) === generation) {
        evictProvider(key)
        publishHealthState(key, state)
      }
      throw failure
    }

    publishHealthState(key, {
      ...getRpcHealthState(key),
      checking: true,
      totalUrls: urls.length,
      error: null,
      errorKind: null
    })

    // The list is capped at 16. Keep health probes parallel so validation fits
    // existing wallet read deadlines even when every endpoint responds slowly.
    const checks = await mapWithConcurrency(urls, MAX_RPC_ENDPOINTS, async (url) => {
      try {
        if ((providerGenerations.get(key) ?? 0) !== generation) {
          throw new Error('RPC configuration changed during health check')
        }
        const chainId = parseRpcChainId(await request(url))
        if (chainId !== CHAINS[key].chainId) {
          throw new Error(`expected chain ${CHAINS[key].chainId} but returned ${chainId}`)
        }
        return { url, failure: null }
      } catch (error) {
        return { url, failure: healthFailure(url, error) }
      }
    })

    if ((providerGenerations.get(key) ?? 0) !== generation) {
      return ensureHealthyReadProvider(key, request)
    }

    const healthyUrls = checks.flatMap((check) => (check.failure ? [] : [check.url]))
    const failures = checks.flatMap((check) => (check.failure ? [check.failure] : []))
    const checkedAt = Date.now()
    if (healthyUrls.length === 0) {
      evictProvider(key)
      const error = `RPC_UNAVAILABLE: ${CHAINS[key].name} has 0/${urls.length} responsive configured RPC endpoints. The RPC list was preserved. This may be caused by the local internet connection, DNS, firewall, proxy/VPN, browser access policy, or the endpoints themselves. Check the network and retry, or open RPC settings to change endpoints.`
      publishHealthState(key, {
        chain: key,
        checking: false,
        checkedAt,
        totalUrls: urls.length,
        healthyUrls,
        failures,
        error,
        errorKind: 'network'
      })
      throw new Error(error)
    }

    const signature = healthyUrls.join('\n')
    let provider = providerCache.get(key)
    if (!provider || providerSignatures.get(key) !== signature) {
      if (provider) evictProvider(key)
      provider = buildReadProvider(key, healthyUrls)
      providerCache.set(key, provider)
      providerSignatures.set(key, signature)
    }
    publishHealthState(key, {
      chain: key,
      checking: false,
      checkedAt,
      totalUrls: urls.length,
      healthyUrls,
      failures,
      error: null,
      errorKind: null
    })
    return provider
  })()

  const flight = { generation, promise }
  healthFlights.set(key, flight)
  const clearFlight = () => {
    if (healthFlights.get(key) === flight) healthFlights.delete(key)
  }
  void promise.then(clearFlight, clearFlight)
  return promise
}

/** Reuse a recently validated provider for background polling. */
export function ensureRecentReadProvider(
  key: ChainKey,
  maxAgeMs: number,
  request: RpcChainIdRequest = requestHealthChainId
): Promise<ReadProvider> {
  const state = healthStates.get(key)
  const provider = providerCache.get(key)
  const checkedAt = state?.checkedAt
  const age =
    checkedAt === null || checkedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() - checkedAt
  if (
    provider &&
    state &&
    state.error === null &&
    state.healthyUrls.length > 0 &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    age >= 0 &&
    age <= maxAgeMs
  ) {
    return Promise.resolve(provider)
  }
  return ensureHealthyReadProvider(key, request)
}

interface RetryErrorLike {
  code?: unknown
  status?: unknown
  message?: unknown
  shortMessage?: unknown
  retryAfterMs?: unknown
  info?: unknown
}

function retryErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const value = error as RetryErrorLike
  return [value.code, value.status, value.message, value.shortMessage, value.info]
    .map((part) => {
      try {
        return typeof part === 'string' ? part : JSON.stringify(part)
      } catch {
        return String(part)
      }
    })
    .join(' ')
}

export function isRetryableRpcError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
    return false
  }
  const text = retryErrorText(error)
  if (
    /CALL_EXCEPTION|execution reverted|\brevert(?:ed)?\b|INVALID_ARGUMENT|invalid (?:argument|params?)|insufficient funds|user (?:rejected|denied)|ACTION_REJECTED/i.test(
      text
    )
  ) {
    return false
  }
  return true
}

function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const value = Number((error as RetryErrorLike).retryAfterMs)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The RPC operation was aborted', 'AbortError')
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/** Retry transient RPC failures with bounded exponential backoff and jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number
    baseDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
    signal?: AbortSignal
    sleep?: (delayMs: number) => Promise<void>
    random?: () => number
    timeoutMs?: number
    totalTimeoutMs?: number
  } = {}
): Promise<T> {
  const retries = opts.retries ?? 3
  const base = opts.baseDelayMs ?? 400
  const maxDelay = opts.maxDelayMs ?? 5_000
  const jitterRatio = opts.jitterRatio ?? 0.2
  const random = opts.random ?? Math.random
  const sleep = opts.sleep ?? ((delayMs: number) => retryDelay(delayMs, opts.signal))
  let lastErr: unknown
  const deadline = Date.now() + (opts.totalTimeoutMs ?? 30_000)
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw abortReason(opts.signal)
    try {
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw new ReadTimeoutError('RPC retry deadline', opts.totalTimeoutMs ?? 30_000)
      return await withReadDeadline(fn, 'RPC read', {
        timeoutMs: Math.min(opts.timeoutMs ?? 12_000, remaining),
        signal: opts.signal
      })
    } catch (err) {
      lastErr = err
      if (attempt === retries || !isRetryableRpcError(err)) break
      if (Date.now() >= deadline) break
      const exponential = Math.min(maxDelay, base * 2 ** attempt)
      const serverDelay = retryAfterMs(err)
      const nominal = serverDelay === null ? exponential : Math.min(maxDelay, serverDelay)
      const jitter = 1 - jitterRatio + random() * jitterRatio * 2
      await sleep(Math.max(0, Math.round(nominal * jitter)))
      if (opts.signal?.aborted) throw abortReason(opts.signal)
    }
  }
  throw lastErr
}
