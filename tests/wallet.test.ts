import { Interface } from 'ethers'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Eip1193Request } from '../src/core/eip1193'

const ACCOUNT_A = '0x0000000000000000000000000000000000000001'
const ACCOUNT_B = '0x0000000000000000000000000000000000000002'
const FACTORY = '0x0000000000000000000000000000000000000003' as const
const TX_HASH = `0x${'a'.repeat(64)}`

type Listener = (...args: unknown[]) => void

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class MockInjectedProvider {
  accounts = [ACCOUNT_A]
  chainId = '0x1'
  readonly failures = new Map<string, Error>()
  readonly listeners = new Map<string, Set<Listener>>()

  request = vi.fn(async ({ method, params }: Eip1193Request): Promise<unknown> => {
    const failure = this.failures.get(method)
    if (failure) throw failure

    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [...this.accounts]
    if (method === 'eth_chainId') return this.chainId
    if (method === 'wallet_switchEthereumChain') {
      const target = (params?.[0] as { chainId?: string } | undefined)?.chainId
      if (!target) throw new Error('Missing chain id')
      this.chainId = target
      return null
    }
    if (method === 'eth_sendTransaction') return TX_HASH
    throw new Error(`Unexpected method: ${method}`)
  })

  on = vi.fn((event: string, listener: Listener) => {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  })

  removeListener = vi.fn((event: string, listener: Listener) => {
    this.listeners.get(event)?.delete(listener)
  })

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function installProvider(provider: MockInjectedProvider) {
  vi.stubGlobal('window', { ethereum: provider })
}

async function loadWallet() {
  return import('../src/core/wallet')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('injected wallet integration', () => {
  it('loads the initial account and chain directly from the injected provider', async () => {
    const provider = new MockInjectedProvider()
    provider.chainId = '0x89'
    installProvider(provider)
    const { currentAccount, initWallet } = await loadWallet()

    await initWallet()

    expect(currentAccount()).toEqual({ address: ACCOUNT_A, chainId: 137 })
    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_accounts' })
    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_chainId' })
  })

  it('merges a chain event that arrives while initial account state is loading', async () => {
    const provider = new MockInjectedProvider()
    const accounts = deferred<string[]>()
    provider.request.mockImplementation(async ({ method }: Eip1193Request) => {
      if (method === 'eth_accounts') return accounts.promise
      if (method === 'eth_chainId') return '0x1'
      throw new Error(`Unexpected method: ${method}`)
    })
    installProvider(provider)
    const { currentAccount, initWallet, onAccountChange } = await loadWallet()
    const changed = vi.fn()
    onAccountChange(changed)

    const initializing = initWallet()
    provider.emit('chainChanged', '0x89')
    accounts.resolve([ACCOUNT_A])
    await initializing

    expect(currentAccount()).toEqual({ address: ACCOUNT_A, chainId: 137 })
  })

  it('connects with eth_requestAccounts and has no modal fallback', async () => {
    const provider = new MockInjectedProvider()
    installProvider(provider)
    const { currentAccount, smartConnect } = await loadWallet()

    await expect(smartConnect()).resolves.toBe('connected')

    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' })
    expect(currentAccount()).toEqual({ address: ACCOUNT_A, chainId: 1 })
  })

  it('reports no wallet without attempting a remote connector', async () => {
    vi.stubGlobal('window', {})
    const { smartConnect } = await loadWallet()

    await expect(smartConnect()).resolves.toBe('no-wallet')
  })

  it('propagates account, chain, and disconnect events and can unsubscribe', async () => {
    const provider = new MockInjectedProvider()
    installProvider(provider)
    const { initWallet, onAccountChange } = await loadWallet()
    await initWallet()
    const changed = vi.fn()

    const unsubscribe = onAccountChange(changed)
    provider.accounts = [ACCOUNT_B]
    provider.emit('accountsChanged', [ACCOUNT_B])
    provider.emit('chainChanged', '0x89')
    provider.emit('disconnect', { code: 4900, message: 'Disconnected' })

    expect(changed).toHaveBeenNthCalledWith(1, ACCOUNT_B, 1)
    expect(changed).toHaveBeenNthCalledWith(2, ACCOUNT_B, 137)
    expect(changed).toHaveBeenNthCalledWith(3, undefined, undefined)

    unsubscribe()
    expect(provider.removeListener).toHaveBeenCalledTimes(3)
  })

  it('preserves a rejected connect request', async () => {
    const provider = new MockInjectedProvider()
    provider.failures.set('eth_requestAccounts', Object.assign(new Error('User rejected'), { code: 4001 }))
    installProvider(provider)
    const { smartConnect } = await loadWallet()

    await expect(smartConnect()).rejects.toThrow('User rejected')
  })

  it('switches chain directly and preserves a rejected switch request', async () => {
    const provider = new MockInjectedProvider()
    installProvider(provider)
    const { switchToChain } = await loadWallet()

    await switchToChain('polygon')
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x89' }]
    })

    provider.failures.set(
      'wallet_switchEthereumChain',
      Object.assign(new Error('Switch rejected'), { code: 4001 })
    )
    await expect(switchToChain('eth')).rejects.toThrow('Switch rejected')
  })

  it('encodes and sends transaction parameters directly through eth_sendTransaction', async () => {
    const provider = new MockInjectedProvider()
    installProvider(provider)
    const { writeFactory } = await loadWallet()
    const abi = ['function bulkClaimRank(uint256 term, uint256 count)']

    await expect(
      writeFactory({
        chainId: 1,
        address: FACTORY,
        abi,
        functionName: 'bulkClaimRank',
        args: [100n, 2n],
        value: 5n,
        gas: 120_000n,
        nonce: 9,
        maxFeePerGas: 30n,
        maxPriorityFeePerGas: 4n,
        expectedFrom: ACCOUNT_A
      })
    ).resolves.toBe(TX_HASH)

    const data = new Interface(abi).encodeFunctionData('bulkClaimRank', [100n, 2n])
    expect(provider.request).toHaveBeenLastCalledWith({
      method: 'eth_sendTransaction',
      params: [
        {
          from: ACCOUNT_A,
          to: FACTORY,
          data,
          value: '0x5',
          gas: '0x1d4c0',
          nonce: '0x9',
          maxFeePerGas: '0x1e',
          maxPriorityFeePerGas: '0x4'
        }
      ]
    })
  })
})
