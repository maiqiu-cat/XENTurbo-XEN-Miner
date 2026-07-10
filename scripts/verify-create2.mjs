// Verifies the local CREATE2 derivation against real on-chain state.
//
// Strategy: pick a wallet that has minted, read factory.vmuCount(wallet), then
// for id in [1..min(vmuCount, N)] compute the proxy address locally and read
// XENCrypto.userMints(proxy). If the derivation is correct, `user` on the mint
// record equals the proxy address itself (each VMU proxy is its own minter),
// and rank/term are non-zero for active VMUs.
//
// Usage:
//   node scripts/verify-create2.mjs [wallet] [rpcUrl]

import {
  JsonRpcProvider,
  Contract,
  concat,
  getAddress,
  getCreate2Address,
  keccak256,
  solidityPackedKeccak256
} from 'ethers'

const FACTORY = '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
const XEN = '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8'
const VMU_TEMPLATE = '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'

const PROXY_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73'
const PROXY_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3'

const wallet = getAddress(process.argv[2] || '0x50d30cdae2ec9384eb890e0906e54f709cc02c16')
const rpcUrl = process.argv[3] || 'https://ethereum-rpc.publicnode.com'

function computeProxyAddress(id) {
  const initHash = keccak256(concat([PROXY_PREFIX, getAddress(VMU_TEMPLATE), PROXY_SUFFIX]))
  const salt = solidityPackedKeccak256(['address', 'uint256'], [wallet, id])
  return getCreate2Address(getAddress(FACTORY), salt, initHash)
}

const factoryAbi = ['function vmuCount(address) view returns (uint256)']
const xenAbi = [
  'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
]

async function main() {
  const provider = new JsonRpcProvider(rpcUrl)
  const factory = new Contract(FACTORY, factoryAbi, provider)
  const xen = new Contract(XEN, xenAbi, provider)

  const vmuCount = Number(await factory.vmuCount(wallet))
  console.log(`wallet=${wallet}`)
  console.log(`vmuCount=${vmuCount}`)
  console.log(`initCodeHash=${keccak256(concat([PROXY_PREFIX, getAddress(VMU_TEMPLATE), PROXY_SUFFIX]))}`)

  if (vmuCount === 0) {
    console.log('NOT_VERIFIED: wallet has no VMUs; pass a wallet that has minted as the first arg.')
    process.exitCode = 2
    return
  }

  const n = Math.min(vmuCount, 5)
  let ok = 0
  for (let id = 1; id <= n; id++) {
    const proxy = computeProxyAddress(id)
    const m = await xen.userMints(proxy)
    const hasRecord = m.user !== '0x0000000000000000000000000000000000000000'
    const active = hasRecord && m.rank > 0n && m.term > 0n
    console.log(
      `id=${id} proxy=${proxy} user=${m.user} rank=${m.rank} term=${m.term} maturityTs=${m.maturityTs} ${
        active ? 'ACTIVE' : 'empty/claimed/inactive'
      }`
    )
    // The strongest correctness signal: the recorded minter equals the proxy.
    if (active && getAddress(m.user) === getAddress(proxy)) ok++
  }
  console.log(`\n${ok}/${n} active VMUs confirm the derived proxy is the on-chain minter.`)
  if (ok > 0) {
    console.log('CREATE2 derivation VERIFIED against on-chain data.')
  } else {
    console.log(
      'NOT_VERIFIED: no sampled active VMU records the derived proxy as its on-chain minter. Try another wallet.'
    )
    process.exitCode = 2
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
