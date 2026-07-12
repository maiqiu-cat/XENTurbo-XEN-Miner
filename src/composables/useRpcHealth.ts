import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { getRpcHealthState, onRpcHealthChange, type RpcHealthState } from '@/core/rpc'
import type { ChainKey } from '@/config/chains'

export function useRpcHealth(getChain: () => ChainKey) {
  const state = ref<RpcHealthState>(getRpcHealthState(getChain()))

  const sync = () => {
    state.value = getRpcHealthState(getChain())
  }
  const unsubscribe = onRpcHealthChange((chain, nextState) => {
    if (chain === getChain()) state.value = nextState
  })

  watch(getChain, sync)
  onScopeDispose(unsubscribe)

  const unavailable = computed(
    () =>
      state.value.error !== null ||
      (state.value.checkedAt !== null && state.value.healthyUrls.length === 0)
  )

  return {
    state: state as Ref<RpcHealthState>,
    unavailable
  }
}
