import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateGroupXen } from '@/utils/rewards'

afterEach(() => vi.useRealTimers())

describe('group reward estimation', () => {
  it('uses every VMU actual rank instead of assuming consecutive ranks', () => {
    const result = estimateGroupXen({
      globalRank: 1_024,
      ranks: [1, 1_023],
      term: 100,
      amplifier: 1_000,
      eaaRate: 0,
      maturityMs: Date.now() + 86_400_000
    })
    const expected =
      Math.floor(Number(Math.log2(1_023).toFixed(4)) * 100 * 1_000) + Math.floor(1 * 100 * 1_000)

    expect(result).toBe(expected)
  })

  it('uses chain time for the late-claim penalty instead of local time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2035-01-01T00:00:00Z'))
    const maturityMs = Date.parse('2026-01-02T00:00:00Z')
    const chainTimestampMs = Date.parse('2026-01-01T00:00:00Z')

    const result = estimateGroupXen({
      globalRank: 1_024,
      ranks: [1],
      term: 100,
      amplifier: 1_000,
      eaaRate: 0,
      maturityMs,
      currentTimeMs: chainTimestampMs
    })

    expect(result).toBe(Math.floor(Number(Math.log2(1_023).toFixed(4)) * 100 * 1_000))
  })
})
