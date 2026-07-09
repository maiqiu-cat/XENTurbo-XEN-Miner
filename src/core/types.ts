import type { ChainKey } from '@/config/chains'

export type VmuStatus = 'EMPTY' | 'MINTING' | 'CLAIMABLE' | 'READ_ERROR'

/** On-chain state of a single VMU proxy, derived entirely from reads. */
export interface Vmu {
  id: number
  address: string
  status: VmuStatus
  rank: number
  term: number
  /** maturity timestamp in ms (0 for empty slots) */
  maturityTs: number
  amplifier: number
  eaaRate: number
  /** false when Multicall/RPC failed for this id (must not treat as EMPTY). */
  readOk: boolean
}

/** A group of VMUs sharing the same mint batch (term + maturityTs). */
export interface VmuGroup {
  key: string
  term: number
  maturityTs: number
  status: Exclude<VmuStatus, 'READ_ERROR' | 'EMPTY'>
  rank: number
  amplifier: number
  eaaRate: number
  ids: number[]
  count: number
  estXen?: number
}

export interface WalletSnapshot {
  chain: ChainKey
  wallet: string
  vmuCount: number
  vmus: Vmu[]
  syncedAt: number
}
