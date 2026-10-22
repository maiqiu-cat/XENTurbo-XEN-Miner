import { safeLogText } from './cli-utils.mjs'

export function rpcBatchResults(payload, ids) {
  if (!Array.isArray(payload) || payload.length > ids.length) {
    throw new Error('INVALID_BATCH: unexpected number or type of RPC results.')
  }
  const results = new Map()
  for (const item of payload) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.jsonrpc !== '2.0' ||
      !ids.includes(item.id)
    ) {
      throw new Error('INVALID_BATCH_MEMBER: expected a JSON-RPC 2.0 result with a requested ID.')
    }
    if (results.has(item.id)) throw new Error('DUPLICATE_ID: RPC result IDs must be unique.')
    if (Object.hasOwn(item, 'error') && Object.hasOwn(item, 'result')) {
      throw new Error('INVALID_RESULT: RPC result and error are mutually exclusive.')
    }
    results.set(item.id, item)
  }
  return results
}

export function rpcStringResult(results, id, label) {
  const item = results.get(id)
  if (!item) throw new Error(`RPC_RESULT_MISSING: ${label}.`)
  if (Object.hasOwn(item, 'error')) {
    const detail =
      typeof item.error?.message === 'string'
        ? safeLogText(item.error.message.slice(0, 200))
        : 'RPC returned an error'
    throw new Error(
      `${label === 'FEE' ? 'FEE_CALL_FAILED' : 'RPC_CALL_FAILED'}: ${label}: ${detail}`
    )
  }
  if (typeof item.result !== 'string')
    throw new Error(`INVALID_RESULT: ${label} requires a string result.`)
  return item.result
}

export function rpcChainId(value) {
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) {
    throw new Error('INVALID_CHAIN_ID: expected a canonical hex quantity of at most 256 bits.')
  }
  return BigInt(value)
}

export function rpcAbiWord(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`INVALID_ABI_WORD: ${label} requires one 32-byte ABI word.`)
  return value
}
