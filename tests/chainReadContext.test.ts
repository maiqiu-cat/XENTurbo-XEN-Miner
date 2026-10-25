import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({
  count: vi.fn(),
  rank: vi.fn(),
  block: vi.fn()
}))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  class Contract {
    vmuCount = reads.count
    globalRank = reads.rank
  }
  return { ...actual, Contract }
})
vi.mock('@/core/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/rpc')>()
  return {
    ...actual,
    getReadProvider: () => ({
      getBlock: reads.block,
      withSignal() {
        return this
      }
    })
  }
})

import { readChainTimestamp, readGlobalRank, readVmuCount } from '@/core/chainReader'

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
})
afterEach(() => vi.useRealTimers())

describe('initial chain reads respect cancellation', () => {
  it.each(['count', 'rank', 'block'] as const)(
    'abandons a stalled %s read without retrying',
    async (kind) => {
      const controller = new AbortController()
      let rejectLate!: (error: Error) => void
      reads[kind].mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectLate = reject
        })
      )
      const context = { signal: controller.signal, blockTag: 42 }
      const pending =
        kind === 'count'
          ? readVmuCount('eth', '0x0000000000000000000000000000000000000001', context)
          : kind === 'rank'
            ? readGlobalRank('eth', context)
            : readChainTimestamp('eth', context)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(0)
      expect(reads[kind]).toHaveBeenCalledOnce()
      controller.abort()
      await rejected
      rejectLate(new Error('late transport failure'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reads[kind]).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('pins a global rank read to the requested block', async () => {
    reads.rank.mockResolvedValue(123n)
    expect(await readGlobalRank('eth', { blockTag: 42 })).toBe(123)
    expect(reads.rank).toHaveBeenCalledWith({ blockTag: 42 })
  })

  it('rejects unsafe milliseconds from the provider rather than returning a maturity clock', async () => {
    reads.block.mockResolvedValue({ timestamp: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1 })
    await expect(readChainTimestamp('eth')).rejects.toThrow('invalid timestamp')
    expect(reads.block).toHaveBeenCalledOnce()
  })
})
