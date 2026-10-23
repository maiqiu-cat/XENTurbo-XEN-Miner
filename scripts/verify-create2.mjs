// Verifies local CREATE2 proxy derivation against the selected chain's on-chain state.
//
// Usage:
//   node scripts/verify-create2.mjs --chain eth --wallet 0x... [--rpc https://...]
//     [--from-id 1] [--scan-limit 1000] [--deadline-ms 30000]
//   CREATE2_WITNESS_POLYGON=0x... node scripts/verify-create2.mjs --chain polygon

import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { setTimeout as sleep } from 'node:timers/promises'
import { Contract, FetchRequest, JsonRpcProvider, getAddress } from 'ethers'
import { computeProxyAddress, minimalProxyRuntimeCode } from '../src/core/create2.ts'
import { getChainConfig } from './chain-config.mjs'
import { cliValue, isMainModule, normalizeProbeUrl, diagnosticError } from './cli-utils.mjs'

const SCAN_BATCH_SIZE = 5
const DEFAULT_SCAN_LIMIT = 1_000
const MAX_SCAN_LIMIT = 100_000
const DEFAULT_DEADLINE_MS = 30_000
const MAX_DEADLINE_MS = 300_000
const UINT256_MAX = (1n << 256n) - 1n
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const factoryAbi = ['function vmuCount(address) view returns (uint256)']
const xenAbi = [
  'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
]

export function rateLimitDelay(retryAfter, attempt, remainingMs, now = Date.now()) {
  const serverDelay =
    typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1_000
      : typeof retryAfter === 'string'
        ? Date.parse(retryAfter) - now
        : Number.NaN
  const fromHeader = Number.isFinite(serverDelay) && serverDelay >= 0
  const delay = fromHeader ? Math.min(serverDelay, 2_147_483_647) : 100 * 2 ** attempt
  if (delay >= remainingMs) {
    const code = fromHeader
      ? 'RATE_LIMIT_RETRY_AFTER_EXCEEDS_BUDGET'
      : 'RATE_LIMIT_BACKOFF_EXCEEDS_BUDGET'
    const error = new Error(code)
    error.code = code
    throw error
  }
  return delay
}

function positiveOption(value, flag, maximum) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value)) {
    throw new Error(`INVALID_SCAN_OPTION: ${flag} requires a positive decimal integer.`)
  }
  const parsed = BigInt(value)
  if (parsed > BigInt(maximum)) {
    throw new Error(`INVALID_SCAN_OPTION: ${flag} must not exceed ${maximum}.`)
  }
  return parsed
}

export function parseVerificationArgs(argv, env = process.env) {
  let chain
  let rpcUrl
  let wallet
  let fromId = '1'
  let scanLimit = String(DEFAULT_SCAN_LIMIT)
  let deadlineMs = String(DEFAULT_DEADLINE_MS)

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--chain') chain = cliValue(argv, ++index, value)
    else if (value === '--wallet') wallet = cliValue(argv, ++index, value)
    else if (value === '--rpc') rpcUrl = cliValue(argv, ++index, value)
    else if (value === '--from-id') fromId = cliValue(argv, ++index, value)
    else if (value === '--scan-limit') scanLimit = cliValue(argv, ++index, value)
    else if (value === '--deadline-ms') deadlineMs = cliValue(argv, ++index, value)
    else
      throw new Error(
        `Unknown argument ${JSON.stringify(value)}. Use --chain, --wallet, --rpc, --from-id, --scan-limit, and --deadline-ms.`
      )
  }

  if (!chain) throw new Error('CHAIN_REQUIRED: pass --chain eth or --chain polygon.')
  const config = getChainConfig(chain)
  const witnessVariable = `CREATE2_WITNESS_${config.key.toUpperCase()}`
  const witness = wallet ?? env[witnessVariable]
  if (!witness) {
    throw new Error(
      `WITNESS_REQUIRED: pass --wallet for ${config.key} or set ${witnessVariable}; no default wallet is used.`
    )
  }

  return {
    config,
    rpcUrl: normalizeProbeUrl(rpcUrl ?? config.rpcUrls[0], true),
    wallet: getAddress(witness),
    fromId: positiveOption(fromId, '--from-id', UINT256_MAX),
    scanLimit: Number(positiveOption(scanLimit, '--scan-limit', MAX_SCAN_LIMIT)),
    deadlineMs: Number(positiveOption(deadlineMs, '--deadline-ms', MAX_DEADLINE_MS))
  }
}

export async function verifyCreate2({
  config,
  provider,
  wallet,
  log = console.log,
  fromId = 1n,
  scanLimit = DEFAULT_SCAN_LIMIT,
  deadlineMs = DEFAULT_DEADLINE_MS
}) {
  if (
    typeof fromId !== 'bigint' ||
    fromId < 1n ||
    fromId > UINT256_MAX ||
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < 1 ||
    scanLimit > MAX_SCAN_LIMIT ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_DEADLINE_MS
  ) {
    throw new Error('INVALID_SCAN_OPTION: scan range and deadline must be positive and bounded.')
  }

  const deadline = performance.now() + deadlineMs
  const deadlineError = new Error('DEADLINE_EXCEEDED')
  let nextId = fromId
  let scanned = 0

  async function readBeforeDeadline(read) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw deadlineError
    let timer
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (performance.now() >= deadline) throw deadlineError
          return read()
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(deadlineError), remaining)
        })
      ])
      if (performance.now() >= deadline) throw deadlineError
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    return await scan()
  } catch (error) {
    if (
      error?.code === 'RATE_LIMIT_RETRY_AFTER_EXCEEDS_BUDGET' ||
      error?.code === 'RATE_LIMIT_BACKOFF_EXCEEDS_BUDGET'
    ) {
      log(
        `NOT_VERIFIED: ${error.code}; scanned=${scanned}. Retry later with a fresh full verification.`
      )
      return false
    }
    if (error !== deadlineError) {
      if (error?.code === 'CREATE2_MISMATCH' || error?.message?.startsWith('CHAIN_ID_MISMATCH:'))
        log(
          'Verification failed. Check the selected chain, contract configuration and RPC response before retrying.'
        )
      else
        log(
          `Verification failed; scanned=${scanned}. Resolve the RPC or configuration error, then run a fresh full verification.`
        )
      throw error
    }
    log(
      `NOT_VERIFIED: DEADLINE_EXCEEDED after ${deadlineMs} ms; scanned=${scanned}; resume with --from-id ${nextId}.`
    )
    return false
  }

  async function scan() {
    const network = await readBeforeDeadline(() => provider.getNetwork())
    if (network.chainId !== BigInt(config.chainId)) {
      throw new Error(
        `CHAIN_ID_MISMATCH: selected ${config.key} expects ${config.chainId}, RPC returned ${network.chainId}.`
      )
    }

    const blockTag = await readBeforeDeadline(() => provider.getBlockNumber())
    const factory = new Contract(config.factory, factoryAbi, provider)
    const xen = new Contract(config.xenCrypto, xenAbi, provider)
    const vmuCount = await readBeforeDeadline(() => factory.vmuCount(wallet, { blockTag }))
    log(`chain=${config.key} chainId=${config.chainId}`)
    log(`wallet=${wallet}`)
    log(`vmuCount=${vmuCount}`)

    if (vmuCount === 0n) {
      log('NOT_VERIFIED: wallet has no VMUs.')
      return false
    }

    // Pin both the inventory and boundary probes to one block, so concurrent
    // minting cannot turn a newly deployed next proxy into a false mismatch.
    const derive = (id) =>
      computeProxyAddress({
        factory: config.factory,
        vmuTemplate: config.vmuTemplate,
        wallet,
        vmuId: id
      })
    const boundaries = [
      ...new Set([1n, vmuCount, ...(vmuCount < UINT256_MAX ? [vmuCount + 1n] : [])])
    ]
    const codes = await readBeforeDeadline(() =>
      Promise.all(
        boundaries.map(async (id) => ({
          id,
          code: await provider.getCode(derive(id), blockTag)
        }))
      )
    )
    const expectedCode = minimalProxyRuntimeCode(config.vmuTemplate).toLowerCase()
    for (const { id, code } of codes) {
      const matches = id <= vmuCount ? code.toLowerCase() === expectedCode : code === '0x'
      if (!matches) {
        const mismatch = new Error(
          `CREATE2_MISMATCH: deployed proxy boundary does not match VMU id ${id} at block ${blockTag}.`
        )
        mismatch.code = 'CREATE2_MISMATCH'
        throw mismatch
      }
    }

    if (fromId > vmuCount) {
      log(
        'NOT_VERIFIED: --from-id is beyond the wallet VMU count; boundary probes passed, but no active witness was checked.'
      )
      return false
    }

    const scanEnd = fromId + BigInt(scanLimit) - 1n
    const lastId = scanEnd < vmuCount ? scanEnd : vmuCount
    while (nextId <= lastId) {
      const batchFrom = nextId
      const toId =
        batchFrom + BigInt(SCAN_BATCH_SIZE - 1) > lastId
          ? lastId
          : batchFrom + BigInt(SCAN_BATCH_SIZE - 1)
      log(`batch=${batchFrom}-${toId}`)

      const records = await readBeforeDeadline(() =>
        Promise.all(
          Array.from({ length: Number(toId - batchFrom + 1n) }, async (_, offset) => {
            const id = batchFrom + BigInt(offset)
            const proxy = computeProxyAddress({
              factory: config.factory,
              vmuTemplate: config.vmuTemplate,
              wallet,
              vmuId: id
            })
            const mint = await xen.userMints(proxy, { blockTag })
            return { id, mint, proxy }
          })
        )
      )
      for (const { id, mint, proxy } of records) {
        if (performance.now() >= deadline) throw deadlineError
        const active = mint.user !== ZERO_ADDRESS && mint.rank > 0n && mint.term > 0n
        log(
          `id=${id} proxy=${proxy} user=${mint.user} rank=${mint.rank} term=${mint.term} maturityTs=${mint.maturityTs} ${
            active ? 'ACTIVE' : 'empty/claimed/inactive'
          }`
        )
        if (active && getAddress(mint.user) === getAddress(proxy)) {
          if (performance.now() >= deadline) throw deadlineError
          log('CREATE2 derivation VERIFIED against on-chain data.')
          return true
        }
        scanned += 1
        nextId = id + 1n
      }
      nextId = toId + 1n
    }

    if (lastId < vmuCount) {
      log(
        `NOT_VERIFIED: SCAN_LIMIT reached after ${scanned} VMUs; continue with --from-id ${nextId}.`
      )
      return false
    }
    log(
      `NOT_VERIFIED: no active VMU records a derived proxy as its on-chain minter in ids ${fromId}..${lastId}.`
    )
    return false
  }
}

async function main() {
  const { config, rpcUrl, wallet, ...scanOptions } = parseVerificationArgs(process.argv.slice(2))
  const agent = new URL(rpcUrl).protocol === 'https:' ? new HttpsAgent() : new HttpAgent()
  const transport = new AbortController()
  const transportDeadline = performance.now() + scanOptions.deadlineMs
  let provider
  try {
    const request = new FetchRequest(rpcUrl)
    request.timeout = scanOptions.deadlineMs
    const getUrl = FetchRequest.createGetUrlFunc({ agent })
    request.getUrlFunc = async (connection, signal) => {
      for (let attempt = 0; ; attempt += 1) {
        transport.signal.throwIfAborted()
        const response = await getUrl(connection, signal)
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          throw new Error('RPC_REDIRECT_REQUIRES_EXPLICIT_URL: pass the final RPC URL with --rpc.')
        }
        if (response.statusCode !== 429) return response
        if (attempt === 2) {
          console.log(
            'RPC_RATE_LIMITED: HTTP 429 persisted after 3 attempts. Wait before retrying a fresh full verification.'
          )
          return response
        }
        const delay = rateLimitDelay(
          response.headers['retry-after'],
          attempt,
          transportDeadline - performance.now()
        )
        await sleep(delay, undefined, { signal: transport.signal })
      }
    }
    // Retries stay in the owned transport; the scan's total deadline still wins.
    request.retryFunc = async () => false
    provider = new JsonRpcProvider(request)
    const verified = await verifyCreate2({ config, provider, wallet, ...scanOptions })
    if (!verified) process.exitCode = 2
  } finally {
    transport.abort()
    try {
      provider?.destroy()
    } finally {
      // JsonRpcProvider.destroy() does not close its in-flight HTTP sockets.
      agent.destroy()
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(diagnosticError(error))
    process.exitCode = error?.code === 'CREATE2_MISMATCH' ? 3 : 1
  })
}
