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
  ].map((entry) => ({ jsonrpc: '2.0', ...entry }))
}

function responseFor(payload: Array<{ id: number }>) {
  return vi.fn<typeof fetch>(async (_url, options) => {
    const requested = JSON.parse(String(options?.body)) as Array<{ id: number }>
    expect(requested.length).toBeLessThanOrEqual(3)
    return Response.json(
      payload.filter(({ id }) => requested.some((item) => item.id === id)).reverse()
    )
  })
}

describe('release chain probe', () => {
  it.each([1, 2, 3, 4, 5, 6])('escapes remote error controls for RPC result %s', async (id) => {
    const payload = validPayload().map((entry) =>
      entry.id === id
        ? { jsonrpc: '2.0', id, error: { message: '\u001b]0;forged\u0007\r\nPASS forged\u009b2J' } }
        : entry
    )
    const fetchImpl = responseFor(payload)
    const result = await probeReleaseEndpoint('https://rpc.example', config, fetchImpl)
    expect(result.healthy).toBe(false)
    for (const control of ['\r', '\n', '\u001b', '\u0007', '\u009b'])
      expect(result.error).not.toContain(control)
    expect(result.error).toContain('\\u001b')
  })

  it('requires the expected chain, all contract code, FEE and vmuCount reads', async () => {
    const fetchImpl = responseFor(validPayload())

    const result = await probeReleaseEndpoint('https://rpc.example', config, fetchImpl)

    expect(result).toMatchObject({
      healthy: true,
      chainId: 1,
      fee: 18n,
      vmuCount: 0n
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const request = fetchImpl.mock.calls.flatMap((call) => JSON.parse(String(call[1]?.body)))
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('error')
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
    payload[4 - 1] = { ...payload[4 - 1], result: '0x' }
    const fetchImpl = responseFor(payload)

    await expect(
      probeReleaseEndpoint('https://rpc.example', config, fetchImpl)
    ).resolves.toMatchObject({
      healthy: false,
      error: 'CONTRACT_CODE_MISSING: vmuTemplate'
    })
  })

  it('rejects a reply for the next batch instead of accepting it as current evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(validPayload().slice(3)))
    expect(await probeReleaseEndpoint('https://rpc.example', config, fetchImpl)).toMatchObject({
      healthy: false,
      error:
        'INVALID_RESULT: INVALID_BATCH_MEMBER: expected a JSON-RPC 2.0 result with a requested ID.'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'duplicate IDs',
      () => validPayload().map((item) => (item.id === 2 ? { ...item, id: 1 } : item)),
      'DUPLICATE_ID'
    ],
    [
      'wrong version',
      () => validPayload().map((item, index) => (index === 0 ? { ...item, jsonrpc: '1.0' } : item)),
      'INVALID_BATCH_MEMBER'
    ],
    [
      'noncanonical chain',
      () => validPayload().map((item, index) => (index === 0 ? { ...item, result: '0x01' } : item)),
      'INVALID_CHAIN_ID'
    ],
    ['missing result', () => validPayload().slice(0, 5), 'RPC_RESULT_MISSING: vmuCount'],
    [
      'conflicting error',
      () =>
        validPayload().map((item, index) =>
          index === 0 ? { ...item, error: { message: 'denied' } } : item
        ),
      'INVALID_RESULT: RPC result and error are mutually exclusive'
    ]
  ])('rejects malformed RPC batches: %s', async (_name, payload, error) => {
    const fetchImpl = responseFor(payload())
    expect(
      await probeReleaseEndpoint(
        'https://rpc.example',
        config,
        fetchImpl as unknown as typeof fetch
      )
    ).toMatchObject({ healthy: false, error: expect.stringContaining(error) })
  })
})
