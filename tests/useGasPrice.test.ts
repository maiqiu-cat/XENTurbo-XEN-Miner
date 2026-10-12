// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READ_TIMEOUT_MS } from '@/core/readDeadline'

const rpc = vi.hoisted(() => ({
  ensureHealthyReadProvider: vi.fn(),
  ensureRecentReadProvider: vi.fn()
}))

vi.mock('@/core/rpc', () => rpc)

import { useGasPrice } from '@/composables/useGasPrice'

let gasState!: ReturnType<typeof useGasPrice>
const GasHarness = defineComponent({
  setup() {
    gasState = useGasPrice(() => 'eth')
    return () => h('div')
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('gas polling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const provider = {
      getFeeData: vi.fn(async () => ({ gasPrice: 1_000_000_000n }))
    }
    rpc.ensureHealthyReadProvider.mockResolvedValue(provider)
    rpc.ensureRecentReadProvider.mockResolvedValue(provider)
  })

  afterEach(() => vi.useRealTimers())

  it('does not poll while hidden and refreshes through the recent health cache when visible', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    const wrapper = mount(GasHarness)
    await nextTick()

    expect(rpc.ensureHealthyReadProvider).not.toHaveBeenCalled()
    expect(rpc.ensureRecentReadProvider).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(rpc.ensureRecentReadProvider).toHaveBeenCalledWith('eth', 30_000))
    expect(rpc.ensureHealthyReadProvider).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('coalesces overlapping gas polls for the same chain', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    const provider = {
      getFeeData: vi.fn(async () => ({ gasPrice: 1_000_000_000n }))
    }
    const health = deferred<typeof provider>()
    rpc.ensureRecentReadProvider.mockReturnValue(health.promise)
    const wrapper = mount(GasHarness)

    const overlappingA = gasState.poll()
    const overlappingB = gasState.poll()
    await nextTick()
    expect(rpc.ensureRecentReadProvider).toHaveBeenCalledTimes(1)

    health.resolve(provider)
    await Promise.all([overlappingA, overlappingB])
    expect(provider.getFeeData).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it.each(['health', 'fee'])(
    'recovers from a stalled %s read and ignores its late response',
    async (path) => {
      vi.useFakeTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      const stalled = deferred<any>()
      const provider = { getFeeData: vi.fn().mockResolvedValue({ gasPrice: 2_000_000_000n }) }
      rpc.ensureRecentReadProvider.mockResolvedValue(provider)
      if (path === 'health') rpc.ensureRecentReadProvider.mockReturnValueOnce(stalled.promise)
      else provider.getFeeData.mockReturnValueOnce(stalled.promise)
      const wrapper = mount(GasHarness)
      const first = gasState.poll()

      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
      expect(gasState.loading.value).toBe(false)
      expect(gasState.gwei.value).toBe('--')
      await first
      await gasState.poll()
      expect(gasState.gwei.value).toBe('2.0')

      stalled.resolve(path === 'health' ? provider : { gasPrice: 99_000_000_000n })
      await nextTick()
      expect(gasState.gwei.value).toBe('2.0')
      expect(provider.getFeeData).toHaveBeenCalledTimes(path === 'health' ? 1 : 2)
      wrapper.unmount()
    }
  )

  it('abandons an active read when its component unmounts', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const fee = deferred<{ gasPrice: bigint }>()
    rpc.ensureRecentReadProvider.mockResolvedValue({ getFeeData: () => fee.promise })
    const wrapper = mount(GasHarness)
    const poll = gasState.poll()
    await nextTick()

    wrapper.unmount()
    await poll
    fee.resolve({ gasPrice: 99_000_000_000n })
    await nextTick()
    expect(gasState.gwei.value).toBe('--')
    expect(vi.getTimerCount()).toBe(0)
  })
})
