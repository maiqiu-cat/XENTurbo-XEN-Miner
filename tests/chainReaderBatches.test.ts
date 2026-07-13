import { beforeEach, describe, expect, it, vi } from 'vitest'

const batchState = vi.hoisted(() => ({ active: 0, peak: 0, calls: 0 }))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  const resultInterface = new actual.Interface([
    'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
  ])
  class Contract {
    async aggregate3(calls: unknown[]) {
      batchState.calls += 1
      batchState.active += 1
      batchState.peak = Math.max(batchState.peak, batchState.active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      batchState.active -= 1
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
  computeProxyAddress: vi.fn(),
  computeProxyAddressRange: ({ fromId, toId }: { fromId: number; toId: number }) =>
    Array.from({ length: toId - fromId + 1 }, (_, index) => ({
      id: fromId + index,
      address: `0x${(fromId + index).toString(16).padStart(40, '0')}`
    })),
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
  })

  it('runs large-wallet Multicall batches with bounded parallelism', async () => {
    const vmus = await readWalletVmus('eth', '0x0000000000000000000000000000000000000002', {
      vmuCount: 1_200,
      chainTimestampMs: 1_000
    })

    expect(vmus).toHaveLength(1_200)
    expect(batchState.calls).toBe(3)
    expect(batchState.peak).toBe(2)
  })
})
