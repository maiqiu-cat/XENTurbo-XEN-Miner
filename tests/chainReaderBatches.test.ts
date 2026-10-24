import { beforeEach, describe, expect, it, vi } from 'vitest'

const batchState = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  calls: 0,
  failCalls: new Set<number>(),
  ranges: [] as Array<{ fromId: number; toId: number }>,
  proxyIds: [] as number[],
  retryDerivedCounts: [] as number[],
  sizes: [] as number[],
  maxResultBytes: Infinity,
  unreadableIds: new Set<number>(),
  blockTags: [] as Array<number | undefined>,
  block: vi.fn(async () => ({ timestamp: 1_800_000_000 })),
  onCall: undefined as ((call: number) => void) | undefined
}))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  const resultInterface = new actual.Interface([
    'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
  ])
  const multicallInterface = new actual.Interface([
    'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])'
  ])
  class Contract {
    async aggregate3(calls: Array<{ callData: string }>, overrides: { blockTag?: number } = {}) {
      batchState.calls += 1
      const call = batchState.calls
      batchState.sizes.push(calls.length)
      batchState.blockTags.push(overrides.blockTag)
      batchState.retryDerivedCounts.push(batchState.proxyIds.length)
      batchState.onCall?.(call)
      batchState.active += 1
      batchState.peak = Math.max(batchState.peak, batchState.active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      batchState.active -= 1
      if (batchState.failCalls.has(call)) throw new Error('batch unavailable')
      const results = calls.map(({ callData }) => {
        const [proxy] = resultInterface.decodeFunctionData('userMints', callData)
        const id = BigInt(proxy)
        if (batchState.unreadableIds.has(Number(id))) return { success: false, returnData: '0x' }
        return {
          success: true,
          returnData: resultInterface.encodeFunctionResult('userMints', [
            proxy,
            100n,
            2_000_000_000n,
            id,
            3_000n,
            0n
          ])
        }
      })
      const resultBytes =
        (multicallInterface.encodeFunctionResult('aggregate3', [results]).length - 2) / 2
      if (resultBytes > batchState.maxResultBytes) {
        throw new Error(
          `call returned result of length ${resultBytes} exceeding limit ${batchState.maxResultBytes}`
        )
      }
      return results
    }
  }
  return { ...actual, Contract }
})

vi.mock('@/core/create2', () => ({
  computeProxyAddress: vi.fn(({ vmuId }: { vmuId: number }) => {
    batchState.proxyIds.push(vmuId)
    return `0x${vmuId.toString(16).padStart(40, '0')}`
  }),
  computeProxyAddressRange: ({ fromId, toId }: { fromId: number; toId: number }) => {
    batchState.ranges.push({ fromId, toId })
    return Array.from({ length: toId - fromId + 1 }, (_, index) => ({
      id: fromId + index,
      address: `0x${(fromId + index).toString(16).padStart(40, '0')}`
    }))
  },
  minimalProxyRuntimeCode: vi.fn()
}))

vi.mock('@/core/rpc', () => ({
  getReadProvider: () => ({ getBlock: batchState.block }),
  withRetry: (operation: () => Promise<unknown>) => operation()
}))

import { readVmuStates, readWalletVmus } from '@/core/chainReader'

describe('wallet VMU batch reads', () => {
  beforeEach(() => {
    batchState.active = 0
    batchState.peak = 0
    batchState.calls = 0
    batchState.failCalls = new Set()
    batchState.ranges = []
    batchState.proxyIds = []
    batchState.retryDerivedCounts = []
    batchState.sizes = []
    batchState.maxResultBytes = Infinity
    batchState.unreadableIds = new Set()
    batchState.blockTags = []
    batchState.block.mockClear()
    batchState.onCall = undefined
  })

  it('reads a Polygon wallet within a 100 KB Multicall response limit', async () => {
    batchState.maxResultBytes = 100_000
    const onProgress = vi.fn()
    const vmus = await readWalletVmus('polygon', '0x0000000000000000000000000000000000000002', {
      vmuCount: 601,
      chainTimestampMs: 1_000,
      onProgress
    })

    expect(vmus).toHaveLength(601)
    expect(vmus.every((vmu) => vmu.readOk && vmu.status === 'MINTING')).toBe(true)
    expect(vmus.map((vmu) => vmu.id)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1))
    expect(batchState.sizes).toEqual([300, 300, 1])
    expect(batchState.peak).toBe(2)
    expect(onProgress.mock.calls.map(([value]) => value)).toEqual([
      { loaded: 300, total: 601 },
      { loaded: 600, total: 601 },
      { loaded: 601, total: 601 }
    ])
  })

  it('runs large-wallet Multicall batches with bounded parallelism', async () => {
    const vmus = await readWalletVmus('eth', '0x0000000000000000000000000000000000000002', {
      vmuCount: 1_200,
      chainTimestampMs: 1_000
    })

    expect(vmus).toHaveLength(1_200)
    expect(batchState.calls).toBe(3)
    expect(batchState.peak).toBe(2)
    expect(batchState.ranges).toEqual([
      { fromId: 1, toId: 400 },
      { fromId: 401, toId: 800 },
      { fromId: 801, toId: 1_200 }
    ])
  })

  it('pins sparse Polygon reads to the requested block and preserves ID/result order', async () => {
    batchState.maxResultBytes = 100_000
    const ids = Array.from({ length: 301 }, (_, i) => 901 - i * 2)
    const vmus = await readVmuStates('polygon', '0x0000000000000000000000000000000000000002', ids, {
      blockTag: 42
    })

    expect(vmus.map((vmu) => vmu.id)).toEqual(ids)
    expect(vmus.map((vmu) => vmu.rank)).toEqual(ids)
    expect(vmus.every((vmu) => vmu.readOk && vmu.status === 'MINTING')).toBe(true)
    expect(batchState.sizes).toEqual([300, 1])
    expect(batchState.blockTags).toEqual([42, 42])
    expect(batchState.block).toHaveBeenCalledExactlyOnceWith(42)
  })

  it('keeps Polygon retries within the response limit while preserving successful batches', async () => {
    batchState.maxResultBytes = 100_000
    batchState.failCalls = new Set([1, 2, 5])
    const vmus = await readWalletVmus('polygon', '0x0000000000000000000000000000000000000002', {
      vmuCount: 601,
      chainTimestampMs: 1_000
    })

    expect(batchState.sizes).toEqual([300, 300, 1, 300, 300])
    expect(batchState.retryDerivedCounts).toEqual([0, 0, 0, 300, 600])
    expect(vmus.map((vmu) => vmu.id)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1))
    expect(vmus.slice(0, 300).every((vmu) => vmu.readOk)).toBe(true)
    expect(vmus.slice(300, 600).every((vmu) => !vmu.readOk && vmu.status === 'READ_ERROR')).toBe(
      true
    )
    expect(vmus[600]).toMatchObject({ id: 601, rank: 601, readOk: true })
    expect(vmus.some((vmu) => vmu.status === 'EMPTY')).toBe(false)
  })

  it('retries only unreadable Polygon entries without losing the pinned block or good results', async () => {
    batchState.maxResultBytes = 100_000
    batchState.unreadableIds = new Set([1, 301])
    const ids = Array.from({ length: 301 }, (_, i) => i + 1)
    const vmus = await readVmuStates('polygon', '0x0000000000000000000000000000000000000002', ids, {
      blockTag: 42
    })

    expect(batchState.sizes).toEqual([300, 1, 2])
    expect(batchState.blockTags).toEqual([42, 42, 42])
    expect(vmus.filter((vmu) => !vmu.readOk).map((vmu) => [vmu.id, vmu.status])).toEqual([
      [1, 'READ_ERROR'],
      [301, 'READ_ERROR']
    ])
    expect(vmus.filter((vmu) => vmu.readOk).map((vmu) => vmu.rank)).toEqual(ids.slice(1, -1))
  })

  it('keeps successful batches and marks a failed batch as unreadable', async () => {
    batchState.failCalls = new Set([2, 4])

    const vmus = await readWalletVmus('eth', '0x0000000000000000000000000000000000000002', {
      vmuCount: 1_200,
      chainTimestampMs: 1_000
    })

    expect(vmus).toHaveLength(1_200)
    expect(vmus.filter((vmu) => !vmu.readOk)).toHaveLength(400)
    expect(vmus.filter((vmu) => vmu.readOk)).toHaveLength(800)
  })

  it.each(['eth', 'polygon'] as const)(
    'stops scheduling later %s batches when aborted',
    async (chain) => {
      const controller = new AbortController()

      const scan = readWalletVmus(chain, '0x0000000000000000000000000000000000000002', {
        vmuCount: 1_200,
        chainTimestampMs: 1_000,
        signal: controller.signal,
        onProgress: () => controller.abort()
      })

      await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
      expect(batchState.calls).toBe(2)
    }
  )

  it('derives failed VMU addresses lazily in retry-sized batches', async () => {
    batchState.failCalls = new Set([1, 2, 3])
    const vmus = await readWalletVmus('eth', '0x0000000000000000000000000000000000000002', {
      vmuCount: 1_200,
      chainTimestampMs: 1_000
    })

    expect(vmus).toHaveLength(1_200)
    expect(vmus.every((vmu) => vmu.readOk)).toBe(true)
    expect(batchState.retryDerivedCounts).toEqual([0, 0, 0, 400, 800, 1_200])
  })

  it.each(['eth', 'polygon'] as const)(
    'does not derive later %s retry batches after cancellation',
    async (chain) => {
      const batchSize = chain === 'eth' ? 400 : 300
      batchState.failCalls = new Set([1, 2, 3])
      const controller = new AbortController()
      batchState.onCall = (call) => {
        if (call === 4) controller.abort()
      }

      await expect(
        readWalletVmus(chain, '0x0000000000000000000000000000000000000002', {
          vmuCount: batchSize * 3,
          chainTimestampMs: 1_000,
          signal: controller.signal
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(batchState.calls).toBe(4)
      expect(batchState.proxyIds).toHaveLength(batchSize)
    }
  )
})
