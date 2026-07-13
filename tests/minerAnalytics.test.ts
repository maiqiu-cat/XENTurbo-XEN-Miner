import { describe, expect, it } from 'vitest'
import { analyticsOperationName, analyticsRpcHealthState } from '@/core/minerAnalytics'
import type { RpcHealthState } from '@/core/rpc'

function rpcState(overrides: Partial<RpcHealthState> = {}): RpcHealthState {
  return {
    chain: 'eth',
    checking: false,
    checkedAt: 1,
    totalUrls: 2,
    healthyUrls: ['https://one.example', 'https://two.example'],
    failures: [],
    error: null,
    ...overrides
  }
}

describe('miner analytics classifications', () => {
  it.each([
    ['GENERAL_MINT', 'general_mint'],
    ['CREATE_EMPTY_SLOT', 'create_empty_slot'],
    ['MINT_EMPTY_SLOT', 'mint_empty_slot'],
    ['CLAIM', 'claim'],
    ['CLAIM_REUSE', 'claim_reuse']
  ] as const)('maps %s without operation inputs', (operation, expected) => {
    expect(analyticsOperationName(operation)).toBe(expected)
  })

  it('reports only completed RPC health classifications', () => {
    expect(analyticsRpcHealthState(rpcState({ checkedAt: null }))).toBeNull()
    expect(analyticsRpcHealthState(rpcState({ checking: true }))).toBeNull()
    expect(analyticsRpcHealthState(rpcState())).toBe('healthy')
    expect(
      analyticsRpcHealthState(
        rpcState({
          healthyUrls: ['https://one.example'],
          failures: [{ url: 'https://two.example', message: 'secret network detail' }]
        })
      )
    ).toBe('degraded')
    expect(
      analyticsRpcHealthState(
        rpcState({
          healthyUrls: [],
          failures: [{ url: 'https://private.example/key', message: 'offline' }],
          error: 'RPC_UNAVAILABLE: private detail'
        })
      )
    ).toBe('unavailable')
  })
})
