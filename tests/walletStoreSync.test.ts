import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Eip1193Request } from '../src/core/eip1193'
import { READ_TIMEOUT_MS } from '../src/core/readDeadline'

const ACCOUNT = '0x0000000000000000000000000000000000000001'

const rpc = vi.hoisted(() => ({
  getCode: vi.fn(),
  ensureHealthyReadProvider: vi.fn()
}))

vi.mock('@/core/rpc', () => ({
  getRpcGeneration: () => 0,
  ensureHealthyReadProvider: rpc.ensureHealthyReadProvider,
  withRetry: (read: () => Promise<unknown>) => read()
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
    vi.useRealTimers()
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

  it.each(['eth_accounts', 'eth_chainId'])(
    'recovers from a stalled initial %s read without applying its late result',
    async (method) => {
      vi.useFakeTimers()
      const provider = new SilentInjectedProvider()
      const request = provider.request.getMockImplementation()!
      let resolveLate!: (value: unknown) => void
      let stalled = true
      provider.request.mockImplementation((params) => {
        if (params.method === method && stalled) {
          return new Promise((resolve) => {
            resolveLate = resolve
          })
        }
        return request(params)
      })
      installProvider(provider)
      const store = await loadStore()
      const initialization = store.init()

      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
      expect(store.ready).toBe(true)
      expect(store.connectError).toContain('Wallet connection read timed out.')
      expect(store.connectError).toContain(
        `${method === 'eth_accounts' ? 'Initial wallet accounts' : 'Initial wallet network'} exceeded 15000 ms.`
      )
      expect(store.connectError).toContain('retry Connect Wallet')
      expect(store.connectError).not.toContain('READ_TIMEOUT')
      await initialization

      stalled = false
      provider.requestedAccounts = ['0x0000000000000000000000000000000000000002']
      provider.chainId = '0x89'
      await store.connect()
      resolveLate(method === 'eth_accounts' ? [ACCOUNT] : '0x1')
      await Promise.resolve()

      expect(store.address).toBe(provider.requestedAccounts[0])
      expect(store.chainId).toBe(137)
      expect(store.contractWalletChecked).toBe(true)
      expect(store.connectError).toBeNull()
    }
  )

  it('keeps a timed-out wallet type unchecked and allows a safe recheck', async () => {
    vi.useFakeTimers()
    let resolveLate!: (value: string) => void
    rpc.getCode.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveLate = resolve
      })
    )
    installProvider(new SilentInjectedProvider())
    const store = await loadStore()
    const initialization = store.init()

    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
    expect(store.ready).toBe(true)
    expect(store.contractWalletChecked).toBe(false)
    expect(store.contractWalletChecking).toBe(false)
    expect(store.contractWalletError).toContain('timed out')
    await initialization

    await store.detectContractWallet(ACCOUNT, 1)
    resolveLate('0x6001600055')
    await Promise.resolve()

    expect(store.contractWalletChecked).toBe(true)
    expect(store.isContractWallet).toBe(false)
    expect(store.contractWalletError).toBeNull()
  })

  it('shows the connected-network timeout and recovers without applying the late network', async () => {
    vi.useFakeTimers()
    const provider = new SilentInjectedProvider()
    provider.accounts = []
    installProvider(provider)
    const store = await loadStore()
    await store.init()
    const request = provider.request.getMockImplementation()!
    let resolveLate!: (value: unknown) => void
    provider.request.mockImplementation((params) =>
      params.method === 'eth_chainId'
        ? new Promise((resolve) => {
            resolveLate = resolve
          })
        : request(params)
    )
    const connecting = store.connect()
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    await connecting
    expect(store.address).toBeNull()
    expect(store.connectError).toContain('Connected wallet network exceeded 15000 ms.')
    expect(store.connectError).toContain('retry Connect Wallet')
    expect(store.connectError).not.toContain('READ_TIMEOUT')
    provider.request.mockImplementation(request)
    await store.connect()
    resolveLate('0x89')
    await Promise.resolve()
    expect(store.address).toBe(ACCOUNT)
    expect(store.chainId).toBe(1)
    expect(store.connectError).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['init', 'connect'] as const)(
    'does not display remote timeout text or forged local metadata during %s',
    async (action) => {
      const provider = new SilentInjectedProvider()
      provider.accounts = []
      installProvider(provider)
      const store = await loadStore()
      if (action === 'connect') await store.init()
      provider.request.mockRejectedValue(
        Object.assign(new Error('READ_TIMEOUT: https://rpc.example/private?key=fixture-secret'), {
          name: 'ReadTimeoutError',
          label: 'Remote label',
          timeoutMs: 10
        })
      )
      await store[action]()
      expect(store.connectError).toBe(
        'Wallet connection read timed out. Open your wallet extension, check network access, then retry Connect Wallet.'
      )
      expect(store.address).toBeNull()
    }
  )

  it('preserves connection rejection messaging and allows the next connection', async () => {
    const provider = new SilentInjectedProvider()
    provider.accounts = []
    installProvider(provider)
    const store = await loadStore()
    await store.init()
    provider.request.mockRejectedValueOnce(
      Object.assign(new Error('User rejected'), { code: 4001 })
    )
    await store.connect()
    expect(store.connectError).toBe('Connection request rejected.')
    await store.connect()
    expect(store.address).toBe(ACCOUNT)
    expect(store.connectError).toBeNull()
  })
})
