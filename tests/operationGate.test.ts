import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInMemoryExclusiveGate,
  operationKey,
  runWalletExclusive
} from '../src/core/operationGate'

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    const request = vi.fn(async (key: string, work: () => Promise<string>) => {
      events.push(`lock:${key}`)
      try {
        return await work()
      } finally {
        events.push('unlock')
      }
    })
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

  it('keeps the final pending check and wallet send inside one browser lock', async () => {
    vi.resetModules()
    const events: string[] = []
    const provider = {
      getTransactionCount: vi.fn(async (_wallet: string, blockTag: string) => {
        events.push(`nonce:${blockTag}`)
        return 7
      }),
      getFeeData: vi.fn(async () => {
        events.push('fees')
        return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: 1n }
      }),
      waitForTransaction: vi.fn(async () => {
        events.push('confirm')
        return { status: 1 }
      })
    }

    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory: vi.fn(async () => {
        events.push('send')
        return '0xhash'
      })
    }))
    vi.doMock('../src/core/rpc', () => ({ getReadProvider: () => provider }))
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
      countUnresolvedPendingOps: vi.fn(() => {
        events.push('local:pending')
        return 0
      }),
      recordPendingOp: vi.fn()
    }))
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_key: string, work: () => Promise<string>) => {
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
          throw new Error(`Unexpected wallet method: ${method}`)
        }
      }
    })

    const { sendPreparedOperation } = await import('../src/core/txManager')
    await sendPreparedOperation({
      chain: 'eth',
      wallet: '0xAbC',
      op: 'GENERAL_MINT',
      ids: [],
      count: 1,
      term: 100,
      chainId: 1,
      factoryAddress: '0x0000000000000000000000000000000000000001',
      gasLimit: 100_000n,
      fnName: 'bulkClaimRank',
      args: [100n, 1n],
      batch: 'batch-1',
      lockIds: [],
      state: { estimate: 'done', send: 'wait', confirm: 'wait' },
      nonce: 7,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n
    })

    expect(events).toEqual([
      'lock:start',
      'local:pending',
      'nonce:latest',
      'nonce:pending',
      'wallet:eth_accounts',
      'wallet:eth_chainId',
      'wallet:eth_getTransactionCount',
      'nonce:pending',
      'fees',
      'send',
      'lock:end',
      'confirm'
    ])
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
    vi.doMock('../src/core/rpc', () => ({ getReadProvider: () => provider }))
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
        request: async (_key: string, work: () => Promise<string>) => {
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
    const prepared = {
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
      nonce: 7,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n
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
      getFeeData: vi.fn(async () => {
        events.push('fees')
        return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: 1n }
      }),
      waitForTransaction: vi.fn()
    }

    vi.doMock('../src/core/wallet', () => ({
      warmUpInjected: vi.fn(),
      writeFactory
    }))
    vi.doMock('../src/core/rpc', () => ({ getReadProvider: () => provider }))
    vi.doMock('../src/core/chainReader', () => ({
      readFee: vi.fn(),
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
        request: async (_key: string, work: () => Promise<string>) => {
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
          throw new Error(`Unexpected wallet method: ${method}`)
        }
      }
    })

    const { sendPreparedOperation } = await import('../src/core/txManager')
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
        gasLimit: 100_000n,
        fnName: 'reuseVMUs',
        args: [[4n], 100n],
        batch: 'batch-1',
        lockIds: [4],
        state: { estimate: 'done', send: 'wait', confirm: 'wait' },
        nonce: 7,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n
      })
    ).rejects.toThrow('VMU state changed on-chain')

    expect(events).toEqual([
      'lock:start',
      'local:pending',
      'nonce:latest',
      'nonce:pending',
      'wallet:eth_accounts',
      'wallet:eth_chainId',
      'wallet:eth_getTransactionCount',
      'nonce:pending',
      'fees',
      'ids:validate',
      'lock:end'
    ])
    expect(recordPendingOp).not.toHaveBeenCalled()
    expect(writeFactory).not.toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalledWith('batch-1')
  })
})
