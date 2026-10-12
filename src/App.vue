<script setup lang="ts">
import { onMounted } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import ChromeGuard from '@/components/ChromeGuard.vue'
import MinerView from '@/views/MinerView.vue'
import { loadCloudflareAnalytics } from '@/core/cloudflareAnalytics'

const wallet = useWalletStore()

onMounted(() => {
  void wallet.init()
  loadCloudflareAnalytics()
})
</script>

<template>
  <MinerView />
  <ChromeGuard />
</template>
