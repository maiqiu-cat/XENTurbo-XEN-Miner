import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertNonceAgreement,
  beginWalletSend,
  getInjectedAccount,
  getInjectedChainId,
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

function installProvider(request: (args: { method: string; params?: unknown[] }) => Promise<unknown>) {
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

  it('reads the wallet pending nonce using eth_getTransactionCount', async () => {
    const request = vi.fn(async () => '0x9')
    installProvider(request)

    await expect(getInjectedPendingNonce('0xAbC')).resolves.toBe(9)
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

function preparedOperation() {
  return {
    chain: 'eth' as const,
    wallet: '0xAbC',
    op: 'GENERAL_MINT' as const,
    ids: [],
    count: 1,
    term: 100,
    chainId: 1,
    factoryAddress: '0x0000000000000000000000000000000000000001' as const,
    gasLimit: 100_000n,
    fnName: 'bulkClaimRank',
    args: [100n, 1n],
    batch: 'batch-1',
    lockIds: [],
    state: { estimate: 'done' as const, send: 'wait' as const, confirm: 'wait' as const },
    nonce: 1,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n
  }
}

async function installSendHarness(options: {
  walletNonce: number
  rpcNonce: number
  freshMaxFeePerGas?: bigint
  freshMaxPriorityFeePerGas?: bigint
}) {
  const writeFactory = vi.fn(async () => `0x${'2'.repeat(64)}`)
  const readProvider = {
    getTransactionCount: vi.fn(async () => options.rpcNonce),
    getFeeData: vi.fn(async () => ({
      maxFeePerGas: options.freshMaxFeePerGas ?? 20n,
      maxPriorityFeePerGas: options.freshMaxPriorityFeePerGas ?? 3n,
      gasPrice: 10n
    })),
    waitForTransaction: vi.fn(async () => ({ status: 1 }))
  }

  installProvider(async ({ method }) => {
    if (method === 'eth_accounts') return ['0xAbC']
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getTransactionCount') return `0x${options.walletNonce.toString(16)}`
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
  vi.doMock('../src/core/rpc', () => ({ getReadProvider: () => readProvider }))
  vi.doMock('../src/core/chainReader', () => ({
    readFee: vi.fn(),
    readVmuCount: vi.fn(async () => 0),
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
    recordPendingOp: vi.fn()
  }))

  const txManager = await import('../src/core/txManager')
  return { ...txManager, writeFactory, readProvider }
}

describe('authoritative pre-send state', () => {
  it('does not call the wallet when injected and read-RPC pending nonces disagree', async () => {
    const { sendPreparedOperation, writeFactory } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 8
    })

    await expect(sendPreparedOperation(preparedOperation())).rejects.toThrow('PENDING_STATE_UNCERTAIN')
    expect(writeFactory).not.toHaveBeenCalled()
  })

  it('uses the injected nonce and fee data refreshed inside the operation gate', async () => {
    const { sendPreparedOperation, writeFactory, readProvider } = await installSendHarness({
      walletNonce: 9,
      rpcNonce: 9,
      freshMaxFeePerGas: 30n,
      freshMaxPriorityFeePerGas: 4n
    })

    await sendPreparedOperation(preparedOperation())

    expect(readProvider.getFeeData).toHaveBeenCalledOnce()
    expect(writeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: 9,
        maxFeePerGas: 30n,
        maxPriorityFeePerGas: 4n
      })
    )
  })
})
