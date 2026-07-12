import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Interface } from 'ethers'
import { CHAINS } from '../src/config/chains'
import { CONTRACTS } from '../src/config/contracts'

const WALLET = '0x00000000000000000000000000000000000000ab'
const HASH = `0x${'1'.repeat(64)}`

type PendingTransaction = {
  from: string
  to: string
  data: string
  nonce: number
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  }
}

function createInterleavingStorage(): {
  storage: Storage
  interceptNextWrite(effect: () => void): void
} {
  const base = createStorage()
  let nextEffect: (() => void) | null = null
  let runningEffect = false
  return {
    storage: {
      get length() {
        return base.length
      },
      clear: () => base.clear(),
      getItem: (key) => base.getItem(key),
      key: (index) => base.key(index),
      removeItem: (key) => base.removeItem(key),
      setItem(key, value) {
        const effect = nextEffect
        if (effect && !runningEffect) {
          nextEffect = null
          runningEffect = true
          effect()
          runningEffect = false
        }
        base.setItem(key, value)
      }
    },
    interceptNextWrite(effect) {
      nextEffect = effect
    }
  }
}

async function installPendingHarness(options: {
  latestNonce: number
  pendingNonce: number
  receipt?: { status: number } | null
  transaction?: PendingTransaction | null | Promise<PendingTransaction | null>
  pendingBlock?: { transactions: unknown[] }
}) {
  const provider = {
    getTransactionCount: vi.fn(async (_wallet: string, tag: 'latest' | 'pending') =>
      tag === 'latest' ? options.latestNonce : options.pendingNonce
    ),
    getTransactionReceipt: vi.fn(async () => options.receipt ?? null),
    getTransaction: vi.fn(async () => await (options.transaction ?? null)),
    send: vi.fn(async (method: string) => {
      if (method !== 'eth_getBlockByNumber') throw new Error(`Unexpected method ${method}`)
      return options.pendingBlock ?? { transactions: [] }
    })
  }
  const releaseLocksByTxHash = vi.fn()
  const releaseLock = vi.fn()
  const attachTxHash = vi.fn()

  const ensureHealthyReadProvider = vi.fn(async () => provider)
  vi.doMock('../src/core/rpc', () => ({
    ensureHealthyReadProvider,
    getReadProvider: () => provider
  }))
  vi.doMock('../src/core/localLock', () => ({
    attachTxHash,
    pendingLocks: vi.fn(() => []),
    releaseLock,
    releaseLocksByTxHash
  }))

  const pending = await import('../src/core/pendingOps')
  return {
    pending,
    provider,
    ensureHealthyReadProvider,
    attachTxHash,
    releaseLock,
    releaseLocksByTxHash
  }
}

function recordBroadcast(
  pending: typeof import('../src/core/pendingOps'),
  overrides: Partial<Parameters<typeof pending.recordPendingOp>[0]> = {}
) {
  return pending.recordPendingOp({
    chain: 'eth',
    wallet: WALLET,
    op: 'CLAIM',
    ids: [7],
    count: 0,
    term: 0,
    txHash: HASH,
    nonce: 7,
    phase: 'broadcast',
    submittedAt: Date.now() - 2 * 60 * 60 * 1000,
    ...overrides
  })
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('pending operation reconciliation', () => {
  it('persists awaiting-wallet and upgrades the same operation after broadcast', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 7, pendingNonce: 7 })

    const awaiting = pending.recordPendingOp({
      id: 'batch-1',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: '',
      nonce: 7,
      phase: 'awaiting-wallet'
    })
    const broadcast = pending.recordPendingOp({
      id: 'batch-1',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: HASH,
      nonce: 7,
      phase: 'broadcast'
    })

    expect(awaiting.phase).toBe('awaiting-wallet')
    expect(broadcast).toMatchObject({ id: 'batch-1', txHash: HASH, nonce: 7, phase: 'broadcast' })
    expect(pending.listPendingOps('eth', WALLET)).toHaveLength(1)
  })

  it('coalesces a tracked hash into the awaiting-wallet record with the same nonce', async () => {
    const data = new Interface(['function bulkClaimMintReward(uint256[] ids)']).encodeFunctionData(
      'bulkClaimMintReward',
      [[7n]]
    )
    const { pending, ensureHealthyReadProvider, attachTxHash } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 8,
      receipt: null,
      transaction: {
        from: WALLET,
        to: CONTRACTS.eth.factory,
        data,
        nonce: 7
      }
    })
    pending.recordPendingOp({
      id: 'batch-1',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: '',
      nonce: 7,
      phase: 'awaiting-wallet'
    })

    const tracked = await pending.trackPendingTxHash('eth', WALLET, HASH)
    const stored = pending.listPendingOps('eth', WALLET)

    expect(tracked).toMatchObject({ id: 'batch-1', txHash: HASH, nonce: 7, phase: 'broadcast' })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: 'batch-1', txHash: HASH, nonce: 7 })
    expect(attachTxHash).toHaveBeenCalledWith('batch-1', HASH)
    expect(ensureHealthyReadProvider).toHaveBeenCalledWith('eth')
  })

  it('uses the wallet address explorer URL when a record has no transaction hash', async () => {
    const { pending, ensureHealthyReadProvider } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 7
    })
    pending.recordPendingOp({
      id: 'batch-1',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: '',
      nonce: 7,
      phase: 'awaiting-wallet'
    })

    const result = await pending.refreshPendingOps('eth', WALLET)

    expect(ensureHealthyReadProvider).toHaveBeenCalledWith('eth')
    expect(result.views[0].explorerUrl).toBe(`${CHAINS.eth.blockExplorerUrl}/address/${WALLET}`)
    expect(result.views[0].explorerUrl).not.toContain('/tx/')
  })

  it('allows manual drop only for a real unresolved unknown record', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 7, pendingNonce: 7 })

    expect(
      pending.canMarkPendingOpDropped({
        id: 'batch-1',
        phase: 'awaiting-wallet',
        status: 'unknown'
      })
    ).toBe(true)
    expect(
      pending.canMarkPendingOpDropped({
        id: 'batch-1',
        phase: 'awaiting-wallet',
        status: 'pending'
      })
    ).toBe(false)
    expect(
      pending.canMarkPendingOpDropped({
        id: 'unknown-pending',
        phase: 'broadcast',
        status: 'unknown'
      })
    ).toBe(false)
    expect(
      pending.canMarkPendingOpDropped({
        id: 'batch-1',
        phase: 'confirmed',
        status: 'unknown'
      })
    ).toBe(false)
  })

  it('marks a successful receipt confirmed and releases its VMU lock', async () => {
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      receipt: { status: 1 }
    })
    recordBroadcast(pending)

    const result = await pending.refreshPendingOps('eth', WALLET)
    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored.phase).toBe('confirmed')
    expect(stored.updatedAt).toBeGreaterThan(stored.submittedAt)
    expect(result.unresolvedCount).toBe(0)
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH)
  })

  it('marks a reverted receipt reverted and releases its VMU lock', async () => {
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      receipt: { status: 0 }
    })
    recordBroadcast(pending)

    const result = await pending.refreshPendingOps('eth', WALLET)
    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored.phase).toBe('reverted')
    expect(result.unresolvedCount).toBe(0)
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH)
  })

  it('keeps a missing transaction unresolved while pending nonce covers its nonce', async () => {
    const { pending, provider, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 8,
      receipt: null,
      transaction: null
    })
    recordBroadcast(pending)

    const result = await pending.refreshPendingOps('eth', WALLET)
    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored.phase).toBe('broadcast')
    expect(result.pendingNonceGap).toBe(1)
    expect(result.unresolvedCount).toBe(1)
    expect(result.views).toHaveLength(1)
    expect(releaseLocksByTxHash).not.toHaveBeenCalled()
    expect(provider.send).not.toHaveBeenCalled()
  })

  it('throttles pending-block discovery for an unexplained nonce gap', async () => {
    const { pending, provider } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 8,
      pendingBlock: { transactions: [] }
    })

    await pending.refreshPendingOps('eth', WALLET)
    await pending.refreshPendingOps('eth', WALLET)

    expect(provider.send).toHaveBeenCalledTimes(1)
  })

  it('marks a missing hash replaced after the confirmed account nonce advances', async () => {
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      receipt: null,
      transaction: null
    })
    recordBroadcast(pending)

    const result = await pending.refreshPendingOps('eth', WALLET)
    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored.phase).toBe('replaced')
    expect(result.unresolvedCount).toBe(0)
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH)
  })

  it('does not infer dropped from one temporarily lower pending nonce', async () => {
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 7,
      receipt: null,
      transaction: null
    })
    recordBroadcast(pending)

    const result = await pending.refreshPendingOps('eth', WALLET)
    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored.phase).toBe('broadcast')
    expect(result.pendingNonceGap).toBe(0)
    expect(result.unresolvedCount).toBe(1)
    expect(result.views).toHaveLength(1)
    expect(result.views[0].status).toBe('unknown')
    expect(releaseLocksByTxHash).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer terminal record when an older refresh finishes', async () => {
    const transaction = deferred<PendingTransaction | null>()
    const { pending, provider } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 7,
      receipt: null,
      transaction: transaction.promise
    })
    recordBroadcast(pending, { id: 'batch-1' })

    const refresh = pending.refreshPendingOps('eth', WALLET)
    await vi.waitFor(() => expect(provider.getTransaction).toHaveBeenCalledOnce())
    expect(pending.markPendingOpDropped('batch-1')?.phase).toBe('dropped')

    transaction.resolve(null)
    const result = await refresh
    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored.phase).toBe('dropped')
    expect(result.unresolvedCount).toBe(0)
    expect(result.views).toHaveLength(0)
  })

  it('preserves a concurrent record written between refresh read and persistence', async () => {
    const interleaving = createInterleavingStorage()
    vi.stubGlobal('localStorage', interleaving.storage)
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      receipt: { status: 1 },
      transaction: null
    })
    recordBroadcast(pending, { id: 'batch-1' })
    const concurrentHash = `0x${'2'.repeat(64)}`
    interleaving.interceptNextWrite(() => {
      pending.recordPendingOp({
        id: 'batch-2',
        chain: 'eth',
        wallet: WALLET,
        op: 'CLAIM',
        ids: [8],
        count: 0,
        term: 0,
        txHash: concurrentHash,
        nonce: 8,
        phase: 'broadcast'
      })
    })

    await pending.refreshPendingOps('eth', WALLET)

    expect(pending.listPendingOps('eth', WALLET).map((record) => record.id)).toContain('batch-2')
  })

  it('migrates old records conservatively instead of deleting them by age', async () => {
    const oldRecord = {
      id: 'old-record',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: HASH,
      submittedAt: Date.now() - 7 * 24 * 60 * 60 * 1000
    }
    vi.stubGlobal('localStorage', createStorage({ 'sm.pendingOps': JSON.stringify([oldRecord]) }))
    const { pending } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 7,
      receipt: null,
      transaction: null
    })

    const stored = pending.listPendingOps('eth', WALLET)[0]

    expect(stored).toMatchObject({
      id: 'old-record',
      nonce: null,
      phase: 'broadcast',
      updatedAt: oldRecord.submittedAt
    })
  })

  it('retains unresolved records but bounds terminal history to 50 records and 7 days', async () => {
    const now = Date.now()
    const terminal = Array.from({ length: 55 }, (_, index) => ({
      id: `terminal-${index}`,
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [index + 1],
      count: 0,
      term: 0,
      txHash: `0x${(index + 2).toString(16).padStart(64, '0')}`,
      nonce: index,
      phase: 'confirmed',
      submittedAt: now - index * 1_000,
      updatedAt: now - index * 1_000
    }))
    const unresolved = {
      ...terminal[0],
      id: 'unresolved-old',
      txHash: HASH,
      phase: 'broadcast',
      updatedAt: now - 30 * 24 * 60 * 60 * 1_000
    }
    const expired = {
      ...terminal[0],
      id: 'expired-terminal',
      txHash: `0x${'f'.repeat(64)}`,
      updatedAt: now - 8 * 24 * 60 * 60 * 1_000
    }
    vi.stubGlobal(
      'localStorage',
      createStorage({ 'sm.pendingOps': JSON.stringify([...terminal, unresolved, expired]) })
    )
    const { pending } = await installPendingHarness({ latestNonce: 0, pendingNonce: 0 })

    const stored = pending.listPendingOps('eth', WALLET)

    expect(stored.filter((record) => record.phase === 'confirmed')).toHaveLength(50)
    expect(stored.some((record) => record.id === 'unresolved-old')).toBe(true)
    expect(stored.some((record) => record.id === 'expired-terminal')).toBe(false)
  })

  it('supports an explicit dropped transition and only then releases the lock', async () => {
    const { pending, releaseLock, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 7
    })
    recordBroadcast(pending, { id: 'batch-1' })

    const dropped = pending.markPendingOpDropped('batch-1')

    expect(dropped?.phase).toBe('dropped')
    expect(releaseLock).toHaveBeenCalledWith('batch-1')
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH)
  })

  it('refuses to downgrade a record that another tab already resolved', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 8, pendingNonce: 8 })
    recordBroadcast(pending, { id: 'batch-1' })
    pending.recordPendingOp({
      id: 'batch-1',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: HASH,
      nonce: 7,
      phase: 'confirmed'
    })

    expect(pending.markPendingOpDropped('batch-1')).toBeNull()
    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('confirmed')
  })

  it('does not downgrade a confirmed record when a late broadcast event arrives', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 8, pendingNonce: 8 })
    recordBroadcast(pending, { id: 'batch-1', phase: 'confirmed' })

    recordBroadcast(pending, { id: 'batch-1', phase: 'broadcast' })

    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('confirmed')
  })
})

describe('broadcast VMU locks', () => {
  it('does not expire a broadcast lock based on elapsed time alone', async () => {
    vi.resetModules()
    vi.doUnmock('../src/core/localLock')
    const oldLock = {
      chain: 'eth',
      wallet: WALLET,
      ids: [7],
      txHash: HASH,
      batch: 'batch-1',
      lockedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
      op: 'CLAIM'
    }
    vi.stubGlobal('localStorage', createStorage({ 'sm.vmuLocks': JSON.stringify([oldLock]) }))

    const locks = await import('../src/core/localLock')

    expect(locks.pendingLocks('eth', WALLET)).toHaveLength(1)
    expect(locks.broadcastLockedIds('eth', WALLET)).toEqual(new Set([7]))
  })
})

describe('transaction lock lifecycle', () => {
  it('keeps the broadcast lock when confirmation has no receipt', async () => {
    vi.resetModules()
    const releaseLock = vi.fn()
    const attachTxHash = vi.fn()
    const recordPendingOp = vi.fn()
    const provider = {
      getTransactionCount: vi.fn(async () => 7),
      waitForTransaction: vi.fn(async () => null)
    }

    vi.stubGlobal('navigator', {
      locks: { request: async (_key: string, work: () => Promise<unknown>) => work() }
    })
    vi.stubGlobal('window', {
      ethereum: {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_accounts') return [WALLET]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getTransactionCount') return '0x7'
          if (method === 'eth_call') return '0x'
          throw new Error(`Unexpected method: ${method}`)
        }
      }
    })
    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory: vi.fn(async (params: { onRequestStart?: () => void }) => {
        params.onRequestStart?.()
        return HASH
      })
    }))
    vi.doMock('../src/core/rpc', () => ({
      ensureHealthyReadProvider: vi.fn(async () => provider),
      getReadProvider: () => provider
    }))
    vi.doMock('../src/core/chainReader', () => ({
      readFee: vi.fn(),
      readVmuStatuses: vi.fn(async () => new Map([[7, 'CLAIMABLE']]))
    }))
    vi.doMock('../src/core/localLock', () => ({
      attachTxHash,
      releaseLock,
      newBatchId: vi.fn(),
      pendingLocks: vi.fn(() => []),
      tryAcquireLock: vi.fn(),
      clearSoftLocks: vi.fn()
    }))
    vi.doMock('../src/core/pendingOps', () => ({
      countUnresolvedPendingOps: vi.fn(() => 0),
      recordPendingOp
    }))

    const { sendPreparedOperation } = await import('../src/core/txManager')
    const preparedAt = Date.now()
    const send = sendPreparedOperation({
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      chainId: 1,
      factoryAddress: '0x0000000000000000000000000000000000000001',
      contextKey: `1:${WALLET.toLowerCase()}`,
      preparedAt,
      expiresAt: preparedAt + 120_000,
      gasLimit: 100_000n,
      fnName: 'bulkClaimMintReward',
      args: [[7n]],
      batch: 'batch-1',
      lockIds: [7],
      state: { estimate: 'done', send: 'wait', confirm: 'wait' }
    })

    await expect(send).rejects.toThrow('Transaction receipt missing')
    expect(attachTxHash).toHaveBeenCalledWith('batch-1', HASH)
    expect(recordPendingOp).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'batch-1',
        txHash: '',
        nonce: 7,
        phase: 'awaiting-wallet'
      })
    )
    expect(recordPendingOp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ txHash: HASH, nonce: 7, phase: 'broadcast' })
    )
    expect(releaseLock).not.toHaveBeenCalled()
  })
})
