import type { ChainKey } from '@/config/chains'
import { isValidLock } from './localLock'
import { normalizeRecord, parsePendingStorageEvent } from './pendingOps'
import { readWalletEvidence, walletReadSession } from './walletEvidence'
import { assertReadActive } from './readDeadline'

export interface StorageSnapshot {
  entries: { key: string; raw: string }[]
}

interface Damage {
  key: string
  rows: unknown[]
  invalid: number[]
  array: boolean
}

const isTransactionKey = (key: string) =>
  key === 'sm.vmuLocks' || key === 'sm.pendingOps' || key.startsWith('sm.pendingOps.event.')

/** Inspect without migration, compaction, or any mutation of transaction evidence. */
export function inspectTransactionStorage(): StorageSnapshot {
  try {
    const entries: StorageSnapshot['entries'] = []
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key || !isTransactionKey(key)) continue
      const raw = localStorage.getItem(key)
      if (raw !== null) entries.push({ key, raw })
    }
    return { entries: entries.sort((a, b) => a.key.localeCompare(b.key)) }
  } catch {
    throw new Error(
      'Storage access is unavailable. Restore browser storage access and retry. No records were changed.'
    )
  }
}

function damage(snapshot: StorageSnapshot): Damage[] {
  return snapshot.entries.flatMap<Damage>(({ key, raw }) => {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (key.startsWith('sm.pendingOps.event.')) {
        try {
          parsePendingStorageEvent(raw)
          return []
        } catch {
          /* Inspect identity only. */
        }
        const record =
          parsed && typeof parsed === 'object' && 'record' in parsed ? parsed.record : null
        return [{ key, rows: [record], invalid: [0], array: false }]
      }
      if (!Array.isArray(parsed)) return [{ key, rows: [null], invalid: [0], array: false }]
      const valid = key === 'sm.vmuLocks' ? isValidLock : normalizeRecord
      const invalid = parsed.flatMap((row, i) => (valid(row) ? [] : [i]))
      return invalid.length ? [{ key, rows: parsed, invalid, array: true }] : []
    } catch {
      return [{ key, rows: [null], invalid: [0], array: false }]
    }
  })
}

export function damagedRecordCount(snapshot: StorageSnapshot): number {
  return damage(snapshot).reduce((sum, item) => sum + item.invalid.length, 0)
}

export function storageBackupJson(snapshot: StorageSnapshot): string {
  return JSON.stringify({ format: 'xenturbo-transaction-storage-v1', ...snapshot }, null, 2)
}

/** Never infer settlement from age, a zero nonce gap, or a configured public RPC. */
export async function recoverTransactionStorage(
  expected: StorageSnapshot,
  chain: ChainKey,
  wallet: string,
  signal?: AbortSignal
): Promise<{ repaired: number; blocked: number; backupKey: string | null }> {
  const assertUnchanged = () => {
    assertReadActive(signal)
    if (JSON.stringify(inspectTransactionStorage()) !== JSON.stringify(expected))
      throw new Error(
        'Transaction records changed in this or another tab. Inspect again before recovery.'
      )
  }
  assertUnchanged()
  const session = await walletReadSession(chain, signal)
  try {
    const assertAccount = async () => {
      await session.validate()
      const accounts = await session.request('eth_accounts')
      if (
        !Array.isArray(accounts) ||
        typeof accounts[0] !== 'string' ||
        accounts[0].toLowerCase() !== wallet.toLowerCase()
      )
        throw new Error('Wallet account changed. Inspect again with the original account.')
    }
    await assertAccount()
    const changes: { key: string; raw: string | null; count: number }[] = []
    let blocked = 0
    // Bound wallet reads per invocation; another inspection can resume safely.
    let reads = 0
    for (const item of damage(expected)) {
      const settled = new Set<number>()
      for (const index of item.invalid) {
        const row = item.rows[index] as Record<string, unknown> | null
        if (
          !row ||
          row.chain !== chain ||
          typeof row.wallet !== 'string' ||
          row.wallet.toLowerCase() !== wallet.toLowerCase() ||
          typeof row.txHash !== 'string' ||
          !/^0x[0-9a-f]{64}$/i.test(row.txHash) ||
          reads >= 20
        ) {
          blocked += 1
          continue
        }
        reads += 1
        const evidence = await readWalletEvidence(chain, wallet, row.txHash, { signal })
        // A corrupt nonce is never authoritative. Only a matching mined receipt is sufficient.
        if (evidence.settlement?.receipt) settled.add(index)
        else blocked += 1
      }
      if (settled.size)
        changes.push({
          key: item.key,
          raw: item.array ? JSON.stringify(item.rows.filter((_, i) => !settled.has(i))) : null,
          count: settled.size
        })
    }
    await assertAccount()
    assertUnchanged()
    if (!changes.length) return { repaired: 0, blocked, backupKey: null }
    const backupKey = `sm.storageRecovery.backup.${crypto.randomUUID()}`
    const backup = storageBackupJson(expected)
    // Keep an exact durable archive before removing even a wallet-settled malformed record.
    try {
      localStorage.setItem(backupKey, backup)
      if (localStorage.getItem(backupKey) !== backup) throw new Error('Backup verification failed')
    } catch {
      throw new Error(
        'Recovery backup could not be saved and verified. No transaction records were changed. Export a backup and restore storage capacity first.'
      )
    }
    assertUnchanged()
    try {
      for (const change of changes) {
        const original = expected.entries.find((entry) => entry.key === change.key)!
        if (localStorage.getItem(change.key) !== original.raw)
          throw new Error('Concurrent storage change')
        if (change.raw === null) localStorage.removeItem(change.key)
        else localStorage.setItem(change.key, change.raw)
        if (localStorage.getItem(change.key) !== change.raw)
          throw new Error('Write verification failed')
      }
    } catch {
      throw new Error(
        'Recovery stopped during a storage change. The original backup is retained. Inspect again; do not clear site data or resend.'
      )
    }
    return { repaired: changes.reduce((n, change) => n + change.count, 0), blocked, backupKey }
  } finally {
    session.dispose()
  }
}
