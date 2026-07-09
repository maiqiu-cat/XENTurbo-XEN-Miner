<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVmuStore } from '@/stores/vmuStore'
import { useWalletStore } from '@/stores/walletStore'
import type { VmuGroup } from '@/core/types'
import { LIMITS, DEFAULT_TERM, DEFAULT_TERM_MAX } from '@/config/miner'
import { formatDate, countdownTo, thousands } from '@/utils/format'

const props = defineProps<{
  busy: boolean
  /** When set, claim actions stay disabled and this reason is shown. */
  blockedReason?: string | null
}>()
const emit = defineEmits<{
  (e: 'claim', ids: number[]): void
  (e: 'claim-reuse', ids: number[], term: number): void
}>()

const store = useVmuStore()
const wallet = useWalletStore()
type Filter = 'ALL' | 'CLAIMABLE' | 'MINTING'
const filter = ref<Filter>('ALL')

/** Term used for the next Claim & Re-Mint — edited next to the action button. */
const reuseTerm = ref(DEFAULT_TERM)

function clampReuseTerm() {
  const n = reuseTerm.value
  if (!Number.isFinite(n)) {
    reuseTerm.value = DEFAULT_TERM
    return
  }
  reuseTerm.value = Math.min(Math.max(1, Math.floor(n)), DEFAULT_TERM_MAX)
}

const claimLimit = computed(() => {
  const key = wallet.chainKey
  return key ? LIMITS[key].claim : LIMITS.eth.claim
})
const claimReuseLimit = computed(() => {
  const key = wallet.chainKey
  return key ? LIMITS[key].claimAndReuse : LIMITS.eth.claimAndReuse
})

const list = computed<VmuGroup[]>(() => {
  if (filter.value === 'CLAIMABLE') return store.claimableGroups
  if (filter.value === 'MINTING') return store.mintingGroups
  return store.groups
})

// Rows are grouped by (term, maturity), so the number of rows can be smaller
// than the number of VMUs. Surface both so the header count reconciles.
const vmuTotal = computed(() => list.value.reduce((sum, g) => sum + g.count, 0))

const selected = ref<Set<string>>(new Set())

function toggle(g: VmuGroup) {
  if (g.status !== 'CLAIMABLE') return
  const next = new Set(selected.value)
  if (next.has(g.key)) {
    next.delete(g.key)
  } else {
    // Cap selection so Claim / Claim&Re-Mint stay within LIMITS.
    const would = selectedIdsFor(next).length + g.count
    const max = Math.max(claimLimit.value, claimReuseLimit.value)
    if (would > max) return
    next.add(g.key)
  }
  selected.value = next
}

function selectedIdsFor(keys: Set<string>): number[] {
  const ids: number[] = []
  for (const g of store.claimableGroups) {
    if (keys.has(g.key)) ids.push(...g.ids)
  }
  return Array.from(new Set(ids))
}

const selectedIds = computed(() => selectedIdsFor(selected.value))

const overClaim = computed(() => selectedIds.value.length > claimLimit.value)
const overReuse = computed(() => selectedIds.value.length > claimReuseLimit.value)

function clearSel() {
  selected.value = new Set()
}

function doClaim() {
  if (overClaim.value) return
  emit('claim', selectedIds.value)
}
function doClaimReuse() {
  if (overReuse.value) return
  clampReuseTerm()
  emit('claim-reuse', selectedIds.value, reuseTerm.value)
}
</script>

<template>
  <div class="card">
    <div class="row between wrap">
      <strong>Mint List</strong>
      <div class="row wrap">
        <span class="tag tag-dim">Empty {{ store.counts.EMPTY }}</span>
        <span class="tag tag-blue">Maturing {{ store.counts.MINTING }}</span>
        <span class="tag tag-green">Claimable {{ store.counts.CLAIMABLE }}</span>
        <span v-if="store.readErrors" class="tag tag-warn">Read err {{ store.readErrors }}</span>
        <button class="btn btn-ghost" :disabled="props.busy || store.loading" @click="store.hardRefresh()">
          Refresh
        </button>
      </div>
    </div>

    <p v-if="store.error" class="err-banner">{{ store.error }}</p>

    <div class="row" style="margin: 14px 0">
      <button class="btn" :class="{ 'btn-primary': filter === 'ALL' }" @click="filter = 'ALL'">All</button>
      <button class="btn" :class="{ 'btn-primary': filter === 'CLAIMABLE' }" @click="filter = 'CLAIMABLE'">
        Claimable
      </button>
      <button class="btn" :class="{ 'btn-primary': filter === 'MINTING' }" @click="filter = 'MINTING'">
        Maturing
      </button>
    </div>

    <div v-if="store.loading && !store.vmus.length" class="dim loading-box">
      Reading on-chain state...
      <span v-if="store.progress.total"> {{ store.progress.loaded }}/{{ store.progress.total }}</span>
    </div>

    <div v-else-if="!list.length" class="dim loading-box">No VMUs in this category.</div>

    <table v-else class="tbl">
      <thead>
        <tr>
          <th></th>
          <th>Status</th>
          <th>VMUs</th>
          <th>Term</th>
          <th>Maturity</th>
          <th>Est. XEN</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="g in list"
          :key="g.key"
          :class="{ selectable: g.status === 'CLAIMABLE', sel: selected.has(g.key) }"
          @click="toggle(g)"
        >
          <td>
            <input v-if="g.status === 'CLAIMABLE'" type="checkbox" :checked="selected.has(g.key)" @click.stop="toggle(g)" />
          </td>
          <td>
            <span v-if="g.status === 'CLAIMABLE'" class="tag tag-green">Claimable</span>
            <span v-else class="tag tag-blue">Maturing</span>
          </td>
          <td class="mono">{{ g.count }}</td>
          <td class="mono">{{ g.term }}d</td>
          <td class="mono">
            {{ formatDate(g.maturityTs) }}
            <span class="dim">({{ countdownTo(g.maturityTs) }})</span>
          </td>
          <td class="mono">{{ thousands(g.estXen ?? 0) }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="list.length" class="dim group-note">
      {{ list.length }} group{{ list.length > 1 ? 's' : '' }} · {{ vmuTotal }} VMU{{ vmuTotal > 1 ? 's' : '' }} total
      <span v-if="vmuTotal !== list.length">(rows are grouped by term &amp; maturity)</span>
    </p>

    <div v-if="selectedIds.length" class="action-bar">
      <div class="row wrap between">
        <span class="dim">
          {{ selectedIds.length }} VMUs selected
          <span v-if="overClaim || overReuse">
            (max Claim {{ claimLimit }} / Claim&amp;Re-Mint {{ claimReuseLimit }})
          </span>
        </span>
        <button class="btn" :disabled="props.busy" @click="clearSel">Clear</button>
      </div>

      <p v-if="props.blockedReason" class="blocked-reason">{{ props.blockedReason }}</p>

      <div class="row wrap action-ops">
        <button class="btn btn-primary" :disabled="props.busy || overClaim" @click="doClaim">
          Claim only
        </button>
        <label class="reuse-term">
          <span class="dim">then re-mint for</span>
          <input
            class="input mono inline-term"
            type="number"
            v-model.number="reuseTerm"
            min="1"
            :max="DEFAULT_TERM_MAX"
            :disabled="props.busy"
            @blur="clampReuseTerm"
          />
          <span class="dim">days</span>
        </label>
        <button class="btn" :disabled="props.busy || overReuse" @click="doClaimReuse">
          Claim &amp; Re-Mint ({{ reuseTerm }}d)
        </button>
      </div>
      <p class="dim reuse-hint">
        Claim only → withdraw XEN and leave slots empty.
        Claim &amp; Re-Mint → withdraw XEN and start a new {{ reuseTerm }}-day mint on the same VMUs.
      </p>
    </div>
  </div>
</template>

<style scoped>
.loading-box {
  padding: 28px 0;
  text-align: center;
}
.err-banner {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  color: var(--danger);
  font-size: 13px;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.tbl th {
  text-align: left;
  color: var(--text-dim);
  font-weight: 500;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.tbl td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
}
.selectable {
  cursor: pointer;
}
.selectable:hover {
  background: var(--bg-elev-2);
}
.sel {
  background: rgba(42, 250, 125, 0.08);
}
.group-note {
  margin: 12px 2px 0;
  font-size: 12px;
}
.action-bar {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.action-ops {
  gap: 10px;
  align-items: center;
}
.reuse-term {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.inline-term {
  width: 72px;
  display: inline-block;
  padding: 6px 8px;
}
.reuse-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
}
.blocked-reason {
  margin: 0;
  color: var(--warn);
  font-size: 13px;
}
</style>
