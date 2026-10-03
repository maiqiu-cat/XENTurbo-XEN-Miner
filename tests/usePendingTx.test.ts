// @vitest-environment happy-dom

import { effectScope, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshPendingOps } from '../src/core/pendingOps'
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
