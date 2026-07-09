<script setup lang="ts">
import { onMounted } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import ChromeGuard from '@/components/ChromeGuard.vue'
import MinerView from '@/views/MinerView.vue'

const wallet = useWalletStore()

onMounted(() => {
  wallet.init()
})
</script>

<template>
  <MinerView />
  <ChromeGuard />
</template>
