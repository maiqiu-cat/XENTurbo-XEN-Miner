import {
  concat,
  getAddress,
  getCreate2Address,
  keccak256,
  solidityPackedKeccak256
} from 'ethers'

// EIP-1167 minimal proxy init code, split around the implementation address.
// Matches the bytecode assembled on-chain in XENFactoryUpgradeableV2:
//   bytes20(0x3D602d80600A3D3981F3363d3d373d3D3D363d73) ++ bytes20(_logic)
//   ++ bytes15(0x5af43d82803e903d91602b57fd5bf3)
const PROXY_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73'
const PROXY_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3'

/** Build the EIP-1167 minimal proxy init code for a given implementation (VMU template). */
export function minimalProxyInitCode(implementation: string): string {
  return concat([PROXY_PREFIX, getAddress(implementation), PROXY_SUFFIX])
}

/** keccak256 of the minimal proxy init code - cached per implementation. */
const initCodeHashCache = new Map<string, string>()

export function proxyInitCodeHash(implementation: string): string {
  const impl = getAddress(implementation)
  const cached = initCodeHashCache.get(impl)
  if (cached) return cached
  const hash = keccak256(minimalProxyInitCode(impl))
  initCodeHashCache.set(impl, hash)
  return hash
}

/**
 * The salt used by the factory: keccak256(abi.encodePacked(msg.sender, i)).
 * `i` is the 1-based VMU index (vmuCount + 1 ... at creation time).
 */
export function proxySalt(wallet: string, vmuId: number | bigint): string {
  return solidityPackedKeccak256(['address', 'uint256'], [getAddress(wallet), vmuId])
}

/**
 * Deterministically compute the VMU proxy address for a (wallet, id) pair.
 * Mirrors the on-chain CREATE2 computation exactly, so it needs no RPC.
 */
export function computeProxyAddress(params: {
  factory: string
  vmuTemplate: string
  wallet: string
  vmuId: number | bigint
}): string {
  const { factory, vmuTemplate, wallet, vmuId } = params
  const salt = proxySalt(wallet, vmuId)
  const initHash = proxyInitCodeHash(vmuTemplate)
  return getCreate2Address(getAddress(factory), salt, initHash)
}

/** Compute proxy addresses for a contiguous id range [fromId, toId]. */
export function computeProxyAddressRange(params: {
  factory: string
  vmuTemplate: string
  wallet: string
  fromId: number
  toId: number
}): { id: number; address: string }[] {
  const { factory, vmuTemplate, wallet, fromId, toId } = params
  const initHash = proxyInitCodeHash(vmuTemplate)
  const factoryAddr = getAddress(factory)
  const walletAddr = getAddress(wallet)
  const out: { id: number; address: string }[] = []
  for (let id = fromId; id <= toId; id++) {
    const salt = solidityPackedKeccak256(['address', 'uint256'], [walletAddr, id])
    out.push({ id, address: getCreate2Address(factoryAddr, salt, initHash) })
  }
  return out
}
