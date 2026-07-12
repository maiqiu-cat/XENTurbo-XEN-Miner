// XEN reward estimation, ported from the original ManualBatch.vue logic.

function getOverTimeDays(maturityMs: number, currentTimeMs: number): number {
  const diff = currentTimeMs - maturityMs
  const dayMs = 86_400_000
  if (diff < 0) return -1
  if (diff === 0) return 0
  return diff / dayMs
}

/** Late-claim penalty multiplier based on how long past maturity we are. */
export function getRewardsPenalty(maturityMs: number, currentTimeMs = Date.now()): number {
  const days = getOverTimeDays(maturityMs, currentTimeMs)
  if (days <= 0) return 1
  if (days > 7) return 1 - 0.99
  if (days > 6) return 1 - 0.72
  if (days > 5) return 1 - 0.35
  if (days > 4) return 1 - 0.17
  if (days > 3) return 1 - 0.08
  if (days > 2) return 1 - 0.03
  if (days > 1) return 1 - 0.01
  return 1
}

/**
 * Estimated XEN for a group using each VMU's actual on-chain rank.
 */
export function estimateGroupXen(params: {
  globalRank: number
  ranks: number[]
  term: number
  amplifier: number
  eaaRate: number
  maturityMs: number
  currentTimeMs?: number
}): number {
  const { globalRank, ranks, term, amplifier, eaaRate, maturityMs, currentTimeMs } = params
  if (!globalRank || !ranks.length) return 0
  const penalty = getRewardsPenalty(maturityMs, currentTimeMs)
  let total = 0
  for (const rank of ranks) {
    if (!Number.isSafeInteger(rank) || rank <= 0) continue
    const rankDiff = globalRank - rank
    const rankDiffLog = Number(Math.log2(rankDiff > 1 ? rankDiff : 2).toFixed(4))
    const rewards = rankDiffLog * term * amplifier * (1 + eaaRate / 1000) * penalty
    total += Math.floor(rewards)
  }
  return total
}
