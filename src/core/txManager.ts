import { Contract, Interface } from 'ethers'
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
import { readFee, readVmuStatuses, readVmuStates } from './chainReader'
import { readWalletEvidence, type WalletReceipt } from './walletEvidence'
import { ReadTimeoutError } from './readDeadline'
import { mapWithConcurrency } from '@/utils/concurrency'
import {
  ensureHealthyReadProvider,
  getReadProvider,
  RpcConfigurationError,
  rpcConfigurationMessage,
  rpcUnavailableMessage
} from './rpc'
import { releaseLock, newBatchId, pendingLocks, tryAcquireLock, clearSoftLocks } from './localLock'
import { countUnresolvedPendingOps, recordPendingOp, removePendingOpRecord } from './pendingOps'
import { operationKey, runWalletExclusive } from './operationGate'
import {
  callInjectedContract,
  getInjectedAccount,
  getInjectedChainId,
  getInjectedLatestNonce,
  getInjectedPendingNonce,
  assertNonceAgreement
} from './eip1193'
import {
  uncertainOperationOutcome,
  verifyOperationOutcomeWithRetry,
  type OperationOutcome
} from './postconditions'
import type { VmuStatus } from './types'

export type OpType =
  'GENERAL_MINT' | 'CREATE_EMPTY_SLOT' | 'MINT_EMPTY_SLOT' | 'CLAIM' | 'CLAIM_REUSE'

export interface TxLogEntry {
  at: number
  status: 'process' | 'done' | 'error' | 'info'
  message: string
}

export interface TxStepState {
  estimate: 'wait' | 'process' | 'done' | 'error'
  send: 'wait' | 'process' | 'done' | 'error'
  confirm: 'wait' | 'process' | 'done' | 'error'
  /** True after estimate succeeds — UI should show "Open MetaMask" button. */
  readyToSign?: boolean
  /** True only after the EIP-1193 transaction request reaches the wallet. */
  walletPrompted?: boolean
  txHash?: string
  error?: string
  outcome?: OperationOutcome
  logs?: TxLogEntry[]
}

export interface TxCallbacks {
  onStep?: (state: TxStepState) => void
  /** Returns true while an unbroadcast operation should be abandoned. */
  isCancelled?: () => boolean
}

function txStateSnapshot(state: TxStepState): TxStepState {
  return {
    ...state,
    logs: state.logs?.map((entry) => ({ ...entry }))
  }
}

function appendTxLog(
  state: TxStepState,
  message: string,
  status: TxLogEntry['status'] = 'process'
): void {
  const previousStatus: TxLogEntry['status'] = status === 'error' ? 'error' : 'done'
  state.logs = [
    ...(state.logs ?? []).map((entry) =>
      entry.status === 'process' ? { ...entry, status: previousStatus } : entry
    ),
    { at: Date.now(), status, message }
  ]
}

/** Reject if a promise does not settle within `ms`, with a labelled error. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function awaitWalletResponse<T>(
  request: Promise<T>,
  timeoutMs: number,
  onLateResolve: (value: T) => void,
  onLateReject: (error: unknown) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let detached = false
    const timer = setTimeout(() => {
      detached = true
      reject(
        new Error(
          `WALLET_RESPONSE_TIMEOUT: Wallet request did not return within ${timeoutMs / 1000}s.`
        )
      )
    }, timeoutMs)

    request.then(
      (value) => {
        clearTimeout(timer)
        if (detached) {
          try {
            onLateResolve(value)
          } catch {
            // The pending record remains unresolved and can be reconciled manually.
          }
          return
        }
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        if (detached) {
          try {
            onLateReject(error)
          } catch {
            // The pending record remains unresolved and can be reconciled manually.
          }
          return
        }
        reject(error)
      }
    )
  })
}

const ESTIMATE_TIMEOUT_MS = 40_000
const PREFLIGHT_TIMEOUT_MS = 15_000
const PREFLIGHT_CONTRACT_TIMEOUT_MS = 30_000
const PROBE_UNITS = 32
const GAS_RATIO_SCALE = 10_000n
/** Keep 10% of the latest block gas limit free for block assembly variance. */
const BLOCK_GAS_SAFETY_BPS = 9_000n
export const PREPARED_OP_TTL_MS = 120_000
export const WALLET_RESPONSE_TIMEOUT_MS = 120_000
const UNCONFIRMED_BROADCAST_MESSAGE =
  'Transaction submitted, but confirmation could not be completed. Do not resend. Check wallet Activity and the explorer, then recheck pending operations.'
const BROADCAST_STORAGE_FAILURE_MESSAGE =
  'Transaction submitted, but its local record could not be saved. Do not resend. Do not clear site data. Keep this page open, save the transaction hash from the explorer link, and check wallet Activity before rechecking pending operations.'

const factoryIface = new Interface(XENFactoryABI as unknown as any[])

function collectErrorDetails(error: unknown, seen = new Set<unknown>(), depth = 0): string[] {
  if (error == null || depth > 4 || seen.has(error)) return []
  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean') {
    return [String(error)]
  }
  if (typeof error !== 'object') return []

  seen.add(error)
  const value = error as Record<string, unknown>
  const fields = [
    'name',
    'code',
    'message',
    'shortMessage',
    'reason',
    'data',
    'error',
    'info',
    'cause'
  ]
  return fields.flatMap((field) => collectErrorDetails(value[field], seen, depth + 1))
}

/** Only provider-capacity failures may use a smaller probe estimation. */
export function isRetryableEstimateError(error: unknown): boolean {
  const details = collectErrorDetails(error).join(' ')

  // These failures describe transaction semantics, so probing must not hide them.
  if (
    /CALL_EXCEPTION|CALL_FAILED|execution reverted|\brevert(?:ed)?\b|insufficient (?:funds|value)|INVALID_ARGUMENT|invalid (?:argument|params?)|intrinsic gas|user (?:rejected|denied)/i.test(
      details
    )
  ) {
    return false
  }

  return (
    /\bTIMEOUT\b|timed? out|deadline exceeded|ETIMEDOUT/i.test(details) ||
    /response (?:size|body).*?(?:too large|exceed)|payload too large|content length.*?exceed|max(?:imum)? response size|(?:^|\s)413(?:\s|$)/i.test(
      details
    ) ||
    /gas required exceeds allowance|(?:transaction|tx|rpc) gas (?:limit|cap).*?(?:exceed|too high)|gas (?:limit|cap) exceeded|exceeds (?:the )?(?:provider|block) gas (?:limit|cap)/i.test(
      details
    )
  )
}

function applyGasRatio(gas: bigint, ratio: number): bigint {
  if (gas < 0n || !Number.isFinite(ratio) || ratio <= 0) {
    throw new Error('Invalid gas estimate or safety ratio')
  }
  const ratioUnits = BigInt(Math.ceil(ratio * Number(GAS_RATIO_SCALE)))
  return (gas * ratioUnits + GAS_RATIO_SCALE - 1n) / GAS_RATIO_SCALE
}

/** Estimate the full call, using a fixed-size probe only for explicit provider limits. */
export async function estimateWithProbe(
  full: () => Promise<bigint>,
  probe: () => Promise<bigint>,
  units: number,
  ratio: number,
  probeUnits = PROBE_UNITS
): Promise<bigint> {
  try {
    return applyGasRatio(await full(), ratio)
  } catch (error) {
    if (units <= probeUnits || !isRetryableEstimateError(error)) throw error
  }

  // Let a probe failure propagate unchanged; it may contain useful revert data.
  const probeGas = await probe()
  const projected = (probeGas * BigInt(units) + BigInt(probeUnits) - 1n) / BigInt(probeUnits)
  return applyGasRatio(projected, ratio)
}

/** Reject unsafe batches against the current block limit; never clip the gas value. */
export function assertFitsBlockGasLimit(estimatedGas: bigint, blockGasLimit: bigint): bigint {
  if (blockGasLimit <= 0n) throw new Error('Latest block returned an invalid gas limit')
  const safeBlockGas = (blockGasLimit * BLOCK_GAS_SAFETY_BPS) / GAS_RATIO_SCALE
  if (estimatedGas > safeBlockGas) {
    throw new Error(
      `BATCH_GAS_LIMIT_EXCEEDED: Estimated gas ${estimatedGas.toLocaleString()} exceeds safe maximum ${safeBlockGas.toLocaleString()} (90% of current block gas limit ${blockGasLimit.toLocaleString()}). Reduce the VMU count.`
    )
  }
  return estimatedGas
}

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

  return estimateWithProbe(
    () =>
      withTimeout(
        buildEstimateCall(readFactory, op, { term, count, ids, from, value: valueFor(units) }),
        ESTIMATE_TIMEOUT_MS,
        'Gas estimation'
      ),
    () =>
      withTimeout(
        buildEstimateCall(readFactory, op, {
          term,
          count: PROBE_UNITS,
          ids: ids.slice(0, PROBE_UNITS),
          from,
          value: valueFor(PROBE_UNITS)
        }),
        ESTIMATE_TIMEOUT_MS,
        'Gas estimation'
      ),
    units,
    ratio
  )
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

function allocatesVmuIds(op: OpType): boolean {
  return op === 'GENERAL_MINT' || op === 'CREATE_EMPTY_SLOT'
}

function assertWholeNumber(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a whole number`)
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
}

export function validateOperationParams(params: {
  chain: ChainKey
  op: OpType
  ids: number[]
  count: number
  term: number
}): void {
  const { chain, op, ids, count, term } = params
  const lim = LIMITS[chain]

  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error('VMU ids must be unique positive whole numbers')
  }

  // createVMUs has no term — only mint / remint / claim-reuse need one.
  if (op === 'GENERAL_MINT' || op === 'MINT_EMPTY_SLOT' || op === 'CLAIM_REUSE') {
    assertWholeNumber(term, 'Term', 1, DEFAULT_TERM_MAX)
  }

  switch (op) {
    case 'GENERAL_MINT':
      assertWholeNumber(count, 'Mint count', 1, lim.generalMint)
      break
    case 'CREATE_EMPTY_SLOT':
      assertWholeNumber(count, 'Create count', 1, lim.createEmptySlot)
      break
    case 'MINT_EMPTY_SLOT':
      if (!ids.length) throw new Error('No empty VMUs selected')
      if (ids.length > lim.mintEmptySlot) {
        throw new Error(
          `Empty-slot mint limited to ${lim.mintEmptySlot} VMUs per tx (selected ${ids.length})`
        )
      }
      break
    case 'CLAIM':
      if (!ids.length) throw new Error('No claimable VMUs selected')
      if (ids.length > lim.claim) {
        throw new Error(
          `Claim limited to ${lim.claim} VMUs per tx (selected ${ids.length}). Deselect some and retry.`
        )
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

export function authoritativeServiceValue(params: {
  walletFee: bigint
  units: number
  feeApplies: boolean
}): bigint | undefined {
  const { walletFee, units, feeApplies } = params
  if (!feeApplies) return undefined
  if (walletFee < 0n || !Number.isSafeInteger(units) || units <= 0) {
    throw new Error('Invalid service fee inputs')
  }
  return walletFee * BigInt(units)
}

export function assertPreparedContext(
  prepared: Pick<PreparedOp, 'wallet' | 'chainId' | 'preparedAt' | 'expiresAt'>,
  account: string,
  chainId: number,
  now = Date.now()
): void {
  if (account.toLowerCase() !== prepared.wallet.toLowerCase()) {
    throw new Error('Wallet account changed during the operation. Reconnect and retry.')
  }
  if (chainId !== prepared.chainId) {
    throw new Error('Wallet is on the wrong network. Switch networks and retry.')
  }
  if (now > prepared.expiresAt) {
    throw new Error('Prepared transaction expired. Estimate again before signing.')
  }
}

async function readInjectedFactoryFee(factoryAddress: string): Promise<bigint> {
  const data = factoryIface.encodeFunctionData('FEE')
  const result = await callInjectedContract(factoryAddress, data)
  const fee = factoryIface.decodeFunctionResult('FEE', result)[0]
  if (typeof fee !== 'bigint' || fee < 0n) {
    throw new Error('Wallet returned an invalid factory fee')
  }
  return fee
}

async function readInjectedVmuCount(factoryAddress: string, wallet: string): Promise<number> {
  const data = factoryIface.encodeFunctionData('vmuCount', [wallet])
  const result = await callInjectedContract(factoryAddress, data)
  const rawCount = factoryIface.decodeFunctionResult('vmuCount', result)[0]
  if (typeof rawCount !== 'bigint' || rawCount < 0n || rawCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Wallet returned an invalid VMU count')
  }
  return Number(rawCount)
}

function assertOperationActive(callbacks: TxCallbacks): void {
  if (callbacks.isCancelled?.()) {
    throw new Error('OPERATION_CANCELLED: Operation cancelled before the wallet request opened.')
  }
}

export function strictSimulationFunction(op: OpType): string {
  switch (op) {
    case 'GENERAL_MINT':
      return 'bulkClaimRank_'
    case 'CREATE_EMPTY_SLOT':
      return 'createVMUs_'
    case 'MINT_EMPTY_SLOT':
      return 'reuseVMUs_'
    case 'CLAIM':
      return 'bulkClaimMintReward_'
    case 'CLAIM_REUSE':
      return 'bulkClaimMintRewardAndClaimRank_'
  }
}

async function simulatePreparedWithWallet(
  prepared: PreparedOp,
  value: bigint | undefined
): Promise<void> {
  const data = factoryIface.encodeFunctionData(strictSimulationFunction(prepared.op), prepared.args)
  await callInjectedContract(prepared.factoryAddress, data, {
    from: prepared.wallet,
    value
  })
}

async function assertIdsStillValid(
  chain: ChainKey,
  wallet: string,
  op: OpType,
  ids: number[]
): Promise<void> {
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

function buildCall(
  op: OpType,
  ids: number[],
  count: number,
  term: number
): { fnName: string; args: readonly unknown[] } {
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
      return {
        fnName: 'bulkClaimMintRewardAndClaimRank',
        args: [ids.map((i) => BigInt(i)), BigInt(term)]
      }
    default:
      throw new Error(`Unknown op ${op}`)
  }
}

/** Prepared tx after gas estimation — send must be triggered by a fresh user click. */
export interface PreparedOp {
  /** Shared across Vue refs and shallow copies; never reset after cancellation or dispatch. */
  lifecycle: { phase: 'prepared' | 'sending' | 'dispatched' | 'finished' | 'cancelled' }
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  term: number
  chainId: number
  factoryAddress: `0x${string}`
  contextKey: string
  preparedAt: number
  expiresAt: number
  gasLimit: bigint
  fnName: string
  args: readonly unknown[]
  batch: string
  lockIds: number[]
  state: TxStepState
  /** VMU count immediately before an allocating transaction is sent. */
  preVmuCount?: number
  receipt?: WalletReceipt
  beforeRanks?: Record<number, number>
}

/**
 * Phase 1: validate, soft-lock, re-read ids, estimate gas.
 * Does NOT call the wallet — returns a PreparedOp for phase 2.
 * MetaMask popups require a fresh user gesture; estimate often takes seconds
 * and breaks that gesture, so send is deferred to an explicit button click.
 */
/** pendingNonce - latestNonce; >0 means at least one in-flight tx. */
export async function getPendingTxCount(chain: ChainKey, wallet: string): Promise<number> {
  const [chainId, walletLatest, walletPending] = await withTimeout(
    Promise.all([
      getInjectedChainId(),
      getInjectedLatestNonce(wallet),
      getInjectedPendingNonce(wallet)
    ]),
    PREFLIGHT_TIMEOUT_MS,
    'Wallet network and pending transaction check'
  )
  if (chainId !== CHAINS[chain].chainId) {
    throw new Error('Wallet is on the wrong network. Switch networks and retry.')
  }
  const readProvider = getReadProvider(chain)
  const [rpcLatest, rpcPending] = await withTimeout(
    Promise.all([
      readProvider.getTransactionCount(wallet, 'latest'),
      readProvider.getTransactionCount(wallet, 'pending')
    ]),
    PREFLIGHT_TIMEOUT_MS,
    'Read RPC pending transaction check'
  )
  assertNonceAgreement(walletLatest, rpcLatest, 'latest')
  assertNonceAgreement(walletPending, rpcPending, 'pending')
  return Math.max(0, walletPending - walletLatest)
}

export async function prepareOperation(
  params: RunParams,
  cb: TxCallbacks = {}
): Promise<PreparedOp> {
  const { chain, wallet, op, ids = [], count = 0, term = 0 } = params
  const state: TxStepState = {
    estimate: 'wait',
    send: 'wait',
    confirm: 'wait',
    logs: []
  }
  const emit = () => cb.onStep?.(txStateSnapshot(state))
  const log = (message: string, status: TxLogEntry['status'] = 'process') => {
    appendTxLog(state, message, status)
    emit()
  }
  const batch = newBatchId()
  const lockIds = op === 'GENERAL_MINT' || op === 'CREATE_EMPTY_SLOT' ? [] : ids
  let lockAcquired = false

  state.estimate = 'process'
  try {
    log('Validating operation parameters...')
    validateOperationParams({ chain, op, ids, count, term })
    assertOperationActive(cb)
    log('Operation parameters validated.', 'done')

    log('Checking configured RPC availability...')
    const readProvider = await ensureHealthyReadProvider(chain)
    assertOperationActive(cb)
    log('Configured RPC is available.', 'done')

    // Block before any gas spend if a previous tx is still in-flight.
    // EIP-7702 / Infura only allows 1 in-flight tx for delegated accounts.
    log('Checking wallet network and pending transactions...')
    const inflight = await getPendingTxCount(chain, wallet)
    assertOperationActive(cb)
    if (inflight > 0) {
      throw new Error(
        `PENDING_TX: ${inflight} transaction(s) still pending on-chain. Wait for confirmation (or Speed up / Cancel in MetaMask) before submitting another.`
      )
    }
    log('Wallet network is correct and no pending transaction was found.', 'done')

    const readFactory = getReadFactory(chain)
    const ratio = GAS_LIMIT_RATIO[chain]
    const factoryAddress = CONTRACTS[chain].factory as `0x${string}`
    const chainId = CHAINS[chain].chainId
    const feeApplies =
      !FREE_CHAINS.includes(chain) &&
      (op === 'GENERAL_MINT' || op === 'MINT_EMPTY_SLOT' || op === 'CLAIM_REUSE')
    if (feeApplies) log('Reading the current contract service fee...')
    const fee = feeApplies
      ? await withTimeout(readFee(chain), PREFLIGHT_CONTRACT_TIMEOUT_MS, 'Factory fee read')
      : 0n
    assertOperationActive(cb)
    if (feeApplies) log('Current contract service fee loaded.', 'done')

    if (lockIds.length) {
      log('Reserving the selected VMUs for this operation...')
      if (!tryAcquireLock({ chain, wallet, ids: lockIds, batch, op, count, term })) {
        throw new Error(
          'LOCK_CONFLICT: Some selected VMUs are already pending in another tab/window. Wait or refresh.'
        )
      }
      lockAcquired = true
      log('Selected VMUs reserved in this browser.', 'done')
    }

    log('Rechecking selected VMU state on-chain...')
    await withTimeout(
      assertIdsStillValid(chain, wallet, op, ids),
      PREFLIGHT_CONTRACT_TIMEOUT_MS,
      'Selected VMU validation'
    )
    assertOperationActive(cb)
    log('Selected VMUs are still eligible.', 'done')
    void warmUpInjected(chainId).catch(() => {})

    log('Estimating gas and checking the latest block limit...')
    const [estimatedGas, latestBlock] = await Promise.all([
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
      withTimeout(
        readProvider.getBlock('latest'),
        PREFLIGHT_CONTRACT_TIMEOUT_MS,
        'Latest block read'
      )
    ])
    assertOperationActive(cb)
    if (!latestBlock) throw new Error('Latest block is unavailable; cannot validate the gas limit')
    const gasLimit = assertFitsBlockGasLimit(estimatedGas, latestBlock.gasLimit)

    state.estimate = 'done'
    state.readyToSign = true
    log('Gas estimate is ready. Open MetaMask to review and sign.', 'done')

    const { fnName, args } = buildCall(op, ids, count, term)
    const preparedAt = Date.now()
    return {
      lifecycle: { phase: 'prepared' },
      chain,
      wallet,
      op,
      ids,
      count,
      term,
      chainId,
      factoryAddress,
      contextKey: `${chainId}:${wallet.toLowerCase()}`,
      preparedAt,
      expiresAt: preparedAt + PREPARED_OP_TTL_MS,
      gasLimit,
      fnName,
      args,
      batch,
      lockIds,
      state
    }
  } catch (err: any) {
    if (lockAcquired) releaseLock(batch)
    state.estimate = 'error'
    state.error = normalizeError(err)
    state.readyToSign = false
    log(`Preparation failed: ${state.error}`, 'error')
    throw err
  }
}

/**
 * Phase 2: send + confirm. MUST be called from a click handler so MetaMask
 * receives a fresh user gesture and can show the signature popup.
 */
export async function sendPreparedOperation(
  prepared: PreparedOp,
  cb: TxCallbacks = {}
): Promise<TxStepState> {
  const lifecycle = prepared.lifecycle
  if (lifecycle.phase === 'cancelled') throw new Error('OPERATION_CANCELLED')
  if (lifecycle.phase !== 'prepared') throw new Error('OPERATION_ALREADY_STARTED')
  lifecycle.phase = 'sending'
  const assertSending = () => {
    if (lifecycle.phase !== 'sending') throw new Error('OPERATION_CANCELLED')
    assertOperationActive(cb)
  }
  const state: TxStepState = {
    estimate: 'done',
    send: 'process',
    confirm: 'wait',
    readyToSign: false,
    walletPrompted: false,
    logs: prepared.state.logs?.map((entry) => ({ ...entry })) ?? []
  }
  const emit = () => cb.onStep?.(txStateSnapshot(state))
  const log = (message: string, status: TxLogEntry['status'] = 'process') => {
    appendTxLog(state, message, status)
    emit()
  }
  const lockHeld = prepared.lockIds.length > 0
  let broadcasted = false
  let resolved = false
  let broadcastNonce: number | null = null
  let awaitingWalletRecorded = false
  let awaitingWalletResolved = false

  const recordBroadcast = (txHash: string) => {
    broadcasted = true
    awaitingWalletResolved = true
    state.txHash = txHash
    state.walletPrompted = false
    state.send = 'done'
    appendTxLog(
      state,
      `Transaction submitted: ${txHash.slice(0, 10)}...${txHash.slice(-8)}.`,
      'done'
    )
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
      phase: 'broadcast',
      nonceAuthoritative: false,
      preVmuCount: prepared.preVmuCount,
      beforeRanks: prepared.beforeRanks
    })
  }

  const recordWalletDrop = (releaseImmediately = false) => {
    if (awaitingWalletResolved) return
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
    if (releaseImmediately && lockHeld && prepared.lockIds.length) releaseLock(prepared.batch)
  }

  const settleLateWalletFailure = (error: unknown) => {
    if (!awaitingWalletRecorded || !isDefinitiveWalletRejection(error)) return
    recordWalletDrop(true)
  }

  const recordLateBroadcast = (txHash: string) => {
    state.confirm = 'error'
    state.error = UNCONFIRMED_BROADCAST_MESSAGE
    try {
      recordBroadcast(txHash)
    } catch {
      state.error = BROADCAST_STORAGE_FAILURE_MESSAGE
    }
    log(state.error, 'error')
  }

  try {
    assertSending()
    log('Starting final checks before opening MetaMask...')
    const walletSend = runWalletExclusive(
      operationKey(prepared.chain, prepared.wallet),
      async () => {
        assertSending()
        // Keep the final safety check, nonce read, and wallet request in one
        // cross-tab critical section so two tabs cannot send concurrently.
        log('Checking unresolved local transaction records...')
        const unresolvedLocal = countUnresolvedPendingOps(prepared.chain, prepared.wallet)
        if (unresolvedLocal > 0) {
          throw new Error(
            `LOCAL_PENDING_UNRESOLVED: ${unresolvedLocal} local transaction record(s) still require reconciliation. Recheck pending operations before submitting another transaction.`
          )
        }
        log('No unresolved local transaction record was found.', 'done')

        log('Rechecking RPC availability and pending nonce...')
        await ensureHealthyReadProvider(prepared.chain)
        assertSending()
        const inflight = await getPendingTxCount(prepared.chain, prepared.wallet)
        assertSending()
        if (inflight > 0) {
          throw new Error(
            `PENDING_TX: ${inflight} transaction(s) still pending on-chain. Wait for confirmation (or Speed up / Cancel in MetaMask) before submitting another.`
          )
        }
        log('RPC and pending nonce checks passed.', 'done')

        log('Checking active wallet account and network...')
        const [injectedAccount, injectedChainId] = await withTimeout(
          Promise.all([getInjectedAccount(), getInjectedChainId()]),
          PREFLIGHT_TIMEOUT_MS,
          'Wallet account and network check'
        )
        assertSending()
        if (!injectedAccount) throw new Error('No wallet account available. Reconnect your wallet.')
        assertPreparedContext(prepared, injectedAccount, injectedChainId)
        log('Active wallet account and network match the prepared operation.', 'done')

        const units =
          prepared.op === 'GENERAL_MINT' || prepared.op === 'CREATE_EMPTY_SLOT'
            ? prepared.count
            : prepared.ids.length
        const feeApplies =
          !FREE_CHAINS.includes(prepared.chain) &&
          (prepared.op === 'GENERAL_MINT' ||
            prepared.op === 'MINT_EMPTY_SLOT' ||
            prepared.op === 'CLAIM_REUSE')

        log('Reading the current wallet nonce and contract data...')
        const [walletNonce, walletFee, preVmuCount] = await withTimeout(
          Promise.all([
            getInjectedPendingNonce(prepared.wallet),
            feeApplies ? readInjectedFactoryFee(prepared.factoryAddress) : Promise.resolve(0n),
            allocatesVmuIds(prepared.op)
              ? readInjectedVmuCount(prepared.factoryAddress, prepared.wallet)
              : Promise.resolve(undefined)
          ]),
          PREFLIGHT_CONTRACT_TIMEOUT_MS,
          'Wallet transaction data read'
        )
        assertSending()
        prepared.preVmuCount = preVmuCount
        const nonce = walletNonce
        broadcastNonce = nonce
        const value = authoritativeServiceValue({
          walletFee,
          units,
          feeApplies
        })
        log('Current nonce, fee, and contract data loaded.', 'done')

        // Preparation can be seconds old by the time the user confirms. Re-read
        // selected IDs inside the cross-tab lock at the actual send boundary.
        log('Revalidating selected VMUs before sending...')
        await withTimeout(
          assertIdsStillValid(prepared.chain, prepared.wallet, prepared.op, prepared.ids),
          PREFLIGHT_CONTRACT_TIMEOUT_MS,
          'Selected VMU revalidation'
        )
        assertSending()
        log('Selected VMUs passed the final validation.', 'done')
        if (prepared.op === 'CLAIM_REUSE') {
          const before = await withTimeout(
            readVmuStates(prepared.chain, prepared.wallet, prepared.ids),
            PREFLIGHT_CONTRACT_TIMEOUT_MS,
            'Pre-remint VMU state'
          )
          if (before.some((vmu) => !vmu.readOk))
            throw new Error('Selected VMU state could not be read before re-minting')
          prepared.beforeRanks = Object.fromEntries(before.map((vmu) => [vmu.id, vmu.rank]))
          assertSending()
        }
        log('Simulating transaction with MetaMask...')
        await withTimeout(
          simulatePreparedWithWallet(prepared, value),
          PREFLIGHT_CONTRACT_TIMEOUT_MS,
          'Wallet transaction simulation'
        )
        assertSending()
        log('Transaction simulation succeeded.', 'done')

        try {
          return await writeFactory({
            chainId: prepared.chainId,
            address: prepared.factoryAddress,
            abi: XENFactoryABI,
            functionName: prepared.fnName,
            simulationFunctionName: strictSimulationFunction(prepared.op),
            args: prepared.args,
            value,
            nonce,
            expectedFrom: prepared.wallet,
            onRequestStart: () => {
              assertSending()
              assertPreparedContext(prepared, prepared.wallet, prepared.chainId)
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
                phase: 'awaiting-wallet',
                nonceAuthoritative: false
              })
              awaitingWalletRecorded = true
              lifecycle.phase = 'dispatched'
              state.send = 'process'
              state.walletPrompted = true
              log('MetaMask request opened. Review the details and confirm or reject it.')
            },
            onRequestSyncError: () => {
              if (!awaitingWalletRecorded) return
              removePendingOpRecord(prepared.batch)
              awaitingWalletResolved = true
            }
          })
        } catch (error) {
          if (
            awaitingWalletRecorded &&
            !awaitingWalletResolved &&
            isDefinitiveWalletRejection(error)
          ) {
            recordWalletDrop()
          }
          throw error
        }
      }
    )
    const txHash = await awaitWalletResponse(
      walletSend,
      WALLET_RESPONSE_TIMEOUT_MS,
      recordLateBroadcast,
      settleLateWalletFailure
    )
    recordBroadcast(txHash)
    emit()

    state.confirm = 'process'
    log('Waiting for the transaction to be confirmed on-chain...')
    const readProvider = await ensureHealthyReadProvider(prepared.chain)
    const confirmMs = CONFIRM_TIMEOUT_MS[prepared.chain]
    let receipt
    try {
      receipt = await readProvider.waitForTransaction(txHash, 1, confirmMs)
    } catch (err: any) {
      if (err?.code === 'TIMEOUT' || /timed? out|timeout/i.test(err?.message || '')) {
        state.confirm = 'error'
        state.error =
          'Confirmation timed out. The transaction may still be pending. Do not resend. Check wallet Activity and the explorer, then recheck pending operations.'
        emit()
        throw err
      }
      throw err
    }

    if (!receipt) throw new Error('Transaction receipt missing')
    log('Cross-checking the receipt through the wallet...')
    let settlement
    for (const delay of [0, 500, 1_500, 3_000]) {
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      const evidence = await readWalletEvidence(prepared.chain, prepared.wallet, txHash, {
        nonce: broadcastNonce,
        nonceAuthoritative: false
      })
      settlement = evidence.settlement
      if (settlement) break
    }
    if (!settlement)
      throw new Error(
        'WALLET_EVIDENCE_UNAVAILABLE: The wallet has not confirmed this receipt yet. Keep the transaction pending and recheck; do not resend.'
      )
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
      phase: settlement.phase,
      settlement,
      preVmuCount: prepared.preVmuCount
    })
    resolved = true
    if (settlement.phase === 'replaced')
      throw new Error(
        'The wallet confirms this nonce was consumed by another transaction. Check wallet Activity before preparing again.'
      )
    prepared.receipt = settlement.receipt
    if (settlement.phase === 'reverted') {
      log('The transaction receipt reports an on-chain revert.', 'error')
      throw new Error('Transaction reverted on-chain')
    }
    log('Transaction confirmed on-chain. Verifying the resulting VMU state.', 'done')
    try {
      state.outcome = await verifyOperationOutcomeWithRetry(prepared)
    } catch {
      // The outer receipt is confirmed. A verifier failure only makes the
      // result uncertain and must not keep the operation or VMU locks pending.
      state.outcome = uncertainOperationOutcome(prepared)
    }
    state.confirm = 'done'
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
      phase: 'confirmed',
      settlement,
      preVmuCount: prepared.preVmuCount,
      beforeRanks: prepared.beforeRanks,
      outcome: state.outcome
    })
    if (state.outcome.classification === 'full') {
      log('Transaction result verified.', 'done')
    } else if (state.outcome.classification === 'partial') {
      log('Transaction confirmed, but result verification found partial success.', 'info')
    } else {
      log('Transaction confirmed, but the final result could not be fully verified.', 'info')
    }
    return state
  } catch (err: any) {
    if (
      !broadcasted &&
      awaitingWalletRecorded &&
      !awaitingWalletResolved &&
      isDefinitiveWalletRejection(err)
    ) {
      recordWalletDrop()
    }
    if (!broadcasted && state.send !== 'done') state.send = 'error'
    else if (broadcasted || state.confirm === 'process') state.confirm = 'error'
    if (!state.error)
      state.error =
        broadcasted && /PENDING_STORAGE_(?:READ|WRITE)_FAILED/i.test(err?.message || '')
          ? BROADCAST_STORAGE_FAILURE_MESSAGE
          : broadcasted && !resolved
            ? UNCONFIRMED_BROADCAST_MESSAGE
            : normalizeError(err)
    log(`Transaction stopped: ${state.error}`, 'error')
    throw err
  } finally {
    finishPreparedLifecycle(prepared, resolved || awaitingWalletResolved)
    if (
      lockHeld &&
      prepared.lockIds.length &&
      ((!broadcasted && (!awaitingWalletRecorded || awaitingWalletResolved)) || resolved)
    ) {
      releaseLock(prepared.batch)
    }
  }
}

function finishPreparedLifecycle(prepared: PreparedOp, settled: boolean): void {
  const phase = prepared.lifecycle.phase
  if (phase === 'sending' || (phase === 'dispatched' && settled)) {
    prepared.lifecycle.phase = 'finished'
  }
}

function isDefinitiveWalletRejection(err: any): boolean {
  const code = err?.code ?? err?.info?.error?.code
  const message = err?.shortMessage || err?.message || ''
  return code === 4001 || /user rejected|user denied|rejected the request/i.test(message)
}

/** Abort a prepared op that was never sent (user soft lock). */
export function abortPrepared(prepared: PreparedOp | null | undefined): void {
  if (!prepared || !['prepared', 'sending'].includes(prepared.lifecycle.phase)) return
  prepared.lifecycle.phase = 'cancelled'
  if (prepared.lockIds.length) releaseLock(prepared.batch)
}

export function clearAbandonedSoftLocks(chain: ChainKey, wallet: string): void {
  clearSoftLocks(chain, wallet)
}

export async function resumePendingLocks(chain: ChainKey, wallet: string): Promise<boolean> {
  clearSoftLocks(chain, wallet)
  const pending = pendingLocks(chain, wallet)
  if (!pending.length) return false
  await ensureHealthyReadProvider(chain)
  let resolvedAny = false
  await mapWithConcurrency(pending, 4, async (lock) => {
    try {
      const { settlement } = await readWalletEvidence(chain, wallet, lock.txHash)
      if (settlement) {
        // The cache may hold the only durable hash after a journal-write failure.
        recordPendingOp({
          id: lock.batch,
          chain,
          wallet,
          op: lock.op ?? 'GENERAL_MINT',
          ids: lock.ids,
          count: lock.count ?? 0,
          term: lock.term ?? 0,
          txHash: lock.txHash,
          phase: settlement.phase,
          settlement,
          submittedAt: lock.lockedAt,
          origin: 'legacy-unknown',
          nonceAuthoritative: false
        })
        resolvedAny = true
      }
    } catch {
      // keep lock
    }
  })
  return resolvedAny
}

export function normalizeError(
  err: any,
  context: 'transaction' | 'storage-recovery' = 'transaction'
): string {
  const msg: string = err?.shortMessage || err?.reason || err?.message || String(err)
  if (/OPERATION_CANCELLED/i.test(msg)) return 'Operation cancelled. No transaction was submitted.'
  if (/^LOCK_CONFLICT:/i.test(msg))
    return 'Some selected VMUs are already pending in another tab/window. Wait or refresh.'
  if (err?.code === 'RPC_READ_INVALIDATED')
    return 'The RPC read was cancelled because its context changed. No transaction was submitted by this read. Start a new read with the current settings.'
  if (err?.code === 'RPC_RATE_LIMITED') return err.message
  if (/OPERATION_ALREADY_STARTED/i.test(msg))
    return 'This prepared operation has already started or finished. Check wallet Activity and recheck pending operations. Do not resend.'
  if (/Prepared transaction expired/i.test(msg))
    return 'The prepared transaction expired after 2 minutes. Estimate it again before signing.'
  if (/RPC_UNAVAILABLE|RPC_NOT_VALIDATED/i.test(msg)) {
    if (err instanceof RpcConfigurationError) return rpcConfigurationMessage(err.message)
    return rpcUnavailableMessage()
  }
  if (/PENDING_STORAGE_(?:READ|WRITE)_FAILED|LOCK_STORAGE_INVALID/i.test(msg)) {
    const action =
      context === 'storage-recovery'
        ? 'Restore storage access, then inspect again.'
        : 'Open transaction storage recovery.'
    return `Local transaction storage is unavailable or damaged. ${action} Do not clear site data or resend; check wallet Activity first.`
  }
  if (/WALLET_CONTEXT_CHANGED/i.test(msg))
    return 'Wallet account or network changed. Reconnect the original account and network, then recheck transaction records. Do not resend.'
  if (/READ_TIMEOUT/i.test(msg)) {
    const detail = err instanceof ReadTimeoutError ? ` ${err.diagnostic}` : ''
    return `Wallet or network read timed out.${detail} Check your connection and wallet, then recheck transaction records. Do not resend.`
  }
  if (/WALLET_EVIDENCE_UNAVAILABLE/i.test(msg))
    return 'Wallet transaction evidence is unavailable. Check wallet Activity and the selected network, then recheck. Do not resend.'
  if (/PENDING_STATE_UNCERTAIN/i.test(msg))
    return 'Wallet and read RPC disagree about the pending nonce. Do not retry yet. Open MetaMask Activity, verify the selected network, then recheck.'
  if (/WALLET_ASLEEP/.test(msg))
    return 'Wallet did not respond (it may have gone idle). Click the MetaMask extension icon or reload the page, then retry.'
  if (/WALLET_LOCK_TIMEOUT/i.test(msg))
    return 'Another tab is currently using this wallet. Wait for that transaction to finish, then retry.'
  if (/WALLET_RESPONSE_TIMEOUT/i.test(msg))
    return 'MetaMask did not return a result within 2 minutes. This page stopped waiting, but the wallet request may still be active. Check MetaMask Activity and recheck pending operations before retrying.'
  if (/LOCAL_PENDING_UNRESOLVED/i.test(msg))
    return 'A previous local transaction record is unresolved. Recheck pending operations. If it remains unknown, verify MetaMask Activity and the block explorer before marking it dropped.'
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
  if (/VMU state changed|already pending|limited to|Term must|count must|No .* selected/i.test(msg))
    return msg
  if (/user rejected|denied|rejected the request/i.test(msg)) return 'Transaction rejected'
  if (msg.includes('-32603'))
    return 'RPC node error (-32603). Try switching RPC / clear pending txs in MetaMask.'
  if (msg.includes('-32080') || /HTTP client error/i.test(msg))
    return 'Wallet RPC endpoint error. Change the network RPC in your wallet, or use the in-app RPC button.'
  if (/insufficient funds/i.test(msg)) return 'Insufficient funds for gas + fee'
  if (/missing revert data|CALL_EXCEPTION/i.test(msg))
    return 'Estimation reverted. Check VMU count/term limits and that you have enough balance for the service fee.'
  return msg.slice(0, 200)
}
