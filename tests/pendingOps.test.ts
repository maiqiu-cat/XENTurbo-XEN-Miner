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
  receipt?: { status: number } | null | (() => Promise<{ status: number } | null>)
  transaction?: PendingTransaction | null | Promise<PendingTransaction | null>
  pendingBlock?: { transactions: unknown[] }
  walletReceipt?: { status: number } | null
  walletLatestNonce?: number
  walletTransaction?: PendingTransaction | null
  switchAndReturnDuringNonce?: boolean
}) {
  const walletListeners = new Map<string, (...args: unknown[]) => void>()
  const provider = {
    getTransactionCount: vi.fn(async (_wallet: string, tag: 'latest' | 'pending') =>
      tag === 'latest' ? options.latestNonce : options.pendingNonce
    ),
    getTransactionReceipt: vi.fn(async () =>
      typeof options.receipt === 'function' ? options.receipt() : (options.receipt ?? null)
    ),
    getTransaction: vi.fn(async () => await (options.transaction ?? null)),
    send: vi.fn(async (method: string) => {
      if (method !== 'eth_getBlockByNumber') throw new Error(`Unexpected method ${method}`)
      return options.pendingBlock ?? { transactions: [] }
    })
  }
  const releaseLocksByTxHash = vi.fn()
  const releaseLock = vi.fn()
  const attachTxHash = vi.fn()
  vi.stubGlobal('window', {
    ethereum: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
        walletListeners.set(event, listener)
      ),
      removeListener: vi.fn((event: string) => walletListeners.delete(event)),
      request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getTransactionCount') {
          if (options.switchAndReturnDuringNonce) {
            walletListeners.get('chainChanged')?.('0x89')
            walletListeners.get('chainChanged')?.('0x1')
          }
          return `0x${(params?.[1] === 'latest' ? (options.walletLatestNonce ?? options.latestNonce) : options.pendingNonce).toString(16)}`
        }
        if (method === 'eth_getTransactionByHash') {
          const tx = Object.hasOwn(options, 'walletTransaction')
            ? options.walletTransaction
            : await provider.getTransaction()
          return tx
            ? { ...tx, hash: params?.[0], input: tx.data, nonce: `0x${tx.nonce.toString(16)}` }
            : null
        }
        if (method === 'eth_getTransactionReceipt') {
          const receipt = Object.hasOwn(options, 'walletReceipt')
            ? options.walletReceipt
            : await provider.getTransactionReceipt()
          return receipt
            ? {
                transactionHash: params?.[0],
                from: WALLET,
                to: CONTRACTS.eth.factory,
                status: `0x${receipt.status.toString(16)}`,
                blockNumber: '0x1',
                blockHash: `0x${'b'.repeat(64)}`
              }
            : null
        }
        throw new Error(`Unexpected wallet method ${method}`)
      })
    }
  })

  const ensureHealthyReadProvider = vi.fn(async () => provider)
  vi.doMock('../src/core/rpc', () => ({
    ensureHealthyReadProvider,
    ensureRecentReadProvider: ensureHealthyReadProvider,
    getReadProvider: () => provider
  }))
  vi.doMock('../src/core/localLock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/core/localLock')>()),
    attachTxHash,
    pendingLocks: vi.fn(() => []),
    releaseLock,
    releaseLocksByTxHash,
    clearSoftLocks: vi.fn()
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
  it.each([null, { status: 1 }])(
    'legacy lock recovery requires wallet receipt evidence',
    async (walletReceipt) => {
      const { pending, releaseLock } = await installPendingHarness({
        latestNonce: 7,
        pendingNonce: 8,
        receipt: { status: 1 },
        walletReceipt
      })
      const locks = await import('../src/core/localLock')
      vi.mocked(locks.pendingLocks).mockReturnValue([
        {
          batch: 'old-lock',
          chain: 'eth',
          wallet: WALLET,
          txHash: HASH,
          ids: [7],
          lockedAt: Date.now()
        }
      ])
      const { resumePendingLocks } = await import('../src/core/txManager')
      expect(await resumePendingLocks('eth', WALLET)).toBe(walletReceipt !== null)
      if (walletReceipt) {
        expect(releaseLock).toHaveBeenCalledWith(
          'old-lock',
          expect.objectContaining({
            chain: 'eth',
            wallet: WALLET,
            txHash: HASH,
            phase: 'confirmed'
          })
        )
        expect(pending.listPendingOps('eth', WALLET)[0]).toMatchObject({
          id: 'old-lock',
          txHash: HASH,
          phase: 'confirmed',
          origin: 'wallet-verified'
        })
      } else expect(releaseLock).not.toHaveBeenCalled()
    }
  )

  it('rejects replacement evidence when the wallet switches networks and switches back', async () => {
    await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      switchAndReturnDuringNonce: true
    })
    const { readWalletEvidence } = await import('../src/core/walletEvidence')
    await expect(
      readWalletEvidence('eth', WALLET, HASH, { nonce: 7, nonceAuthoritative: true })
    ).rejects.toThrow('WALLET_CONTEXT_CHANGED')
  })

  it('does not treat a requested but unobserved transaction nonce as replacement proof', async () => {
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 9
    })
    recordBroadcast(pending, { nonceAuthoritative: false })
    await pending.refreshPendingOps('eth', WALLET)
    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('broadcast')
    expect(releaseLocksByTxHash).not.toHaveBeenCalled()
  })

  it('reauthenticates old RPC-settled terminal records before tracking can release their locks', async () => {
    const old = {
      id: 'old-unverified',
      chain: 'eth',
      wallet: WALLET,
      op: 'CLAIM',
      ids: [7],
      count: 0,
      term: 0,
      txHash: HASH,
      nonce: 7,
      phase: 'confirmed',
      submittedAt: Date.now(),
      updatedAt: Date.now()
    }
    vi.stubGlobal('localStorage', createStorage({ 'sm.pendingOps': JSON.stringify([old]) }))
    const iface = new Interface(['function bulkClaimMintReward(uint256[] ids)'])
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 8,
      walletReceipt: null,
      walletTransaction: {
        from: WALLET,
        to: CONTRACTS.eth.factory,
        data: iface.encodeFunctionData('bulkClaimMintReward', [[7]]),
        nonce: 7
      }
    })
    expect(pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
    await pending.trackPendingTxHash('eth', WALLET, HASH)
    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('broadcast')
    expect(releaseLocksByTxHash).not.toHaveBeenCalled()
  })

  it('restores confirmed result warnings and only revalidates them on explicit recheck', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 }
    })
    const { readWalletEvidence } = await import('../src/core/walletEvidence')
    const { settlement } = await readWalletEvidence('eth', WALLET, HASH)
    recordBroadcast(pending, { phase: 'confirmed', settlement, beforeRanks: { 7: 100 } })
    const result = await pending.refreshPendingOps('eth', WALLET)
    expect(result.unresolvedCount).toBe(0)
    expect(result.views[0].status).toBe('confirmed')
    expect(result.views[0].detail).toContain('result verification incomplete')
    expect(pending.listPendingOps('eth', WALLET)[0].beforeRanks).toEqual({ 7: 100 })
  })

  it('does not settle or unlock from a public-only receipt or advanced nonce', async () => {
    const { pending, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletLatestNonce: 7,
      receipt: { status: 1 },
      walletReceipt: null
    })
    recordBroadcast(pending)
    await pending.refreshPendingOps('eth', WALLET)
    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('broadcast')
    expect(releaseLocksByTxHash).not.toHaveBeenCalled()
  })

  it('rejects terminal phases without opaque wallet evidence at the shared write boundary', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 7, pendingNonce: 7 })
    recordBroadcast(pending)
    expect(() =>
      recordBroadcast(pending, {
        phase: 'confirmed',
        settlement: { chain: 'eth', wallet: WALLET, txHash: HASH, nonce: 7, phase: 'confirmed' }
      })
    ).toThrow('WALLET_EVIDENCE_REQUIRED')
    expect(pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
  })

  it('does not promote forged remote discovery candidates to permanent blockers', async () => {
    const data = new Interface(['function bulkClaimMintReward(uint256[] ids)']).encodeFunctionData(
      'bulkClaimMintReward',
      [[7n]]
    )
    const { pending } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 8,
      walletTransaction: null,
      pendingBlock: {
        transactions: [
          { hash: HASH, from: WALLET, to: CONTRACTS.eth.factory, input: data, nonce: '0x7' }
        ]
      }
    })
    const result = await pending.refreshPendingOps('eth', WALLET)
    expect(result.pendingNonceGap).toBe(1)
    expect(result.views[0].id).toBe('unknown-pending')
    expect(pending.listPendingOps('eth', WALLET)).toEqual([])
  })

  it('does not remove a manually tracked record based on a forged public receipt', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 7,
      pendingNonce: 8,
      receipt: { status: 1 },
      walletReceipt: null,
      walletTransaction: null
    })
    recordBroadcast(pending)
    await expect(pending.trackPendingTxHash('eth', WALLET, HASH)).rejects.toThrow(
      'Transaction not found through the wallet'
    )
    expect(pending.countUnresolvedPendingOps('eth', WALLET)).toBe(1)
  })

  it('does not treat an unauthenticated legacy nonce as replacement evidence', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 8, pendingNonce: 8 })
    recordBroadcast(pending, { origin: 'legacy-unknown', nonceAuthoritative: false })
    await pending.refreshPendingOps('eth', WALLET)
    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('broadcast')
  })

  it('bounds calldata and rejects unsafe or duplicate ids', async () => {
    const { pending } = await installPendingHarness({ latestNonce: 0, pendingNonce: 0 })
    const iface = new Interface(['function bulkClaimMintReward(uint256[] ids)'])
    for (const ids of [
      [1n, 1n],
      [2n ** 60n],
      [0n],
      Array.from({ length: 1_001 }, (_, index) => BigInt(index + 1))
    ]) {
      expect(
        pending.decodeFactoryCalldata(iface.encodeFunctionData('bulkClaimMintReward', [ids]))
      ).toBeNull()
    }
  })

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

  it('keeps a tracked hash separate from an unsigned request with the same nonce', async () => {
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
      phase: 'awaiting-wallet',
      nonceAuthoritative: false
    })

    const tracked = await pending.trackPendingTxHash('eth', WALLET, HASH)
    const stored = pending.listPendingOps('eth', WALLET)

    expect(tracked.id).not.toBe('batch-1')
    expect(tracked).toMatchObject({ txHash: HASH, nonce: 7, phase: 'broadcast' })
    expect(stored).toHaveLength(2)
    expect(stored.find((record) => record.id === 'batch-1')).toMatchObject({
      txHash: '',
      phase: 'awaiting-wallet'
    })
    expect(attachTxHash).toHaveBeenCalledWith(
      tracked.id,
      HASH,
      expect.objectContaining({ chain: 'eth', wallet: WALLET, ids: [7] })
    )
    pending.recordPendingOp({
      ...stored.find((record) => record.id === 'batch-1')!,
      phase: 'dropped'
    })
    expect(
      pending.listPendingOps('eth', WALLET).find((record) => record.txHash === HASH)?.phase
    ).toBe('broadcast')
    expect(ensureHealthyReadProvider).toHaveBeenCalledWith('eth')
  })

  it('keeps a receipt-only authenticated legacy record terminal after subsequent storage reads', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 },
      walletTransaction: null
    })
    recordBroadcast(pending, { origin: 'legacy-unknown', nonceAuthoritative: false })
    await pending.refreshPendingOps('eth', WALLET)
    expect(pending.listPendingOps('eth', WALLET)[0]).toMatchObject({
      phase: 'confirmed',
      origin: 'wallet-verified'
    })
    expect((await pending.refreshPendingOps('eth', WALLET)).unresolvedCount).toBe(0)
  })

  it('does not verify cached operation metadata when only a wallet receipt is available', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 },
      walletTransaction: null
    })
    recordBroadcast(pending, { ids: [], origin: 'legacy-unknown', nonceAuthoritative: false })
    await pending.refreshPendingOps('eth', WALLET)
    const verify = vi.spyOn(
      await import('../src/core/postconditions'),
      'verifyOperationOutcomeWithRetry'
    )

    const result = await pending.refreshPendingOps('eth', WALLET, { reverifyResults: true })

    expect(verify).not.toHaveBeenCalled()
    expect(result.views[0].detail).toContain('verification incomplete')
    expect(pending.listPendingOps('eth', WALLET)[0].outcome).toBeUndefined()
  })

  it('re-decodes authenticated wallet calldata before rechecking a cached confirmed operation', async () => {
    const data = new Interface(['function bulkClaimMintReward(uint256[] ids)']).encodeFunctionData(
      'bulkClaimMintReward',
      [[9]]
    )
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 },
      walletTransaction: { from: WALLET, to: CONTRACTS.eth.factory, data, nonce: 7 }
    })
    const { settlement } = await (
      await import('../src/core/walletEvidence')
    ).readWalletEvidence('eth', WALLET, HASH)
    recordBroadcast(pending, { ids: [], phase: 'confirmed', settlement })
    const verify = vi
      .spyOn(await import('../src/core/postconditions'), 'verifyOperationOutcomeWithRetry')
      .mockResolvedValue({
        classification: 'full',
        expectedStatus: 'EMPTY',
        expectedCount: 1,
        expectedIds: [9],
        matchingCount: 1,
        matchingIds: [9],
        unexpectedCount: 0,
        unexpectedIds: [],
        readErrorCount: 0,
        readErrorIds: []
      })

    await pending.refreshPendingOps('eth', WALLET, { reverifyResults: true })

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'CLAIM', ids: [9] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(pending.listPendingOps('eth', WALLET)[0]).toMatchObject({
      ids: [9],
      outcome: { classification: 'full' }
    })
  })

  it('re-decodes a mined transaction when manually tracking an old operation description', async () => {
    const data = new Interface(['function bulkClaimMintReward(uint256[] ids)']).encodeFunctionData(
      'bulkClaimMintReward',
      [[9]]
    )
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 },
      walletTransaction: { from: WALLET, to: CONTRACTS.eth.factory, data, nonce: 7 }
    })
    recordBroadcast(pending, { ids: [7], origin: 'legacy-unknown', nonceAuthoritative: false })

    expect(await pending.trackPendingTxHash('eth', WALLET, HASH)).toMatchObject({
      ids: [9],
      phase: 'confirmed'
    })
  })

  it('never inherits an old receipt or terminal phase for a different hash at the same client id', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 }
    })
    const { readWalletEvidence } = await import('../src/core/walletEvidence')
    const { settlement } = await readWalletEvidence('eth', WALLET, HASH)
    recordBroadcast(pending, { id: 'batch-1', phase: 'confirmed', settlement })
    const later = recordBroadcast(pending, {
      id: 'batch-1',
      txHash: `0x${'2'.repeat(64)}`,
      nonceAuthoritative: false
    })
    expect(later.id).not.toBe('batch-1')
    expect(later.phase).toBe('broadcast')
    expect(later.receipt).toBeUndefined()
    expect(pending.listPendingOps('eth', WALLET)).toHaveLength(2)
  })

  it('does not release a later broadcast lock that reused an old client id', async () => {
    const { pending, releaseLock, releaseLocksByTxHash } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      walletReceipt: { status: 1 }
    })
    const locks =
      await vi.importActual<typeof import('../src/core/localLock')>('../src/core/localLock')
    releaseLock.mockImplementation(locks.releaseLock)
    releaseLocksByTxHash.mockImplementation(locks.releaseLocksByTxHash)
    localStorage.setItem(
      'sm.vmuLocks',
      JSON.stringify([
        {
          chain: 'eth',
          wallet: WALLET,
          ids: [8],
          txHash: `0x${'2'.repeat(64)}`,
          batch: 'batch-1',
          lockedAt: Date.now()
        }
      ])
    )
    const { settlement } = await (
      await import('../src/core/walletEvidence')
    ).readWalletEvidence('eth', WALLET, HASH)

    recordBroadcast(pending, { id: 'batch-1', phase: 'confirmed', settlement })

    expect(locks.pendingLocks('eth', WALLET)).toEqual([
      expect.objectContaining({ batch: 'batch-1', ids: [8], txHash: `0x${'2'.repeat(64)}` })
    ])
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH, { chain: 'eth', wallet: WALLET })
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
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH, { chain: 'eth', wallet: WALLET })
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
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH, { chain: 'eth', wallet: WALLET })
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

  it('reconciles many local records with bounded RPC concurrency', async () => {
    let active = 0
    let peak = 0
    const { pending } = await installPendingHarness({
      latestNonce: 0,
      pendingNonce: 12,
      receipt: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return null
      }
    })
    for (let nonce = 0; nonce < 12; nonce += 1) {
      recordBroadcast(pending, {
        id: `batch-${nonce}`,
        txHash: `0x${(nonce + 1).toString(16).padStart(64, '0')}`,
        nonce
      })
    }

    await pending.refreshPendingOps('eth', WALLET)

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
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
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH, { chain: 'eth', wallet: WALLET })
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
      origin: 'local',
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
    expect(releaseLock).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({
        chain: 'eth',
        wallet: WALLET,
        txHash: HASH
      })
    )
    expect(releaseLocksByTxHash).toHaveBeenCalledWith(HASH, { chain: 'eth', wallet: WALLET })
  })

  it('refuses to downgrade a record that another tab already resolved', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      receipt: { status: 1 }
    })
    recordBroadcast(pending, { id: 'batch-1' })
    const { settlement } = await (
      await import('../src/core/walletEvidence')
    ).readWalletEvidence('eth', WALLET, HASH)
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
      phase: 'confirmed',
      settlement
    })

    expect(pending.markPendingOpDropped('batch-1')).toBeNull()
    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('confirmed')
  })

  it('does not downgrade a confirmed record when a late broadcast event arrives', async () => {
    const { pending } = await installPendingHarness({
      latestNonce: 8,
      pendingNonce: 8,
      receipt: { status: 1 }
    })
    const { settlement } = await (
      await import('../src/core/walletEvidence')
    ).readWalletEvidence('eth', WALLET, HASH)
    recordBroadcast(pending, { id: 'batch-1', phase: 'confirmed', settlement })

    recordBroadcast(pending, { id: 'batch-1', phase: 'broadcast' })

    expect(pending.listPendingOps('eth', WALLET)[0].phase).toBe('confirmed')
  })
})

describe('broadcast VMU locks', () => {
  it('releases a matching hash only for the authenticated wallet and chain', async () => {
    vi.resetModules()
    vi.doUnmock('../src/core/localLock')
    const locks = await import('../src/core/localLock')
    const otherWallet = '0x00000000000000000000000000000000000000cd'
    for (const [chain, wallet, batch] of [
      ['eth', WALLET, 'eth-batch'],
      ['polygon', WALLET, 'polygon-batch'],
      ['eth', otherWallet, 'other-batch']
    ] as const) {
      expect(locks.tryAcquireLock({ chain, wallet, batch, ids: [7] })).toBe(true)
      locks.attachTxHash(batch, HASH)
    }

    locks.releaseLocksByTxHash(HASH, { chain: 'eth', wallet: WALLET.toUpperCase() })

    expect(locks.pendingLocks('eth', WALLET)).toEqual([])
    expect(locks.pendingLocks('polygon', WALLET)).toHaveLength(1)
    expect(locks.pendingLocks('eth', otherWallet)).toHaveLength(1)
  })

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
      locks: {
        request: async (_key: string, _options: LockOptions, work: () => Promise<unknown>) => work()
      }
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
      lifecycle: { phase: 'prepared' },
      state: { estimate: 'done', send: 'wait', confirm: 'wait' }
    })

    await expect(send).rejects.toThrow('Transaction receipt missing')
    expect(attachTxHash).not.toHaveBeenCalled()
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
