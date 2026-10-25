import { ReadTimeoutError } from './readDeadline'

type ErrorRecord = Record<string, unknown>

function record(value: unknown): ErrorRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as ErrorRecord) : undefined
}

export class RpcReadInvalidatedError extends Error {
  constructor() {
    super('RPC configuration changed. Start a new read with the current settings.')
    this.name = 'RpcReadInvalidatedError'
  }
}

export type RpcFailureKind = 'rate-limit' | 'transient' | 'capacity' | 'permanent'

/** Inspect the original RPC error, not CALL_EXCEPTION's generated "missing revert data" text. */
export function rpcFailureKind(error: unknown): RpcFailureKind {
  const value = record(error)
  if (
    error instanceof RpcReadInvalidatedError ||
    value?.name === 'AbortError' ||
    value?.code === 'CANCELLED'
  ) {
    return 'permanent'
  }
  if (error instanceof ReadTimeoutError) return 'transient'

  const rpc = record(record(value?.info)?.error) ?? record(value?.error)
  const message = typeof rpc?.message === 'string' ? rpc.message : ''
  const outer = [value?.message, value?.shortMessage, value?.code]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
  const data = [value?.data, rpc?.data, record(rpc?.data)?.data]
  if (
    data.some((part) => typeof part === 'string' && /^0x[0-9a-f]+$/i.test(part)) ||
    /execution reverted|\brevert(?:ed)?\b/i.test(message) ||
    /INVALID_ARGUMENT|invalid (?:argument|params?)|insufficient funds|user (?:rejected|denied)|ACTION_REJECTED|network changed|NONCE_EXPIRED/i.test(
      outer
    ) ||
    rpc?.code === -32602 ||
    (value?.code === 'CALL_EXCEPTION' && typeof value.reason === 'string' && value.reason !== '')
  ) {
    return 'permanent'
  }
  if (
    /(?:result|response|returndata|payload|batch|query|logs?).{0,100}(?:exceed|limit|maximum|too (?:large|big|many)|more than)|(?:limit|maximum).{0,60}(?:bytes|items|results|response|payload|batch)/i.test(
      message
    )
  ) {
    return 'capacity'
  }

  const response = record(value?.response)
  const status = Number(response?.statusCode ?? value?.status)
  const diagnostic = rpc ? message : outer || String(error)
  if (status === 429 || /too many requests|rate[ -]?limit|throttl/i.test(diagnostic)) {
    return 'rate-limit'
  }
  if (
    status === 408 ||
    (status >= 500 && status <= 599) ||
    /temporar(?:y|ily)|unavailable|overloaded|server busy|\btimeout\b|\btimed out\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|failed to fetch|network error|network request failed|offline/i.test(
      diagnostic
    ) ||
    value?.code === 'TIMEOUT'
  ) {
    return 'transient'
  }
  return 'permanent'
}

export function isRetryableRpcError(error: unknown): boolean {
  const kind = rpcFailureKind(error)
  return kind === 'transient' || kind === 'rate-limit'
}

/** Retry-After is a minimum delay, in seconds or an HTTP date, never an SDK millisecond count. */
export function rpcRetryAfterMs(error: unknown, now = Date.now()): number | null {
  const value = record(error)
  if (typeof value?.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs)) {
    return value.retryAfterMs >= 0 ? value.retryAfterMs : null
  }
  const headers = record(record(value?.response)?.headers)
  const header = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof header !== 'string') return null
  const raw = header.trim()
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1_000
    return Number.isSafeInteger(ms) ? ms : null
  }
  // Reject numeric garbage that Date.parse can otherwise interpret as a calendar date.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(raw)) return null
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}
