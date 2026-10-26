import { ReadTimeoutError } from './readDeadline'

type ErrorRecord = Record<string, unknown>

export const MAX_COOLDOWN_MS = 60_000

function record(value: unknown): ErrorRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as ErrorRecord) : undefined
}

/** Extract a single HTTP error or an unassigned whole-batch BAD_DATA reply. */
function rpcErrorResponse(error: unknown): { rpc: ErrorRecord; unassigned: boolean } | undefined {
  const value = record(error)
  let body: unknown
  if (value?.code === 'SERVER_ERROR') {
    const responseBody = record(value.info)?.responseBody
    if (typeof responseBody !== 'string') return undefined
    try {
      body = JSON.parse(responseBody)
    } catch {
      return undefined
    }
  } else if (value?.code === 'BAD_DATA' && value.shortMessage === 'missing response for request') {
    body = value.value
  } else {
    return undefined
  }
  const reply = record(Array.isArray(body) ? (body.length === 1 ? body[0] : undefined) : body)
  if (!reply || 'result' in reply || (value.code === 'BAD_DATA' && reply.id != null))
    return undefined
  const rpc = record(reply.error)
  return rpc && Number.isSafeInteger(rpc.code) && typeof rpc.message === 'string'
    ? { rpc, unassigned: reply.id == null }
    : undefined
}

export function rpcResponseError(error: unknown): ErrorRecord | undefined {
  return rpcErrorResponse(error)?.rpc
}

export class RpcReadInvalidatedError extends Error {
  readonly code = 'RPC_READ_INVALIDATED'

  constructor() {
    super('RPC configuration changed. Start a new read with the current settings.')
    this.name = 'RpcReadInvalidatedError'
  }
}

export class RpcRateLimitError extends Error {
  readonly code = 'RPC_RATE_LIMITED'
  readonly retryAfterMs: number | undefined

  constructor(retryAfterMs?: number, options?: ErrorOptions) {
    const boundedDelay =
      retryAfterMs === undefined || !Number.isFinite(retryAfterMs)
        ? undefined
        : Math.max(1, Math.min(retryAfterMs, MAX_COOLDOWN_MS))
    super(
      boundedDelay === undefined
        ? 'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
        : `RPC endpoints are rate-limited. Retry in ${Math.ceil(boundedDelay / 1_000)}s. Your RPC list was preserved.`,
      options
    )
    this.name = 'RpcRateLimitError'
    this.retryAfterMs = boundedDelay
  }
}

export function isRpcReadInvalidated(error: unknown): boolean {
  return error instanceof RpcReadInvalidatedError || record(error)?.code === 'RPC_READ_INVALIDATED'
}

export function isRpcReadCancelled(error: unknown): boolean {
  const value = record(error)
  return isRpcReadInvalidated(error) || value?.name === 'AbortError' || value?.code === 'CANCELLED'
}

// Endpoint failures may fail over once, but only transient/rate-limit failures may replay.
export type RpcFailureKind = 'rate-limit' | 'transient' | 'capacity' | 'endpoint' | 'permanent'

/** Inspect the original RPC error, not CALL_EXCEPTION's generated "missing revert data" text. */
export function rpcFailureKind(error: unknown): RpcFailureKind {
  const value = record(error)
  if (isRpcReadCancelled(error)) return 'permanent'
  if (error instanceof ReadTimeoutError) return 'transient'

  const directRpc =
    record(record(value?.info)?.error) ??
    record(value?.error) ??
    (typeof value?.code === 'number' ? value : undefined)
  const responseRpc = directRpc ? undefined : rpcErrorResponse(error)
  const rpc = directRpc ?? responseRpc?.rpc
  const message = typeof rpc?.message === 'string' ? rpc.message : ''
  const response = record(value?.response)
  const status = Number(response?.statusCode ?? value?.status)
  const outer = [
    Number.isFinite(status) ? undefined : value?.message,
    value?.shortMessage,
    value?.code
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
  const data = [value?.data, rpc?.data, record(rpc?.data)?.data]
  const capacity =
    status === 413 ||
    /(?:result|response|returndata|payload|batch|query|logs?).{0,100}(?:exceed|limit|maximum|too (?:large|big|many)|more than)|(?:limit|maximum).{0,60}(?:bytes|items|results|response|payload|batch)/i.test(
      message
    )
  // An unassigned -32600 rejects the request envelope, not an individual call's semantics.
  if (
    rpc?.code === -32600 &&
    responseRpc?.unassigned &&
    !(status === 429 || status === 408 || (status >= 500 && status <= 599))
  )
    return capacity ? 'capacity' : 'endpoint'
  if (
    data.some((part) => typeof part === 'string' && /^0x[0-9a-f]+$/i.test(part)) ||
    /execution reverted|\brevert(?:ed)?\b/i.test(message) ||
    /INVALID_ARGUMENT|invalid (?:argument|params?)|insufficient funds|user (?:rejected|denied)|ACTION_REJECTED|NONCE_EXPIRED|execution reverted/i.test(
      `${message} ${outer}`
    ) ||
    (rpc?.code === -32600 && !responseRpc?.unassigned) ||
    rpc?.code === -32602 ||
    (value?.code === 'CALL_EXCEPTION' && typeof value.reason === 'string' && value.reason !== '')
  ) {
    return 'permanent'
  }
  if (capacity) return 'capacity'
  if (status === 429) return 'rate-limit'

  // Validated RPC semantics win; HTTP status wins over unstructured HTML/SDK text.
  if (!rpc) {
    if (status === 408 || (status >= 500 && status <= 599)) return 'transient'
    if (status >= 400 && status <= 499) return 'endpoint'
  }
  const diagnostic = rpc
    ? message
    : typeof value?.shortMessage === 'string'
      ? value.shortMessage
      : typeof value?.code === 'string'
        ? value.code
        : outer || String(error)
  if (
    value?.code === 'RPC_RATE_LIMITED' ||
    rpc?.code === -32005 ||
    rpc?.code === -32007 ||
    rpc?.code === 429 ||
    /too many requests|rate[ -]?limit|throttl|request rate|rate exceeded|quota|capacity|requests? limit|limit(?:ed)? reached/i.test(
      diagnostic
    )
  ) {
    return 'rate-limit'
  }
  if (
    /temporar(?:y|ily)|unavailable|overloaded|server busy|header not found|unknown block|block not found|block number too high|in the future|resource not found|deadline exceeded|missing trie node|state (?:is )?not available|\btimeout\b|\btimed out\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|failed to fetch|network error|network request failed|offline/i.test(
      diagnostic
    ) ||
    value?.code === 'TIMEOUT'
  ) {
    return 'transient'
  }
  // Unclassified structured errors still retain the HTTP transport's retry/cooldown signal.
  if (status === 408 || (status >= 500 && status <= 599)) return 'transient'
  return 'endpoint'
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
