import { afterEach, describe, expect, it, vi } from 'vitest'
import { withReadDeadline } from '@/core/readDeadline'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('bounded read recovery', () => {
  it('times out a stalled read and ignores its late success', async () => {
    vi.useFakeTimers()
    let resolve!: (value: number) => void
    const promise = withReadDeadline(
      () =>
        new Promise<number>((done) => {
          resolve = done
        }),
      'test',
      { timeoutMs: 50 }
    )
    const assertion = expect(promise).rejects.toThrow('READ_TIMEOUT')
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    resolve(123)
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a running read without waiting for the endpoint', async () => {
    const controller = new AbortController()
    const promise = withReadDeadline(() => new Promise<number>(() => {}), 'test', {
      signal: controller.signal
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each(['null', '[]', '42', '{"eth":null}', '{"eth":[null,42,"https://valid.example"]}'])(
    'handles corrupted custom RPC storage: %s',
    async (raw) => {
      vi.stubGlobal('localStorage', { getItem: () => raw })
      const { readCustomRpc, getRpcUrls } = await import('@/config/chains')
      expect(() => readCustomRpc('eth')).not.toThrow()
      expect(getRpcUrls('eth').length).toBeGreaterThanOrEqual(raw.includes('valid.example') ? 1 : 4)
    }
  )

  it('abandons blocked IndexedDB opens, closes late connections, and permits retry', async () => {
    const requests: Array<{
      onblocked?: () => void
      onsuccess?: () => void
      result: { close: ReturnType<typeof vi.fn> }
    }> = []
    vi.stubGlobal('indexedDB', {
      open: vi.fn(() => {
        const request = { result: { close: vi.fn() } }
        requests.push(request)
        return request
      })
    })
    const { loadSnapshot } = await import('@/core/idb')
    const first = loadSnapshot('eth', '0x1111111111111111111111111111111111111111')
    requests[0].onblocked!()
    await expect(first).resolves.toBeNull()
    requests[0].onsuccess!()
    expect(requests[0].result.close).toHaveBeenCalledOnce()
    const retry = loadSnapshot('eth', '0x1111111111111111111111111111111111111111')
    expect(requests).toHaveLength(2)
    requests[1].onblocked!()
    await expect(retry).resolves.toBeNull()
  })
})
