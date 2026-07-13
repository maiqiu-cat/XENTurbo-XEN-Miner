// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wallet = vi.hoisted(() => ({
  address: null as string | null,
  connect: vi.fn(),
  connectError: null as string | null,
  isConnected: false
}))
const trackAnalyticsEvent = vi.hoisted(() => vi.fn())

vi.mock('@/stores/walletStore', () => ({ useWalletStore: () => wallet }))
vi.mock('@/core/analytics', () => ({ trackAnalyticsEvent }))

import WalletButton from '@/components/WalletButton.vue'

describe('WalletButton analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wallet.address = null
    wallet.connectError = null
    wallet.isConnected = false
  })

  it('reports a successful connection without the wallet address', async () => {
    wallet.connect.mockImplementation(async () => {
      wallet.address = '0x0000000000000000000000000000000000000001'
      wallet.isConnected = true
    })
    const wrapper = mount(WalletButton)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(trackAnalyticsEvent).toHaveBeenCalledWith('wallet_connect_result', {
      result: 'success'
    })
    expect(JSON.stringify(trackAnalyticsEvent.mock.calls)).not.toContain(wallet.address)
  })

  it.each([
    ['Connection request rejected.', 'rejected'],
    ['No injected wallet detected. Install MetaMask.', 'no_wallet'],
    ['Wallet provider failed.', 'error']
  ] as const)('classifies %s as %s without sending the error text', async (message, result) => {
    wallet.connect.mockImplementation(async () => {
      wallet.connectError = message
    })
    const wrapper = mount(WalletButton)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(trackAnalyticsEvent).toHaveBeenCalledWith('wallet_connect_result', { result })
    expect(JSON.stringify(trackAnalyticsEvent.mock.calls)).not.toContain(message)
  })
})
