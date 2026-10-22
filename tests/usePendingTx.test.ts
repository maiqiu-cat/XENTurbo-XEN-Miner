// @vitest-environment happy-dom

import { effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshPendingOps, trackPendingTxHash } from '../src/core/pendingOps'
import { usePendingTx } from '../src/composables/usePendingTx'

vi.mock('../src/core/pendingOps', () => ({
  canMarkPendingOpDropped: vi.fn(),
  markPendingOpDropped: vi.fn(),
  refreshPendingOps: vi.fn(),
  trackPendingTxHash: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('usePendingTx', () => {
  it('refreshes mining inventory when manual Track authenticates an already mined record', async () => {
    const wallet = '0x0000000000000000000000000000000000000001'
    const record = {
      id: 'tracked',
      chain: 'eth',
      wallet,
      op: 'CLAIM',
      ids: [1],
      count: 0,
      term: 0,
      txHash: `0x${'a'.repeat(64)}`,
      nonce: 0,
      phase: 'confirmed',
      status: 'confirmed',
      label: 'Claim',
      detail: '',
      explorerUrl: 'https://etherscan.io/',
      submittedAt: Date.now(),
      updatedAt: Date.now()
    } as const
    vi.mocked(trackPendingTxHash).mockResolvedValue({ ...record, ids: [1] })
    vi.mocked(refreshPendingOps).mockResolvedValue({
      views: [],
      pendingNonceGap: 0,
      unresolvedCount: 0,
      confirmedOps: []
    })
    const onConfirmed = vi.fn()
    const scope = effectScope()
    const state = scope.run(() =>
      usePendingTx(
        () => wallet,
        () => 'eth',
        onConfirmed
      )
    )!
    await state.trackHash(record.txHash)
    expect(onConfirmed).toHaveBeenCalledWith([{ ...record, ids: [1] }])
    scope.stop()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
  })

  it('uses a slower polling interval while the account has no pending work', async () => {
    vi.useFakeTimers()
    vi.mocked(refreshPendingOps).mockResolvedValue({
      views: [],
      pendingNonceGap: 0,
      unresolvedCount: 0,
      confirmedOps: []
    })
    const address = ref('0x0000000000000000000000000000000000000001')
    const chain = ref<'eth'>('eth')
    const scope = effectScope()
    scope.run(() =>
      usePendingTx(
        () => address.value,
        () => chain.value
      )
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(refreshPendingOps).toHaveBeenCalledTimes(1)
    expect(refreshPendingOps).toHaveBeenLastCalledWith(
      'eth',
      '0x0000000000000000000000000000000000000001',
      expect.objectContaining({ freshRpc: false, signal: expect.any(AbortSignal) })
    )
    await vi.advanceTimersByTimeAsync(29_999)
    expect(refreshPendingOps).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refreshPendingOps).toHaveBeenCalledTimes(2)

    scope.stop()
    vi.useRealTimers()
  })

  it('pauses polling while hidden and refreshes when the page becomes visible', async () => {
    vi.mocked(refreshPendingOps).mockResolvedValue({
      views: [],
      pendingNonceGap: 0,
      unresolvedCount: 0,
      confirmedOps: []
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    const address = ref('0x0000000000000000000000000000000000000001')
    const chain = ref<'eth'>('eth')
    const scope = effectScope()
    scope.run(() =>
      usePendingTx(
        () => address.value,
        () => chain.value
      )
    )

    await nextTick()
    expect(refreshPendingOps).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(refreshPendingOps).toHaveBeenCalledTimes(1))

    scope.stop()
  })

  it('ignores an in-flight refresh after the wallet disconnects', async () => {
    const refresh = deferred<Awaited<ReturnType<typeof refreshPendingOps>>>()
    vi.mocked(refreshPendingOps).mockReturnValueOnce(refresh.promise)
    const address = ref<string | null>('0x0000000000000000000000000000000000000001')
    const chain = ref<'eth' | null>('eth')
    const scope = effectScope()
    const state = scope.run(() =>
      usePendingTx(
        () => address.value,
        () => chain.value
      )
    )!

    await vi.waitFor(() => expect(refreshPendingOps).toHaveBeenCalledTimes(1))
    address.value = null
    await nextTick()

    refresh.resolve({
      views: [
        {
          id: 'stale-op',
          chain: 'eth',
          wallet: '0x0000000000000000000000000000000000000001',
          op: 'CLAIM',
          ids: [1],
          count: 0,
          term: 0,
          txHash: '',
          nonce: 1,
          phase: 'broadcast',
          submittedAt: 0,
          updatedAt: 0,
          label: 'Claim',
          detail: '',
          explorerUrl: 'https://etherscan.io/',
          status: 'pending'
        }
      ],
      pendingNonceGap: 1,
      unresolvedCount: 1,
      confirmedOps: []
    })
    await refresh.promise
    await nextTick()

    expect(state.pendingCount.value).toBe(0)
    expect(state.localUnresolvedCount.value).toBe(0)
    expect(state.ops.value).toEqual([])
    expect(state.checking.value).toBe(false)

    scope.stop()
  })

  it.each(['wallet', 'chain'] as const)(
    'immediately removes the old pending display when %s changes',
    async (kind) => {
      const walletA = '0x0000000000000000000000000000000000000001'
      const oldView = {
        id: 'old-account-op',
        chain: 'eth' as const,
        wallet: walletA,
        op: 'CLAIM' as const,
        ids: [1],
        count: 0,
        term: 0,
        txHash: '',
        nonce: 1,
        phase: 'broadcast' as const,
        submittedAt: 0,
        updatedAt: 0,
        label: 'Claim',
        detail: '',
        explorerUrl: 'https://etherscan.io/',
        status: 'pending' as const
      }
      vi.mocked(refreshPendingOps)
        .mockResolvedValueOnce({
          views: [oldView],
          pendingNonceGap: 1,
          unresolvedCount: 1,
          confirmedOps: []
        })
        .mockRejectedValueOnce(new Error('new context RPC is unavailable'))
      const address = ref(walletA)
      const chain = ref<'eth' | 'polygon'>('eth')
      const scope = effectScope()
      const state = scope.run(() =>
        usePendingTx(
          () => address.value,
          () => chain.value
        )
      )!
      await vi.waitFor(() => expect(state.ops.value).toHaveLength(1))
      expect(state.lastCheckedAt.value).not.toBeNull()
      if (kind === 'wallet') address.value = '0x0000000000000000000000000000000000000002'
      else chain.value = 'polygon'
      expect(state.ops.value).toEqual([])
      expect(state.pendingCount.value).toBe(0)
      expect(state.localUnresolvedCount.value).toBe(0)
      expect(state.lastCheckedAt.value).toBeNull()
      expect(state.ready.value).toBe(false)
      await vi.waitFor(() => expect(state.error.value).toContain('new context RPC is unavailable'))
      await expect(state.markDropped(oldView.id)).rejects.toThrow('Only an unresolved transaction')
      expect(state.ops.value).toEqual([])
      expect(state.ready.value).toBe(false)
      scope.stop()
    }
  )

  it('keeps slow checks single-flight and performs one trailing refresh', async () => {
    const first = deferred<Awaited<ReturnType<typeof refreshPendingOps>>>()
    const second = deferred<Awaited<ReturnType<typeof refreshPendingOps>>>()
    vi.mocked(refreshPendingOps)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const address = ref('0x0000000000000000000000000000000000000001')
    const chain = ref<'eth'>('eth')
    const scope = effectScope()
    const state = scope.run(() =>
      usePendingTx(
        () => address.value,
        () => chain.value
      )
    )!

    await vi.waitFor(() => expect(refreshPendingOps).toHaveBeenCalledTimes(1))
    const overlappingA = state.check()
    const overlappingB = state.check()
    expect(refreshPendingOps).toHaveBeenCalledTimes(1)

    first.resolve({ views: [], pendingNonceGap: 0, unresolvedCount: 0, confirmedOps: [] })
    await Promise.all([first.promise, overlappingA, overlappingB])
    await vi.waitFor(() => expect(refreshPendingOps).toHaveBeenCalledTimes(2))

    second.resolve({ views: [], pendingNonceGap: 0, unresolvedCount: 0, confirmedOps: [] })
    await second.promise
    scope.stop()
  })

  it('blocks an unknown scope and a failed retry until reconciliation succeeds', async () => {
    const retry = deferred<Awaited<ReturnType<typeof refreshPendingOps>>>()
    vi.mocked(refreshPendingOps)
      .mockResolvedValueOnce({
        views: [],
        pendingNonceGap: 0,
        unresolvedCount: 0,
        confirmedOps: []
      })
      .mockRejectedValueOnce(new Error('wallet nonce unavailable'))
      .mockReturnValueOnce(retry.promise)
    const scope = effectScope()
    const state = scope.run(() =>
      usePendingTx(
        () => '0x0000000000000000000000000000000000000001',
        () => 'eth'
      )
    )!
    expect(state.ready.value).toBe(false)
    await vi.waitFor(() => expect(state.ready.value).toBe(true))
    await state.check()
    expect(state.ready.value).toBe(false)
    const checking = state.check()
    expect(state.error.value).toBeNull()
    expect(state.ready.value).toBe(false)
    retry.resolve({ views: [], pendingNonceGap: 0, unresolvedCount: 0, confirmedOps: [] })
    await checking
    expect(state.ready.value).toBe(true)
    scope.stop()
  })

  it('coalesces synchronous wallet and chain changes without checking an intermediate scope', async () => {
    vi.mocked(refreshPendingOps).mockResolvedValue({
      views: [],
      pendingNonceGap: 0,
      unresolvedCount: 0,
      confirmedOps: []
    })
    const address = ref('0x0000000000000000000000000000000000000001')
    const chain = ref<'eth' | 'polygon'>('eth')
    const scope = effectScope()
    const state = scope.run(() =>
      usePendingTx(
        () => address.value,
        () => chain.value
      )
    )!
    await vi.waitFor(() => expect(state.ready.value).toBe(true))
    vi.mocked(refreshPendingOps).mockClear()
    address.value = '0x0000000000000000000000000000000000000002'
    chain.value = 'polygon'
    expect(state.ready.value).toBe(false)
    expect(refreshPendingOps).not.toHaveBeenCalled()
    await nextTick()
    expect(refreshPendingOps).toHaveBeenCalledTimes(1)
    expect(refreshPendingOps).toHaveBeenCalledWith('polygon', address.value, expect.any(Object))
    scope.stop()
  })

  it.each(['wallet', 'chain'] as const)(
    'restarts recurring checks after a synchronous %s round trip',
    async (kind) => {
      vi.useFakeTimers()
      const empty = { views: [], pendingNonceGap: 0, unresolvedCount: 0, confirmedOps: [] }
      vi.mocked(refreshPendingOps).mockReset().mockResolvedValue(empty)
      const wallet = '0x0000000000000000000000000000000000000001'
      const address = ref<string | null>(wallet)
      const chain = ref<'eth' | 'polygon'>('eth')
      const scope = effectScope()
      const state = scope.run(() =>
        usePendingTx(
          () => address.value,
          () => chain.value
        )
      )!
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(state.ready.value).toBe(true)
        vi.mocked(refreshPendingOps).mockClear()
        if (kind === 'wallet') {
          address.value = null
          address.value = wallet
        } else {
          chain.value = 'polygon'
          chain.value = 'eth'
        }
        expect(state.ready.value).toBe(false)
        await nextTick()
        await vi.advanceTimersByTimeAsync(0)
        expect(refreshPendingOps).toHaveBeenCalledTimes(1)
        expect(state.ready.value).toBe(true)
        await state.check()
        expect(refreshPendingOps).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(refreshPendingOps).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(refreshPendingOps).toHaveBeenCalledTimes(4)
      } finally {
        scope.stop()
        vi.useRealTimers()
      }
    }
  )

  it('notifies the mining inventory after delayed confirmation is authenticated', async () => {
    const confirmed = {
      id: 'confirmed',
      chain: 'eth',
      wallet: '0x0000000000000000000000000000000000000001',
      op: 'CLAIM',
      ids: [1],
      count: 0,
      term: 0,
      txHash: `0x${'a'.repeat(64)}`,
      nonce: 0,
      phase: 'confirmed',
      submittedAt: Date.now(),
      updatedAt: Date.now()
    } as const
    vi.mocked(refreshPendingOps).mockResolvedValue({
      views: [],
      pendingNonceGap: 0,
      unresolvedCount: 0,
      confirmedOps: [{ ...confirmed, ids: [1] }]
    })
    const onConfirmed = vi.fn()
    const scope = effectScope()
    scope.run(() =>
      usePendingTx(
        () => confirmed.wallet,
        () => 'eth',
        onConfirmed
      )
    )
    await vi.waitFor(() => expect(onConfirmed).toHaveBeenCalledWith([{ ...confirmed, ids: [1] }]))
    scope.stop()
  })
})
