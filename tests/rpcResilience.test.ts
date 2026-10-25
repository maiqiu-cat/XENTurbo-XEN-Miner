import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Contract, FetchRequest, Interface } from 'ethers'
import { Multicall3ABI } from '@/abis/Multicall3ABI'
import { readCustomRpc, writeCustomRpc } from '@/config/chains'
import {
  ensureHealthyReadProvider,
  getReadProvider,
  isRetryableRpcError,
  resetProviders,
  withRetry
} from '@/core/rpc'
import { ReadTimeoutError } from '@/core/readDeadline'
import { rpcFailureKind, rpcRetryAfterMs } from '@/core/rpcPolicy'

interface RpcCall {
  id: number
  method: string
  params: unknown[]
}
interface Failure {
  delay?: number
  status?: number
  retryAfter?: string
  error?: { code: number; message: string; data?: string }
  chainId?: string
  discoveryFailures?: number
  failDiscoveryAfter?: number
  discoveryDelay?: number
  body?: string
  malformedReceipt?: boolean
}

const originalTransport = new FetchRequest('https://rpc.example/').getUrlFunc
const urls = ['https://first.example/', 'https://second.example/', 'https://third.example/']
const address = '0x0000000000000000000000000000000000000001'
const multicallInterface = new Interface(Multicall3ABI)
const calls = [{ target: address, allowFailure: true, callData: '0x' }]
const encoded = multicallInterface.encodeFunctionResult('aggregate3', [[[true, '0xab']]])
const requests: Array<{ url: string; calls: RpcCall[] }> = []
const failures = new Map<string, Failure>()
const discoveries = new Map<string, number>()
const hash = `0x${'a'.repeat(64)}`
let receiptAvailable = false
let blockHeight = 42

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
  vi.stubGlobal('fetch', () => {
    throw new Error('Unexpected real network request')
  })
  resetProviders()
  failures.clear()
  discoveries.clear()
  requests.length = 0
  receiptAvailable = false
  blockHeight = 42
  FetchRequest.registerGetUrl(async (request) => {
    if (!urls.includes(request.url)) throw new Error('Unexpected RPC host')
    const payload = JSON.parse(new TextDecoder().decode(request.body!)) as RpcCall | RpcCall[]
    const batch = Array.isArray(payload) ? payload : [payload]
    requests.push({ url: request.url, calls: batch })
    const failure = failures.get(request.url)
    if (failure?.discoveryDelay && batch.every(({ method }) => method === 'eth_chainId')) {
      await new Promise((resolve) => setTimeout(resolve, failure.discoveryDelay))
    }
    if (batch.some(({ method }) => method === 'eth_chainId'))
      discoveries.set(request.url, (discoveries.get(request.url) ?? 0) + 1)
    if (
      failure?.failDiscoveryAfter !== undefined &&
      (discoveries.get(request.url) ?? 0) > failure.failDiscoveryAfter
    ) {
      return { statusCode: 503, statusMessage: 'Unavailable', headers: {}, body: new Uint8Array() }
    }
    if (failure?.discoveryFailures && batch.every(({ method }) => method === 'eth_chainId')) {
      failure.discoveryFailures -= 1
      return { statusCode: 503, statusMessage: 'Unavailable', headers: {}, body: new Uint8Array() }
    }
    const reads = batch.some(({ method }) => method !== 'eth_chainId')
    if (failure?.delay && reads) {
      await new Promise((resolve) => setTimeout(resolve, failure.delay))
    }
    const replies = batch.map(({ id, method }) => {
      if (method !== 'eth_chainId' && failure?.error) {
        return { jsonrpc: '2.0', id, error: failure.error }
      }
      if (method === 'eth_getTransactionReceipt')
        return {
          jsonrpc: '2.0',
          id,
          result: failure?.malformedReceipt
            ? { transactionHash: hash }
            : receiptAvailable
              ? {
                  blockHash: `0x${'b'.repeat(64)}`,
                  blockNumber: '0x2a',
                  contractAddress: null,
                  cumulativeGasUsed: '0x5208',
                  effectiveGasPrice: '0x3b9aca00',
                  from: address,
                  gasUsed: '0x5208',
                  logs: [],
                  logsBloom: `0x${'0'.repeat(512)}`,
                  status: '0x1',
                  to: address,
                  transactionHash: hash,
                  transactionIndex: '0x0',
                  type: '0x2'
                }
              : null
        }
      const result =
        method === 'eth_chainId'
          ? (failure?.chainId ?? '0x1')
          : method === 'eth_blockNumber'
            ? `0x${blockHeight.toString(16)}`
            : method === 'eth_getTransactionCount'
              ? '0x7'
              : method === 'eth_call'
                ? encoded
                : method === 'eth_getCode'
                  ? '0x6001'
                  : null
      if (result === null) throw new Error(`Unexpected method: ${method}`)
      return { jsonrpc: '2.0', id, result }
    })
    return {
      statusCode: reads ? (failure?.status ?? 200) : 200,
      statusMessage: 'Fixture',
      headers: {
        'content-type': 'application/json',
        ...(failure?.retryAfter ? { 'retry-after': failure.retryAfter } : {})
      },
      body: new TextEncoder().encode(
        reads && failure?.body !== undefined
          ? failure.body
          : JSON.stringify(Array.isArray(payload) ? replies.reverse() : replies[0])
      )
    }
  })
})

afterEach(() => {
  resetProviders()
  FetchRequest.registerGetUrl(originalTransport)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function ready(count = 2) {
  writeCustomRpc('eth', urls.slice(0, count))
  const provider = await ensureHealthyReadProvider('eth', async () => '0x1')
  const warm = provider.getBlockNumber()
  await vi.advanceTimersByTimeAsync(100)
  await warm
  requests.length = 0
  return provider
}

function readRequests(method = 'eth_getTransactionCount') {
  return requests.filter(({ calls: batch }) => batch.some((call) => call.method === method))
}

describe('bounded read-only RPC failover', () => {
  it('returns the second answer before a twenty-second first endpoint completes', async () => {
    const provider = await ready()
    failures.set(urls[0], { delay: 20_000 })
    let value: number | undefined
    const read = provider
      .getTransactionCount(address, 'pending')
      .then((result) => {
        value = result
        return result
      })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(value).toBe(7)
    expect(await read).toBe(7)
    expect(readRequests().map(({ url }) => url)).toEqual(urls.slice(0, 2))
    expect(readCustomRpc('eth')).toEqual(urls.slice(0, 2))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(value).toBe(7)
    expect(readRequests()).toHaveLength(2)
  })

  it('moves to a healthy node immediately after an HTTP 503', async () => {
    const provider = await ready()
    failures.set(urls[0], { status: 503 })
    const read = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(200)
    await expect(read).resolves.toBe(7)
    expect(readRequests().map(({ url }) => url)).toEqual(urls.slice(0, 2))
  })

  it('does not amplify a healthy read to other endpoints', async () => {
    const provider = await ready(3)
    const read = provider.getTransactionCount(address, 'pending')
    await vi.advanceTimersByTimeAsync(100)
    await expect(read).resolves.toBe(7)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
    expect(requests).toHaveLength(1)
    expect(requests[0].calls.map(({ method }) => method).sort()).toEqual([
      'eth_chainId',
      'eth_getTransactionCount'
    ])
  })

  it.each([
    { status: 401 },
    { status: 403 },
    { status: 404 },
    { status: 413 },
    { body: '<html>upstream unavailable</html>' },
    {
      body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } })
    },
    { error: { code: -32601, message: 'Method not found' } },
    { error: { code: -32603, message: 'Internal JSON-RPC error.' } },
    { error: { code: -32000, message: 'header not found' } },
    { chainId: '0x89' }
  ] satisfies Failure[])('tries a peer once for endpoint failure %j', async (failure) => {
    const provider = await ready()
    failures.set(urls[0], failure)
    const result = withRetry(() => provider.getTransactionCount(address, 'pending')).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toBe(7)
    expect(readRequests().map(({ url }) => url)).toEqual(urls.slice(0, 2))
    expect(requests.every(({ calls }) => calls.length <= 3)).toBe(true)
  })

  it('batches network validation and a hot contract read into exactly one POST', async () => {
    const provider = await ready(1)
    const result = new Contract(address, Multicall3ABI, provider).aggregate3(calls)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toEqual([[true, '0xab']])
    expect(requests).toHaveLength(1)
    expect(requests[0].calls.map(({ method }) => method).sort()).toEqual([
      'eth_call',
      'eth_chainId'
    ])
  })

  it.each([
    ['contract', { code: 3, message: 'execution reverted', data: '0xabcd' }],
    ['contract', { code: -32602, message: 'invalid params' }],
    ['send', { code: 3, message: 'execution reverted', data: '0xabcd' }],
    ['send', { code: -32602, message: 'invalid params' }]
  ] as const)(
    'ignores semantic errors from a wrong-chain endpoint for %s',
    async (method, error) => {
      const provider = await ready()
      failures.set(urls[0], { chainId: '0x89', error })
      const read =
        method === 'contract'
          ? new Contract(address, Multicall3ABI, provider).aggregate3(calls)
          : provider.send('eth_call', [
              { to: address, data: multicallInterface.encodeFunctionData('aggregate3', [calls]) },
              'latest'
            ])
      const result = read.catch((failure: unknown) => failure)
      await vi.advanceTimersByTimeAsync(200)
      expect(await result).toEqual(method === 'contract' ? [[true, '0xab']] : encoded)
      expect(readRequests('eth_call').map(({ url }) => url)).toEqual(urls.slice(0, 2))
    }
  )

  it('stops future fallback dispatches when a read is cancelled', async () => {
    await ready(3)
    const controller = new AbortController()
    failures.set(urls[0], { delay: 20_000 })
    const result = getReadProvider('eth', controller.signal)
      .getTransactionCount(address, 'pending')
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
  })

  it('does not revive an obsolete read after a configuration reset', async () => {
    const provider = await ready(3)
    failures.set(urls[0], { delay: 20_000 })
    const result = withRetry(() => provider.getTransactionCount(address, 'pending')).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(100)
    resetProviders('eth')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toMatchObject({ name: 'RpcReadInvalidatedError' })
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
  })

  it('rejects a node that changes chain after successful initialization', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { chainId: '0x89' })
    const read = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(200)
    expect(await read).toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('falls back from cold network detection without an unbounded bootstrap loop', async () => {
    writeCustomRpc('eth', urls.slice(0, 2))
    const provider = await ensureHealthyReadProvider('eth', async () => '0x1')
    failures.set(urls[0], { discoveryFailures: 100 })
    const result = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toBe(7)
    const completed = requests.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests).toHaveLength(completed)
    expect(readRequests().map(({ url }) => url)).toEqual([urls[1]])
  })

  it('does not dispatch a late call after a stalled chain lookup loses the race', async () => {
    writeCustomRpc('eth', urls.slice(0, 2))
    const provider = await ensureHealthyReadProvider('eth', async () => '0x1')
    failures.set(urls[0], { discoveryDelay: 20_000 })
    let settled = false
    const read = provider
      .getTransactionCount(address, 'pending')
      .then((result) => {
        settled = true
        return result
      })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
    expect(settled).toBe(false) // A business result cannot bypass the unresolved chain check.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await read).toBe(7)
    expect(readRequests().map(({ url }) => url)).toEqual(urls.slice(0, 2))
    const completed = requests.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests).toHaveLength(completed)
    expect(readRequests().map(({ url }) => url)).toEqual(urls.slice(0, 2))
  })

  it('destroying one scoped reader does not destroy other readers or the shared pool', async () => {
    const provider = await ready()
    const scoped = provider.withSignal(new AbortController().signal)
    failures.set(urls[0], { delay: 20_000 })
    const read = scoped.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    scoped.destroy()
    expect(await read).toMatchObject({ name: 'AbortError' })
    failures.clear()
    const current = provider.getCode(address, 'latest').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await current).toBe('0x6001')
    expect(provider.destroyed).toBe(false)
    expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual(urls.slice(0, 2))
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
    const completed = requests.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests).toHaveLength(completed)
  })

  it('bounds all-stalled reads and ignores late results without further requests', async () => {
    const provider = await ready(3)
    urls.forEach((url) => failures.set(url, { delay: 20_000 }))
    const result = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await result).toBeInstanceOf(ReadTimeoutError)
    expect(readRequests().map(({ url }) => url)).toEqual(urls)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(readRequests()).toHaveLength(3)
  })

  it('stops ethers initial-network-discovery retries when a node fails during startup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      writeCustomRpc('eth', urls.slice(0, 2))
      const provider = await ensureHealthyReadProvider('eth', async () => '0x1')
      failures.set(urls[0], { failDiscoveryAfter: 0 })
      const result = provider
        .getTransactionCount(address, 'pending')
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await result).toBe(7)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to detect network'))
      const completed = requests.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requests).toHaveLength(completed)
    } finally {
      log.mockRestore()
    }
  })

  it('drains a started read on health replacement but forbids new reads through the retired pool', async () => {
    const provider = await ready()
    failures.set(urls[0], { delay: 500 })
    const read = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    const destroy = vi.spyOn(provider, 'destroy')
    await ensureHealthyReadProvider('eth', async (url) => {
      if (url === urls[0]) throw new Error('unavailable')
      return '0x1'
    })
    expect(destroy).not.toHaveBeenCalled()
    await expect(provider.send('eth_getCode', [address, 'latest'])).rejects.toMatchObject({
      name: 'RpcReadInvalidatedError'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await read).toBe(7)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('cancels the provider attempt when the outer read deadline expires', async () => {
    const provider = await ready(3)
    failures.set(urls[0], { delay: 20_000 })
    const result = withRetry(
      (signal) => provider.withSignal(signal).getTransactionCount(address, 'pending'),
      {
        timeoutMs: 100,
        retries: 0
      }
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toBeInstanceOf(ReadTimeoutError)
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
  })

  it('invalidates draining pools too when the user resets the RPC configuration', async () => {
    const provider = await ready()
    failures.set(urls[0], { delay: 20_000 })
    const result = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    await ensureHealthyReadProvider('eth', async (url) => {
      if (url === urls[0]) throw new Error('unavailable')
      return '0x1'
    })
    resetProviders('eth')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await result).toMatchObject({ name: 'RpcReadInvalidatedError' })
    expect(readRequests().map(({ url }) => url)).toEqual([urls[0]])
  })

  it('continues a confirmation wait during health replacement and cleans up afterwards', async () => {
    const provider = await ready()
    const result = provider.waitForTransaction(hash, 1, 10_000).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(readRequests('eth_getTransactionReceipt')).toHaveLength(1)
    await ensureHealthyReadProvider('eth', async (url) => {
      if (url === urls[0]) throw new Error('unavailable')
      return '0x1'
    })
    receiptAvailable = true
    failures.set(urls[0], { status: 503 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ hash, status: 1, blockNumber: 42 })
    expect(provider.destroyed).toBe(true)
    expect(await provider.listenerCount()).toBe(0)
    const finished = requests.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests).toHaveLength(finished)
  })

  it('stops confirmation polling immediately on explicit configuration reset', async () => {
    const provider = await ready()
    const result = provider.waitForTransaction(hash, 1, 10_000).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    resetProviders('eth')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ name: 'RpcReadInvalidatedError' })
    expect(await provider.listenerCount()).toBe(0)
    expect(readRequests('eth_getTransactionReceipt')).toHaveLength(1)
  })

  it.each(['network', 'configuration'] as const)(
    'drains confirmation leases instead of aborting them on background %s failure',
    async (failure) => {
      const provider = await ready()
      let settled = false
      const result = provider.waitForTransaction(hash, 1, 10_000).then(
        (receipt) => {
          settled = true
          return receipt
        },
        (error: unknown) => {
          settled = true
          return error
        }
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(readRequests('eth_getTransactionReceipt')).toHaveLength(1)
      if (failure === 'configuration')
        localStorage.setItem('sm.customRpc', JSON.stringify({ eth: ['http://invalid.example/'] }))
      await expect(
        ensureHealthyReadProvider('eth', async () => {
          throw new Error('ECONNRESET')
        })
      ).rejects.toThrow('RPC_UNAVAILABLE')
      expect(settled).toBe(false)
      expect(provider.destroyed).toBe(false)
      receiptAvailable = true
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await result).toMatchObject({ hash, status: 1 })
      expect(provider.destroyed).toBe(true)
      const completed = requests.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requests).toHaveLength(completed)
    }
  )

  it('keeps the confirmation lease alive through real 2.5-second health-probe timeouts', async () => {
    const provider = await ready()
    let settled = false
    const result = provider
      .waitForTransaction(hash, 1, 10_000)
      .then((receipt) => {
        settled = true
        return receipt
      })
      .catch((error: unknown) => {
        settled = true
        return error
      })
    await vi.advanceTimersByTimeAsync(100)
    const fetchProbe = vi.fn<typeof fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true
          })
        })
    )
    vi.stubGlobal('fetch', fetchProbe)
    const check = ensureHealthyReadProvider('eth').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(await check).toMatchObject({ message: expect.stringContaining('RPC_UNAVAILABLE') })
    expect(fetchProbe).toHaveBeenCalledTimes(2)
    expect(fetchProbe.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
    expect(settled).toBe(false)
    expect(provider.destroyed).toBe(false)
    receiptAvailable = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ hash, status: 1 })
    expect(provider.destroyed).toBe(true)
    const completed = requests.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests).toHaveLength(completed)
  })

  it.each([
    [-32000, 'header not found'],
    [-32000, 'missing trie node'],
    [-32000, 'unknown block'],
    [-32001, 'Resource not found.'],
    [-32603, 'Internal JSON-RPC error.'],
    [-32005, 'project ID request rate exceeded'],
    [-32007, '300/second request limit reached']
  ] as const)(
    'confirms through the second endpoint after receipt error %s / %s',
    async (code, message) => {
      const provider = await ready()
      receiptAvailable = true
      failures.set(urls[0], { error: { code, message } })
      const result = provider.waitForTransaction(hash, 1, 10_000).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(200)
      expect(await result).toMatchObject({ hash, status: 1 })
      expect(readRequests('eth_getTransactionReceipt').map(({ url }) => url)).toEqual(
        urls.slice(0, 2)
      )
      const completed = requests.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requests).toHaveLength(completed)
    }
  )

  it('keeps polling a single endpoint after an unclassified receipt error, until recovery', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { error: { code: -32603, message: 'Internal JSON-RPC error.' } })
    let settled = false
    const result = provider.waitForTransaction(hash, 1, 10_000).then(
      (receipt) => {
        settled = true
        return receipt
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    failures.clear()
    receiptAvailable = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ hash, status: 1 })
    expect(readRequests('eth_getTransactionReceipt')).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect(
      requests.every(
        ({ calls }) =>
          calls
            .map(({ method }) => method)
            .sort()
            .join(',') === 'eth_chainId,eth_getTransactionReceipt'
      )
    ).toBe(true)
  })

  it('tries another endpoint for a malformed receipt before promoting the bad endpoint', async () => {
    const provider = await ready()
    failures.set(urls[0], { malformedReceipt: true })
    receiptAvailable = true
    const result = provider.waitForTransaction(hash, 1, 10_000)
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toMatchObject({ hash, status: 1 })
    expect(readRequests('eth_getTransactionReceipt').map(({ url }) => url)).toEqual(
      urls.slice(0, 2)
    )
    const completed = requests.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests).toHaveLength(completed)
  })

  it('requires the requested confirmation count and supports a zero-confirmation read', async () => {
    const provider = await ready(1)
    const pending = provider.waitForTransaction(hash, 0)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toBeNull()
    receiptAvailable = true
    let resolved = false
    const result = provider.waitForTransaction(hash, 2, 10_000).then((receipt) => {
      resolved = true
      return receipt
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(resolved).toBe(false)
    blockHeight = 43
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await result).toMatchObject({ hash, status: 1 })
    expect((await result)?.provider).toBe(provider)
    expect(await provider.listenerCount()).toBe(0)
  })

  it.each(['timeout', 'abort', 'receipt error', 'rate limit'] as const)(
    'cleans up confirmation polling after %s without a late request',
    async (kind) => {
      const provider = await ready(1)
      const controller = new AbortController()
      if (kind === 'receipt error')
        failures.set(urls[0], { error: { code: -32602, message: 'invalid params' } })
      if (kind === 'rate limit') failures.set(urls[0], { status: 429, retryAfter: '30' })
      let settled = false
      const result = provider
        .withSignal(controller.signal)
        .waitForTransaction(hash, 1, 500)
        .catch((error: unknown) => error)
        .then((result) => {
          settled = true
          return result
        })
      await vi.advanceTimersByTimeAsync(100)
      expect(settled).toBe(false)
      if (kind === 'abort') controller.abort()
      await vi.advanceTimersByTimeAsync(500)
      const error = await result
      if (kind === 'abort') expect(error).toMatchObject({ name: 'AbortError' })
      else expect(error).toMatchObject({ code: 'TIMEOUT' })
      const completed = requests.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requests).toHaveLength(completed)
      expect(await provider.listenerCount()).toBe(0)
      resetProviders()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('rejects invalid confirmation options before any request', async () => {
    const provider = await ready(1)
    await expect(provider.waitForTransaction('0xinvalid', 1, 100)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(provider.waitForTransaction(hash, -1, 100)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(provider.waitForTransaction(hash, 1, -1)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    expect(requests).toEqual([])
  })

  it('does not retry a revert or broadcast through any configured endpoint', async () => {
    const provider = await ready()
    failures.set(urls[0], { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } })
    const contract = new Contract(address, Multicall3ABI, provider)
    const result = withRetry(() => contract.aggregate3(calls)).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ code: 'CALL_EXCEPTION' })
    expect(readRequests('eth_call').map(({ url }) => url)).toEqual([urls[0]])
    const count = requests.length
    await expect(provider.send('eth_sendRawTransaction', ['0xab'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION'
    })
    await expect(
      provider._perform({ method: 'broadcastTransaction', signedTransaction: '0xab' })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(requests).toHaveLength(count)
  })

  it('uses a compatible peer for a capacity error without repeating the oversized call', async () => {
    const provider = await ready()
    failures.set(urls[0], {
      error: { code: 3, message: 'result length 128064 exceeding limit 100000' }
    })
    const result = withRetry(() =>
      new Contract(address, Multicall3ABI, provider).aggregate3(calls)
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toEqual([[true, '0xab']])
    expect(readRequests('eth_call').map(({ url }) => url)).toEqual(urls.slice(0, 2))
  })

  it('does not replay an oversized request when the remaining peer is rate-limited', async () => {
    const provider = await ready()
    failures.set(urls[0], {
      error: { code: 3, message: 'result length 128064 exceeding limit 100000' }
    })
    failures.set(urls[1], { status: 429, retryAfter: '1' })
    const result = withRetry(() =>
      new Contract(address, Multicall3ABI, provider).aggregate3(calls)
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isRetryableRpcError(await result)).toBe(false)
    expect(readRequests('eth_call').map(({ url }) => url)).toEqual(urls.slice(0, 2))
  })

  it('does not replay an unknown internal error when the peer is rate-limited', async () => {
    const provider = await ready()
    failures.set(urls[0], { error: { code: -32603, message: 'Internal error' } })
    failures.set(urls[1], { status: 429 })
    const result = withRetry(() => provider.send('eth_getCode', [address, 'latest'])).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isRetryableRpcError(await result)).toBe(false)
    expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual(urls.slice(0, 2))
    expect(requests).toHaveLength(3) // The cold peer also initializes its network.
  })

  it.each([-32600, -32602])(
    'does not fail over or replay invalid request code %s',
    async (code) => {
      const provider = await ready()
      failures.set(urls[0], { error: { code, message: 'timeout' } })
      const result = withRetry(() => provider.send('eth_getCode', [address, 'latest'])).catch(
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(isRetryableRpcError(await result)).toBe(false)
      expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual([urls[0]])
      expect(requests).toHaveLength(1)
    }
  )
})

describe('one retry layer and structured errors', () => {
  it.each([
    [{ code: -32005, message: 'unknown quota wording' }, 'rate-limit'],
    [{ code: -32007, message: 'opaque provider diagnostic' }, 'rate-limit'],
    [{ code: 429, message: 'opaque provider diagnostic' }, 'rate-limit'],
    [{ code: -32600, message: 'rate limit' }, 'permanent'],
    [{ code: -32602, message: 'timeout' }, 'permanent'],
    [{ code: 3, message: 'execution reverted: rate limit' }, 'permanent'],
    [{ code: -32005, message: 'unknown', data: { data: '0xabcd' } }, 'permanent'],
    [{ code: -32005, message: 'query returned more than 1000 results' }, 'capacity'],
    [{ code: -32603, message: 'Internal error' }, 'endpoint'],
    [{ code: 'CALL_EXCEPTION', reason: 'insufficient balance' }, 'permanent'],
    [{ code: 'RPC_READ_INVALIDATED' }, 'permanent'],
    [{ code: 'CANCELLED' }, 'permanent'],
    [{ name: 'AbortError' }, 'permanent'],
    [{ code: 'INVALID_ARGUMENT' }, 'permanent'],
    [new Error('HTTP 404'), 'endpoint'],
    [null, 'endpoint'],
    ['network request failed', 'transient'],
    [{ response: { statusCode: 408 } }, 'transient'],
    [{ response: { statusCode: 503 } }, 'transient']
  ] as const)('classifies raw errors without bypassing semantic vetoes: %j', (error, kind) => {
    expect(rpcFailureKind(error)).toBe(kind)
  })
  it('makes at most four multicall POSTs, not 48, for Retry-After: 1', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { status: 429, retryAfter: '1' })
    const contract = new Contract(address, Multicall3ABI, provider)
    const sleep = vi.fn(
      (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
    )
    const result = withRetry(() => contract.aggregate3(calls), {
      sleep,
      jitterRatio: 0
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ code: 'SERVER_ERROR' })
    expect(readRequests('eth_call')).toHaveLength(4)
    expect(sleep.mock.calls).toEqual([[1_000], [1_000], [1_600]])
  })

  it.each([
    [{ code: -32005, message: 'Too Many Requests' }, true],
    [{ code: -32005, message: 'limit exceeded' }, true],
    [{ code: -32005, message: 'request rate exceeded' }, true],
    [{ code: -32005, message: 'project ID request rate exceeded' }, true],
    [{ code: -32005, message: 'exceeded the quota' }, true],
    [{ code: -32007, message: '300/second request limit reached' }, true],
    [{ code: 429, message: 'Your app has exceeded its compute units per second capacity' }, true],
    [{ code: -32000, message: 'header not found' }, true],
    [{ code: -32000, message: 'unknown block' }, true],
    [{ code: -32000, message: 'block not found' }, true],
    [{ code: -32000, message: 'missing trie node' }, true],
    [{ code: -32000, message: 'state is not available' }, true],
    [{ code: -32000, message: 'execution aborted (timeout = 5s)' }, true],
    [{ code: -32603, message: 'upstream temporarily unavailable' }, true],
    [{ code: -32000, message: 'result length 128064 exceeding limit 100000' }, false],
    [{ code: 3, message: 'result length 128064 exceeding limit 100000' }, false],
    [{ code: -32005, message: 'query returned more than 10000 results' }, false],
    [{ code: -32000, message: 'execution reverted' }, false],
    [{ code: -32005, message: 'Too Many Requests', data: '0x08c379a0' }, false],
    [{ code: -32603, message: 'Internal error' }, false]
  ] as const)('classifies the actual eth_call wrapper for %j', async (error, retryable) => {
    const provider = await ready(1)
    failures.set(urls[0], { error })
    const contract = new Contract(address, Multicall3ABI, provider)
    const result = contract.aggregate3(calls).catch((caught: unknown) => caught)
    await vi.advanceTimersByTimeAsync(200)
    const wrapped = await result
    expect(wrapped).toMatchObject({ code: 'CALL_EXCEPTION', info: { error } })
    expect(isRetryableRpcError(wrapped)).toBe(retryable)
    expect(readRequests('eth_call')).toHaveLength(1)
  })

  it('does not shorten a server Retry-After to the exponential cap or negative jitter', async () => {
    const fail = Object.assign(new Error('HTTP 429'), {
      response: { statusCode: 429, headers: { 'retry-after': '10' } }
    })
    const operation = vi.fn().mockRejectedValueOnce(fail).mockResolvedValue('ok')
    const sleep = vi.fn(async () => {})
    await expect(withRetry(operation, { sleep, random: () => 0 })).resolves.toBe('ok')
    expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000)
  })

  it('reports rate limiting immediately when server backoff cannot fit the remaining budget', async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 429'), {
        response: { statusCode: 429, headers: { 'retry-after': '30' } }
      })
    })
    const sleep = vi.fn(async () => {})
    const result = await withRetry(operation, { totalTimeoutMs: 1_000, sleep }).catch(
      (error: unknown) => error
    )
    expect(result).toMatchObject({ code: 'RPC_RATE_LIMITED', retryAfterMs: 30_000 })
    expect(sleep).not.toHaveBeenCalled()
    expect(operation).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not burn a zero-request retry when 429 has no Retry-After', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { status: 429 })
    const sleep = vi.fn(
      (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
    )
    const result = withRetry(
      () => new Contract(address, Multicall3ABI, provider).aggregate3(calls),
      {
        sleep,
        jitterRatio: 0
      }
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ code: 'SERVER_ERROR' })
    expect(readRequests('eth_call')).toHaveLength(4)
    expect(sleep.mock.calls).toEqual([[1_000], [1_000], [1_600]])
  })

  it('reports current cooldown without stale errors and caps it at sixty seconds', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { status: 429, retryAfter: '3600' })
    const first = provider.send('eth_getCode', [address, 'latest']).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await first).toMatchObject({ code: 'SERVER_ERROR' })
    failures.clear()
    requests.length = 0
    const cooling = await provider
      .send('eth_getCode', [address, 'latest'])
      .catch((error: unknown) => error)
    expect(cooling).toMatchObject({ code: 'RPC_RATE_LIMITED' })
    expect(rpcRetryAfterMs(cooling)).toBeGreaterThan(59_000)
    expect(rpcRetryAfterMs(cooling)).toBeLessThanOrEqual(60_000)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    const recovered = provider.send('eth_getCode', [address, 'latest'])
    await vi.advanceTimersByTimeAsync(100)
    expect(await recovered).toBe('0x6001')
    expect(readRequests('eth_getCode')).toHaveLength(1)
  })

  it('resumes receipt polling within the capped cooldown after an oversized Retry-After', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { status: 429, retryAfter: '3600' })
    let settled = false
    const result = provider
      .waitForTransaction(hash, 1, 180_000)
      .then((receipt) => {
        settled = true
        return receipt
      })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    failures.clear()
    receiptAvailable = true
    await vi.advanceTimersByTimeAsync(61_000)
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ hash, status: 1 })
    expect(readRequests('eth_getTransactionReceipt')).toHaveLength(2)
    const completed = requests.length
    await vi.advanceTimersByTimeAsync(180_000)
    expect(requests).toHaveLength(completed)
  })

  it('clears endpoint cooldown after a successful explicit health recheck of the same pool', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { status: 429, retryAfter: '3600' })
    const first = provider.send('eth_getCode', [address, 'latest']).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    await first
    failures.clear()
    const checked = await ensureHealthyReadProvider('eth', async () => '0x1')
    expect(checked).toBe(provider)
    requests.length = 0
    const recovered = provider
      .send('eth_getCode', [address, 'latest'])
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await recovered).toBe('0x6001')
    expect(readRequests('eth_getCode')).toHaveLength(1)
  })

  it('does not erase a newer rate limit when an older health probe finishes late', async () => {
    const provider = await ready(1)
    let release!: (value: string) => void
    const checked = ensureHealthyReadProvider(
      'eth',
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(10)
    failures.set(urls[0], { status: 429, retryAfter: '30' })
    const result = provider
      .send('eth_getCode', [address, 'latest'])
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ code: 'SERVER_ERROR' })
    release('0x1')
    expect(await checked).toBe(provider)
    requests.length = 0
    await expect(provider.send('eth_getCode', [address, 'latest'])).rejects.toMatchObject({
      code: 'RPC_RATE_LIMITED'
    })
    expect(requests).toEqual([])
  })

  it('returns to configured endpoint order after a successful health recheck', async () => {
    const provider = await ready()
    failures.set(urls[0], { status: 503 })
    const initial = provider.send('eth_getCode', [address, 'latest'])
    await vi.advanceTimersByTimeAsync(100)
    expect(await initial).toBe('0x6001')
    failures.clear()
    expect(await ensureHealthyReadProvider('eth', async () => '0x1')).toBe(provider)
    requests.length = 0
    const read = provider.send('eth_getCode', [address, 'latest'])
    await vi.advanceTimersByTimeAsync(100)
    expect(await read).toBe('0x6001')
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(urls[0])
    expect(requests[0].calls.map(({ method }) => method).sort()).toEqual([
      'eth_chainId',
      'eth_getCode'
    ])
  })

  it.each(['0', '30', 'Sun, 25 Oct 2026 00:00:30 GMT', 'garbage', '1.5', '-1'])(
    'parses Retry-After seconds and HTTP dates conservatively: %s',
    (header) => {
      const now = Date.UTC(2026, 9, 25)
      const expected =
        header === '0' ? 0 : header === '30' || header.startsWith('Sun,') ? 30_000 : null
      expect(rpcRetryAfterMs({ response: { headers: { 'retry-after': header } } }, now)).toBe(
        expected
      )
    }
  )
})
