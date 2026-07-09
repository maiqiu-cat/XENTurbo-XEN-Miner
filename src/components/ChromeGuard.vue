<script setup lang="ts">
import { onMounted, ref } from 'vue'

const supported = ref(true)
const message = ref('XENTurbo XEN Miner requires Google Chrome.')

interface BrowserCheck {
  supported: boolean
  message: string
}

function checkBrowser(): BrowserCheck {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }>; mobile?: boolean }
    brave?: unknown
  }
  const ua = nav.userAgent
  const name = detectName(ua)

  if (isMobileEnvironment(nav, ua)) {
    return {
      supported: false,
      message: 'Mobile browsers are not supported. Open this site on a desktop or laptop with Google Chrome.'
    }
  }

  if (isGoogleChrome(nav, ua)) {
    return {
      supported: true,
      message: ''
    }
  }

  return {
    supported: false,
    message: `XENTurbo XEN Miner requires PC Google Chrome. You are currently using ${name}.`
  }
}

function isGoogleChrome(
  nav: Navigator & { userAgentData?: { brands?: Array<{ brand: string; version: string }> }; brave?: unknown },
  ua: string
): boolean {
  const brands = nav.userAgentData?.brands ?? []
  if (brands.some((b) => b.brand === 'Google Chrome')) return true

  const looksLikeChrome = /Chrome\/|CriOS\//.test(ua)
  const excluded = /Edg\/|EdgiOS\/|OPR\/|Opera|SamsungBrowser|DuckDuckGo|YaBrowser|Firefox\/|FxiOS\//.test(ua)
  if (typeof nav.brave !== 'undefined') return false
  return looksLikeChrome && !excluded
}

function isMobileEnvironment(
  nav: Navigator & { userAgentData?: { mobile?: boolean } },
  ua: string
): boolean {
  if (nav.userAgentData?.mobile) return true
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua)) return true
  // iPadOS can present a desktop Safari UA.
  return /Macintosh/i.test(ua) && nav.maxTouchPoints > 1
}

function detectName(ua: string): string {
  if (/Edg\/|EdgiOS\//.test(ua)) return 'Microsoft Edge'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/SamsungBrowser/.test(ua)) return 'Samsung Browser'
  if (/Safari\//.test(ua) && !/Chrome\/|CriOS\//.test(ua)) return 'Safari'
  return 'this browser'
}

onMounted(() => {
  const result = checkBrowser()
  supported.value = result.supported
  message.value = result.message
})
</script>

<template>
  <div v-if="!supported" class="chrome-guard" role="alertdialog" aria-modal="true" aria-labelledby="chrome-guard-title">
    <div class="chrome-guard__panel">
      <p id="chrome-guard-title" class="chrome-guard__title">Please use PC Chrome</p>
      <p class="chrome-guard__body">
        {{ message }}
      </p>
      <a class="btn btn-primary chrome-guard__action" href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
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
