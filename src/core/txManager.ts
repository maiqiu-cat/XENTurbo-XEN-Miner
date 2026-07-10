import { Contract } from 'ethers'
import { CONTRACTS } from '@/config/contracts'
import { CHAINS, type ChainKey } from '@/config/chains'
import { XENFactoryABI } from '@/abis/XENFactoryABI'
import {
  GAS_LIMIT_RATIO,
  FREE_CHAINS,
  CONFIRM_TIMEOUT_MS,
  LIMITS,
  DEFAULT_TERM_MAX
} from '@/config/miner'
import { writeFactory, warmUpInjected } from './wallet'
import { readFee, readVmuStatuses } from './chainReader'
import { getReadProvider } from './rpc'
import {
  attachTxHash,
  releaseLock,
  newBatchId,
  pendingLocks,
  tryAcquireLock,
  clearSoftLocks
} from './localLock'
import { recordPendingOp } from './pendingOps'
import { operationKey, runWalletExclusive } from './operationGate'
import {
  assertNonceAgreement,
  getInjectedAccount,
  getInjectedChainId,
  getInjectedPendingNonce
} from './eip1193'
import type { VmuStatus } from './types'

export type OpType =
  | 'GENERAL_MINT'
  | 'CREATE_EMPTY_SLOT'
  | 'MINT_EMPTY_SLOT'
  | 'CLAIM'
  | 'CLAIM_REUSE'

export interface TxStepState {
  estimate: 'wait' | 'process' | 'done' | 'error'
  send: 'wait' | 'process' | 'done' | 'error'
  confirm: 'wait' | 'process' | 'done' | 'error'
  /** True after estimate succeeds — UI should show "Open MetaMask" button. */
  readyToSign?: boolean
  txHash?: string
  error?: string
}

export interface TxCallbacks {
  onStep?: (state: TxStepState) => void
}

/** Reject if a promise does not settle within `ms`, with a labelled error. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    )
  ])
}

const ESTIMATE_TIMEOUT_MS = 40_000
const PROBE_UNITS = 32
const BLOCK_GAS_CAP = 55_000_000n

function getReadFactory(chain: ChainKey) {
  return new Contract(
    CONTRACTS[chain].factory,
    XENFactoryABI as unknown as any[],
    getReadProvider(chain)
  )
}

interface EstimateShape {
  term: number
  count: number
  ids: number[]
  from: string
  value?: bigint
}

function buildEstimateCall(readFactory: Contract, op: OpType, p: EstimateShape): Promise<bigint> {
  const base = p.value !== undefined ? { from: p.from, value: p.value } : { from: p.from }
  switch (op) {
    case 'GENERAL_MINT':
      return readFactory.bulkClaimRank_.estimateGas(p.term, p.count, base)
    case 'CREATE_EMPTY_SLOT':
      return readFactory.createVMUs_.estimateGas(p.count, { from: p.from })
    case 'MINT_EMPTY_SLOT':
      return readFactory.reuseVMUs_.estimateGas(p.ids, p.term, base)
    case 'CLAIM':
      return readFactory.bulkClaimMintReward_.estimateGas(p.ids, base)
    case 'CLAIM_REUSE':
      return readFactory.bulkClaimMintRewardAndClaimRank_.estimateGas(p.ids, p.term, base)
    default:
      throw new Error(`Unknown op ${op}`)
  }
}

async function estimateGasLimit(params: {
  readFactory: Contract
  op: OpType
  term: number
  count: number
  ids: number[]
  from: string
  fee: bigint
  feeApplies: boolean
  ratio: number
}): Promise<bigint> {
  const { readFactory, op, term, count, ids, from, fee, feeApplies, ratio } = params
  const units = op === 'GENERAL_MINT' || op === 'CREATE_EMPTY_SLOT' ? count : ids.length
  const valueFor = (u: number) => (feeApplies ? fee * BigInt(u) : undefined)

  try {
    const est = await withTimeout(
      buildEstimateCall(readFactory, op, { term, count, ids, from, value: valueFor(units) }),
      ESTIMATE_TIMEOUT_MS,
      'Gas estimation'
    )
    return BigInt(Math.ceil(Number(est) * ratio))
  } catch (err) {
    if (units <= PROBE_UNITS) throw err
    let probeGas: bigint
    try {
      probeGas = await withTimeout(
        buildEstimateCall(readFactory, op, {
          term,
          count: PROBE_UNITS,
          ids: ids.slice(0, PROBE_UNITS),
          from,
          value: valueFor(PROBE_UNITS)
        }),
        ESTIMATE_TIMEOUT_MS,
        'Gas estimation'
      )
    } catch {
      throw err
    }
    const perUnit = Number(probeGas) / PROBE_UNITS
    const projected = BigInt(Math.ceil(perUnit * units * ratio))
    return projected < BLOCK_GAS_CAP ? projected : BLOCK_GAS_CAP
  }
}

interface RunParams {
  chain: ChainKey
  wallet: string
  op: OpType
  ids?: number[]
  count?: number
  term?: number
}

function expectedStatus(op: OpType): VmuStatus | null {
  if (op === 'MINT_EMPTY_SLOT') return 'EMPTY'
  if (op === 'CLAIM' || op === 'CLAIM_REUSE') return 'CLAIMABLE'
  return null
}

function validateParams(params: {
  chain: ChainKey
  op: OpType
  ids: number[]
  count: number
  term: number
}): void {
  const { chain, op, ids, count, term } = params
  const lim = LIMITS[chain]

  // createVMUs has no term — only mint / remint / claim-reuse need one.
  if (op === 'GENERAL_MINT' || op === 'MINT_EMPTY_SLOT' || op === 'CLAIM_REUSE') {
    if (!Number.isFinite(term) || term < 1 || term > DEFAULT_TERM_MAX) {
      throw new Error(`Term must be between 1 and ${DEFAULT_TERM_MAX} days`)
    }
  }

  switch (op) {
    case 'GENERAL_MINT':
      if (!Number.isFinite(count) || count < 1 || count > lim.generalMint) {
        throw new Error(`Mint count must be 1–${lim.generalMint}`)
      }
      break
    case 'CREATE_EMPTY_SLOT':
      if (!Number.isFinite(count) || count < 1 || count > lim.createEmptySlot) {
        throw new Error(`Create count must be 1–${lim.createEmptySlot}`)
      }
      break
    case 'MINT_EMPTY_SLOT':
      if (!ids.length) throw new Error('No empty VMUs selected')
      if (ids.length > lim.mintEmptySlot) {
        throw new Error(`Empty-slot mint limited to ${lim.mintEmptySlot} VMUs per tx (selected ${ids.length})`)
      }
      break
    case 'CLAIM':
      if (!ids.length) throw new Error('No claimable VMUs selected')
      if (ids.length > lim.claim) {
        throw new Error(`Claim limited to ${lim.claim} VMUs per tx (selected ${ids.length}). Deselect some and retry.`)
      }
      break
    case 'CLAIM_REUSE':
      if (!ids.length) throw new Error('No claimable VMUs selected')
      if (ids.length > lim.claimAndReuse) {
        throw new Error(
          `Claim & Re-Mint limited to ${lim.claimAndReuse} VMUs per tx (selected ${ids.length}). Deselect some and retry.`
        )
      }
      break
  }
}

async function assertIdsStillValid(chain: ChainKey, wallet: string, op: OpType, ids: number[]): Promise<void> {
  const want = expectedStatus(op)
  if (!want || !ids.length) return
  const statuses = await readVmuStatuses(chain, wallet, ids)
  const bad = ids.filter((id) => {
    const s = statuses.get(id)
    return !s || s !== want || s === 'READ_ERROR'
  })
  if (bad.length) {
    throw new Error(
      `VMU state changed on-chain (ids ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? '…' : ''}). Refresh and retry.`
    )
  }
}

function buildCall(op: OpType, ids: number[], count: number, term: number): { fnName: string; args: readonly unknown[] } {
  switch (op) {
    case 'GENERAL_MINT':
      return { fnName: 'bulkClaimRank', args: [BigInt(term), BigInt(count)] }
    case 'CREATE_EMPTY_SLOT':
      return { fnName: 'createVMUs', args: [BigInt(count)] }
    case 'MINT_EMPTY_SLOT':
      return { fnName: 'reuseVMUs', args: [ids.map((i) => BigInt(i)), BigInt(term)] }
    case 'CLAIM':
      return { fnName: 'bulkClaimMintReward', args: [ids.map((i) => BigInt(i))] }
    case 'CLAIM_REUSE':
      return { fnName: 'bulkClaimMintRewardAndClaimRank', args: [ids.map((i) => BigInt(i)), BigInt(term)] }
    default:
      throw new Error(`Unknown op ${op}`)
  }
}

/** Prepared tx after gas estimation — send must be triggered by a fresh user click. */
export interface PreparedOp {
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  term: number
  chainId: number
  factoryAddress: `0x${string}`
  gasLimit: bigint
  value?: bigint
  fnName: string
  args: readonly unknown[]
  batch: string
  lockIds: number[]
  state: TxStepState
  /** Prefetched so MetaMask does not stall on its own RPC before showing the popup. */
  nonce: number
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * Phase 1: validate, soft-lock, re-read ids, estimate gas.
 * Does NOT call the wallet — returns a PreparedOp for phase 2.
 * MetaMask popups require a fresh user gesture; estimate often takes seconds
 * and breaks that gesture, so send is deferred to an explicit button click.
 */
/** pendingNonce - latestNonce; >0 means at least one in-flight tx. */
export async function getPendingTxCount(chain: ChainKey, wallet: string): Promise<number> {
  const provider = getReadProvider(chain)
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(wallet, 'latest'),
    provider.getTransactionCount(wallet, 'pending')
  ])
  return Math.max(0, pending - latest)
}

export async function prepareOperation(params: RunParams, cb: TxCallbacks = {}): Promise<PreparedOp> {
  const { chain, wallet, op, ids = [], count = 0, term = 0 } = params
  const state: TxStepState = { estimate: 'wait', send: 'wait', confirm: 'wait' }
  const emit = () => cb.onStep?.({ ...state })

  validateParams({ chain, op, ids, count, term })

  // Block before any gas spend if a previous tx is still in-flight.
  // EIP-7702 / Infura only allows 1 in-flight tx for delegated accounts.
  const inflight = await getPendingTxCount(chain, wallet)
  if (inflight > 0) {
    throw new Error(
      `PENDING_TX: ${inflight} transaction(s) still pending on-chain. Wait for confirmation (or Speed up / Cancel in MetaMask) before submitting another.`
    )
  }

  const readFactory = getReadFactory(chain)
  const ratio = GAS_LIMIT_RATIO[chain]
  const factoryAddress = CONTRACTS[chain].factory as `0x${string}`
  const chainId = CHAINS[chain].chainId

  const units = op === 'GENERAL_MINT' || op === 'CREATE_EMPTY_SLOT' ? count : ids.length
  const feeApplies =
    !FREE_CHAINS.includes(chain) &&
    (op === 'GENERAL_MINT' || op === 'MINT_EMPTY_SLOT' || op === 'CLAIM_REUSE')
  const fee = feeApplies ? await readFee(chain) : 0n
  const value = feeApplies ? fee * BigInt(units) : undefined

  const batch = newBatchId()
  const lockIds = op === 'GENERAL_MINT' || op === 'CREATE_EMPTY_SLOT' ? [] : ids

  if (lockIds.length) {
    if (!tryAcquireLock({ chain, wallet, ids: lockIds, batch, op, count, term })) {
      throw new Error('Some selected VMUs are already pending in another tab/window. Wait or refresh.')
    }
  }

  try {
    await assertIdsStillValid(chain, wallet, op, ids)
    void warmUpInjected(chainId).catch(() => {})

    state.estimate = 'process'
    emit()
    const readProvider = getReadProvider(chain)
    // Prefetch nonce + fees from OUR RPC in parallel with gas estimation.
    // MetaMask otherwise fetches these via its own (often slow/broken) endpoint
    // before showing the signature popup — that alone can take 1–2 minutes.
    const [gasLimit, nonce, feeData] = await Promise.all([
      estimateGasLimit({
        readFactory,
        op,
        term,
        count,
        ids,
        from: wallet,
        fee,
        feeApplies,
        ratio
      }),
      readProvider.getTransactionCount(wallet, 'pending'),
      readProvider.getFeeData()
    ])
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n // 1 gwei fallback
    const maxFeePerGas =
      feeData.maxFeePerGas ?? maxPriorityFeePerGas * 2n + (feeData.gasPrice ?? 0n)

    state.estimate = 'done'
    state.readyToSign = true
    emit()

    const { fnName, args } = buildCall(op, ids, count, term)
    return {
      chain,
      wallet,
      op,
      ids,
      count,
      term,
      chainId,
      factoryAddress,
      gasLimit,
      value,
      fnName,
      args,
      batch,
      lockIds,
      state,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas
    }
  } catch (err: any) {
    if (lockIds.length) releaseLock(batch)
    if (state.estimate === 'process') state.estimate = 'error'
    state.error = normalizeError(err)
    state.readyToSign = false
    emit()
    throw err
  }
}

/**
 * Phase 2: send + confirm. MUST be called from a click handler so MetaMask
 * receives a fresh user gesture and can show the signature popup.
 */
export async function sendPreparedOperation(prepared: PreparedOp, cb: TxCallbacks = {}): Promise<TxStepState> {
  const state: TxStepState = {
    estimate: 'done',
    send: 'wait',
    confirm: 'wait',
    readyToSign: false
  }
  const emit = () => cb.onStep?.({ ...state })
  const lockHeld = prepared.lockIds.length > 0
  let broadcasted = false
  let resolved = false
  let broadcastNonce = prepared.nonce
  let awaitingWalletRecorded = false
  let awaitingWalletResolved = false

  try {
    const walletSend = runWalletExclusive(
      operationKey(prepared.chain, prepared.wallet),
      async () => {
        // Keep the final safety check, nonce read, and wallet request in one
        // cross-tab critical section so two tabs cannot send concurrently.
        const inflight = await getPendingTxCount(prepared.chain, prepared.wallet)
        if (inflight > 0) {
          throw new Error(
            `PENDING_TX: ${inflight} transaction(s) still pending on-chain. Wait for confirmation (or Speed up / Cancel in MetaMask) before submitting another.`
          )
        }

        const readProvider = getReadProvider(prepared.chain)
        const [injectedAccount, injectedChainId] = await Promise.all([
          getInjectedAccount(),
          getInjectedChainId()
        ])
        if (!injectedAccount || injectedAccount.toLowerCase() !== prepared.wallet.toLowerCase()) {
          throw new Error('Wallet account changed during the operation. Reconnect and retry.')
        }
        if (injectedChainId !== prepared.chainId) {
          throw new Error('Wallet is on the wrong network. Switch networks and retry.')
        }

        const [walletNonce, rpcNonce, feeData] = await Promise.all([
          getInjectedPendingNonce(prepared.wallet),
          readProvider.getTransactionCount(prepared.wallet, 'pending'),
          readProvider.getFeeData()
        ])
        const nonce = assertNonceAgreement(walletNonce, rpcNonce)
        broadcastNonce = nonce
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n
        const maxFeePerGas =
          feeData.maxFeePerGas ?? maxPriorityFeePerGas * 2n + (feeData.gasPrice ?? 0n)

        state.send = 'process'
        emit()

        recordPendingOp({
          id: prepared.batch,
          chain: prepared.chain,
          wallet: prepared.wallet,
          op: prepared.op,
          ids: prepared.ids,
          count: prepared.count,
          term: prepared.term,
          txHash: '',
          nonce,
          phase: 'awaiting-wallet'
        })
        awaitingWalletRecorded = true

        return writeFactory({
          chainId: prepared.chainId,
          address: prepared.factoryAddress,
          abi: XENFactoryABI,
          functionName: prepared.fnName,
          args: prepared.args,
          value: prepared.value,
          gas: prepared.gasLimit,
          nonce,
          maxFeePerGas,
          maxPriorityFeePerGas,
          expectedFrom: prepared.wallet
        })
      }
    )
    const txHash = await walletSend
    broadcasted = true
    state.txHash = txHash
    if (prepared.lockIds.length) attachTxHash(prepared.batch, txHash)
    // Persist for the Pending Ops panel (survives reload until mined).
    recordPendingOp({
      id: prepared.batch,
      chain: prepared.chain,
      wallet: prepared.wallet,
      op: prepared.op,
      ids: prepared.ids,
      count: prepared.count,
      term: prepared.term,
      txHash,
      nonce: broadcastNonce,
      phase: 'broadcast'
    })
    state.send = 'done'
    emit()

    state.confirm = 'process'
    emit()
    const readProvider = getReadProvider(prepared.chain)
    const confirmMs = CONFIRM_TIMEOUT_MS[prepared.chain]
    let receipt
    try {
      receipt = await withTimeout(readProvider.waitForTransaction(txHash, 1), confirmMs, 'Confirmation')
    } catch (err: any) {
      if (/Confirmation timed out/i.test(err?.message || '')) {
        state.confirm = 'error'
        state.error =
          'Confirmation timed out. The transaction may still be pending — do not retry the same VMUs. Refresh later or check the explorer.'
        emit()
        throw err
      }
      throw err
    }

    if (!receipt) throw new Error('Transaction receipt missing')
    if (receipt.status === 0) {
      recordPendingOp({
        id: prepared.batch,
        chain: prepared.chain,
        wallet: prepared.wallet,
        op: prepared.op,
        ids: prepared.ids,
        count: prepared.count,
        term: prepared.term,
        txHash,
        nonce: broadcastNonce,
        phase: 'reverted'
      })
      resolved = true
      throw new Error('Transaction reverted on-chain')
    }
    recordPendingOp({
      id: prepared.batch,
      chain: prepared.chain,
      wallet: prepared.wallet,
      op: prepared.op,
      ids: prepared.ids,
      count: prepared.count,
      term: prepared.term,
      txHash,
      nonce: broadcastNonce,
      phase: 'confirmed'
    })
    resolved = true
    state.confirm = 'done'
    emit()
    return state
  } catch (err: any) {
    if (!broadcasted && awaitingWalletRecorded && isDefinitiveWalletRejection(err)) {
      recordPendingOp({
        id: prepared.batch,
        chain: prepared.chain,
        wallet: prepared.wallet,
        op: prepared.op,
        ids: prepared.ids,
        count: prepared.count,
        term: prepared.term,
        txHash: '',
        nonce: broadcastNonce,
        phase: 'dropped'
      })
      awaitingWalletResolved = true
    }
    if (state.send === 'process') state.send = 'error'
    else if (state.confirm === 'process') state.confirm = 'error'
    if (!state.error) state.error = normalizeError(err)
    emit()
    throw err
  } finally {
    if (
      lockHeld &&
      prepared.lockIds.length &&
      ((!broadcasted && (!awaitingWalletRecorded || awaitingWalletResolved)) || resolved)
    ) {
      releaseLock(prepared.batch)
    }
  }
}

function isDefinitiveWalletRejection(err: any): boolean {
  const code = err?.code ?? err?.info?.error?.code
  const message = err?.shortMessage || err?.message || ''
  return code === 4001 || /user rejected|user denied|rejected the request/i.test(message)
}

/** Abort a prepared op that was never sent (user soft lock). */
export function abortPrepared(prepared: PreparedOp | null | undefined): void {
  if (!prepared?.lockIds.length) return
  releaseLock(prepared.batch)
}

export function clearAbandonedSoftLocks(chain: ChainKey, wallet: string): void {
  clearSoftLocks(chain, wallet)
}

export async function resumePendingLocks(chain: ChainKey, wallet: string): Promise<boolean> {
  clearSoftLocks(chain, wallet)
  const pending = pendingLocks(chain, wallet)
  if (!pending.length) return false
  const provider = getReadProvider(chain)
  let resolvedAny = false
  await Promise.all(
    pending.map(async (lock) => {
      try {
        const receipt = await provider.getTransactionReceipt(lock.txHash)
        if (receipt) {
          resolvedAny = true
          releaseLock(lock.batch)
          return
        }
        const waited = await withTimeout(
          provider.waitForTransaction(lock.txHash, 1),
          Math.min(CONFIRM_TIMEOUT_MS[chain], 30_000),
          'Resume confirm'
        )
        if (waited) {
          resolvedAny = true
          releaseLock(lock.batch)
        }
      } catch {
        // keep lock
      }
    })
  )
  return resolvedAny
}

export function normalizeError(err: any): string {
  const msg: string = err?.shortMessage || err?.reason || err?.message || String(err)
  if (/PENDING_STATE_UNCERTAIN/i.test(msg))
    return 'Wallet and read RPC disagree about the pending nonce. Do not retry yet. Open MetaMask Activity, verify the selected network, then recheck.'
  if (/WALLET_ASLEEP/.test(msg))
    return 'Wallet did not respond (it may have gone idle). Click the MetaMask extension icon or reload the page, then retry.'
  if (/PENDING_TX|in-flight transaction limit|delegated accounts/i.test(msg))
    return 'A previous transaction is still pending. Open MetaMask → Activity, wait for it to confirm (or Speed up / Cancel it), then retry. EIP-7702 smart accounts usually allow only 1 in-flight tx.'
  if (/WALLET_PENDING|already pending|Request is already pending/i.test(msg))
    return 'MetaMask has a pending request. Open the MetaMask extension, approve or reject it, then retry.'
  if (/getChainId is not a function|connector\.getChainId/i.test(msg))
    return 'Wallet connector error. Reload the page and reconnect MetaMask, then retry.'
  if (/No injected wallet found/i.test(msg))
    return 'No browser wallet detected. Open MetaMask and reconnect.'
  if (/Transaction reverted on-chain/i.test(msg))
    return 'Transaction reverted on-chain. Refresh the list and try again.'
  if (/Wallet account changed|wrong network/i.test(msg)) return msg
  if (/still be pending/i.test(msg)) return msg
  if (/VMU state changed|already pending|limited to|Term must|count must|No .* selected/i.test(msg)) return msg
  if (/user rejected|denied|rejected the request/i.test(msg)) return 'Transaction rejected'
  if (msg.includes('-32603')) return 'RPC node error (-32603). Try switching RPC / clear pending txs in MetaMask.'
  if (msg.includes('-32080') || /HTTP client error/i.test(msg))
    return 'Wallet RPC endpoint error. Change the network RPC in your wallet, or use the in-app RPC button.'
  if (/insufficient funds/i.test(msg)) return 'Insufficient funds for gas + fee'
  if (/missing revert data|CALL_EXCEPTION/i.test(msg))
    return 'Estimation reverted. Check VMU count/term limits and that you have enough balance for the service fee.'
  return msg.slice(0, 200)
}
