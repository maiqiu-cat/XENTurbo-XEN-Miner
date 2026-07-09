<script setup lang="ts">
import { computed } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import { shortenAddress } from '@/utils/format'

const wallet = useWalletStore()
const label = computed(() =>
  wallet.isConnected ? shortenAddress(wallet.address as string) : 'Connect Wallet'
)
</script>

<template>
  <button class="btn" :class="{ 'btn-primary': !wallet.isConnected }" @click="wallet.connect()">
    <span class="mono">{{ label }}</span>
  </button>
</template>
