import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue'
import { formatUnits } from 'ethers'
import { ensureRecentReadProvider } from '@/core/rpc'
import type { ChainKey } from '@/config/chains'

// Reads native gas price directly from RPC (no platform price API).
export function useGasPrice(getChain: () => ChainKey | null) {
  const gwei = ref<string>('--')
  const loading = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null
  let active: { chain: ChainKey; promise: Promise<void> } | null = null
  /** Ignore stale responses after a fast chain switch. */
  let reqSeq = 0

  function poll(): Promise<void> {
    const chain = getChain()
    if (!chain) {
      reqSeq += 1
      gwei.value = '--'
      loading.value = false
      return Promise.resolve()
    }
    if (active?.chain === chain) return active.promise

    const seq = ++reqSeq
    loading.value = true
    const promise = (async () => {
      try {
        const provider = await ensureRecentReadProvider(chain, 30_000)
        const fee = await provider.getFeeData()
        if (seq !== reqSeq || getChain() !== chain) return
        const price = fee.gasPrice ?? fee.maxFeePerGas
        gwei.value = price ? formatGwei(Number(formatUnits(price, 'gwei'))) : '--'
      } catch {
        if (seq !== reqSeq || getChain() !== chain) return
        gwei.value = '--'
      } finally {
        if (seq === reqSeq) loading.value = false
      }
    })()
    const flight = { chain, promise }
    active = flight
    const clearFlight = () => {
      if (active === flight) active = null
    }
    void promise.then(clearFlight, clearFlight)
    return promise
  }

  // Adaptive precision: sub-1 Gwei (common on L1 now) must not round to 0.
  function formatGwei(g: number): string {
    if (g <= 0) return '0'
    if (g >= 10) return g.toFixed(0)
    if (g >= 1) return g.toFixed(1)
    if (g >= 0.01) return g.toFixed(3)
    return g.toPrecision(2)
  }

  function onChainChange() {
    // Clear immediately so the previous chain's Gwei never lingers.
    gwei.value = '--'
    void poll()
  }

  const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  const start = () => {
    if (timer) clearInterval(timer)
    timer = null
    if (!pageVisible()) return
    void poll()
    timer = setInterval(() => void poll(), 15_000)
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const onVisibilityChange = () => {
    if (pageVisible()) start()
    else stop()
  }

  onMounted(() => {
    start()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
  })
  onUnmounted(() => {
    stop()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  watch(
    () => getChain(),
    (next, prev) => {
      if (next === prev) return
      onChainChange()
    }
  )

  return { gwei, loading: loading as Ref<boolean>, poll }
}
