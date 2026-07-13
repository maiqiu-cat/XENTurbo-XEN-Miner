<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { checkBrowserSupport, type BrowserNavigator } from '@/core/browserGuard'
import { trackAnalyticsEvent } from '@/core/analytics'

const supported = ref(true)
const message = ref('XENTurbo XEN Miner requires Google Chrome.')

onMounted(() => {
  const result = checkBrowserSupport(navigator as unknown as BrowserNavigator)
  supported.value = result.supported
  message.value = result.message
  if (!result.supported && result.reason) {
    trackAnalyticsEvent('browser_guard_shown', { reason: result.reason })
  }
})
</script>

<template>
  <div
    v-if="!supported"
    class="chrome-guard"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="chrome-guard-title"
  >
    <div class="chrome-guard__panel">
      <p id="chrome-guard-title" class="chrome-guard__title">Please use PC Chrome</p>
      <p class="chrome-guard__body">
        {{ message }}
      </p>
      <a
        class="btn btn-primary chrome-guard__action"
        href="https://www.google.com/chrome/"
        target="_blank"
        rel="noreferrer"
      >
        Get Chrome
      </a>
    </div>
  </div>
</template>

<style scoped>
.chrome-guard {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(5, 7, 10, 0.86);
  backdrop-filter: blur(10px);
}

.chrome-guard__panel {
  width: min(420px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 24px;
  text-align: center;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
}

.chrome-guard__title {
  margin: 0 0 10px;
  color: var(--text);
  font-size: 20px;
  font-weight: 700;
}

.chrome-guard__body {
  margin: 0;
  color: var(--text-dim);
  line-height: 1.5;
}

.chrome-guard__action {
  display: inline-flex;
  justify-content: center;
  margin-top: 18px;
}
</style>
