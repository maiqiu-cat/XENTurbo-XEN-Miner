import { beforeEach, describe, expect, it, vi } from 'vitest'

const batchState = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  calls: 0,
  failCalls: new Set<number>(),
  ranges: [] as Array<{ fromId: number; toId: number }>,
  proxyIds: [] as number[],
  retryDerivedCounts: [] as number[],
  onCall: undefined as ((call: number) => void) | undefined
}))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  const resultInterface = new actual.Interface([
    'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
  ])
  class Contract {
    async aggregate3(calls: unknown[]) {
      batchState.calls += 1
      const call = batchState.calls
      batchState.retryDerivedCounts.push(batchState.proxyIds.length)
      batchState.onCall?.(call)
      batchState.active += 1
      batchState.peak = Math.max(batchState.peak, batchState.active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      batchState.active -= 1
      if (batchState.failCalls.has(call)) throw new Error('batch unavailable')
      return calls.map(() => ({
        success: true,
        returnData: resultInterface.encodeFunctionResult('userMints', [
          '0x0000000000000000000000000000000000000001',
          100n,
          2_000_000_000n,
          10n,
          3_000n,
          0n
        ])
      }))
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
  getReadProvider: () => ({}),
  withRetry: (operation: () => Promise<unknown>) => operation()
}))

import { readWalletVmus } from '@/core/chainReader'

describe('wallet VMU batch reads', () => {
  beforeEach(() => {
    batchState.active = 0
    batchState.peak = 0
    batchState.calls = 0
    batchState.failCalls = new Set()
    batchState.ranges = []
    batchState.proxyIds = []
    batchState.retryDerivedCounts = []
    batchState.onCall = undefined
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

  it('stops scheduling later batches when the scan is aborted', async () => {
    const controller = new AbortController()

    const scan = readWalletVmus('eth', '0x0000000000000000000000000000000000000002', {
      vmuCount: 1_200,
      chainTimestampMs: 1_000,
      signal: controller.signal,
      onProgress: () => controller.abort()
    })

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    expect(batchState.calls).toBe(2)
  })

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

  it('does not derive later retry batches after cancellation', async () => {
    batchState.failCalls = new Set([1, 2, 3])
    const controller = new AbortController()
    batchState.onCall = (call) => {
      if (call === 4) controller.abort()
    }

    await expect(
      readWalletVmus('eth', '0x0000000000000000000000000000000000000002', {
        vmuCount: 1_200,
        chainTimestampMs: 1_000,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(batchState.calls).toBe(4)
    expect(batchState.proxyIds).toHaveLength(400)
  })
})
