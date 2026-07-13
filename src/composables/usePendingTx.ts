import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ChainKey } from '@/config/chains'
import {
  canMarkPendingOpDropped,
  markPendingOpDropped,
  refreshPendingOps,
  trackPendingTxHash,
  type PendingOpView
} from '@/core/pendingOps'

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

  let timer: ReturnType<typeof setTimeout> | null = null
  let gen = 0
  let active: { generation: number; promise: Promise<number> } | null = null
  let trailing = false
  const activePollMs = 8_000
  const idlePollMs = 30_000

  const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  function resetState(): void {
    checking.value = false
    pendingCount.value = 0
    localUnresolvedCount.value = 0
    ops.value = []
  }

  function check(options: { freshRpc?: boolean } = {}): Promise<number> {
    const addr = address()
    const key = chain()
    if (!addr || !key) {
      resetState()
      return Promise.resolve(0)
    }
    const myGen = gen
    if (active?.generation === myGen) {
      trailing = true
      return active.promise
    }

    checking.value = true
    error.value = null
    const promise = refreshPendingOps(key, addr, options)
      .then(({ views, pendingNonceGap, unresolvedCount }) => {
        if (myGen !== gen) return pendingCount.value
        pendingCount.value = pendingNonceGap
        localUnresolvedCount.value = unresolvedCount
        ops.value = views
        lastCheckedAt.value = Date.now()
        return pendingNonceGap
      })
      .catch((err: any) => {
        if (myGen !== gen) return pendingCount.value
        error.value = err?.shortMessage || err?.message || 'Failed to check pending txs'
        return pendingCount.value
      })
      .finally(() => {
        if (active?.promise === promise) active = null
        if (myGen !== gen) return
        checking.value = false
        if (trailing) {
          trailing = false
          void check()
        }
      })
    active = { generation: myGen, promise }
    return promise
  }

  function startPolling() {
    stopPolling()
    const pollGen = gen
    const poll = async () => {
      if (!pageVisible()) return
      await check({ freshRpc: false })
      if (pollGen !== gen || !pageVisible()) return
      const delay =
        pendingCount.value > 0 || localUnresolvedCount.value > 0 ? activePollMs : idlePollMs
      timer = setTimeout(() => void poll(), delay)
    }
    if (pageVisible()) void poll()
  }

  function stopPolling() {
    gen += 1
    trailing = false
    checking.value = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const onVisibilityChange = () => {
    if (!address() || !chain()) return
    if (pageVisible()) startPolling()
    else stopPolling()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  watch(
    [() => address(), () => chain()],
    ([addr, key]) => {
      if (addr && key) startPolling()
      else {
        stopPolling()
        resetState()
      }
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    stopPolling()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  const hasPending = computed(() => pendingCount.value > 0 || localUnresolvedCount.value > 0)

  async function trackHash(txHash: string, seenText?: string): Promise<void> {
    const addr = address()
    const key = chain()
    if (!addr || !key) throw new Error('Connect wallet first')
    await trackPendingTxHash(key, addr, txHash, seenText)
    await check()
  }

  async function markDropped(id: string): Promise<void> {
    const candidate = ops.value.find((op) => op.id === id)
    if (!candidate || !canMarkPendingOpDropped(candidate)) {
      throw new Error(
        'Only an unresolved transaction with unknown chain status can be marked dropped'
      )
    }
    const dropped = markPendingOpDropped(id)
    if (!dropped) throw new Error('Pending transaction record no longer exists')
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
    markDropped,
    startPolling,
    stopPolling
  }
}
