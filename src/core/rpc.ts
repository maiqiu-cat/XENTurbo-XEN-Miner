import { JsonRpcProvider, FallbackProvider, Network } from 'ethers'
import { CHAINS, getRpcUrls, type ChainKey } from '@/config/chains'

// Read-only providers, one per chain, built from the effective RPC list.
// A FallbackProvider is used so a single flaky public RPC does not break reads.
const providerCache = new Map<ChainKey, JsonRpcProvider | FallbackProvider>()

export function getReadProvider(key: ChainKey): JsonRpcProvider | FallbackProvider {
  const cached = providerCache.get(key)
  if (cached) return cached

  const cfg = CHAINS[key]
  const network = Network.from(cfg.chainId)
  const urls = getRpcUrls(key)

  let provider: JsonRpcProvider | FallbackProvider
  if (urls.length === 1) {
    provider = new JsonRpcProvider(urls[0], network, { staticNetwork: network })
  } else {
    const configs = urls.map((url, i) => ({
      provider: new JsonRpcProvider(url, network, { staticNetwork: network }),
      priority: i + 1,
      stallTimeout: 2500,
      weight: 1
    }))
    // quorum 1: first successful response wins, remaining RPCs are pure backup.
    provider = new FallbackProvider(configs, network, { quorum: 1 })
  }

  providerCache.set(key, provider)
  return provider
}

/** Drop cached providers (call after the user edits custom RPC URLs). */
export function resetProviders(): void {
  providerCache.clear()
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
