import type { ChainKey } from '@/config/chains'
import {
  readVmuCount,
  readVmuProxyDeployments,
  readVmuStatuses,
  readVmuStates,
  type ChainReadContext,
  type ProxyDeploymentStatus
} from './chainReader'
import type { OpType } from './txManager'
import type { VmuStatus, Vmu } from './types'
import { ensureRecentReadProvider, getReadProvider, withRetry } from './rpc'
import type { WalletReceipt } from './walletEvidence'
import { assertReadActive } from './readDeadline'

type ExpectedVmuStatus = Exclude<VmuStatus, 'READ_ERROR' | 'CLAIMABLE'> | 'MINTING'

export interface OutcomeOperation {
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  /** Required for operations that allocate new, sequential VMU ids. */
  preVmuCount?: number
  term?: number
  receipt?: WalletReceipt
  beforeRanks?: Record<number, number>
}

export type OperationOutcomeClassification = 'full' | 'partial' | 'uncertain'

export interface OperationOutcome {
  classification: OperationOutcomeClassification
  expectedStatus: ExpectedVmuStatus
  expectedCount: number
  expectedIds: number[]
  matchingCount: number
  matchingIds: number[]
  unexpectedCount: number
  unexpectedIds: number[]
  readErrorCount: number
  readErrorIds: number[]
}

interface VerifyOutcomeDependencies {
  signal?: AbortSignal
  readStatuses?: (
    chain: ChainKey,
    wallet: string,
    ids: number[],
    context?: ChainReadContext
  ) => Promise<Map<number, VmuStatus>>
  readStates?: (
    chain: ChainKey,
    wallet: string,
    ids: number[],
    context?: ChainReadContext
  ) => Promise<Vmu[]>
  readProxyDeployments?: (
    chain: ChainKey,
    wallet: string,
    ids: number[],
    context?: ChainReadContext
  ) => Promise<Map<number, ProxyDeploymentStatus>>
  readCount?: (chain: ChainKey, wallet: string, context?: ChainReadContext) => Promise<number>
}

function expectedStatusFor(op: OpType): ExpectedVmuStatus {
  switch (op) {
    case 'GENERAL_MINT':
    case 'MINT_EMPTY_SLOT':
    case 'CLAIM_REUSE':
      return 'MINTING'
    case 'CREATE_EMPTY_SLOT':
    case 'CLAIM':
      return 'EMPTY'
  }
}

function expectedIdsFor(prepared: OutcomeOperation): number[] {
  if (prepared.op !== 'GENERAL_MINT' && prepared.op !== 'CREATE_EMPTY_SLOT') {
    if (
      prepared.ids.length === 0 ||
      prepared.ids.length > 1_000 ||
      new Set(prepared.ids).size !== prepared.ids.length ||
      prepared.ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 100_000)
    )
      throw new Error('POSTCONDITION_INPUT_INVALID: VMU ids are outside the supported range')
    return [...prepared.ids]
  }

  if (
    !Number.isSafeInteger(prepared.preVmuCount) ||
    prepared.preVmuCount! < 0 ||
    prepared.preVmuCount! > 100_000
  ) {
    throw new Error('POSTCONDITION_INPUT_MISSING: pre-operation VMU count is required')
  }
  if (
    !Number.isSafeInteger(prepared.count) ||
    prepared.count <= 0 ||
    prepared.count > 1_000 ||
    prepared.preVmuCount! + prepared.count > 100_000
  )
    throw new Error('POSTCONDITION_INPUT_INVALID: VMU count is outside the supported range')

  return Array.from({ length: prepared.count }, (_, index) => prepared.preVmuCount! + index + 1)
}

function uncertainReadResult(
  expectedStatus: ExpectedVmuStatus,
  expectedIds: number[]
): OperationOutcome {
  return {
    classification: 'uncertain',
    expectedStatus,
    expectedCount: expectedIds.length,
    expectedIds,
    matchingCount: 0,
    matchingIds: [],
    unexpectedCount: 0,
    unexpectedIds: [],
    readErrorCount: expectedIds.length,
    readErrorIds: [...expectedIds]
  }
}

/** Build an uncertain result without throwing, including defensive verifier failures. */
export function uncertainOperationOutcome(prepared: OutcomeOperation): OperationOutcome {
  const expectedStatus = expectedStatusFor(prepared.op)
  try {
    return uncertainReadResult(expectedStatus, expectedIdsFor(prepared))
  } catch {
    const expectedCount =
      prepared.op === 'GENERAL_MINT' || prepared.op === 'CREATE_EMPTY_SLOT'
        ? prepared.count
        : prepared.ids.length
    return {
      classification: 'uncertain',
      expectedStatus,
      expectedCount,
      expectedIds: [],
      matchingCount: 0,
      matchingIds: [],
      unexpectedCount: 0,
      unexpectedIds: [],
      readErrorCount: expectedCount,
      readErrorIds: []
    }
  }
}

/**
 * Verify the state transition after a status-1 outer receipt. Read failures are
 * reported as uncertain outcomes and never reclassified as transaction reverts.
 */
export async function verifyOperationOutcome(
  prepared: OutcomeOperation,
  deps: VerifyOutcomeDependencies = {}
): Promise<OperationOutcome> {
  const expectedStatus = expectedStatusFor(prepared.op)
  const expectedIds = expectedIdsFor(prepared)
  const readStatuses = deps.readStatuses ?? readVmuStatuses
  const readProxyDeployments = deps.readProxyDeployments ?? readVmuProxyDeployments
  const readCount = deps.readCount ?? readVmuCount
  const context: ChainReadContext = { blockTag: prepared.receipt?.blockNumber }
  if (deps.signal) context.signal = deps.signal
  const mintedStates = new Map<number, Vmu>()
  let receiptTimeMs: number | undefined

  let statuses = new Map<number, VmuStatus>()
  let deployments: Map<number, ProxyDeploymentStatus> | null = null
  let actualVmuCount: number | null = null
  try {
    assertReadActive(deps.signal)
    if (prepared.receipt) {
      const block = await withRetry(
        () => getReadProvider(prepared.chain).getBlock(prepared.receipt!.blockNumber),
        { signal: deps.signal }
      )
      if (
        !block ||
        block.hash?.toLowerCase() !== prepared.receipt.blockHash.toLowerCase() ||
        block.number !== prepared.receipt.blockNumber ||
        !Number.isSafeInteger(block.timestamp) ||
        block.timestamp <= 0
      )
        return uncertainOperationOutcome(prepared)
      receiptTimeMs = block.timestamp * 1000
    }
    if (prepared.op === 'CREATE_EMPTY_SLOT') {
      actualVmuCount = await readCount(prepared.chain, prepared.wallet, context)
      if (!Number.isSafeInteger(actualVmuCount) || actualVmuCount < 0) {
        return uncertainOperationOutcome(prepared)
      }
      const observableIds = expectedIds.filter((id) => id <= actualVmuCount!)
      if (observableIds.length) {
        ;[statuses, deployments] = await Promise.all([
          readStatuses(prepared.chain, prepared.wallet, observableIds, context),
          readProxyDeployments(prepared.chain, prepared.wallet, observableIds, context)
        ])
      } else {
        deployments = new Map()
      }
    } else {
      statuses = await readStatuses(prepared.chain, prepared.wallet, expectedIds, context)
      if (expectedStatus === 'MINTING' && prepared.term !== undefined) {
        const states = await (deps.readStates ?? readVmuStates)(
          prepared.chain,
          prepared.wallet,
          expectedIds,
          context
        )
        for (const state of states) mintedStates.set(state.id, state)
      }
    }
  } catch {
    assertReadActive(deps.signal)
    return uncertainOperationOutcome(prepared)
  }
  assertReadActive(deps.signal)

  const matchingIds: number[] = []
  const unexpectedIds: number[] = []
  const readErrorIds: number[] = []

  for (const id of expectedIds) {
    if (prepared.op === 'CREATE_EMPTY_SLOT' && actualVmuCount !== null && id > actualVmuCount) {
      unexpectedIds.push(id)
      continue
    }
    const status = statuses.get(id)
    if (!status || status === 'READ_ERROR') {
      readErrorIds.push(id)
      continue
    }
    if (status !== expectedStatus) {
      unexpectedIds.push(id)
      continue
    }
    if (expectedStatus === 'MINTING' && prepared.term !== undefined) {
      const mint = mintedStates.get(id)
      if (!mint?.readOk) {
        readErrorIds.push(id)
        continue
      }
      const expectedMaturity =
        receiptTimeMs === undefined ? undefined : receiptTimeMs + prepared.term * 86_400_000
      if (
        mint.term !== prepared.term ||
        mint.rank <= 0 ||
        mint.rank === prepared.beforeRanks?.[id] ||
        (expectedMaturity !== undefined && mint.maturityTs !== expectedMaturity)
      ) {
        unexpectedIds.push(id)
        continue
      }
    }

    if (prepared.op === 'CREATE_EMPTY_SLOT') {
      const deployment = deployments?.get(id)
      if (!deployment || deployment === 'READ_ERROR') {
        readErrorIds.push(id)
        continue
      }
      if (deployment !== 'DEPLOYED') {
        unexpectedIds.push(id)
        continue
      }
    }

    matchingIds.push(id)
  }

  const classification: OperationOutcomeClassification = readErrorIds.length
    ? 'uncertain'
    : unexpectedIds.length
      ? 'partial'
      : 'full'

  return {
    classification,
    expectedStatus,
    expectedCount: expectedIds.length,
    expectedIds,
    matchingCount: matchingIds.length,
    matchingIds,
    unexpectedCount: unexpectedIds.length,
    unexpectedIds,
    readErrorCount: readErrorIds.length,
    readErrorIds
  }
}

const POSTCONDITION_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const

/** Retry latest-state reads after a receipt so lagging RPCs do not create false partial results. */
export async function verifyOperationOutcomeWithRetry(
  prepared: OutcomeOperation,
  options: {
    verify?: (operation: OutcomeOperation) => Promise<OperationOutcome>
    sleep?: (delayMs: number) => Promise<void>
    signal?: AbortSignal
  } = {}
): Promise<OperationOutcome> {
  const verify =
    options.verify ?? ((operation) => verifyOperationOutcome(operation, { signal: options.signal }))
  const sleep =
    options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))

  const verifyWithHealthyRpc = async (): Promise<OperationOutcome> => {
    assertReadActive(options.signal)
    await ensureRecentReadProvider(prepared.chain, 30_000)
    assertReadActive(options.signal)
    return verify(prepared)
  }

  let result: OperationOutcome
  try {
    result = await verifyWithHealthyRpc()
  } catch {
    assertReadActive(options.signal)
    result = uncertainOperationOutcome(prepared)
  }
  if (result.classification === 'full') return result
  let stablePartial = result.classification === 'partial' ? 1 : 0
  let previousSignature = JSON.stringify(result.unexpectedIds)

  for (const delayMs of POSTCONDITION_RETRY_DELAYS_MS) {
    await sleep(delayMs)
    assertReadActive(options.signal)
    try {
      result = await verifyWithHealthyRpc()
    } catch {
      assertReadActive(options.signal)
      result = uncertainOperationOutcome(prepared)
    }
    if (result.classification === 'full') return result
    const signature = JSON.stringify(result.unexpectedIds)
    stablePartial =
      result.classification === 'partial'
        ? previousSignature === signature
          ? stablePartial + 1
          : 1
        : 0
    previousSignature = signature
  }
  return result.classification === 'partial' && stablePartial >= 2
    ? result
    : uncertainOperationOutcome(prepared)
}
