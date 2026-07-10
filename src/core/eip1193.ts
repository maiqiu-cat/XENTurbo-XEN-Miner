export interface Eip1193Request {
  method: string
  params?: unknown[]
}

export interface InjectedProvider {
  request(args: Eip1193Request): Promise<unknown>
  isMetaMask?: boolean
  providers?: InjectedProvider[]
  on?(event: 'accountsChanged' | 'chainChanged' | 'disconnect', listener: (...args: unknown[]) => void): void
  removeListener?(
    event: 'accountsChanged' | 'chainChanged' | 'disconnect',
    listener: (...args: unknown[]) => void
  ): void
}

export type WalletSendState = 'awaiting-wallet' | 'broadcast' | 'failed'

export interface WalletSend<T> {
  state(): WalletSendState
  result: Promise<T>
}

/** Resolve the browser-injected provider, preferring MetaMask when several exist. */
export function getInjectedProvider(): InjectedProvider | undefined {
  if (typeof window === 'undefined') return undefined
  const ethereum = (window as Window & { ethereum?: InjectedProvider }).ethereum
  if (!ethereum) return undefined
  if (Array.isArray(ethereum.providers)) {
    return ethereum.providers.find((provider: InjectedProvider) => provider.isMetaMask) ?? ethereum.providers[0]
  }
  return ethereum
}

function requireInjectedProvider(): InjectedProvider {
  const provider = getInjectedProvider()
  if (!provider) throw new Error('No injected wallet found')
  return provider
}

function parseQuantity(value: unknown, label: string): number {
  let parsed: bigint
  try {
    if (typeof value === 'bigint') parsed = value
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value)
    else if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) parsed = BigInt(value)
    else throw new Error('invalid quantity')
  } catch {
    throw new Error(`Invalid ${label} returned by injected wallet`)
  }

  const result = Number(parsed)
  if (parsed < 0n || !Number.isSafeInteger(result)) {
    throw new Error(`Invalid ${label} returned by injected wallet`)
  }
  return result
}

export async function getInjectedAccount(): Promise<string | undefined> {
  const accounts = await requireInjectedProvider().request({ method: 'eth_accounts' })
  if (!Array.isArray(accounts)) throw new Error('Invalid account list returned by injected wallet')
  const account = accounts[0]
  return typeof account === 'string' && account ? account : undefined
}

export async function getInjectedChainId(): Promise<number> {
  const chainId = await requireInjectedProvider().request({ method: 'eth_chainId' })
  return parseQuantity(chainId, 'chain id')
}

export async function getInjectedPendingNonce(address: string): Promise<number> {
  const nonce = await requireInjectedProvider().request({
    method: 'eth_getTransactionCount',
    params: [address, 'pending']
  })
  return parseQuantity(nonce, 'pending nonce')
}

export function assertNonceAgreement(walletNonce: number, rpcNonce: number): number {
  if (!Number.isSafeInteger(walletNonce) || !Number.isSafeInteger(rpcNonce) || walletNonce < 0 || rpcNonce < 0) {
    throw new Error('PENDING_STATE_UNCERTAIN: Invalid pending nonce returned by wallet or read RPC.')
  }
  if (walletNonce !== rpcNonce) {
    throw new Error(
      `PENDING_STATE_UNCERTAIN: Wallet pending nonce ${walletNonce} disagrees with read RPC pending nonce ${rpcNonce}.`
    )
  }
  return walletNonce
}

/** Track a non-cancellable wallet request without imposing a synthetic timeout. */
export function beginWalletSend<T>(request: () => Promise<T>): WalletSend<T> {
  let current: WalletSendState = 'awaiting-wallet'
  let requested: Promise<T>
  try {
    requested = Promise.resolve(request())
  } catch (error) {
    current = 'failed'
    requested = Promise.reject(error)
  }

  const result = requested.then(
    (value) => {
      current = 'broadcast'
      return value
    },
    (error) => {
      current = 'failed'
      throw error
    }
  )

  return { state: () => current, result }
}
