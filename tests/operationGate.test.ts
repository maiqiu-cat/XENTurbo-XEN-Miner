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
    vi.doMock('../src/core/pendingOps', () => ({ recordPendingOp: vi.fn() }))
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
      'nonce:latest',
      'nonce:pending',
      'nonce:pending',
      'send',
      'lock:end',
      'confirm'
    ])
  })
})
