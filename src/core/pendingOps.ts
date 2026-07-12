import { Interface } from 'ethers'
import type { ChainKey } from '@/config/chains'
import { CHAINS } from '@/config/chains'
import { CONTRACTS } from '@/config/contracts'
import { ensureHealthyReadProvider, getReadProvider } from './rpc'
import { attachTxHash, pendingLocks, releaseLock, releaseLocksByTxHash } from './localLock'
import type { OpType } from './txManager'

const LEGACY_KEY = 'sm.pendingOps'
const EVENT_KEY_PREFIX = 'sm.pendingOps.event.'
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const TERMINAL_RECORD_LIMIT = 50
const DISCOVERY_THROTTLE_MS = 60_000
const lastDiscoveryAt = new Map<string, number>()

export type PendingPhase =
  'awaiting-wallet' | 'broadcast' | 'confirmed' | 'reverted' | 'replaced' | 'dropped'

const UNRESOLVED_PHASES = new Set<PendingPhase>(['awaiting-wallet', 'broadcast'])

export interface PendingOpRecord {
  id: string
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  term: number
  txHash: string
  /** Transaction nonce. Null means an older record that must be reconciled conservatively. */
  nonce: number | null
  phase: PendingPhase
  submittedAt: number
  updatedAt: number
}

export interface PendingOpView extends PendingOpRecord {
  label: string
  detail: string
  explorerUrl: string
  status: 'pending' | 'confirmed' | 'reverted' | 'replaced' | 'dropped' | 'unknown'
}

interface PendingStorageEvent {
  recordId: string
  updatedAt: number
  record: PendingOpRecord | null
}

interface StoredPendingEvent {
  key: string
  value: PendingStorageEvent
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

function normalizeRecord(r: unknown): PendingOpRecord | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const valid =
    typeof o.id === 'string' &&
    typeof o.chain === 'string' &&
    typeof o.wallet === 'string' &&
    typeof o.op === 'string' &&
    typeof o.txHash === 'string' &&
    typeof o.submittedAt === 'number' &&
    Array.isArray(o.ids)
  if (!valid) return null

  const phase = isPendingPhase(o.phase)
    ? o.phase
    : (o.txHash as string).length > 0
      ? 'broadcast'
      : 'awaiting-wallet'
  const nonce =
    typeof o.nonce === 'number' && Number.isSafeInteger(o.nonce) && o.nonce >= 0 ? o.nonce : null

  return {
    ...(o as unknown as PendingOpRecord),
    nonce,
    phase,
    updatedAt:
      typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)
        ? o.updatedAt
        : (o.submittedAt as number)
  }
}

function isPendingPhase(value: unknown): value is PendingPhase {
  return (
    value === 'awaiting-wallet' ||
    value === 'broadcast' ||
    value === 'confirmed' ||
    value === 'reverted' ||
    value === 'replaced' ||
    value === 'dropped'
  )
}

function nextUpdatedAt(previous = 0): number {
  return Math.max(Date.now(), previous + 0.001)
}

function eventKey(): string {
  return `${EVENT_KEY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function appendStorageEvent(value: PendingStorageEvent): void {
  try {
    localStorage.setItem(eventKey(), JSON.stringify(value))
  } catch {
    throw new Error(
      'PENDING_STORAGE_WRITE_FAILED: Browser storage is full or unavailable. Clear old site data before sending another transaction.'
    )
  }
}

function appendRecord(record: PendingOpRecord): void {
  appendStorageEvent({ recordId: record.id, updatedAt: record.updatedAt, record })
}

function appendTombstone(record: PendingOpRecord): void {
  appendStorageEvent({
    recordId: record.id,
    updatedAt: nextUpdatedAt(record.updatedAt),
    record: null
  })
}

function storageEventPriority(event: StoredPendingEvent): number {
  const record = event.value.record
  if (!record) return 100
  if (!isUnresolvedPending(record)) return 80
  if (record.phase === 'broadcast' || record.txHash) return 40
  return 20
}

function newerStorageEvent(
  current: StoredPendingEvent | undefined,
  candidate: StoredPendingEvent
): StoredPendingEvent {
  if (!current) return candidate
  if (candidate.value.updatedAt !== current.value.updatedAt) {
    return candidate.value.updatedAt > current.value.updatedAt ? candidate : current
  }
  const priorityDifference = storageEventPriority(candidate) - storageEventPriority(current)
  if (priorityDifference !== 0) return priorityDifference > 0 ? candidate : current
  return candidate.key > current.key ? candidate : current
}

function readStoredEvents(): StoredPendingEvent[] {
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index)
  ).filter((key): key is string => Boolean(key?.startsWith(EVENT_KEY_PREFIX)))
  const events: StoredPendingEvent[] = []
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as Partial<PendingStorageEvent>
      const record = parsed.record === null ? null : normalizeRecord(parsed.record)
      if (
        typeof parsed.recordId !== 'string' ||
        typeof parsed.updatedAt !== 'number' ||
        !Number.isFinite(parsed.updatedAt) ||
        (parsed.record !== null && (!record || record.id !== parsed.recordId))
      ) {
        localStorage.removeItem(key)
        continue
      }
      events.push({
        key,
        value: { recordId: parsed.recordId, updatedAt: parsed.updatedAt, record }
      })
    } catch {
      localStorage.removeItem(key)
    }
  }
  return events
}

function migrateLegacyRecords(): void {
  const raw = localStorage.getItem(LEGACY_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        const record = normalizeRecord(value)
        if (record) appendRecord(record)
      }
    }
    localStorage.removeItem(LEGACY_KEY)
  } catch (error) {
    if (error instanceof Error && error.message.includes('PENDING_STORAGE_WRITE_FAILED')) {
      throw error
    }
    localStorage.removeItem(LEGACY_KEY)
  }
}

function readAll(): PendingOpRecord[] {
  try {
    migrateLegacyRecords()
    const events = readStoredEvents()
    const winners = new Map<string, StoredPendingEvent>()
    for (const event of events) {
      winners.set(event.value.recordId, newerStorageEvent(winners.get(event.value.recordId), event))
    }

    const records = [...winners.values()].flatMap((event) =>
      event.value.record ? [event.value.record] : []
    )
    const pruned = prunePendingRecords(records)
    const retainedIds = new Set(pruned.map((record) => record.id))

    // Compact only keys observed in this snapshot. A concurrent writer uses a
    // unique key and therefore cannot be deleted or overwritten here.
    for (const event of events) {
      const winner = winners.get(event.value.recordId)
      if (winner?.key !== event.key || !retainedIds.has(event.value.recordId)) {
        localStorage.removeItem(event.key)
      }
    }
    return pruned
  } catch {
    return []
  }
}

function sameRecordRevision(a: PendingOpRecord, b: PendingOpRecord): boolean {
  return (
    a.id === b.id &&
    a.chain === b.chain &&
    a.wallet.toLowerCase() === b.wallet.toLowerCase() &&
    a.op === b.op &&
    a.ids.length === b.ids.length &&
    a.ids.every((id, index) => id === b.ids[index]) &&
    a.count === b.count &&
    a.term === b.term &&
    a.updatedAt === b.updatedAt &&
    a.submittedAt === b.submittedAt &&
    a.phase === b.phase &&
    a.txHash === b.txHash &&
    a.nonce === b.nonce
  )
}

export function prunePendingRecords(list: PendingOpRecord[], now = Date.now()): PendingOpRecord[] {
  const unresolved = list.filter(isUnresolvedPending)
  const terminal = list
    .filter(
      (record) => !isUnresolvedPending(record) && now - record.updatedAt <= TERMINAL_RETENTION_MS
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, TERMINAL_RECORD_LIMIT)
  return [...unresolved, ...terminal]
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

function statusForPhase(phase: PendingPhase): PendingOpView['status'] {
  if (phase === 'awaiting-wallet' || phase === 'broadcast') return 'pending'
  return phase
}

function toView(
  r: PendingOpRecord,
  status: PendingOpView['status'] = statusForPhase(r.phase)
): PendingOpView {
  const explorerUrl = r.txHash
    ? `${CHAINS[r.chain].blockExplorerUrl}/tx/${r.txHash}`
    : `${CHAINS[r.chain].blockExplorerUrl}/address/${r.wallet}`
  return {
    ...r,
    label: OP_LABELS[r.op] ?? r.op,
    detail: detailFor(r),
    explorerUrl,
    status
  }
}

export function recordPendingOp(params: {
  /** Stable client operation id, normally the local VMU lock batch id. */
  id?: string
  chain: ChainKey
  wallet: string
  op: OpType
  ids: number[]
  count: number
  term: number
  txHash: string
  nonce?: number | null
  phase?: PendingPhase
  /** First-seen / broadcast time. Preserved across rediscovery so "pending for" stays accurate. */
  submittedAt?: number
}): PendingOpRecord {
  const all = readAll()
  const normalizedHash = params.txHash.toLowerCase()
  const directMatch = all.find(
    (record) =>
      (params.id && record.id === params.id) ||
      (normalizedHash.length > 0 && record.txHash.toLowerCase() === normalizedHash)
  )
  const awaitingNonceMatch =
    normalizedHash.length > 0 && params.nonce != null
      ? all.find(
          (record) =>
            record.chain === params.chain &&
            record.wallet.toLowerCase() === params.wallet.toLowerCase() &&
            record.nonce === params.nonce &&
            record.phase === 'awaiting-wallet' &&
            record.txHash.length === 0
        )
      : undefined
  const existing = directMatch ?? awaitingNonceMatch
  const submittedAt = Math.min(
    existing?.submittedAt ?? Number.POSITIVE_INFINITY,
    params.submittedAt ?? Date.now()
  )
  const requestedPhase =
    params.phase ?? existing?.phase ?? (params.txHash ? 'broadcast' : 'awaiting-wallet')
  const phase =
    existing &&
    !isUnresolvedPending(existing) &&
    isUnresolvedPending({ phase: requestedPhase }) &&
    !(existing.phase === 'dropped' && normalizedHash.length > 0)
      ? existing.phase
      : requestedPhase
  const rec: PendingOpRecord = {
    id: existing?.id ?? params.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chain: params.chain,
    wallet: params.wallet,
    op: params.op,
    ids: params.ids.length ? params.ids : (existing?.ids ?? []),
    count: params.count || existing?.count || 0,
    term: params.term || existing?.term || 0,
    txHash: params.txHash,
    nonce: params.nonce ?? existing?.nonce ?? null,
    phase,
    // Earliest known time ≈ when the tx entered the mempool from our perspective.
    // Pending txs have no on-chain block timestamp until mined.
    submittedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
    updatedAt: nextUpdatedAt(existing?.updatedAt)
  }
  for (const duplicate of all) {
    if (
      duplicate.id !== rec.id &&
      normalizedHash.length > 0 &&
      duplicate.txHash.toLowerCase() === normalizedHash
    ) {
      appendTombstone(duplicate)
    }
  }
  appendRecord(rec)
  if (rec.txHash && isUnresolvedPending(rec)) {
    attachTxHash(rec.id, rec.txHash)
  } else if (!isUnresolvedPending(rec)) {
    releaseLock(rec.id)
    if (rec.txHash) releaseLocksByTxHash(rec.txHash)
  }
  return rec
}

export function isUnresolvedPending(record: Pick<PendingOpRecord, 'phase'>): boolean {
  return UNRESOLVED_PHASES.has(record.phase)
}

export function canMarkPendingOpDropped(
  record: Pick<PendingOpView, 'id' | 'phase' | 'status'>
): boolean {
  return (
    record.id !== 'unknown-pending' && record.status === 'unknown' && isUnresolvedPending(record)
  )
}

function transitionPendingOp(
  identifier: string,
  phase: PendingPhase,
  canTransition: (record: PendingOpRecord) => boolean = () => true
): PendingOpRecord | null {
  const normalized = identifier.toLowerCase()
  const record = readAll().find(
    (record) => record.id === identifier || record.txHash.toLowerCase() === normalized
  )
  if (!record || !canTransition(record)) return null
  const updated: PendingOpRecord = {
    ...record,
    phase,
    updatedAt: nextUpdatedAt(record.updatedAt)
  }
  appendRecord(updated)
  if (!isUnresolvedPending(updated)) {
    releaseLock(updated.id)
    if (updated.txHash) releaseLocksByTxHash(updated.txHash)
  }
  return updated
}

export function markPendingOpDropped(identifier: string): PendingOpRecord | null {
  return transitionPendingOp(identifier, 'dropped', isUnresolvedPending)
}

export function removePendingOpRecord(identifier: string): boolean {
  const normalized = identifier.toLowerCase()
  const matches = readAll().filter(
    (record) => record.id === identifier || record.txHash.toLowerCase() === normalized
  )
  for (const record of matches) {
    appendTombstone(record)
    releaseLock(record.id)
    if (record.txHash) releaseLocksByTxHash(record.txHash)
  }
  return matches.length > 0
}

export function removePendingOp(txHash: string): void {
  const normalized = txHash.toLowerCase()
  const matches = readAll().filter((record) => record.txHash.toLowerCase() === normalized)
  for (const record of matches) appendTombstone(record)
  if (matches.length > 0) releaseLocksByTxHash(txHash)
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
 * Manually track a pending tx by hash (from MetaMask / Etherscan).
 * Decodes calldata and accepts a manually pasted explorer First/Last Seen time.
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
  const provider = await ensureHealthyReadProvider(chain)
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
    nonce: tx.nonce ?? null,
    phase: 'broadcast',
    submittedAt: pastedMs ?? undefined
  })
  return toView(rec, 'pending')
}

export function listPendingOps(chain: ChainKey, wallet: string): PendingOpRecord[] {
  return readAll().filter(
    (r) => r.chain === chain && r.wallet.toLowerCase() === wallet.toLowerCase()
  )
}

export function countUnresolvedPendingOps(chain: ChainKey, wallet: string): number {
  return listPendingOps(chain, wallet).filter(isUnresolvedPending).length
}

export interface PendingObservation {
  receipt: { status?: number | null } | null
  transactionFound: boolean
  observedNonce?: number | null
  latestNonce: number
  pendingNonce: number
}

/** Resolve only from affirmative chain evidence; absence alone stays blocking. */
export function reconcilePendingOp(
  record: PendingOpRecord,
  observation: PendingObservation,
  now = Date.now()
): PendingOpRecord {
  if (!isUnresolvedPending(record)) return record

  const observedNonce = normalizeNonce(observation.observedNonce)
  const nonce = record.nonce ?? observedNonce
  let phase = record.phase

  if (observation.receipt) {
    phase = observation.receipt.status === 0 ? 'reverted' : 'confirmed'
  } else if (!observation.transactionFound && nonce !== null && observation.latestNonce > nonce) {
    // A confirmed account nonce beyond this nonce proves another transaction
    // consumed it. A lower pending nonce alone is not enough evidence.
    phase = 'replaced'
  } else if (record.txHash && phase === 'awaiting-wallet') {
    phase = 'broadcast'
  }

  if (phase === record.phase && nonce === record.nonce) return record
  return { ...record, nonce, phase, updatedAt: now }
}

function normalizeNonce(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    const parsed = Number.parseInt(value, 16)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
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
  else if (read.providerConfigs?.[0]?.provider?.send)
    providers.push(read.providerConfigs[0].provider)

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
        // pending block may return hashes only
        let full = tx
        if (typeof tx === 'string') {
          full = await rpc.send('eth_getTransactionByHash', [tx]).catch(() => null)
        }
        if (!full || typeof full !== 'object') continue
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
          txHash: hash,
          nonce: normalizeNonce(full.nonce),
          phase: 'broadcast'
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
      nonce: null,
      phase: 'broadcast',
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
): Promise<{ views: PendingOpView[]; pendingNonceGap: number; unresolvedCount: number }> {
  const provider = await ensureHealthyReadProvider(chain)
  const injected = getInjected()
  const factory = CONTRACTS[chain].factory.toLowerCase()

  const [latest, pendingNonce] = await Promise.all([
    provider.getTransactionCount(wallet, 'latest'),
    provider.getTransactionCount(wallet, 'pending')
  ])
  const pendingNonceGap = Math.max(0, pendingNonce - latest)

  hydrateFromLocks(chain, wallet)

  const beforeDiscovery = listPendingOps(chain, wallet).filter(isUnresolvedPending)
  const coveredNonces = new Set(
    beforeDiscovery.flatMap((record) => (record.nonce === null ? [] : [record.nonce]))
  )
  let unexplainedGap = false
  for (let nonce = latest; nonce < pendingNonce; nonce += 1) {
    if (!coveredNonces.has(nonce)) {
      unexplainedGap = true
      break
    }
  }
  const discoveryKey = `${chain}:${wallet.toLowerCase()}`
  const now = Date.now()
  const discoveryDue = now - (lastDiscoveryAt.get(discoveryKey) ?? 0) >= DISCOVERY_THROTTLE_MS

  // Pending blocks can be huge and many RPCs do not support them. Only scan
  // when the account nonce gap cannot be explained by known local records.
  if (pendingNonceGap > 0 && unexplainedGap && discoveryDue) {
    lastDiscoveryAt.set(discoveryKey, now)
    await discoverPendingFactoryTxs(chain, wallet, injected)
  }

  const local = listPendingOps(chain, wallet).filter(isUnresolvedPending)
  const outcomes = await Promise.all(
    local.map(async (record) => {
      let receipt: { status?: number | null } | null = null
      if (record.txHash) {
        try {
          receipt = await provider.getTransactionReceipt(record.txHash)
        } catch {
          // An RPC failure is not resolution evidence.
        }
      }

      const tx = record.txHash ? await fetchTxByHash(record.txHash, provider, injected) : null
      let enriched = record
      if (tx?.input && tx.to?.toLowerCase() === factory) {
        const decoded = decodeFactoryCalldata(tx.input)
        if (decoded) {
          enriched = {
            ...record,
            op: decoded.op,
            ids: decoded.ids.length ? decoded.ids : record.ids,
            count: decoded.count || record.count,
            term: decoded.term || record.term
          }
        }
      }

      const reconciled = reconcilePendingOp(enriched, {
        receipt,
        transactionFound: tx !== null,
        observedNonce: tx?.nonce,
        latestNonce: latest,
        pendingNonce
      })
      const uncertain =
        isUnresolvedPending(reconciled) &&
        tx === null &&
        (reconciled.nonce === null || pendingNonce <= reconciled.nonce)

      return {
        source: record,
        record: reconciled,
        status: uncertain ? ('unknown' as const) : statusForPhase(reconciled.phase)
      }
    })
  )

  const accepted = new Map<string, { record: PendingOpRecord; status: PendingOpView['status'] }>()
  if (outcomes.length) {
    const candidates = new Map(outcomes.map((outcome) => [outcome.source.id, outcome]))
    const current = readAll()
    for (const record of current) {
      const candidate = candidates.get(record.id)
      if (!candidate || !sameRecordRevision(record, candidate.source)) continue
      accepted.set(record.id, { record: candidate.record, status: candidate.status })
      if (!sameRecordRevision(record, candidate.record)) appendRecord(candidate.record)
    }
  }

  const persisted = listPendingOps(chain, wallet)
  const persistedById = new Map(persisted.map((record) => [record.id, record]))
  for (const [id, observation] of accepted) {
    const record = persistedById.get(id)
    if (!record || !sameRecordRevision(record, observation.record) || isUnresolvedPending(record))
      continue
    releaseLock(record.id)
    if (record.txHash) releaseLocksByTxHash(record.txHash)
  }

  const unresolved = persisted.filter(isUnresolvedPending)
  const views = unresolved.map((record) => {
    const observation = accepted.get(record.id)
    const status =
      observation && sameRecordRevision(record, observation.record)
        ? observation.status
        : statusForPhase(record.phase)
    return toView(record, status)
  })
  const unresolvedCount = unresolved.length

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
      nonce: null,
      phase: 'broadcast',
      submittedAt: Date.now(),
      updatedAt: Date.now(),
      label: 'Pending transaction',
      detail: `${pendingNonceGap} in-flight nonce(s) — open MetaMask → Activity for type / hash`,
      explorerUrl: `${CHAINS[chain].blockExplorerUrl}/address/${wallet}`,
      status: 'pending'
    })
  }

  views.sort((a, b) => b.submittedAt - a.submittedAt)
  return { views, pendingNonceGap, unresolvedCount }
}
