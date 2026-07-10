<script setup lang="ts">
import { computed } from 'vue'
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
    { label: 'Estimate gas', status: s?.estimate ?? 'wait' },
    { label: 'Send transaction', status: s?.send ?? 'wait' },
    { label: 'Confirm on-chain', status: s?.confirm ?? 'wait' }
  ]
})

const done = computed(() => props.state?.confirm === 'done')
const failed = computed(
  () => props.state?.estimate === 'error' || props.state?.send === 'error' || props.state?.confirm === 'error'
)
const readyToSign = computed(() => !!props.state?.readyToSign && props.state?.estimate === 'done')
const waitingWallet = computed(() => props.state?.send === 'process' && !props.state?.txHash)

function dismiss(): void {
  if (readyToSign.value) emit('cancel')
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
        <strong>{{ title }}</strong>
        <button class="btn btn-ghost" :title="waitingWallet ? 'Hide' : 'Close'" @click="dismiss">x</button>
      </div>
      <hr class="hr" />
      <ul class="steps">
        <li v-for="step in steps" :key="step.label" class="row between">
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

      <p v-if="readyToSign" class="hint-text">
        Gas estimated. Click below to open MetaMask.
        If the popup takes a long time, MetaMask is simulating the tx on its own RPC — open the fox icon, or disable Smart Transactions in MetaMask settings.
      </p>
      <p v-else-if="waitingWallet" class="hint-text">
        Waiting for MetaMask… If no popup after ~10s, click the MetaMask extension icon (it may be simulating in the background).
      </p>
      <p v-if="state?.error" class="err-text">{{ state.error }}</p>
      <p v-if="done" class="ok-text">Transaction confirmed.</p>

      <div class="row" style="margin-top: 14px">
        <a v-if="explorerTxUrl" :href="explorerTxUrl" target="_blank" rel="noreferrer">View on explorer</a>
        <span class="grow" />
        <button v-if="readyToSign" class="btn" @click="emit('cancel')">Cancel</button>
        <button v-else-if="waitingWallet" class="btn" @click="emit('close')">Hide</button>
        <button v-if="readyToSign" class="btn btn-primary" @click="emit('sign')">Open MetaMask &amp; Sign</button>
        <button v-if="done || failed" class="btn btn-primary" @click="emit('close')">Close</button>
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
</style>
