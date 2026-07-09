import type { ChainKey } from './chains'

// VMU count limits per operation, ported from the original ManualBatch.vue.
export interface MinerLimits {
  generalMint: number
  createEmptySlot: number
  mintEmptySlot: number
  claim: number
  claimAndReuse: number
}

export const LIMITS: Record<ChainKey, MinerLimits> = {
  eth: { generalMint: 128, createEmptySlot: 500, mintEmptySlot: 150, claim: 350, claimAndReuse: 300 },
  polygon: { generalMint: 65, createEmptySlot: 320, mintEmptySlot: 90, claim: 220, claimAndReuse: 160 }
}

// gasLimit safety multiplier applied to estimated gas, ported from original.
export const GAS_LIMIT_RATIO: Record<ChainKey, number> = {
  eth: 1.3,
  polygon: 1.2
}

// Chains that skip a fee (msg.value). The deployed V2 contract charges a fee on
// mint/reuse/claim+remint, so no chain is free by default.
export const FREE_CHAINS: ChainKey[] = []

// Default General Mint batch size. Kept modest: a single huge batch (e.g. 128
// VMUs ~ 22M gas) is expensive and can trip wallet simulation / smart-tx relays.
// Users can still raise it up to LIMITS[chain].generalMint.
export const DEFAULT_MINT_VMUS = 50

// Default term (days).
export const DEFAULT_TERM = 100
export const DEFAULT_TERM_MAX = 250

/** How long we wait for an on-chain receipt before treating confirm as timed out. */
export const CONFIRM_TIMEOUT_MS: Record<ChainKey, number> = {
  eth: 120_000,
  polygon: 180_000
}

/** Max time waiting for the user to approve/reject in the wallet UI. */
export const SEND_TIMEOUT_MS = 10 * 60 * 1000
