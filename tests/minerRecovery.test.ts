// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  release: null as null | (() => void),
  send: vi.fn(),
  prepared: {
    chain: 'eth',
    wallet: '0x1111111111111111111111111111111111111111',
    op: 'GENERAL_MINT',
    ids: [],
    count: 1,
    term: 100,
    chainId: 1,
    factoryAddress: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
    contextKey: '1:0x1111111111111111111111111111111111111111',
    preparedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    gasLimit: 100000n,
    fnName: 'bulkClaimRank',
    args: [100n, 1n],
    batch: 'isolated-review',
    lockIds: [],
    state: { estimate: 'done', send: 'wait', confirm: 'wait', readyToSign: true, logs: [] }
  }
}))
vi.mock('@/core/txManager', () => ({
  prepareOperation: vi.fn(async (_params, callbacks) => {
    callbacks.onStep(harness.prepared.state)
    return harness.prepared
  }),
  sendPreparedOperation: harness.send,
  abortPrepared: vi.fn(),
  resumePendingLocks: vi.fn(async () => false),
  clearAbandonedSoftLocks: vi.fn()
}))
vi.mock('@/composables/useGasPrice', () => ({
  useGasPrice: () => ({ gwei: ref('1'), loading: ref(false), poll: vi.fn() })
}))
vi.mock('@/composables/useRpcHealth', () => ({
  useRpcHealth: () => ({
    state: ref({
      chain: 'eth',
      checking: false,
      checkedAt: null,
      totalUrls: 4,
      healthyUrls: [],
      failures: [],
      error: null
    }),
    unavailable: ref(false)
  })
}))
vi.mock('@/composables/usePendingTx', () => ({
  usePendingTx: () => ({
    hasPending: ref(false),
    pendingCount: ref(0),
    localUnresolvedCount: ref(0),
    ops: ref([]),
    checking: ref(false),
    check: vi.fn(async () => 0),
    trackHash: vi.fn(),
    markDropped: vi.fn()
  })
}))

import MinerView from '../src/views/MinerView.vue'
import { useWalletStore } from '../src/stores/walletStore'
import { useVmuStore } from '../src/stores/vmuStore'

it('account switch during send preflight detaches the old UI without disabling the new account', async () => {
  setActivePinia(createPinia())
  const wallet = useWalletStore()
  const store = useVmuStore()
  vi.spyOn(store, 'load').mockResolvedValue()
  vi.spyOn(store, 'refresh').mockResolvedValue()
  vi.spyOn(store, 'detach').mockImplementation(() => {})
  wallet.address = harness.prepared.wallet
  wallet.chainId = 1
  wallet.contractWalletChecked = true
  wallet.isContractWallet = false
  harness.send.mockImplementation(async (_prepared, callbacks) => {
    callbacks.onStep({
      estimate: 'done',
      send: 'process',
      confirm: 'wait',
      readyToSign: false,
      walletPrompted: false,
      logs: []
    })
    await new Promise<void>((resolve) => {
      harness.release = resolve
    })
    if (callbacks.isCancelled()) throw new Error('OPERATION_CANCELLED')
    return { estimate: 'done', send: 'error', confirm: 'wait' }
  })

  const wrapper = mount(MinerView, {
    global: {
      stubs: { WalletButton: true, RpcSettings: true, PendingOpsPanel: true, MintList: true }
    }
  })
  const button = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!
  await flushPromises()
  await button('Confirm Mint').trigger('click')
  await flushPromises()
  await button('Open MetaMask & Sign').trigger('click')
  await flushPromises()
  expect(harness.release).not.toBeNull()

  wallet.address = '0x2222222222222222222222222222222222222222'
  wallet.contextGen += 1
  await nextTick()
  harness.release!()
  await flushPromises()
  expect(button('Confirm Mint').attributes('disabled')).toBeUndefined()
  expect(wrapper.text()).not.toContain('MetaMask is still processing this request.')
  wrapper.unmount()
})

it('broadcast locks invalidate cached VMU groups immediately', async () => {
  localStorage.clear()
  setActivePinia(createPinia())
  const store = useVmuStore()
  store.$patch({
    chain: 'eth',
    wallet: harness.prepared.wallet,
    vmus: [
      {
        id: 1,
        address: '0x3333333333333333333333333333333333333333',
        status: 'CLAIMABLE',
        rank: 100,
        term: 100,
        maturityTs: 1700000000000,
        amplifier: 3000,
        eaaRate: 0,
        readOk: true
      }
    ]
  })
  expect(store.groups.flatMap((g) => g.ids)).toEqual([1])
  const locks = await import('../src/core/localLock')
  expect(
    locks.tryAcquireLock({
      chain: 'eth',
      wallet: harness.prepared.wallet,
      ids: [1],
      batch: 'review-lock'
    })
  ).toBe(true)
  locks.attachTxHash('review-lock', '0x' + 'a'.repeat(64))
  expect(locks.broadcastLockedIds('eth', harness.prepared.wallet).has(1)).toBe(true)
  expect(store.groups.flatMap((g) => g.ids)).toEqual([])
  expect(store.counts.CLAIMABLE).toBe(0)
  localStorage.clear()
})
