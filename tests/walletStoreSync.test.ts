import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Eip1193Request } from '../src/core/eip1193'

const ACCOUNT = '0x0000000000000000000000000000000000000001'

const rpc = vi.hoisted(() => ({
  getCode: vi.fn(),
  ensureHealthyReadProvider: vi.fn()
}))

vi.mock('@/core/rpc', () => ({
  ensureHealthyReadProvider: rpc.ensureHealthyReadProvider
}))

type Listener = (...args: unknown[]) => void

class SilentInjectedProvider {
  accounts: string[] = [ACCOUNT]
  requestedAccounts: string[] = [ACCOUNT]
  chainId = '0x1'
  readonly listeners = new Map<string, Set<Listener>>()

  request = vi.fn(async ({ method, params }: Eip1193Request): Promise<unknown> => {
    if (method === 'eth_accounts') return [...this.accounts]
    if (method === 'eth_requestAccounts') {
      this.accounts = [...this.requestedAccounts]
      return [...this.accounts]
    }
    if (method === 'eth_chainId') return this.chainId
    if (method === 'wallet_switchEthereumChain') {
      const target = (params?.[0] as { chainId?: string } | undefined)?.chainId
      if (!target) throw new Error('Missing chain id')
      this.chainId = target
      return null
    }
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
}

function installProvider(provider: SilentInjectedProvider) {
  vi.stubGlobal('window', { ethereum: provider })
}

async function loadStore() {
  const { useWalletStore } = await import('../src/stores/walletStore')
  return useWalletStore()
}

describe('wallet store injected state synchronization', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    rpc.getCode.mockReset().mockResolvedValue('0x')
    rpc.ensureHealthyReadProvider.mockReset().mockResolvedValue({ getCode: rpc.getCode })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('loads an authorized account and chain without provider events or duplicate listeners', async () => {
    const provider = new SilentInjectedProvider()
    provider.chainId = '0x89'
    installProvider(provider)
    const store = await loadStore()

    await Promise.all([store.init(), store.init()])

    expect(store.address).toBe(ACCOUNT)
    expect(store.chainId).toBe(137)
    expect(store.ready).toBe(true)
    expect(provider.on).toHaveBeenCalledTimes(3)
    expect(provider.request).toHaveBeenCalledTimes(2)
  })

  it('updates the store after connect succeeds without an accountsChanged event', async () => {
    const provider = new SilentInjectedProvider()
    provider.accounts = []
    installProvider(provider)
    const store = await loadStore()
    await store.init()

    await store.connect()

    expect(store.address).toBe(ACCOUNT)
    expect(store.chainId).toBe(1)
    expect(store.connectError).toBeNull()
  })

  it('updates the store after a chain switch succeeds without a chainChanged event', async () => {
    const provider = new SilentInjectedProvider()
    installProvider(provider)
    const store = await loadStore()
    await store.init()

    await store.switchChain('polygon')

    expect(store.address).toBe(ACCOUNT)
    expect(store.chainId).toBe(137)
    expect(store.switchingChain).toBe(false)
    expect(store.switchError).toBeNull()
  })
})
