import { Interface } from 'ethers'
import type { ChainKey } from '@/config/chains'
import { CHAINS } from '@/config/chains'
import { CONTRACTS } from '@/config/contracts'
import { getReadProvider } from './rpc'
import { pendingLocks } from './localLock'
import type { OpType } from './txManager'

const KEY = 'sm.pendingOps'
const TTL_MS = 60 * 60 * 1000 // 1 hour

export interface PendingOpRecord {
  id: string
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  term: number
  txHash: string
  submittedAt: number
}

export interface PendingOpView extends PendingOpRecord {
  label: string
  detail: string
  explorerUrl: string
  /** still in mempool / not yet mined */
  status: 'pending' | 'mined' | 'reverted' | 'unknown'
}

const OP_LABELS: Record<OpType, string> = {
  GENERAL_MINT: 'General Mint',
  CREATE_EMPTY_SLOT: 'Create Empty Slots',
  MINT_EMPTY_SLOT: 'Empty Slots Mint',
  CLAIM: 'Claim',
  CLAIM_REUSE: 'Claim & Re-Mint'
}

const factoryIface = new Interface([
  'function bulkClaimRank(uint256 term, uint256 count)',
  'function createVMUs(uint256 count)',
  'function reuseVMUs(uint256[] ids, uint256 term)',
  'function bulkClaimMintReward(uint256[] ids)',
  'function bulkClaimMintRewardAndClaimRank(uint256[] ids, uint256 term)'
])

function isValid(r: unknown): r is PendingOpRecord {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.chain === 'string' &&
    typeof o.wallet === 'string' &&
    typeof o.op === 'string' &&
    typeof o.txHash === 'string' &&
    typeof o.submittedAt === 'number' &&
    Array.isArray(o.ids)
  )
}

function readAll(): PendingOpRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as unknown[]) : []
    if (!Array.isArray(list)) return []
    const now = Date.now()
    const valid = list.filter(isValid).filter((r) => now - r.submittedAt < TTL_MS)
    if (valid.length !== list.length) writeAll(valid)
    return valid
  } catch {
    return []
  }
}

function writeAll(list: PendingOpRecord[]): void {
  localStorage.setItem(KEY, JSON.stringify(list))
}

function detailFor(r: Pick<PendingOpRecord, 'op' | 'ids' | 'count' | 'term'>): string {
  switch (r.op) {
    case 'GENERAL_MINT':
      return `${r.count} VMUs · ${r.term}d term`
    case 'CREATE_EMPTY_SLOT':
      return `${r.count} empty slots`
    case 'MINT_EMPTY_SLOT':
      return `ids ${formatIds(r.ids)} · ${r.term}d`
    case 'CLAIM':
      return `ids ${formatIds(r.ids)}`
    case 'CLAIM_REUSE':
      return `ids ${formatIds(r.ids)} · re-mint ${r.term}d`
    default:
      return ''
  }
}

function formatIds(ids: number[]): string {
  if (!ids.length) return '—'
  if (ids.length <= 6) return ids.join(', ')
  return `${ids.slice(0, 5).join(', ')}… (+${ids.length - 5})`
}

function toView(r: PendingOpRecord, status: PendingOpView['status'] = 'pending'): PendingOpView {
  return {
    ...r,
    label: OP_LABELS[r.op] ?? r.op,
    detail: detailFor(r),
    explorerUrl: `${CHAINS[r.chain].blockExplorerUrl}/tx/${r.txHash}`,
    status
  }
}

export function recordPendingOp(params: {
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  term: number
  txHash: string
  /** First-seen / broadcast time. Preserved across rediscovery so "pending for" stays accurate. */
  submittedAt?: number
}): PendingOpRecord {
  const existing = readAll().find((r) => r.txHash.toLowerCase() === params.txHash.toLowerCase())
  const submittedAt = Math.min(
    existing?.submittedAt ?? Number.POSITIVE_INFINITY,
    params.submittedAt ?? Date.now()
  )
  const rec: PendingOpRecord = {
    id: existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chain: params.chain,
    wallet: params.wallet,
    op: params.op,
    ids: params.ids.length ? params.ids : existing?.ids ?? [],
    count: params.count || existing?.count || 0,
    term: params.term || existing?.term || 0,
    txHash: params.txHash,
    // Earliest known time ≈ when the tx entered the mempool from our perspective.
    // Pending txs have no on-chain block timestamp until mined.
    submittedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now()
  }
  const list = readAll().filter((r) => r.txHash.toLowerCase() !== params.txHash.toLowerCase())
  list.push(rec)
  writeAll(list)
  return rec
}

export function removePendingOp(txHash: string): void {
  writeAll(readAll().filter((r) => r.txHash.toLowerCase() !== txHash.toLowerCase()))
}

const EXPLORER_DATE_RE =
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}-\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(AM|PM)\s*UTC/i

/** Parse a single Etherscan-style date, e.g. "Jul-09-2026 05:53:45 AM UTC". */
export function parseExplorerDateString(text: string): number | null {
  const m = text.match(EXPLORER_DATE_RE)
  if (!m) return null
  const normalized = m[0].replace(/-/g, ' ').replace(/\s+UTC$/i, ' UTC')
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Parse Etherscan/Polygonscan "First Seen" / "Time Last Seen" from HTML or pasted text.
 * Pending txs have no block timestamp; explorers index when they observed the tx in mempool.
 * Example: "Time Last Seen: … (Jul-09-2026 05:53:45 AM UTC)"
 */
export function parseExplorerSeenTime(html: string): number | null {
  // Prefer First Seen; fall back to Last Seen (what the UI often labels).
  const patterns = [
    /First\s*Seen[\s\S]{0,200}?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}-\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)\s*UTC)/i,
    /Time\s*Last\s*Seen[\s\S]{0,200}?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}-\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)\s*UTC)/i,
    EXPLORER_DATE_RE
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (!m) continue
    const dateStr = (m[1] && EXPLORER_DATE_RE.test(m[1]) ? m[1] : m[0]).match(EXPLORER_DATE_RE)?.[0]
    if (!dateStr) continue
    const ms = parseExplorerDateString(dateStr)
    if (ms != null) return ms
  }
  return null
}

/**
 * Explorer HTML scrape disabled — MITM/proxy TLS failures caused console 500 spam.
 * Use pasted "Time Last Seen" text on Track instead.
 */
export async function fetchExplorerPendingTime(
  _chain: ChainKey,
  _txHash: string
): Promise<number | null> {
  return null
}

/**
 * Manually track a pending tx by hash (from MetaMask / Etherscan).
 * Decodes calldata, pulls explorer First/Last Seen time when available.
 */
export async function trackPendingTxHash(
  chain: ChainKey,
  wallet: string,
  txHash: string,
  /** Optional paste of Etherscan "Time Last Seen / First Seen" text when proxy scrape fails. */
  seenText?: string
): Promise<PendingOpView> {
  const hash = txHash.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('Invalid transaction hash')
  }
  const provider = getReadProvider(chain)
  const injected = getInjected()
  const factory = CONTRACTS[chain].factory.toLowerCase()

  const receipt = await provider.getTransactionReceipt(hash).catch(() => null)
  if (receipt) {
    removePendingOp(hash)
    throw new Error('This transaction is already mined (no longer pending)')
  }

  const tx = await fetchTxByHash(hash, provider, injected)
  if (!tx) throw new Error('Transaction not found on RPC. Check the hash / network.')
  if (tx.from && tx.from.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Transaction is not from the connected wallet')
  }
  if (tx.to && tx.to.toLowerCase() !== factory) {
    throw new Error('Transaction is not a miner factory call')
  }

  const decoded = tx.input ? decodeFactoryCalldata(tx.input) : null
  if (!decoded) throw new Error('Could not decode factory call (unsupported method)')

  const pastedMs = seenText ? parseExplorerSeenTime(seenText) : null
  if (seenText?.trim() && pastedMs == null) {
    throw new Error(
      'Could not parse Seen time. Paste e.g. Jul-09-2026 05:53:45 AM UTC from Etherscan.'
    )
  }
  const rec = recordPendingOp({
    chain,
    wallet,
    op: decoded.op,
    ids: decoded.ids,
    count: decoded.count,
    term: decoded.term,
    txHash: hash,
    submittedAt: pastedMs ?? undefined
  })
  return toView(rec, 'pending')
}

export function listPendingOps(chain: ChainKey, wallet: string): PendingOpRecord[] {
  return readAll().filter(
    (r) => r.chain === chain && r.wallet.toLowerCase() === wallet.toLowerCase()
  )
}

export function decodeFactoryCalldata(data: string): {
  op: OpType
  ids: number[]
  count: number
  term: number
} | null {
  try {
    const parsed = factoryIface.parseTransaction({ data })
    if (!parsed) return null
    switch (parsed.name) {
      case 'bulkClaimRank':
        return {
          op: 'GENERAL_MINT',
          ids: [],
          term: Number(parsed.args.term ?? parsed.args[0]),
          count: Number(parsed.args.count ?? parsed.args[1])
        }
      case 'createVMUs':
        return {
          op: 'CREATE_EMPTY_SLOT',
          ids: [],
          term: 0,
          count: Number(parsed.args.count ?? parsed.args[0])
        }
      case 'reuseVMUs':
        return {
          op: 'MINT_EMPTY_SLOT',
          ids: (parsed.args.ids ?? parsed.args[0]).map((x: bigint) => Number(x)),
          term: Number(parsed.args.term ?? parsed.args[1]),
          count: 0
        }
      case 'bulkClaimMintReward':
        return {
          op: 'CLAIM',
          ids: (parsed.args.ids ?? parsed.args[0]).map((x: bigint) => Number(x)),
          term: 0,
          count: 0
        }
      case 'bulkClaimMintRewardAndClaimRank':
        return {
          op: 'CLAIM_REUSE',
          ids: (parsed.args.ids ?? parsed.args[0]).map((x: bigint) => Number(x)),
          term: Number(parsed.args.term ?? parsed.args[1]),
          count: 0
        }
      default:
        return null
    }
  } catch {
    return null
  }
}

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<any> }

function getInjected(): Eip1193 | undefined {
  if (typeof window === 'undefined') return undefined
  const eth = (window as any).ethereum
  if (!eth?.request) return undefined
  if (Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p: any) => p.isMetaMask)
    return (mm ?? eth.providers[0]) as Eip1193
  }
  return eth as Eip1193
}

async function fetchTxByHash(
  hash: string,
  readProvider: ReturnType<typeof getReadProvider>,
  injected?: Eip1193
): Promise<{ hash: string; from?: string; to?: string; input?: string; nonce?: number } | null> {
  // 1) Our RPC
  try {
    const tx = await readProvider.getTransaction(hash)
    if (tx) {
      return {
        hash,
        from: tx.from,
        to: tx.to ?? undefined,
        input: tx.data,
        nonce: tx.nonce
      }
    }
  } catch {
    /* continue */
  }
  // 2) MetaMask's provider — often still has the user's pending tx
  if (injected) {
    try {
      const tx = await injected.request({
        method: 'eth_getTransactionByHash',
        params: [hash]
      })
      if (tx) {
        return {
          hash: tx.hash || hash,
          from: tx.from,
          to: tx.to,
          input: tx.input || tx.data,
          nonce: typeof tx.nonce === 'string' ? parseInt(tx.nonce, 16) : tx.nonce
        }
      }
    } catch {
      /* continue */
    }
  }
  return null
}

async function discoverPendingFactoryTxs(
  chain: ChainKey,
  wallet: string,
  injected?: Eip1193
): Promise<PendingOpRecord[]> {
  const factory = CONTRACTS[chain].factory.toLowerCase()
  const found: PendingOpRecord[] = []
  const providers: Array<{ send: (m: string, p: unknown[]) => Promise<any> }> = []

  const read = getReadProvider(chain) as any
  if (typeof read.send === 'function') providers.push(read)
  else if (read.providerConfigs?.[0]?.provider?.send) providers.push(read.providerConfigs[0].provider)

  if (injected) {
    providers.push({
      send: (method, params) => injected.request({ method, params })
    })
  }

  for (const rpc of providers) {
    try {
      const blk = await rpc.send('eth_getBlockByNumber', ['pending', true])
      const txs: any[] = blk?.transactions ?? []
      for (const tx of txs) {
        if (!tx || typeof tx !== 'object') continue
        // pending block may return hashes only
        let full = tx
        if (typeof tx === 'string') {
          full = await rpc.send('eth_getTransactionByHash', [tx]).catch(() => null)
        }
        if (!full) continue
        const from = (full.from || '').toLowerCase()
        const to = (full.to || '').toLowerCase()
        const hash = (full.hash || '') as string
        const input = (full.input || full.data || '') as string
        if (from !== wallet.toLowerCase() || to !== factory || !hash || !input) continue
        const decoded = decodeFactoryCalldata(input)
        if (!decoded) continue
        const rec = recordPendingOp({
          chain,
          wallet,
          op: decoded.op,
          ids: decoded.ids,
          count: decoded.count,
          term: decoded.term,
          txHash: hash
        })
        found.push(rec)
      }
      if (found.length) break
    } catch {
      /* try next provider */
    }
  }
  return found
}

/**
 * Hydrate pending-ops store from VMU locks that already have a txHash
 * (covers older sessions that predate sm.pendingOps).
 */
function hydrateFromLocks(chain: ChainKey, wallet: string): void {
  const locks = pendingLocks(chain, wallet)
  for (const lock of locks) {
    const existing = listPendingOps(chain, wallet).find(
      (r) => r.txHash.toLowerCase() === lock.txHash.toLowerCase()
    )
    if (existing) continue
    // Prefer lock metadata; if missing, still store the hash so we can decode calldata next.
    recordPendingOp({
      chain,
      wallet,
      op: (lock.op as OpType) || 'GENERAL_MINT',
      ids: lock.ids,
      count: lock.count ?? 0,
      term: lock.term ?? 0,
      txHash: lock.txHash,
      submittedAt: lock.lockedAt
    })
  }
}

/**
 * Refresh pending-op list against the chain and wallet provider.
 */
export async function refreshPendingOps(
  chain: ChainKey,
  wallet: string
): Promise<{ views: PendingOpView[]; pendingNonceGap: number }> {
  const provider = getReadProvider(chain)
  const injected = getInjected()
  const factory = CONTRACTS[chain].factory.toLowerCase()

  const [latest, pendingNonce] = await Promise.all([
    provider.getTransactionCount(wallet, 'latest'),
    provider.getTransactionCount(wallet, 'pending')
  ])
  const pendingNonceGap = Math.max(0, pendingNonce - latest)

  hydrateFromLocks(chain, wallet)

  // Discover unknown pending factory txs (MetaMask + public RPC).
  if (pendingNonceGap > 0) {
    await discoverPendingFactoryTxs(chain, wallet, injected)
  }

  const local = listPendingOps(chain, wallet)
  const views: PendingOpView[] = []

  await Promise.all(
    local.map(async (r) => {
      try {
        const receipt = await provider.getTransactionReceipt(r.txHash)
        if (receipt) {
          removePendingOp(r.txHash)
          return
        }
      } catch {
        /* keep */
      }

      // Enrich / correct op details from the actual calldata when possible.
      let enriched = r
      const tx = await fetchTxByHash(r.txHash, provider, injected)
      if (tx?.input && tx.to?.toLowerCase() === factory) {
        const decoded = decodeFactoryCalldata(tx.input)
        if (decoded) {
          enriched = {
            ...r,
            op: decoded.op,
            ids: decoded.ids.length ? decoded.ids : r.ids,
            count: decoded.count || r.count,
            term: decoded.term || r.term
          }
        }
      }
      // Do NOT scrape explorer on every poll — proxy/TLS failures spam 500s in the console.
      // Explorer time is set once via Track (paste Seen text or one-shot scrape).
      if (enriched !== r) {
        const all = readAll().map((x) =>
          x.txHash.toLowerCase() === r.txHash.toLowerCase() ? { ...x, ...enriched } : x
        )
        writeAll(all)
      }

      // If nonce gap is 0 and we still have no receipt, tx was likely dropped —
      // keep briefly as unknown, or drop if older than soft window.
      const status: PendingOpView['status'] =
        pendingNonceGap > 0 ? 'pending' : Date.now() - r.submittedAt > 120_000 ? 'unknown' : 'pending'

      if (status === 'unknown' && pendingNonceGap === 0) {
        // Drop stale entries once chain has no in-flight nonces.
        removePendingOp(r.txHash)
        return
      }

      views.push(toView(enriched, status))
    })
  )

  // If we still have a nonce gap but zero decoded rows, surface a synthetic row
  // so the panel is never an empty "details unavailable" dead-end.
  if (pendingNonceGap > 0 && views.length === 0) {
    views.push({
      id: 'unknown-pending',
      chain,
      wallet,
      op: 'GENERAL_MINT',
      ids: [],
      count: 0,
      term: 0,
      txHash: '',
      submittedAt: Date.now(),
      label: 'Pending transaction',
      detail: `${pendingNonceGap} in-flight nonce(s) — open MetaMask → Activity for type / hash`,
      explorerUrl: `${CHAINS[chain].blockExplorerUrl}/address/${wallet}`,
      status: 'pending'
    })
  }

  views.sort((a, b) => b.submittedAt - a.submittedAt)
  return { views, pendingNonceGap }
}
