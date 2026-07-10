import { describe, expect, it, vi } from 'vitest'
import {
  assertFitsBlockGasLimit,
  estimateWithProbe,
  isRetryableEstimateError
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
