// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTRACTS } from '@/config/contracts'
import { countUnresolvedPendingOps } from '@/core/pendingOps'
import {
  damagedRecordCount,
  inspectTransactionStorage,
  recoverTransactionStorage,
  storageBackupJson,
  transactionStorageIssues
} from '@/core/storageRecovery'

const wallet = '0x0000000000000000000000000000000000000001'
const other = '0x0000000000000000000000000000000000000002'
const hash = `0x${'a'.repeat(64)}`
const eventKey = 'sm.pendingOps.event.corrupt'
const badLock = {
  chain: 'eth',
  wallet,
  txHash: hash,
  ids: ['1'],
  batch: 'broken',
  lockedAt: Date.now()
}
const badEvent = {
  recordId: 'broken',
  updatedAt: 'bad',
  record: { chain: 'eth', wallet, txHash: hash }
}
const validLock = { ...badLock, ids: [2], batch: 'valid' }
const request = vi.fn()
const removeListener = vi.fn()
let receipt: unknown
let account = wallet

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, String(value))
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear()
  } satisfies Storage)
  account = wallet
  receipt = {
    transactionHash: hash,
    from: wallet,
    to: CONTRACTS.eth.factory,
    status: '0x1',
    blockNumber: '0x1',
    blockHash: `0x${'b'.repeat(64)}`
  }
  request.mockReset().mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_accounts') return [account]
    if (method === 'eth_getTransactionByHash') return null
    if (method === 'eth_getTransactionReceipt') return receipt
    throw new Error(`Unexpected wallet method: ${method}`)
  })
  Object.defineProperty(window, 'ethereum', {
    configurable: true,
    value: { request, on: vi.fn(), removeListener }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('receipt-authenticated transaction storage recovery', () => {
  it.each(['journal', 'locks', 'legacy'] as const)(
    'archives the exact %s before repairing only settled damage',
    async (kind) => {
      const key = kind === 'journal' ? eventKey : kind === 'locks' ? 'sm.vmuLocks' : 'sm.pendingOps'
      const raw = JSON.stringify(
        kind === 'journal' ? badEvent : kind === 'locks' ? [badLock, validLock] : [badEvent.record]
      )
      localStorage.setItem(key, raw)
      const snapshot = inspectTransactionStorage()
      expect(damagedRecordCount(snapshot)).toBe(1)
      const result = await recoverTransactionStorage(snapshot, 'eth', wallet)
      expect(result).toMatchObject({ repaired: 1, blocked: 0 })
      expect(localStorage.getItem(result.backupKey!)).toBe(storageBackupJson(snapshot))
      expect(localStorage.getItem(key)).toBe(
        kind === 'journal' ? null : JSON.stringify(kind === 'locks' ? [validLock] : [])
      )
      expect(request.mock.calls.some(([args]) => args.method === 'eth_sendTransaction')).toBe(false)
      expect(damagedRecordCount(inspectTransactionStorage())).toBe(0)
      expect(countUnresolvedPendingOps('eth', wallet)).toBe(0)
    }
  )
  it.each(['broken-json', 'missing-hash', 'other-wallet', 'other-chain', 'pending'] as const)(
    'does not erase %s evidence',
    async (kind) => {
      const record = { ...badEvent.record }
      if (kind === 'missing-hash') record.txHash = ''
      if (kind === 'other-wallet') record.wallet = other
      if (kind === 'other-chain') record.chain = 'polygon'
      if (kind === 'pending') receipt = null
      const raw = kind === 'broken-json' ? '{' : JSON.stringify({ ...badEvent, record })
      localStorage.setItem(eventKey, raw)
      const result = await recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
      expect(result).toMatchObject({ repaired: 0, blocked: 1, backupKey: null })
      const reason =
        kind === 'other-wallet' || kind === 'other-chain'
          ? 'otherContext'
          : kind === 'pending'
            ? 'unconfirmed'
            : 'unidentified'
      expect(result.blockedReasons[reason]).toBe(1)
      expect(localStorage.getItem(eventKey)).toBe(raw)
      expect(() => countUnresolvedPendingOps('eth', wallet)).toThrow('PENDING_STORAGE_READ_FAILED')
    }
  )
  it('blocks even lockless operations when a lock cache is damaged', () => {
    localStorage.setItem('sm.vmuLocks', JSON.stringify([badLock]))
    expect(() => countUnresolvedPendingOps('eth', wallet)).toThrow('LOCK_STORAGE_INVALID')
  })
  it('preserves unknown rows while repairing a settled row', async () => {
    localStorage.setItem('sm.vmuLocks', JSON.stringify([badLock, { unknown: true }, validLock]))
    const result = await recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
    expect(result).toMatchObject({ repaired: 1, blocked: 1 })
    expect(JSON.parse(localStorage.getItem('sm.vmuLocks')!)).toEqual([{ unknown: true }, validLock])
    expect(() => countUnresolvedPendingOps('eth', wallet)).toThrow('LOCK_STORAGE_INVALID')
  })
  it.each(['from', 'to', 'transactionHash'] as const)(
    'rejects a mismatched receipt %s',
    async (field) => {
      localStorage.setItem(eventKey, JSON.stringify(badEvent))
      receipt = {
        ...(receipt as object),
        [field]: field === 'transactionHash' ? `0x${'c'.repeat(64)}` : other
      }
      await expect(
        recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
      ).rejects.toThrow('identity')
      expect(localStorage.getItem(eventKey)).toBe(JSON.stringify(badEvent))
    }
  )
  it.each(['throw', 'silent'] as const)(
    'keeps originals when backup storage fails: %s',
    async (mode) => {
      localStorage.setItem(eventKey, JSON.stringify(badEvent))
      const set = localStorage.setItem.bind(localStorage)
      vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
        if (key.startsWith('sm.storageRecovery.backup.')) {
          if (mode === 'throw') throw new DOMException('full', 'QuotaExceededError')
          return
        }
        set(key, value)
      })
      await expect(
        recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
      ).rejects.toThrow('backup could not be saved')
      expect(localStorage.getItem(eventKey)).toBe(JSON.stringify(badEvent))
    }
  )
  it('rejects a stale preview after a cross-tab write', async () => {
    localStorage.setItem(eventKey, JSON.stringify(badEvent))
    const snapshot = inspectTransactionStorage()
    localStorage.setItem('sm.vmuLocks', JSON.stringify([validLock]))
    await expect(recoverTransactionStorage(snapshot, 'eth', wallet)).rejects.toThrow(
      'records changed'
    )
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['wallet', 'storage', 'abort'] as const)(
    'stops before mutation if %s changes during wallet verification',
    async (kind) => {
      localStorage.setItem(eventKey, JSON.stringify(badEvent))
      const snapshot = inspectTransactionStorage()
      const controller = new AbortController()
      const original = request.getMockImplementation()!
      request.mockImplementation(async (args) => {
        if (args.method === 'eth_getTransactionReceipt') {
          if (kind === 'wallet') account = other
          if (kind === 'storage') localStorage.setItem('sm.vmuLocks', JSON.stringify([validLock]))
          if (kind === 'abort') controller.abort()
        }
        return original(args)
      })
      const recovery = recoverTransactionStorage(snapshot, 'eth', wallet, controller.signal)
      if (kind === 'abort') await expect(recovery).rejects.toMatchObject({ name: 'AbortError' })
      else
        await expect(recovery).rejects.toThrow(
          kind === 'wallet' ? 'Wallet account changed' : 'Transaction records changed'
        )
      expect(localStorage.getItem(eventKey)).toBe(JSON.stringify(badEvent))
      expect(removeListener).toHaveBeenCalled()
    }
  )
  it('reports inaccessible storage without presenting an empty successful inspection', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    localStorage.setItem(eventKey, '{}')
    expect(inspectTransactionStorage).toThrow('Storage access is unavailable')
  })
  it('leaves a durable archive after a repair write fails', async () => {
    localStorage.setItem('sm.vmuLocks', JSON.stringify([badLock]))
    const snapshot = inspectTransactionStorage()
    const set = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'sm.vmuLocks') throw new DOMException('denied', 'SecurityError')
      set(key, value)
    })
    await expect(recoverTransactionStorage(snapshot, 'eth', wallet)).rejects.toThrow(
      'Recovery stopped'
    )
    const archive = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i)!
    ).find((key) => key.startsWith('sm.storageRecovery.backup.'))!
    expect(localStorage.getItem(archive)).toBe(storageBackupJson(snapshot))
    expect(localStorage.getItem('sm.vmuLocks')).toBe(snapshot.entries[0].raw)
  })

  it('accepts a wallet-authenticated reverted receipt as settled without sending', async () => {
    receipt = { ...(receipt as object), status: '0x0' }
    localStorage.setItem(eventKey, JSON.stringify(badEvent))
    const result = await recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
    expect(result).toMatchObject({ repaired: 1, blocked: 0 })
    expect(damagedRecordCount(inspectTransactionStorage())).toBe(0)
    expect(countUnresolvedPendingOps('eth', wallet)).toBe(0)
    expect(request.mock.calls.some(([args]) => args.method === 'eth_sendTransaction')).toBe(false)
  })

  it('limits one recovery to 20 records and distinguishes deferred work from unknown identity', async () => {
    const records = Array.from({ length: 21 }, (_, i) => ({ ...badLock, batch: `broken-${i}` }))
    records.push({ ...badLock, batch: 'unknown', txHash: '' })
    localStorage.setItem('sm.vmuLocks', JSON.stringify(records))
    const result = await recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
    expect(result).toMatchObject({
      repaired: 20,
      blocked: 2,
      blockedReasons: { readLimit: 1, unidentified: 1, otherContext: 0, unconfirmed: 0 }
    })
    expect(
      request.mock.calls.filter(([args]) => args.method === 'eth_getTransactionReceipt')
    ).toHaveLength(20)
    expect(JSON.parse(localStorage.getItem('sm.vmuLocks')!)).toEqual(records.slice(20))
    const resumed = await recoverTransactionStorage(inspectTransactionStorage(), 'eth', wallet)
    expect(resumed).toMatchObject({
      repaired: 1,
      blocked: 1,
      blockedReasons: { readLimit: 0, unidentified: 1 }
    })
    expect(JSON.parse(localStorage.getItem('sm.vmuLocks')!)).toEqual(records.slice(21))
    expect(() => countUnresolvedPendingOps('eth', wallet)).toThrow('LOCK_STORAGE_INVALID')
  })

  it.each([
    ['{', 'invalid-json'],
    ['{}', 'not-array'],
    [JSON.stringify([{ ...badLock, txHash: undefined, lockedAt: 1 }]), 'invalid-record']
  ])('classifies %s and never removes unidentified lock evidence', async (raw, kind) => {
    localStorage.setItem('sm.vmuLocks', raw)
    const snapshot = inspectTransactionStorage()
    expect(transactionStorageIssues(snapshot)).toEqual([{ key: 'sm.vmuLocks', kind, count: 1 }])
    const result = await recoverTransactionStorage(snapshot, 'eth', wallet)
    expect(result).toMatchObject({
      repaired: 0,
      blocked: 1,
      backupKey: null,
      blockedReasons: { unidentified: 1 }
    })
    expect(localStorage.getItem('sm.vmuLocks')).toBe(raw)
    expect(
      request.mock.calls.filter(([args]) => args.method === 'eth_getTransactionReceipt')
    ).toHaveLength(0)
    expect(() => countUnresolvedPendingOps('eth', wallet)).toThrow('LOCK_STORAGE_INVALID')
  })
})
