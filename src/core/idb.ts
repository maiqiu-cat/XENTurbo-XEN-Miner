import type { ChainKey } from '@/config/chains'
import type { Vmu } from './types'

// Minimal IndexedDB wrapper used as a read-only cache of derived on-chain state.
// The cache is always reconstructible from the chain, so it is safe to clear.

const DB_NAME = 'standalone-miner'
const DB_VERSION = 1
const STORE = 'walletVmus'

interface CachedSnapshot {
  key: string // `${chain}:${wallet}`
  chain: ChainKey
  wallet: string
  vmuCount: number
  vmus: Vmu[]
  syncedAt: number
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

export async function loadSnapshot(
  chain: ChainKey,
  wallet: string
): Promise<CachedSnapshot | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(cacheKey(chain, wallet))
      req.onsuccess = () => resolve((req.result as CachedSnapshot) ?? null)
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
}): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ ...snapshot, key: cacheKey(snapshot.chain, snapshot.wallet) })
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
