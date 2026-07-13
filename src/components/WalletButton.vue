<script setup lang="ts">
import { computed } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import { shortenAddress } from '@/utils/format'
import { trackAnalyticsEvent } from '@/core/analytics'

const wallet = useWalletStore()
const label = computed(() =>
  wallet.isConnected ? shortenAddress(wallet.address as string) : 'Connect Wallet'
)

async function connectWallet() {
  try {
    await wallet.connect()
  } catch {
    trackAnalyticsEvent('wallet_connect_result', { result: 'error' })
    return
  }

  const result = wallet.isConnected
    ? 'success'
    : /rejected/i.test(wallet.connectError ?? '')
      ? 'rejected'
      : /no injected wallet/i.test(wallet.connectError ?? '')
        ? 'no_wallet'
        : 'error'
  trackAnalyticsEvent('wallet_connect_result', { result })
}
</script>

<template>
  <button class="btn" :class="{ 'btn-primary': !wallet.isConnected }" @click="connectWallet">
    <span class="mono">{{ label }}</span>
  </button>
</template>
