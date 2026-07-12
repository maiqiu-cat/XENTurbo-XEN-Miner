// Chain configuration for the standalone miner.
// Each entry is self-contained (no Nacos / platform config service).

export type ChainKey = 'eth' | 'polygon'

export interface ChainConfig {
  key: ChainKey
  chainId: number
  name: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  /** Default public RPCs, tried in order. Users can override in-app. */
  defaultRpcUrls: string[]
  blockExplorerUrl: string
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  eth: {
    key: 'eth',
    chainId: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    defaultRpcUrls: ['https://ethereum.publicnode.com', 'https://ethereum-rpc.publicnode.com'],
    blockExplorerUrl: 'https://etherscan.io'
  },
  polygon: {
    key: 'polygon',
    chainId: 137,
    name: 'Polygon',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    defaultRpcUrls: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.publicnode.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic'
      // polygon-rpc.com often returns 401 without a key — omit from defaults
    ],
    blockExplorerUrl: 'https://polygonscan.com'
  }
}

export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[]

/**
 * Resolve effective RPC list for a chain.
 * Priority: user overrides (localStorage) > env override > defaults.
 */
export function getRpcUrls(key: ChainKey): string[] {
  const custom = readCustomRpc(key)
  if (custom.length) return custom
  const envKey = key === 'eth' ? 'VITE_RPC_ETH' : 'VITE_RPC_POLYGON'
  const envVal = (import.meta.env?.[envKey] as string | undefined)?.trim()
  if (envVal) {
    return envVal
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeHttpsRpcUrl)
  }
  return CHAINS[key].defaultRpcUrls
}

const RPC_STORAGE_KEY = 'sm.customRpc'

function readAllCustomRpc(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(RPC_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

export function readCustomRpc(key: ChainKey): string[] {
  const all = readAllCustomRpc()
  if (!Array.isArray(all[key])) return []
  return all[key].flatMap((url) => {
    try {
      return [normalizeHttpsRpcUrl(url)]
    } catch {
      return []
    }
  })
}

export function writeCustomRpc(key: ChainKey, urls: string[]): void {
  const all = readAllCustomRpc()
  const cleaned = urls.map(normalizeHttpsRpcUrl)
  if (cleaned.length) {
    all[key] = cleaned
  } else {
    delete all[key]
  }
  localStorage.setItem(RPC_STORAGE_KEY, JSON.stringify(all))
}

/** Normalize and reject RPC URLs that are unsafe to persist in the browser. */
export function normalizeHttpsRpcUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('RPC endpoint must be a valid HTTPS URL')
  }
  if (url.protocol !== 'https:') throw new Error('RPC endpoint must use HTTPS')
  if (url.username || url.password) {
    throw new Error('RPC endpoint must not contain credentials in the URL')
  }
  return url.toString()
}
