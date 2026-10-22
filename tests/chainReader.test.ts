import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertVmuCount,
  classifyVmuStatus,
  MAX_WALLET_VMU_COUNT,
  timestampSecondsToMs
} from '@/core/chainReader'

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

describe('chain timestamp bounds', () => {
  const lastSafeSecond = Math.floor(Number.MAX_SAFE_INTEGER / 1_000)

  it.each([1, 1_800_000_000, lastSafeSecond])('accepts safe seconds %s', (seconds) => {
    expect(timestampSecondsToMs(seconds)).toBe(seconds * 1_000)
  })

  it.each([undefined, null, '1800000000', 0, -1, 1.5, NaN, Infinity, lastSafeSecond + 1])(
    'rejects an invalid or millisecond-overflowing timestamp %s',
    (seconds) => {
      expect(() => timestampSecondsToMs(seconds)).toThrow('invalid timestamp')
    }
  )

  it('only permits zero for the empty mint representation', () => {
    expect(timestampSecondsToMs(0, true)).toBe(0)
    expect(() => timestampSecondsToMs(-1, true)).toThrow('invalid timestamp')
  })
})
