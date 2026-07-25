import { describe, expect, it, vi } from 'vitest'
import { Interface } from 'ethers'
import { probeReleaseEndpoint } from '../scripts/probe-release-chain.mjs'

const factoryInterface = new Interface([
  'function FEE() view returns (uint256)',
  'function vmuCount(address) view returns (uint256)'
])
const config = {
  chainId: 1,
  factory: '0x0000000000000000000000000000000000000001',
  xenCrypto: '0x0000000000000000000000000000000000000002',
  vmuTemplate: '0x0000000000000000000000000000000000000003'
}

function validPayload() {
  return [
    { id: 1, result: '0x1' },
    { id: 2, result: '0x6001' },
    { id: 3, result: '0x6002' },
    { id: 4, result: '0x6003' },
    { id: 5, result: factoryInterface.encodeFunctionResult('FEE', [18n]) },
    { id: 6, result: factoryInterface.encodeFunctionResult('vmuCount', [0n]) }
  ]
}

describe('release chain probe', () => {
  it('requires the expected chain, all contract code, FEE and vmuCount reads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validPayload()
    })

    const result = await probeReleaseEndpoint('https://rpc.example', config, fetchImpl)

    expect(result).toMatchObject({
      healthy: true,
      chainId: 1,
      fee: 18n,
      vmuCount: 0n
    })
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(request.map((entry: { method: string }) => entry.method)).toEqual([
      'eth_chainId',
      'eth_getCode',
      'eth_getCode',
      'eth_getCode',
      'eth_call',
      'eth_call'
    ])
  })

  it('fails when any deployed contract has no bytecode', async () => {
    const payload = validPayload()
    payload[4 - 1] = { id: 4, result: '0x' }
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload
    })

    await expect(
      probeReleaseEndpoint('https://rpc.example', config, fetchImpl)
    ).resolves.toMatchObject({
      healthy: false,
      error: 'CONTRACT_CODE_MISSING: vmuTemplate'
    })
  })
})
