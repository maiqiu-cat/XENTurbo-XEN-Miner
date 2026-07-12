import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAINS, getRpcUrls, readCustomRpc, writeCustomRpc } from '@/config/chains'
import {
  ensureHealthyReadProvider,
  getReadProvider,
  getRpcHealthState,
  onRpcHealthChange,
  resetProviders,
  validateRpcEndpoint
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

afterEach(() => {
  resetProviders()
  vi.unstubAllGlobals()
})

describe('custom RPC validation', () => {
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
})
