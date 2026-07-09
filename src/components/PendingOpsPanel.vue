<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { PendingOpView } from '@/core/pendingOps'

const props = defineProps<{
  ops: PendingOpView[]
  pendingCount: number
  checking: boolean
}>()
const emit = defineEmits<{
  (e: 'recheck'): void
  (e: 'track', payload: { hash: string; seenText?: string }): void
}>()

const pasteHash = ref('')
const pasteSeen = ref('')
const pasteError = ref<string | null>(null)

/** Tick so "pending for Xm" updates without waiting for the 8s poll. */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tick = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (tick) clearInterval(tick)
})

function shortHash(h: string): string {
  if (!h) return 'hash unavailable'
  if (h.length < 12) return h
  return `${h.slice(0, 10)}…${h.slice(-8)}`
}

/**
 * Duration since explorer First/Last Seen (or local first-seen).
 * Pending txs have no block timestamp; explorers index when they observed the tx.
 */
function pendingFor(submittedAt: number): string {
  const s = Math.max(0, Math.floor((now.value - submittedAt) / 1000))
  if (s < 60) return `pending ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `pending ${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `pending ${h}h ${m % 60}m`
}

function seenAt(submittedAt: number): string {
  try {
    return new Date(submittedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  } catch {
    return ''
  }
}

function submitHash() {
  pasteError.value = null
  const h = pasteHash.value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    pasteError.value = 'Paste a full 0x… transaction hash (66 chars)'
    return
  }
  const seen = pasteSeen.value.trim()
  emit('track', { hash: h, seenText: seen || undefined })
  pasteHash.value = ''
  pasteSeen.value = ''
}

const needsHash =
  () => props.pendingCount > 0 && props.ops.every((o) => !o.txHash || o.id === 'unknown-pending')
</script>

<template>
  <div class="card pending-panel">
    <div class="row between wrap" style="gap: 10px; margin-bottom: 10px">
      <strong>
        Pending on-chain
        <span class="dim" style="font-weight: 400">
          · {{ pendingCount }} in-flight nonce{{ pendingCount === 1 ? '' : 's' }}
        </span>
      </strong>
      <button class="btn" :disabled="checking" @click="emit('recheck')">
        {{ checking ? 'Checking…' : 'Recheck' }}
      </button>
    </div>

    <p class="dim intro">
      Submits are blocked while a nonce is in-flight. Age uses Etherscan’s First/Last Seen
      (browser index time for pending txs — not a block timestamp).
      Stuck? MetaMask → Activity → Speed up / Cancel.
    </p>

    <ul v-if="ops.length" class="ops">
      <li v-for="op in ops" :key="op.txHash || op.id" class="op-row">
        <div class="row between wrap" style="gap: 8px">
          <div class="op-main">
            <div class="row wrap" style="gap: 8px; align-items: center">
              <span class="tag tag-warn">{{ op.label }}</span>
              <span class="tag tag-dim">{{ op.status }}</span>
            </div>
            <div class="detail mono">{{ op.detail || '—' }}</div>
          </div>
          <div class="age-box">
            <span class="age">{{ pendingFor(op.submittedAt) }}</span>
            <span class="dim seen" :title="'Explorer First/Last Seen (indexed pending time)'">
              {{ seenAt(op.submittedAt) }}
            </span>
          </div>
        </div>
        <div class="row wrap hash-row">
          <span class="dim">Tx</span>
          <a
            v-if="op.txHash"
            :href="op.explorerUrl"
            target="_blank"
            rel="noreferrer"
            class="mono hash"
          >
            {{ shortHash(op.txHash) }}
          </a>
          <a v-else :href="op.explorerUrl" target="_blank" rel="noreferrer" class="dim">
            View address on explorer
          </a>
        </div>
      </li>
    </ul>

    <div class="paste-box" :class="{ 'paste-only': !ops.length }">
      <p class="dim paste-label">
        {{
          needsHash()
            ? 'Details missing — paste the pending tx hash from MetaMask / Etherscan:'
            : ops.length
              ? 'Or paste another pending tx hash:'
              : 'Paste a pending tx hash to show explorer First/Last Seen time:'
        }}
      </p>
      <div class="row wrap" style="gap: 8px">
        <input
          class="input mono paste-input"
          v-model="pasteHash"
          placeholder="0x…"
          spellcheck="false"
          @keyup.enter="submitHash"
        />
        <button class="btn btn-primary" @click="submitHash">Track</button>
      </div>
      <input
        class="input paste-seen"
        v-model="pasteSeen"
        placeholder="Optional: paste Etherscan Time Last Seen, e.g. Jul-09-2026 05:53:45 AM UTC"
        spellcheck="false"
        @keyup.enter="submitHash"
      />
      <p v-if="pasteError" class="paste-err">{{ pasteError }}</p>
    </div>
  </div>
</template>

<style scoped>
.pending-panel {
  border-color: var(--warn);
  background: rgba(255, 176, 32, 0.08);
  margin-bottom: 16px;
}
.intro {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.4;
}
.ops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.op-row {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
}
.op-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail {
  font-size: 13px;
}
.age-box {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.age {
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: var(--warn);
}
.seen {
  font-size: 11px;
  white-space: nowrap;
}
.hash-row {
  margin-top: 8px;
  gap: 8px;
  align-items: center;
}
.hash {
  font-size: 12px;
}
.paste-box {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.paste-box.paste-only {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
.paste-label {
  margin: 0 0 8px;
  font-size: 12px;
}
.paste-input {
  flex: 1;
  min-width: 220px;
}
.paste-seen {
  width: 100%;
  margin-top: 8px;
  font-size: 12px;
}
.paste-err {
  margin: 8px 0 0;
  color: var(--danger);
  font-size: 12px;
}
</style>
