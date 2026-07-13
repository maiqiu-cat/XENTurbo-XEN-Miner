// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDocumentClock } from '@/composables/useDocumentClock'

afterEach(() => {
  vi.useRealTimers()
})

describe('document clock', () => {
  it('stops ticking while hidden and catches up when visible again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    let clock!: ReturnType<typeof useDocumentClock>
    const wrapper = mount(
      defineComponent({
        setup() {
          clock = useDocumentClock(1_000)
          return () => h('div')
        }
      })
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(clock.value).toBe(2_000)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(clock.value).toBe(2_000)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(clock.value).toBe(7_000)

    wrapper.unmount()
  })
})
