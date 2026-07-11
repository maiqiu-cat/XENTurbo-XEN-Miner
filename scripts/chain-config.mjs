// Script-only chain metadata. Keep this independent from src/config/chains.ts so
// release gates stay executable in Node without importing browser-side TypeScript.
export const CHAIN_CONFIG = Object.freeze({
  eth: Object.freeze({
    key: 'eth',
    chainId: 1,
    rpcUrls: Object.freeze([
      'https://ethereum.publicnode.com',
      'https://ethereum-rpc.publicnode.com',
      'https://cloudflare-eth.com'
    ]),
    factory: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
    xenCrypto: '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8',
    vmuTemplate: '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'
  }),
  polygon: Object.freeze({
    key: 'polygon',
    chainId: 137,
    rpcUrls: Object.freeze([
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.publicnode.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic'
    ]),
    factory: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
    xenCrypto: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e',
    vmuTemplate: '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'
  })
})

export function getChainConfig(key) {
  const config = CHAIN_CONFIG[key]
  if (!config) throw new Error(`Unsupported chain ${JSON.stringify(key)}; use eth or polygon.`)
  return config
}
