import { describe, expect, it, vi } from 'vitest'
import { Interface } from 'ethers'
import { checkRpcEndpoint } from '../scripts/check-rpc-health.mjs'

const config = {
  chainId: 1,
  factory: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
}

const factoryInterface = new Interface(['function FEE() view returns (uint256)'])

describe('RPC health release gate', () => {
  it('requires HTTPS before probing an RPC endpoint', async () => {
    const fetchImpl = vi.fn()

    const result = await checkRpcEndpoint('http://rpc.example.test', config, fetchImpl)

    expect(result.healthy).toBe(false)
    expect(result.error).toContain('HTTPS_REQUIRED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts an HTTPS endpoint only when chain ID and factory FEE() both succeed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, jsonrpc: '2.0', result: '0x1' },
        {
          id: 2,
          jsonrpc: '2.0',
          result: factoryInterface.encodeFunctionResult('FEE', [123n])
        }
      ]
    })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result).toMatchObject({ healthy: true, chainId: 1, fee: 123n })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body as string)
    expect(request).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'eth_chainId' }),
        expect.objectContaining({ method: 'eth_call' })
      ])
    )
  })

  it('rejects a reachable endpoint that reports a different chain', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, jsonrpc: '2.0', result: '0x89' },
        {
          id: 2,
          jsonrpc: '2.0',
          result: factoryInterface.encodeFunctionResult('FEE', [123n])
        }
      ]
    })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result.healthy).toBe(false)
    expect(result.error).toContain('CHAIN_ID_MISMATCH')
  })
})
