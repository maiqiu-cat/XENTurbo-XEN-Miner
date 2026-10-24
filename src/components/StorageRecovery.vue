<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import type { ChainKey } from '@/config/chains'
import { normalizeError } from '@/core/txManager'
import { t, message as localize } from '@/i18n'
import {
  inspectTransactionStorage,
  recoverTransactionStorage,
  storageBackupJson,
  transactionStorageIssues,
  type StorageSnapshot
} from '@/core/storageRecovery'

const props = defineProps<{ chain: ChainKey; wallet: string; disabled: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'open', value: boolean): void }>()
const open = ref(false)
const working = ref(false)
const snapshot = ref<StorageSnapshot | null>(null)
const messageParts = ref<string[]>([])
const message = computed(() => messageParts.value.map((part) => localize(part)).join(' '))
const exported = ref(false)
const acknowledged = ref(false)
const issues = computed(() => (snapshot.value ? transactionStorageIssues(snapshot.value) : []))
const damaged = computed(() => issues.value.reduce((sum, issue) => sum + issue.count, 0))
const damageLabels = {
  'invalid-json': 'Unreadable JSON',
  'not-array': 'Expected a record array',
  'invalid-record': 'Invalid record structure'
}
let controller: AbortController | null = null

function inspect() {
  exported.value = false
  acknowledged.value = false
  snapshot.value = null
  messageParts.value = []
  try {
    snapshot.value = inspectTransactionStorage()
  } catch {
    messageParts.value = [
      'Browser storage is inaccessible. Restore storage access, then inspect again. No records were changed.'
    ]
  }
}
function show() {
  inspect()
  open.value = true
  emit('open', true)
}
function close() {
  controller?.abort()
  open.value = false
  emit('open', false)
}
function download() {
  if (!snapshot.value) return
  const url = URL.createObjectURL(
    new Blob([storageBackupJson(snapshot.value)], { type: 'application/json' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = `xenturbo-transaction-backup-${Date.now()}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
  exported.value = true
}
async function recover() {
  if (working.value || !snapshot.value || !exported.value || !acknowledged.value) return
  working.value = true
  const active = new AbortController()
  controller = active
  const timer = setTimeout(() => active.abort(), 30_000)
  messageParts.value = ['Verifying damaged records through the connected wallet...']
  try {
    const result = await recoverTransactionStorage(
      snapshot.value,
      props.chain,
      props.wallet,
      active.signal
    )
    if (active.signal.aborted) return
    inspect()
    messageParts.value = [
      `${result.repaired} settled record(s) archived and repaired. ${result.blocked} record(s) remain blocked. Unidentified or unconfirmed records are never discarded.`
    ]
    const reasons = result.blockedReasons
    const details = [
      reasons.unidentified &&
        `${reasons.unidentified} missing or unreadable transaction identities.`,
      reasons.otherContext && `${reasons.otherContext} belong to another account or network.`,
      reasons.unconfirmed && `${reasons.unconfirmed} without a matching mined receipt.`,
      reasons.readLimit &&
        `${reasons.readLimit} deferred by the 20-record verification limit; inspect again to continue.`
    ].filter(Boolean)
    messageParts.value.push(
      ...details.filter((detail): detail is string => typeof detail === 'string')
    )
  } catch (error) {
    if (!open.value) return
    messageParts.value = [
      active.signal.aborted
        ? 'Recovery cancelled or timed out. Inspect again; no unverified records were removed.'
        : error instanceof Error
          ? normalizeError(error, 'storage-recovery')
          : 'Recovery failed. Original records were retained.'
    ]
  } finally {
    clearTimeout(timer)
    working.value = false
    emit('changed')
  }
}
watch(() => [props.chain, props.wallet], close, { flush: 'sync' })
onScopeDispose(close)
</script>

<template>
  <button class="btn btn-ghost recovery-entry" :disabled="disabled" @click="show">
    {{ t('Transaction storage recovery') }}
  </button>
  <Teleport to="body">
    <div v-if="open" class="recovery-mask" @click.self="close">
      <section
        class="card recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
      >
        <div class="row between">
          <strong id="recovery-title">{{ t('Transaction storage recovery') }}</strong>
          <button
            class="btn btn-ghost"
            :aria-label="t('Close recovery')"
            :title="t('Close recovery')"
            @click="close"
          >
            ×
          </button>
        </div>
        <p>
          {{
            t('Damaged records: {count}. Mining stays blocked until transaction checks succeed.', {
              count: damaged
            })
          }}
        </p>
        <ul v-if="issues.length" class="recovery-issues">
          <li v-for="issue in issues" :key="issue.key">
            <code>{{ issue.key }}</code
            >: {{ localize(damageLabels[issue.kind]) }} ({{ issue.count }})
          </li>
        </ul>
        <p class="dim">
          {{
            t(
              'Keep the backup private. It contains wallet addresses and transaction history. Do not clear site data or resend transactions.'
            )
          }}
        </p>
        <p class="dim">
          {{
            t(
              'Only damaged records with a matching mined receipt from your connected wallet can be repaired. Unreadable JSON, missing identity, pending transactions and other accounts remain blocked.'
            )
          }}
        </p>
        <p class="dim">
          {{
            t(
              'Damaged records without a transaction hash cannot be verified here. Keep their exported backup for manual investigation. While such records remain, mining stays blocked for this site in this browser profile.'
            )
          }}
        </p>
        <label class="recovery-ack"
          ><input v-model="acknowledged" type="checkbox" :disabled="working" />{{
            t('I have checked wallet Activity and retained the downloaded backup.')
          }}</label
        >
        <p role="status" aria-live="polite" class="recovery-message">{{ message }}</p>
        <div class="row wrap recovery-actions">
          <button class="btn" :disabled="working" @click="inspect">{{ t('Inspect again') }}</button>
          <button class="btn" :disabled="working || !snapshot" @click="download">
            {{ t('Export backup') }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="working || !damaged || !exported || !acknowledged"
            @click="recover"
          >
            {{ working ? t('Verifying...') : t('Verify and repair') }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.recovery-entry {
  margin: 8px 0 16px;
}
.recovery-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: grid;
  place-items: center;
  z-index: 70;
  padding: 16px;
}
.recovery-dialog {
  width: min(100%, 580px);
  max-height: 90dvh;
  overflow-y: auto;
  border-radius: 8px;
}
.recovery-dialog p {
  line-height: 1.5;
}
.recovery-message {
  overflow-wrap: anywhere;
  min-height: 24px;
}
.recovery-issues {
  overflow-wrap: anywhere;
  padding-left: 20px;
  max-height: 120px;
  overflow-y: auto;
}
.recovery-ack {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.recovery-actions {
  gap: 8px;
}
</style>
