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
import { readFee, readVmuStatuses } from './chainReader'
import { ensureHealthyReadProvider, getReadProvider } from './rpc'
import {
  attachTxHash,
  releaseLock,
  newBatchId,
  pendingLocks,
  tryAcquireLock,
  clearSoftLocks
} from './localLock'
import { countUnresolvedPendingOps, recordPendingOp, removePendingOpRecord } from './pendingOps'
import { operationKey, runWalletExclusive } from './operationGate'
import {
  callInjectedContract,
  getInjectedAccount,
  getInjectedChainId,
  getInjectedLatestNonce,
  getInjectedPendingNonce
} from './eip1193'
import {
  uncertainOperationOutcome,
  verifyOperationOutcomeWithRetry,
  type OperationOutcome
} from './postconditions'
import type { VmuStatus } from './types'

export type OpType =
  'GENERAL_MINT' | 'CREATE_EMPTY_SLOT' | 'MINT_EMPTY_SLOT' | 'CLAIM' | 'CLAIM_REUSE'

export interface TxStepState {
  estimate: 'wait' | 'process' | 'done' | 'error'
  send: 'wait' | 'process' | 'done' | 'error'
  confirm: 'wait' | 'process' | 'done' | 'error'
  /** True after estimate succeeds — UI should show "Open MetaMask" button. */
  readyToSign?: boolean
  txHash?: string
  error?: string
  outcome?: OperationOutcome
}

export interface TxCallbacks {
  onStep?: (state: TxStepState) => void
  /** Returns true while an unbroadcast operation should be abandoned. */
  isCancelled?: () => boolean
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
const GAS_RATIO_SCALE = 10_000n
/** Keep 10% of the latest block gas limit free for block assembly variance. */
const BLOCK_GAS_SAFETY_BPS = 9_000n
export const PREPARED_OP_TTL_MS = 120_000

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
}

/**
 * Phase 1: validate, soft-lock, re-read ids, estimate gas.
 * Does NOT call the wallet — returns a PreparedOp for phase 2.
 * MetaMask popups require a fresh user gesture; estimate often takes seconds
 * and breaks that gesture, so send is deferred to an explicit button click.
 */
/** pendingNonce - latestNonce; >0 means at least one in-flight tx. */
export async function getPendingTxCount(chain: ChainKey, wallet: string): Promise<number> {
  const [chainId, latest, pending] = await Promise.all([
    getInjectedChainId(),
    getInjectedLatestNonce(wallet),
    getInjectedPendingNonce(wallet)
  ])
  if (chainId !== CHAINS[chain].chainId) {
    throw new Error('Wallet is on the wrong network. Switch networks and retry.')
  }
  return Math.max(0, pending - latest)
}

export async function prepareOperation(
  params: RunParams,
  cb: TxCallbacks = {}
): Promise<PreparedOp> {
  const { chain, wallet, op, ids = [], count = 0, term = 0 } = params
  const state: TxStepState = { estimate: 'wait', send: 'wait', confirm: 'wait' }
  const emit = () => cb.onStep?.({ ...state })

  validateOperationParams({ chain, op, ids, count, term })

  let readProvider
  try {
    readProvider = await ensureHealthyReadProvider(chain)
  } catch (err: any) {
    state.estimate = 'error'
    state.error = normalizeError(err)
    emit()
    throw err
  }

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

  const feeApplies =
    !FREE_CHAINS.includes(chain) &&
    (op === 'GENERAL_MINT' || op === 'MINT_EMPTY_SLOT' || op === 'CLAIM_REUSE')
  const fee = feeApplies ? await readFee(chain) : 0n

  const batch = newBatchId()
  const lockIds = op === 'GENERAL_MINT' || op === 'CREATE_EMPTY_SLOT' ? [] : ids

  if (lockIds.length) {
    if (!tryAcquireLock({ chain, wallet, ids: lockIds, batch, op, count, term })) {
      throw new Error(
        'Some selected VMUs are already pending in another tab/window. Wait or refresh.'
      )
    }
  }

  try {
    await assertIdsStillValid(chain, wallet, op, ids)
    void warmUpInjected(chainId).catch(() => {})

    state.estimate = 'process'
    emit()
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
      readProvider.getBlock('latest')
    ])
    if (!latestBlock) throw new Error('Latest block is unavailable; cannot validate the gas limit')
    const gasLimit = assertFitsBlockGasLimit(estimatedGas, latestBlock.gasLimit)

    state.estimate = 'done'
    state.readyToSign = true
    emit()

    const { fnName, args } = buildCall(op, ids, count, term)
    const preparedAt = Date.now()
    return {
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
export async function sendPreparedOperation(
  prepared: PreparedOp,
  cb: TxCallbacks = {}
): Promise<TxStepState> {
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
  let broadcastNonce: number | null = null
  let awaitingWalletRecorded = false
  let awaitingWalletResolved = false

  try {
    assertOperationActive(cb)
    const walletSend = runWalletExclusive(
      operationKey(prepared.chain, prepared.wallet),
      async () => {
        assertOperationActive(cb)
        // Keep the final safety check, nonce read, and wallet request in one
        // cross-tab critical section so two tabs cannot send concurrently.
        const unresolvedLocal = countUnresolvedPendingOps(prepared.chain, prepared.wallet)
        if (unresolvedLocal > 0) {
          throw new Error(
            `LOCAL_PENDING_UNRESOLVED: ${unresolvedLocal} local transaction record(s) still require reconciliation. Recheck pending operations before submitting another transaction.`
          )
        }

        await ensureHealthyReadProvider(prepared.chain)
        const inflight = await getPendingTxCount(prepared.chain, prepared.wallet)
        if (inflight > 0) {
          throw new Error(
            `PENDING_TX: ${inflight} transaction(s) still pending on-chain. Wait for confirmation (or Speed up / Cancel in MetaMask) before submitting another.`
          )
        }

        const [injectedAccount, injectedChainId] = await Promise.all([
          getInjectedAccount(),
          getInjectedChainId()
        ])
        if (!injectedAccount) throw new Error('No wallet account available. Reconnect your wallet.')
        assertPreparedContext(prepared, injectedAccount, injectedChainId)

        const units =
          prepared.op === 'GENERAL_MINT' || prepared.op === 'CREATE_EMPTY_SLOT'
            ? prepared.count
            : prepared.ids.length
        const feeApplies =
          !FREE_CHAINS.includes(prepared.chain) &&
          (prepared.op === 'GENERAL_MINT' ||
            prepared.op === 'MINT_EMPTY_SLOT' ||
            prepared.op === 'CLAIM_REUSE')

        const [walletNonce, walletFee, preVmuCount] = await Promise.all([
          getInjectedPendingNonce(prepared.wallet),
          feeApplies ? readInjectedFactoryFee(prepared.factoryAddress) : Promise.resolve(0n),
          allocatesVmuIds(prepared.op)
            ? readInjectedVmuCount(prepared.factoryAddress, prepared.wallet)
            : Promise.resolve(undefined)
        ])
        prepared.preVmuCount = preVmuCount
        const nonce = walletNonce
        broadcastNonce = nonce
        const value = authoritativeServiceValue({
          walletFee,
          units,
          feeApplies
        })

        // Preparation can be seconds old by the time the user confirms. Re-read
        // selected IDs inside the cross-tab lock at the actual send boundary.
        await assertIdsStillValid(prepared.chain, prepared.wallet, prepared.op, prepared.ids)
        await simulatePreparedWithWallet(prepared, value)

        return writeFactory({
          chainId: prepared.chainId,
          address: prepared.factoryAddress,
          abi: XENFactoryABI,
          functionName: prepared.fnName,
          args: prepared.args,
          value,
          gas: prepared.gasLimit,
          nonce,
          expectedFrom: prepared.wallet,
          onRequestStart: () => {
            assertOperationActive(cb)
            assertPreparedContext(prepared, prepared.wallet, prepared.chainId)
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
          },
          onRequestSyncError: () => {
            if (!awaitingWalletRecorded) return
            removePendingOpRecord(prepared.batch)
            awaitingWalletResolved = true
          }
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
    const readProvider = await ensureHealthyReadProvider(prepared.chain)
    const confirmMs = CONFIRM_TIMEOUT_MS[prepared.chain]
    let receipt
    try {
      receipt = await withTimeout(
        readProvider.waitForTransaction(txHash, 1),
        confirmMs,
        'Confirmation'
      )
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
    try {
      state.outcome = await verifyOperationOutcomeWithRetry(prepared)
    } catch {
      // The outer receipt is confirmed. A verifier failure only makes the
      // result uncertain and must not keep the operation or VMU locks pending.
      state.outcome = uncertainOperationOutcome(prepared)
    }
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
    if (!broadcasted && state.send !== 'done') state.send = 'error'
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
  const provider = await ensureHealthyReadProvider(chain)
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
  if (/OPERATION_CANCELLED/i.test(msg)) return 'Operation cancelled. No transaction was submitted.'
  if (/Prepared transaction expired/i.test(msg))
    return 'The prepared transaction expired after 2 minutes. Estimate it again before signing.'
  if (/RPC_UNAVAILABLE|RPC_NOT_VALIDATED/i.test(msg))
    return 'No configured RPC endpoint responded on the expected network. Your RPC list was preserved. Check internet access, DNS, firewall, and proxy/VPN settings, then retry; or change endpoints in RPC settings.'
  if (/PENDING_STORAGE_WRITE_FAILED/i.test(msg))
    return 'Browser storage is full or unavailable. Clear old site data before sending another transaction.'
  if (/PENDING_STATE_UNCERTAIN/i.test(msg))
    return 'Wallet and read RPC disagree about the pending nonce. Do not retry yet. Open MetaMask Activity, verify the selected network, then recheck.'
  if (/WALLET_ASLEEP/.test(msg))
    return 'Wallet did not respond (it may have gone idle). Click the MetaMask extension icon or reload the page, then retry.'
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
