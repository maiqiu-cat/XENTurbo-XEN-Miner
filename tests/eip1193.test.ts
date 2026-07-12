import { afterEach, describe, expect, it, vi } from 'vitest'
import { Interface } from 'ethers'

import {
  assertNonceAgreement,
  beginWalletSend,
  getInjectedAccount,
  getInjectedChainId,
  getInjectedLatestNonce,
  getInjectedPendingNonce
} from '../src/core/eip1193'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function installProvider(
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
) {
  vi.stubGlobal('window', { ethereum: { request } })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('injected EIP-1193 state', () => {
  it('reads the active account and chain directly from the injected provider', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return ['0xAbC']
      if (method === 'eth_chainId') return '0x89'
      throw new Error(`Unexpected method: ${method}`)
    })
    installProvider(request)

    await expect(getInjectedAccount()).resolves.toBe('0xAbC')
    await expect(getInjectedChainId()).resolves.toBe(137)
  })

  it('reads wallet latest and pending nonces using eth_getTransactionCount', async () => {
    const request = vi.fn(async ({ params }: { params?: unknown[] }) =>
      params?.[1] === 'latest' ? '0x8' : '0x9'
    )
    installProvider(request)

    await expect(getInjectedLatestNonce('0xAbC')).resolves.toBe(8)
    await expect(getInjectedPendingNonce('0xAbC')).resolves.toBe(9)
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getTransactionCount',
      params: ['0xAbC', 'latest']
    })
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getTransactionCount',
      params: ['0xAbC', 'pending']
    })
  })

  it('blocks a send when wallet and read RPC pending nonces disagree', () => {
    expect(() => assertNonceAgreement(9, 8)).toThrow('PENDING_STATE_UNCERTAIN')
  })

  it('accepts an agreed pending nonce and returns it', () => {
    expect(assertNonceAgreement(9, 9)).toBe(9)
  })
})

describe('wallet send lifecycle', () => {
  it('stays awaiting-wallet until a late eth_sendTransaction resolves', async () => {
    vi.useFakeTimers()
    const request = deferred<string>()
    const send = beginWalletSend(() => request.promise)

    expect(send.state()).toBe('awaiting-wallet')
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
    expect(send.state()).toBe('awaiting-wallet')

    request.resolve(`0x${'1'.repeat(64)}`)

    await expect(send.result).resolves.toMatch(/^0x/)
    expect(send.state()).toBe('broadcast')
  })

  it('reports a rejected wallet request as failed', async () => {
    const request = deferred<string>()
    const send = beginWalletSend(() => request.promise)
    request.reject(new Error('user rejected'))

    await expect(send.result).rejects.toThrow('user rejected')
    expect(send.state()).toBe('failed')
  })
})

const SEND_WALLET = '0x0000000000000000000000000000000000000abc'

function preparedOperation() {
  const preparedAt = Date.now()
  return {
    chain: 'eth' as const,
    wallet: SEND_WALLET,
    op: 'GENERAL_MINT' as const,
    ids: [],
    count: 1,
    term: 100,
    chainId: 1,
    factoryAddress: '0x0000000000000000000000000000000000000001' as const,
    contextKey: `1:${SEND_WALLET}`,
    preparedAt,
    expiresAt: preparedAt + 120_000,
    gasLimit: 100_000n,
    fnName: 'bulkClaimRank',
    args: [100n, 1n],
    batch: 'batch-1',
    lockIds: [],
    state: { estimate: 'done' as const, send: 'wait' as const, confirm: 'wait' as const }
  }
}

async function installSendHarness(options: {
  walletNonce: number
  rpcNonce: number
  walletLatestNonce?: number
  walletFee?: bigint
  readRpcFee?: bigint
  walletVmuCount?: number
  rejectWalletSimulation?: boolean
  writeFactoryFailure?: Error
  beforeRequestStart?: () => void
  syncRequestFailure?: Error
}) {
  const feeInterface = new Interface(['function FEE() view returns (uint256)'])
  const countInterface = new Interface(['function vmuCount(address) view returns (uint256)'])
  const simulationInterface = new Interface([
    'function bulkClaimRank_(uint256 term, uint256 count)'
  ])
  const walletFee = options.walletFee ?? 18_000n
  const writeFactory = vi.fn(async (params: Record<string, unknown>) => {
    if (options.writeFactoryFailure) throw options.writeFactoryFailure
    options.beforeRequestStart?.()
    ;(params.onRequestStart as (() => void) | undefined)?.()
    if (options.syncRequestFailure) {
      ;(params.onRequestSyncError as (() => void) | undefined)?.()
      throw options.syncRequestFailure
    }
    return `0x${'2'.repeat(64)}`
  })
  const recordPendingOp = vi.fn()
  const removePendingOpRecord = vi.fn()
  const readVmuCount = vi.fn(async () => 0)
  const readFee = vi.fn(async () => options.readRpcFee ?? walletFee)
  const readProvider = {
    getTransactionCount: vi.fn(async () => options.rpcNonce),
    waitForTransaction: vi.fn(async () => ({ status: 1 }))
  }

  installProvider(async ({ method, params }) => {
    if (method === 'eth_accounts') return [SEND_WALLET]
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getTransactionCount') {
      const tag = params?.[1]
      const nonce =
        tag === 'latest' ? (options.walletLatestNonce ?? options.walletNonce) : options.walletNonce
      return `0x${nonce.toString(16)}`
    }
    if (method === 'eth_call') {
      const data = (params?.[0] as { data?: string } | undefined)?.data
      if (data === feeInterface.encodeFunctionData('FEE')) {
        return feeInterface.encodeFunctionResult('FEE', [walletFee])
      }
      if (data?.startsWith(simulationInterface.getFunction('bulkClaimRank_')!.selector)) {
        if (options.rejectWalletSimulation) throw new Error('execution reverted: strict simulation')
        return '0x'
      }
      if (data?.startsWith(countInterface.getFunction('vmuCount')!.selector)) {
        return countInterface.encodeFunctionResult('vmuCount', [options.walletVmuCount ?? 0])
      }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_key: string, work: () => Promise<unknown>) => work()
    }
  })
  vi.doMock('../src/core/wallet', () => ({
    warmUpInjected: vi.fn(),
    writeFactory
  }))
  const ensureHealthyReadProvider = vi.fn(async () => readProvider)
  vi.doMock('../src/core/rpc', () => ({
    ensureHealthyReadProvider,
    getReadProvider: () => readProvider
  }))
  vi.doMock('../src/core/chainReader', () => ({
    readFee,
    readVmuCount,
    readVmuStatuses: vi.fn()
  }))
  vi.doMock('../src/core/localLock', () => ({
    attachTxHash: vi.fn(),
    releaseLock: vi.fn(),
    newBatchId: vi.fn(),
    pendingLocks: vi.fn(),
    tryAcquireLock: vi.fn(),
    clearSoftLocks: vi.fn()
  }))
  vi.doMock('../src/core/pendingOps', () => ({
    countUnresolvedPendingOps: vi.fn(() => 0),
    recordPendingOp,
    removePendingOpRecord
  }))
  vi.doMock('../src/core/postconditions', () => ({
    verifyOperationOutcomeWithRetry: vi.fn(async () => ({ classification: 'full' })),
    uncertainOperationOutcome: vi.fn(() => ({ classification: 'uncertain' }))
  }))

  const txManager = await import('../src/core/txManager')
  return {
    ...txManager,
    writeFactory,
    readProvider,
    ensureHealthyReadProvider,
    readFee,
    readVmuCount,
    recordPendingOp,
    removePendingOpRecord
  }
}

describe('authoritative pre-send state', () => {
  it('blocks an injected-wallet nonce gap even when the read RPC hides it', async () => {
    const { sendPreparedOperation, writeFactory } = await installSendHarness({
      walletNonce: 9,
      walletLatestNonce: 8,
      rpcNonce: 9
    })

    await expect(sendPreparedOperation(preparedOperation())).rejects.toThrow('PENDING_TX')
    expect(writeFactory).not.toHaveBeenCalled()
  })

  it('uses the injected nonce and factory fee but leaves gas pricing to the wallet', async () => {
    const {
      sendPreparedOperation,
      writeFactory,
      readProvider,
      ensureHealthyReadProvider,
      readFee
    } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      walletFee: 30n,
      readRpcFee: 30_000n
    })

    await sendPreparedOperation(preparedOperation())

    expect(readProvider.getTransactionCount).not.toHaveBeenCalled()
    expect(ensureHealthyReadProvider).toHaveBeenCalledWith('eth')
    expect(ensureHealthyReadProvider.mock.invocationCallOrder[0]).toBeLessThan(
      writeFactory.mock.invocationCallOrder[0]
    )
    expect(readFee).not.toHaveBeenCalled()
    expect(writeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: 9,
        value: 30n
      })
    )
    const sent = writeFactory.mock.calls[0][0]
    expect(sent).not.toHaveProperty('maxFeePerGas')
    expect(sent).not.toHaveProperty('maxPriorityFeePerGas')
  })

  it('does not open a wallet send when the injected strict simulation rejects', async () => {
    const { sendPreparedOperation, writeFactory } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      rejectWalletSimulation: true
    })

    await expect(sendPreparedOperation(preparedOperation())).rejects.toThrow(/strict simulation/)
    expect(writeFactory).not.toHaveBeenCalled()
  })

  it('does not persist awaiting-wallet before writeFactory reaches the request boundary', async () => {
    const { sendPreparedOperation, recordPendingOp } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      writeFactoryFailure: new Error('Wallet account changed during the operation')
    })
    const onStep = vi.fn()

    await expect(sendPreparedOperation(preparedOperation(), { onStep })).rejects.toThrow(
      /Wallet account changed/
    )

    expect(recordPendingOp).not.toHaveBeenCalled()
    expect(onStep).toHaveBeenLastCalledWith(expect.objectContaining({ send: 'error' }))
  })

  it('cancels during async preflight before the wallet request boundary', async () => {
    let cancelled = false
    const { sendPreparedOperation, recordPendingOp } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      beforeRequestStart: () => {
        cancelled = true
      }
    })

    await expect(
      sendPreparedOperation(preparedOperation(), { isCancelled: () => cancelled })
    ).rejects.toThrow('OPERATION_CANCELLED')
    expect(recordPendingOp).not.toHaveBeenCalled()
  })

  it('rechecks prepared-operation expiry at the wallet request boundary', async () => {
    const prepared = preparedOperation()
    const { sendPreparedOperation, recordPendingOp } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      beforeRequestStart: () => {
        prepared.expiresAt = Date.now() - 1
      }
    })

    await expect(sendPreparedOperation(prepared)).rejects.toThrow(/expired/i)
    expect(recordPendingOp).not.toHaveBeenCalled()
  })

  it('uses the injected-wallet VMU count for allocating-operation postconditions', async () => {
    const prepared = preparedOperation()
    const { sendPreparedOperation, readVmuCount } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      walletVmuCount: 42
    })

    await sendPreparedOperation(prepared)

    expect((prepared as { preVmuCount?: number }).preVmuCount).toBe(42)
    expect(readVmuCount).not.toHaveBeenCalled()
  })

  it('removes awaiting-wallet state when the provider throws synchronously', async () => {
    const { sendPreparedOperation, removePendingOpRecord } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      syncRequestFailure: new Error('provider failed synchronously')
    })

    await expect(sendPreparedOperation(preparedOperation())).rejects.toThrow(
      /provider failed synchronously/
    )
    expect(removePendingOpRecord).toHaveBeenCalledWith('batch-1')
  })
})
