import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Interface } from 'ethers'
import {
  createInMemoryExclusiveGate,
  operationKey,
  runWalletExclusive
} from '../src/core/operationGate'

beforeEach(() => {
  expect(vi.isFakeTimers()).toBe(false)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const feeInterface = new Interface(['function FEE() view returns (uint256)'])
const feeResult = feeInterface.encodeFunctionResult('FEE', [18n])

function preparedContext() {
  const preparedAt = Date.now()
  return {
    contextKey: '1:0xabc',
    preparedAt,
    expiresAt: preparedAt + 120_000
  }
}

async function expectRpcErrorMapping(): Promise<void> {
  const { RpcConfigurationError } =
    await vi.importActual<typeof import('../src/core/rpc')>('../src/core/rpc')
  const { normalizeError } = await import('../src/core/txManager')
  expect(
    normalizeError(new RpcConfigurationError('eth', 'Use at most 16 RPC endpoints'))
  ).toContain('Open the RPC settings')
  expect(normalizeError(new Error('RPC_UNAVAILABLE: offline fixture'))).toContain(
    'Check internet access'
  )
}

describe('operation gate', () => {
  it('scopes sends by chain and normalized wallet address', () => {
    expect(operationKey('eth', '0xAbC')).toBe('xenturbo:eth:0xabc:send')
  })

  it('never overlaps two sends for the same chain and wallet', async () => {
    const gate = createInMemoryExclusiveGate()
    let active = 0
    let maxActive = 0

    const send = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
    }

    await Promise.all([gate.run('eth:0xabc', send), gate.run('eth:0xabc', send)])

    expect(maxActive).toBe(1)
  })

  it('holds the browser lock until wallet work settles', async () => {
    const events: string[] = []
    let finishSend!: () => void
    const sendFinished = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const request = vi.fn(
      async (key: string, _options: LockOptions, work: () => Promise<string>) => {
        events.push(`lock:${key}`)
        try {
          return await work()
        } finally {
          events.push('unlock')
        }
      }
    )
    vi.stubGlobal('navigator', { locks: { request } })

    const result = runWalletExclusive('xenturbo:eth:0xabc:send', async () => {
      events.push('send')
      await sendFinished
      return '0xhash'
    })

    await vi.waitFor(() => {
      expect(events).toEqual(['lock:xenturbo:eth:0xabc:send', 'send'])
    })
    expect(events).not.toContain('unlock')

    finishSend()

    await expect(result).resolves.toBe('0xhash')
    expect(events).toEqual(['lock:xenturbo:eth:0xabc:send', 'send', 'unlock'])
  })

  it('times out while waiting for another tab without aborting acquired work', async () => {
    vi.useFakeTimers()
    const request = vi.fn(
      async (_key: string, options: LockOptions, _work: () => Promise<string>) =>
        new Promise<string>((_resolve, reject) => {
          void _work
          options.signal?.addEventListener('abort', () => {
            reject(new DOMException('The request was aborted', 'AbortError'))
          })
        })
    )
    vi.stubGlobal('navigator', { locks: { request } })

    const waiting = runWalletExclusive('xenturbo:eth:0xabc:send', async () => '0xhash', {
      timeoutMs: 5_000
    })
    const rejection = expect(waiting).rejects.toThrow('WALLET_LOCK_TIMEOUT')

    await vi.advanceTimersByTimeAsync(5_000)
    await rejection
  })

  it('keeps the final pending check and wallet send inside one browser lock', async () => {
    vi.resetModules()
    const walletAddress = '0x0000000000000000000000000000000000000abc'
    const events: string[] = []
    const provider = {
      getTransactionCount: vi.fn(async (_wallet: string, blockTag: string) => {
        events.push(`nonce:${blockTag}`)
        return 7
      }),
      waitForTransaction: vi.fn(async () => {
        events.push('confirm')
        return { status: 1 }
      })
    }

    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory: vi.fn(async (params: { onRequestStart?: () => void }) => {
        params.onRequestStart?.()
        events.push('send')
        return `0x${'a'.repeat(64)}`
      })
    }))
    vi.doMock('../src/core/rpc', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/rpc')>()),
      ensureHealthyReadProvider: vi.fn(async () => provider),
      getReadProvider: () => provider
    }))
    vi.doMock('../src/core/chainReader', () => ({
      readFee: vi.fn(async () => 18n),
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
      countUnresolvedPendingOps: vi.fn(() => {
        events.push('local:pending')
        return 0
      }),
      recordPendingOp: vi.fn()
    }))
    vi.doMock('../src/core/postconditions', () => ({
      verifyOperationOutcomeWithRetry: vi.fn(async () => ({ classification: 'full' })),
      uncertainOperationOutcome: vi.fn(() => ({ classification: 'uncertain' }))
    }))
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_key: string, _options: LockOptions, work: () => Promise<string>) => {
          events.push('lock:start')
          try {
            return await work()
          } finally {
            events.push('lock:end')
          }
        }
      }
    })
    vi.stubGlobal('window', {
      ethereum: {
        request: async ({ method }: { method: string }) => {
          events.push(`wallet:${method}`)
          if (method === 'eth_accounts') return [walletAddress]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getTransactionByHash') return null
          if (method === 'eth_getTransactionReceipt')
            return {
              transactionHash: `0x${'a'.repeat(64)}`,
              from: walletAddress,
              to: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
              status: '0x1',
              blockNumber: '0x1',
              blockHash: `0x${'b'.repeat(64)}`
            }
          if (method === 'eth_getTransactionCount') return '0x7'
          if (method === 'eth_call') return feeResult
          throw new Error(`Unexpected wallet method: ${method}`)
        }
      }
    })

    const { sendPreparedOperation } = await import('../src/core/txManager')
    await expectRpcErrorMapping()
    await sendPreparedOperation({
      chain: 'eth',
      wallet: walletAddress,
      op: 'GENERAL_MINT',
      ids: [],
      count: 1,
      term: 100,
      chainId: 1,
      factoryAddress: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
      ...preparedContext(),
      gasLimit: 100_000n,
      fnName: 'bulkClaimRank',
      args: [100n, 1n],
      batch: 'batch-1',
      lockIds: [],
      lifecycle: { phase: 'prepared' },
      state: { estimate: 'done', send: 'wait', confirm: 'wait' }
    })

    expect(events.slice(0, events.indexOf('confirm') + 1)).toEqual([
      'lock:start',
      'local:pending',
      'wallet:eth_chainId',
      'wallet:eth_getTransactionCount',
      'wallet:eth_getTransactionCount',
      'nonce:latest',
      'nonce:pending',
      'wallet:eth_accounts',
      'wallet:eth_chainId',
      'wallet:eth_getTransactionCount',
      'wallet:eth_call',
      'wallet:eth_call',
      'wallet:eth_call',
      'send',
      'lock:end',
      'confirm'
    ])
    expect(provider.getTransactionCount).toHaveBeenNthCalledWith(1, walletAddress, 'latest')
    expect(provider.getTransactionCount).toHaveBeenNthCalledWith(2, walletAddress, 'pending')
  })

  it('blocks a locally unresolved operation before any nonce read or wallet request', async () => {
    vi.resetModules()
    const events: string[] = []
    const writeFactory = vi.fn()
    const provider = {
      getTransactionCount: vi.fn(),
      getFeeData: vi.fn(),
      waitForTransaction: vi.fn()
    }

    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory
    }))
    vi.doMock('../src/core/rpc', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/rpc')>()),
      ensureHealthyReadProvider: vi.fn(async () => provider),
      getReadProvider: () => provider
    }))
    vi.doMock('../src/core/chainReader', () => ({
      readFee: vi.fn(),
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
    const countUnresolvedPendingOps = vi.fn(() => {
      events.push('local:pending')
      return 1
    })
    vi.doMock('../src/core/pendingOps', () => ({
      countUnresolvedPendingOps,
      recordPendingOp: vi.fn()
    }))
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_key: string, _options: LockOptions, work: () => Promise<string>) => {
          events.push('lock:start')
          try {
            return await work()
          } finally {
            events.push('lock:end')
          }
        }
      }
    })

    const { sendPreparedOperation } = await import('../src/core/txManager')
    await expectRpcErrorMapping()
    const prepared = {
      chain: 'eth' as const,
      wallet: '0xAbC',
      op: 'GENERAL_MINT' as const,
      ids: [],
      count: 1,
      term: 100,
      chainId: 1,
      factoryAddress: '0x0000000000000000000000000000000000000001' as const,
      ...preparedContext(),
      gasLimit: 100_000n,
      fnName: 'bulkClaimRank',
      args: [100n, 1n],
      batch: 'batch-1',
      lockIds: [],
      lifecycle: { phase: 'prepared' as const },
      state: { estimate: 'done' as const, send: 'wait' as const, confirm: 'wait' as const }
    }

    await expect(sendPreparedOperation(prepared)).rejects.toThrow('LOCAL_PENDING_UNRESOLVED')

    expect(countUnresolvedPendingOps).toHaveBeenCalledWith('eth', '0xAbC')
    expect(events).toEqual(['lock:start', 'local:pending', 'lock:end'])
    expect(provider.getTransactionCount).not.toHaveBeenCalled()
    expect(writeFactory).not.toHaveBeenCalled()
  })

  it('revalidates selected VMUs inside the browser lock immediately before sending', async () => {
    vi.resetModules()
    const events: string[] = []
    const writeFactory = vi.fn(async () => {
      events.push('send')
      return '0xhash'
    })
    const releaseLock = vi.fn()
    const recordPendingOp = vi.fn()
    const provider = {
      getTransactionCount: vi.fn(async (_wallet: string, blockTag: string) => {
        events.push(`nonce:${blockTag}`)
        return 7
      }),
      waitForTransaction: vi.fn()
    }

    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory
    }))
    vi.doMock('../src/core/rpc', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/rpc')>()),
      ensureHealthyReadProvider: vi.fn(async () => provider),
      getReadProvider: () => provider
    }))
    vi.doMock('../src/core/chainReader', () => ({
      readFee: vi.fn(async () => 18n),
      readVmuCount: vi.fn(),
      readVmuStatuses: vi.fn(async () => {
        events.push('ids:validate')
        return new Map([[4, 'MINTING']])
      })
    }))
    vi.doMock('../src/core/localLock', () => ({
      attachTxHash: vi.fn(),
      releaseLock,
      newBatchId: vi.fn(),
      pendingLocks: vi.fn(),
      tryAcquireLock: vi.fn(),
      clearSoftLocks: vi.fn()
    }))
    vi.doMock('../src/core/pendingOps', () => ({
      countUnresolvedPendingOps: vi.fn(() => {
        events.push('local:pending')
        return 0
      }),
      recordPendingOp
    }))
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_key: string, _options: LockOptions, work: () => Promise<string>) => {
          events.push('lock:start')
          try {
            return await work()
          } finally {
            events.push('lock:end')
          }
        }
      }
    })
    vi.stubGlobal('window', {
      ethereum: {
        request: async ({ method }: { method: string }) => {
          events.push(`wallet:${method}`)
          if (method === 'eth_accounts') return ['0xAbC']
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getTransactionCount') return '0x7'
          if (method === 'eth_call') return feeResult
          throw new Error(`Unexpected wallet method: ${method}`)
        }
      }
    })

    const { sendPreparedOperation } = await import('../src/core/txManager')
    await expectRpcErrorMapping()
    await expect(
      sendPreparedOperation({
        chain: 'eth',
        wallet: '0xAbC',
        op: 'MINT_EMPTY_SLOT',
        ids: [4],
        count: 0,
        term: 100,
        chainId: 1,
        factoryAddress: '0x0000000000000000000000000000000000000001',
        ...preparedContext(),
        gasLimit: 100_000n,
        fnName: 'reuseVMUs',
        args: [[4n], 100n],
        batch: 'batch-1',
        lockIds: [4],
        lifecycle: { phase: 'prepared' },
        state: { estimate: 'done', send: 'wait', confirm: 'wait' }
      })
    ).rejects.toThrow('VMU state changed on-chain')

    expect(events).toEqual([
      'lock:start',
      'local:pending',
      'wallet:eth_chainId',
      'wallet:eth_getTransactionCount',
      'wallet:eth_getTransactionCount',
      'nonce:latest',
      'nonce:pending',
      'wallet:eth_accounts',
      'wallet:eth_chainId',
      'wallet:eth_getTransactionCount',
      'wallet:eth_call',
      'ids:validate',
      'lock:end'
    ])
    expect(recordPendingOp).not.toHaveBeenCalled()
    expect(writeFactory).not.toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalledWith('batch-1')
  })
})
