import type { ChainKey } from '@/config/chains'
import type { Vmu } from './types'

// Minimal IndexedDB wrapper used as a read-only cache of derived on-chain state.
// The cache is always reconstructible from the chain, so it is safe to clear.

const DB_NAME = 'standalone-miner'
const DB_VERSION = 2
const STORE = 'walletVmus'

export interface CachedSnapshot {
  version: 2
  key: string // `${chain}:${wallet}`
  chain: ChainKey
  wallet: string
  vmuCount: number
  vmus: Vmu[]
  syncedAt: number
  chainTimestampMs: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

const cacheKey = (chain: ChainKey, wallet: string) => `${chain}:${wallet.toLowerCase()}`

const VMU_STATUSES = new Set(['EMPTY', 'MINTING', 'CLAIMABLE', 'READ_ERROR'])

function isNonNegativeSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isVmu(value: unknown, vmuCount: number): value is Vmu {
  if (!value || typeof value !== 'object') return false
  const vmu = value as Record<string, unknown>
  return (
    isNonNegativeSafeNumber(vmu.id) &&
    vmu.id > 0 &&
    vmu.id <= vmuCount &&
    typeof vmu.address === 'string' &&
    /^0x[0-9a-f]{40}$/i.test(vmu.address) &&
    typeof vmu.status === 'string' &&
    VMU_STATUSES.has(vmu.status) &&
    isNonNegativeSafeNumber(vmu.rank) &&
    isNonNegativeSafeNumber(vmu.term) &&
    isNonNegativeSafeNumber(vmu.maturityTs) &&
    isNonNegativeSafeNumber(vmu.amplifier) &&
    isNonNegativeSafeNumber(vmu.eaaRate) &&
    typeof vmu.readOk === 'boolean'
  )
}

export function isCachedSnapshot(
  value: unknown,
  expectedChain: ChainKey,
  expectedWallet: string
): value is CachedSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  if (
    snapshot.version !== 2 ||
    snapshot.chain !== expectedChain ||
    typeof snapshot.wallet !== 'string' ||
    snapshot.wallet.toLowerCase() !== expectedWallet.toLowerCase() ||
    snapshot.key !== cacheKey(expectedChain, expectedWallet) ||
    !isNonNegativeSafeNumber(snapshot.vmuCount) ||
    !Array.isArray(snapshot.vmus) ||
    snapshot.vmus.length !== snapshot.vmuCount ||
    !isNonNegativeSafeNumber(snapshot.syncedAt) ||
    !isNonNegativeSafeNumber(snapshot.chainTimestampMs)
  ) {
    return false
  }
  const ids = new Set<number>()
  for (const vmu of snapshot.vmus) {
    if (!isVmu(vmu, snapshot.vmuCount) || ids.has(vmu.id)) return false
    ids.add(vmu.id)
  }
  return true
}

export async function loadSnapshot(
  chain: ChainKey,
  wallet: string
): Promise<CachedSnapshot | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(cacheKey(chain, wallet))
      req.onsuccess = () => {
        if (req.result == null) {
          resolve(null)
          return
        }
        if (isCachedSnapshot(req.result, chain, wallet)) {
          resolve(req.result)
          return
        }
        const cleanup = db.transaction(STORE, 'readwrite')
        cleanup.objectStore(STORE).delete(cacheKey(chain, wallet))
        cleanup.oncomplete = () => resolve(null)
        cleanup.onerror = () => resolve(null)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

export async function saveSnapshot(snapshot: {
  chain: ChainKey
  wallet: string
  vmuCount: number
  vmus: Vmu[]
  syncedAt: number
  chainTimestampMs: number
}): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({
        ...snapshot,
        version: 2,
        key: cacheKey(snapshot.chain, snapshot.wallet)
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // Cache failures are non-fatal - state can always be re-read from chain.
  }
}

export async function clearSnapshot(chain: ChainKey, wallet: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(cacheKey(chain, wallet))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore
  }
}
