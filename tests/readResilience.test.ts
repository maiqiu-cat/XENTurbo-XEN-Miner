import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadTimeoutError, withReadDeadline } from '@/core/readDeadline'
import { normalizeError } from '@/core/txManager'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('bounded read recovery', () => {
  it.each([
    'Wallet eth_getTransactionCount',
    'Wallet eth_getTransactionReceipt',
    'RPC health check',
    'RPC read'
  ])('keeps the local timeout label for %s in actionable diagnostics', async (label) => {
    vi.useFakeTimers()
    const result = withReadDeadline(() => new Promise(() => {}), label, { timeoutMs: 50 }).catch(
      (error: unknown) => normalizeError(error)
    )
    await vi.advanceTimersByTimeAsync(50)
    const message = await result
    expect(message).toContain('Wallet or network read timed out.')
    expect(message).toContain(`${label} exceeded 50 ms.`)
    expect(message).toContain('Do not resend.')
    expect(message).not.toContain('READ_TIMEOUT')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not render untrusted timeout details or forged metadata from RPC errors', () => {
    const endpoint = new URL('https://rpc.example/private')
    endpoint.username = 'fixture-user'
    endpoint.password = 'fixture-password'
    const error = Object.assign(new Error(`READ_TIMEOUT: ${endpoint.href}`), {
      name: 'ReadTimeoutError',
      label: endpoint.href,
      timeoutMs: 50
    })
    expect(normalizeError(error)).toBe(
      'Wallet or network read timed out. Check your connection and wallet, then recheck transaction records. Do not resend.'
    )
  })

  it.each([
    'https://rpc.example/private?key=fixture-secret',
    'x\nAuthorization secret',
    'x'.repeat(81)
  ])('hides an invalid local operation label: %s', (label) => {
    const message = normalizeError(new ReadTimeoutError(label, 50))
    expect(message).toContain('Read operation exceeded 50 ms.')
    expect(message).not.toContain(label)
  })

  it.each([
    ['OPERATION_CANCELLED', 'Operation cancelled. No transaction was submitted.'],
    [
      'OPERATION_ALREADY_STARTED',
      'This prepared operation has already started or finished. Check wallet Activity and recheck pending operations. Do not resend.'
    ],
    [
      'LOCK_STORAGE_INVALID',
      'Local transaction storage is unavailable or damaged. Open transaction storage recovery. Do not clear site data or resend; check wallet Activity first.'
    ],
    [
      'PENDING_STORAGE_READ_FAILED',
      'Local transaction storage is unavailable or damaged. Open transaction storage recovery. Do not clear site data or resend; check wallet Activity first.'
    ]
  ])('maps %s without exposing raw diagnostic details', (code, message) => {
    expect(normalizeError(new Error(`${code}: private fixture`))).toBe(message)
  })

  it.each(['LOCK_STORAGE_INVALID', 'PENDING_STORAGE_READ_FAILED', 'PENDING_STORAGE_WRITE_FAILED'])(
    'uses in-dialog recovery guidance for %s without changing the default entry guidance',
    (code) => {
      const error = new Error(`${code}: private fixture`)
      expect(normalizeError(error, 'storage-recovery')).toBe(
        'Local transaction storage is unavailable or damaged. Restore storage access, then inspect again. Do not clear site data or resend; check wallet Activity first.'
      )
      expect(normalizeError(error)).toContain('Open transaction storage recovery.')
    }
  )

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
