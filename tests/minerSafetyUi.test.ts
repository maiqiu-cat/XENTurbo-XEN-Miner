// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { refreshPendingOps } from '@/core/pendingOps'
import { ensureHealthyReadProvider, resetProviders } from '@/core/rpc'
import { useWalletStore } from '@/stores/walletStore'
import { useVmuStore } from '@/stores/vmuStore'
import { recoverTransactionStorage } from '@/core/storageRecovery'
import {
  abortPrepared,
  prepareOperation,
  sendPreparedOperation,
  type PreparedOp
} from '@/core/txManager'
import MinerView from '@/views/MinerView.vue'
import StorageRecovery from '@/components/StorageRecovery.vue'

vi.mock('@/core/txManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/txManager')>()),
  prepareOperation: vi.fn(),
  sendPreparedOperation: vi.fn(),
  abortPrepared: vi.fn(),
  resumePendingLocks: vi.fn(async () => false),
  clearAbandonedSoftLocks: vi.fn()
}))
vi.mock('@/core/pendingOps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/pendingOps')>()),
  refreshPendingOps: vi.fn(),
  trackPendingTxHash: vi.fn(),
  markPendingOpDropped: vi.fn(),
  canMarkPendingOpDropped: vi.fn(() => false)
}))
vi.mock('@/composables/useGasPrice', () => ({
  useGasPrice: () => ({ gwei: ref('1'), loading: ref(false), poll: vi.fn() })
}))
vi.mock('@/core/storageRecovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/storageRecovery')>()),
  recoverTransactionStorage: vi.fn()
}))

let wrapper: ReturnType<typeof mount> | undefined
const empty = { views: [], pendingNonceGap: 0, unresolvedCount: 0, confirmedOps: [] }
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resetProviders()
  setActivePinia(createPinia())
  vi.mocked(refreshPendingOps).mockReset().mockResolvedValue(empty)
  vi.mocked(recoverTransactionStorage).mockReset()
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
  vi.useRealTimers()
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

it.each(['disconnect', 'unsupported-chain'] as const)(
  'clears the recovery gate after %s unmounts the dialog',
  async (kind) => {
    const view = render()
    await flushPromises()
    await view.getComponent(StorageRecovery).get('button').trigger('click')
    expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('true')
    const wallet = useWalletStore()
    if (kind === 'disconnect') wallet.address = null
    else wallet.chainId = 999
    await nextTick()
    await flushPromises()
    wallet.$patch({ address: '0x1111111111111111111111111111111111111111', chainId: 1 })
    await nextTick()
    await flushPromises()
    expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('false')
    const mint = view.findAll('button').find((button) => button.text() === 'Confirm Mint')!
    expect(mint.attributes('disabled')).toBeUndefined()
  }
)

it.each(['PENDING_STORAGE_READ_FAILED', 'LOCK_STORAGE_INVALID'])(
  'forces reconciliation after real recovery clicks and stays blocked through %s',
  async (code) => {
    vi.useFakeTimers()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:offline-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = render()
    await flushPromises()
    localStorage.setItem('sm.vmuLocks', JSON.stringify([{ damaged: true }]))
    const recovery = view.getComponent(StorageRecovery)
    await recovery.get('button').trigger('click')
    expect(view.get('[data-testid="mint-list"]').text()).toContain(
      'Transaction storage recovery is open'
    )
    let reject!: (error: Error) => void
    vi.mocked(refreshPendingOps)
      .mockClear()
      .mockReturnValue(
        new Promise((_resolve, fail) => {
          reject = fail
        })
      )
    const repaired = {
      repaired: 1,
      blocked: 0,
      backupKey: 'fixture-backup',
      blockedReasons: { unidentified: 0, otherContext: 0, unconfirmed: 0, readLimit: 0 }
    }
    if (code === 'LOCK_STORAGE_INVALID')
      vi.mocked(recoverTransactionStorage).mockRejectedValue(
        new Error('WALLET_EVIDENCE_UNAVAILABLE')
      )
    else vi.mocked(recoverTransactionStorage).mockResolvedValue(repaired)
    const dialogButton = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent?.trim() === name
      )!
    dialogButton('Export backup').click()
    document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click()
    await flushPromises()
    dialogButton('Verify and repair').click()
    await flushPromises()
    expect(recoverTransactionStorage).toHaveBeenCalledOnce()
    expect(refreshPendingOps).toHaveBeenCalledOnce()
    expect(refreshPendingOps).toHaveBeenLastCalledWith(
      'eth',
      useWalletStore().address,
      expect.objectContaining({ reverifyResults: true })
    )
    document.querySelector<HTMLButtonElement>('[aria-label="Close recovery"]')!.click()
    await flushPromises()
    const mint = () => view.findAll('button').find((button) => button.text() === 'Confirm Mint')!
    expect(mint().attributes('disabled')).toBeDefined()
    expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('true')
    reject(new Error(`${code}: fixture`))
    await flushPromises()
    expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('true')
    expect(view.text()).toContain('Open transaction storage recovery')
    expect(view.text()).not.toContain(code)
    expect(mint().attributes('disabled')).toBeDefined()
    // No polling timers run: only the real recovery callback can have requested this check.
    expect(refreshPendingOps).toHaveBeenCalledOnce()
    vi.mocked(refreshPendingOps).mockResolvedValue(empty)
    view.findComponent({ name: 'PendingOpsPanel' }).vm.$emit('recheck')
    await flushPromises()
    expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('false')
    expect(mint().attributes('disabled')).toBeUndefined()
    expect(sendPreparedOperation).not.toHaveBeenCalled()
  }
)

it('closes recovery on a same-account generation change without bypassing wallet verification', async () => {
  const view = render()
  await flushPromises()
  await view.getComponent(StorageRecovery).get('button').trigger('click')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  let resolve!: (value: typeof empty) => void
  vi.mocked(refreshPendingOps).mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const wallet = useWalletStore()
  wallet.$patch({
    contextGen: wallet.contextGen + 1,
    contractWalletChecked: false,
    contractWalletChecking: true
  })
  await nextTick()
  await flushPromises()
  try {
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('true')
  } finally {
    resolve(empty)
    await flushPromises()
  }
  expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('true')
  wallet.$patch({ contractWalletChecked: true, contractWalletChecking: false })
  await nextTick()
  expect(view.get('[data-testid="mint-list"]').attributes('data-busy')).toBe('false')
  const mint = view.findAll('button').find((button) => button.text() === 'Confirm Mint')!
  expect(mint.attributes('disabled')).toBeUndefined()
})

it.each([false, true])(
  'does not revive signing after a failed shared check (immediate retry: %s)',
  async (immediateRetry) => {
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
      lifecycle: { phase: 'prepared' },
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
    vi.mocked(refreshPendingOps)
      .mockReturnValueOnce(background)
      .mockReturnValueOnce(immediateRetry ? Promise.resolve(empty) : retry)
    view.findComponent({ name: 'PendingOpsPanel' }).vm.$emit('recheck')
    await button('Open MetaMask & Sign').trigger('click')
    reject(new Error('shared pending check failed'))
    await flushPromises()
    try {
      expect(view.get('.modal-body .err-text').text()).toContain('shared pending check failed')
      expect(sendPreparedOperation).not.toHaveBeenCalled()
      expect(abortPrepared).toHaveBeenCalledWith(prepared)
    } finally {
      resolveRetry(empty)
      await flushPromises()
    }
    expect(sendPreparedOperation).not.toHaveBeenCalled()
    expect(button('Open MetaMask & Sign')).toBeUndefined()
    expect(button('Confirm Mint').attributes('disabled')).toBeUndefined()
  }
)
