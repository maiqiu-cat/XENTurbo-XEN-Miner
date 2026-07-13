// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const analytics = vi.hoisted(() => ({
  deny: vi.fn(),
  getConsent: vi.fn<() => 'granted' | 'denied' | null>(),
  grant: vi.fn(),
  isAvailable: vi.fn()
}))

vi.mock('@/core/analytics', () => ({ analytics }))

async function mountConsent() {
  const { default: AnalyticsConsent } = await import('@/components/AnalyticsConsent.vue')
  return mount(AnalyticsConsent)
}

describe('AnalyticsConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    analytics.isAvailable.mockReturnValue(true)
    analytics.getConsent.mockReturnValue(null)
    analytics.grant.mockResolvedValue(true)
  })

  it('allows analytics only after an explicit user choice', async () => {
    const wrapper = await mountConsent()

    expect(wrapper.get('[role="dialog"]').text()).toContain('Optional usage analytics')
    expect(analytics.grant).not.toHaveBeenCalled()

    await wrapper.get('button[data-consent="grant"]').trigger('click')
    await flushPromises()

    expect(analytics.grant).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('button[data-consent="settings"]').text()).toBe('Analytics settings')
  })

  it('supports rejection and later reopening the settings', async () => {
    const wrapper = await mountConsent()

    await wrapper.get('button[data-consent="deny"]').trigger('click')
    expect(analytics.deny).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)

    await wrapper.get('button[data-consent="settings"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain(
      'wallet addresses, transaction hashes, RPC URLs, form values, or error details'
    )
  })

  it('renders nothing when analytics is not configured for the current host', async () => {
    analytics.isAvailable.mockReturnValue(false)

    const wrapper = await mountConsent()

    expect(wrapper.html()).toBe('<!--v-if-->')
  })
})
