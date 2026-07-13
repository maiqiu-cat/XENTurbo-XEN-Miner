// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    expect(rpc.ensureRecentReadProvider).toHaveBeenCalledTimes(1)

    health.resolve(provider)
    await Promise.all([overlappingA, overlappingB])
    expect(provider.getFeeData).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
