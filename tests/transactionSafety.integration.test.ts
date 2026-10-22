import { Interface } from 'ethers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTRACTS } from '@/config/contracts'
import type { Eip1193Request, InjectedProvider } from '@/core/eip1193'
import type { PendingOpRecord } from '@/core/pendingOps'

const WALLET = '0x0000000000000000000000000000000000000001'
const OTHER_WALLET = '0x0000000000000000000000000000000000000002'
const HASH = `0x${'a'.repeat(64)}`
const NONCE = 7
const claimInterface = new Interface([
  'function bulkClaimMintReward(uint256[] ids)',
  'function bulkClaimMintReward_(uint256[] ids)'
])

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 22))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('@/core/rpc')
  vi.doUnmock('@/core/chainReader')
  vi.resetModules()
})

async function installOfflineHarness(storageFailure?: 'QuotaExceededError' | 'SecurityError') {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: vi.fn((key: string, value: string) => {
      if (storageFailure && key.startsWith('sm.pendingOps.event.')) {
        throw new DOMException('Offline pending-storage failure', storageFailure)
      }
      values.set(key, String(value))
    })
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network access is forbidden in this offline fixture')
    })
  )

  // Only chain-read boundaries and browser facilities are replaced. The real
  // prepare/send, writeFactory, wallet gas validation, pending journal and VMU locks are retained.
  const readProvider = {
    getTransactionCount: vi.fn(async () => NONCE),
    estimateGas: vi.fn(async () => 100_000n),
    getBlock: vi.fn(async () => ({ gasLimit: 30_000_000n })),
    waitForTransaction: vi.fn()
  }
  vi.doMock('@/core/rpc', () => ({
    getReadProvider: () => readProvider,
    ensureHealthyReadProvider: vi.fn(async () => readProvider),
    ensureRecentReadProvider: vi.fn(async () => readProvider),
    withRetry: (work: () => Promise<unknown>) => work()
  }))
  vi.doMock('@/core/chainReader', () => ({
    readFee: vi.fn(async () => 0n),
    readVmuStatuses: vi.fn(async () => new Map([[1, 'CLAIMABLE']])),
    readVmuStates: vi.fn(async () => []),
    readVmuCount: vi.fn(async () => 1),
    readVmuProxyDeployments: vi.fn(async () => new Map())
  }))

  const { createInMemoryExclusiveGate, operationKey } = await import('@/core/operationGate')
  const gate = createInMemoryExclusiveGate()
  const activeLocks = new Set<string>()
  const lockRequest = vi.fn((key: string, options: LockOptions, work: () => Promise<unknown>) => {
    const signal = options.signal
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(new DOMException('Lock request aborted', 'AbortError'))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      const queued = gate.run(key, async () => {
        if (signal?.aborted) throw new DOMException('Lock request aborted', 'AbortError')
        signal?.removeEventListener('abort', abort)
        activeLocks.add(key)
        try {
          return await work()
        } finally {
          activeLocks.delete(key)
        }
      })
      void queued.then(
        (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        }
      )
    })
  })
  vi.stubGlobal('navigator', { locks: { request: lockRequest } })

  const walletResponse = deferred<unknown>()
  const userRejection = Object.assign(new Error('User rejected the request'), { code: 4001 })
  const pendingAtSend: PendingOpRecord[][] = []
  const request = vi.fn(async ({ method, params }: Eip1193Request): Promise<unknown> => {
    if (method === 'eth_accounts') return [WALLET]
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getTransactionCount') return `0x${NONCE.toString(16)}`
    if (method === 'eth_estimateGas') return '0x186a0'
    if (method === 'eth_getBlockByNumber') return { gasLimit: '0x1c9c380' }
    if (method === 'eth_call') {
      const call = params?.[0] as { to: string; data: string }
      const decoded = claimInterface.parseTransaction({ data: call.data })
      if (
        call.to.toLowerCase() === CONTRACTS.eth.factory.toLowerCase() &&
        (decoded?.name === 'bulkClaimMintReward_' || decoded?.name === 'bulkClaimMintReward')
      ) {
        return '0x'
      }
    }
    if (method === 'eth_sendTransaction') {
      pendingAtSend.push(pending.listPendingOps('eth', WALLET))
      if (pendingAtSend.length === 1) return walletResponse.promise
      throw userRejection
    }
    throw new Error(`Unexpected offline wallet method: ${method}`)
  })
  const injected: InjectedProvider = { request, on: vi.fn(), removeListener: vi.fn() }
  vi.stubGlobal('window', { ethereum: injected })

  const tx = await import('@/core/txManager')
  const pending = await import('@/core/pendingOps')
  const locks = await import('@/core/localLock')
  const wallet = await import('@/core/wallet')
  expect(vi.isMockFunction(wallet.writeFactory)).toBe(false)
  const prepare = () => tx.prepareOperation({ chain: 'eth', wallet: WALLET, op: 'CLAIM', ids: [1] })
  const sendRequests = () =>
    request.mock.calls.map(([args]) => args).filter((args) => args.method === 'eth_sendTransaction')

  return {
    tx,
    pending,
    locks,
    prepare,
    sendRequests,
    request,
    walletResponse,
    userRejection,
    pendingAtSend,
    readProvider,
    storage,
    activeLocks,
    lockRequest,
    lockKey: operationKey('eth', WALLET)
  }
}

async function detachAtWalletTimeout(harness: Awaited<ReturnType<typeof installOfflineHarness>>) {
  const prepared = await harness.prepare()
  expect(harness.locks.lockedIds('eth', WALLET)).toEqual(new Set([1]))
  const onStep = vi.fn()
  const sending = harness.tx.sendPreparedOperation(prepared, { onStep })
  const timeout = expect(sending).rejects.toThrow('WALLET_RESPONSE_TIMEOUT')
  await vi.waitFor(() => expect(harness.sendRequests()).toHaveLength(1))
  expect(harness.pendingAtSend[0]).toEqual([
    expect.objectContaining({ id: prepared.batch, phase: 'awaiting-wallet', nonce: NONCE })
  ])
  expect(harness.sendRequests()[0].params?.[0]).toEqual(
    expect.objectContaining({
      from: WALLET,
      to: CONTRACTS.eth.factory,
      data: claimInterface.encodeFunctionData('bulkClaimMintReward', [[1]]),
      nonce: `0x${NONCE.toString(16)}`,
      gas: `0x${130_000n.toString(16)}`
    })
  )

  await vi.advanceTimersByTimeAsync(harness.tx.WALLET_RESPONSE_TIMEOUT_MS)
  await timeout

  expect(harness.sendRequests()).toHaveLength(1)
  expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
  expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
    expect.objectContaining({ id: prepared.batch, phase: 'awaiting-wallet', txHash: '' })
  ])
  expect(harness.activeLocks).toContain(harness.lockKey)
  return { prepared, onStep }
}

describe('offline transaction safety integration (H-08)', () => {
  it('persists a late hash across reload and blocks a queued resend', async () => {
    const harness = await installOfflineHarness()
    const { prepared, onStep } = await detachAtWalletTimeout(harness)
    const notifications = onStep.mock.calls.length
    const retry = await harness.prepare()
    const retryFailure = expect(harness.tx.sendPreparedOperation(retry)).rejects.toThrow(
      'LOCAL_PENDING_UNRESOLVED'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.lockRequest).toHaveBeenCalledTimes(2)
    expect(harness.sendRequests()).toHaveLength(1)

    harness.walletResponse.resolve(HASH)
    await retryFailure
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.sendRequests()).toHaveLength(1)
    expect(harness.readProvider.waitForTransaction).not.toHaveBeenCalled()
    expect(onStep).toHaveBeenCalledTimes(notifications)
    expect(harness.activeLocks.size).toBe(0)
    expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({
        id: prepared.batch,
        phase: 'broadcast',
        txHash: HASH,
        nonce: NONCE,
        nonceAuthoritative: false
      })
    ])

    vi.resetModules()
    const reloaded = await import('@/core/pendingOps')
    expect(reloaded.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
    expect(reloaded.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, phase: 'broadcast', txHash: HASH })
    ])
    expect(harness.sendRequests()).toHaveLength(1)
  })

  it('drops only a late code-4001 request, allowing a new explicit send', async () => {
    const harness = await installOfflineHarness()
    const { prepared } = await detachAtWalletTimeout(harness)
    harness.pending.recordPendingOp({
      id: 'other-wallet-operation',
      chain: 'eth',
      wallet: OTHER_WALLET,
      op: 'CLAIM',
      ids: [2],
      count: 0,
      term: 0,
      txHash: '',
      nonce: NONCE,
      phase: 'awaiting-wallet'
    })

    harness.walletResponse.reject(harness.userRejection)
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.sendRequests()).toHaveLength(1)
    expect(harness.activeLocks.size).toBe(0)
    expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(0)
    expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, phase: 'dropped', txHash: '' })
    ])
    expect(harness.pending.countUnresolvedPendingOps('eth', OTHER_WALLET)).toBe(1)

    // A second send is allowed only after a new, explicit prepare/send action.
    const fresh = await harness.prepare()
    expect(harness.locks.lockedIds('eth', WALLET)).toEqual(new Set([1]))
    await expect(harness.tx.sendPreparedOperation(fresh)).rejects.toBe(harness.userRejection)
    expect(harness.sendRequests()).toHaveLength(2)
    expect(harness.locks.lockedIds('eth', WALLET).size).toBe(0)
    expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(0)
    expect(harness.pending.countUnresolvedPendingOps('eth', OTHER_WALLET)).toBe(1)
  })

  it('keeps the pending gate after a late ambiguous wallet failure', async () => {
    const harness = await installOfflineHarness()
    const { prepared } = await detachAtWalletTimeout(harness)
    harness.walletResponse.reject(Object.assign(new Error('Wallet disconnected'), { code: 4900 }))
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, phase: 'awaiting-wallet', txHash: '' })
    ])
    expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
    const retry = await harness.prepare()
    await expect(harness.tx.sendPreparedOperation(retry)).rejects.toThrow(
      'LOCAL_PENDING_UNRESOLVED'
    )
    expect(harness.sendRequests()).toHaveLength(1)
    expect(harness.readProvider.waitForTransaction).not.toHaveBeenCalled()
  })

  it.each(['QuotaExceededError', 'SecurityError'] as const)(
    'does not call eth_sendTransaction when pending persistence fails with %s',
    async (failure) => {
      const harness = await installOfflineHarness(failure)
      const prepared = await harness.prepare()
      expect(harness.locks.lockedIds('eth', WALLET)).toEqual(new Set([1]))

      await expect(harness.tx.sendPreparedOperation(prepared)).rejects.toThrow(
        'PENDING_STORAGE_WRITE_FAILED'
      )

      expect(harness.storage.setItem).toHaveBeenCalledWith(
        expect.stringMatching(/^sm\.pendingOps\.event\./),
        expect.any(String)
      )
      expect(
        harness.request.mock.calls.filter(([args]) => args.method === 'eth_estimateGas')
      ).toHaveLength(2)
      // Non-interactive reads are expected; the actual send request is the prompt boundary.
      expect(harness.sendRequests()).toHaveLength(0)
      expect(
        harness.request.mock.calls.some(
          ([args]) =>
            args.method === 'eth_requestAccounts' || args.method === 'wallet_switchEthereumChain'
        )
      ).toBe(false)
      expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(0)
      expect(harness.locks.lockedIds('eth', WALLET).size).toBe(0)
      expect(harness.activeLocks.size).toBe(0)
      expect(harness.readProvider.waitForTransaction).not.toHaveBeenCalled()
    }
  )
})
