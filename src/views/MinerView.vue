<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useWalletStore } from '@/stores/walletStore'
import { useVmuStore } from '@/stores/vmuStore'
import { CHAIN_KEYS, CHAINS, type ChainKey } from '@/config/chains'
import { LIMITS, DEFAULT_TERM, DEFAULT_TERM_MAX, DEFAULT_MINT_VMUS } from '@/config/miner'
import {
  prepareOperation,
  sendPreparedOperation,
  abortPrepared,
  resumePendingLocks,
  clearAbandonedSoftLocks,
  type OpType,
  type TxStepState,
  type PreparedOp
} from '@/core/txManager'
import { useGasPrice } from '@/composables/useGasPrice'
import { usePendingTx } from '@/composables/usePendingTx'
import { useRpcHealth } from '@/composables/useRpcHealth'
import WalletButton from '@/components/WalletButton.vue'
import RpcSettings from '@/components/RpcSettings.vue'
import TxModal from '@/components/TxModal.vue'
import MintList from '@/components/MintList.vue'
import PendingOpsPanel from '@/components/PendingOpsPanel.vue'
import AnalyticsConsent from '@/components/AnalyticsConsent.vue'
import { CONTRACTS } from '@/config/contracts'
import { analyticsOperationName, analyticsRpcHealthState } from '@/core/minerAnalytics'
import { trackAnalyticsEvent, type AnalyticsEventPayloads } from '@/core/analytics'

const wallet = useWalletStore()
const store = useVmuStore()

type Tab = 'GENERAL_MINT' | 'MINT_EMPTY_SLOT' | 'CREATE_EMPTY_SLOT'
const tab = ref<Tab>('GENERAL_MINT')

const activeChain = computed<ChainKey | null>(() => wallet.chainKey)
// Gas indicator works even before connecting: fall back to Ethereum.
const readChain = computed<ChainKey>(() => activeChain.value ?? 'eth')
const { gwei, loading: gweiLoading, poll: pollGas } = useGasPrice(() => readChain.value)
const { state: rpcHealth, unavailable: rpcUnavailable } = useRpcHealth(() => readChain.value)

watch(
  () =>
    [readChain.value, rpcHealth.value.checkedAt, analyticsRpcHealthState(rpcHealth.value)] as const,
  ([, checkedAt, state]) => {
    if (checkedAt !== null && state) trackAnalyticsEvent('rpc_health_state', { state })
  }
)

const rpcHealthMessage = computed(() => {
  const state = rpcHealth.value
  if (state.error || (state.checkedAt !== null && state.healthyUrls.length === 0)) {
    return `No usable ${CHAINS[state.chain].name} RPC endpoints (${state.healthyUrls.length}/${state.totalUrls}). Your RPC list was not changed. Check internet access, DNS, firewall, and proxy/VPN settings, then recheck; or use the RPC button to change endpoints. Chain reads and transactions are blocked until a recheck succeeds.`
  }
  if (state.checkedAt !== null && state.failures.length > 0) {
    return `${CHAINS[state.chain].name} RPC failover active: ${state.healthyUrls.length}/${state.totalUrls} endpoints available. Unhealthy endpoints are excluded.`
  }
  return null
})

async function recheckRpc() {
  const checks: Promise<unknown>[] = [pollGas()]
  if (wallet.address && activeChain.value) {
    checks.push(
      wallet.detectContractWallet(wallet.address, CHAINS[activeChain.value].chainId),
      checkPending(),
      store.refresh()
    )
  }
  await Promise.allSettled(checks)
}

async function onChainSelect(ev: Event) {
  const el = ev.target as HTMLSelectElement
  const next = el.value as ChainKey
  const prev = activeChain.value
  // Keep the select on the current chain until the wallet confirms.
  el.value = prev ?? ''
  if (!next || next === prev || wallet.switchingChain) return
  const name = CHAINS[next].name
  if (!window.confirm(`Switch network to ${name}? Your wallet will ask for confirmation.`)) {
    return
  }
  try {
    await wallet.switchChain(next)
    trackAnalyticsEvent('chain_selected', {
      chain: next === 'eth' ? 'ethereum' : 'polygon'
    })
  } catch {
    /* switchError set in store; select already restored */
  }
}
const {
  hasPending,
  pendingCount,
  localUnresolvedCount,
  ops: pendingOps,
  checking: pendingChecking,
  check: checkPending,
  trackHash: trackPendingHash,
  markDropped: markPendingDropped
} = usePendingTx(
  () => wallet.address,
  () => activeChain.value
)

const pendingBlockedReason = computed(() => {
  if (!hasPending.value) return null
  if (pendingCount.value > 0) {
    return `Blocked: ${pendingCount.value} pending tx on-chain`
  }
  return `Blocked: ${localUnresolvedCount.value} unresolved transaction awaiting reconciliation`
})

const trackError = ref<string | null>(null)
async function onTrackHash(payload: { hash: string; seenText?: string }) {
  trackError.value = null
  try {
    await trackPendingHash(payload.hash, payload.seenText)
  } catch (err: any) {
    trackError.value = err?.message || String(err)
  }
}

async function onMarkPendingDropped(id: string) {
  const confirmed = window.confirm(
    'WARNING: This does NOT cancel a blockchain transaction.\n\nOnly continue after checking MetaMask Activity and the block explorer and confirming that this transaction was never broadcast or is no longer pending. Marking a live transaction as dropped can allow a conflicting transaction.\n\nMark this record as dropped and unlock mining actions?'
  )
  if (!confirmed) return

  trackError.value = null
  try {
    await markPendingDropped(id)
  } catch (err: any) {
    trackError.value = err?.message || String(err)
  }
}

const limits = computed(() => (activeChain.value ? LIMITS[activeChain.value] : LIMITS.eth))

const form = reactive({
  mintVmus: Math.min(DEFAULT_MINT_VMUS, LIMITS.eth.generalMint),
  mintTerm: DEFAULT_TERM,
  createVmus: LIMITS.eth.createEmptySlot,
  emptyVmus: 1,
  emptyTerm: DEFAULT_TERM
})

// Load / reload wallet VMU data when account or chain changes.
watch(
  [() => wallet.address, () => wallet.chainKey, () => wallet.contextGen],
  async ([addr, key]) => {
    if (addr && key) {
      form.mintVmus = Math.min(DEFAULT_MINT_VMUS, LIMITS[key].generalMint)
      form.createVmus = LIMITS[key].createEmptySlot
      // Load immediately; resume pending locks in the background (do not block UI).
      void store.load(key, addr)
      void resumePendingLocks(key, addr)
        .then((resolved) => {
          if (resolved && wallet.address === addr && wallet.chainKey === key) store.refresh()
        })
        .catch(() => {})
      void checkPending()
    } else {
      store.detach()
    }
  },
  { immediate: true }
)

const emptySlotIds = computed(() => store.emptyIds)

// ---- transaction orchestration ----
const txVisible = ref(false)
const txState = ref<TxStepState | null>(null)
const txTitle = ref('')
const busy = ref(false)
const waitingWallet = computed(() => txState.value?.send === 'process' && !txState.value?.txHash)

const canOperate = computed(
  () =>
    wallet.isConnected &&
    wallet.isSupportedChain &&
    !wallet.isContractWallet &&
    wallet.contractWalletChecked &&
    !rpcUnavailable.value &&
    !busy.value &&
    !hasPending.value
)

let opSeq = 0
const prepared = ref<PreparedOp | null>(null)
type OperationStage = AnalyticsEventPayloads['miner_operation']['stage']
type OperationAnalytics = {
  seq: number
  operation: AnalyticsEventPayloads['miner_operation']['operation']
  sentStages: Set<OperationStage>
}
let activeOperationAnalytics: OperationAnalytics | null = null

function trackOperationStage(context: OperationAnalytics, stage: OperationStage) {
  if (context.sentStages.has(stage)) return
  context.sentStages.add(stage)
  trackAnalyticsEvent('miner_operation', { operation: context.operation, stage })
}

// Invalidate only work that has not reached the wallet. Once an EIP-1193
// request is open or a hash exists, keep tracking it until the wallet settles.
watch([() => wallet.address, () => wallet.chainKey, () => wallet.contextGen], () => {
  const walletRequestOpen = txState.value?.send === 'process'
  const broadcasted =
    Boolean(txState.value?.txHash) ||
    txState.value?.send === 'done' ||
    txState.value?.confirm === 'process' ||
    txState.value?.confirm === 'done'
  if (walletRequestOpen || broadcasted) return

  opSeq += 1
  if (!busy.value && !prepared.value) {
    activeOperationAnalytics = null
    return
  }
  abortPrepared(prepared.value)
  prepared.value = null
  activeOperationAnalytics = null
  busy.value = false
  txState.value = null
  txVisible.value = false
})

async function operate(
  op: OpType,
  args: { ids?: number[]; count?: number; term?: number },
  title: string
) {
  if (!activeChain.value || !wallet.address) return
  const requestedChain = activeChain.value
  const requestedWallet = wallet.address
  const requestedContextGen = wallet.contextGen
  const seq = ++opSeq
  const analyticsContext: OperationAnalytics = {
    seq,
    operation: analyticsOperationName(op),
    sentStages: new Set()
  }
  activeOperationAnalytics = analyticsContext
  // Fresh check right before starting — polling may be a few seconds stale.
  const n = await checkPending()
  if (
    seq !== opSeq ||
    wallet.contextGen !== requestedContextGen ||
    activeChain.value !== requestedChain ||
    wallet.address?.toLowerCase() !== requestedWallet.toLowerCase()
  ) {
    if (activeOperationAnalytics === analyticsContext) activeOperationAnalytics = null
    return
  }
  if (n > 0) {
    trackOperationStage(analyticsContext, 'failed')
    if (activeOperationAnalytics === analyticsContext) activeOperationAnalytics = null
    txTitle.value = title
    txState.value = {
      estimate: 'error',
      send: 'wait',
      confirm: 'wait',
      error: `Blocked: ${n} pending tx on-chain. Wait, Speed up, or Cancel in MetaMask first.`
    }
    txVisible.value = true
    return
  }

  busy.value = true
  prepared.value = null
  txTitle.value = title
  txState.value = { estimate: 'wait', send: 'wait', confirm: 'wait' }
  txVisible.value = true
  try {
    // Phase 1 only: estimate. Send waits for an explicit click (fresh user gesture).
    const prep = await prepareOperation(
      { chain: requestedChain, wallet: requestedWallet, op, ...args },
      {
        onStep: (s) => {
          if (seq === opSeq && wallet.contextGen === requestedContextGen) txState.value = s
        }
      }
    )
    if (seq !== opSeq || wallet.contextGen !== requestedContextGen) {
      abortPrepared(prep)
      if (activeOperationAnalytics === analyticsContext) activeOperationAnalytics = null
      return
    }
    prepared.value = prep
    trackOperationStage(analyticsContext, 'prepared')
    // Keep busy=true while waiting for the user to click "Open MetaMask & Sign".
  } catch {
    trackOperationStage(analyticsContext, 'failed')
    if (activeOperationAnalytics === analyticsContext) activeOperationAnalytics = null
    if (seq === opSeq && wallet.contextGen === requestedContextGen) busy.value = false
    void checkPending()
  }
}

/** Phase 2: must run from a click so MetaMask gets a fresh user gesture. */
async function signPrepared() {
  const prep = prepared.value
  if (!prep) return
  const seq = opSeq
  const analyticsContext =
    activeOperationAnalytics?.seq === seq
      ? activeOperationAnalytics
      : {
          seq,
          operation: analyticsOperationName(prep.op),
          sentStages: new Set<OperationStage>()
        }
  const requestedContextGen = wallet.contextGen
  const n = await checkPending()
  if (seq !== opSeq || wallet.contextGen !== requestedContextGen || prepared.value !== prep) return
  if (n > 0) {
    trackOperationStage(analyticsContext, 'failed')
    if (activeOperationAnalytics === analyticsContext) activeOperationAnalytics = null
    abortPrepared(prep)
    prepared.value = null
    busy.value = false
    txState.value = {
      estimate: 'done',
      send: 'error',
      confirm: 'wait',
      readyToSign: false,
      error: `A previous transaction is still pending (${n}). Wait for it in MetaMask, then retry.`
    }
    return
  }
  prepared.value = null
  try {
    await sendPreparedOperation(prep, {
      onStep: (s) => {
        if (seq === opSeq && wallet.contextGen === requestedContextGen) {
          txState.value = s
          if (s.send === 'process') trackOperationStage(analyticsContext, 'wallet_opened')
          if (s.txHash) trackOperationStage(analyticsContext, 'submitted')
          if (s.confirm === 'done') trackOperationStage(analyticsContext, 'confirmed')
        }
      },
      isCancelled: () => seq !== opSeq || wallet.contextGen !== requestedContextGen
    })
  } catch {
    trackOperationStage(analyticsContext, 'failed')
    // error in txState
  } finally {
    if (seq === opSeq && wallet.contextGen === requestedContextGen) {
      busy.value = false
      store.refresh()
      void checkPending()
    }
    if (activeOperationAnalytics === analyticsContext) activeOperationAnalytics = null
  }
}

function cancelTx() {
  if (waitingWallet.value) {
    txVisible.value = false
    return
  }
  opSeq++
  abortPrepared(prepared.value)
  prepared.value = null
  activeOperationAnalytics = null
  busy.value = false
  if (activeChain.value && wallet.address)
    clearAbandonedSoftLocks(activeChain.value, wallet.address)
  if (txState.value?.readyToSign) {
    txState.value = {
      estimate: txState.value.estimate,
      send: 'error',
      confirm: 'wait',
      readyToSign: false,
      error: 'Preparation cancelled. No transaction was submitted.'
    }
  } else {
    txVisible.value = false
  }
}

function clampTerm(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERM
  return Math.min(Math.max(1, Math.floor(n)), DEFAULT_TERM_MAX)
}

function doGeneralMint() {
  clampMint()
  form.mintTerm = clampTerm(form.mintTerm)
  operate('GENERAL_MINT', { count: form.mintVmus, term: form.mintTerm }, 'General Mint')
}
function doCreateEmpty() {
  clampCreate()
  operate('CREATE_EMPTY_SLOT', { count: form.createVmus }, 'Create Empty Slots')
}
function doMintEmpty() {
  clampEmpty()
  form.emptyTerm = clampTerm(form.emptyTerm)
  const ids = emptySlotIds.value.slice(0, form.emptyVmus)
  operate('MINT_EMPTY_SLOT', { ids, term: form.emptyTerm }, 'Empty Slots Mint')
}
function onClaim(ids: number[]) {
  operate('CLAIM', { ids }, 'Claim only')
}
function onClaimReuse(ids: number[], term: number) {
  const t = clampTerm(term)
  operate('CLAIM_REUSE', { ids, term: t }, `Claim & Re-Mint (${t} days)`)
}

function clampMint() {
  form.mintVmus = Math.min(Math.max(1, Math.floor(form.mintVmus || 1)), limits.value.generalMint)
}
function clampCreate() {
  form.createVmus = Math.min(
    Math.max(1, Math.floor(form.createVmus || 1)),
    limits.value.createEmptySlot
  )
}
function clampEmpty() {
  const max = Math.min(limits.value.mintEmptySlot, emptySlotIds.value.length || 1)
  form.emptyVmus = Math.min(Math.max(1, Math.floor(form.emptyVmus || 1)), max)
}

const explorerAddrUrl = computed(() => {
  if (!activeChain.value) return '#'
  return `${CHAINS[activeChain.value].blockExplorerUrl}/address/${CONTRACTS[activeChain.value].factory}`
})
</script>

<template>
  <div class="container" style="padding-top: 24px; padding-bottom: 28px">
    <!-- header -->
    <header class="row between wrap" style="margin-bottom: 20px">
      <div>
        <h1 style="margin: 0; font-size: 22px">XENTurbo XEN Miner</h1>
        <span class="dim">Pure frontend. No backend, no database. All state read from chain.</span>
      </div>
      <div class="row wrap">
        <div class="gas-pill" :title="gweiLoading ? 'Fetching gas…' : 'Gas price'">
          <span class="mono">{{ gweiLoading && gwei === '--' ? '…' : gwei }}</span>
          <span class="dim">Gwei</span>
        </div>
        <select
          v-if="wallet.isConnected"
          class="input chain-select"
          :value="activeChain ?? ''"
          :disabled="wallet.switchingChain"
          @change="onChainSelect"
        >
          <option v-for="k in CHAIN_KEYS" :key="k" :value="k">{{ CHAINS[k].name }}</option>
        </select>
        <RpcSettings :chain="readChain" @saved="recheckRpc" />
        <WalletButton />
      </div>
    </header>
    <p v-if="wallet.switchError" class="card warn-card" style="margin-bottom: 12px">
      {{ wallet.switchError }}
    </p>
    <div
      v-if="rpcHealthMessage"
      class="card rpc-health-banner"
      :class="{ 'rpc-health-critical': rpcUnavailable }"
      role="status"
    >
      <span>{{ rpcHealthMessage }}</span>
      <button class="btn" :disabled="rpcHealth.checking" @click="recheckRpc">
        {{ rpcHealth.checking ? 'Checking...' : 'Recheck RPC' }}
      </button>
    </div>
    <div v-if="waitingWallet" class="card warn-card wallet-wait-banner">
      <span>
        MetaMask is still processing this request. Mining actions remain locked until you approve or
        reject it.
      </span>
      <button v-if="!txVisible" class="btn" @click="txVisible = true">Show request</button>
    </div>

    <!-- warnings -->
    <div v-if="wallet.isConnected && !wallet.isSupportedChain" class="card warn-card">
      Unsupported network. Switch to Ethereum or Polygon in your wallet.
    </div>
    <div v-else-if="wallet.isContractWallet" class="card warn-card">
      This looks like a smart-contract wallet. The miner contract requires an EOA (tx.origin ==
      msg.sender) and will reject contract wallets.
    </div>
    <div
      v-else-if="wallet.isConnected && !wallet.contractWalletChecked && !rpcUnavailable"
      class="card warn-card"
    >
      Wallet type could not be verified. Recheck RPC before starting a transaction.
    </div>
    <div v-if="!wallet.isConnected" class="card connect-card">
      <p>Connect an EOA wallet to start batch minting XEN.</p>
      <WalletButton />
      <p v-if="wallet.connectError" class="connect-err">{{ wallet.connectError }}</p>
    </div>

    <template v-else-if="wallet.isSupportedChain">
      <PendingOpsPanel
        :ops="pendingOps"
        :pending-count="pendingCount"
        :checking="pendingChecking"
        @recheck="checkPending"
        @track="onTrackHash"
        @mark-dropped="onMarkPendingDropped"
      />
      <p v-if="trackError" class="card warn-card">{{ trackError }}</p>

      <!-- operation tabs -->
      <div class="card" style="margin-bottom: 16px">
        <div class="row wrap tabs">
          <button
            class="btn"
            :class="{ 'btn-primary': tab === 'GENERAL_MINT' }"
            @click="tab = 'GENERAL_MINT'"
          >
            General Mint
          </button>
          <button
            class="btn"
            :class="{ 'btn-primary': tab === 'MINT_EMPTY_SLOT' }"
            @click="tab = 'MINT_EMPTY_SLOT'"
          >
            Empty Slots Mint
          </button>
          <button
            class="btn"
            :class="{ 'btn-primary': tab === 'CREATE_EMPTY_SLOT' }"
            @click="tab = 'CREATE_EMPTY_SLOT'"
          >
            Slots Management
          </button>
        </div>
        <hr class="hr" />

        <!-- General Mint -->
        <div v-if="tab === 'GENERAL_MINT'" class="form-grid">
          <label>
            <span class="dim">Mint VMUs (max {{ limits.generalMint }})</span>
            <input
              class="input mono"
              type="number"
              v-model.number="form.mintVmus"
              min="1"
              step="1"
              :max="limits.generalMint"
              @blur="clampMint"
            />
          </label>
          <label>
            <span class="dim">Term (days, max {{ DEFAULT_TERM_MAX }})</span>
            <input
              class="input mono"
              type="number"
              v-model.number="form.mintTerm"
              min="1"
              step="1"
              :max="DEFAULT_TERM_MAX"
              @blur="form.mintTerm = clampTerm(form.mintTerm)"
            />
          </label>
          <button class="btn btn-primary tall" :disabled="!canOperate" @click="doGeneralMint">
            Confirm Mint
          </button>
        </div>

        <!-- Empty Slots Mint -->
        <div v-else-if="tab === 'MINT_EMPTY_SLOT'" class="form-grid">
          <label>
            <span class="dim">Empty VMUs to mint (available {{ emptySlotIds.length }})</span>
            <input
              class="input mono"
              type="number"
              v-model.number="form.emptyVmus"
              min="1"
              step="1"
              @blur="clampEmpty"
            />
          </label>
          <label>
            <span class="dim">Term (days)</span>
            <input
              class="input mono"
              type="number"
              v-model.number="form.emptyTerm"
              min="1"
              step="1"
              :max="DEFAULT_TERM_MAX"
              @blur="form.emptyTerm = clampTerm(form.emptyTerm)"
            />
          </label>
          <button
            class="btn btn-primary tall"
            :disabled="!canOperate || !emptySlotIds.length"
            @click="doMintEmpty"
          >
            Re-Mint Empty Slots
          </button>
        </div>

        <!-- Slots Management -->
        <div v-else class="form-grid">
          <label>
            <span class="dim">Create Empty Slots (max {{ limits.createEmptySlot }})</span>
            <input
              class="input mono"
              type="number"
              v-model.number="form.createVmus"
              min="1"
              step="1"
              :max="limits.createEmptySlot"
              @blur="clampCreate"
            />
          </label>
          <div />
          <button class="btn btn-primary tall" :disabled="!canOperate" @click="doCreateEmpty">
            Create Slots
          </button>
          <p class="dim reuse-term-note" style="grid-column: 1 / -1; margin: 0">
            Creates empty VMU proxies only (no mint term). Use Empty Slots Mint afterwards to start
            a term.
          </p>
        </div>

        <p class="dim reuse-term-note">
          Contract:
          <a :href="explorerAddrUrl" target="_blank" rel="noreferrer">{{
            activeChain ? CONTRACTS[activeChain].factory : ''
          }}</a>
        </p>
      </div>

      <!-- mint list -->
      <MintList
        :busy="busy || hasPending || rpcUnavailable || !wallet.contractWalletChecked"
        :blocked-reason="
          rpcUnavailable
            ? `Blocked: no healthy ${CHAINS[readChain].name} RPC endpoint`
            : !wallet.contractWalletChecked
              ? 'Blocked: wallet type is not verified'
              : pendingBlockedReason
        "
        @claim="onClaim"
        @claim-reuse="(ids, term) => onClaimReuse(ids, term)"
      />
    </template>

    <footer class="site-footer">
      <p>
        Copyright 2026 ·
        <a href="https://miner.xenturbo.io/" target="_blank" rel="noreferrer">
          Miner.XENTurbo.io
        </a>
      </p>
      <p class="site-footer-source">
        All code is open source. GitHub:
        <a href="https://github.com/maiqiu-cat/XENTurbo-XEN-Miner" target="_blank" rel="noreferrer">
          maiqiu-cat/XENTurbo-XEN-Miner <span aria-hidden="true">↗</span>
        </a>
      </p>
      <AnalyticsConsent />
    </footer>

    <TxModal
      :visible="txVisible"
      :state="txState"
      :chain="activeChain"
      :title="txTitle"
      @close="txVisible = false"
      @cancel="cancelTx"
      @sign="signPrepared"
    />
  </div>
</template>

<style scoped>
.gas-pill {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
  background: var(--bg-elev);
}
.chain-select {
  width: auto;
  padding: 9px 12px;
}
.warn-card {
  border-color: var(--warn);
  color: var(--warn);
  margin-bottom: 16px;
}
.wallet-wait-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rpc-health-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  border-color: var(--warn);
  color: var(--warn);
}
.rpc-health-critical {
  border-color: var(--danger);
  color: var(--danger);
}
.connect-card {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 48px 20px;
}
.connect-err {
  color: var(--danger);
  max-width: 480px;
  font-size: 13px;
}
.tabs {
  gap: 10px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 16px;
  align-items: end;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tall {
  height: 42px;
}
.reuse-term-note {
  margin: 16px 0 0;
  font-size: 13px;
}
.site-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 13px;
}
.site-footer p {
  margin: 0;
}
.site-footer-source {
  text-align: right;
}
@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .site-footer {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .site-footer-source {
    text-align: left;
  }
}
</style>
