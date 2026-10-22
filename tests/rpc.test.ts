import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAINS,
  getRpcUrls,
  readCustomRpc,
  writeCustomRpc,
  parseRpcInput,
  MAX_RPC_ENDPOINTS,
  MAX_RPC_INPUT_LENGTH,
  MAX_RPC_URL_LENGTH
} from '@/config/chains'
import { withReadDeadline } from '@/core/readDeadline'
import {
  ensureRecentReadProvider,
  ensureHealthyReadProvider,
  getReadProvider,
  getRpcHealthState,
  onRpcHealthChange,
  resetProviders,
  validateRpcEndpoint,
  withRetry
} from '@/core/rpc'

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorage())
  resetProviders()
})

describe('RPC retry policy', () => {
  it('does not retry semantic contract failures', async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })
    })
    const sleep = vi.fn(async () => {})

    await expect(withRetry(operation, { retries: 3, sleep })).rejects.toThrow('execution reverted')
    expect(operation).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('honors server retry timing and then applies bounded exponential backoff', async () => {
    const limited = Object.assign(new Error('rate limit'), {
      status: 429,
      retryAfterMs: 2_000
    })
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(limited)
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('ok')
    const sleep = vi.fn(async () => {})

    await expect(
      withRetry(operation, {
        retries: 3,
        baseDelayMs: 400,
        maxDelayMs: 5_000,
        jitterRatio: 0,
        sleep
      })
    ).resolves.toBe('ok')
    expect(sleep.mock.calls).toEqual([[2_000], [800]])
  })

  it('cancels backoff immediately when the caller aborts', async () => {
    const controller = new AbortController()
    const sleep = vi.fn(async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'))
    })

    await expect(
      withRetry(async () => Promise.reject(new Error('ETIMEDOUT')), {
        retries: 3,
        signal: controller.signal,
        sleep
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

afterEach(() => {
  resetProviders()
  vi.unstubAllGlobals()
})

describe('custom RPC validation', () => {
  it('accepts exact input boundaries and normalizes duplicate endpoints', () => {
    const prefix = 'https://rpc.example/'
    const longest = prefix + 'x'.repeat(MAX_RPC_URL_LENGTH - prefix.length)
    expect(parseRpcInput(longest)).toEqual([longest])
    expect(parseRpcInput(prefix.padEnd(MAX_RPC_INPUT_LENGTH, ' '))).toEqual([prefix])
    expect(parseRpcInput(' https://rpc.example\nhttps://rpc.example/ ')).toEqual([prefix])
  })

  it('does not overwrite a saved list when replacement configuration exceeds its limit', () => {
    writeCustomRpc('eth', ['https://preserved.example'])
    expect(() =>
      writeCustomRpc(
        'eth',
        Array.from({ length: MAX_RPC_ENDPOINTS + 1 }, (_, i) => `https://rpc${i}.example`)
      )
    ).toThrow('at most')
    expect(readCustomRpc('eth')).toEqual(['https://preserved.example/'])
  })

  it('keeps an overlong legacy endpoint visible instead of silently choosing defaults', async () => {
    const url = `https://legacy.example/${'x'.repeat(MAX_RPC_URL_LENGTH)}`
    const stored = JSON.stringify({ eth: [url] })
    localStorage.setItem('sm.customRpc', stored)
    expect(readCustomRpc('eth')).toEqual([url])
    expect(getRpcUrls('eth')).toEqual([url])
    const request = vi.fn(async () => '0x1')
    await expect(ensureHealthyReadProvider('eth', request)).rejects.toThrow(
      'RPC URL must not exceed'
    )
    expect(request).not.toHaveBeenCalled()
    expect(localStorage.getItem('sm.customRpc')).toBe(stored)
  })
  it('keeps the diversified Ethereum defaults in the intended failover order', () => {
    expect(CHAINS.eth.defaultRpcUrls).toEqual([
      'https://ethereum.publicnode.com',
      'https://ethereum-rpc.publicnode.com',
      'https://rpc.mevblocker.io',
      'https://public.1rpc.io/eth'
    ])
    expect(new Set(CHAINS.eth.defaultRpcUrls).size).toBe(4)
  })

  it.each(['http://rpc.example', 'ws://rpc.example', 'not-a-url'])(
    'rejects non-HTTPS endpoint %s',
    async (url) => {
      await expect(validateRpcEndpoint(url, 1, vi.fn())).rejects.toThrow(/HTTPS/)
    }
  )

  it('accepts an HTTPS endpoint only when eth_chainId matches', async () => {
    const request = vi.fn(async () => '0x1')

    await expect(validateRpcEndpoint('https://rpc.example', 1, request)).resolves.toMatchObject({
      url: 'https://rpc.example/',
      chainId: 1
    })
    expect(request).toHaveBeenCalledWith('https://rpc.example/')
  })

  it('rejects a valid endpoint serving the wrong chain', async () => {
    const request = vi.fn(async () => '0x89')

    await expect(validateRpcEndpoint('https://rpc.example', 1, request)).rejects.toThrow(
      /expected chain 1.*returned 137/i
    )
  })

  it('rejects malformed chain ids returned by an endpoint', async () => {
    const request = vi.fn(async () => 'mainnet')

    await expect(validateRpcEndpoint('https://rpc.example', 1, request)).rejects.toThrow(
      /invalid chain id/i
    )
  })
})

describe('runtime RPC health selection', () => {
  it('does not dispatch remaining old probes after a synchronous configuration change', async () => {
    writeCustomRpc('eth', ['https://old-a.example/', 'https://old-b.example/'])
    const request = vi.fn(async (url: string) => {
      if (url === 'https://old-a.example/') {
        writeCustomRpc('eth', ['https://new.example/'])
        resetProviders('eth')
      }
      return '0x1'
    })
    await ensureHealthyReadProvider('eth', request)
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://old-a.example/',
      'https://new.example/'
    ])
    expect(getRpcHealthState('eth').healthyUrls).toEqual(['https://new.example/'])
  })
  it('discards an old in-flight health result after configuration changes', async () => {
    writeCustomRpc('eth', ['https://old.example/'])
    let finishOld!: (value: string) => void
    const old = new Promise<string>((resolve) => {
      finishOld = resolve
    })
    const request = vi.fn((url: string) =>
      url === 'https://old.example/' ? old : Promise.resolve('0x1')
    )
    const publications: string[][] = []
    const unsubscribe = onRpcHealthChange((_chain, state) => {
      if (!state.checking) publications.push(state.healthyUrls)
    })
    try {
      const first = ensureHealthyReadProvider('eth', request)
      expect(request).toHaveBeenCalledWith('https://old.example/')
      writeCustomRpc('eth', ['https://new.example/'])
      resetProviders('eth')
      const current = await ensureHealthyReadProvider('eth', request)
      finishOld('0x1')
      await expect(first).resolves.toBe(current)
      expect(getReadProvider('eth')).toBe(current)
      expect(getRpcHealthState('eth').healthyUrls).toEqual(['https://new.example/'])
      expect(publications.flat()).not.toContain('https://old.example/')
      expect(readCustomRpc('eth')).toEqual(['https://new.example/'])
    } finally {
      unsubscribe()
    }
  })

  it('bounds background probe concurrency without dropping configured nodes', async () => {
    const urls = Array.from({ length: MAX_RPC_ENDPOINTS }, (_, i) => `https://rpc${i}.example/`)
    writeCustomRpc('eth', urls)
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    let active = 0
    let peak = 0
    const request = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await gate
      active -= 1
      return '0x1'
    })
    const health = ensureHealthyReadProvider('eth', request)
    expect(request).toHaveBeenCalledTimes(MAX_RPC_ENDPOINTS)
    release()
    await health
    expect(peak).toBe(MAX_RPC_ENDPOINTS)
    expect(request).toHaveBeenCalledTimes(MAX_RPC_ENDPOINTS)
    expect(getRpcHealthState('eth').healthyUrls).toEqual(urls)
    expect(readCustomRpc('eth')).toEqual(urls)
  })

  it('finishes a full slow healthy list within the existing wallet read deadline', async () => {
    vi.useFakeTimers()
    try {
      writeCustomRpc(
        'eth',
        Array.from({ length: MAX_RPC_ENDPOINTS }, (_, i) => `https://rpc${i}.example/`)
      )
      const request = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_400))
        await new Promise((resolve) => setTimeout(resolve, 2_400))
        return '0x1'
      })
      const checked = withReadDeadline(
        () => ensureHealthyReadProvider('eth', request),
        'Wallet RPC validation'
      )
      const assertion = expect(checked).resolves.toBeDefined()
      await vi.advanceTimersByTimeAsync(4_800)
      await assertion
      expect(request).toHaveBeenCalledTimes(MAX_RPC_ENDPOINTS)
      expect(getRpcHealthState('eth').healthyUrls).toHaveLength(MAX_RPC_ENDPOINTS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves but rejects an oversized legacy configuration before network requests', async () => {
    const urls = Array.from({ length: MAX_RPC_ENDPOINTS + 1 }, (_, i) => `https://rpc${i}.example/`)
    const stored = JSON.stringify({ eth: urls })
    localStorage.setItem('sm.customRpc', stored)
    const request = vi.fn(async () => '0x1')
    await expect(ensureHealthyReadProvider('eth', request)).rejects.toThrow('at most')
    expect(request).not.toHaveBeenCalled()
    expect(localStorage.getItem('sm.customRpc')).toBe(stored)
  })
  it('reuses a recently validated provider until the caller freshness window expires', async () => {
    writeCustomRpc('eth', ['https://rpc.example'])
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const request = vi.fn(async () => '0x1')

    const initial = await ensureHealthyReadProvider('eth', request)
    await expect(ensureRecentReadProvider('eth', 30_000, request)).resolves.toBe(initial)
    expect(request).toHaveBeenCalledTimes(1)

    now.mockReturnValue(40_001)
    await ensureRecentReadProvider('eth', 30_000, request)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('builds the read provider from only responsive endpoints on the expected chain', async () => {
    writeCustomRpc('eth', [
      'https://healthy.example',
      'https://offline.example',
      'https://wrong-chain.example'
    ])
    const request = vi.fn(async (url: string) => {
      if (url.includes('healthy')) return '0x1'
      if (url.includes('wrong-chain')) return '0x89'
      throw new Error('connection refused')
    })

    const provider = await ensureHealthyReadProvider('eth', request)
    const state = getRpcHealthState('eth')

    expect(getReadProvider('eth')).toBe(provider)
    expect(state.healthyUrls).toEqual(['https://healthy.example/'])
    expect(state.failures).toHaveLength(2)
    expect(state.error).toBeNull()
  })

  it('clears the previous provider and reports an actionable error when every endpoint fails', async () => {
    writeCustomRpc('eth', ['https://first.example', 'https://second.example'])
    await ensureHealthyReadProvider(
      'eth',
      vi.fn(async () => '0x1')
    )

    await expect(
      ensureHealthyReadProvider(
        'eth',
        vi.fn(async () => Promise.reject(new Error('offline')))
      )
    ).rejects.toThrow(/RPC_UNAVAILABLE.*Ethereum.*0\/2/i)

    expect(() => getReadProvider('eth')).toThrow(/RPC_NOT_VALIDATED/)
    expect(readCustomRpc('eth')).toEqual(['https://first.example/', 'https://second.example/'])
    expect(getRpcHealthState('eth')).toMatchObject({
      healthyUrls: [],
      error: expect.stringMatching(/RPC_UNAVAILABLE.*RPC list was preserved/)
    })
  })

  it('preserves the default RPC list when the client network blocks every probe', async () => {
    const configuredUrls = [...getRpcUrls('eth')]

    await expect(
      ensureHealthyReadProvider(
        'eth',
        vi.fn(async () => Promise.reject(new Error('offline')))
      )
    ).rejects.toThrow(/local internet connection.*retry/i)

    expect(configuredUrls).toEqual(CHAINS.eth.defaultRpcUrls)
    expect(getRpcUrls('eth')).toEqual(configuredUrls)
    expect(readCustomRpc('eth')).toEqual([])
  })

  it('revalidates endpoints for each operation while coalescing concurrent checks', async () => {
    writeCustomRpc('eth', ['https://rpc.example'])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const request = vi.fn(async () => {
      await gate
      return '0x1'
    })

    const first = ensureHealthyReadProvider('eth', request)
    const overlapping = ensureHealthyReadProvider('eth', request)
    release()
    await Promise.all([first, overlapping])
    expect(request).toHaveBeenCalledTimes(1)

    await ensureHealthyReadProvider('eth', request)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not let a health-state listener failure block a healthy provider', async () => {
    writeCustomRpc('eth', ['https://rpc.example'])
    const unsubscribe = onRpcHealthChange(() => {
      throw new Error('broken UI listener')
    })

    try {
      const provider = await ensureHealthyReadProvider(
        'eth',
        vi.fn(async () => '0x1')
      )
      expect(getReadProvider('eth')).toBe(provider)
    } finally {
      unsubscribe()
    }
  })

  it('destroys a cached provider when it is reset', async () => {
    writeCustomRpc('eth', ['https://rpc.example'])
    const provider = await ensureHealthyReadProvider(
      'eth',
      vi.fn(async () => '0x1')
    )
    const destroy = vi.spyOn(provider, 'destroy')

    resetProviders('eth')

    expect(destroy).toHaveBeenCalledOnce()
  })

  it('destroys the old provider when the healthy endpoint set changes', async () => {
    writeCustomRpc('eth', ['https://first.example'])
    const first = await ensureHealthyReadProvider(
      'eth',
      vi.fn(async () => '0x1')
    )
    const destroy = vi.spyOn(first, 'destroy')

    writeCustomRpc('eth', ['https://second.example'])
    await ensureHealthyReadProvider(
      'eth',
      vi.fn(async () => '0x1')
    )

    expect(destroy).toHaveBeenCalledOnce()
  })
})
