// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDocumentClock } from '@/composables/useDocumentClock'

afterEach(() => {
  vi.useRealTimers()
})

function mountClock(onResume?: () => void) {
  let clock!: ReturnType<typeof useDocumentClock>
  const wrapper = mount(
    defineComponent({
      setup() {
        clock = useDocumentClock(1_000, () => true, Date.now, onResume)
        return () => h('div')
      }
    })
  )
  return { wrapper, clock }
}

describe('document clock', () => {
  it('stops ticking while hidden and catches up when visible again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    const { wrapper, clock } = mountClock()

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

  it('revalidates on focus or BFCache restore only when visible and removes listeners', () => {
    const resume = vi.fn()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const { wrapper } = mountClock(resume)
    window.dispatchEvent(new Event('focus'))
    expect(resume).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    window.dispatchEvent(new Event('pageshow'))
    expect(resume).not.toHaveBeenCalled()
    const restored = new Event('pageshow')
    Object.defineProperty(restored, 'persisted', { value: true })
    window.dispatchEvent(restored)
    window.dispatchEvent(new Event('focus'))
    expect(resume).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    window.dispatchEvent(restored)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(resume).toHaveBeenCalledTimes(2)
  })
})
