import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Contract, FetchRequest, Interface } from 'ethers'
import { Multicall3ABI } from '@/abis/Multicall3ABI'
import { readCustomRpc, writeCustomRpc } from '@/config/chains'
import {
  ensureHealthyReadProvider,
  getReadProvider,
  isRetryableRpcError,
  resetProviders,
  RpcConfigurationError,
  withRetry
} from '@/core/rpc'
import { ReadTimeoutError } from '@/core/readDeadline'
import { RpcRateLimitError, rpcFailureKind, rpcRetryAfterMs } from '@/core/rpcPolicy'
import { normalizeError } from '@/core/txManager'
import { createI18n } from '@/i18n'

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
  receiptResult?: unknown
  readFailures?: number
}

const originalTransport = new FetchRequest('https://rpc.example/').getUrlFunc
const urls = ['https://first.example/', 'https://second.example/', 'https://third.example/']
const fourUrls = [...urls, 'https://fourth.example/']
const address = '0x0000000000000000000000000000000000000001'
const multicallInterface = new Interface(Multicall3ABI)
const calls = [{ target: address, allowFailure: true, callData: '0x' }]
const encoded = multicallInterface.encodeFunctionResult('aggregate3', [[[true, '0xab']]])
const requests: Array<{ url: string; calls: RpcCall[]; at: number }> = []
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
    if (!fourUrls.includes(request.url)) throw new Error('Unexpected RPC host')
    const payload = JSON.parse(new TextDecoder().decode(request.body!)) as RpcCall | RpcCall[]
    const batch = Array.isArray(payload) ? payload : [payload]
    requests.push({ url: request.url, calls: batch, at: Date.now() })
    let failure = failures.get(request.url)
    const discoveryDelay = failure?.discoveryDelay
    if (discoveryDelay && batch.every(({ method }) => method === 'eth_chainId')) {
      await new Promise((resolve) => setTimeout(resolve, discoveryDelay))
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
    if (reads && failure?.readFailures !== undefined) {
      if (failure.readFailures === 0) failure = undefined
      else failure.readFailures -= 1
    }
    const readDelay = failure?.delay
    if (readDelay && reads) {
      await new Promise((resolve) => setTimeout(resolve, readDelay))
    }
    const replies = batch.map(({ id, method }) => {
      if (method !== 'eth_chainId' && failure?.error) {
        return { jsonrpc: '2.0', id, error: failure.error }
      }
      if (method === 'eth_getTransactionReceipt')
        return {
          jsonrpc: '2.0',
          id,
          result:
            failure?.receiptResult ??
            (failure?.malformedReceipt
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
                : null)
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
  writeCustomRpc('eth', fourUrls.slice(0, count))
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
  it.each([408, 500, 503])(
    'recovers a single endpoint after an HTTP %s whole-batch invalid request',
    async (status) => {
      const provider = await ready(1)
      failures.set(urls[0], {
        status,
        readFailures: 1,
        body: JSON.stringify({ id: null, error: { code: -32600, message: 'Invalid request' } })
      })
      const sleep = vi.fn(
        (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
      )
      const result = withRetry(() => provider.send('eth_getCode', [address, 'latest']), {
        sleep,
        jitterRatio: 0
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await result).toBe('0x6001')
      expect(sleep.mock.calls).toEqual([[400]])
      expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual([urls[0], urls[0]])
      expect(requests).toHaveLength(2)
    }
  )

  for (const count of [1, 4]) {
    it.each([
      { code: -32600, message: 'Invalid request' },
      { code: -32000, message: 'header not found' }
    ])(
      `cools ${count} HTTP 429 endpoints before any replay and translates the error: %j`,
      async (error) => {
        const provider = await ready(count)
        const endpoints = fourUrls.slice(0, count)
        for (const url of endpoints)
          failures.set(url, {
            status: 429,
            retryAfter: '5',
            body: JSON.stringify({ id: null, error })
          })
        const read = () => provider.send('eth_getCode', [address, 'latest'])
        const first = read().catch((failure: unknown) => failure)
        await vi.advanceTimersByTimeAsync(100)
        const cause = await first
        expect(cause).toMatchObject({ code: 'SERVER_ERROR', response: { statusCode: 429 } })
        expect(rpcRetryAfterMs(cause)).toBe(5_000)
        expect(rpcFailureKind(cause)).toBe('rate-limit')
        const english = 'RPC endpoints are rate-limited. Retry in 5s. Your RPC list was preserved.'
        const chinese = 'RPC 節點受到限流。請於 5 秒後重試。RPC 清單已保留。'
        const translator = createI18n({
          languages: () => ['zh-TW'],
          storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} })
        })
        translator.restore()
        expect(normalizeError(cause)).toBe(english)
        expect(translator.message(normalizeError(cause))).toBe(chinese)
        expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual(endpoints)
        const firstPosts = requests.length
        const concurrent = [read(), read()].map((request) =>
          request.catch((failure: unknown) => failure)
        )
        await vi.advanceTimersByTimeAsync(100)
        for (const request of concurrent)
          expect(await request).toMatchObject({ code: 'RPC_RATE_LIMITED' })
        expect(requests).toHaveLength(firstPosts)
        await vi.advanceTimersByTimeAsync(5_000)
        requests.length = 0
        const sleep = vi.fn(
          (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
        )
        const result = withRetry(read, { sleep, jitterRatio: 0 }).catch(
          (failure: unknown) => failure
        )
        await vi.advanceTimersByTimeAsync(20_000)
        const exhausted = await result
        expect(exhausted).toMatchObject({
          code: 'RPC_RATE_LIMITED',
          cause: { code: 'SERVER_ERROR' }
        })
        expect(normalizeError(exhausted)).toBe(english)
        expect(translator.message(normalizeError(exhausted))).toBe(chinese)
        expect(sleep.mock.calls).toEqual([[5_000], [5_000], [5_000]])
        const reads = readRequests('eth_getCode')
        expect(reads).toHaveLength(count * 4)
        expect(requests).toHaveLength(count * 4)
        for (const endpoint of endpoints) {
          const attempts = reads.filter(({ url }) => url === endpoint)
          expect(attempts).toHaveLength(4)
          for (let i = 1; i < attempts.length; i++)
            expect(attempts[i].at - attempts[i - 1].at).toBeGreaterThanOrEqual(5_000)
        }
      }
    )
  }

  it.each([408, 500, 503])(
    'recovers a single endpoint after one HTTP %s ordinary JSON-RPC failure',
    async (status) => {
      const provider = await ready(1)
      failures.set(urls[0], {
        status,
        readFailures: 1,
        body: JSON.stringify({ id: null, error: { code: -32603, message: 'Internal error' } })
      })
      const sleep = vi.fn(
        (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
      )
      const result = withRetry(() => provider.send('eth_getCode', [address, 'latest']), {
        sleep,
        jitterRatio: 0
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await result).toBe('0x6001')
      expect(sleep.mock.calls).toEqual([[400]])
      expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual([urls[0], urls[0]])
      expect(requests).toHaveLength(2)
    }
  )

  it.each([500, 429])(
    'recovers after every endpoint fails once with HTTP %s and an ordinary RPC body',
    async (status) => {
      const provider = await ready(3)
      for (const url of urls)
        failures.set(url, {
          status,
          readFailures: 1,
          body: JSON.stringify({ id: null, error: { code: -32603, message: 'Internal error' } })
        })
      const result = withRetry(() => provider.send('eth_getCode', [address, 'latest']), {
        jitterRatio: 0
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await result).toBe('0x6001')
      expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual([...urls, urls[0]])
      expect(
        requests
          .filter(({ calls }) => calls.every(({ method }) => method === 'eth_chainId'))
          .map(({ url }) => url)
      ).toEqual(urls.slice(1))
      expect(requests).toHaveLength(6)
    }
  )

  it.each([undefined, '5'])(
    'cools down and retries an ordinary HTTP 429 RPC body with Retry-After %s',
    async (retryAfter) => {
      const provider = await ready(1)
      failures.set(urls[0], {
        status: 429,
        retryAfter,
        body: JSON.stringify({ id: null, error: { code: -32603, message: 'Internal error' } })
      })
      const first = provider
        .send('eth_getCode', [address, 'latest'])
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      const cause = await first
      expect(rpcFailureKind(cause)).toBe('rate-limit')
      expect(normalizeError(cause)).toBe(
        new RpcRateLimitError(retryAfter ? 5_000 : undefined).message
      )
      const skipped = provider
        .send('eth_getCode', [address, 'latest'])
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      expect(await skipped).toMatchObject({ code: 'RPC_RATE_LIMITED', cause })
      expect(readRequests('eth_getCode')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(retryAfter ? 5_000 : 1_000)
      requests.length = 0
      const sleep = vi.fn(
        (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
      )
      const result = withRetry(() => provider.send('eth_getCode', [address, 'latest']), {
        sleep,
        jitterRatio: 0
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await result).toMatchObject({
        code: 'RPC_RATE_LIMITED',
        cause: { code: 'SERVER_ERROR' }
      })
      expect(sleep.mock.calls).toEqual(
        retryAfter ? [[5_000], [5_000], [5_000]] : [[1_000], [1_000], [1_600]]
      )
      expect(readRequests('eth_getCode')).toHaveLength(4)
    }
  )

  for (const status of [200, 400, 429, 503]) {
    it.each(['Invalid request', 'batch size too large'])(
      `fails over from HTTP ${status} whole-batch -32600 without replaying the rejected endpoint: %s`,
      async (message) => {
        const provider = await ready()
        failures.set(urls[0], {
          status,
          body: JSON.stringify({ id: null, error: { code: -32600, message } })
        })
        const read = () =>
          withRetry(() => provider.send('eth_getCode', [address, 'latest'])).catch(
            (error: unknown) => error
          )
        const first = read()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(await first).toBe('0x6001')
        const second = read()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(await second).toBe('0x6001')
        expect(readRequests('eth_getCode').map(({ url }) => url)).toEqual([
          urls[0],
          urls[1],
          urls[1]
        ])
        expect(
          requests
            .filter(({ calls }) => calls.every(({ method }) => method === 'eth_chainId'))
            .map(({ url }) => url)
        ).toEqual([urls[1]])
        expect(requests).toHaveLength(4)
      }
    )
  }

  for (const status of [400, 500, 503]) {
    it.each([
      { code: 3, message: 'execution reverted', data: '0x08c379a0' },
      { code: -32602, message: 'invalid params' }
    ])(
      `does not replay or fail over an HTTP ${status} JSON-RPC semantic error: %j`,
      async (error) => {
        const provider = await ready(3)
        for (const url of urls)
          failures.set(url, { status, body: JSON.stringify({ jsonrpc: '2.0', id: null, error }) })
        const result = withRetry(() =>
          new Contract(address, Multicall3ABI, provider).aggregate3(calls)
        ).catch((failure: unknown) => failure)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await result).toMatchObject({
          code: 'SERVER_ERROR',
          response: { statusCode: status }
        })
        expect(rpcFailureKind(await result)).toBe('permanent')
        expect(requests).toHaveLength(1)
        expect(readRequests('eth_call').map(({ url }) => url)).toEqual([urls[0]])
      }
    )
  }

  it.each([
    [{ code: -32005, message: 'opaque provider diagnostic' }, 'rate-limit'],
    [{ code: -32000, message: 'header not found' }, 'transient']
  ] as const)('retries an unassigned whole-batch JSON-RPC error: %j', async (error, kind) => {
    const provider = await ready(3)
    for (const url of urls)
      failures.set(url, { body: JSON.stringify({ jsonrpc: '2.0', id: null, error }) })
    const direct = new Contract(address, Multicall3ABI, provider)
      .aggregate3(calls)
      .catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(100)
    const first = await direct
    expect(first).toMatchObject({ code: 'BAD_DATA', value: [{ id: null, error }] })
    expect(rpcFailureKind(first)).toBe(kind)
    if (kind === 'rate-limit') expect(normalizeError(first)).toBe(new RpcRateLimitError().message)
    await vi.advanceTimersByTimeAsync(1_000)
    requests.length = 0
    const result = withRetry(
      () => new Contract(address, Multicall3ABI, provider).aggregate3(calls),
      { jitterRatio: 0 }
    ).catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rpcFailureKind(await result)).toBe(kind)
    expect(readRequests('eth_call')).toHaveLength(12)
    for (const url of urls)
      expect(readRequests('eth_call').filter((request) => request.url === url)).toHaveLength(4)
    expect(requests.every(({ calls: batch }) => batch.length <= 3)).toBe(true)
  })

  it('does not classify the serialized SDK response body when structured HTTP details are absent', () => {
    const error = Object.assign(
      new Error('server error (responseBody="over capacity, quota exceeded")'),
      { code: 'SERVER_ERROR' }
    )
    expect(rpcFailureKind(error)).toBe('endpoint')
    expect(isRetryableRpcError(error)).toBe(false)
    expect(rpcFailureKind(Object.assign(error, { shortMessage: 'too many requests' }))).toBe(
      'rate-limit'
    )
  })
  it.each([undefined, '5'])(
    'reports only server-sourced cooldown seconds and retains cause: %s',
    async (retryAfter) => {
      const provider = await ready(1)
      failures.set(urls[0], { status: 429, retryAfter })
      const first = provider
        .getTransactionCount(address, 'pending')
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      const cause = await first
      const second = provider
        .withSignal(new AbortController().signal)
        .getTransactionCount(address, 'pending')
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      const error = (await second) as RpcRateLimitError
      expect(error).toBeInstanceOf(RpcRateLimitError)
      expect(error.cause).toBe(cause)
      expect(error.message).toBe(
        retryAfter
          ? 'RPC endpoints are rate-limited. Retry in 5s. Your RPC list was preserved.'
          : 'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
      )
      if (!retryAfter) expect(error.retryAfterMs).toBeUndefined()
      expect(readRequests()).toHaveLength(1)
    }
  )

  it.each([NaN, Infinity, -Infinity])(
    'does not invent a cooldown from non-finite delay %s',
    (delay) => {
      const error = new RpcRateLimitError(delay)
      expect(error.retryAfterMs).toBeUndefined()
      expect(error.message).toBe(
        'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
      )
    }
  )

  it.each([401, 403, 404, 408, 429, 503])(
    'classifies HTTP %i before incidental response-body keywords',
    (status) => {
      const error = Object.assign(
        new Error('server error (responseBody="Over capacity, quota exceeded")'),
        {
          shortMessage: `server response ${status}`,
          code: 'SERVER_ERROR',
          response: { statusCode: status }
        }
      )
      expect(rpcFailureKind(error)).toBe(
        status === 429 ? 'rate-limit' : status === 408 || status === 503 ? 'transient' : 'endpoint'
      )
    }
  )

  it.each([
    'block number too high',
    'block is in the future',
    'resource not found',
    'deadline exceeded'
  ])('retries a temporarily unavailable chain resource: %s', (message) => {
    const error = { code: 'CALL_EXCEPTION', info: { error: { code: -32000, message } } }
    expect(rpcFailureKind(error)).toBe('transient')
    expect(isRetryableRpcError(error)).toBe(true)
  })
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
        localStorage.setItem(
          'sm.customRpc',
          JSON.stringify({
            eth: Array.from({ length: 17 }, (_, index) => `https://rpc-${index}.example/`)
          })
        )
      const probe = vi.fn(async () => {
        throw new Error('ECONNRESET')
      })
      const error = await ensureHealthyReadProvider('eth', probe).catch((error: unknown) => error)
      if (failure === 'configuration') {
        expect(error).toBeInstanceOf(RpcConfigurationError)
        expect(error).toMatchObject({
          message: expect.stringContaining('Use at most 16 RPC endpoints')
        })
        expect(probe).not.toHaveBeenCalled()
      } else {
        expect(error).not.toBeInstanceOf(RpcConfigurationError)
        expect(error).toMatchObject({ message: expect.stringContaining('RPC_UNAVAILABLE') })
        expect(probe).toHaveBeenCalledTimes(2)
      }
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

  it.each([
    { code: -32602, message: 'opaque receipt diagnostic' },
    { code: 3, message: 'opaque receipt diagnostic', data: '0xabcd' }
  ])('does not interpret an invalid receipt result as a batch RPC error: %j', async (error) => {
    const provider = await ready()
    failures.set(urls[0], { receiptResult: { error } })
    receiptAvailable = true
    const result = provider.waitForTransaction(hash, 1, 10_000).catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(10_000)
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
  for (const status of [200, 400, 408, 429, 500, 502, 503, 504]) {
    for (const wrapper of ['responseBody', 'info.error', 'error'] as const) {
      it.each([
        { code: -32603, message: 'Internal error' },
        { code: -32000, message: 'upstream connect failure' }
      ])(
        `falls back to HTTP ${status} only for unclassified ${wrapper} RPC semantics: %j`,
        (error) => {
          const failure = {
            code: 'SERVER_ERROR',
            response: { statusCode: status },
            ...(wrapper === 'responseBody'
              ? { info: { responseBody: JSON.stringify({ id: null, error }) } }
              : wrapper === 'info.error'
                ? { info: { error } }
                : { error })
          }
          const expected =
            status === 429
              ? 'rate-limit'
              : status === 408 || status >= 500
                ? 'transient'
                : 'endpoint'
          expect(rpcFailureKind(failure)).toBe(expected)
          expect(isRetryableRpcError(failure)).toBe(expected !== 'endpoint')
        }
      )
    }
  }

  for (const wrapper of ['responseBody', 'batch-object', 'batch-array'] as const) {
    for (const id of [null, undefined]) {
      it.each([
        ['Invalid request', 'endpoint'],
        ['batch size too large', 'capacity'],
        ['rate limit', 'endpoint']
      ] as const)(
        `classifies unassigned -32600 as envelope rejection (${wrapper}, ${String(id)}): %s`,
        (message, expected) => {
          const envelope = { id, error: { code: -32600, message } }
          const failure =
            wrapper === 'responseBody'
              ? {
                  code: 'SERVER_ERROR',
                  response: { statusCode: 429 },
                  info: { responseBody: JSON.stringify(envelope) }
                }
              : {
                  code: 'BAD_DATA',
                  shortMessage: 'missing response for request',
                  value: wrapper === 'batch-array' ? [envelope] : envelope
                }
          const kind =
            wrapper === 'responseBody' && expected !== 'capacity' ? 'rate-limit' : expected
          expect(rpcFailureKind(failure)).toBe(kind)
          expect(isRetryableRpcError(failure)).toBe(kind === 'rate-limit')
        }
      )
    }
  }

  for (const status of [408, 500, 503]) {
    it.each([null, undefined])(
      `retains HTTP ${status} for an unassigned -32600 with id %s`,
      (id) => {
        const failure = {
          code: 'SERVER_ERROR',
          response: { statusCode: status },
          info: {
            responseBody: JSON.stringify({
              id,
              error: { code: -32600, message: 'Invalid request' }
            })
          }
        }
        expect(rpcFailureKind(failure)).toBe('transient')
      }
    )
  }

  for (const wrapper of ['responseBody', 'info.error'] as const) {
    it.each(['header not found', 'missing trie node', 'unknown block'])(
      `classifies HTTP 429 before transient ${wrapper} wording: %s`,
      (message) => {
        const error = { code: -32000, message }
        const failure = {
          code: 'SERVER_ERROR',
          response: { statusCode: 429 },
          info:
            wrapper === 'responseBody'
              ? { responseBody: JSON.stringify({ id: null, error }) }
              : { error }
        }
        expect(rpcFailureKind(failure)).toBe('rate-limit')
      }
    )
  }

  it.each([undefined, 'Invalid RPC receipt response', 'invalid value for value.hash'])(
    'does not extract JSON-RPC semantics from unrelated BAD_DATA: %s',
    (shortMessage) => {
      const failure = {
        code: 'BAD_DATA',
        shortMessage,
        value: { error: { code: -32602, message: 'opaque diagnostic' } }
      }
      expect(rpcFailureKind(failure)).toBe('endpoint')
    }
  )

  for (const status of [400, 403, 404, 413, 429, 500, 502, 503]) {
    it.each([
      [{ code: 3, message: 'execution reverted', data: '0xabcd' }, 'permanent'],
      [{ code: -32602, message: 'timeout' }, 'permanent'],
      [{ code: -32600, message: 'rate limit' }, 'permanent'],
      [{ code: -32000, message: 'insufficient funds' }, 'permanent'],
      [
        { code: -32005, message: 'opaque provider diagnostic', data: { data: '0xabcd' } },
        'permanent'
      ]
    ] as const)(
      `preserves semantic vetoes inside HTTP ${status} responseBody: %j`,
      (error, kind) => {
        const failure = {
          code: 'SERVER_ERROR',
          shortMessage: `server response ${status}`,
          response: { statusCode: status },
          info: {
            responseBody: JSON.stringify({
              jsonrpc: '2.0',
              id: error.code === -32600 ? 1 : null,
              error
            })
          }
        }
        expect(rpcFailureKind(failure)).toBe(kind)
        expect(isRetryableRpcError(failure)).toBe(false)
      }
    )
  }

  for (const wrapper of ['http', 'batch-object', 'batch-array'] as const) {
    it.each([
      [{ code: -32005, message: 'opaque provider diagnostic' }, 'rate-limit'],
      [{ code: -32007, message: 'opaque provider diagnostic' }, 'rate-limit'],
      [{ code: 429, message: 'opaque provider diagnostic' }, 'rate-limit'],
      [{ code: -32000, message: 'header not found' }, 'transient'],
      [{ code: -32603, message: 'Internal error' }, 'endpoint'],
      [{ code: -32005, message: 'query returned more than 1000 results' }, 'capacity'],
      [{ code: 3, message: 'execution reverted: rate limit' }, 'permanent']
    ] as const)(
      `classifies a validated ${wrapper} RPC error before transport diagnostics: %j`,
      (error, kind) => {
        const envelope = { jsonrpc: '2.0', id: null, error }
        const failure =
          wrapper === 'http'
            ? {
                code: 'SERVER_ERROR',
                response: { statusCode: 503 },
                info: { responseBody: JSON.stringify(envelope) }
              }
            : {
                code: 'BAD_DATA',
                shortMessage: 'missing response for request',
                value: wrapper === 'batch-array' ? [envelope] : envelope
              }
        expect(rpcFailureKind(failure)).toBe(
          wrapper === 'http' && error.code === -32603 ? 'transient' : kind
        )
        if (kind === 'rate-limit')
          expect(normalizeError(failure)).toBe(new RpcRateLimitError().message)
      }
    )
  }

  it.each([
    'Over capacity',
    '<html>quota exceeded</html>',
    '{"error":',
    JSON.stringify({ error: { code: '-32005', message: 'rate limit' } }),
    JSON.stringify({ error: { code: -32005 } }),
    JSON.stringify({ error: { code: null, message: 'rate limit' } }),
    JSON.stringify({ result: 'quota' })
  ])('does not interpret an invalid HTTP body as a JSON-RPC error: %s', (responseBody) => {
    expect(
      rpcFailureKind({
        code: 'SERVER_ERROR',
        response: { statusCode: 503 },
        info: { responseBody }
      })
    ).toBe('transient')
  })

  it.each([
    { error: { code: '-32005', message: 'rate limit' } },
    { error: { code: -32005, message: 123 } },
    { id: 123, error: { code: -32005, message: 'rate limit' } },
    { result: '0x1', error: { code: -32005, message: 'rate limit' } },
    [
      { id: null, error: { code: -32005, message: 'rate limit' } },
      { id: 1, result: '0x1' }
    ],
    'quota exceeded',
    null
  ])('does not reuse unrelated or malformed BAD_DATA values: %j', (value) => {
    expect(
      rpcFailureKind({ code: 'BAD_DATA', shortMessage: 'missing response for request', value })
    ).toBe('endpoint')
    expect(
      normalizeError({ code: 'BAD_DATA', message: 'wallet capacity unavailable', value })
    ).not.toContain('RPC endpoints are rate-limited')
  })

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
    expect(await result).toMatchObject({
      code: 'RPC_RATE_LIMITED',
      retryAfterMs: 1_000,
      message: 'RPC endpoints are rate-limited. Retry in 1s. Your RPC list was preserved.',
      cause: { code: 'SERVER_ERROR', response: { statusCode: 429 } }
    })
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

  it('reports exhausted 429 without inventing a wait or burning a zero-request retry', async () => {
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
    expect(await result).toMatchObject({
      code: 'RPC_RATE_LIMITED',
      message:
        'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.',
      cause: { code: 'SERVER_ERROR', response: { statusCode: 429 } }
    })
    expect(rpcRetryAfterMs(await result)).toBeNull()
    expect(readRequests('eth_call')).toHaveLength(4)
    expect(sleep.mock.calls).toEqual([[1_000], [1_000], [1_600]])
  })

  it.each([undefined, 'soon', '1'])(
    'preserves server delay and cause when slow 429 exhausts the retry budget: %s',
    async (retryAfter) => {
      const provider = await ready(1)
      failures.set(urls[0], { status: 429, delay: 9_000, retryAfter })
      const originals: unknown[] = []
      const operation = vi.fn(async (signal: AbortSignal) => {
        try {
          return await provider.withSignal(signal).getTransactionCount(address, 'pending')
        } catch (error) {
          originals.push(error)
          throw error
        }
      })
      const sleep = vi.fn(
        (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))
      )
      const started = Date.now()
      let settledAt = 0
      const result = withRetry(operation, { sleep, jitterRatio: 0 }).catch((error: unknown) => {
        settledAt = Date.now()
        return error
      })
      await vi.advanceTimersByTimeAsync(30_000)
      const error = await result
      expect(error).toBeInstanceOf(RpcRateLimitError)
      expect((error as Error).cause).toBe(originals.at(-1))
      expect(originals.at(-1)).toMatchObject({
        code: 'SERVER_ERROR',
        response: { statusCode: 429 }
      })
      expect(rpcRetryAfterMs(error)).toBe(retryAfter === '1' ? 1_000 : null)
      expect(normalizeError(error)).toBe(
        retryAfter === '1'
          ? 'RPC endpoints are rate-limited. Retry in 1s. Your RPC list was preserved.'
          : 'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
      )
      expect(sleep.mock.calls).toEqual([[1_000], [1_000]])
      expect(operation).toHaveBeenCalledTimes(3)
      expect(readRequests()).toHaveLength(3)
      expect(settledAt - started).toBeGreaterThanOrEqual(29_000)
      expect(settledAt - started).toBeLessThan(30_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(readRequests()).toHaveLength(3)
    }
  )

  it.each(['eth_getTransactionCount', 'eth_getBlockByNumber'])(
    'normalizes a direct %s rate limit from the ethers top-level error shape',
    async (method) => {
      const provider = await ready(2)
      const rpcError = { code: -32005, message: 'project ID request rate exceeded' }
      for (const url of urls.slice(0, 2)) failures.set(url, { error: rpcError })
      const result = (
        method === 'eth_getTransactionCount'
          ? provider.getTransactionCount(address, 'pending')
          : provider.getBlock('latest')
      ).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(200)
      const error = await result
      expect(error).toMatchObject({
        code: 'UNKNOWN_ERROR',
        error: rpcError,
        payload: { method }
      })
      expect(normalizeError(error)).toBe(
        'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
      )
      expect(readRequests(method).map(({ url }) => url)).toEqual(urls.slice(0, 2))
    }
  )

  it('normalizes an exhausted -32005 eth_call without exposing the generated revert diagnostic', async () => {
    const provider = await ready(2)
    const rpcError = { code: -32005, message: 'project ID request rate exceeded' }
    for (const url of urls.slice(0, 2)) failures.set(url, { error: rpcError })
    const result = withRetry((signal) =>
      new Contract(address, Multicall3ABI, provider.withSignal(signal)).aggregate3(calls)
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({
      code: 'RPC_RATE_LIMITED',
      message:
        'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.',
      cause: { code: 'CALL_EXCEPTION', info: { error: rpcError } }
    })
    expect(rpcRetryAfterMs(await result)).toBeNull()
    for (const url of urls.slice(0, 2))
      expect(readRequests('eth_call').filter((request) => request.url === url)).toHaveLength(4)
    expect(readCustomRpc('eth')).toEqual(urls.slice(0, 2))
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

  it('reports the same bounded cooldown for an oversized server Retry-After and the pool', async () => {
    const provider = await ready(1)
    failures.set(urls[0], { status: 429, retryAfter: '3600' })
    const result = withRetry((signal) =>
      provider.withSignal(signal).send('eth_getCode', [address, 'latest'])
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({
      code: 'RPC_RATE_LIMITED',
      retryAfterMs: 60_000,
      message: 'RPC endpoints are rate-limited. Retry in 60s. Your RPC list was preserved.'
    })
    const cooling = await provider
      .send('eth_getCode', [address, 'latest'])
      .catch((error: unknown) => error)
    expect(cooling).toMatchObject({
      code: 'RPC_RATE_LIMITED',
      message: 'RPC endpoints are rate-limited. Retry in 60s. Your RPC list was preserved.'
    })
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
