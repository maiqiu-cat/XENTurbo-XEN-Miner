import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchRequest, Interface } from 'ethers'
import { Multicall3ABI } from '@/abis/Multicall3ABI'
import { XENCryptoABI } from '@/abis/XENCryptoABI'
import { readVmuStates, readWalletVmus } from '@/core/chainReader'
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
const unavailableAddresses = new Set<string>()
const multicall = new Interface(Multicall3ABI)
const xen = new Interface(XENCryptoABI)
const multicallSizes: number[] = []
let multicallError: { code: number; message: string; data?: string } | undefined

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
  resetProviders()
  requests.length = 0
  unavailableUrls.clear()
  unavailableAddresses.clear()
  multicallSizes.length = 0
  multicallError = undefined
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
      if (
        method === 'eth_getCode' &&
        (unavailableUrls.has(request.url) || unavailableAddresses.has(String(params[0])))
      ) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'temporary read failure' } }
      }
      if (method === 'eth_call' && multicallError)
        return { jsonrpc: '2.0', id, error: multicallError }
      let result: unknown
      if (method === 'eth_chainId') result = chainId
      else if (method === 'eth_blockNumber') result = '0x2a'
      else if (method === 'eth_getBlockByNumber')
        result = {
          hash: `0x${'b'.repeat(64)}`,
          parentHash: `0x${'a'.repeat(64)}`,
          number: '0x2a',
          timestamp: '0x6b49d200',
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: '0x1111111111111111111111111111111111111111',
          extraData: '0x',
          transactions: []
        }
      else if (method === 'eth_getCode') result = `0x60${String(params[0]).slice(-2)}`
      else if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data
        const calls = multicall.decodeFunctionData('aggregate3', data)[0] as Array<{
          callData: string
        }>
        multicallSizes.push(calls.length)
        result = multicall.encodeFunctionResult('aggregate3', [
          calls.map(({ callData }) => {
            const [proxy] = xen.decodeFunctionData('userMints', callData)
            return [
              true,
              xen.encodeFunctionResult('userMints', [proxy, 10n, 1_700_000_000n, 100n, 3_000n, 0n])
            ]
          })
        ])
      } else throw new Error(`Unexpected RPC method: ${method}`)
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
  for (const mode of ['wallet', 'selected'] as const) {
    it.each([
      [{ code: -32000, message: 'result length 128064 exceeding limit 100000' }, 2],
      [{ code: -32603, message: 'Internal error' }, 2],
      [{ code: 3, message: 'execution reverted', data: '0xabcd' }, 1]
    ] as const)(
      `does not replay non-retryable failures during a ${mode} scan: %j`,
      async (error, expectedPosts) => {
        chainId = '0x1'
        const endpoints = ['https://rpc-a.example/', 'https://rpc-b.example/']
        writeCustomRpc('eth', endpoints)
        const provider = await ensureHealthyReadProvider('eth', async () => chainId)
        await provider.getBlockNumber()
        requests.length = 0
        multicallError = error
        const wallet = '0x1111111111111111111111111111111111111111'
        const vmus =
          mode === 'wallet'
            ? await readWalletVmus('eth', wallet, {
                vmuCount: 400,
                chainTimestampMs: 1_800_000_000_000
              })
            : await readVmuStates(
                'eth',
                wallet,
                Array.from({ length: 400 }, (_, i) => i + 1),
                { blockTag: 42 }
              )
        expect(vmus).toHaveLength(400)
        expect(vmus.every((vmu) => !vmu.readOk && vmu.status === 'READ_ERROR')).toBe(true)
        const posts = requests.filter(({ calls }) =>
          calls.some(({ method }) => method === 'eth_call')
        )
        expect(posts.map(({ url }) => url)).toEqual(endpoints.slice(0, expectedPosts))
        expect(posts.every(({ calls }) => calls.length <= 3)).toBe(true)
      }
    )
  }

  it.each([
    ['eth', [400, 201], [3]],
    ['polygon', [300, 300, 1], [3, 2]]
  ] as const)(
    'keeps a hot 601-VMU %s scan within the existing wire and multicall limits',
    async (chain, sizes, postSizes) => {
      chainId = `0x${CHAINS[chain].chainId.toString(16)}`
      writeCustomRpc(chain, ['https://rpc.example/'])
      const provider = await ensureHealthyReadProvider(chain, async () => chainId)
      await provider.getBlockNumber()
      requests.length = 0
      const vmus = await readWalletVmus(chain, '0x1111111111111111111111111111111111111111', {
        vmuCount: 601,
        chainTimestampMs: 1_800_000_000_000
      })
      expect(vmus).toHaveLength(601)
      expect(vmus.every((vmu) => vmu.readOk && vmu.status === 'CLAIMABLE')).toBe(true)
      expect(vmus.map((vmu) => vmu.id)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1))
      expect(multicallSizes).toEqual(sizes)
      expect(requests.map(({ calls }) => calls.length)).toEqual(postSizes)
      expect(requests.map(({ calls }) => calls.map(({ method }) => method).sort())).toEqual(
        postSizes.map((size) => ['eth_chainId', ...Array<string>(size - 1).fill('eth_call')].sort())
      )
      expect(new Set(requests.map(({ url }) => url))).toEqual(new Set(['https://rpc.example/']))
    }
  )

  it('preserves explicit RPC read errors instead of returning empty code or deleting nodes', async () => {
    chainId = '0x89'
    const urls = ['https://rpc0.example/', 'https://rpc1.example/']
    writeCustomRpc('polygon', urls)
    const provider = await ensureHealthyReadProvider('polygon', async () => chainId)
    urls.forEach((url) => unavailableUrls.add(url))
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
      expect(new Set(requests.map(({ url }) => url))).toEqual(new Set([urls[0]]))
      const codeCalls = requests
        .flatMap(({ calls }) => calls)
        .filter(({ method }) => method === 'eth_getCode')
      expect(codeCalls).toHaveLength(32)
      expect(codeCalls.every(({ params }) => params[1] === '0x2a')).toBe(true)
      expect(readCustomRpc(chain)).toEqual(urls)
    }
  )

  it('isolates a failed item from successful siblings in the same reversed batch', async () => {
    chainId = '0x89'
    writeCustomRpc('polygon', ['https://rpc.example/'])
    const provider = await ensureHealthyReadProvider('polygon', async () => chainId)
    await provider.getBlockNumber()
    requests.length = 0
    const addresses = [1, 2, 3].map((id) => `0x${id.toString(16).padStart(40, '0')}`)
    unavailableAddresses.add(addresses[1])
    const results = await Promise.allSettled(
      addresses.map((address) => provider.getCode(address, 42))
    )
    expect(results).toEqual([
      { status: 'fulfilled', value: '0x6001' },
      { status: 'rejected', reason: expect.objectContaining({ code: 'UNKNOWN_ERROR' }) },
      { status: 'fulfilled', value: '0x6003' }
    ])
    expect(
      requests.some(
        ({ calls }) =>
          calls.some(({ params }) => params[0] === addresses[0]) &&
          calls.some(({ params }) => params[0] === addresses[1])
      )
    ).toBe(true)
    expect(requests.every(({ calls }) => calls.length <= 3)).toBe(true)
  })
})
