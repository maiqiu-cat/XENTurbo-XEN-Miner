import type { ChainKey } from './chains'

export interface ChainContracts {
  /** XENFactoryUpgradeable proxy - the miner entry contract users call. */
  factory: string
  /** Official XENCrypto token contract. */
  xenCrypto: string
  /** VMU implementation (logic) contract used as the CREATE2 minimal-proxy target. */
  vmuTemplate: string
  /** Multicall3 canonical deployment on this chain. */
  multicall3: string
}

// Addresses ported from the original deployed.config.ts (production values).
// ETH mainnet and Polygon mainnet share the same factory / VMU template.
export const CONTRACTS: Record<ChainKey, ChainContracts> = {
  eth: {
    factory: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
    xenCrypto: '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8',
    vmuTemplate: '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11'
  },
  polygon: {
    factory: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2',
    xenCrypto: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e',
    vmuTemplate: '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11'
  }
}
