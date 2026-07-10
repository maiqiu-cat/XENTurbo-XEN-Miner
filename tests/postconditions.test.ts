import { describe, expect, it } from 'vitest'
import {
  verifyOperationOutcome,
  type OutcomeOperation,
  type OperationOutcome
} from '@/core/postconditions'
import type { VmuStatus } from '@/core/types'

const wallet = '0x0000000000000000000000000000000000000001'

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
  ])('verifies $op.op against its exact expected state', async ({ op, expectedIds, expectedStatus }) => {
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
  })

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
    const result = await verify(
      operation({ op: 'CREATE_EMPTY_SLOT', count: 2, preVmuCount: 10 }),
      new Map([
        [11, 'EMPTY'],
        [12, 'EMPTY']
      ]),
      {
        deployments: new Map([
          [11, 'DEPLOYED'],
          [12, 'DEPLOYED']
        ]),
        vmuCount: 11
      }
    )

    expect(result.classification).toBe('partial')
    expect(result.matchingIds).toEqual([11])
    expect(result.unexpectedIds).toEqual([12])
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
