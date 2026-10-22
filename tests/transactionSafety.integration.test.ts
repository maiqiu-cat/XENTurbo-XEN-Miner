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
  vi.restoreAllMocks()
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
  expect(onStep.mock.lastCall?.[0]).toMatchObject({ send: 'error', confirm: 'wait' })
  expect(onStep.mock.lastCall?.[0].error).toContain(
    'MetaMask did not return a result within 2 minutes'
  )
  expect(onStep.mock.lastCall?.[0].logs.at(-1)).toMatchObject({ status: 'error' })
  return { prepared, onStep }
}

function mockRevertedReceipt(harness: Awaited<ReturnType<typeof installOfflineHarness>>) {
  const request = harness.request.getMockImplementation()!
  harness.request.mockImplementation(async (args) => {
    if (args.method === 'eth_getTransactionByHash') return null
    if (args.method === 'eth_getTransactionReceipt')
      return {
        transactionHash: HASH,
        from: WALLET,
        to: CONTRACTS.eth.factory,
        status: '0x0',
        blockNumber: '0x1',
        blockHash: `0x${'b'.repeat(64)}`
      }
    return request(args)
  })
}

describe('offline transaction safety integration (H-08)', () => {
  it.each([
    { late: false, cacheFails: false },
    { late: false, cacheFails: true },
    { late: true, cacheFails: false },
    { late: true, cacheFails: true }
  ])(
    'recovers a hash after journal reads fail (late=$late, cacheFails=$cacheFails)',
    async ({ late, cacheFails }) => {
      const harness = await installOfflineHarness()
      const prepared = late
        ? (await detachAtWalletTimeout(harness)).prepared
        : await harness.prepare()
      const sending = late ? null : harness.tx.sendPreparedOperation(prepared)
      const rejected = sending
        ? expect(sending).rejects.toThrow('PENDING_STORAGE_READ_FAILED')
        : null
      await vi.waitFor(() => expect(harness.sendRequests()).toHaveLength(1))
      const get = harness.storage.getItem.bind(harness.storage)
      const reads = vi.spyOn(harness.storage, 'getItem').mockImplementation((key) => {
        if (key.startsWith('sm.pendingOps.event.'))
          throw new DOMException('read denied', 'SecurityError')
        return get(key)
      })
      const set = vi.mocked(harness.storage.setItem).getMockImplementation()!
      if (cacheFails)
        vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
          if (key === 'sm.vmuLocks') throw new DOMException('cache unavailable', 'SecurityError')
          return set(key, value)
        })
      harness.walletResponse.resolve(HASH)
      await vi.advanceTimersByTimeAsync(0)
      if (rejected) await rejected
      expect(() => harness.pending.listPendingOps('eth', WALLET)).toThrow(
        'PENDING_STORAGE_READ_FAILED'
      )
      if (!cacheFails)
        expect(harness.locks.pendingLocks('eth', WALLET)[0]).toMatchObject({ txHash: HASH })
      reads.mockRestore()
      vi.mocked(harness.storage.setItem).mockImplementation(set)
      await harness.pending.refreshPendingOps('eth', WALLET)
      expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
        expect.objectContaining({ id: prepared.batch, txHash: HASH, phase: 'broadcast' })
      ])
      vi.resetModules()
      const reloaded = await import('@/core/pendingOps')
      expect(reloaded.listPendingOps('eth', WALLET)[0]).toMatchObject({ txHash: HASH })
      expect(reloaded.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
      expect(harness.sendRequests()).toHaveLength(1)
    }
  )

  it.each([false, true])(
    'persists settlement before deleting the sole reload recovery hash (journal fails: %s)',
    async (journalFails) => {
      const harness = await installOfflineHarness()
      harness.pending.recordPendingOp({
        id: 'recover',
        chain: 'eth',
        wallet: WALLET,
        op: 'CLAIM',
        ids: [1],
        count: 0,
        term: 0,
        txHash: '',
        phase: 'awaiting-wallet',
        nonce: NONCE
      })
      harness.locks.attachTxHash('recover', HASH, {
        chain: 'eth',
        wallet: WALLET,
        ids: [1],
        op: 'CLAIM'
      })
      mockRevertedReceipt(harness)
      vi.resetModules()
      const tx = await import('@/core/txManager')
      const pending = await import('@/core/pendingOps')
      const locks = await import('@/core/localLock')
      const set = vi.mocked(harness.storage.setItem).getMockImplementation()!
      if (journalFails) {
        vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
          if (key.startsWith('sm.pendingOps.event.'))
            throw new DOMException('journal full', 'QuotaExceededError')
          return set(key, value)
        })
        expect(await tx.resumePendingLocks('eth', WALLET)).toBe(false)
        expect(locks.pendingLocks('eth', WALLET)[0]).toMatchObject({ txHash: HASH })
        expect(pending.listPendingOps('eth', WALLET)[0]).toMatchObject({ phase: 'awaiting-wallet' })
        vi.mocked(harness.storage.setItem).mockImplementation(set)
      }
      expect(await tx.resumePendingLocks('eth', WALLET)).toBe(true)
      expect(pending.listPendingOps('eth', WALLET)).toEqual([
        expect.objectContaining({
          id: 'recover',
          txHash: HASH,
          phase: 'reverted',
          receipt: expect.objectContaining({ status: 0 })
        })
      ])
      expect(locks.pendingLocks('eth', WALLET)).toEqual([])
      expect(harness.sendRequests()).toHaveLength(0)
    }
  )

  it('retries terminal-lock cleanup after a temporary cache-write failure', async () => {
    const harness = await installOfflineHarness()
    harness.pending.recordPendingOp({
      id: 'settled',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [1],
      count: 0,
      term: 0,
      txHash: HASH,
      phase: 'broadcast',
      nonce: NONCE
    })
    mockRevertedReceipt(harness)
    const set = vi.mocked(harness.storage.setItem).getMockImplementation()!
    vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
      if (key === 'sm.vmuLocks') throw new DOMException('cache full', 'QuotaExceededError')
      return set(key, value)
    })
    expect((await harness.pending.refreshPendingOps('eth', WALLET)).unresolvedCount).toBe(0)
    expect(harness.pending.listPendingOps('eth', WALLET)[0].phase).toBe('reverted')
    expect(harness.locks.broadcastLockedIds('eth', WALLET)).toEqual(new Set([1]))
    vi.mocked(harness.storage.setItem).mockImplementation(set)
    await harness.pending.refreshPendingOps('eth', WALLET)
    expect(harness.locks.pendingLocks('eth', WALLET)).toEqual([])
    expect(harness.locks.broadcastLockedIds('eth', WALLET)).toEqual(new Set())
    expect(harness.sendRequests()).toHaveLength(0)
  })

  it.each(['GENERAL_MINT', 'CREATE_EMPTY_SLOT'] as const)(
    'recovers the hash of a lockless %s operation after journal failure and reload',
    async (op) => {
      const harness = await installOfflineHarness()
      const params = {
        id: 'lockless',
        chain: 'eth' as const,
        wallet: WALLET,
        op,
        ids: [],
        count: 1,
        term: 10,
        nonce: NONCE
      }
      harness.pending.recordPendingOp({ ...params, txHash: '', phase: 'awaiting-wallet' })
      const setItem = vi.mocked(harness.storage.setItem).getMockImplementation()!
      vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
        if (key.startsWith('sm.pendingOps.event.'))
          throw new DOMException('journal full', 'QuotaExceededError')
        return setItem(key, value)
      })
      expect(() =>
        harness.pending.recordPendingOp({ ...params, txHash: HASH, phase: 'broadcast' })
      ).toThrow('PENDING_STORAGE_WRITE_FAILED')
      expect(harness.locks.pendingLocks('eth', WALLET)).toEqual([
        expect.objectContaining({ batch: params.id, txHash: HASH, ids: [], op, count: 1 })
      ])
      expect(harness.pending.listPendingOps('eth', WALLET)[0]).toMatchObject({ txHash: HASH })
      vi.mocked(harness.storage.setItem).mockImplementation(setItem)
      vi.resetModules()
      const reloaded = await import('@/core/pendingOps')
      await reloaded.refreshPendingOps('eth', WALLET).catch(() => undefined)
      expect(reloaded.listPendingOps('eth', WALLET)).toEqual([
        expect.objectContaining({ id: params.id, txHash: HASH, op, count: 1 })
      ])
      expect(reloaded.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
      expect(harness.sendRequests()).toHaveLength(0)
    }
  )

  it('preserves duplicate evidence until the replacement journal event is saved', async () => {
    const harness = await installOfflineHarness()
    const record = {
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [1],
      count: 0,
      term: 0,
      txHash: HASH,
      phase: 'broadcast',
      origin: 'local',
      submittedAt: Date.now(),
      updatedAt: Date.now()
    }
    harness.storage.setItem(
      'sm.pendingOps',
      JSON.stringify([
        { ...record, id: 'first' },
        { ...record, id: 'second' }
      ])
    )
    expect(harness.pending.listPendingOps('eth', WALLET)).toHaveLength(2)
    const setItem = vi.mocked(harness.storage.setItem).getMockImplementation()!
    vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
      if (key.startsWith('sm.pendingOps.event.') && JSON.parse(value).record !== null)
        throw new DOMException('journal full', 'QuotaExceededError')
      return setItem(key, value)
    })
    expect(() =>
      harness.pending.recordPendingOp({
        id: 'first',
        chain: 'eth',
        wallet: WALLET,
        op: 'CLAIM',
        ids: [1],
        count: 0,
        term: 0,
        txHash: HASH,
        phase: 'broadcast'
      })
    ).toThrow('PENDING_STORAGE_WRITE_FAILED')
    expect(
      harness.pending
        .listPendingOps('eth', WALLET)
        .map((item) => item.id)
        .sort()
    ).toEqual(['first', 'second'])
  })

  it.each(['journal', 'both'] as const)(
    'shows a submitted transaction and preserves the pending gate when %s storage fails after a timely hash',
    async (failure) => {
      const harness = await installOfflineHarness()
      const prepared = await harness.prepare()
      const onStep = vi.fn()
      const sending = harness.tx.sendPreparedOperation(prepared, { onStep })
      const assertion = expect(sending).rejects.toThrow('PENDING_STORAGE_WRITE_FAILED')
      await vi.waitFor(() => expect(harness.sendRequests()).toHaveLength(1))
      const setItem = vi.mocked(harness.storage.setItem).getMockImplementation()!
      vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
        if (key.startsWith('sm.pendingOps.event.') || (failure === 'both' && key === 'sm.vmuLocks'))
          throw new DOMException('storage full', 'QuotaExceededError')
        return setItem(key, value)
      })

      harness.walletResponse.resolve(HASH)
      await assertion
      const state = onStep.mock.lastCall?.[0]
      expect(state).toMatchObject({
        txHash: HASH,
        send: 'done',
        confirm: 'error',
        walletPrompted: false
      })
      expect(state.error).toContain('Do not resend')
      expect(state.error).toContain('Do not clear')
      expect(state.error).toContain('Keep this page open')
      expect(state.logs.at(-1)).toMatchObject({ status: 'error' })
      expect(state.logs.some((entry: { status: string }) => entry.status === 'process')).toBe(false)
      expect(state.logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'done',
            message: expect.stringContaining('MetaMask request opened')
          }),
          expect.objectContaining({
            status: 'done',
            message: expect.stringContaining('Transaction submitted:')
          })
        ])
      )
      expect(harness.readProvider.waitForTransaction).not.toHaveBeenCalled()
      expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
      expect(harness.pending.listPendingOps('eth', WALLET)[0]).toMatchObject({
        id: prepared.batch,
        phase: 'broadcast',
        txHash: HASH
      })
      const persisted = Array.from({ length: harness.storage.length }, (_, i) =>
        harness.storage.key(i)
      )
        .filter((key): key is string => key?.startsWith('sm.pendingOps.event.') === true)
        .map((key) => JSON.parse(harness.storage.getItem(key)!))
      expect(persisted).toEqual([
        expect.objectContaining({
          record: expect.objectContaining({
            id: prepared.batch,
            phase: 'awaiting-wallet',
            txHash: ''
          })
        })
      ])
      if (failure === 'journal') {
        expect(harness.locks.pendingLocks('eth', WALLET)).toEqual([
          expect.objectContaining({ batch: prepared.batch, ids: [1], txHash: HASH, op: 'CLAIM' })
        ])
      }

      // A fresh attempt must still fail after the unsigned reservation expires.
      vi.mocked(harness.storage.setItem).mockImplementation(setItem)
      await vi.advanceTimersByTimeAsync(harness.tx.WALLET_RESPONSE_TIMEOUT_MS)
      if (failure === 'both') {
        const retry = await harness.prepare()
        await expect(harness.tx.sendPreparedOperation(retry)).rejects.toThrow(
          'LOCAL_PENDING_UNRESOLVED'
        )
      } else {
        await expect(harness.prepare()).rejects.toThrow()
      }
      expect(harness.sendRequests()).toHaveLength(1)
    }
  )

  it('continues confirmation after a timely hash when only the lock cache write fails', async () => {
    const harness = await installOfflineHarness()
    const prepared = await harness.prepare()
    const onStep = vi.fn()
    const sending = harness.tx.sendPreparedOperation(prepared, { onStep })
    const assertion = expect(sending).rejects.toThrow('Transaction receipt missing')
    await vi.waitFor(() => expect(harness.sendRequests()).toHaveLength(1))
    const setItem = vi.mocked(harness.storage.setItem).getMockImplementation()!
    vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
      if (key === 'sm.vmuLocks') throw new DOMException('lock storage full', 'QuotaExceededError')
      return setItem(key, value)
    })
    harness.walletResponse.resolve(HASH)
    await assertion
    expect(harness.readProvider.waitForTransaction).toHaveBeenCalledWith(
      HASH,
      1,
      expect.any(Number)
    )
    expect(onStep.mock.lastCall?.[0]).toMatchObject({ send: 'done', txHash: HASH })
    expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, txHash: HASH, phase: 'broadcast' })
    ])
    expect(harness.sendRequests()).toHaveLength(1)
  })

  it('actively releases a non-expired soft lock after late code-4001 rejection', async () => {
    // Advance timeout timers without advancing the lock's wall clock.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = await installOfflineHarness()
    const { prepared } = await detachAtWalletTimeout(harness)
    expect(Date.now()).toBe(now)
    expect(harness.locks.lockedIds('eth', WALLET)).toEqual(new Set([1]))
    harness.locks.tryAcquireLock({ chain: 'eth', wallet: OTHER_WALLET, ids: [1], batch: 'other' })
    harness.walletResponse.reject(harness.userRejection)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.locks.lockedIds('eth', WALLET)).toEqual(new Set())
    expect(harness.locks.lockedIds('eth', OTHER_WALLET)).toEqual(new Set([1]))
    expect(harness.pending.listPendingOps('eth', WALLET)[0]).toMatchObject({
      id: prepared.batch,
      phase: 'dropped'
    })
    expect(harness.activeLocks.size).toBe(0)
    expect(harness.sendRequests()).toHaveLength(1)
  })

  it('persists a late hash across reload and blocks a queued resend', async () => {
    const harness = await installOfflineHarness()
    const { prepared, onStep } = await detachAtWalletTimeout(harness)
    const notifications = onStep.mock.calls.length
    expect(harness.locks.lockedIds('eth', WALLET).size).toBe(0)
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
    expect(harness.locks.pendingLocks('eth', WALLET)).toEqual([
      expect.objectContaining({ batch: prepared.batch, txHash: HASH, ids: [1] })
    ])
    expect(harness.locks.broadcastLockedIds('eth', WALLET)).toEqual(new Set([1]))
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
    const reloadedLocks = await import('@/core/localLock')
    expect(reloaded.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
    expect(reloaded.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, phase: 'broadcast', txHash: HASH })
    ])
    expect(harness.sendRequests()).toHaveLength(1)
    expect(reloadedLocks.broadcastLockedIds('eth', WALLET)).toEqual(new Set([1]))
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

  it('persists a late broadcast hash even when the VMU lock cache cannot be written', async () => {
    const harness = await installOfflineHarness()
    const { prepared } = await detachAtWalletTimeout(harness)
    const setItem = vi.mocked(harness.storage.setItem).getMockImplementation()!
    vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
      if (key === 'sm.vmuLocks') throw new DOMException('lock storage full', 'QuotaExceededError')
      return setItem(key, value)
    })
    harness.walletResponse.resolve(HASH)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, txHash: HASH, phase: 'broadcast' })
    ])
    expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
    expect(harness.sendRequests()).toHaveLength(1)
  })

  it('retains the unresolved request if journal persistence fails after a real hash arrives', async () => {
    const harness = await installOfflineHarness()
    const { prepared } = await detachAtWalletTimeout(harness)
    const setItem = vi.mocked(harness.storage.setItem).getMockImplementation()!
    vi.mocked(harness.storage.setItem).mockImplementation((key, value) => {
      if (key.startsWith('sm.pendingOps.event.'))
        throw new DOMException('journal full', 'QuotaExceededError')
      return setItem(key, value)
    })
    harness.walletResponse.resolve(HASH)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.pending.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, txHash: HASH, phase: 'broadcast' })
    ])
    expect(harness.pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
    expect(harness.sendRequests()).toHaveLength(1)
    expect(harness.locks.pendingLocks('eth', WALLET)).toEqual([
      expect.objectContaining({ batch: prepared.batch, txHash: HASH, ids: [1] })
    ])

    vi.mocked(harness.storage.setItem).mockImplementation(setItem)
    vi.resetModules()
    const reloaded = await import('@/core/pendingOps')
    // Hydration runs before network reconciliation; the offline wallet has no receipt methods.
    await reloaded.refreshPendingOps('eth', WALLET).catch(() => undefined)
    expect(reloaded.listPendingOps('eth', WALLET)).toEqual([
      expect.objectContaining({ id: prepared.batch, phase: 'broadcast', txHash: HASH })
    ])
    expect(reloaded.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
  })

  it.each(['corrupt event', 'read failure'] as const)(
    'blocks sending without deleting evidence after a journal %s',
    async (failure) => {
      const harness = await installOfflineHarness()
      const prepared = await harness.prepare()
      const key = 'sm.pendingOps.event.unreadable'
      harness.storage.setItem(key, '{invalid')
      const get = harness.storage.getItem.bind(harness.storage)
      if (failure === 'read failure')
        vi.spyOn(harness.storage, 'getItem').mockImplementation((name) => {
          if (name === key) throw new DOMException('read denied', 'SecurityError')
          return get(name)
        })
      const onStep = vi.fn()
      await expect(harness.tx.sendPreparedOperation(prepared, { onStep })).rejects.toThrow(
        'PENDING_STORAGE_READ_FAILED'
      )
      expect(harness.sendRequests()).toHaveLength(0)
      expect(get(key)).toBe('{invalid')
      expect(onStep.mock.lastCall?.[0].error).toContain('Do not clear')
    }
  )
})
