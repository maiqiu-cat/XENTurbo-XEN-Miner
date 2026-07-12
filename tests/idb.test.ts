import { describe, expect, it } from 'vitest'
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

describe('IndexedDB snapshot schema', () => {
  it('accepts a complete versioned snapshot', () => {
    expect(isCachedSnapshot(validSnapshot, 'eth', validSnapshot.wallet)).toBe(true)
  })

  it.each([
    { ...validSnapshot, version: 1 },
    { ...validSnapshot, vmus: undefined },
    { ...validSnapshot, vmuCount: 2 },
    { ...validSnapshot, chainTimestampMs: undefined },
    {
      ...validSnapshot,
      vmus: [{ ...validSnapshot.vmus[0], id: 1.5 }]
    }
  ])('rejects malformed or obsolete cache data', (snapshot) => {
    expect(isCachedSnapshot(snapshot, 'eth', validSnapshot.wallet)).toBe(false)
  })
})
