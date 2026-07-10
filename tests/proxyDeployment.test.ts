import { describe, expect, it, vi } from 'vitest'
import { CONTRACTS } from '../src/config/contracts'
import { computeProxyAddress, minimalProxyRuntimeCode } from '../src/core/create2'

const WALLET = '0x0000000000000000000000000000000000000001'

describe('VMU proxy deployment evidence', () => {
  it('distinguishes exact proxy code, wrong or absent code, and RPC read failures', async () => {
    vi.resetModules()
    const contracts = CONTRACTS.eth
    const addresses = new Map(
      [1, 2, 3].map((id) => [
        id,
        computeProxyAddress({
          factory: contracts.factory,
          vmuTemplate: contracts.vmuTemplate,
          wallet: WALLET,
          vmuId: id
        }).toLowerCase()
      ])
    )
    const provider = {
      getCode: vi.fn(async (address: string) => {
        const normalized = address.toLowerCase()
        if (normalized === addresses.get(1)) return minimalProxyRuntimeCode(contracts.vmuTemplate)
        if (normalized === addresses.get(2)) return '0x6000'
        throw new Error('RPC unavailable')
      })
    }

    vi.doMock('../src/core/rpc', () => ({
      getReadProvider: () => provider,
      withRetry: (read: () => Promise<unknown>) => read()
    }))

    const { readVmuProxyDeployments } = await import('../src/core/chainReader')
    const result = await readVmuProxyDeployments('eth', WALLET, [1, 2, 3])

    expect(result).toEqual(
      new Map([
        [1, 'DEPLOYED'],
        [2, 'MISSING'],
        [3, 'READ_ERROR']
      ])
    )
  })
})
