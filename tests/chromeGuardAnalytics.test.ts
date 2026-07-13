// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkBrowserSupport = vi.hoisted(() => vi.fn())
const trackAnalyticsEvent = vi.hoisted(() => vi.fn())

vi.mock('@/core/browserGuard', () => ({ checkBrowserSupport }))
vi.mock('@/core/analytics', () => ({ trackAnalyticsEvent }))

import ChromeGuard from '@/components/ChromeGuard.vue'

describe('ChromeGuard analytics', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['mobile', 'non_chrome'] as const)('reports only the %s reason', (reason) => {
    checkBrowserSupport.mockReturnValue({
      supported: false,
      message: 'Detailed browser message',
      reason
    })

    mount(ChromeGuard)

    expect(trackAnalyticsEvent).toHaveBeenCalledWith('browser_guard_shown', { reason })
    expect(JSON.stringify(trackAnalyticsEvent.mock.calls)).not.toContain('Detailed browser message')
  })

  it('does not report the guard for supported Chrome', () => {
    checkBrowserSupport.mockReturnValue({ supported: true, message: '' })

    mount(ChromeGuard)

    expect(trackAnalyticsEvent).not.toHaveBeenCalled()
  })
})
