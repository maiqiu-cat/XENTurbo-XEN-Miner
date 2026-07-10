import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ChainKey } from '@/config/chains'
import { refreshPendingOps, trackPendingTxHash, type PendingOpView } from '@/core/pendingOps'

/**
 * Poll the chain for in-flight txs and surface decoded mint/claim/remint ops.
 * Blocks submits while pendingNonce > latestNonce (EIP-7702 / Infura limit).
 */
export function usePendingTx(
  address: () => string | null | undefined,
  chain: () => ChainKey | null | undefined
) {
  const pendingCount = ref(0)
  const localUnresolvedCount = ref(0)
  const ops = ref<PendingOpView[]>([])
  const checking = ref(false)
  const lastCheckedAt = ref<number | null>(null)
  const error = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null
  let gen = 0

  async function check(): Promise<number> {
    const addr = address()
    const key = chain()
    if (!addr || !key) {
      pendingCount.value = 0
      localUnresolvedCount.value = 0
      ops.value = []
      return 0
    }
    const myGen = ++gen
    checking.value = true
    error.value = null
    try {
      const { views, pendingNonceGap, unresolvedCount } = await refreshPendingOps(key, addr)
      if (myGen !== gen) return pendingCount.value
      pendingCount.value = pendingNonceGap
      localUnresolvedCount.value = unresolvedCount
      ops.value = views
      lastCheckedAt.value = Date.now()
      return pendingNonceGap
    } catch (err: any) {
      if (myGen !== gen) return pendingCount.value
      error.value = err?.shortMessage || err?.message || 'Failed to check pending txs'
      return pendingCount.value
    } finally {
      if (myGen === gen) checking.value = false
    }
  }

  function startPolling() {
    stopPolling()
    void check()
    timer = setInterval(() => {
      void check()
    }, 8_000)
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  watch(
    [() => address(), () => chain()],
    ([addr, key]) => {
      if (addr && key) startPolling()
      else {
        stopPolling()
        pendingCount.value = 0
        localUnresolvedCount.value = 0
        ops.value = []
      }
    },
    { immediate: true }
  )

  onUnmounted(stopPolling)

  const hasPending = computed(
    () => pendingCount.value > 0 || localUnresolvedCount.value > 0
  )

  async function trackHash(txHash: string, seenText?: string): Promise<void> {
    const addr = address()
    const key = chain()
    if (!addr || !key) throw new Error('Connect wallet first')
    await trackPendingTxHash(key, addr, txHash, seenText)
    await check()
  }

  return {
    pendingCount: pendingCount as Ref<number>,
    localUnresolvedCount: localUnresolvedCount as Ref<number>,
    ops: ops as Ref<PendingOpView[]>,
    hasPending,
    checking,
    lastCheckedAt,
    error,
    check,
    trackHash,
    startPolling,
    stopPolling
  }
}
