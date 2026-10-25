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
  normalizeError,
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
import StorageRecovery from '@/components/StorageRecovery.vue'
import { CONTRACTS } from '@/config/contracts'
import { APP_VERSION } from '@/config/version'
import { rpcConfigurationMessage } from '@/core/rpc'
import LanguageSelect from '@/components/LanguageSelect.vue'
import { t, message } from '@/i18n'
import { STALE_PREPARATION_MESSAGE } from '@/i18n/messages'

const wallet = useWalletStore()
const store = useVmuStore()

type Tab = 'GENERAL_MINT' | 'MINT_EMPTY_SLOT' | 'CREATE_EMPTY_SLOT'
const tab = ref<Tab>('GENERAL_MINT')

const activeChain = computed<ChainKey | null>(() => wallet.chainKey)
// Gas indicator works even before connecting: fall back to Ethereum.
const readChain = computed<ChainKey>(() => activeChain.value ?? 'eth')
const { gwei, loading: gweiLoading, poll: pollGas } = useGasPrice(() => readChain.value)
const { state: rpcHealth, unavailable: rpcUnavailable } = useRpcHealth(() => readChain.value)

const rpcHealthMessage = computed(() => {
  const state = rpcHealth.value
  if (state.error && state.errorKind === 'configuration') {
    return rpcConfigurationMessage(state.error)
  }
  if (state.error || (state.checkedAt !== null && state.healthyUrls.length === 0)) {
    return `No usable ${CHAINS[state.chain].name} RPC endpoints (${state.healthyUrls.length}/${state.totalUrls}). Your RPC list was not changed. Check internet access, DNS, firewall, and proxy/VPN settings, then recheck; or use the RPC button to change endpoints. Chain reads and transactions are blocked until a recheck succeeds.`
  }
  if (state.checkedAt !== null && state.failures.length > 0) {
    return `${CHAINS[state.chain].name} RPC failover active: ${state.healthyUrls.length}/${state.totalUrls} endpoints available. Unhealthy endpoints are excluded.`
  }
  return null
})

async function recheckRpc(restartReads = false) {
  const checks: Promise<unknown>[] = [pollGas()]
  if (wallet.address && activeChain.value) {
    checks.push(
      wallet.detectContractWallet(wallet.address, CHAINS[activeChain.value].chainId),
      checkPending(),
      store.refresh({ restart: restartReads })
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
  if (
    !window.confirm(message(`Switch network to ${name}? Your wallet will ask for confirmation.`))
  ) {
    return
  }
  try {
    await wallet.switchChain(next)
  } catch {
    /* switchError set in store; select already restored */
  }
}
const {
  hasPending,
  ready: pendingReady,
  pendingCount,
  localUnresolvedCount,
  ops: pendingOps,
  checking: pendingChecking,
  queued: pendingQueued,
  error: pendingError,
  check: checkPending,
  trackHash: trackPendingHash,
  markDropped: markPendingDropped
} = usePendingTx(
  () => wallet.address,
  () => activeChain.value,
  (operations) => {
    const matching = operations.filter(
      (operation) =>
        operation.chain === activeChain.value &&
        operation.wallet.toLowerCase() === wallet.address?.toLowerCase()
    )
    if (!matching.length) return
    if (
      matching.some(
        (operation) =>
          (operation.op === 'GENERAL_MINT' || operation.op === 'CREATE_EMPTY_SLOT') &&
          (!Number.isSafeInteger(operation.preVmuCount) ||
            operation.preVmuCount! < 0 ||
            operation.preVmuCount! > 100_000 ||
            !Number.isSafeInteger(operation.count) ||
            operation.count <= 0 ||
            operation.count > 1_000 ||
            operation.preVmuCount! + operation.count > 100_000)
      )
    ) {
      void store.refresh({ afterCurrent: true })
      return
    }
    const ids = matching.flatMap((operation) =>
      operation.op === 'GENERAL_MINT' || operation.op === 'CREATE_EMPTY_SLOT'
        ? Array.from({ length: operation.count }, (_, index) => operation.preVmuCount! + index + 1)
        : operation.ids
    )
    void store.refreshAffected(ids)
  }
)

const pendingBlockedReason = computed(() => {
  if (recoveryOpen.value)
    return 'Blocked: Transaction storage recovery is open. Close it before starting another operation.'
  if (!pendingReady.value) {
    return pendingError.value
      ? 'Blocked: pending transaction check failed. Recheck before submitting.'
      : 'Blocked: verifying pending transactions for this account and network.'
  }
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
    trackError.value = normalizeError(err)
  }
}

async function onMarkPendingDropped(id: string) {
  const confirmed = window.confirm(
    message(
      'WARNING: This does NOT cancel a blockchain transaction.\n\nOnly continue after checking MetaMask Activity and the block explorer and confirming that this transaction was never broadcast or is no longer pending. Marking a live transaction as dropped can allow a conflicting transaction.\n\nMark this record as dropped and unlock mining actions?'
    )
  )
  if (!confirmed) return

  trackError.value = null
  try {
    await markPendingDropped(id)
  } catch (err: any) {
    trackError.value = normalizeError(err)
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
          if (resolved && wallet.address === addr && wallet.chainKey === key)
            store.refresh({ afterCurrent: true })
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
// An invalidated UI must wait for its async work to release locks and the submission gate.
const operationFlights = reactive(new Set<{ chain: ChainKey; wallet: string }>())
const cancelling = computed(
  () =>
    !busy.value &&
    [...operationFlights].some(
      (flight) =>
        flight.chain === activeChain.value &&
        flight.wallet.toLowerCase() === wallet.address?.toLowerCase()
    )
)
const recoveryOpen = ref(false)
const waitingWallet = computed(
  () =>
    txState.value?.walletPrompted === true &&
    txState.value.send === 'process' &&
    !txState.value.txHash
)
const listReady = computed(
  () =>
    store.transactionReady &&
    store.chain === activeChain.value &&
    store.wallet?.toLowerCase() === wallet.address?.toLowerCase()
)

const canOperate = computed(
  () =>
    wallet.isConnected &&
    wallet.isSupportedChain &&
    !wallet.isContractWallet &&
    wallet.contractWalletChecked &&
    listReady.value &&
    !rpcUnavailable.value &&
    !busy.value &&
    !cancelling.value &&
    !recoveryOpen.value &&
    pendingReady.value &&
    !hasPending.value
)

let opSeq = 0
const prepared = ref<PreparedOp | null>(null)
// Detach the old UI context, but preserve records for non-cancellable wallet sends.
watch([() => wallet.address, () => wallet.chainKey, () => wallet.contextGen], () => {
  recoveryOpen.value = false
  const walletRequestOpen = txState.value?.walletPrompted === true
  const broadcasted =
    Boolean(txState.value?.txHash) ||
    txState.value?.send === 'done' ||
    txState.value?.confirm === 'process' ||
    txState.value?.confirm === 'done'
  opSeq += 1
  if (!walletRequestOpen && !broadcasted) abortPrepared(prepared.value)
  prepared.value = null
  busy.value = false
  txState.value = null
  txVisible.value = false
})

const operationBlockedReason = computed(() => {
  if (cancelling.value)
    return 'Waiting for the previous operation to finish cancelling. Transactions remain disabled until cleanup completes.'
  if (!listReady.value)
    return store.syncedAt !== null
      ? 'Previously loaded VMU data may be outdated. Transactions are disabled until a complete refresh succeeds.'
      : 'VMU data is not verified. Transactions are disabled until a complete refresh succeeds.'
  return null
})

function invalidateStalePreparation() {
  if (!busy.value && !prepared.value) return
  // Wallet prompts and broadcast transactions cannot be cancelled by a list refresh.
  if (
    txState.value?.walletPrompted ||
    txState.value?.txHash ||
    txState.value?.send === 'done' ||
    txState.value?.confirm === 'process' ||
    txState.value?.confirm === 'done'
  )
    return
  opSeq += 1
  abortPrepared(prepared.value)
  prepared.value = null
  busy.value = false
  txState.value = {
    estimate: 'error',
    send: 'wait',
    confirm: 'wait',
    readyToSign: false,
    error: STALE_PREPARATION_MESSAGE,
    logs: [{ at: Date.now(), status: 'error', message: STALE_PREPARATION_MESSAGE }]
  }
}

watch([() => store.refreshGen, listReady], invalidateStalePreparation, { flush: 'sync' })

async function operate(
  op: OpType,
  args: { ids?: number[]; count?: number; term?: number },
  title: string
) {
  if (!canOperate.value || !activeChain.value || !wallet.address) return
  const flight = { chain: activeChain.value, wallet: wallet.address }
  operationFlights.add(flight)
  try {
    const requestedChain = activeChain.value
    const requestedWallet = wallet.address
    const requestedContextGen = wallet.contextGen
    const requestedListGen = store.refreshGen
    const seq = ++opSeq
    busy.value = true
    prepared.value = null
    txTitle.value = title
    txVisible.value = true
    txState.value = {
      estimate: 'process',
      send: 'wait',
      confirm: 'wait',
      logs: [
        {
          at: Date.now(),
          status: 'process',
          message: 'Checking pending transactions through the wallet...'
        }
      ]
    }
    // Fresh check right before starting — polling may be a few seconds stale.
    const { count: n, error: checkError } = await checkPendingForSubmit()
    if (
      seq !== opSeq ||
      wallet.contextGen !== requestedContextGen ||
      activeChain.value !== requestedChain ||
      wallet.address?.toLowerCase() !== requestedWallet.toLowerCase()
    ) {
      return
    }
    if (!listReady.value || store.refreshGen !== requestedListGen) {
      invalidateStalePreparation()
      return
    }
    if (checkError || !pendingReady.value || pendingError.value) {
      busy.value = false
      const error =
        checkError ??
        pendingError.value ??
        'Pending transaction check has not completed. Recheck before submitting.'
      txState.value = {
        estimate: 'error',
        send: 'wait',
        confirm: 'wait',
        error,
        logs: [{ at: Date.now(), status: 'error', message: `Pending check failed: ${error}` }]
      }
      return
    }
    if (n > 0) {
      txTitle.value = title
      txState.value = {
        estimate: 'error',
        send: 'wait',
        confirm: 'wait',
        error:
          pendingBlockedReason.value ??
          `Blocked: ${n} pending tx on-chain. Wait, Speed up, or Cancel in MetaMask first.`
      }
      txVisible.value = true
      busy.value = false
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
          },
          isCancelled: () =>
            seq !== opSeq ||
            wallet.contextGen !== requestedContextGen ||
            !listReady.value ||
            store.refreshGen !== requestedListGen
        }
      )
      if (seq !== opSeq || wallet.contextGen !== requestedContextGen) {
        abortPrepared(prep)
        return
      }
      prepared.value = prep
      // Keep busy=true while waiting for the user to click "Open MetaMask & Sign".
    } catch {
      if (seq === opSeq && wallet.contextGen === requestedContextGen) busy.value = false
      void checkPending()
    }
  } finally {
    operationFlights.delete(flight)
  }
}

async function checkPendingForSubmit(): Promise<{ count: number; error: string | null }> {
  let failure: string | null = null
  let fail!: (count: number) => void
  const failed = new Promise<number>((resolve) => {
    fail = resolve
  })
  // A queued recheck may recover, but must not revive a click whose check already failed.
  const stop = watch(
    pendingError,
    (message) => {
      if (message) {
        failure = message
        fail(0)
      }
    },
    { flush: 'sync' }
  )
  try {
    const count = await Promise.race([checkPending(), failed])
    return { count, error: failure }
  } finally {
    stop()
  }
}

/** Phase 2: must run from a click so MetaMask gets a fresh user gesture. */
async function signPrepared() {
  const prep = prepared.value
  if (!prep) return
  if (!listReady.value) {
    invalidateStalePreparation()
    return
  }
  const flight = { chain: prep.chain, wallet: prep.wallet }
  operationFlights.add(flight)
  try {
    const seq = opSeq
    const requestedContextGen = wallet.contextGen
    const requestedListGen = store.refreshGen
    const { count: n, error: checkError } = await checkPendingForSubmit()
    if (seq !== opSeq || wallet.contextGen !== requestedContextGen || prepared.value !== prep)
      return
    if (!listReady.value || store.refreshGen !== requestedListGen) {
      invalidateStalePreparation()
      return
    }
    if (checkError || !pendingReady.value || n > 0 || pendingError.value) {
      abortPrepared(prep)
      prepared.value = null
      busy.value = false
      txState.value = {
        estimate: 'done',
        send: 'error',
        confirm: 'wait',
        readyToSign: false,
        error:
          checkError ??
          pendingError.value ??
          pendingBlockedReason.value ??
          `A previous transaction is still pending (${n}). Wait for it in MetaMask, then retry.`
      }
      return
    }
    prepared.value = null
    try {
      await sendPreparedOperation(prep, {
        onStep: (s) => {
          if (seq === opSeq && wallet.contextGen === requestedContextGen) {
            txState.value = s
          }
        },
        isCancelled: () => seq !== opSeq || wallet.contextGen !== requestedContextGen
      })
    } catch {
      // error in txState
    } finally {
      if (seq === opSeq && wallet.contextGen === requestedContextGen) {
        busy.value = false
        if (prep.receipt) {
          const affectedIds =
            prep.op === 'GENERAL_MINT' || prep.op === 'CREATE_EMPTY_SLOT'
              ? Array.from(
                  { length: prep.count },
                  (_, index) => (prep.preVmuCount ?? 0) + index + 1
                )
              : prep.ids
          void store.refreshAffected(affectedIds)
        }
        void checkPending()
      }
    }
  } finally {
    operationFlights.delete(flight)
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
  const clampedTerm = clampTerm(term)
  operate('CLAIM_REUSE', { ids, term: clampedTerm }, `Claim & Re-Mint (${clampedTerm} days)`)
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
        <div class="brand-line">
          <h1>XENTurbo XEN Miner</h1>
          <span data-testid="app-version" class="app-version">{{ APP_VERSION }}</span>
        </div>
        <span class="dim">{{
          t('Pure frontend. No backend, no database. All state read from chain.')
        }}</span>
      </div>
      <div class="row wrap">
        <div class="gas-pill" :title="gweiLoading ? t('Fetching gas…') : t('Gas price')">
          <span class="mono">{{ gweiLoading && gwei === '--' ? '…' : gwei }}</span>
          <span class="dim">Gwei</span>
        </div>
        <select
          v-if="wallet.isConnected"
          class="input chain-select"
          :aria-label="t('Network')"
          :value="activeChain ?? ''"
          :disabled="wallet.switchingChain"
          @change="onChainSelect"
        >
          <option v-for="k in CHAIN_KEYS" :key="k" :value="k">{{ CHAINS[k].name }}</option>
        </select>
        <LanguageSelect />
        <RpcSettings :chain="readChain" @saved="recheckRpc(true)" />
        <WalletButton />
      </div>
    </header>
    <p v-if="wallet.switchError" class="card warn-card" style="margin-bottom: 12px">
      {{ message(wallet.switchError) }}
    </p>
    <div
      v-if="rpcHealthMessage"
      class="card rpc-health-banner"
      :class="{ 'rpc-health-critical': rpcUnavailable }"
      role="status"
    >
      <span>{{ message(rpcHealthMessage) }}</span>
      <button class="btn" :disabled="rpcHealth.checking" @click="recheckRpc()">
        {{ rpcHealth.checking ? t('Checking...') : t('Recheck RPC') }}
      </button>
    </div>
    <div v-if="waitingWallet" class="card warn-card wallet-wait-banner">
      <span>
        {{
          t(
            'MetaMask is still processing this request. Mining actions remain locked until you approve or reject it.'
          )
        }}
      </span>
      <button v-if="!txVisible" class="btn" @click="txVisible = true">
        {{ t('Show request') }}
      </button>
    </div>

    <!-- warnings -->
    <div v-if="wallet.isConnected && !wallet.isSupportedChain" class="card warn-card">
      {{ t('Unsupported network. Switch to Ethereum or Polygon in your wallet.') }}
    </div>
    <div v-else-if="wallet.isContractWallet" class="card warn-card">
      {{
        t(
          'This looks like a smart-contract wallet. The miner contract requires an EOA (tx.origin == msg.sender) and will reject contract wallets.'
        )
      }}
    </div>
    <div
      v-else-if="wallet.isConnected && !wallet.contractWalletChecked && !rpcUnavailable"
      class="card warn-card wallet-wait-banner"
    >
      <span>
        {{
          message(
            wallet.contractWalletChecking
              ? 'Checking wallet type through the read RPC...'
              : (wallet.contractWalletError ??
                  'Wallet type could not be verified. Recheck before starting a transaction.')
          )
        }}
      </span>
      <button class="btn" :disabled="wallet.contractWalletChecking" @click="recheckRpc()">
        {{ t('Recheck wallet') }}
      </button>
    </div>
    <div v-if="!wallet.isConnected" class="card connect-card">
      <p>{{ t('Connect an EOA wallet to start batch minting XEN.') }}</p>
      <WalletButton />
      <p v-if="wallet.connectError" class="connect-err">{{ message(wallet.connectError) }}</p>
    </div>

    <template v-else-if="wallet.isSupportedChain">
      <PendingOpsPanel
        :ops="pendingOps"
        :pending-count="pendingCount"
        :checking="pendingChecking"
        @recheck="checkPending({ reverifyResults: true })"
        @track="onTrackHash"
        @mark-dropped="onMarkPendingDropped"
      />
      <p v-if="pendingBlockedReason" class="dim" role="status">
        {{ message(pendingBlockedReason) }}
        <span v-if="pendingError">{{ message(pendingError) }}</span>
      </p>
      <p v-if="pendingQueued" class="dim" role="status">
        {{
          t(
            'A fresh pending check is queued behind the current check. Waiting for both checks to finish.'
          )
        }}
      </p>
      <StorageRecovery
        v-if="activeChain && wallet.address"
        :key="wallet.contextGen"
        :chain="activeChain"
        :wallet="wallet.address"
        :disabled="busy || cancelling"
        @open="recoveryOpen = $event"
        @changed="checkPending({ reverifyResults: true })"
      />
      <p v-if="trackError" class="card warn-card">{{ message(trackError) }}</p>

      <!-- operation tabs -->
      <div class="card" style="margin-bottom: 16px">
        <div class="row wrap tabs">
          <button
            class="btn"
            :class="{ 'btn-primary': tab === 'GENERAL_MINT' }"
            @click="tab = 'GENERAL_MINT'"
          >
            {{ t('General Mint') }}
          </button>
          <button
            class="btn"
            :class="{ 'btn-primary': tab === 'MINT_EMPTY_SLOT' }"
            @click="tab = 'MINT_EMPTY_SLOT'"
          >
            {{ t('Empty Slots Mint') }}
          </button>
          <button
            class="btn"
            :class="{ 'btn-primary': tab === 'CREATE_EMPTY_SLOT' }"
            @click="tab = 'CREATE_EMPTY_SLOT'"
          >
            {{ t('Slots Management') }}
          </button>
        </div>
        <hr class="hr" />

        <!-- General Mint -->
        <div v-if="tab === 'GENERAL_MINT'" class="form-grid">
          <label>
            <span class="dim">{{ t('Mint VMUs (max {max})', { max: limits.generalMint }) }}</span>
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
            <span class="dim">{{ t('Term (days, max {max})', { max: DEFAULT_TERM_MAX }) }}</span>
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
            {{ t('Confirm Mint') }}
          </button>
        </div>

        <!-- Empty Slots Mint -->
        <div v-else-if="tab === 'MINT_EMPTY_SLOT'" class="form-grid">
          <label>
            <span class="dim">{{
              t('Empty VMUs to mint (available {count})', { count: emptySlotIds.length })
            }}</span>
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
            <span class="dim">{{ t('Term (days)') }}</span>
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
            {{ t('Re-Mint Empty Slots') }}
          </button>
        </div>

        <!-- Slots Management -->
        <div v-else class="form-grid">
          <label>
            <span class="dim">{{
              t('Create Empty Slots (max {max})', { max: limits.createEmptySlot })
            }}</span>
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
            {{ t('Create Slots') }}
          </button>
          <p class="dim reuse-term-note" style="grid-column: 1 / -1; margin: 0">
            {{
              t(
                'Creates empty VMU proxies only (no mint term). Use Empty Slots Mint afterwards to start a term.'
              )
            }}
          </p>
        </div>

        <p
          v-if="operationBlockedReason"
          class="dim reuse-term-note"
          role="status"
          data-testid="operation-blocked-reason"
        >
          {{ message(operationBlockedReason) }}
        </p>
        <p class="dim reuse-term-note">
          {{ t('Contract:') }}
          <a :href="explorerAddrUrl" target="_blank" rel="noreferrer">{{
            activeChain ? CONTRACTS[activeChain].factory : ''
          }}</a>
        </p>
      </div>

      <!-- mint list -->
      <MintList
        :busy="
          busy ||
          cancelling ||
          recoveryOpen ||
          !pendingReady ||
          hasPending ||
          rpcUnavailable ||
          !wallet.contractWalletChecked
        "
        :blocked-reason="
          rpcUnavailable
            ? rpcHealth.errorKind === 'configuration'
              ? `Blocked: invalid ${CHAINS[readChain].name} RPC configuration. Open RPC settings to correct it.`
              : `Blocked: no healthy ${CHAINS[readChain].name} RPC endpoint`
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
        {{ t('All code is open source. GitHub:') }}
        <a href="https://github.com/maiqiu-cat/XENTurbo-XEN-Miner" target="_blank" rel="noreferrer">
          maiqiu-cat/XENTurbo-XEN-Miner <span aria-hidden="true">↗</span>
        </a>
      </p>
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
.brand-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.brand-line h1 {
  margin: 0;
  font-size: 22px;
}
.app-version {
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
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
