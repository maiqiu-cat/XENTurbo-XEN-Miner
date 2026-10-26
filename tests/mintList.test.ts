// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import MintList from '@/components/MintList.vue'
import { useVmuStore } from '@/stores/vmuStore'
import { useWalletStore } from '@/stores/walletStore'

const chainClock = vi.hoisted(() => ({ readChainTimestamp: vi.fn() }))
vi.mock('@/core/chainReader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/chainReader')>()),
  readChainTimestamp: chainClock.readChainTimestamp
}))
vi.mock('@/core/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/rpc')>()),
  ensureHealthyReadProvider: vi.fn().mockResolvedValue({})
}))

enableAutoUnmount(afterEach)

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
    stale: false,
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
  afterEach(() => {
    useVmuStore().detach()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

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

  it('keeps stale rows visible but clears selection and blocks claim while allowing refresh', async () => {
    const { wrapper, store } = mountClaimableList()
    await wrapper.get('input[type="checkbox"]').trigger('click')
    expect(wrapper.text()).toContain('1 VMUs selected')
    store.stale = true
    store.error = 'Read failed'
    await nextTick()

    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('VMUs selected')
    expect(wrapper.get('[data-testid="stale-vmu-warning"]').text()).toContain('may be outdated')
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    const refresh = wrapper.findAll('button').find((button) => button.text() === 'Refresh')!
    expect(refresh.attributes('disabled')).toBeUndefined()
    await wrapper.get('tbody tr').trigger('click')
    expect(wrapper.text()).not.toContain('VMUs selected')

    store.stale = false
    store.error = null
    await nextTick()
    expect(wrapper.find('[data-testid="stale-vmu-warning"]').exists()).toBe(false)
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('input[type="checkbox"]').trigger('click')
    expect(wrapper.text()).toContain('1 VMUs selected')
  })

  it('renders large grouped wallets in bounded pages', async () => {
    const { wrapper, store } = mountClaimableList()
    const now = Date.now()
    store.$patch({
      vmuCount: 250,
      vmus: Array.from({ length: 250 }, (_, index) => ({
        id: index + 1,
        address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
        status: 'CLAIMABLE' as const,
        rank: index + 1,
        term: 100,
        maturityTs: now - (index + 1) * 1_000,
        amplifier: 3_000,
        eaaRate: 0,
        readOk: true
      }))
    })
    await nextTick()

    expect(wrapper.findAll('tbody tr')).toHaveLength(100)
    expect(wrapper.text()).toContain('Page 1 of 3')

    await wrapper.get('button[aria-label="Next page"]').trigger('click')
    expect(wrapper.findAll('tbody tr')).toHaveLength(100)
    expect(wrapper.text()).toContain('Page 2 of 3')
  })

  it('uses chain time for the countdown even if the system clock is days ahead', async () => {
    vi.useFakeTimers()
    const chainTime = 1_800_000_000_000
    vi.setSystemTime(chainTime + 2 * 86_400_000)
    const { wrapper, store } = mountClaimableList()
    store.$patch({
      chainTimestampMs: chainTime,
      syncedAt: Date.now(),
      vmus: [{ ...store.vmus[0], status: 'MINTING', maturityTs: chainTime + 3_600_000 }]
    })
    await nextTick()

    const row = wrapper.get('tbody tr')
    expect(row.text()).toContain('Maturing')
    expect(row.text()).toContain('1h 0m')
    expect(row.text()).not.toContain('Matured')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the page but clears selection during refresh, without flashing a stale warning', async () => {
    const { wrapper, store, wallet } = mountClaimableList()
    store.vmus = Array.from({ length: 250 }, (_, index) => ({
      ...store.vmus[0],
      id: index + 1,
      maturityTs: index * 1000
    }))
    store.vmuCount = 250
    await nextTick()
    await wrapper.get('button[aria-label="Next page"]').trigger('click')
    await wrapper.get('input[type="checkbox"]').trigger('click')
    expect(wrapper.text()).toContain('1 VMUs selected')
    store.refreshGen += 1
    store.loading = true
    store.stale = true
    await nextTick()
    expect(wrapper.text()).toContain('Page 2 of 3')
    expect(wrapper.text()).not.toContain('VMUs selected')
    expect(wrapper.find('[data-testid="stale-vmu-warning"]').exists()).toBe(false)
    expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    store.syncedAt = 2
    store.stale = false
    store.loading = false
    await nextTick()
    expect(wrapper.text()).toContain('Page 2 of 3')
    wallet.contextGen += 1
    await nextTick()
    expect(wrapper.text()).toContain('Page 1 of 3')
    await wrapper.get('button[aria-label="Next page"]').trigger('click')
    store.vmus = store.vmus.slice(0, 100)
    await nextTick()
    expect(wrapper.findAll('tbody tr')).toHaveLength(100)
    expect(wrapper.text()).not.toContain('Page 2')
  })

  it.each(['focus', 'visibilitychange', 'pageshow'])(
    'does not rescan stale matured rows after repeated %s events',
    async (event) => {
      vi.useFakeTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      const { wrapper, store } = mountClaimableList()
      store.vmus[0].status = 'MINTING'
      store.stale = true
      const refresh = vi.spyOn(store, 'refresh').mockResolvedValue()
      chainClock.readChainTimestamp.mockResolvedValue(Date.now())
      for (let index = 0; index < 5; index++) {
        const resume = new Event(event)
        if (event === 'pageshow') Object.defineProperty(resume, 'persisted', { value: true })
        ;(event === 'visibilitychange' ? document : window).dispatchEvent(resume)
        await flushPromises()
        await vi.advanceTimersByTimeAsync(1500)
      }
      expect(refresh).not.toHaveBeenCalled()
      expect(store.transactionReady).toBe(false)
      wrapper.unmount()
    }
  )

  it('advances with a monotonic clock and waits for chain confirmation at maturity', async () => {
    vi.useFakeTimers()
    const chainTime = 1_800_000_000_000
    let elapsed = 100
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const { wrapper, store } = mountClaimableList()
    store.$patch({
      chainTimestampMs: chainTime,
      vmus: [{ ...store.vmus[0], status: 'MINTING', maturityTs: chainTime + 60_000 }]
    })
    await nextTick()

    elapsed += 30_000
    vi.setSystemTime(chainTime + 20 * 86_400_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wrapper.get('tbody tr').text()).toContain('0m')
    expect(wrapper.get('tbody tr').text()).not.toContain('Matured')

    elapsed += 30_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wrapper.get('tbody tr').text()).toContain('Awaiting chain confirmation')
    expect(store.vmus[0].status).toBe('MINTING')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('reanchors to fresh chain time after sleep without rescanning VMUs', async () => {
    vi.useFakeTimers()
    const chainTime = 1_800_000_000_000
    vi.setSystemTime(chainTime)
    vi.spyOn(performance, 'now').mockReturnValue(100)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    chainClock.readChainTimestamp.mockResolvedValue(chainTime + 3_600_000)
    const { wrapper, store } = mountClaimableList()
    store.$patch({
      chainTimestampMs: chainTime,
      vmus: [{ ...store.vmus[0], status: 'MINTING', maturityTs: chainTime + 7_200_000 }]
    })
    const refresh = vi.spyOn(store, 'refresh').mockResolvedValue()
    store.scheduleMaturityRefresh()
    await nextTick()
    expect(wrapper.get('tbody tr').text()).toContain('2h 0m')

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(3_600_000)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    expect(wrapper.get('tbody tr').text()).toContain('1h 0m')
    expect(store.chainTimestampMs).toBe(chainTime + 3_600_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(store.vmus[0].status).toBe('MINTING')
    await vi.advanceTimersByTimeAsync(3_601_500)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps chain time unavailable after a failed resume and retries on focus', async () => {
    vi.useFakeTimers()
    const chainTime = 1_800_000_000_000
    vi.setSystemTime(chainTime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const { wrapper, store } = mountClaimableList()
    store.$patch({
      chainTimestampMs: chainTime,
      vmus: [{ ...store.vmus[0], status: 'MINTING', maturityTs: chainTime + 3_600_000 }]
    })
    chainClock.readChainTimestamp.mockRejectedValueOnce(new Error('offline'))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.get('tbody tr').text()).toContain('Chain time unavailable')
    expect(store.vmus[0].status).toBe('MINTING')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)

    chainClock.readChainTimestamp.mockResolvedValueOnce(chainTime + 60_000)
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.get('tbody tr').text()).toContain('59m')
  })

  it('coalesces resume events and cancels the read when unmounted', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const { wrapper, store } = mountClaimableList()
    let finish!: (value: number) => void
    chainClock.readChainTimestamp.mockClear().mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve
      })
    )
    const previous = store.chainTimestampMs
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(chainClock.readChainTimestamp).toHaveBeenCalledOnce()
    wrapper.unmount()
    finish(previous! + 60_000)
    await flushPromises()
    expect(store.chainTimestampMs).toBe(previous)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(chainClock.readChainTimestamp).toHaveBeenCalledOnce()
  })
})
