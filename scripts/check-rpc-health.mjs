// Validates every configured default RPC without requiring a wallet or private key.

import { Interface } from 'ethers'
import { CHAIN_CONFIG, getChainConfig } from './chain-config.mjs'
import { isMainModule, cliValue, normalizeProbeUrl } from './cli-utils.mjs'
import { rpcBatchResults, rpcStringResult, rpcChainId, rpcAbiWord } from './rpc-response.mjs'

const factoryInterface = new Interface(['function FEE() view returns (uint256)'])

export async function checkRpcEndpoint(url, config, fetchImpl = fetch) {
  try {
    return await inspectRpcEndpoint(url, config, fetchImpl)
  } catch (error) {
    return {
      url,
      healthy: false,
      error: `INVALID_RPC_RESPONSE: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

async function inspectRpcEndpoint(url, config, fetchImpl) {
  try {
    normalizeProbeUrl(url)
  } catch (error) {
    return { url, healthy: false, error: error.message }
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_call',
          params: [
            { to: config.factory, data: factoryInterface.encodeFunctionData('FEE') },
            'latest'
          ]
        }
      ])
    })
  } catch (error) {
    return {
      url,
      healthy: false,
      error: `REQUEST_FAILED: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (!response.ok) return { url, healthy: false, error: `HTTP_STATUS: ${response.status}` }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return {
      url,
      healthy: false,
      error: `INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const results = rpcBatchResults(payload, [1, 2])
  const chainId = rpcChainId(rpcStringResult(results, 1, 'eth_chainId'))
  const feeResult = rpcStringResult(results, 2, 'FEE')
  if (chainId !== BigInt(config.chainId)) {
    return {
      url,
      healthy: false,
      error: `CHAIN_ID_MISMATCH: expected ${config.chainId}, received ${chainId}.`
    }
  }

  try {
    const [fee] = factoryInterface.decodeFunctionResult('FEE', rpcAbiWord(feeResult, 'FEE'))
    return { url, healthy: true, chainId: Number(chainId), fee }
  } catch (error) {
    return {
      url,
      healthy: false,
      error: `FEE_CALL_FAILED: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function parseArgs(argv) {
  let chain
  const rpcUrls = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--chain') chain = cliValue(argv, ++index, value)
    else if (value === '--rpc') rpcUrls.push(cliValue(argv, ++index, value))
    else throw new Error(`Unknown argument ${JSON.stringify(value)}. Use --chain and --rpc.`)
  }
  if (rpcUrls.length > 0 && !chain)
    throw new Error('RPC_OVERRIDE_REQUIRES_CHAIN: pass --chain with --rpc.')
  return { chain, rpcUrls }
}

async function main() {
  const { chain, rpcUrls } = parseArgs(process.argv.slice(2))
  const configs = chain ? [getChainConfig(chain)] : Object.values(CHAIN_CONFIG)
  let failed = false

  for (const config of configs) {
    const urls = rpcUrls.length > 0 ? rpcUrls : config.rpcUrls
    console.log(
      `chain=${config.key} expectedChainId=${config.chainId} config=scripts/chain-config.mjs`
    )
    for (const url of urls) {
      const result = await checkRpcEndpoint(url, config)
      if (result.healthy) {
        console.log(`PASS ${result.url} https=true chainId=${result.chainId} FEE=${result.fee}`)
      } else {
        failed = true
        console.error(`FAIL ${result.url} ${result.error}`)
      }
    }
  }

  if (failed) process.exitCode = 1
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
