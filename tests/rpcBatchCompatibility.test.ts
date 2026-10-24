import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchRequest } from 'ethers'
import { CHAINS, readCustomRpc, writeCustomRpc, type ChainKey } from '@/config/chains'
import { ensureHealthyReadProvider, resetProviders } from '@/core/rpc'

interface RpcRequest {
  id: number
  method: string
  params: unknown[]
}

const originalTransport = new FetchRequest('https://rpc.example/').getUrlFunc
const requests: Array<{ url: string; calls: RpcRequest[] }> = []
let chainId = '0x1'
const unavailableUrls = new Set<string>()

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
  resetProviders()
  requests.length = 0
  unavailableUrls.clear()
  // Intercept only the HTTP boundary; keep ethers serialization, batching and ID matching real.
  FetchRequest.registerGetUrl(async (request) => {
    if (!request.body) throw new Error('Missing JSON-RPC request body')
    const payload = JSON.parse(new TextDecoder().decode(request.body)) as RpcRequest | RpcRequest[]
    const calls = Array.isArray(payload) ? payload : [payload]
    requests.push({ url: request.url, calls })
    const replies = calls.map(({ id, method, params }) => {
      if (calls.length > 3) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: 31, message: 'Batch of more than 3 requests are not allowed' }
        }
      }
      if (method === 'eth_getCode' && unavailableUrls.has(request.url)) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'temporary read failure' } }
      }
      let result: string
      if (method === 'eth_chainId') result = chainId
      else if (method === 'eth_blockNumber') result = '0x2a'
      else if (method === 'eth_getCode') result = `0x60${String(params[0]).slice(-2)}`
      else throw new Error(`Unexpected RPC method: ${method}`)
      return { jsonrpc: '2.0', id, result }
    })
    return {
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(
        JSON.stringify(Array.isArray(payload) ? replies.reverse() : replies[0])
      )
    }
  })
})

afterEach(() => {
  resetProviders()
  FetchRequest.registerGetUrl(originalTransport)
  vi.unstubAllGlobals()
})

describe('public RPC wire batch compatibility', () => {
  it('preserves explicit RPC read errors instead of returning empty code or deleting nodes', async () => {
    chainId = '0x89'
    const urls = ['https://rpc0.example/', 'https://rpc1.example/']
    writeCustomRpc('polygon', urls)
    const provider = await ensureHealthyReadProvider('polygon', async () => chainId)
    unavailableUrls.add(urls[0])
    await expect(
      provider.getCode('0x0000000000000000000000000000000000000001', 42)
    ).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      error: { code: -32000, message: 'temporary read failure' }
    })
    expect(requests.every(({ calls }) => calls.length <= 3)).toBe(true)
    expect(readCustomRpc('polygon')).toEqual(urls)
  })

  it('still rejects a node that switches chains after health validation', async () => {
    writeCustomRpc('polygon', ['https://rpc.example/'])
    const provider = await ensureHealthyReadProvider('polygon', async () => '0x89')
    chainId = '0x1'
    await expect(
      provider.getCode('0x0000000000000000000000000000000000000001', 42)
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(readCustomRpc('polygon')).toEqual(['https://rpc.example/'])
  })

  it.each([
    ['eth', 1],
    ['eth', 2],
    ['polygon', 1],
    ['polygon', 2]
  ] as const)(
    'reads 32 distinct codes on %s through %i endpoint(s) limited to three RPC items',
    async (chain: ChainKey, endpointCount) => {
      chainId = `0x${CHAINS[chain].chainId.toString(16)}`
      const urls = Array.from({ length: endpointCount }, (_, i) => `https://rpc${i}.example/`)
      writeCustomRpc(chain, urls)
      const provider = await ensureHealthyReadProvider(chain, async () => chainId)
      const addresses = Array.from(
        { length: 32 },
        (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`
      )
      const results = await Promise.allSettled(
        addresses.map((address) => provider.getCode(address, 42))
      )

      expect(results).toEqual(
        addresses.map((address) => ({ status: 'fulfilled', value: `0x60${address.slice(-2)}` }))
      )
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every(({ calls }) => calls.length >= 1 && calls.length <= 3)).toBe(true)
      expect(requests.some(({ calls }) => calls.length === 3)).toBe(true)
      expect(new Set(requests.map(({ url }) => url))).toEqual(new Set(urls))
      const codeCalls = requests
        .flatMap(({ calls }) => calls)
        .filter(({ method }) => method === 'eth_getCode')
      expect(codeCalls.length).toBeGreaterThanOrEqual(32)
      expect(codeCalls.every(({ params }) => params[1] === '0x2a')).toBe(true)
      expect(readCustomRpc(chain)).toEqual(urls)
    }
  )
})
