// Verifies local CREATE2 proxy derivation against the selected chain's on-chain state.
//
// Usage:
//   node scripts/verify-create2.mjs --chain eth --wallet 0x... [--rpc https://...]
//   CREATE2_WITNESS_POLYGON=0x... node scripts/verify-create2.mjs --chain polygon

import { Contract, JsonRpcProvider, getAddress } from 'ethers'
import { computeProxyAddress } from '../src/core/create2.ts'
import { getChainConfig } from './chain-config.mjs'

const SCAN_BATCH_SIZE = 5
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const factoryAbi = ['function vmuCount(address) view returns (uint256)']
const xenAbi = [
  'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
]

export function parseVerificationArgs(argv, env = process.env) {
  let chain
  let rpcUrl
  let wallet

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--chain') chain = argv[++index]
    else if (value === '--wallet') wallet = argv[++index]
    else if (value === '--rpc') rpcUrl = argv[++index]
    else
      throw new Error(
        `Unknown argument ${JSON.stringify(value)}. Use --chain, --wallet, and --rpc.`
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

  return { config, rpcUrl: rpcUrl ?? config.rpcUrls[0], wallet: getAddress(witness) }
}

export async function verifyCreate2({ config, provider, wallet, log = console.log }) {
  const network = await provider.getNetwork()
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(
      `CHAIN_ID_MISMATCH: selected ${config.key} expects ${config.chainId}, RPC returned ${network.chainId}.`
    )
  }

  const factory = new Contract(config.factory, factoryAbi, provider)
  const xen = new Contract(config.xenCrypto, xenAbi, provider)
  const vmuCount = await factory.vmuCount(wallet)
  log(`chain=${config.key} chainId=${config.chainId}`)
  log(`wallet=${wallet}`)
  log(`vmuCount=${vmuCount}`)

  if (vmuCount === 0n) {
    log('NOT_VERIFIED: wallet has no VMUs.')
    return false
  }

  for (let fromId = 1n; fromId <= vmuCount; fromId += BigInt(SCAN_BATCH_SIZE)) {
    const toId =
      fromId + BigInt(SCAN_BATCH_SIZE - 1) > vmuCount
        ? vmuCount
        : fromId + BigInt(SCAN_BATCH_SIZE - 1)
    log(`batch=${fromId}-${toId}`)

    const records = await Promise.all(
      Array.from({ length: Number(toId - fromId + 1n) }, async (_, offset) => {
        const id = fromId + BigInt(offset)
        const proxy = computeProxyAddress({
          factory: config.factory,
          vmuTemplate: config.vmuTemplate,
          wallet,
          vmuId: id
        })
        const mint = await xen.userMints(proxy)
        return { id, mint, proxy }
      })
    )

    for (const { id, mint, proxy } of records) {
      const active = mint.user !== ZERO_ADDRESS && mint.rank > 0n && mint.term > 0n
      log(
        `id=${id} proxy=${proxy} user=${mint.user} rank=${mint.rank} term=${mint.term} maturityTs=${mint.maturityTs} ${
          active ? 'ACTIVE' : 'empty/claimed/inactive'
        }`
      )
      if (active && getAddress(mint.user) === getAddress(proxy)) {
        log('CREATE2 derivation VERIFIED against on-chain data.')
        return true
      }
    }
  }

  log('NOT_VERIFIED: no active VMU records a derived proxy as its on-chain minter.')
  return false
}

async function main() {
  const { config, rpcUrl, wallet } = parseVerificationArgs(process.argv.slice(2))
  const provider = new JsonRpcProvider(rpcUrl)
  try {
    const verified = await verifyCreate2({ config, provider, wallet })
    if (!verified) process.exitCode = 2
  } finally {
    provider.destroy()
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
