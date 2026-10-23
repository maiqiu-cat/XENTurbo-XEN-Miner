import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCachedSnapshot } from '@/core/idb'

const validSnapshot = {
  version: 2,
  key: 'eth:0x0000000000000000000000000000000000000001',
  chain: 'eth',
  wallet: '0x0000000000000000000000000000000000000001',
  vmuCount: 1,
  vmus: [
    {
      id: 1,
      address: '0x0000000000000000000000000000000000000002',
      status: 'MINTING',
      rank: 1,
      term: 100,
      maturityTs: 2_000_000,
      amplifier: 1,
      eaaRate: 0,
      readOk: true
    }
  ],
  syncedAt: 1_000_000,
  chainTimestampMs: 1_000_000
}

const otherWallet = '0x0000000000000000000000000000000000000003'
const scopeMismatches = [
  { label: 'wrong wallet', chain: 'eth', wallet: otherWallet },
  { label: 'wrong chain', chain: 'polygon', wallet: validSnapshot.wallet },
  { label: 'wrong wallet and chain', chain: 'polygon', wallet: otherWallet }
] as const

const invalidNumbers = [
  { label: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  { label: 'fraction', value: 1.5 },
  { label: 'negative', value: -1 },
  { label: 'NaN', value: Number.NaN },
  { label: 'infinity', value: Number.POSITIVE_INFINITY }
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function installSnapshotRead(snapshot: unknown) {
  const remove = vi.fn()
  const get = vi.fn(() => {
    const request: { result: unknown; onsuccess?: () => void } = { result: snapshot }
    queueMicrotask(() => request.onsuccess?.())
    return request
  })
  const db = {
    close: vi.fn(),
    transaction: vi.fn((_store: string, mode: string) => {
      if (mode === 'readonly') return { objectStore: () => ({ get }) }
      const transaction: {
        oncomplete?: () => void
        objectStore(): { delete(key: string): void }
      } = {
        objectStore: () => ({
          delete(key) {
            remove(key)
            queueMicrotask(() => transaction.oncomplete?.())
          }
        })
      }
      return transaction
    })
  }
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => {
      const request: { result: typeof db; onsuccess?: () => void } = { result: db }
      queueMicrotask(() => request.onsuccess?.())
      return request
    })
  })
  return { get, remove }
}

describe('IndexedDB snapshot schema', () => {
  it('accepts a complete versioned snapshot', () => {
    expect(isCachedSnapshot(validSnapshot, 'eth', validSnapshot.wallet)).toBe(true)
  })

  it.each([
    { ...validSnapshot, version: 1 },
    { ...validSnapshot, vmus: undefined },
    { ...validSnapshot, vmuCount: 2 },
    { ...validSnapshot, chainTimestampMs: undefined }
  ])('rejects malformed or obsolete cache data', (snapshot) => {
    expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet)).toBe(false)
  })

  it.each(scopeMismatches)('rejects a valid snapshot for $label', ({ chain, wallet }) => {
    expect(isCachedSnapshot(validSnapshot, chain, wallet)).toBe(false)
  })

  it.each([
    { label: 'wallet field', snapshot: { ...validSnapshot, wallet: otherWallet } },
    { label: 'chain field', snapshot: { ...validSnapshot, chain: 'polygon' } },
    { label: 'wallet in key', snapshot: { ...validSnapshot, key: `eth:${otherWallet}` } },
    {
      label: 'chain in key',
      snapshot: { ...validSnapshot, key: `polygon:${validSnapshot.wallet}` }
    }
  ])('rejects a mismatched $label even if other identity fields match', ({ snapshot }) => {
    expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet)).toBe(false)
  })

  it('normalizes wallet case without weakening the chain and key checks', () => {
    const wallet = '0x00000000000000000000000000000000000000ab'
    const snapshot = {
      ...validSnapshot,
      wallet: '0x00000000000000000000000000000000000000AB',
      key: `eth:${wallet}`
    }
    expect(isCachedSnapshot(snapshot, 'eth', wallet)).toBe(true)
    expect(isCachedSnapshot(snapshot, 'polygon', wallet)).toBe(false)
  })

  it('rejects duplicate ids even when the count and list length match', () => {
    const snapshot = {
      ...validSnapshot,
      vmuCount: 2,
      vmus: [{ ...validSnapshot.vmus[0] }, { ...validSnapshot.vmus[0], address: otherWallet }]
    }
    expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet)).toBe(false)
    expect(
      isCachedSnapshot(
        { ...snapshot, vmus: [snapshot.vmus[0], { ...snapshot.vmus[1], id: 2 }] },
        'eth',
        validSnapshot.wallet
      )
    ).toBe(true)
  })

  it.each(['syncedAt', 'chainTimestampMs'] as const)(
    'accepts the safe integer boundary for %s',
    (field) => {
      expect(
        isCachedSnapshot(
          { ...validSnapshot, [field]: Number.MAX_SAFE_INTEGER },
          'eth',
          validSnapshot.wallet
        )
      ).toBe(true)
    }
  )

  it.each(invalidNumbers)('rejects $label in snapshot numeric fields', ({ value }) => {
    for (const field of ['vmuCount', 'syncedAt', 'chainTimestampMs']) {
      expect(
        isCachedSnapshot({ ...validSnapshot, [field]: value }, 'eth', validSnapshot.wallet),
        field
      ).toBe(false)
    }
  })

  it.each(['rank', 'term', 'maturityTs', 'amplifier', 'eaaRate'] as const)(
    'accepts the safe integer boundary for VMU %s',
    (field) => {
      const snapshot = {
        ...validSnapshot,
        vmus: [{ ...validSnapshot.vmus[0], [field]: Number.MAX_SAFE_INTEGER }]
      }
      expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet)).toBe(true)
    }
  )

  it.each(invalidNumbers)('rejects $label in every VMU numeric field', ({ value }) => {
    for (const field of ['id', 'rank', 'term', 'maturityTs', 'amplifier', 'eaaRate']) {
      const snapshot = {
        ...validSnapshot,
        vmus: [{ ...validSnapshot.vmus[0], [field]: value }]
      }
      expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet), field).toBe(false)
    }
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'does not accept the prototype-like string %s as a VMU status',
    (status) => {
      expect(
        isCachedSnapshot(
          { ...validSnapshot, vmus: [{ ...validSnapshot.vmus[0], status }] },
          'eth',
          validSnapshot.wallet
        )
      ).toBe(false)
    }
  )

  it.each(['__proto__', '<img src="data:," onerror="alert(1)">', 'javascript:alert(1)'])(
    'rejects non-address VMU text: %s',
    (address) => {
      expect(
        isCachedSnapshot(
          { ...validSnapshot, vmus: [{ ...validSnapshot.vmus[0], address }] },
          'eth',
          validSnapshot.wallet
        )
      ).toBe(false)
    }
  )

  it.each(['key', 'wallet', 'chain'])('rejects __proto__ text in snapshot %s', (field) => {
    expect(
      isCachedSnapshot({ ...validSnapshot, [field]: '__proto__' }, 'eth', validSnapshot.wallet)
    ).toBe(false)
  })

  it('treats an own JSON __proto__ key as inert data, not as the snapshot identity', () => {
    const snapshot = JSON.parse(
      JSON.stringify({
        ...validSnapshot,
        ['__proto__']: { wallet: otherWallet, h07Polluted: true }
      })
    )
    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true)
    expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet)).toBe(true)
    expect(isCachedSnapshot(snapshot, 'eth', otherWallet)).toBe(false)
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'h07Polluted')).toBe(false)
  })
})

describe('IndexedDB snapshot restore scope (H-07)', () => {
  it.each(scopeMismatches)('does not restore a snapshot for $label', async ({ chain, wallet }) => {
    const { get, remove } = installSnapshotRead(validSnapshot)
    const { loadSnapshot } = await import('@/core/idb')

    await expect(loadSnapshot(chain, wallet)).resolves.toBeNull()
    expect(get).toHaveBeenCalledExactlyOnceWith(`${chain}:${wallet}`)
    expect(remove).toHaveBeenCalledExactlyOnceWith(`${chain}:${wallet}`)
  })

  it('restores a valid scoped snapshot without deleting it', async () => {
    const { get, remove } = installSnapshotRead(validSnapshot)
    const { loadSnapshot } = await import('@/core/idb')

    await expect(loadSnapshot('eth', validSnapshot.wallet)).resolves.toBe(validSnapshot)
    expect(get).toHaveBeenCalledExactlyOnceWith(validSnapshot.key)
    expect(remove).not.toHaveBeenCalled()
  })
})
