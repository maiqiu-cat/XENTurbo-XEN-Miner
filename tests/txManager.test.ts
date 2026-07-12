import { describe, expect, it, vi } from 'vitest'
import {
  assertPreparedContext,
  assertFitsBlockGasLimit,
  authoritativeServiceValue,
  estimateWithProbe,
  isRetryableEstimateError,
  strictSimulationFunction,
  validateOperationParams
} from '@/core/txManager'

describe('gas estimation fallback', () => {
  it('does not replace a contract revert with a probe projection', async () => {
    const revert = Object.assign(new Error('execution reverted: CALL_FAILED'), {
      code: 'CALL_EXCEPTION',
      data: '0xdeadbeef'
    })
    const probe = vi.fn(async () => 100_000n)

    await expect(
      estimateWithProbe(async () => Promise.reject(revert), probe, 64, 1.3)
    ).rejects.toBe(revert)
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    Object.assign(new Error('insufficient funds for intrinsic transaction cost'), {
      code: 'INSUFFICIENT_FUNDS'
    }),
    Object.assign(new Error('invalid argument: malformed transaction'), {
      code: 'INVALID_ARGUMENT'
    }),
    Object.assign(new Error('insufficient value for factory fee'), {
      data: '0x08c379a0'
    })
  ])('preserves non-retryable estimation failures exactly', async (failure) => {
    const probe = vi.fn(async () => 100_000n)

    await expect(
      estimateWithProbe(async () => Promise.reject(failure), probe, 64, 1.3)
    ).rejects.toBe(failure)
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    new Error('Gas estimation timed out after 40s'),
    new Error('RPC response size exceeded the provider limit'),
    new Error('transaction gas limit exceeds the provider gas cap')
  ])('allows projection for an explicit retryable provider failure', async (failure) => {
    const probe = vi.fn(async () => 100_000n)

    await expect(
      estimateWithProbe(async () => Promise.reject(failure), probe, 64, 1.3)
    ).resolves.toBe(260_000n)
    expect(probe).toHaveBeenCalledOnce()
    expect(isRetryableEstimateError(failure)).toBe(true)
  })

  it('preserves a probe revert when a retryable full estimate triggers probing', async () => {
    const retryable = new Error('Gas estimation timed out after 40s')
    const probeRevert = Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      data: '0x1234'
    })

    await expect(
      estimateWithProbe(
        async () => Promise.reject(retryable),
        async () => Promise.reject(probeRevert),
        64,
        1.3
      )
    ).rejects.toBe(probeRevert)
  })

  it('does not probe when the requested unit count already fits the probe size', async () => {
    const failure = new Error('Gas estimation timed out after 40s')
    const probe = vi.fn(async () => 100_000n)

    await expect(
      estimateWithProbe(async () => Promise.reject(failure), probe, 32, 1.3)
    ).rejects.toBe(failure)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('current block gas safety limit', () => {
  it('accepts an estimate at the documented 90 percent boundary', () => {
    expect(assertFitsBlockGasLimit(27_000_000n, 30_000_000n)).toBe(27_000_000n)
  })

  it('rejects an estimate above the current block safety boundary without clipping', () => {
    expect(() => assertFitsBlockGasLimit(27_000_001n, 30_000_000n)).toThrow(
      /BATCH_GAS_LIMIT_EXCEEDED.*27,000,001.*27,000,000.*30,000,000/
    )
  })
})

describe('transaction trust boundary', () => {
  it.each([
    ['GENERAL_MINT', 'bulkClaimRank_'],
    ['CREATE_EMPTY_SLOT', 'createVMUs_'],
    ['MINT_EMPTY_SLOT', 'reuseVMUs_'],
    ['CLAIM', 'bulkClaimMintReward_'],
    ['CLAIM_REUSE', 'bulkClaimMintRewardAndClaimRank_']
  ] as const)('simulates %s with the strict factory method', (op, functionName) => {
    expect(strictSimulationFunction(op)).toBe(functionName)
  })

  it('uses only the wallet-read factory fee to calculate transaction value', () => {
    expect(
      authoritativeServiceValue({
        walletFee: 18_000n,
        units: 3,
        feeApplies: true
      })
    ).toBe(54_000n)
  })

  it('rejects an invalid wallet-reported fee', () => {
    expect(() =>
      authoritativeServiceValue({
        walletFee: -1n,
        units: 3,
        feeApplies: true
      })
    ).toThrow(/Invalid service fee inputs/)
  })

  it('does not attach value on free operations', () => {
    expect(
      authoritativeServiceValue({
        walletFee: 18_000n,
        units: 3,
        feeApplies: false
      })
    ).toBeUndefined()
  })
})

describe('prepared operation context', () => {
  const prepared = {
    wallet: '0x0000000000000000000000000000000000000001',
    chainId: 1,
    preparedAt: 10_000,
    expiresAt: 130_000
  }

  it('accepts the same account and chain before expiry', () => {
    expect(() =>
      assertPreparedContext(prepared, '0x0000000000000000000000000000000000000001', 1, 129_999)
    ).not.toThrow()
  })

  it.each([
    ['account', '0x0000000000000000000000000000000000000002', 1, 20_000],
    ['chain', '0x0000000000000000000000000000000000000001', 137, 20_000],
    ['expiry', '0x0000000000000000000000000000000000000001', 1, 130_001]
  ])('rejects a prepared operation after %s changes', (_label, account, chainId, now) => {
    expect(() => assertPreparedContext(prepared, account, chainId, now)).toThrow()
  })
})

describe('operation input validation', () => {
  it.each([
    { count: 1.5, term: 100, ids: [] },
    { count: 1, term: 100.5, ids: [] }
  ])('rejects non-integer transaction inputs', ({ count, term, ids }) => {
    expect(() =>
      validateOperationParams({ chain: 'eth', op: 'GENERAL_MINT', ids, count, term })
    ).toThrow(/whole number/)
  })

  it.each([[[0, 2]], [[1.5, 2]], [[Number.MAX_SAFE_INTEGER + 1]]])(
    'rejects invalid VMU ids: %j',
    (ids) => {
      expect(() =>
        validateOperationParams({
          chain: 'eth',
          op: 'CLAIM',
          ids,
          count: 0,
          term: 0
        })
      ).toThrow(/VMU ids must be unique positive whole numbers/)
    }
  )

  it('rejects duplicate VMU ids', () => {
    expect(() =>
      validateOperationParams({
        chain: 'eth',
        op: 'CLAIM',
        ids: [1, 1],
        count: 0,
        term: 0
      })
    ).toThrow(/VMU ids must be unique positive whole numbers/)
  })
})
