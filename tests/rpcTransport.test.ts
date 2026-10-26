import { createServer } from 'node:http'
import { once } from 'node:events'
import { FetchRequest } from 'ethers'
import { expect, it, vi } from 'vitest'
import { writeCustomRpc } from '@/config/chains'
import { ensureHealthyReadProvider, resetProviders } from '@/core/rpc'
import { ReadTimeoutError } from '@/core/readDeadline'

it('exercises real health probes and the 12-second ethers transport timeout on loopback only', async () => {
  const nativeFetch = globalThis.fetch
  const transport = new FetchRequest('https://transport.example/').getUrlFunc
  const methods: string[][] = []
  const transportTimeouts: number[] = []
  let stall = false
  let transportFailed!: (error: unknown) => void
  const transportFailure = new Promise<unknown>((resolve) => {
    transportFailed = resolve
  })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const payload = JSON.parse(body)
      const batch = Array.isArray(payload) ? payload : [payload]
      methods.push(batch.map((call: { method: string }) => call.method))
      if (
        stall &&
        batch.some((call: { method: string }) => call.method === 'eth_getTransactionCount')
      )
        return
      const replies = batch.map(({ id, method }: { id: number; method: string }) => ({
        jsonrpc: '2.0',
        id,
        result:
          method === 'eth_chainId'
            ? '0x1'
            : method === 'eth_getBlockByNumber'
              ? { number: '0x2a', timestamp: '0x1234', hash: `0x${'a'.repeat(64)}` }
              : method === 'eth_call'
                ? `0x${'0'.repeat(64)}`
                : '0x2a'
      }))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback fixture did not start')
  const url = `http://127.0.0.1:${address.port}/`
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
  // Only the destination is remapped; real fetch, response parsing, SDK transport and timers run.
  vi.stubGlobal('fetch', (input: string, options?: RequestInit) => {
    expect(input).toBe('https://transport.example/')
    return nativeFetch(url, options)
  })
  FetchRequest.registerGetUrl(async (request, signal) => {
    expect(request.url).toBe('https://transport.example/')
    transportTimeouts.push(request.timeout)
    const local = request.clone()
    local.url = url
    try {
      return await transport(local, signal)
    } catch (error) {
      transportFailed(error)
      throw error
    }
  })
  try {
    resetProviders()
    writeCustomRpc('eth', ['https://transport.example/'])
    const provider = await ensureHealthyReadProvider('eth')
    expect(methods).toEqual([['eth_chainId'], ['eth_getBlockByNumber', 'eth_call']])
    await expect(provider.getBlockNumber()).resolves.toBe(42)
    stall = true
    const startedAt = performance.now()
    await expect(
      provider.getTransactionCount('0x0000000000000000000000000000000000000001', 'pending')
    ).rejects.toBeInstanceOf(ReadTimeoutError)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(11_900)
    // The pool deadline alone is insufficient: wait for the actual socket transport's TIMEOUT too.
    expect(await transportFailure).toMatchObject({ code: 'TIMEOUT' })
    expect(transportTimeouts.every((timeout) => timeout === 12_000)).toBe(true)
    expect(methods.filter((batch) => batch.includes('eth_getTransactionCount'))).toHaveLength(1)
  } finally {
    resetProviders()
    FetchRequest.registerGetUrl(transport)
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 20_000)
