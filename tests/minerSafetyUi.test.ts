// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { refreshPendingOps } from '@/core/pendingOps'
import { ensureHealthyReadProvider, resetProviders } from '@/core/rpc'
import { useWalletStore } from '@/stores/walletStore'
import { useVmuStore } from '@/stores/vmuStore'
import {
  abortPrepared,
  prepareOperation,
  sendPreparedOperation,
  type PreparedOp
} from '@/core/txManager'
import MinerView from '@/views/MinerView.vue'

vi.mock('@/core/txManager', () => ({
  prepareOperation: vi.fn(),
  sendPreparedOperation: vi.fn(),
  abortPrepared: vi.fn(),
  resumePendingLocks: vi.fn(async () => false),
  clearAbandonedSoftLocks: vi.fn()
}))
vi.mock('@/core/pendingOps', () => ({
  refreshPendingOps: vi.fn(),
  trackPendingTxHash: vi.fn(),
  markPendingOpDropped: vi.fn(),
  canMarkPendingOpDropped: vi.fn(() => false)
}))
vi.mock('@/composables/useGasPrice', () => ({
  useGasPrice: () => ({ gwei: ref('1'), loading: ref(false), poll: vi.fn() })
}))

let wrapper: ReturnType<typeof mount> | undefined
const empty = { views: [], pendingNonceGap: 0, unresolvedCount: 0, confirmedOps: [] }
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resetProviders()
  setActivePinia(createPinia())
  vi.mocked(refreshPendingOps).mockReset().mockResolvedValue(empty)
  const store = useVmuStore()
  vi.spyOn(store, 'load').mockResolvedValue()
  vi.spyOn(store, 'refresh').mockResolvedValue()
  vi.spyOn(store, 'detach').mockImplementation(() => {})
  useWalletStore().$patch({
    address: '0x1111111111111111111111111111111111111111',
    chainId: 1,
    contractWalletChecked: true,
    isContractWallet: false
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  resetProviders()
  vi.restoreAllMocks()
})
function render() {
  wrapper = mount(MinerView, {
    global: {
      stubs: {
        WalletButton: true,
        RpcSettings: true,
        PendingOpsPanel: true,
        MintList: {
          props: ['busy', 'blockedReason'],
          template: '<div data-testid="mint-list" :data-busy="busy">{{ blockedReason }}</div>'
        }
      }
    }
  })
  return wrapper
}
it.each(['count', 'length'] as const)(
  'explains a legacy RPC %s configuration failure rather than blaming the network',
  async (kind) => {
    const urls =
      kind === 'count'
        ? Array.from({ length: 17 }, (_, id) => `https://rpc${id}.example/`)
        : [`https://rpc.example/${'x'.repeat(2048)}`]
    const stored = JSON.stringify({ eth: urls })
    localStorage.setItem('sm.customRpc', stored)
    await expect(ensureHealthyReadProvider('eth', vi.fn())).rejects.toThrow(
      'configuration is invalid'
    )
    const view = render()
    const banner = view.get('.rpc-health-banner').text()
    expect(banner).toContain(kind === 'count' ? 'at most 16' : '2048 characters')
    expect(banner).toContain('RPC settings')
    expect(banner).not.toContain('Check internet access')
    expect(localStorage.getItem('sm.customRpc')).toBe(stored)
  }
)
it('blocks every operation after a new scope check fails and until its retry succeeds', async () => {
  let resolve!: (value: typeof empty) => void
  const retry = new Promise<typeof empty>((done) => {
    resolve = done
  })
  const view = render()
  const mint = () => view.findAll('button').find((button) => button.text() === 'Confirm Mint')!
  await flushPromises()
  expect(mint().attributes('disabled')).toBeUndefined()
  vi.mocked(refreshPendingOps).mockRejectedValue(new Error('nonce check failed'))
  useWalletStore().address = '0x2222222222222222222222222222222222222222'
  await nextTick()
  await flushPromises()
  expect(mint().attributes('disabled')).toBeDefined()
  expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('true')
  expect(view.text()).toContain('pending transaction check failed')
  vi.mocked(refreshPendingOps).mockReturnValue(retry)
  view.findComponent({ name: 'PendingOpsPanel' }).vm.$emit('recheck')
  await nextTick()
  expect(mint().attributes('disabled')).toBeDefined()
  resolve(empty)
  await flushPromises()
  expect(mint().attributes('disabled')).toBeUndefined()
  expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('false')
})

it('does not sign after a shared pending check fails while its trailing retry is unresolved', async () => {
  const prepared: PreparedOp = {
    chain: 'eth',
    wallet: useWalletStore().address!,
    op: 'GENERAL_MINT',
    ids: [],
    count: 1,
    term: 100,
    chainId: 1,
    factoryAddress: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
    contextKey: 'prepared-ui-test',
    preparedAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    gasLimit: 100_000n,
    fnName: 'bulkClaimRank',
    args: [100n, 1n],
    batch: 'prepared-ui-test',
    lockIds: [],
    state: { estimate: 'done', send: 'wait', confirm: 'wait', readyToSign: true }
  }
  vi.mocked(prepareOperation).mockImplementation(async (_params, callbacks) => {
    callbacks?.onStep?.(prepared.state)
    return prepared
  })
  const view = render()
  const button = (name: string) => view.findAll('button').find((entry) => entry.text() === name)!
  await flushPromises()
  await button('Confirm Mint').trigger('click')
  await flushPromises()
  expect(button('Open MetaMask & Sign')).toBeDefined()

  let reject!: (error: Error) => void
  let resolveRetry!: (value: typeof empty) => void
  const background = new Promise<typeof empty>((_resolve, fail) => {
    reject = fail
  })
  const retry = new Promise<typeof empty>((resolve) => {
    resolveRetry = resolve
  })
  vi.mocked(refreshPendingOps).mockReturnValueOnce(background).mockReturnValueOnce(retry)
  view.findComponent({ name: 'PendingOpsPanel' }).vm.$emit('recheck')
  await button('Open MetaMask & Sign').trigger('click')
  reject(new Error('shared pending check failed'))
  await flushPromises()
  try {
    expect(view.text()).toContain('pending transactions')
    expect(sendPreparedOperation).not.toHaveBeenCalled()
    expect(abortPrepared).toHaveBeenCalledWith(prepared)
  } finally {
    resolveRetry(empty)
    await flushPromises()
  }
  expect(button('Confirm Mint').attributes('disabled')).toBeUndefined()
})
