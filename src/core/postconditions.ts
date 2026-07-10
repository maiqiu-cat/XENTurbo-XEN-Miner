import type { ChainKey } from '@/config/chains'
import {
  readVmuCount,
  readVmuProxyDeployments,
  readVmuStatuses,
  type ProxyDeploymentStatus
} from './chainReader'
import type { OpType } from './txManager'
import type { VmuStatus } from './types'

type ExpectedVmuStatus = Exclude<VmuStatus, 'READ_ERROR' | 'CLAIMABLE'> | 'MINTING'

export interface OutcomeOperation {
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  /** Required for operations that allocate new, sequential VMU ids. */
  preVmuCount?: number
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
  readStatuses?: (
    chain: ChainKey,
    wallet: string,
    ids: number[]
  ) => Promise<Map<number, VmuStatus>>
  readProxyDeployments?: (
    chain: ChainKey,
    wallet: string,
    ids: number[]
  ) => Promise<Map<number, ProxyDeploymentStatus>>
  readCount?: (chain: ChainKey, wallet: string) => Promise<number>
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
    return [...prepared.ids]
  }

  if (!Number.isSafeInteger(prepared.preVmuCount) || prepared.preVmuCount! < 0) {
    throw new Error('POSTCONDITION_INPUT_MISSING: pre-operation VMU count is required')
  }

  return Array.from(
    { length: prepared.count },
    (_, index) => prepared.preVmuCount! + index + 1
  )
}

function uncertainReadResult(expectedStatus: ExpectedVmuStatus, expectedIds: number[]): OperationOutcome {
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

  let statuses: Map<number, VmuStatus>
  let deployments: Map<number, ProxyDeploymentStatus> | null = null
  let actualVmuCount: number | null = null
  try {
    if (prepared.op === 'CREATE_EMPTY_SLOT') {
      const [currentStatuses, currentDeployments, currentVmuCount] = await Promise.all([
        readStatuses(prepared.chain, prepared.wallet, expectedIds),
        readProxyDeployments(prepared.chain, prepared.wallet, expectedIds),
        readCount(prepared.chain, prepared.wallet)
      ])
      statuses = currentStatuses
      deployments = currentDeployments
      actualVmuCount = currentVmuCount
      if (!Number.isSafeInteger(actualVmuCount) || actualVmuCount < 0) {
        return uncertainOperationOutcome(prepared)
      }
    } else {
      statuses = await readStatuses(prepared.chain, prepared.wallet, expectedIds)
    }
  } catch {
    return uncertainOperationOutcome(prepared)
  }

  const matchingIds: number[] = []
  const unexpectedIds: number[] = []
  const readErrorIds: number[] = []

  for (const id of expectedIds) {
    const status = statuses.get(id)
    if (!status || status === 'READ_ERROR') {
      readErrorIds.push(id)
      continue
    }
    if (status !== expectedStatus) {
      unexpectedIds.push(id)
      continue
    }

    if (prepared.op === 'CREATE_EMPTY_SLOT') {
      const deployment = deployments?.get(id)
      if (!deployment || deployment === 'READ_ERROR') {
        readErrorIds.push(id)
        continue
      }
      if (deployment !== 'DEPLOYED' || actualVmuCount === null || id > actualVmuCount) {
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
