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
import { rpcRetryAfterMs } from '@/core/rpcPolicy'

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
          result: receiptAvailable
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
        JSON.stringify(Array.isArray(payload) ? replies.reverse() : replies[0])
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
  })

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
    const read = provider.getTransactionCount(address, 'pending').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await read).toBe(7)
    expect(readRequests().map(({ url }) => url)).toEqual([urls[1]])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(readRequests().map(({ url }) => url)).toEqual([urls[1]])
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
    await vi.advanceTimersByTimeAsync(100)
    expect(await current).toBe('0x6001')
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
      failures.set(urls[0], { failDiscoveryAfter: 1 })
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

  it.each(['timeout', 'abort', 'permanent error', 'rate limit'] as const)(
    'cleans up confirmation polling after %s without a late request',
    async (kind) => {
      const provider = await ready(1)
      const controller = new AbortController()
      if (kind === 'permanent error')
        failures.set(urls[0], { error: { code: -32602, message: 'invalid params' } })
      if (kind === 'rate limit') failures.set(urls[0], { status: 429, retryAfter: '30' })
      const result = provider
        .withSignal(controller.signal)
        .waitForTransaction(hash, 1, 500)
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      if (kind === 'abort') controller.abort()
      await vi.advanceTimersByTimeAsync(500)
      const error = await result
      if (kind === 'abort') expect(error).toMatchObject({ name: 'AbortError' })
      else if (kind === 'permanent error') expect(isRetryableRpcError(error)).toBe(false)
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
})

describe('one retry layer and structured errors', () => {
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

  it('caps server backoff by the total deadline without another request', async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 429'), {
        response: { statusCode: 429, headers: { 'retry-after': '30' } }
      })
    })
    const result = withRetry(operation, { totalTimeoutMs: 1_000 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await result).toBeInstanceOf(ReadTimeoutError)
    expect(operation).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
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
