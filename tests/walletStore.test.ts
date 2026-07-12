import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const walletApi = vi.hoisted(() => ({
  initWallet: vi.fn(),
  smartConnect: vi.fn(),
  onAccountChange: vi.fn(),
  currentAccount: vi.fn(),
  switchToChain: vi.fn(),
  chainIdToKey: { 1: 'eth', 137: 'polygon' } as Record<number, 'eth' | 'polygon'>
}))

const rpc = vi.hoisted(() => ({
  getCode: vi.fn(),
  ensureHealthyReadProvider: vi.fn()
}))

vi.mock('@/core/wallet', () => walletApi)
vi.mock('@/core/rpc', () => ({
  ensureHealthyReadProvider: rpc.ensureHealthyReadProvider
}))

import { useWalletStore } from '@/stores/walletStore'

const walletA = '0x0000000000000000000000000000000000000001'
const walletB = '0x0000000000000000000000000000000000000002'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('wallet store request invalidation', () => {
  let stateListener: ((address?: string, chainId?: number) => void | Promise<void>) | undefined

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    walletApi.initWallet.mockResolvedValue(undefined)
    walletApi.smartConnect.mockResolvedValue('connected')
    walletApi.switchToChain.mockResolvedValue(undefined)
    walletApi.currentAccount.mockReturnValue({})
    rpc.getCode.mockResolvedValue('0x')
    rpc.ensureHealthyReadProvider.mockResolvedValue({ getCode: rpc.getCode })
    stateListener = undefined
    walletApi.onAccountChange.mockImplementation((listener) => {
      stateListener = listener
      return vi.fn()
    })
  })

  it('reflects authorized state published by init without reading a stale snapshot', async () => {
    rpc.getCode.mockResolvedValue('0x')
    walletApi.initWallet.mockImplementation(async () => {
      await stateListener?.(walletA, 137)
    })
    const store = useWalletStore()

    await store.init()

    expect(store.address).toBe(walletA)
    expect(store.chainId).toBe(137)
    expect(store.ready).toBe(true)
    expect(store.contractWalletChecked).toBe(true)
    expect(rpc.ensureHealthyReadProvider).toHaveBeenCalledWith('polygon')
    expect(walletApi.currentAccount).not.toHaveBeenCalled()
  })

  it('updates connected state from the wallet notification without an emitted event', async () => {
    rpc.getCode.mockResolvedValue('0x')
    walletApi.smartConnect.mockImplementation(async () => {
      await stateListener?.(walletA, 1)
      return 'connected'
    })
    const store = useWalletStore()
    await store.init()

    await store.connect()

    expect(store.address).toBe(walletA)
    expect(store.chainId).toBe(1)
    expect(walletApi.currentAccount).not.toHaveBeenCalled()
  })

  it('updates switched chain state from the wallet notification without an emitted event', async () => {
    rpc.getCode.mockResolvedValue('0x')
    walletApi.switchToChain.mockImplementation(async () => {
      await stateListener?.(walletA, 137)
    })
    const store = useWalletStore()
    await store.init()
    await store.applyAccount(walletA, 1)

    await store.switchChain('polygon')

    expect(store.address).toBe(walletA)
    expect(store.chainId).toBe(137)
    expect(store.switchingChain).toBe(false)
    expect(walletApi.currentAccount).not.toHaveBeenCalled()
  })

  it('coalesces concurrent initialization and installs one state subscription', async () => {
    const initialization = deferred<void>()
    walletApi.initWallet.mockReturnValue(initialization.promise)
    const store = useWalletStore()

    const first = store.init()
    const second = store.init()

    expect(walletApi.onAccountChange).toHaveBeenCalledTimes(1)
    expect(walletApi.initWallet).toHaveBeenCalledTimes(1)

    initialization.resolve()
    await Promise.all([first, second])
    expect(store.ready).toBe(true)
  })

  it('ignores stale contract-wallet detection after account and chain change', async () => {
    const oldDetection = deferred<string>()
    rpc.getCode.mockImplementation((address: string) => {
      if (address === walletA) return oldDetection.promise
      return Promise.resolve('0x')
    })
    const store = useWalletStore()

    const oldApply = store.applyAccount(walletA, 1)
    await store.applyAccount(walletB, 137)
    oldDetection.resolve('0x6001600055')
    await oldApply

    expect(store.address).toBe(walletB)
    expect(store.chainId).toBe(137)
    expect(store.isContractWallet).toBe(false)
  })

  it('does not treat an RPC failure as a verified EOA result', async () => {
    rpc.ensureHealthyReadProvider.mockRejectedValueOnce(new Error('RPC_UNAVAILABLE'))
    const store = useWalletStore()

    await store.applyAccount(walletA, 1)

    expect(store.isContractWallet).toBe(false)
    expect(store.contractWalletChecked).toBe(false)
  })

  it('does not let an old switch rejection clear or overwrite a newer switch', async () => {
    rpc.getCode.mockResolvedValue('0x')
    const oldSwitch = deferred<void>()
    const newSwitch = deferred<void>()
    walletApi.switchToChain
      .mockReturnValueOnce(oldSwitch.promise)
      .mockReturnValueOnce(newSwitch.promise)
    walletApi.currentAccount.mockReturnValue({ address: walletB, chainId: 1 })
    const store = useWalletStore()
    await store.applyAccount(walletA, 1)

    const oldResult = store.switchChain('polygon')
    expect(store.switchingChain).toBe(true)

    await store.applyAccount(walletB, 137)
    const newResult = store.switchChain('eth')
    expect(store.switchingChain).toBe(true)

    oldSwitch.reject(new Error('old switch rejected'))
    await expect(oldResult).rejects.toThrow('old switch rejected')
    expect(store.address).toBe(walletB)
    expect(store.chainId).toBe(137)
    expect(store.switchError).toBeNull()
    expect(store.switchingChain).toBe(true)

    newSwitch.resolve()
    await newResult
    expect(store.switchingChain).toBe(false)
    expect(store.switchError).toBeNull()
  })
})
