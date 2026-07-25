// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TxModal from '@/components/TxModal.vue'

describe('transaction modal cancellation', () => {
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
