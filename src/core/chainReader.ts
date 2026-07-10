import { Contract, Interface } from 'ethers'
import { CONTRACTS } from '@/config/contracts'
import type { ChainKey } from '@/config/chains'
import { XENFactoryABI } from '@/abis/XENFactoryABI'
import { XENCryptoABI } from '@/abis/XENCryptoABI'
import { Multicall3ABI } from '@/abis/Multicall3ABI'
import {
  computeProxyAddress,
  computeProxyAddressRange,
  minimalProxyRuntimeCode
} from './create2'
import { getReadProvider, withRetry } from './rpc'
import type { Vmu, VmuStatus } from './types'

const xenIface = new Interface(XENCryptoABI as unknown as any[])

// Multicall batch size: number of userMints calls per aggregate3 request.
const BATCH_SIZE = 400
const CODE_BATCH_SIZE = 32

export type ProxyDeploymentStatus = 'DEPLOYED' | 'MISSING' | 'READ_ERROR'

export interface ReadProgress {
  loaded: number
  total: number
}

/** Read factory.vmuCount(wallet) - the on-chain source of truth for VMU count. */
export async function readVmuCount(chain: ChainKey, wallet: string): Promise<number> {
  const provider = getReadProvider(chain)
  const factory = new Contract(CONTRACTS[chain].factory, XENFactoryABI as unknown as any[], provider)
  const count = await withRetry(() => factory.vmuCount(wallet))
  return Number(count)
}

/** Read the current XEN global rank (for reward estimation). */
export async function readGlobalRank(chain: ChainKey): Promise<number> {
  const provider = getReadProvider(chain)
  const xen = new Contract(CONTRACTS[chain].xenCrypto, XENCryptoABI as unknown as any[], provider)
  const rank = await withRetry(() => xen.globalRank())
  return Number(rank)
}

/** Read the per-VMU service fee (wei) charged by the factory. */
export async function readFee(chain: ChainKey): Promise<bigint> {
  const provider = getReadProvider(chain)
  const factory = new Contract(CONTRACTS[chain].factory, XENFactoryABI as unknown as any[], provider)
  return (await withRetry(() => factory.FEE())) as bigint
}

function classify(rank: number, maturityMs: number): VmuStatus {
  if (rank === 0) return 'EMPTY'
  // Match on-chain: claimable only when block.timestamp > maturityTs.
  // Use +1s buffer so UI does not show Claimable one second early.
  if (maturityMs + 1000 > Date.now()) return 'MINTING'
  return 'CLAIMABLE'
}

function emptyVmu(id: number, address: string, readOk: boolean): Vmu {
  return {
    id,
    address,
    status: readOk ? 'EMPTY' : 'READ_ERROR',
    rank: 0,
    term: 0,
    maturityTs: 0,
    amplifier: 0,
    eaaRate: 0,
    readOk
  }
}

/**
 * Decode a single userMints return. Distinguishes a genuine empty mint
 * (rank=0, successful decode) from a failed/empty RPC response.
 */
function decodeUserMint(
  id: number,
  address: string,
  res: { success: boolean; returnData: string } | undefined
): Vmu {
  if (!res?.success || !res.returnData || res.returnData === '0x') {
    return emptyVmu(id, address, false)
  }
  try {
    const decoded = xenIface.decodeFunctionResult('userMints', res.returnData)
    const term = Number(decoded.term)
    const maturityTs = Number(decoded.maturityTs) * 1000
    const rank = Number(decoded.rank)
    const amplifier = Number(decoded.amplifier)
    const eaaRate = Number(decoded.eaaRate)
    return {
      id,
      address,
      status: classify(rank, maturityTs),
      rank,
      term,
      maturityTs,
      amplifier,
      eaaRate,
      readOk: true
    }
  } catch {
    return emptyVmu(id, address, false)
  }
}

/** Re-read selected VMU ids in bounded multicall batches. */
async function readVmuIds(chain: ChainKey, wallet: string, ids: number[]): Promise<Vmu[]> {
  if (!ids.length) return []
  const provider = getReadProvider(chain)
  const { factory, vmuTemplate, xenCrypto, multicall3 } = CONTRACTS[chain]
  const multicall = new Contract(multicall3, Multicall3ABI as unknown as any[], provider)
  const proxies = ids.map((id) => ({
    id,
    address: computeProxyAddress({ factory, vmuTemplate, wallet, vmuId: id })
  }))
  const vmus: Vmu[] = []
  for (let start = 0; start < proxies.length; start += BATCH_SIZE) {
    const slice = proxies.slice(start, start + BATCH_SIZE)
    const calls = slice.map((proxy) => ({
      target: xenCrypto,
      allowFailure: true,
      callData: xenIface.encodeFunctionData('userMints', [proxy.address])
    }))
    try {
      const results = (await withRetry(() => multicall.aggregate3(calls))) as {
        success: boolean
        returnData: string
      }[]
      slice.forEach((proxy, index) => {
        vmus.push(decodeUserMint(proxy.id, proxy.address, results[index]))
      })
    } catch {
      slice.forEach((proxy) => vmus.push(emptyVmu(proxy.id, proxy.address, false)))
    }
  }
  return vmus
}

/**
 * Read the on-chain state of every VMU owned by `wallet`.
 * Proxy addresses are computed locally (CREATE2); userMints is batched via Multicall3.
 * Failed multicall entries are marked READ_ERROR (never silently treated as EMPTY)
 * and retried once in a small batch.
 */
export async function readWalletVmus(
  chain: ChainKey,
  wallet: string,
  opts: { vmuCount?: number; onProgress?: (p: ReadProgress) => void } = {}
): Promise<Vmu[]> {
  const { factory, vmuTemplate, xenCrypto, multicall3 } = CONTRACTS[chain]

  const total = opts.vmuCount ?? (await readVmuCount(chain, wallet))
  if (total <= 0) {
    opts.onProgress?.({ loaded: 0, total: 0 })
    return []
  }

  const multicall = new Contract(
    multicall3,
    Multicall3ABI as unknown as any[],
    getReadProvider(chain)
  )
  const proxies = computeProxyAddressRange({
    factory,
    vmuTemplate,
    wallet,
    fromId: 1,
    toId: total
  })

  const vmus: Vmu[] = []
  for (let start = 0; start < proxies.length; start += BATCH_SIZE) {
    const slice = proxies.slice(start, start + BATCH_SIZE)
    const calls = slice.map((p) => ({
      target: xenCrypto,
      allowFailure: true,
      callData: xenIface.encodeFunctionData('userMints', [p.address])
    }))

    const results = (await withRetry(() => multicall.aggregate3(calls))) as {
      success: boolean
      returnData: string
    }[]

    slice.forEach((p, i) => {
      vmus.push(decodeUserMint(p.id, p.address, results[i]))
    })

    opts.onProgress?.({ loaded: Math.min(start + BATCH_SIZE, proxies.length), total })
  }

  // Retry failed reads once (small batch) so transient RPC blips don't stick.
  const failedIds = vmus.filter((v) => !v.readOk).map((v) => v.id)
  if (failedIds.length) {
    try {
      const retried = await readVmuIds(chain, wallet, failedIds)
      const byId = new Map(retried.map((v) => [v.id, v]))
      for (let i = 0; i < vmus.length; i++) {
        const fix = byId.get(vmus[i].id)
        if (fix) vmus[i] = fix
      }
    } catch {
      // Keep READ_ERROR markers; UI will surface the count.
    }
  }

  return vmus
}

/**
 * Re-read specific VMU ids and return a map id -> status.
 * Used both before a send and after a receipt; retry failed entries once so a
 * transient multicall miss does not immediately make an outcome uncertain.
 */
export async function readVmuStatuses(
  chain: ChainKey,
  wallet: string,
  ids: number[]
): Promise<Map<number, VmuStatus>> {
  const list = await readVmuIds(chain, wallet, ids)
  const failedIds = list.filter((vmu) => !vmu.readOk).map((vmu) => vmu.id)
  if (failedIds.length) {
    try {
      const retried = await readVmuIds(chain, wallet, failedIds)
      const byId = new Map(retried.map((vmu) => [vmu.id, vmu]))
      for (let index = 0; index < list.length; index++) {
        list[index] = byId.get(list[index].id) ?? list[index]
      }
    } catch {
      // Preserve the first READ_ERROR markers for the caller to classify.
    }
  }
  return new Map(list.map((v) => [v.id, v.status]))
}

/**
 * Verify that each derived VMU address contains the exact EIP-1167 runtime
 * bytecode expected for this chain's VMU implementation.
 */
export async function readVmuProxyDeployments(
  chain: ChainKey,
  wallet: string,
  ids: number[]
): Promise<Map<number, ProxyDeploymentStatus>> {
  const results = new Map<number, ProxyDeploymentStatus>()
  if (!ids.length) return results

  const provider = getReadProvider(chain)
  const { factory, vmuTemplate } = CONTRACTS[chain]
  const expectedCode = minimalProxyRuntimeCode(vmuTemplate).toLowerCase()
  const proxies = ids.map((id) => ({
    id,
    address: computeProxyAddress({ factory, vmuTemplate, wallet, vmuId: id })
  }))

  for (let start = 0; start < proxies.length; start += CODE_BATCH_SIZE) {
    const slice = proxies.slice(start, start + CODE_BATCH_SIZE)
    const codes = await Promise.all(
      slice.map(async ({ address }) => {
        try {
          return (await withRetry(() => provider.getCode(address))).toLowerCase()
        } catch {
          return null
        }
      })
    )

    slice.forEach(({ id }, index) => {
      const code = codes[index]
      results.set(id, code === null ? 'READ_ERROR' : code === expectedCode ? 'DEPLOYED' : 'MISSING')
    })
  }

  return results
}
