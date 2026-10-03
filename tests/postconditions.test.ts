import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpcHealth = vi.hoisted(() => ({
  ensureRecentReadProvider: vi.fn(),
  getReadProvider: vi.fn(),
  withRetry: vi.fn((read) => read())
}))

vi.mock('@/core/rpc', () => rpcHealth)

import {
  verifyOperationOutcome,
  verifyOperationOutcomeWithRetry,
  type OutcomeOperation,
  type OperationOutcome
} from '@/core/postconditions'
import type { Vmu, VmuStatus } from '@/core/types'

const wallet = '0x0000000000000000000000000000000000000001'

beforeEach(() => {
  rpcHealth.ensureRecentReadProvider.mockReset().mockResolvedValue({})
})

function operation(overrides: Partial<OutcomeOperation>): OutcomeOperation {
  return {
    chain: 'eth',
    wallet,
    op: 'GENERAL_MINT',
    ids: [],
    count: 3,
    preVmuCount: 7,
    ...overrides
  }
}

async function verify(
  prepared: OutcomeOperation,
  statuses: Map<number, VmuStatus> | Error,
  evidence: {
    deployments?: Map<number, 'DEPLOYED' | 'MISSING' | 'READ_ERROR'> | Error
    vmuCount?: number | Error
  } = {}
): Promise<OperationOutcome> {
  return verifyOperationOutcome(prepared, {
    readStatuses: async () => {
      if (statuses instanceof Error) throw statuses
      return statuses
    },
    readProxyDeployments: async () => {
      if (evidence.deployments instanceof Error) throw evidence.deployments
      return evidence.deployments ?? new Map()
    },
    readCount: async () => {
      if (evidence.vmuCount instanceof Error) throw evidence.vmuCount
      return evidence.vmuCount ?? 0
    }
  })
}

describe('operation postconditions', () => {
  const blockHash = `0x${'b'.repeat(64)}`
  const receipt = {
    transactionHash: `0x${'a'.repeat(64)}`,
    blockHash,
    blockNumber: 42,
    status: 1 as const
  }
  const timestamp = 1_800_000_000

  it.each([null, { hash: `0x${'c'.repeat(64)}`, number: 42, timestamp }])(
    'does not classify a lagging or reorganized receipt block as partial success',
    async (block) => {
      rpcHealth.getReadProvider.mockReturnValue({ getBlock: vi.fn(async () => block) })
      const readStatuses = vi.fn()
      const result = await verifyOperationOutcome(operation({ op: 'CLAIM', ids: [1], receipt }), {
        readStatuses
      })
      expect(result.classification).toBe('uncertain')
      expect(readStatuses).not.toHaveBeenCalled()
    }
  )

  it.each([
    { term: 10, rank: 200, maturityTs: (timestamp + 10 * 86_400) * 1000, expected: 'full' },
    { term: 9, rank: 200, maturityTs: (timestamp + 10 * 86_400) * 1000, expected: 'partial' },
    { term: 10, rank: 100, maturityTs: (timestamp + 10 * 86_400) * 1000, expected: 'partial' },
    { term: 10, rank: 200, maturityTs: (timestamp + 9 * 86_400) * 1000, expected: 'partial' }
  ])('checks the new remint term, rank and maturity at the receipt block', async (mint) => {
    rpcHealth.getReadProvider.mockReturnValue({
      getBlock: vi.fn(async () => ({ hash: blockHash, number: 42, timestamp }))
    })
    const readStatuses = vi.fn(async () => new Map([[1, 'MINTING' as const]]))
    const readStates = vi.fn(async () => [{ id: 1, readOk: true, ...mint } as unknown as Vmu])
    const result = await verifyOperationOutcome(
      operation({ op: 'CLAIM_REUSE', ids: [1], term: 10, receipt, beforeRanks: { 1: 100 } }),
      { readStatuses, readStates }
    )
    expect(result.classification).toBe(mint.expected)
    expect(readStatuses).toHaveBeenCalledWith('eth', wallet, [1], { blockTag: 42 })
    expect(readStates).toHaveBeenCalledWith('eth', wallet, [1], { blockTag: 42 })
  })

  it.each([
    {
      op: operation({ op: 'GENERAL_MINT', count: 3, preVmuCount: 7 }),
      expectedIds: [8, 9, 10],
      expectedStatus: 'MINTING' as const
    },
    {
      op: operation({ op: 'CREATE_EMPTY_SLOT', count: 2, preVmuCount: 10 }),
      expectedIds: [11, 12],
      expectedStatus: 'EMPTY' as const
    },
    {
      op: operation({ op: 'MINT_EMPTY_SLOT', ids: [2, 5], count: 0, preVmuCount: undefined }),
      expectedIds: [2, 5],
      expectedStatus: 'MINTING' as const
    },
    {
      op: operation({ op: 'CLAIM', ids: [3, 4], count: 0, preVmuCount: undefined }),
      expectedIds: [3, 4],
      expectedStatus: 'EMPTY' as const
    },
    {
      op: operation({ op: 'CLAIM_REUSE', ids: [6, 9], count: 0, preVmuCount: undefined }),
      expectedIds: [6, 9],
      expectedStatus: 'MINTING' as const
    }
  ])(
    'verifies $op.op against its exact expected state',
    async ({ op, expectedIds, expectedStatus }) => {
      const statuses = new Map(expectedIds.map((id) => [id, expectedStatus]))
      const evidence =
        op.op === 'CREATE_EMPTY_SLOT'
          ? {
              deployments: new Map(expectedIds.map((id) => [id, 'DEPLOYED' as const])),
              vmuCount: op.preVmuCount! + op.count
            }
          : undefined

      const result = await verify(op, statuses, evidence)

      expect(result).toEqual({
        classification: 'full',
        expectedStatus,
        expectedCount: expectedIds.length,
        expectedIds,
        matchingCount: expectedIds.length,
        matchingIds: expectedIds,
        unexpectedCount: 0,
        unexpectedIds: [],
        readErrorCount: 0,
        readErrorIds: []
      })
    }
  )

  it('reports known mismatches as a partial result with exact ids and counts', async () => {
    const result = await verify(
      operation({ op: 'GENERAL_MINT', count: 3, preVmuCount: 10 }),
      new Map([
        [11, 'MINTING'],
        [12, 'EMPTY'],
        [13, 'MINTING']
      ])
    )

    expect(result.classification).toBe('partial')
    expect(result.expectedCount).toBe(3)
    expect(result.matchingCount).toBe(2)
    expect(result.matchingIds).toEqual([11, 13])
    expect(result.unexpectedCount).toBe(1)
    expect(result.unexpectedIds).toEqual([12])
    expect(result.readErrorCount).toBe(0)
  })

  it('reports any read error as uncertain while retaining known mismatches', async () => {
    const result = await verify(
      operation({ op: 'CLAIM_REUSE', ids: [1, 2, 3], count: 0, preVmuCount: undefined }),
      new Map([
        [1, 'MINTING'],
        [2, 'READ_ERROR'],
        [3, 'EMPTY']
      ])
    )

    expect(result.classification).toBe('uncertain')
    expect(result.matchingIds).toEqual([1])
    expect(result.unexpectedIds).toEqual([3])
    expect(result.readErrorIds).toEqual([2])
    expect(result.matchingCount).toBe(1)
    expect(result.unexpectedCount).toBe(1)
    expect(result.readErrorCount).toBe(1)
  })

  it('turns an RPC read failure into an uncertain result for every affected id', async () => {
    const result = await verify(
      operation({ op: 'CLAIM', ids: [21, 22], count: 0, preVmuCount: undefined }),
      new Error('multicall unavailable')
    )

    expect(result.classification).toBe('uncertain')
    expect(result.matchingIds).toEqual([])
    expect(result.unexpectedIds).toEqual([])
    expect(result.readErrorIds).toEqual([21, 22])
    expect(result.readErrorCount).toBe(2)
  })

  it('treats a missing VMU status as a read error rather than an empty slot', async () => {
    const result = await verify(
      operation({ op: 'MINT_EMPTY_SLOT', ids: [31, 32], count: 0, preVmuCount: undefined }),
      new Map([[31, 'MINTING']])
    )

    expect(result.classification).toBe('uncertain')
    expect(result.matchingIds).toEqual([31])
    expect(result.readErrorIds).toEqual([32])
  })

  it('does not verify empty-slot creation when the expected proxy code is absent', async () => {
    const result = await verify(
      operation({ op: 'CREATE_EMPTY_SLOT', count: 2, preVmuCount: 10 }),
      new Map([
        [11, 'EMPTY'],
        [12, 'EMPTY']
      ]),
      {
        deployments: new Map([
          [11, 'MISSING'],
          [12, 'MISSING']
        ]),
        vmuCount: 12
      }
    )

    expect(result.classification).toBe('partial')
    expect(result.matchingIds).toEqual([])
    expect(result.unexpectedIds).toEqual([11, 12])
  })

  it('does not verify empty-slot creation unless the factory count reaches every expected id', async () => {
    const readStatuses = vi.fn(
      async (_chain, _wallet, ids: number[]) => new Map(ids.map((id) => [id, 'EMPTY' as const]))
    )
    const readProxyDeployments = vi.fn(
      async (_chain, _wallet, ids: number[]) => new Map(ids.map((id) => [id, 'DEPLOYED' as const]))
    )
    const result = await verifyOperationOutcome(
      operation({ op: 'CREATE_EMPTY_SLOT', count: 2, preVmuCount: 10 }),
      {
        readStatuses,
        readProxyDeployments,
        readCount: async () => 11
      }
    )

    expect(result.classification).toBe('partial')
    expect(result.matchingIds).toEqual([11])
    expect(result.unexpectedIds).toEqual([12])
    expect(readStatuses).toHaveBeenCalledWith('eth', wallet, [11], { blockTag: undefined })
    expect(readProxyDeployments).toHaveBeenCalledWith('eth', wallet, [11], { blockTag: undefined })
  })

  it('skips status and code reads when empty-slot creation did not increase the factory count', async () => {
    const readStatuses = vi.fn()
    const readProxyDeployments = vi.fn()

    const result = await verifyOperationOutcome(
      operation({ op: 'CREATE_EMPTY_SLOT', count: 500, preVmuCount: 10 }),
      {
        readStatuses,
        readProxyDeployments,
        readCount: async () => 10
      }
    )

    expect(result.classification).toBe('partial')
    expect(result.unexpectedCount).toBe(500)
    expect(readStatuses).not.toHaveBeenCalled()
    expect(readProxyDeployments).not.toHaveBeenCalled()
  })

  it('reports empty-slot proxy code read failures as uncertain', async () => {
    const result = await verify(
      operation({ op: 'CREATE_EMPTY_SLOT', count: 2, preVmuCount: 10 }),
      new Map([
        [11, 'EMPTY'],
        [12, 'EMPTY']
      ]),
      {
        deployments: new Map([
          [11, 'DEPLOYED'],
          [12, 'READ_ERROR']
        ]),
        vmuCount: 12
      }
    )

    expect(result.classification).toBe('uncertain')
    expect(result.matchingIds).toEqual([11])
    expect(result.readErrorIds).toEqual([12])
  })
})

describe('postcondition retry', () => {
  const partial: OperationOutcome = {
    classification: 'partial',
    expectedStatus: 'MINTING',
    expectedCount: 1,
    expectedIds: [1],
    matchingCount: 0,
    matchingIds: [],
    unexpectedCount: 1,
    unexpectedIds: [1],
    readErrorCount: 0,
    readErrorIds: []
  }
  const full: OperationOutcome = {
    ...partial,
    classification: 'full',
    matchingCount: 1,
    matchingIds: [1],
    unexpectedCount: 0,
    unexpectedIds: []
  }

  it('retries a lagging result and stops as soon as full success is visible', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(full)
    const sleep = vi.fn(async () => {})

    const result = await verifyOperationOutcomeWithRetry(operation({ count: 1 }), {
      verify,
      sleep
    })

    expect(result.classification).toBe('full')
    expect(rpcHealth.ensureRecentReadProvider).toHaveBeenCalledTimes(3)
    expect(verify).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 500)
    expect(sleep).toHaveBeenNthCalledWith(2, 1_500)
  })

  it('reports a stable mismatch only after all retry delays', async () => {
    const verify = vi.fn(async () => partial)
    const sleep = vi.fn(async () => {})

    const result = await verifyOperationOutcomeWithRetry(operation({ count: 1 }), {
      verify,
      sleep
    })

    expect(result.classification).toBe('partial')
    expect(verify).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[500], [1_500], [3_000]])
  })

  it('reports inconsistent mismatches as uncertain instead of choosing the last answer', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ ...partial, unexpectedIds: [2] })
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ ...partial, unexpectedIds: [2] })
    const result = await verifyOperationOutcomeWithRetry(operation({ count: 1 }), {
      verify,
      sleep: async () => {}
    })
    expect(result.classification).toBe('uncertain')
  })
})
