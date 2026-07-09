import { createWeb3Modal } from '@web3modal/wagmi'
import {
  createConfig,
  http,
  getAccount,
  watchAccount,
  reconnect,
  switchChain,
  getWalletClient,
  connect,
  getConnectors
} from '@wagmi/core'
import { mainnet, polygon } from '@wagmi/core/chains'
import { walletConnect, injected } from '@wagmi/connectors'
import { BrowserProvider, JsonRpcSigner, Network, Interface } from 'ethers'
import { CHAINS, getRpcUrls, type ChainKey } from '@/config/chains'

const rawProjectId = (import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID as string) || ''
// A real WalletConnect project id is required for the WalletConnect/Web3Modal flow.
const hasWalletConnect = rawProjectId.length > 0 && rawProjectId !== 'demo'
const projectId = hasWalletConnect ? rawProjectId : 'demo'

const metadata = {
  name: 'XENTurbo XEN Miner',
  description: 'Pure-frontend XEN batch miner',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
  icons: []
}

// Only register the WalletConnect connector when a real project id is present,
// otherwise it fails to initialize and blocks connecting.
export const wagmiConfig = createConfig({
  chains: [mainnet, polygon],
  connectors: [
    ...(hasWalletConnect ? [walletConnect({ projectId, metadata, showQrModal: false })] : []),
    injected({ shimDisconnect: true })
  ],
  transports: {
    [mainnet.id]: http(getRpcUrls('eth')[0]),
    [polygon.id]: http(getRpcUrls('polygon')[0])
  }
})

let modal: ReturnType<typeof createWeb3Modal> | null = null

export function initWallet(): void {
  // Web3Modal (WalletConnect UI) only works with a real project id.
  if (hasWalletConnect && !modal) {
    try {
      modal = createWeb3Modal({ wagmiConfig: wagmiConfig as any, projectId, enableAnalytics: false })
    } catch {
      modal = null
    }
  }
  void reconnect(wagmiConfig)
}

function hasInjectedProvider(): boolean {
  return !!getInjectedProvider()
}

/** Resolve the browser-injected EIP-1193 provider (MetaMask, etc.). */
export function getInjectedProvider(): { request: (args: any) => Promise<any> } | undefined {
  if (typeof window === 'undefined') return undefined
  const eth = (window as any).ethereum
  if (!eth) return undefined
  // Multiple wallets (MetaMask + others): pick MetaMask when available.
  if (Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p: any) => p.isMetaMask)
    return (mm ?? eth.providers[0]) as { request: (args: any) => Promise<any> }
  }
  return eth as { request: (args: any) => Promise<any> }
}

/** Connect the browser-injected wallet (MetaMask, etc.) directly via wagmi. */
export async function connectInjected(): Promise<void> {
  const connectors = getConnectors(wagmiConfig)
  const injectedConnector =
    connectors.find((c) => c.type === 'injected') ??
    connectors.find((c) => c.id === 'injected')
  if (!injectedConnector) throw new Error('No injected wallet connector available')
  await connect(wagmiConfig, { connector: injectedConnector })
}

export type ConnectResult = 'connected' | 'modal' | 'no-wallet'

/**
 * Smart connect: prefer the injected wallet (works without any project id).
 * Fall back to the Web3Modal/WalletConnect UI if configured.
 */
export async function smartConnect(): Promise<ConnectResult> {
  if (hasInjectedProvider()) {
    await connectInjected()
    return 'connected'
  }
  if (modal) {
    await modal.open()
    return 'modal'
  }
  return 'no-wallet'
}

export const chainIdToKey: Record<number, ChainKey> = {
  [mainnet.id]: 'eth',
  [polygon.id]: 'polygon'
}

export function currentAccount() {
  return getAccount(wagmiConfig)
}

export function onAccountChange(cb: (address?: string, chainId?: number) => void) {
  return watchAccount(wagmiConfig, {
    onChange(account) {
      cb(account.address, account.chainId)
    }
  })
}

export async function switchToChain(key: ChainKey): Promise<void> {
  await switchChain(wagmiConfig, { chainId: CHAINS[key].chainId as 1 | 137 })
}

const toHex = (v: bigint) => '0x' + v.toString(16)

/** Reject if a promise does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms)
    )
  ])
}

/**
 * MetaMask's MV3 service worker sleeps after ~30s idle; the injected provider's
 * port to it can go stale, making the NEXT request hang forever. Ping a cheap,
 * approval-free method first (with a short timeout) to wake it and detect a dead
 * connection before we try to send a transaction.
 */
async function wakeInjected(eth: any): Promise<void> {
  try {
    await withTimeout(eth.request({ method: 'eth_chainId' }), 6000, 'wake')
  } catch {
    // Second attempt: waking usually revives the service worker on the retry.
    try {
      await withTimeout(eth.request({ method: 'eth_chainId' }), 6000, 'wake')
    } catch {
      throw new Error(
        'WALLET_ASLEEP: Wallet did not respond. Click the MetaMask extension icon (or reload the page) and try again.'
      )
    }
  }
}

/**
 * Send a contract write. Prefer a DIRECT eth_sendTransaction through the injected
 * provider (window.ethereum): this is the most reliable way to trigger the wallet
 * signature prompt and avoids connector/chain-switch quirks. Falls back to wagmi
 * writeContract (e.g. WalletConnect sessions with no injected provider).
 * Returns the tx hash.
 */
export async function writeFactory(params: {
  chainId: number
  address: `0x${string}`
  abi: any
  functionName: string
  args: readonly unknown[]
  value?: bigint
  gas?: bigint
  /** Prefetched from our RPC so MetaMask does not hit its (often slow) node. */
  nonce?: number
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  /** If set, abort when the wallet's active account differs (account switch mid-flow). */
  expectedFrom?: string
}): Promise<`0x${string}`> {
  const eth = getInjectedProvider()
  if (!eth?.request) {
    throw new Error('No injected wallet found. Install MetaMask (or similar) and reconnect.')
  }

  // Keep this path SHORT: it is called from a click handler. Prefer eth_accounts
  // (no popup) and skip wakeInjected when fees/nonce are already prefetched —
  // those round-trips alone can add seconds before MetaMask even opens.
  const accounts = (await eth.request({ method: 'eth_accounts' })) as string[]
  let from = accounts?.[0] ?? (getAccount(wagmiConfig).address as string | undefined)
  if (!from) {
    const req = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
    from = req?.[0]
  }
  if (!from) throw new Error('No wallet account available. Reconnect your wallet.')
  if (params.expectedFrom && from.toLowerCase() !== params.expectedFrom.toLowerCase()) {
    throw new Error('Wallet account changed during the operation. Reconnect and retry.')
  }

  const current = await eth.request({ method: 'eth_chainId' })
  if (typeof current === 'string' && parseInt(current, 16) !== params.chainId) {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + params.chainId.toString(16) }]
    })
  }

  const iface = new Interface(params.abi)
  const data = iface.encodeFunctionData(params.functionName, params.args as any[])
  const txParams: Record<string, string> = {
    from,
    to: params.address,
    data
  }
  if (params.value !== undefined) txParams.value = toHex(params.value)
  if (params.gas !== undefined) txParams.gas = toHex(params.gas)
  // Prefill fee + nonce from our RPC. Without these, MetaMask queries its own
  // RPC (often the broken Infura/default endpoint) and the popup can stall 1–2 min.
  if (params.nonce !== undefined) txParams.nonce = toHex(BigInt(params.nonce))
  if (params.maxFeePerGas !== undefined) txParams.maxFeePerGas = toHex(params.maxFeePerGas)
  if (params.maxPriorityFeePerGas !== undefined) {
    txParams.maxPriorityFeePerGas = toHex(params.maxPriorityFeePerGas)
  }

  try {
    const hash: string = await eth.request({
      method: 'eth_sendTransaction',
      params: [txParams]
    })
    return hash as `0x${string}`
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (/already pending|Request is already pending/i.test(msg)) {
      throw new Error(
        'WALLET_PENDING: MetaMask has a pending request. Open the MetaMask extension, approve or reject it, then retry.'
      )
    }
    throw err
  }
}

/**
 * Pre-warm the injected wallet: wake its (possibly asleep) MV3 service worker
 * and switch to the target chain. Safe to call in parallel with gas estimation
 * so the signature prompt appears immediately once estimation finishes.
 */
export async function warmUpInjected(chainId: number): Promise<void> {
  const eth = getInjectedProvider()
  if (!eth) return
  await wakeInjected(eth)
  await ensureChain(eth, chainId)
}

/** Make the injected wallet switch to the target chain if it is not already on it. */
async function ensureChain(eth: any, chainId: number): Promise<void> {
  try {
    const current = await withTimeout(eth.request({ method: 'eth_chainId' }), 6000, 'chainId')
    if (typeof current === 'string' && parseInt(current, 16) === chainId) return
    await withTimeout(
      eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x' + chainId.toString(16) }]
      }),
      30000,
      'switchChain'
    )
  } catch {
    // If switching fails/times out, let eth_sendTransaction surface the error.
  }
}

/** Bridge the connected wagmi/viem wallet client to an ethers v6 signer. */
export async function getEthersSigner(chainId: number): Promise<JsonRpcSigner> {
  const client = await getWalletClient(wagmiConfig, { chainId: chainId as 1 | 137 })
  if (!client) throw new Error('Wallet not connected')

  // Prefer the raw EIP-1193 provider (window.ethereum) for injected wallets:
  // it is the most reliable transport for ethers. Fall back to the viem transport.
  const eip1193 = getInjectedProvider() ?? client.transport

  // staticNetwork avoids repeated eth_chainId probing that can stall requests.
  const network = new Network(chainIdToKey[chainId] ?? 'chain', chainId)
  const provider = new BrowserProvider(eip1193, network, { staticNetwork: network })
  return new JsonRpcSigner(provider, client.account.address)
}
