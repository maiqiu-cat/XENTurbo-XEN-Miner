// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  attachTxHash,
  broadcastLockedIds,
  lockedIds,
  pendingLocks,
  tryAcquireLock
} from '@/core/localLock'
import { useVmuStore } from '@/stores/vmuStore'

const WALLET = '0x0000000000000000000000000000000000000001'
const OTHER = '0x0000000000000000000000000000000000000002'
const HASH = `0x${'a'.repeat(64)}`
const metadata = {
  chain: 'eth' as const,
  wallet: WALLET,
  ids: [1],
  op: 'CLAIM' as const,
  count: 0,
  term: 0
}
beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})
describe('broadcast lock recovery', () => {
  it('keeps unsigned expiry but reconstructs an expired and pruned broadcast reservation', () => {
    expect(tryAcquireLock({ ...metadata, batch: 'late' })).toBe(true)
    vi.advanceTimersByTime(119_999)
    expect(lockedIds('eth', WALLET)).toEqual(new Set([1]))
    vi.advanceTimersByTime(1)
    expect(lockedIds('eth', WALLET).size).toBe(0)
    tryAcquireLock({ ...metadata, wallet: OTHER, batch: 'other' })
    attachTxHash('late', HASH, metadata)
    attachTxHash('late', HASH, metadata)
    expect(pendingLocks('eth', WALLET)).toEqual([
      expect.objectContaining({ batch: 'late', ids: [1], txHash: HASH })
    ])
    expect(lockedIds('eth', OTHER)).toEqual(new Set([1]))
    vi.advanceTimersByTime(7 * 86_400_000)
    expect(broadcastLockedIds('eth', WALLET)).toEqual(new Set([1]))
  })
  it('does not overwrite unrelated locks after a failed cache read', () => {
    const storage = localStorage
    tryAcquireLock({ ...metadata, wallet: OTHER, batch: 'keep' })
    const before = storage.getItem('sm.vmuLocks')
    const set = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: set
    })
    expect(() => attachTxHash('late', HASH, metadata)).toThrow('storage unavailable')
    expect(set).not.toHaveBeenCalled()
    expect(storage.getItem('sm.vmuLocks')).toBe(before)
  })
  it('scopes an upsert and never changes an existing broadcast identity', () => {
    attachTxHash('same-batch', HASH, { ...metadata, wallet: OTHER })
    attachTxHash('same-batch', HASH, metadata)
    expect(pendingLocks('eth', OTHER)).toHaveLength(1)
    expect(pendingLocks('eth', WALLET)).toHaveLength(1)
    expect(() => attachTxHash('same-batch', `0x${'b'.repeat(64)}`, metadata)).toThrow(
      'LOCK_IDENTITY_CONFLICT'
    )
    expect(pendingLocks('eth', WALLET)[0].txHash).toBe(HASH)
  })
  it('immediately invalidates cached VMU groups when a late hash restores a lock', () => {
    setActivePinia(createPinia())
    const store = useVmuStore()
    store.$patch({
      chain: 'eth',
      wallet: WALLET,
      vmus: [
        {
          id: 1,
          address: OTHER,
          status: 'CLAIMABLE',
          rank: 1,
          term: 1,
          maturityTs: 1,
          amplifier: 1,
          eaaRate: 0,
          readOk: true
        }
      ]
    })
    expect(store.groups.flatMap((group) => group.ids)).toEqual([1])
    attachTxHash('late', HASH, metadata)
    expect(store.groups).toEqual([])
    expect(store.counts.CLAIMABLE).toBe(0)
    localStorage.setItem('sm.vmuLocks', '[]')
    window.dispatchEvent(new StorageEvent('storage', { key: 'sm.vmuLocks' }))
    expect(store.groups.flatMap((group) => group.ids)).toEqual([1])
  })
})
