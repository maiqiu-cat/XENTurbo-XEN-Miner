// Read-only production release probe. It never signs or broadcasts a transaction.

import { Interface } from 'ethers'
import { CHAIN_CONFIG } from './chain-config.mjs'
import { isMainModule, normalizeProbeUrl, diagnosticError, safeLogText } from './cli-utils.mjs'
import { rpcBatchResults, rpcStringResult, rpcChainId, rpcAbiWord } from './rpc-response.mjs'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const factoryInterface = new Interface([
  'function FEE() view returns (uint256)',
  'function vmuCount(address) view returns (uint256)'
])

function rpcCall(id, method, params) {
  return { jsonrpc: '2.0', id, method, params }
}

function usableCode(value) {
  return typeof value === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(value)
}

export async function probeReleaseEndpoint(url, config, fetchImpl = fetch) {
  try {
    normalizeProbeUrl(url)
  } catch (error) {
    return { healthy: false, url, error: error.message }
  }

  const requests = [
    rpcCall(1, 'eth_chainId', []),
    rpcCall(2, 'eth_getCode', [config.factory, 'latest']),
    rpcCall(3, 'eth_getCode', [config.xenCrypto, 'latest']),
    rpcCall(4, 'eth_getCode', [config.vmuTemplate, 'latest']),
    rpcCall(5, 'eth_call', [
      { to: config.factory, data: factoryInterface.encodeFunctionData('FEE') },
      'latest'
    ]),
    rpcCall(6, 'eth_call', [
      { to: config.factory, data: factoryInterface.encodeFunctionData('vmuCount', [ZERO_ADDRESS]) },
      'latest'
    ])
  ]
  const payload = []
  const signal = AbortSignal.timeout(10_000)
  let readingResponse = false
  try {
    // Match the browser's public endpoint wire limit; retain one total time budget.
    for (let start = 0; start < requests.length; start += 3) {
      const batch = requests.slice(start, start + 3)
      readingResponse = false
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(batch)
      })
      if (!response.ok) return { healthy: false, url, error: `HTTP_STATUS: ${response.status}` }
      readingResponse = true
      const part = await response.json()
      rpcBatchResults(
        part,
        batch.map(({ id }) => id)
      )
      payload.push(...part)
    }
  } catch (error) {
    const interrupted =
      signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    return {
      healthy: false,
      url,
      error: `${readingResponse && !interrupted ? 'INVALID_RESULT' : 'REQUEST_FAILED'}: ${diagnosticError(error)}`
    }
  }
  try {
    const results = rpcBatchResults(payload, [1, 2, 3, 4, 5, 6])
    const chainId = rpcChainId(rpcStringResult(results, 1, 'eth_chainId'))
    if (chainId !== BigInt(config.chainId)) {
      return {
        healthy: false,
        url,
        error: `CHAIN_ID_MISMATCH: expected ${config.chainId}, received ${chainId}`
      }
    }
    for (const [id, label] of [
      [2, 'factory'],
      [3, 'xenCrypto'],
      [4, 'vmuTemplate']
    ]) {
      if (!usableCode(rpcStringResult(results, id, label))) {
        return { healthy: false, url, error: `CONTRACT_CODE_MISSING: ${label}` }
      }
    }
    const [fee] = factoryInterface.decodeFunctionResult(
      'FEE',
      rpcAbiWord(rpcStringResult(results, 5, 'FEE'), 'FEE')
    )
    const [vmuCount] = factoryInterface.decodeFunctionResult(
      'vmuCount',
      rpcAbiWord(rpcStringResult(results, 6, 'vmuCount'), 'vmuCount')
    )
    return { healthy: true, url, chainId: Number(chainId), fee, vmuCount }
  } catch (error) {
    return {
      healthy: false,
      url,
      error: `INVALID_RESULT: ${diagnosticError(error)}`
    }
  }
}

async function main() {
  if (process.argv.length > 2)
    throw new Error('UNEXPECTED_ARGUMENT: this probe does not accept CLI options.')
  let failed = false
  for (const config of Object.values(CHAIN_CONFIG)) {
    let passed = null
    for (const url of config.rpcUrls) {
      const result = await probeReleaseEndpoint(url, config)
      if (result.healthy) {
        passed = result
        break
      }
      console.error(safeLogText(`WARN chain=${config.key} rpc=${url} ${result.error}`))
    }
    if (!passed) {
      failed = true
      console.error(`FAIL chain=${config.key} no endpoint passed the release probe`)
      continue
    }
    console.log(
      `PASS chain=${config.key} chainId=${passed.chainId} contracts=3/3 FEE=${passed.fee} vmuCountZero=${passed.vmuCount}`
    )
  }
  if (failed) process.exitCode = 1
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(diagnosticError(error))
    process.exitCode = 1
  })
}
