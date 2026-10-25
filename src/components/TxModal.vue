<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { t, message } from '@/i18n'
import type { TxStepState } from '@/core/txManager'
import { CHAINS, type ChainKey } from '@/config/chains'

const props = defineProps<{
  visible: boolean
  state: TxStepState | null
  chain: ChainKey | null
  title: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'cancel'): void
  (e: 'sign'): void
}>()

const explorerTxUrl = computed(() => {
  if (!props.chain || !props.state?.txHash) return null
  return `${CHAINS[props.chain].blockExplorerUrl}/tx/${props.state.txHash}`
})

const steps = computed(() => {
  const s = props.state
  return [
    { id: 'estimate', label: t('Estimate gas'), status: s?.estimate ?? 'wait' },
    { id: 'send', label: t('Send transaction'), status: s?.send ?? 'wait' },
    { id: 'confirm', label: t('Confirm on-chain'), status: s?.confirm ?? 'wait' }
  ]
})

const done = computed(() => props.state?.confirm === 'done')
const failed = computed(
  () => props.state?.estimate === 'error' || props.state?.send === 'error' || props.state?.confirm === 'error'
)
const readyToSign = computed(() => !!props.state?.readyToSign && props.state?.estimate === 'done')
const waitingWallet = computed(
  () => !!props.state?.walletPrompted && props.state?.send === 'process' && !props.state?.txHash
)
const preparing = computed(
  () =>
    !props.state?.txHash &&
    !props.state?.walletPrompted &&
    ((props.state?.send === 'wait' && (props.state?.estimate === 'wait' || props.state?.estimate === 'process')) ||
      props.state?.send === 'process')
)
const logList = ref<HTMLOListElement | null>(null)

watch(
  () => props.state?.logs?.length,
  async () => {
    await nextTick()
    if (logList.value) logList.value.scrollTop = logList.value.scrollHeight
  }
)

function formatLogTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function formatAffected(ids: number[], count: number): string {
  if (!count) return '0'
  if (!ids.length) return t('{count} (ids unavailable)', { count })
  const shown = ids.slice(0, 8)
  const remaining = count - shown.length
  return t('{count} ({unit} {ids}{more})', { count, unit: t(count === 1 ? 'VMU' : 'VMUs'), ids: shown.join(', '), more: remaining > 0 ? t(', +{count} more', { count: remaining }) : '' })
}

const outcomeMessage = computed(() => {
  const outcome = props.state?.outcome
  if (!outcome) return null
  if (outcome.classification === 'full') {
    return t('Verified full result: {matched}/{expected} VMUs are {status}.', { matched: outcome.matchingCount, expected: outcome.expectedCount, status: message(outcome.expectedStatus) })
  }

  const details = [t('{matched}/{expected} matched', { matched: outcome.matchingCount, expected: outcome.expectedCount })]
  if (outcome.unexpectedCount) {
    details.push(t('unexpected {details}', { details: formatAffected(outcome.unexpectedIds, outcome.unexpectedCount) }))
  }
  if (outcome.readErrorCount) {
    details.push(t('read failed for {details}', { details: formatAffected(outcome.readErrorIds, outcome.readErrorCount) }))
  }
  const prefix =
    outcome.classification === 'partial'
      ? t('Confirmed with partial result')
      : t('Confirmed, result uncertain')
  return `${prefix}: ${details.join('; ')}.`
})

function dismiss(): void {
  if (readyToSign.value || preparing.value) emit('cancel')
  else emit('close')
}

function icon(status: string): string {
  if (status === 'done') return 'OK'
  if (status === 'process') return '...'
  if (status === 'error') return 'X'
  return '-'
}
</script>

<template>
  <div v-if="visible" class="modal-mask">
    <div class="card modal-body">
      <div class="row between">
        <strong>{{ message(title) }}</strong>
        <button
          class="btn btn-ghost"
          :title="waitingWallet ? t('Hide') : preparing || readyToSign ? t('Cancel') : t('Close')"
          :aria-label="waitingWallet ? t('Hide transaction dialog') : preparing || readyToSign ? t('Cancel transaction preparation') : t('Close transaction dialog')"
          @click="dismiss"
        >
          x
        </button>
      </div>
      <hr class="hr" />
      <ul class="steps">
        <li v-for="step in steps" :key="step.id" class="row between">
          <span>{{ step.label }}</span>
          <span
            class="step-icon"
            :class="{
              ok: step.status === 'done',
              run: step.status === 'process',
              err: step.status === 'error'
            }"
            >{{ icon(step.status) }}</span
          >
        </li>
      </ul>

      <section
        v-if="state?.logs?.length"
        data-testid="tx-log"
        class="tx-log"
        :aria-label="t('Transaction activity')"
        aria-live="polite"
      >
        <div class="tx-log-title">{{ t('Activity') }}</div>
        <ol ref="logList">
          <li
            v-for="(entry, index) in state.logs"
            :key="`${entry.at}-${index}`"
            data-testid="tx-log-entry"
            :class="entry.status"
          >
            <time :datetime="new Date(entry.at).toISOString()">{{ formatLogTime(entry.at) }}</time>
            <span class="tx-log-marker">{{ icon(entry.status) }}</span>
            <span>{{ message(entry.message) }}</span>
          </li>
        </ol>
      </section>

      <p v-if="readyToSign" class="hint-text">
        {{ t('Gas estimated. Click below to open MetaMask. If the popup takes a long time, MetaMask is simulating the tx on its own RPC — open the fox icon, or disable Smart Transactions in MetaMask settings.') }}
      </p>
      <p v-else-if="waitingWallet" class="hint-text">
        {{ t('Waiting for MetaMask… If no popup after ~10s, click the MetaMask extension icon (it may be simulating in the background).') }}
      </p>
      <p v-if="state?.error" class="err-text">{{ message(state.error) }}</p>
      <p
        v-if="done && outcomeMessage"
        class="outcome-text"
        :class="state?.outcome?.classification"
      >
        {{ outcomeMessage }}
      </p>
      <p v-else-if="done" class="ok-text">{{ t('Transaction confirmed.') }}</p>

      <div class="row" style="margin-top: 14px">
        <a v-if="explorerTxUrl" :href="explorerTxUrl" target="_blank" rel="noreferrer">{{ t('View on explorer') }}</a>
        <span class="grow" />
        <button v-if="readyToSign || preparing" class="btn" @click="emit('cancel')">{{ t('Cancel') }}</button>
        <button v-else-if="waitingWallet" class="btn" @click="emit('close')">{{ t('Hide') }}</button>
        <button v-if="readyToSign" class="btn btn-primary" @click="emit('sign')">{{ t('Open MetaMask & Sign') }}</button>
        <button v-if="done || failed" class="btn btn-primary" @click="emit('close')">{{ t('Close') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.modal-body {
  width: 420px;
  max-width: 92vw;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.step-icon {
  font-weight: 700;
  color: var(--text-dim);
}
.step-icon.ok {
  color: var(--accent);
}
.step-icon.run {
  color: var(--warn);
}
.step-icon.err {
  color: var(--danger);
}
.tx-log {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.tx-log-title {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}
.tx-log ol {
  list-style: none;
  margin: 8px 0 0;
  padding: 0 4px 0 0;
  max-height: 180px;
  overflow-y: auto;
}
.tx-log li {
  display: grid;
  grid-template-columns: 62px 24px minmax(0, 1fr);
  gap: 6px;
  align-items: start;
  padding: 5px 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.tx-log li.process {
  color: var(--warn);
}
.tx-log li.error {
  color: var(--danger);
}
.tx-log li.info {
  color: var(--warn);
}
.tx-log time {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.tx-log-marker {
  font-weight: 700;
  text-align: center;
}
.hint-text {
  color: var(--warn);
  margin-top: 14px;
  font-size: 13px;
  line-height: 1.45;
}
.err-text {
  color: var(--danger);
  margin-top: 14px;
}
.ok-text {
  color: var(--accent);
  margin-top: 14px;
}
.outcome-text {
  color: var(--accent);
  margin-top: 14px;
  line-height: 1.45;
}
.outcome-text.partial,
.outcome-text.uncertain {
  color: var(--warn);
}
</style>
