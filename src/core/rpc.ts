import { JsonRpcProvider, FallbackProvider, Network } from 'ethers'
import { CHAINS, getRpcUrls, normalizeHttpsRpcUrl, type ChainKey } from '@/config/chains'

export type ReadProvider = JsonRpcProvider | FallbackProvider

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

function emptyHealthState(chain: ChainKey): RpcHealthState {
  return {
    chain,
    checking: false,
    checkedAt: null,
    totalUrls: 0,
    healthyUrls: [],
    failures: [],
    error: null
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
  if (urls.length === 1) return new JsonRpcProvider(urls[0], network)

  const configs = urls.map((url, index) => ({
    provider: new JsonRpcProvider(url, network),
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

/** Drop cached providers (call after the user edits custom RPC URLs). */
export function resetProviders(key?: ChainKey): void {
  const keys = key ? [key] : (Object.keys(CHAINS) as ChainKey[])
  for (const chain of keys) {
    providerCache.delete(chain)
    providerSignatures.delete(chain)
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

const requestHealthChainId: RpcChainIdRequest = (url) => requestChainId(url, RPC_HEALTH_TIMEOUT_MS)

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
      urls = Array.from(new Set(getRpcUrls(key).map(normalizeHttpsRpcUrl)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const state: RpcHealthState = {
        ...emptyHealthState(key),
        checkedAt: Date.now(),
        error: `RPC_UNAVAILABLE: ${CHAINS[key].name} RPC configuration is invalid: ${message}`
      }
      if ((providerGenerations.get(key) ?? 0) === generation) {
        providerCache.delete(key)
        providerSignatures.delete(key)
        publishHealthState(key, state)
      }
      throw new Error(state.error!)
    }

    publishHealthState(key, {
      ...getRpcHealthState(key),
      checking: true,
      totalUrls: urls.length,
      error: null
    })

    const checks = await Promise.all(
      urls.map(async (url) => {
        try {
          const chainId = parseRpcChainId(await request(url))
          if (chainId !== CHAINS[key].chainId) {
            throw new Error(`expected chain ${CHAINS[key].chainId} but returned ${chainId}`)
          }
          return { url, failure: null }
        } catch (error) {
          return { url, failure: healthFailure(url, error) }
        }
      })
    )

    if ((providerGenerations.get(key) ?? 0) !== generation) {
      return ensureHealthyReadProvider(key, request)
    }

    const healthyUrls = checks.flatMap((check) => (check.failure ? [] : [check.url]))
    const failures = checks.flatMap((check) => (check.failure ? [check.failure] : []))
    const checkedAt = Date.now()
    if (healthyUrls.length === 0) {
      providerCache.delete(key)
      providerSignatures.delete(key)
      const error = `RPC_UNAVAILABLE: ${CHAINS[key].name} has 0/${urls.length} responsive configured RPC endpoints. The RPC list was preserved. This may be caused by the local internet connection, DNS, firewall, proxy/VPN, browser access policy, or the endpoints themselves. Check the network and retry, or open RPC settings to change endpoints.`
      publishHealthState(key, {
        chain: key,
        checking: false,
        checkedAt,
        totalUrls: urls.length,
        healthyUrls,
        failures,
        error
      })
      throw new Error(error)
    }

    const signature = healthyUrls.join('\n')
    let provider = providerCache.get(key)
    if (!provider || providerSignatures.get(key) !== signature) {
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
      error: null
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

/** Retry an async RPC call with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 3
  const base = opts.baseDelayMs ?? 400
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries) break
      await new Promise((r) => setTimeout(r, base * 2 ** attempt))
    }
  }
  throw lastErr
}
