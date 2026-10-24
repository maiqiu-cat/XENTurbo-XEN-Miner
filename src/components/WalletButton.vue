<script setup lang="ts">
import { computed } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import { shortenAddress } from '@/utils/format'
import { t } from '@/i18n'

const wallet = useWalletStore()
const label = computed(() =>
  wallet.isConnected ? shortenAddress(wallet.address as string) : t('Connect Wallet')
)

async function connectWallet() {
  try {
    await wallet.connect()
  } catch {
    // The wallet store owns the user-facing connection error.
  }
}
</script>

<template>
  <button class="btn" :class="{ 'btn-primary': !wallet.isConnected }" @click="connectWallet">
    <span class="mono">{{ label }}</span>
  </button>
</template>
