import type { OpType } from './txManager'
import type { RpcHealthState } from './rpc'
import type { AnalyticsEventPayloads } from './analytics'

type AnalyticsOperation = AnalyticsEventPayloads['miner_operation']['operation']
type AnalyticsRpcState = AnalyticsEventPayloads['rpc_health_state']['state']

const OPERATION_NAMES: Record<OpType, AnalyticsOperation> = {
  GENERAL_MINT: 'general_mint',
  CREATE_EMPTY_SLOT: 'create_empty_slot',
  MINT_EMPTY_SLOT: 'mint_empty_slot',
  CLAIM: 'claim',
  CLAIM_REUSE: 'claim_reuse'
}

export function analyticsOperationName(operation: OpType): AnalyticsOperation {
  return OPERATION_NAMES[operation]
}

export function analyticsRpcHealthState(state: RpcHealthState): AnalyticsRpcState | null {
  if (state.checking || state.checkedAt === null) return null
  if (state.error || state.healthyUrls.length === 0) return 'unavailable'
  if (state.failures.length > 0) return 'degraded'
  return 'healthy'
}
