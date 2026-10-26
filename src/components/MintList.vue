<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useVmuStore } from '@/stores/vmuStore'
import { useWalletStore } from '@/stores/walletStore'
import type { VmuGroup } from '@/core/types'
import { LIMITS, DEFAULT_TERM, DEFAULT_TERM_MAX } from '@/config/miner'
import { formatDate, countdownTo, thousands } from '@/utils/format'
import { useDocumentClock } from '@/composables/useDocumentClock'
import { t, message } from '@/i18n'

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
const monotonicNow = useDocumentClock(
  30_000,
  () => store.chainTimestampMs !== null,
  () => performance.now(),
  () => void refreshClock()
)
const clockAnchor = ref<{ timestamp: number | null; observedAt: number }>({
  timestamp: null,
  observedAt: performance.now()
})
let clockRefresh: AbortController | null = null

async function refreshClock() {
  if (clockRefresh || !store.chain || !store.wallet) return
  const controller = new AbortController()
  clockRefresh = controller
  clockAnchor.value = { timestamp: null, observedAt: performance.now() }
  try {
    const timestamp = await store.refreshChainTime(controller.signal)
    if (!controller.signal.aborted && timestamp !== null) {
      clockAnchor.value = { timestamp, observedAt: performance.now() }
    }
  } catch {
    // Keep the clock unavailable until a subsequent chain read succeeds.
  } finally {
    if (clockRefresh === controller) clockRefresh = null
  }
}

onUnmounted(() => clockRefresh?.abort())
watch(
  [() => store.chainTimestampMs, () => store.syncedAt, () => store.chain, () => store.wallet],
  () => {
    clockAnchor.value = { timestamp: store.chainTimestampMs, observedAt: performance.now() }
  },
  { immediate: true }
)
const chainNow = computed(() => {
  const anchor = clockAnchor.value
  return anchor.timestamp === null
    ? null
    : anchor.timestamp + Math.max(0, monotonicNow.value - anchor.observedAt)
})

function countdown(group: VmuGroup): string {
  if (group.status === 'CLAIMABLE') return t('Matured')
  if (chainNow.value === null) return t('Chain time unavailable')
  if (chainNow.value >= group.maturityTs) return t('Awaiting chain confirmation')
  return message(countdownTo(group.maturityTs, chainNow.value))
}

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
const PAGE_SIZE = 100
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(list.value.length / PAGE_SIZE)))
const pagedList = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return list.value.slice(start, start + PAGE_SIZE)
})

const selected = ref<Set<string>>(new Set())
const actionsDisabled = computed(() => props.busy || !store.transactionReady)

function toggle(g: VmuGroup) {
  if (!store.transactionReady || g.status !== 'CLAIMABLE') return
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

watch(filter, () => {
  page.value = 1
})

watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})

watch(
  [() => wallet.address, () => wallet.chainKey, () => wallet.contextGen],
  () => {
    clearSel()
    page.value = 1
  },
  { flush: 'sync' }
)
watch([() => store.syncedAt, () => store.refreshGen, () => store.transactionReady], clearSel, {
  flush: 'sync'
})

function doClaim() {
  if (actionsDisabled.value || !selectedIds.value.length || overClaim.value) return
  emit('claim', selectedIds.value)
}
function doClaimReuse() {
  if (actionsDisabled.value || !selectedIds.value.length || overReuse.value) return
  clampReuseTerm()
  emit('claim-reuse', selectedIds.value, reuseTerm.value)
}
</script>

<template>
  <div class="card">
    <div class="row between wrap">
      <strong>{{ t('Mint List') }}</strong>
      <div class="row wrap">
        <span class="tag tag-dim">{{ t('Empty') }} {{ store.counts.EMPTY }}</span>
        <span class="tag tag-blue">{{ t('Maturing') }} {{ store.counts.MINTING }}</span>
        <span class="tag tag-green">{{ t('Claimable') }} {{ store.counts.CLAIMABLE }}</span>
        <span v-if="store.readErrors" class="tag tag-warn"
          >{{ t('Read err') }} {{ store.readErrors }}</span
        >
        <button
          class="btn btn-ghost"
          :disabled="props.busy || store.loading"
          @click="store.hardRefresh()"
        >
          {{ store.loading ? t('Refreshing...') : t('Refresh') }}
        </button>
      </div>
    </div>

    <p v-if="store.error" class="err-banner">{{ message(store.error) }}</p>
    <p
      v-if="store.stale && !store.loading"
      class="stale-banner"
      role="status"
      data-testid="stale-vmu-warning"
    >
      {{
        t(
          store.syncedAt !== null
            ? 'Previously loaded VMU data may be outdated. Transactions are disabled until a complete refresh succeeds.'
            : 'VMU data is not verified. Transactions are disabled until a complete refresh succeeds.'
        )
      }}
      <span v-if="store.syncedAt !== null">
        {{ t('Last loaded: {time}', { time: formatDate(store.syncedAt) }) }}
      </span>
    </p>
    <p v-if="store.rankError" class="rank-banner">
      {{
        t(
          'Global rank unavailable. Reward estimates are disabled until the next successful refresh.'
        )
      }}
    </p>

    <div class="row" style="margin: 14px 0">
      <button class="btn" :class="{ 'btn-primary': filter === 'ALL' }" @click="filter = 'ALL'">
        {{ t('All') }}
      </button>
      <button
        class="btn"
        :class="{ 'btn-primary': filter === 'CLAIMABLE' }"
        @click="filter = 'CLAIMABLE'"
      >
        {{ t('Claimable') }}
      </button>
      <button
        class="btn"
        :class="{ 'btn-primary': filter === 'MINTING' }"
        @click="filter = 'MINTING'"
      >
        {{ t('Maturing') }}
      </button>
    </div>

    <div v-if="store.loading && !store.vmus.length" class="dim loading-box">
      {{ t('Reading on-chain state...') }}
      <span v-if="store.progress.total">
        {{ store.progress.loaded }}/{{ store.progress.total }}</span
      >
    </div>

    <div v-else-if="!list.length" class="dim loading-box">{{ t('No VMUs in this category.') }}</div>

    <table v-else class="tbl">
      <thead>
        <tr>
          <th></th>
          <th>{{ t('Status') }}</th>
          <th>VMUs</th>
          <th>{{ t('Term') }}</th>
          <th>{{ t('Maturity') }}</th>
          <th>{{ t('Est. XEN') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="g in pagedList"
          :key="g.key"
          :class="{
            selectable: g.status === 'CLAIMABLE' && store.transactionReady,
            sel: selected.has(g.key)
          }"
          @click="toggle(g)"
        >
          <td>
            <input
              v-if="g.status === 'CLAIMABLE'"
              type="checkbox"
              :disabled="!store.transactionReady"
              :checked="selected.has(g.key)"
              @click.stop="toggle(g)"
            />
          </td>
          <td>
            <span v-if="g.status === 'CLAIMABLE'" class="tag tag-green">{{ t('Claimable') }}</span>
            <span v-else class="tag tag-blue">{{ t('Maturing') }}</span>
          </td>
          <td class="mono">{{ g.count }}</td>
          <td class="mono">{{ t('{days}d', { days: g.term }) }}</td>
          <td class="mono">
            {{ formatDate(g.maturityTs) }}
            <span class="dim">({{ countdown(g) }})</span>
          </td>
          <td class="mono">
            {{ g.estXen === undefined ? t('Unavailable') : thousands(g.estXen) }}
          </td>
        </tr>
      </tbody>
    </table>

    <nav v-if="pageCount > 1" class="pagination" :aria-label="t('Mint list pages')">
      <button
        class="btn btn-ghost page-button"
        :aria-label="t('Previous page')"
        :title="t('Previous page')"
        :disabled="page === 1"
        @click="page -= 1"
      >
        &larr;
      </button>
      <span class="dim mono">{{ t('Page {page} of {pages}', { page, pages: pageCount }) }}</span>
      <button
        class="btn btn-ghost page-button"
        :aria-label="t('Next page')"
        :title="t('Next page')"
        :disabled="page === pageCount"
        @click="page += 1"
      >
        &rarr;
      </button>
    </nav>

    <p v-if="list.length" class="dim group-note">
      {{
        t('{groups} {groupLabel} · {count} {unitLabel} total', {
          groups: list.length,
          groupLabel: t(list.length > 1 ? 'groups' : 'group'),
          count: vmuTotal,
          unitLabel: t(vmuTotal > 1 ? 'VMUs' : 'VMU')
        })
      }}
      <span v-if="vmuTotal !== list.length">{{ t('(rows are grouped by term & maturity)') }}</span>
    </p>

    <div v-if="selectedIds.length" class="action-bar">
      <div class="row wrap between">
        <span class="dim">
          {{ t('{count} VMUs selected', { count: selectedIds.length }) }}
          <span v-if="overClaim || overReuse">
            {{
              t('(max Claim {claim} / Claim&Re-Mint {reuse})', {
                claim: claimLimit,
                reuse: claimReuseLimit
              })
            }}
          </span>
        </span>
        <button class="btn" :disabled="props.busy" @click="clearSel">{{ t('Clear') }}</button>
      </div>

      <p v-if="props.blockedReason" class="blocked-reason">{{ message(props.blockedReason) }}</p>

      <div class="row wrap action-ops">
        <button class="btn btn-primary" :disabled="actionsDisabled || overClaim" @click="doClaim">
          {{ t('Claim only') }}
        </button>
        <label class="reuse-term">
          <span class="dim">{{ t('then re-mint for') }}</span>
          <input
            class="input mono inline-term"
            type="number"
            v-model.number="reuseTerm"
            min="1"
            step="1"
            :max="DEFAULT_TERM_MAX"
            :disabled="actionsDisabled"
            @blur="clampReuseTerm"
          />
          <span class="dim">{{ t('days') }}</span>
        </label>
        <button class="btn" :disabled="actionsDisabled || overReuse" @click="doClaimReuse">
          {{ t('Claim & Re-Mint ({days}d)', { days: reuseTerm }) }}
        </button>
      </div>
      <p class="dim reuse-hint">
        {{
          t(
            'Claim only → withdraw XEN and leave slots empty. Claim & Re-Mint → withdraw XEN and start a new {days}-day mint on the same VMUs.',
            { days: reuseTerm }
          )
        }}
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
.rank-banner,
.stale-banner {
  margin: 12px 0 0;
  color: var(--warn);
  font-size: 13px;
}
.stale-banner {
  line-height: 1.5;
}
.stale-banner span {
  display: block;
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
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 42px;
  margin-top: 12px;
}
.page-button {
  width: 42px;
  min-width: 42px;
  padding: 8px;
}
.blocked-reason {
  margin: 0;
  color: var(--warn);
  font-size: 13px;
}
</style>
