// @vitest-environment happy-dom

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PendingOpsPanel from '@/components/PendingOpsPanel.vue'
import RpcSettings from '@/components/RpcSettings.vue'
import TxModal from '@/components/TxModal.vue'
import type { PendingOpView } from '@/core/pendingOps'
import { STALE_PREPARATION_MESSAGE } from '@/i18n/messages'
import * as rpc from '@/core/rpc'
import { i18n } from '@/i18n'

enableAutoUnmount(afterEach)
const restoreWindowFunctions: Array<() => void> = []

afterEach(() => {
  for (const restore of restoreWindowFunctions.splice(0)) restore()
  vi.restoreAllMocks()
})

const dangerousDisplayTexts = [
  ['script tag', '<script>window.alert("h07")</script>'],
  [
    'event handlers and navigation',
    '<img src="data:," onerror="window.alert(\'h07\')"><a href="javascript:alert(1)">go</a>'
  ],
  [
    'attribute breakout',
    '"><svg onload="open(\'#h07\')"></svg><meta http-equiv="refresh" content="0;url=#h07">'
  ],
  ['prototype-like text', '__proto__']
] as const

function expectTextOnly(element: Element, text: string): void {
  expect(element.textContent).toBe(text)
  expect(element.childElementCount).toBe(0)
}

function observeDisplaySideEffects(): () => void {
  const alert = vi.fn()
  const open = vi.fn(() => null)
  for (const [name, value] of [
    ['alert', alert],
    ['open', open]
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(window, name)
    Object.defineProperty(window, name, { configurable: true, value })
    restoreWindowFunctions.push(() => {
      if (original) Object.defineProperty(window, name, original)
      else Reflect.deleteProperty(window, name)
    })
  }
  const location = window.location.href
  return () => {
    expect(alert).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(window.location.href).toBe(location)
  }
}

describe('transaction modal cancellation', () => {
  it.each(['process', 'done'] as const)(
    'closes an invalidated preparation while preserving the historical estimate %s',
    async (estimate) => {
      const wrapper = mount(TxModal, {
        props: {
          visible: true,
          chain: 'eth',
          title: 'Claim',
          state: {
            estimate,
            send: 'wait',
            confirm: 'wait',
            readyToSign: false,
            error: STALE_PREPARATION_MESSAGE
          }
        }
      })
      expect(wrapper.get('.step-icon').text()).toBe(estimate === 'done' ? 'OK' : '...')
      expect(wrapper.get('.err-text').text()).toBe(STALE_PREPARATION_MESSAGE)
      expect(wrapper.findAll('button').map((button) => button.text())).toEqual(['x', 'Close'])
      const close = wrapper.get('button.btn-ghost')
      expect(close.attributes('aria-label')).toBe('Close transaction dialog')
      await close.trigger('click')
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('cancel')).toBeUndefined()
      expect(wrapper.emitted('sign')).toBeUndefined()
    }
  )

  it('keeps step elements and distinct accessible controls when the language changes', async () => {
    const preference = i18n.preference.value
    try {
      i18n.setPreference('en')
      const wrapper = mount(TxModal, {
        props: {
          visible: true,
          chain: 'eth',
          title: 'Claim',
          state: { estimate: 'process', send: 'wait', confirm: 'wait' }
        }
      })
      const steps = wrapper.findAll('.steps > li').map((step) => step.element)
      const close = wrapper.get('button.btn-ghost')
      expect(close.attributes('aria-label')).toBe('Cancel transaction preparation')
      i18n.setPreference('zh-Hant')
      await flushPromises()
      wrapper.findAll('.steps > li').forEach((step, index) => {
        expect(step.element).toBe(steps[index])
      })
      expect(close.attributes('aria-label')).toBe('取消交易準備')
      await close.trigger('click')
      expect(wrapper.emitted('cancel')).toHaveLength(1)
      expect(wrapper.emitted('close')).toBeUndefined()

      await wrapper.setProps({
        state: { estimate: 'done', send: 'process', confirm: 'wait', walletPrompted: true }
      })
      expect(close.attributes('aria-label')).toBe('隱藏交易對話框')
      await close.trigger('click')
      expect(wrapper.emitted('close')).toHaveLength(1)
      expect(wrapper.emitted('cancel')).toHaveLength(1)

      await wrapper.setProps({ state: { estimate: 'done', send: 'error', confirm: 'wait' } })
      expect(close.attributes('aria-label')).toBe('關閉交易對話框')
    } finally {
      i18n.setPreference(preference)
    }
  })

  it('permits cancelling final send preflight before the wallet request opens', async () => {
    const wrapper = mount(TxModal, {
      props: {
        visible: true,
        chain: 'eth',
        title: 'Claim',
        state: { estimate: 'done', send: 'process', confirm: 'wait', walletPrompted: false }
      }
    })
    const cancel = wrapper.findAll('button').find((button) => button.text() === 'Cancel')!
    await cancel.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Waiting for MetaMask')
  })
  it('lets the user cancel while transaction preparation is still running', async () => {
    const wrapper = mount(TxModal, {
      props: {
        visible: true,
        chain: 'eth',
        title: 'Claim & Re-Mint (10 days)',
        state: {
          estimate: 'process',
          send: 'wait',
          confirm: 'wait'
        }
      }
    })

    const closeButton = wrapper.get('button[title="Cancel"]')
    await closeButton.trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('shows an explicit cancel button during transaction preparation', async () => {
    const wrapper = mount(TxModal, {
      props: {
        visible: true,
        chain: 'eth',
        title: 'Claim & Re-Mint (10 days)',
        state: {
          estimate: 'wait',
          send: 'wait',
          confirm: 'wait'
        }
      }
    })

    const cancelButton = wrapper.get('button:not(.btn-ghost)')
    expect(cancelButton.text()).toBe('Cancel')
    await cancelButton.trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})

describe('transaction activity log', () => {
  it('renders timestamped operation entries and marks the active entry', () => {
    const wrapper = mount(TxModal, {
      props: {
        visible: true,
        chain: 'eth',
        title: 'Claim & Re-Mint (10 days)',
        state: {
          estimate: 'process',
          send: 'wait',
          confirm: 'wait',
          logs: [
            {
              at: Date.UTC(2026, 6, 25, 1, 2, 3),
              status: 'done',
              message: 'Configured RPC is available.'
            },
            {
              at: Date.UTC(2026, 6, 25, 1, 2, 4),
              status: 'process',
              message: 'Checking wallet network and pending transactions...'
            }
          ]
        }
      }
    })

    const entries = wrapper.findAll('[data-testid="tx-log-entry"]')
    expect(entries).toHaveLength(2)
    expect(entries[0].text()).toContain('Configured RPC is available.')
    expect(entries[1].text()).toContain('Checking wallet network and pending transactions...')
    expect(entries[1].classes()).toContain('process')
    expect(wrapper.get('[data-testid="tx-log"]').attributes('aria-live')).toBe('polite')
  })
})

describe('untrusted display text (H-07)', () => {
  it.each(dangerousDisplayTexts)('renders %s literally in transaction text', (_label, text) => {
    const expectNoSideEffects = observeDisplaySideEffects()
    const wrapper = mount(TxModal, {
      attachTo: document.body,
      props: {
        visible: true,
        chain: 'eth',
        title: text,
        state: {
          estimate: 'done',
          send: 'error',
          confirm: 'wait',
          error: text,
          logs: [{ at: Date.UTC(2026, 9, 22), status: 'error', message: text }]
        }
      }
    })

    expectTextOnly(wrapper.get('strong').element, text)
    expectTextOnly(wrapper.get('.err-text').element, text)
    expectTextOnly(wrapper.get('[data-testid="tx-log-entry"] span:last-child').element, text)
    expect(wrapper.find('script, img, svg, meta, iframe, a').exists()).toBe(false)
    expect(wrapper.emitted()).toEqual({})
    expectNoSideEffects()
  })

  it.each(dangerousDisplayTexts)('renders %s literally in pending text', (_label, text) => {
    const expectNoSideEffects = observeDisplaySideEffects()
    const operation: PendingOpView = {
      id: '__proto__',
      chain: 'eth',
      wallet: '0x0000000000000000000000000000000000000001',
      op: 'CLAIM',
      ids: [1],
      count: 0,
      term: 0,
      txHash: '',
      nonce: null,
      phase: 'awaiting-wallet',
      submittedAt: Date.UTC(2026, 9, 22),
      updatedAt: Date.UTC(2026, 9, 22),
      label: text,
      detail: text,
      explorerUrl: '#offline-fixture',
      status: 'pending'
    }
    const wrapper = mount(PendingOpsPanel, {
      attachTo: document.body,
      props: { ops: [operation], pendingCount: 1, checking: false }
    })

    expectTextOnly(wrapper.get('.tag-warn').element, text)
    expectTextOnly(wrapper.get('.detail').element, text)
    expect(wrapper.find('script, img, svg, meta, iframe').exists()).toBe(false)
    expect(wrapper.findAll('a')).toHaveLength(1)
    expect(wrapper.get('a').attributes('href')).toBe('#offline-fixture')
    expect(wrapper.emitted()).toEqual({})
    expectNoSideEffects()
  })

  it.each(dangerousDisplayTexts)('renders %s literally in RPC errors', async (_label, text) => {
    const expectNoSideEffects = observeDisplaySideEffects()
    const validate = vi.spyOn(rpc, 'validateRpcEndpoint').mockRejectedValueOnce(new Error(text))
    const wrapper = mount(RpcSettings, { attachTo: document.body, props: { chain: 'eth' } })

    await wrapper.get('button').trigger('click')
    await wrapper.get('textarea').setValue('https://offline.invalid/')
    await wrapper.get('.btn-primary').trigger('click')
    await flushPromises()

    expect(validate).toHaveBeenCalledExactlyOnceWith('https://offline.invalid/', 1)
    expectTextOnly(wrapper.get('.rpc-error').element, text)
    expect(wrapper.find('script, img, svg, meta, iframe, a').exists()).toBe(false)
    expect(wrapper.emitted('saved')).toBeUndefined()
    expectNoSideEffects()
  })
})
