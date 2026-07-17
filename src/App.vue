<script setup lang="ts">
import { onMounted } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import ChromeGuard from '@/components/ChromeGuard.vue'
import MinerView from '@/views/MinerView.vue'
import { analytics } from '@/core/analytics'

const wallet = useWalletStore()

onMounted(() => {
  void wallet.init()
  void analytics.grant().catch(() => {})
})
</script>

<template>
  <MinerView />
  <ChromeGuard />
</template>
