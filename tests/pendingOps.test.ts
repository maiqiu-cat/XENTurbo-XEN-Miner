import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Interface } from 'ethers'
import { CHAINS } from '../src/config/chains'
import { CONTRACTS } from '../src/config/contracts'

const WALLET = '0x00000000000000000000000000000000000000ab'
const HASH = `0x${'1'.repeat(64)}`

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

async function installPendingHarness(options: {
  latestNonce: number
  pendingNonce: number
  receipt?: { status: number } | null
  transaction?: {
    from: string
    to: string
    data: string
    nonce: number
  } | null
}) {
  const provider = {
    getTransactionCount: vi.fn(async (_wallet: string, tag: 'latest' | 'pending') =>
      tag === 'latest' ? options.latestNonce : options.pendingNonce
    ),
    getTransactionReceipt: vi.fn(async () => options.receipt ?? null),
    getTransaction: vi.fn(async () => options.transaction ?? null)
  }
  const releaseLocksByTxHash = vi.fn()
  const releaseLock = vi.fn()
  const attachTxHash = vi.fn()

  vi.doMock('../src/core/rpc', () => ({ getReadProvider: () => provider }))
  vi.doMock('../src/core/localLock', () => ({
    attachTxHash,
    pendingLocks: vi.fn(() => []),
    releaseLock,
    releaseLocksByTxHash
  }))

  const pending = await import('../src/core/pendingOps')
  return { pending, provider, attachTxHash, releaseLock, releaseLocksByTxHash }
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
    const data = new Interface([
      'function bulkClaimMintReward(uint256[] ids)'
    ]).encodeFunctionData('bulkClaimMintReward', [[7n]])
    const { pending, attachTxHash } = await installPendingHarness({
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
  })

  it('uses the wallet address explorer URL when a record has no transaction hash', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 7, pendingNonce: 7 })
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
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
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
    vi.stubGlobal(
      'localStorage',
      createStorage({ 'sm.pendingOps': JSON.stringify([oldRecord]) })
    )
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
      getFeeData: vi.fn(async () => ({
        maxFeePerGas: 20n,
        maxPriorityFeePerGas: 3n,
        gasPrice: 10n
      })),
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
          throw new Error(`Unexpected method: ${method}`)
        }
      }
    })
    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory: vi.fn(async () => HASH)
    }))
    vi.doMock('../src/core/rpc', () => ({ getReadProvider: () => provider }))
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
    const send = sendPreparedOperation({
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      chainId: 1,
      factoryAddress: '0x0000000000000000000000000000000000000001',
      gasLimit: 100_000n,
      fnName: 'bulkClaimMintReward',
      args: [[7n]],
      batch: 'batch-1',
      lockIds: [7],
      state: { estimate: 'done', send: 'wait', confirm: 'wait' },
      nonce: 7,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n
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
