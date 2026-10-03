import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Vmu, WalletSnapshot } from '@/core/types'

const chainReader = vi.hoisted(() => ({
  readVmuCount: vi.fn(),
  readGlobalRank: vi.fn(),
  readChainTimestamp: vi.fn(),
  readWalletVmus: vi.fn(),
  readVmuStates: vi.fn(),
  classifyVmuStatus: vi.fn((rank: number, maturityMs: number, chainTimestampMs: number) => {
    if (rank === 0) return 'EMPTY'
    return maturityMs + 1_000 > chainTimestampMs ? 'MINTING' : 'CLAIMABLE'
  })
}))

const snapshots = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  saveSnapshot: vi.fn(),
  clearSnapshot: vi.fn()
}))

const rpcHealth = vi.hoisted(() => ({
  ensureHealthyReadProvider: vi.fn()
}))

vi.mock('@/core/chainReader', () => chainReader)
vi.mock('@/core/idb', () => snapshots)
vi.mock('@/core/rpc', () => rpcHealth)
vi.mock('@/core/localLock', () => ({
  broadcastLockedIds: () => new Set<number>()
}))

import { useVmuStore } from '@/stores/vmuStore'

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

function mintingVmu(id = 1): Vmu {
  return {
    id,
    address: `0x${id.toString(16).padStart(40, '0')}`,
    status: 'MINTING',
    rank: 10,
    term: 100,
    maturityTs: Date.now() + 86_400_000,
    amplifier: 3000,
    eaaRate: 0,
    readOk: true
  }
}

function snapshot(wallet: string): WalletSnapshot {
  return {
    chain: 'eth',
    wallet,
    vmuCount: 1,
    vmus: [mintingVmu()],
    syncedAt: 123,
    chainTimestampMs: 100
  }
}

describe('vmu store request invalidation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    snapshots.saveSnapshot.mockResolvedValue(undefined)
    snapshots.clearSnapshot.mockResolvedValue(undefined)
    rpcHealth.ensureHealthyReadProvider.mockResolvedValue({})
    chainReader.readChainTimestamp.mockResolvedValue(Date.now())
  })

  it('checks configured RPC health before reading wallet state', async () => {
    snapshots.loadSnapshot.mockResolvedValue(null)
    chainReader.readVmuCount.mockResolvedValue(0)
    chainReader.readGlobalRank.mockResolvedValue(100)
    chainReader.readWalletVmus.mockResolvedValue([])
    const store = useVmuStore()

    await store.load('eth', walletA)

    expect(rpcHealth.ensureHealthyReadProvider).toHaveBeenCalledWith('eth')
    expect(rpcHealth.ensureHealthyReadProvider.mock.invocationCallOrder[0]).toBeLessThan(
      chainReader.readVmuCount.mock.invocationCallOrder[0]
    )
  })

  it.each([100, 1_000, 10_000])(
    'refreshes one VMU without rescanning a complete %i-VMU wallet',
    async (size) => {
      const store = useVmuStore()
      const vmus = Array.from({ length: size }, (_, index) => mintingVmu(index + 1))
      store.$patch({
        chain: 'eth',
        wallet: walletA,
        vmus,
        vmuCount: vmus.length,
        syncedAt: Date.now()
      })
      chainReader.readVmuCount.mockResolvedValue(vmus.length)
      chainReader.readGlobalRank.mockResolvedValue(200)
      chainReader.readVmuStates.mockResolvedValue([
        { ...vmus[size - 1], status: 'EMPTY', rank: 0, maturityTs: 0 }
      ])
      await store.refreshAffected([size])
      expect(chainReader.readWalletVmus).not.toHaveBeenCalled()
      expect(chainReader.readVmuStates).toHaveBeenCalledWith(
        'eth',
        walletA,
        [size],
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(store.vmus).toHaveLength(size)
      expect(store.vmus[size - 1].status).toBe('EMPTY')
      store.detach()
    }
  )

  it('falls back to a full scan when an external transaction changes the inventory', async () => {
    const store = useVmuStore()
    store.$patch({
      chain: 'eth',
      wallet: walletA,
      vmus: [mintingVmu()],
      vmuCount: 1,
      syncedAt: Date.now()
    })
    chainReader.readVmuCount.mockResolvedValue(2)
    chainReader.readGlobalRank.mockResolvedValue(200)
    chainReader.readWalletVmus.mockResolvedValue([mintingVmu(1), mintingVmu(2)])
    await store.refreshAffected([1])
    expect(chainReader.readWalletVmus).toHaveBeenCalledOnce()
    expect(store.vmuCount).toBe(2)
    store.detach()
  })

  it('serializes overlapping incremental updates without losing the first affected ids', async () => {
    const store = useVmuStore()
    store.$patch({
      chain: 'eth',
      wallet: walletA,
      vmus: [mintingVmu(1), mintingVmu(2)],
      vmuCount: 2,
      syncedAt: Date.now()
    })
    chainReader.readVmuCount.mockResolvedValue(2)
    chainReader.readGlobalRank.mockResolvedValue(200)
    const first = deferred<Vmu[]>()
    chainReader.readVmuStates
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ ...mintingVmu(2), rank: 0, maturityTs: 0, status: 'EMPTY' }])
    const a = store.refreshAffected([1])
    await vi.waitFor(() => expect(chainReader.readVmuStates).toHaveBeenCalledTimes(1))
    const b = store.refreshAffected([2])
    expect(chainReader.readVmuStates).toHaveBeenCalledTimes(1)
    first.resolve([{ ...mintingVmu(1), rank: 0, maturityTs: 0, status: 'EMPTY' }])
    await Promise.all([a, b])
    expect(chainReader.readVmuStates).toHaveBeenNthCalledWith(
      2,
      'eth',
      walletA,
      [2],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(store.vmus.map((vmu) => vmu.status)).toEqual(['EMPTY', 'EMPTY'])
    store.detach()
  })

  it('coalesces overlapping full refreshes for the same wallet and chain', async () => {
    const walletRead = deferred<Vmu[]>()
    chainReader.readVmuCount.mockResolvedValue(1)
    chainReader.readGlobalRank.mockResolvedValue(100)
    chainReader.readWalletVmus.mockReturnValue(walletRead.promise)
    const store = useVmuStore()
    store.$patch({ chain: 'eth', wallet: walletA })

    const first = store.refresh()
    const overlapping = store.refresh()
    await vi.waitFor(() => expect(chainReader.readWalletVmus).toHaveBeenCalled())

    expect(chainReader.readVmuCount).toHaveBeenCalledTimes(1)
    expect(chainReader.readWalletVmus).toHaveBeenCalledTimes(1)

    walletRead.resolve([mintingVmu()])
    await Promise.all([first, overlapping])
  })

  it('queues a requested full scan after an in-flight targeted refresh', async () => {
    const store = useVmuStore()
    const selectedRead = deferred<Vmu[]>()
    store.$patch({
      chain: 'eth',
      wallet: walletA,
      vmus: [mintingVmu()],
      vmuCount: 1,
      syncedAt: Date.now()
    })
    chainReader.readVmuCount.mockResolvedValueOnce(1).mockResolvedValue(2)
    chainReader.readGlobalRank.mockResolvedValue(100)
    chainReader.readVmuStates.mockReturnValueOnce(selectedRead.promise)
    chainReader.readWalletVmus.mockResolvedValue([mintingVmu(1), mintingVmu(2)])

    const targeted = store.refreshAffected([1])
    await vi.waitFor(() => expect(chainReader.readVmuStates).toHaveBeenCalled())
    const full = store.refresh()
    expect(chainReader.readWalletVmus).not.toHaveBeenCalled()
    selectedRead.resolve([{ ...mintingVmu(), rank: 0, maturityTs: 0, status: 'EMPTY' }])
    await Promise.all([targeted, full])

    expect(chainReader.readWalletVmus).toHaveBeenCalledOnce()
    expect(store.vmuCount).toBe(2)
    expect(store.vmus.map((vmu) => vmu.id)).toEqual([1, 2])
    expect(snapshots.saveSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ vmuCount: 2 })
    )
    store.detach()
  })

  it('queues a confirmation scan after a full scan that already captured an older count', async () => {
    const store = useVmuStore()
    const firstRead = deferred<Vmu[]>()
    store.$patch({ chain: 'eth', wallet: walletA })
    chainReader.readVmuCount.mockResolvedValueOnce(1).mockResolvedValue(2)
    chainReader.readGlobalRank.mockResolvedValue(100)
    chainReader.readWalletVmus
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue([mintingVmu(1), mintingVmu(2)])

    const earlier = store.refresh()
    await vi.waitFor(() => expect(chainReader.readWalletVmus).toHaveBeenCalledOnce())
    const confirmed = store.refresh({ afterCurrent: true })
    firstRead.resolve([mintingVmu()])
    await Promise.all([earlier, confirmed])

    expect(chainReader.readWalletVmus).toHaveBeenCalledTimes(2)
    expect(store.vmuCount).toBe(2)
    expect(store.vmus.map((vmu) => vmu.id)).toEqual([1, 2])
    store.detach()
  })

  it('does not apply a cached snapshot that resolves after detach', async () => {
    const cached = deferred<WalletSnapshot | null>()
    snapshots.loadSnapshot.mockReturnValueOnce(cached.promise)
    const store = useVmuStore()

    const loading = store.load('eth', walletA)
    store.detach()
    cached.resolve(snapshot(walletA))
    await loading

    expect(chainReader.readVmuCount).not.toHaveBeenCalled()
    expect(store.$state).toMatchObject({
      chain: null,
      wallet: null,
      vmuCount: 0,
      vmus: [],
      globalRank: 0,
      rankAvailable: false,
      syncedAt: null,
      loading: false,
      progress: { loaded: 0, total: 0 },
      error: null,
      rankError: null,
      readErrors: 0
    })
  })

  it('ignores progress, results, errors and finally updates from a refresh detached in flight', async () => {
    snapshots.loadSnapshot.mockResolvedValue(null)
    chainReader.readVmuCount.mockResolvedValue(1)
    chainReader.readGlobalRank.mockResolvedValue(100)
    const walletRead = deferred<Vmu[]>()
    let reportProgress: ((progress: { loaded: number; total: number }) => void) | undefined
    let scanSignal: AbortSignal | undefined
    chainReader.readWalletVmus.mockImplementation(
      async (
        _chain: string,
        _wallet: string,
        options: { onProgress?: typeof reportProgress; signal?: AbortSignal }
      ) => {
        reportProgress = options.onProgress
        scanSignal = options.signal
        return walletRead.promise
      }
    )
    const store = useVmuStore()

    const loading = store.load('eth', walletA)
    await vi.waitFor(() => expect(chainReader.readWalletVmus).toHaveBeenCalledOnce())
    expect(store.loading).toBe(true)

    store.detach()
    expect(scanSignal?.aborted).toBe(true)
    reportProgress?.({ loaded: 1, total: 1 })
    walletRead.reject(new Error('late RPC failure'))
    await loading

    expect(store.$state).toMatchObject({
      chain: null,
      wallet: null,
      vmuCount: 0,
      vmus: [],
      globalRank: 0,
      rankAvailable: false,
      syncedAt: null,
      loading: false,
      progress: { loaded: 0, total: 0 },
      error: null,
      rankError: null,
      readErrors: 0
    })
  })

  it('loads VMUs but never reuses the previous chain rank when the new rank read fails', async () => {
    snapshots.loadSnapshot.mockResolvedValue(null)
    chainReader.readVmuCount.mockResolvedValue(1)
    chainReader.readWalletVmus.mockResolvedValue([mintingVmu()])
    chainReader.readGlobalRank.mockImplementation(async (chain: string) => {
      if (chain === 'eth') return 100
      throw new Error('polygon rank unavailable')
    })
    const store = useVmuStore()

    await store.load('eth', walletA)
    expect(store.globalRank).toBe(100)
    expect(store.rankAvailable).toBe(true)
    expect(store.groups[0].estXen).toBeTypeOf('number')

    await store.load('polygon', walletB)

    expect(store.chain).toBe('polygon')
    expect(store.wallet).toBe(walletB)
    expect(store.vmuCount).toBe(1)
    expect(store.vmus).toHaveLength(1)
    expect(store.globalRank).toBe(0)
    expect(store.rankAvailable).toBe(false)
    expect(store.rankError).toContain('polygon rank unavailable')
    expect(store.error).toBeNull()
    expect(store.groups[0].estXen).toBeUndefined()
  })

  it('does not let an old-chain refresh overwrite a completed new-chain load', async () => {
    snapshots.loadSnapshot.mockResolvedValue(null)
    chainReader.readVmuCount.mockResolvedValue(1)
    chainReader.readGlobalRank.mockImplementation(async (chain: string) =>
      chain === 'eth' ? 100 : 200
    )
    const oldRead = deferred<Vmu[]>()
    chainReader.readWalletVmus.mockImplementation(async (chain: string) => {
      if (chain === 'eth') return oldRead.promise
      return [mintingVmu(2)]
    })
    const store = useVmuStore()

    const oldLoad = store.load('eth', walletA)
    await vi.waitFor(() => expect(chainReader.readWalletVmus).toHaveBeenCalledOnce())
    await store.load('polygon', walletB)
    const newSyncedAt = store.syncedAt

    oldRead.reject(new Error('late old-chain failure'))
    await oldLoad

    expect(store.chain).toBe('polygon')
    expect(store.wallet).toBe(walletB)
    expect(store.vmus.map((vmu) => vmu.id)).toEqual([2])
    expect(store.globalRank).toBe(200)
    expect(store.rankAvailable).toBe(true)
    expect(store.rankError).toBeNull()
    expect(store.error).toBeNull()
    expect(store.loading).toBe(false)
    expect(store.syncedAt).toBe(newSyncedAt)
  })

  it('refreshes automatically after the nearest chain maturity', async () => {
    vi.useFakeTimers()
    try {
      const chainNow = 1_000_000
      snapshots.loadSnapshot.mockResolvedValue(null)
      chainReader.readVmuCount.mockResolvedValue(1)
      chainReader.readGlobalRank.mockResolvedValue(100)
      chainReader.readChainTimestamp.mockResolvedValue(chainNow)
      chainReader.readWalletVmus
        .mockResolvedValueOnce([
          { ...mintingVmu(), maturityTs: chainNow + 2_000, status: 'MINTING' }
        ])
        .mockResolvedValueOnce([
          { ...mintingVmu(), maturityTs: chainNow + 2_000, status: 'CLAIMABLE' }
        ])
      const store = useVmuStore()

      await store.load('eth', walletA)
      expect(chainReader.readWalletVmus).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(3_500)

      expect(chainReader.readWalletVmus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rereads chain time after a long VMU scan and reclassifies the result', async () => {
    snapshots.loadSnapshot.mockResolvedValue(null)
    chainReader.readVmuCount.mockResolvedValue(1)
    chainReader.readGlobalRank.mockResolvedValue(100)
    chainReader.readChainTimestamp.mockResolvedValueOnce(1_000).mockResolvedValueOnce(5_000)
    chainReader.readWalletVmus.mockResolvedValue([
      { ...mintingVmu(), maturityTs: 3_000, status: 'MINTING' }
    ])
    const store = useVmuStore()

    await store.load('eth', walletA)

    expect(chainReader.readChainTimestamp).toHaveBeenCalledTimes(2)
    expect(store.chainTimestampMs).toBe(5_000)
    expect(store.vmus[0].status).toBe('CLAIMABLE')
  })
})
