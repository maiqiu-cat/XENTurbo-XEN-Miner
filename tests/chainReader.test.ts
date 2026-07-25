import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertVmuCount, classifyVmuStatus, MAX_WALLET_VMU_COUNT } from '@/core/chainReader'

afterEach(() => vi.restoreAllMocks())

describe('VMU maturity classification', () => {
  it('uses chain time instead of the local wall clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999)

    expect(classifyVmuStatus(10, 2_000_000, 1_000_000)).toBe('MINTING')
    expect(classifyVmuStatus(10, 2_000_000, 2_001_001)).toBe('CLAIMABLE')
  })

  it('keeps rank zero as an empty slot regardless of time', () => {
    expect(classifyVmuStatus(0, 2_000_000, 9_999_999)).toBe('EMPTY')
  })
})

describe('VMU count validation', () => {
  it.each([-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, BigInt(MAX_WALLET_VMU_COUNT + 1)])(
    'rejects unsafe or resource-exhausting VMU count %s',
    (count) => {
      expect(() => assertVmuCount(count)).toThrow(/Invalid VMU count|VMU count limit/)
    }
  )

  it('accepts the configured defensive boundary', () => {
    expect(assertVmuCount(BigInt(MAX_WALLET_VMU_COUNT))).toBe(MAX_WALLET_VMU_COUNT)
  })
})
