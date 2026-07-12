// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import MintList from '@/components/MintList.vue'
import { useVmuStore } from '@/stores/vmuStore'
import { useWalletStore } from '@/stores/walletStore'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'

function mountClaimableList() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wallet = useWalletStore()
  const store = useVmuStore()
  wallet.$patch({ address: ACCOUNT_A, chainId: 1, ready: true })
  store.$patch({
    chain: 'eth',
    wallet: ACCOUNT_A,
    vmuCount: 1,
    vmus: [
      {
        id: 1,
        address: '0x3333333333333333333333333333333333333333',
        status: 'CLAIMABLE',
        rank: 10,
        term: 100,
        maturityTs: Date.now() - 60_000,
        amplifier: 3_000,
        eaaRate: 0,
        readOk: true
      }
    ],
    syncedAt: 1,
    chainTimestampMs: Date.now(),
    rankAvailable: false
  })
  const wrapper = mount(MintList, {
    props: { busy: false },
    global: { plugins: [pinia] }
  })
  return { wrapper, wallet, store }
}

describe('MintList selection context', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('clears selected VMUs when the wallet account changes', async () => {
    const { wrapper, wallet } = mountClaimableList()
    await wrapper.get('input[type="checkbox"]').trigger('click')
    expect(wrapper.text()).toContain('1 VMUs selected')

    wallet.$patch({ address: ACCOUNT_B })
    await nextTick()

    expect(wrapper.text()).not.toContain('VMUs selected')
    expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('clears selected VMUs after a completed full refresh', async () => {
    const { wrapper, store } = mountClaimableList()
    await wrapper.get('input[type="checkbox"]').trigger('click')
    expect(wrapper.text()).toContain('1 VMUs selected')

    store.syncedAt = 2
    await nextTick()

    expect(wrapper.text()).not.toContain('VMUs selected')
  })
})
