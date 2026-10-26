// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const checkBrowserSupport = vi.hoisted(() => vi.fn())
vi.mock('@/core/browserGuard', () => ({ checkBrowserSupport }))
import ChromeGuard from '@/components/ChromeGuard.vue'

describe('ChromeGuard', () => {
  it('keeps the language control centered without logical-margin support', () => {
    const source = readFileSync('src/components/ChromeGuard.vue', 'utf8')
    const style = source.match(/\.chrome-guard[^{]*:deep\(\.language-control\)\s*\{([^}]+)\}/)?.[1]
    expect(style).toMatch(/margin-left:\s*auto/)
    expect(style).toMatch(/margin-right:\s*auto/)
  })
  beforeEach(() => vi.clearAllMocks())

  it.each(['mobile', 'non_chrome'] as const)(
    'still explains the %s restriction',
    async (reason) => {
      checkBrowserSupport.mockReturnValue({
        supported: false,
        message: 'Please use desktop Chrome',
        reason
      })
      const wrapper = mount(ChromeGuard)
      await nextTick()
      expect(wrapper.get('[role="alertdialog"]').text()).toContain('Please use desktop Chrome')
      wrapper.unmount()
    }
  )

  it('does not display a restriction for supported Chrome', () => {
    checkBrowserSupport.mockReturnValue({ supported: true, message: '' })
    const wrapper = mount(ChromeGuard)
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
