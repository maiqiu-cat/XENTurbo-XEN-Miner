export interface ScriptChainConfig {
  key: 'eth' | 'polygon'
  chainId: number
  rpcUrls: readonly string[]
  factory: string
  xenCrypto: string
  vmuTemplate: string
}
export const CHAIN_CONFIG: Readonly<Record<'eth' | 'polygon', ScriptChainConfig>>
export function getChainConfig(key: string): ScriptChainConfig
