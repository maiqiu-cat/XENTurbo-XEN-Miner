import type { ContractRunner, TransactionRequest } from 'ethers'

export interface VerificationChainConfig {
  readonly key: 'eth' | 'polygon'
  readonly chainId: number
  readonly rpcUrls: readonly string[]
  readonly factory: string
  readonly xenCrypto: string
  readonly vmuTemplate: string
}

export interface VerificationScanOptions {
  fromId?: bigint
  scanLimit?: number
  deadlineMs?: number
}

export interface VerificationArgs extends Required<VerificationScanOptions> {
  config: VerificationChainConfig
  rpcUrl: string
  wallet: string
}

export interface VerificationProvider extends ContractRunner {
  getNetwork(): Promise<{ chainId: bigint }>
  getBlockNumber(): Promise<number>
  getCode(address: string, blockTag?: number): Promise<string>
  call(transaction: TransactionRequest): Promise<string>
}

export interface VerificationOptions extends VerificationScanOptions {
  config: VerificationChainConfig
  // Borrowed: only the CLI destroys the provider it creates.
  provider: VerificationProvider
  wallet: string
  log?: (message: string) => void
}

export function parseVerificationArgs(
  argv: readonly string[],
  env?: Record<string, string | undefined>
): VerificationArgs

export function verifyCreate2(options: VerificationOptions): Promise<boolean>
export function rateLimitDelay(
  retryAfter: string | undefined,
  attempt: number,
  remainingMs: number,
  now?: number
): number
