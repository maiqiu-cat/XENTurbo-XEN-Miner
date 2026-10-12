// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wallet = vi.hoisted(() => ({
  address: null as string | null,
  connect: vi.fn(),
  connectError: null as string | null,
  isConnected: false
}))

vi.mock('@/stores/walletStore', () => ({ useWalletStore: () => wallet }))

import WalletButton from '@/components/WalletButton.vue'

describe('WalletButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wallet.address = null
    wallet.connectError = null
    wallet.isConnected = false
  })

  it('still connects through the wallet store', async () => {
    wallet.connect.mockImplementation(async () => {
      wallet.address = '0x0000000000000000000000000000000000000001'
      wallet.isConnected = true
    })
    const wrapper = mount(WalletButton)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(wallet.connect).toHaveBeenCalledOnce()
    expect(wallet.isConnected).toBe(true)
    wrapper.unmount()
  })

  it.each([
    'Connection request rejected.',
    'No injected wallet detected. Install MetaMask.',
    'Wallet provider failed.'
  ])('preserves the store connection error: %s', async (message) => {
    wallet.connect.mockImplementation(async () => {
      wallet.connectError = message
    })
    const wrapper = mount(WalletButton)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(wallet.connectError).toBe(message)
    expect(wrapper.get('button').text()).toBe('Connect Wallet')
    wrapper.unmount()
  })

  it('renders the shortened connected account', () => {
    wallet.address = '0x1111111111111111111111111111111111111111'
    wallet.isConnected = true
    const wrapper = mount(WalletButton)
    expect(wrapper.get('button').text()).toBe('0x1111...1111')
    wrapper.unmount()
  })
})
