import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue'
import { formatUnits } from 'ethers'
import { ensureHealthyReadProvider } from '@/core/rpc'
import type { ChainKey } from '@/config/chains'

// Reads native gas price directly from RPC (no platform price API).
export function useGasPrice(getChain: () => ChainKey | null) {
  const gwei = ref<string>('--')
  const loading = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null
  /** Ignore stale responses after a fast chain switch. */
  let reqSeq = 0

  async function poll() {
    const chain = getChain()
    const seq = ++reqSeq
    if (!chain) {
      gwei.value = '--'
      loading.value = false
      return
    }
    loading.value = true
    try {
      const provider = await ensureHealthyReadProvider(chain)
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

  onMounted(() => {
    void poll()
    timer = setInterval(() => void poll(), 15_000)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
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
