import { Interface } from 'ethers'
import { CHAINS, type ChainKey } from '@/config/chains'
import {
  beginWalletSend,
  getInjectedAccount,
  getInjectedChainId,
  getInjectedProvider,
  type InjectedProvider
} from './eip1193'

export { getInjectedProvider } from './eip1193'

export interface WalletAccount {
  address?: string
  chainId?: number
}

export type ConnectResult = 'connected' | 'no-wallet'

export const chainIdToKey: Record<number, ChainKey> = {
  [CHAINS.eth.chainId]: 'eth',
  [CHAINS.polygon.chainId]: 'polygon'
}

let accountState: WalletAccount = {}
let addressVersion = 0
let chainVersion = 0

type WalletStateListener = (address?: string, chainId?: number) => void | Promise<void>

const walletStateListeners = new Set<WalletStateListener>()
const pendingNotifications = new Set<Promise<void>>()
let observedProvider: InjectedProvider | undefined
let providerListenerGeneration = 0
let removeObservedProviderListeners: (() => void) | undefined

function setAddressState(address?: string): void {
  accountState = { ...accountState, address }
  addressVersion += 1
}

function setChainState(chainId?: number): void {
  accountState = { ...accountState, chainId }
  chainVersion += 1
}

function clearAccountState(): void {
  setAddressState()
  setChainState()
}

function firstAccount(value: unknown): string | undefined {
  if (!Array.isArray(value)) throw new Error('Invalid account list returned by injected wallet')
  const account = value[0]
  return typeof account === 'string' && account ? account : undefined
}

function parseChainId(value: unknown): number {
  let parsed: bigint
  try {
    if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
      throw new Error('invalid chain id')
    }
    parsed = BigInt(value)
  } catch {
    throw new Error('Invalid chain id returned by injected wallet')
  }
  const chainId = Number(parsed)
  if (parsed < 0n || !Number.isSafeInteger(chainId)) {
    throw new Error('Invalid chain id returned by injected wallet')
  }
  return chainId
}

function publishWalletState(): Promise<void> {
  const { address, chainId } = accountState
  const notifications = [...walletStateListeners].map((listener) => {
    try {
      return Promise.resolve(listener(address, chainId))
    } catch {
      return Promise.resolve()
    }
  })
  const pending = Promise.allSettled(notifications).then(() => undefined)
  pendingNotifications.add(pending)
  void pending.finally(() => pendingNotifications.delete(pending))
  return pending
}

async function waitForWalletStateNotifications(): Promise<void> {
  while (pendingNotifications.size > 0) {
    await Promise.all([...pendingNotifications])
  }
}

function detachObservedProvider(): void {
  providerListenerGeneration += 1
  const remove = removeObservedProviderListeners
  removeObservedProviderListeners = undefined
  observedProvider = undefined
  try {
    remove?.()
  } catch {
    // A broken provider cleanup must not leave the replacement listener stale-active.
  }
}

function ensureObservedProvider(provider = getInjectedProvider()): void {
  if (walletStateListeners.size === 0) {
    if (observedProvider) detachObservedProvider()
    return
  }
  if (observedProvider === provider) return

  detachObservedProvider()
  observedProvider = provider
  if (!provider?.on) return

  const generation = providerListenerGeneration
  const isCurrent = () => generation === providerListenerGeneration && observedProvider === provider
  const handleAccountsChanged = (value: unknown) => {
    if (!isCurrent()) return
    setAddressState(firstAccount(value))
    void publishWalletState()
  }
  const handleChainChanged = (value: unknown) => {
    if (!isCurrent()) return
    setChainState(parseChainId(value))
    void publishWalletState()
  }
  const handleDisconnect = () => {
    if (!isCurrent()) return
    clearAccountState()
    void publishWalletState()
  }

  provider.on('accountsChanged', handleAccountsChanged)
  provider.on('chainChanged', handleChainChanged)
  provider.on('disconnect', handleDisconnect)

  removeObservedProviderListeners = () => {
    provider.removeListener?.('accountsChanged', handleAccountsChanged)
    provider.removeListener?.('chainChanged', handleChainChanged)
    provider.removeListener?.('disconnect', handleDisconnect)
  }
}

/** Read the wallet's initial non-interactive state without opening a prompt. */
export async function initWallet(): Promise<void> {
  const provider = getInjectedProvider()
  ensureObservedProvider(provider)
  if (!provider) {
    clearAccountState()
    await publishWalletState()
    return
  }

  const initialAddressVersion = addressVersion
  const initialChainVersion = chainVersion
  const [accounts, rawChainId] = await Promise.all([
    provider.request({ method: 'eth_accounts' }),
    provider.request({ method: 'eth_chainId' })
  ])
  if (getInjectedProvider() !== provider) {
    ensureObservedProvider()
    await waitForWalletStateNotifications()
    return
  }

  const address = firstAccount(accounts)
  const chainId = parseChainId(rawChainId)
  let updated = false
  if (addressVersion === initialAddressVersion) {
    setAddressState(address)
    updated = true
  }
  if (chainVersion === initialChainVersion) {
    setChainState(chainId)
    updated = true
  }
  if (updated) await publishWalletState()
  else await waitForWalletStateNotifications()
}

export function currentAccount(): WalletAccount {
  return { ...accountState }
}

export async function connectInjected(): Promise<void> {
  const provider = getInjectedProvider()
  if (!provider) throw new Error('No injected wallet found')
  ensureObservedProvider(provider)
  const initialAddressVersion = addressVersion
  const initialChainVersion = chainVersion
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  const address = firstAccount(accounts)
  if (!address) throw new Error('No wallet account available. Reconnect your wallet.')
  const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }))
  if (getInjectedProvider() !== provider) {
    ensureObservedProvider()
    throw new Error('Wallet provider changed during connection. Retry the connection.')
  }

  let updated = false
  if (addressVersion === initialAddressVersion) {
    setAddressState(address)
    updated = true
  }
  if (chainVersion === initialChainVersion) {
    setChainState(chainId)
    updated = true
  }
  if (updated) await publishWalletState()
  else await waitForWalletStateNotifications()
}

export async function smartConnect(): Promise<ConnectResult> {
  if (!getInjectedProvider()) return 'no-wallet'
  await connectInjected()
  return 'connected'
}

export function onAccountChange(cb: WalletStateListener): () => void {
  walletStateListeners.add(cb)
  ensureObservedProvider()
  let active = true
  return () => {
    if (!active) return
    active = false
    walletStateListeners.delete(cb)
    if (walletStateListeners.size === 0) detachObservedProvider()
  }
}

export async function switchToChain(key: ChainKey): Promise<void> {
  const provider = getInjectedProvider()
  if (!provider) throw new Error('No injected wallet found')
  ensureObservedProvider(provider)
  const chainId = CHAINS[key].chainId
  const initialChainVersion = chainVersion
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${chainId.toString(16)}` }]
  })
  if (getInjectedProvider() !== provider) {
    ensureObservedProvider()
    throw new Error('Wallet provider changed during the chain switch. Retry the switch.')
  }
  if (chainVersion === initialChainVersion) {
    setChainState(chainId)
    await publishWalletState()
  } else {
    await waitForWalletStateNotifications()
  }
}

const toHex = (value: bigint) => `0x${value.toString(16)}`

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms))
  ])
}

async function wakeInjected(provider: InjectedProvider): Promise<void> {
  try {
    await withTimeout(provider.request({ method: 'eth_chainId' }), 6000, 'wake')
  } catch {
    try {
      await withTimeout(provider.request({ method: 'eth_chainId' }), 6000, 'wake')
    } catch {
      throw new Error(
        'WALLET_ASLEEP: Wallet did not respond. Click the MetaMask extension icon (or reload the page) and try again.'
      )
    }
  }
}

export async function writeFactory(params: {
  chainId: number
  address: `0x${string}`
  abi: any
  functionName: string
  args: readonly unknown[]
  value?: bigint
  gas?: bigint
  nonce?: number
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  expectedFrom?: string
  /** Called after all local checks, immediately before opening the wallet request. */
  onRequestStart?: () => void
  /** Called only when the provider throws before returning a request promise. */
  onRequestSyncError?: (error: unknown) => void
}): Promise<`0x${string}`> {
  const provider = getInjectedProvider()
  if (!provider) {
    throw new Error('No injected wallet found. Install MetaMask (or similar) and reconnect.')
  }

  let from = await getInjectedAccount()
  if (!from) {
    from = firstAccount(await provider.request({ method: 'eth_requestAccounts' }))
  }
  if (!from) throw new Error('No wallet account available. Reconnect your wallet.')
  if (params.expectedFrom && from.toLowerCase() !== params.expectedFrom.toLowerCase()) {
    throw new Error('Wallet account changed during the operation. Reconnect and retry.')
  }

  const currentChainId = await getInjectedChainId()
  if (currentChainId !== params.chainId) {
    throw new Error('Wallet is on the wrong network. Switch networks and retry.')
  }

  const data = new Interface(params.abi).encodeFunctionData(
    params.functionName,
    params.args as any[]
  )
  const txParams: Record<string, string> = {
    from,
    to: params.address,
    data
  }
  if (params.value !== undefined) txParams.value = toHex(params.value)
  if (params.gas !== undefined) txParams.gas = toHex(params.gas)
  if (params.nonce !== undefined) txParams.nonce = toHex(BigInt(params.nonce))
  if (params.maxFeePerGas !== undefined) txParams.maxFeePerGas = toHex(params.maxFeePerGas)
  if (params.maxPriorityFeePerGas !== undefined) {
    txParams.maxPriorityFeePerGas = toHex(params.maxPriorityFeePerGas)
  }

  try {
    const send = beginWalletSend(() => {
      params.onRequestStart?.()
      try {
        return provider.request({ method: 'eth_sendTransaction', params: [txParams] })
      } catch (error) {
        params.onRequestSyncError?.(error)
        throw error
      }
    })
    const hash = await send.result
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) {
      throw new Error('Wallet returned an invalid transaction hash')
    }
    return hash as `0x${string}`
  } catch (error: any) {
    const message = error?.message || String(error)
    if (/already pending|Request is already pending/i.test(message)) {
      throw new Error(
        'WALLET_PENDING: MetaMask has a pending request. Open the MetaMask extension, approve or reject it, then retry.'
      )
    }
    throw error
  }
}

export async function warmUpInjected(chainId: number): Promise<void> {
  const provider = getInjectedProvider()
  if (!provider) return
  await wakeInjected(provider)
  await ensureChain(provider, chainId)
}

async function ensureChain(provider: InjectedProvider, chainId: number): Promise<void> {
  try {
    const current = await withTimeout(provider.request({ method: 'eth_chainId' }), 6000, 'chainId')
    if (parseChainId(current) === chainId) return
    await withTimeout(
      provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }]
      }),
      30000,
      'switchChain'
    )
  } catch {
    // Pre-warming is best-effort; the authoritative send path validates the chain.
  }
}
