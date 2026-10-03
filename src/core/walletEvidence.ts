import { CHAINS, type ChainKey } from '@/config/chains'
import { CONTRACTS } from '@/config/contracts'
import { captureInjectedContext, getInjectedProvider, type InjectedProvider } from './eip1193'
import { assertReadActive, withReadDeadline } from './readDeadline'

export interface WalletTransaction {
  hash: string
  from: string
  to: string
  input: string
  nonce: number
}

export interface WalletReceipt {
  transactionHash: string
  blockHash: string
  blockNumber: number
  status: 0 | 1
}

export interface WalletSettlement {
  chain: ChainKey
  wallet: string
  txHash: string
  nonce: number | null
  phase: 'confirmed' | 'reverted' | 'replaced'
  receipt?: WalletReceipt
}

const settlements = new WeakSet<WalletSettlement>()

export function walletQuantity(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value))
    throw new Error(`Invalid wallet ${label}`)
  const result = Number(BigInt(value))
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid wallet ${label}`)
  return result
}

export async function walletReadSession(chain: ChainKey, signal?: AbortSignal) {
  const provider = getInjectedProvider()
  if (!provider)
    throw new Error('WALLET_EVIDENCE_UNAVAILABLE: Connect the wallet to reconcile transactions.')
  const context = captureInjectedContext(provider)
  const request = async (method: string, params: unknown[] = []) => {
    context.assertStable()
    const result = await withReadDeadline(
      () => provider.request({ method, params }),
      `Wallet ${method}`,
      { signal }
    )
    context.assertStable()
    return result
  }
  const validate = async () => {
    assertReadActive(signal)
    const chainId = walletQuantity(await request('eth_chainId'), 'chain id')
    if (provider !== getInjectedProvider() || chainId !== CHAINS[chain].chainId) {
      throw new Error(
        'WALLET_CONTEXT_CHANGED: Switch the wallet back to this operation network before reconciliation.'
      )
    }
  }
  try {
    await validate()
  } catch (error) {
    context.dispose()
    throw error
  }
  return { request, validate, provider, observed: context.observed, dispose: context.dispose }
}

export function validatedWalletTransaction(
  value: unknown,
  chain: ChainKey,
  wallet: string,
  hash: string
): WalletTransaction | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Invalid wallet transaction')
  const tx = value as Record<string, unknown>
  const input = tx.input ?? tx.data
  if (
    typeof tx.hash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(tx.hash) ||
    tx.hash.toLowerCase() !== hash.toLowerCase() ||
    typeof tx.from !== 'string' ||
    tx.from.toLowerCase() !== wallet.toLowerCase() ||
    typeof tx.to !== 'string' ||
    tx.to.toLowerCase() !== CONTRACTS[chain].factory.toLowerCase() ||
    typeof input !== 'string' ||
    input.length > 65_536 ||
    !/^0x[0-9a-f]*$/i.test(input)
  )
    throw new Error('Wallet transaction identity does not match the miner operation')
  if (
    tx.chainId !== undefined &&
    walletQuantity(tx.chainId, 'transaction chain id') !== CHAINS[chain].chainId
  )
    throw new Error('Wallet transaction is on the wrong chain')
  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    input,
    nonce: walletQuantity(tx.nonce, 'nonce')
  }
}

export function isWalletSettlement(
  evidence: WalletSettlement | undefined,
  record: { chain: ChainKey; wallet: string; txHash: string; nonce?: number | null }
): evidence is WalletSettlement {
  return (
    !!evidence &&
    settlements.has(evidence) &&
    evidence.chain === record.chain &&
    evidence.wallet.toLowerCase() === record.wallet.toLowerCase() &&
    evidence.txHash.toLowerCase() === record.txHash.toLowerCase() &&
    (evidence.phase !== 'replaced' || evidence.nonce === record.nonce)
  )
}

/** Public RPC observations cannot mint terminal evidence or promote remote hashes. */
export async function readWalletEvidence(
  chain: ChainKey,
  wallet: string,
  hash: string,
  options: { nonce?: number | null; nonceAuthoritative?: boolean; signal?: AbortSignal } = {}
): Promise<{ transaction: WalletTransaction | null; settlement: WalletSettlement | undefined }> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash))
    throw new Error('Invalid transaction hash for wallet reconciliation')
  const session = await walletReadSession(chain, options.signal)
  try {
    const [rawTx, rawReceipt] = await Promise.all([
      session.request('eth_getTransactionByHash', [hash]),
      session.request('eth_getTransactionReceipt', [hash])
    ])
    const transaction = validatedWalletTransaction(rawTx, chain, wallet, hash)
    let settlement: WalletSettlement | undefined
    if (rawReceipt !== null) {
      if (!rawReceipt || typeof rawReceipt !== 'object') throw new Error('Invalid wallet receipt')
      const receipt = rawReceipt as Record<string, unknown>
      if (
        typeof receipt.transactionHash !== 'string' ||
        receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        typeof receipt.from !== 'string' ||
        receipt.from.toLowerCase() !== wallet.toLowerCase() ||
        typeof receipt.to !== 'string' ||
        receipt.to.toLowerCase() !== CONTRACTS[chain].factory.toLowerCase() ||
        typeof receipt.blockHash !== 'string' ||
        !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)
      )
        throw new Error('Wallet receipt identity does not match the miner operation')
      const status = walletQuantity(receipt.status, 'receipt status')
      if (status !== 0 && status !== 1) throw new Error('Invalid wallet receipt status')
      const blockNumber = walletQuantity(receipt.blockNumber, 'receipt block number')
      settlement = {
        chain,
        wallet,
        txHash: hash,
        nonce: transaction?.nonce ?? options.nonce ?? null,
        phase: status === 1 ? 'confirmed' : 'reverted',
        receipt: { transactionHash: hash, blockHash: receipt.blockHash, blockNumber, status }
      }
    } else if (
      !transaction &&
      session.observed &&
      options.nonceAuthoritative &&
      Number.isSafeInteger(options.nonce) &&
      options.nonce! >= 0
    ) {
      const latest = walletQuantity(
        await session.request('eth_getTransactionCount', [wallet, 'latest']),
        'latest nonce'
      )
      if (latest > options.nonce!)
        settlement = { chain, wallet, txHash: hash, nonce: options.nonce!, phase: 'replaced' }
    }
    await session.validate()
    assertReadActive(options.signal)
    if (settlement) settlements.add(settlement)
    return { transaction, settlement }
  } finally {
    session.dispose()
  }
}

/** Derive the final send budget only from the wallet, never a configured read RPC. */
export async function validatedWalletGas(
  provider: InjectedProvider,
  chainId: number,
  tx: Record<string, string>,
  strictData?: string
): Promise<bigint> {
  const context = captureInjectedContext(provider)
  try {
    const request = (method: string, params: unknown[]) =>
      withReadDeadline(() => provider.request({ method, params }), `Wallet ${method}`)
    const strictTx = strictData ? { ...tx, data: strictData } : tx
    const [estimate, strictEstimate, latest] = await Promise.all([
      request('eth_estimateGas', [tx]),
      strictData ? request('eth_estimateGas', [strictTx]) : Promise.resolve('0x0'),
      request('eth_getBlockByNumber', ['latest', false])
    ])
    context.assertStable()
    const actualGas = BigInt(walletQuantity(estimate, 'gas estimate'))
    const strictGas = BigInt(walletQuantity(strictEstimate, 'strict gas estimate'))
    const gas = ((actualGas > strictGas ? actualGas : strictGas) * 13n) / 10n
    const block = latest as { gasLimit?: unknown } | null
    const limit = (BigInt(walletQuantity(block?.gasLimit, 'block gas limit')) * 9n) / 10n
    if (gas <= 0n || gas > limit)
      throw new Error('Wallet gas estimate exceeds the safe block limit; use a smaller batch.')
    if (strictData) {
      const strictResult = await request('eth_call', [
        { ...strictTx, gas: `0x${gas.toString(16)}` },
        'latest'
      ])
      if (typeof strictResult !== 'string' || !/^0x[0-9a-f]*$/i.test(strictResult))
        throw new Error('Invalid wallet strict gas simulation result')
    }
    const result = await request('eth_call', [{ ...tx, gas: `0x${gas.toString(16)}` }, 'latest'])
    if (typeof result !== 'string' || !/^0x[0-9a-f]*$/i.test(result))
      throw new Error('Invalid wallet gas simulation result')
    if (
      provider !== getInjectedProvider() ||
      walletQuantity(await request('eth_chainId', []), 'chain id') !== chainId
    )
      throw new Error('Wallet network changed during gas validation')
    const accounts = await request('eth_accounts', [])
    context.assertStable()
    if (
      provider !== getInjectedProvider() ||
      !Array.isArray(accounts) ||
      typeof accounts[0] !== 'string' ||
      accounts[0].toLowerCase() !== tx.from.toLowerCase()
    )
      throw new Error('Wallet account changed during gas validation')
    return gas
  } finally {
    context.dispose()
  }
}
