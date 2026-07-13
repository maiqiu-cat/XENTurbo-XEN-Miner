<script setup lang="ts">
import { ref } from 'vue'
import { analytics, type AnalyticsConsent } from '@/core/analytics'

const available = analytics.isAvailable()
const decision = ref<AnalyticsConsent | null>(available ? analytics.getConsent() : null)
const open = ref(available && decision.value === null)
const busy = ref(false)
const error = ref<string | null>(null)

async function allowAnalytics() {
  busy.value = true
  error.value = null
  try {
    await analytics.grant()
    decision.value = 'granted'
    open.value = false
  } catch {
    error.value = 'Analytics could not be enabled. The Miner remains fully available.'
  } finally {
    busy.value = false
  }
}

function denyAnalytics() {
  analytics.deny()
  decision.value = 'denied'
  error.value = null
  open.value = false
}
</script>

<template>
  <div v-if="available" class="analytics-control">
    <button
      v-if="!open"
      class="analytics-settings"
      type="button"
      data-consent="settings"
      @click="open = true"
    >
      Analytics settings
    </button>

    <aside
      v-if="open"
      class="analytics-consent"
      role="dialog"
      aria-labelledby="analytics-consent-title"
      aria-describedby="analytics-consent-description"
    >
      <div class="analytics-consent__inner">
        <div class="analytics-consent__copy">
          <strong id="analytics-consent-title">Optional usage analytics</strong>
          <p id="analytics-consent-description">
            Google Analytics loads only if you allow it. It may use a first-party cookie and receive
            basic device and network information. Our custom events never include wallet addresses,
            transaction hashes, RPC URLs, form values, or error details.
            <a
              href="https://policies.google.com/technologies/partner-sites"
              target="_blank"
              rel="noreferrer"
            >
              How Google uses data
            </a>
          </p>
          <p v-if="error" class="analytics-consent__error" role="status">{{ error }}</p>
        </div>
        <div class="analytics-consent__actions">
          <button
            class="btn"
            type="button"
            data-consent="deny"
            :disabled="busy"
            @click="denyAnalytics"
          >
            No thanks
          </button>
          <button
            class="btn btn-primary"
            type="button"
            data-consent="grant"
            :disabled="busy"
            @click="allowAnalytics"
          >
            {{ busy ? 'Enabling...' : 'Allow analytics' }}
          </button>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.analytics-control {
  display: inline-flex;
  align-items: center;
}

.analytics-settings {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.analytics-settings:hover {
  color: var(--text);
}

.analytics-consent {
  position: fixed;
  z-index: 900;
  right: 0;
  bottom: 0;
  left: 0;
  border-top: 1px solid var(--border);
  background: #10151d;
  box-shadow: 0 -16px 48px rgba(0, 0, 0, 0.36);
  color: var(--text);
  text-align: left;
}

.analytics-consent__inner {
  display: flex;
  max-width: 1080px;
  margin: 0 auto;
  padding: 18px 16px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.analytics-consent__copy {
  min-width: 0;
}

.analytics-consent__copy strong {
  display: block;
  margin-bottom: 4px;
  font-size: 15px;
}

.analytics-consent__copy p {
  max-width: 720px;
  margin: 0;
  color: var(--text-dim);
  line-height: 1.5;
}

.analytics-consent__error {
  margin-top: 6px !important;
  color: var(--danger) !important;
}

.analytics-consent__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 10px;
}

@media (max-width: 720px) {
  .analytics-consent__inner {
    align-items: stretch;
    flex-direction: column;
    gap: 14px;
  }

  .analytics-consent__actions .btn {
    flex: 1 1 0;
  }
}
</style>
