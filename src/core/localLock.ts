import type { ChainKey } from '@/config/chains'
import { shallowRef } from 'vue'

// Client-side VMU lock (localStorage). Replaces the server-side lock of the
// original platform. It prevents the same browser from double-spending VMU ids
// across tabs while a transaction is pending. It is best-effort only: it does
// NOT coordinate across devices, so the UI must re-read chain state before
// sending and warn the user.

export type LockOp =
  | 'GENERAL_MINT'
  | 'CREATE_EMPTY_SLOT'
  | 'MINT_EMPTY_SLOT'
  | 'CLAIM'
  | 'CLAIM_REUSE'

interface LockRecord {
  chain: ChainKey
  wallet: string
  ids: number[]
  txHash?: string
  batch: string
  lockedAt: number
  /** Optional metadata so the Pending Ops panel can show type/term after reload. */
  op?: LockOp
  count?: number
  term?: number
}

const KEY = 'sm.vmuLocks'
// Soft locks (pre-signature, no txHash): expire quickly so a hung Send cannot
// block Claim forever after the user closes the modal / refreshes.
const SOFT_LOCK_TTL_MS = 2 * 60 * 1000

function isValidLock(l: unknown): l is LockRecord {
  if (!l || typeof l !== 'object') return false
  const r = l as Record<string, unknown>
  return (
    typeof r.chain === 'string' &&
    typeof r.wallet === 'string' &&
    typeof r.batch === 'string' &&
    typeof r.lockedAt === 'number' &&
    Array.isArray(r.ids) &&
    r.ids.every((id) => typeof id === 'number' && Number.isFinite(id))
  )
}

function isAlive(l: LockRecord, now: number): boolean {
  const hasTx = typeof l.txHash === 'string' && l.txHash.length > 0
  // A broadcast lock is released only by receipt/nonce reconciliation. Age is
  // not evidence that a transaction stopped competing for its nonce.
  return hasTx || now - l.lockedAt < SOFT_LOCK_TTL_MS
}

function readAll(strict = false): LockRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as unknown[]) : []
    if (!Array.isArray(list)) throw new Error('Invalid VMU lock storage')
    const now = Date.now()
    const valid = list.filter(isValidLock).filter((l) => isAlive(l, now))
    if (valid.length !== list.length) writeAll(valid)
    return valid
  } catch (error) {
    if (strict) throw error
    return []
  }
}

const lockRevision = shallowRef(0)
const subscribedWindows = new WeakSet<Window>()

function observeLockChanges(): void {
  void lockRevision.value
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  if (subscribedWindows.has(window)) return
  subscribedWindows.add(window)
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) lockRevision.value += 1
  })
}

function writeAll(list: LockRecord[]): void {
  localStorage.setItem(KEY, JSON.stringify(list))
  lockRevision.value += 1
}

const scope = (chain: ChainKey, wallet: string) => (l: LockRecord) =>
  l.chain === chain && l.wallet.toLowerCase() === wallet.toLowerCase()

/** Ids currently locked (any soft/hard lock) for a wallet on a chain. */
export function lockedIds(chain: ChainKey, wallet: string): Set<number> {
  const set = new Set<number>()
  readAll()
    .filter(scope(chain, wallet))
    .forEach((l) => l.ids.forEach((id) => set.add(id)))
  return set
}

/**
 * Ids locked AFTER a tx was broadcast (have a txHash). These are hidden from the
 * Mint list. Soft locks (pre-signature, no hash yet) are NOT hidden so the row
 * stays visible while the user confirms in MetaMask.
 */
export function broadcastLockedIds(chain: ChainKey, wallet: string): Set<number> {
  observeLockChanges()
  const set = new Set<number>()
  readAll()
    .filter(scope(chain, wallet))
    .filter((l) => typeof l.txHash === 'string' && l.txHash.length > 0)
    .forEach((l) => l.ids.forEach((id) => set.add(id)))
  return set
}

/**
 * Acquire a lock, rejecting if any of the ids are already locked.
 * Returns true on success, false if there is an overlap.
 */
export function tryAcquireLock(params: {
  chain: ChainKey
  wallet: string
  ids: number[]
  batch: string
  op?: LockOp
  count?: number
  term?: number
}): boolean {
  const existing = lockedIds(params.chain, params.wallet)
  if (params.ids.some((id) => existing.has(id))) return false
  const list = readAll()
  list.push({ ...params, lockedAt: Date.now() })
  writeAll(list)
  return true
}

export function attachTxHash(
  batch: string,
  txHash: string,
  metadata?: Omit<LockRecord, 'batch' | 'txHash' | 'lockedAt'> & { lockedAt?: number }
): void {
  if (metadata && metadata.ids.length === 0) return
  const list = readAll(true)
  const matching = list.filter((lock) => lock.batch === batch && (!metadata || scope(metadata.chain, metadata.wallet)(lock)))
  if (matching.some((lock) => lock.txHash && lock.txHash.toLowerCase() !== txHash.toLowerCase())) {
    throw new Error('LOCK_IDENTITY_CONFLICT: a broadcast lock cannot change transaction identity')
  }
  matching.forEach((lock) => { lock.txHash = txHash })
  if (metadata && matching.length === 0) {
    list.push({ ...metadata, ids: [...metadata.ids], batch, txHash, lockedAt: metadata.lockedAt ?? Date.now() })
  }
  writeAll(list)
}

export function releaseLock(batch: string): void {
  writeAll(readAll().filter((l) => l.batch !== batch))
}

export function releaseLocksByTxHash(
  txHash: string,
  context?: { chain: ChainKey; wallet: string }
): void {
  const normalized = txHash.toLowerCase()
  writeAll(
    readAll().filter(
      (l) =>
        (context &&
          (l.chain !== context.chain || l.wallet.toLowerCase() !== context.wallet.toLowerCase())) ||
        typeof l.txHash !== 'string' ||
        l.txHash.toLowerCase() !== normalized
    )
  )
}

export function newBatchId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export interface PendingLock {
  chain: ChainKey
  wallet: string
  ids: number[]
  txHash: string
  batch: string
  lockedAt: number
  op?: LockOp
  count?: number
  term?: number
}

/** Locks that already have a tx hash - used to resume waiting after a reload. */
export function pendingLocks(chain: ChainKey, wallet: string): PendingLock[] {
  return readAll()
    .filter(scope(chain, wallet))
    .filter((l): l is PendingLock => typeof l.txHash === 'string' && l.txHash.length > 0)
}

/** Drop soft locks (no txHash) for a wallet — used on page load / Cancel. */
export function clearSoftLocks(chain: ChainKey, wallet: string): void {
  writeAll(
    readAll().filter(
      (l) =>
        !(
          l.chain === chain &&
          l.wallet.toLowerCase() === wallet.toLowerCase() &&
          !(typeof l.txHash === 'string' && l.txHash.length > 0)
        )
    )
  )
}
