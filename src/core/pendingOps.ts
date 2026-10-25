import { Interface } from 'ethers'
import type { ChainKey } from '@/config/chains'
import { CHAINS } from '@/config/chains'
import { CONTRACTS } from '@/config/contracts'
import { ensureHealthyReadProvider, ensureRecentReadProvider, getReadProvider } from './rpc'
import {
  assertLockStorageReadable,
  attachTxHash,
  pendingLocks,
  releaseLock,
  releaseLocksByTxHash
} from './localLock'
import type { OpType } from './txManager'
import { mapWithConcurrency } from '@/utils/concurrency'
import { assertReadActive, withReadDeadline } from './readDeadline'
import {
  readWalletEvidence,
  walletReadSession,
  walletQuantity,
  isWalletSettlement,
  type WalletSettlement,
  type WalletReceipt
} from './walletEvidence'
import { verifyOperationOutcomeWithRetry, type OperationOutcome } from './postconditions'

const LEGACY_KEY = 'sm.pendingOps'
const EVENT_KEY_PREFIX = 'sm.pendingOps.event.'
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const TERMINAL_RECORD_LIMIT = 50
const DISCOVERY_THROTTLE_MS = 60_000
const RECONCILE_CONCURRENCY = 4
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
  origin?: 'local' | 'wallet-verified' | 'legacy-unknown'
  nonceAuthoritative?: boolean
  receipt?: WalletReceipt
  outcome?: OperationOutcome
  preVmuCount?: number
  beforeRanks?: Record<number, number>
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

// Retain a wallet-returned hash in this tab even if both durable copies fail.
// The prior awaiting-wallet event remains the reload-safe submission gate.
const unpersistedBroadcasts = new Map<string, PendingOpRecord>()
// Read failures cannot safely resolve an operation identity yet. Retry the original input.
const unreadBroadcasts = new Map<string, Parameters<typeof recordPendingOp>[0]>()

function broadcastKey(record: { chain: ChainKey; wallet: string; txHash: string }): string {
  return `${record.chain}:${record.wallet.toLowerCase()}:${record.txHash.toLowerCase()}`
}

function cacheBroadcast(
  record: Pick<
    PendingOpRecord,
    'id' | 'chain' | 'wallet' | 'txHash' | 'ids' | 'op' | 'count' | 'term' | 'submittedAt'
  >
): void {
  try {
    attachTxHash(record.id, record.txHash, {
      chain: record.chain,
      wallet: record.wallet,
      ids: record.ids,
      op: record.op,
      count: record.count,
      term: record.term,
      lockedAt: record.submittedAt
    })
  } catch {
    // Either durable copy may fail independently; retain the in-memory recovery input.
  }
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

export function normalizeRecord(r: unknown): PendingOpRecord | null {
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

  const oldPhase = isPendingPhase(o.phase)
    ? o.phase
    : (o.txHash as string).length > 0
      ? 'broadcast'
      : 'awaiting-wallet'
  const origin =
    o.origin === 'local' || o.origin === 'wallet-verified' ? o.origin : 'legacy-unknown'
  const phase =
    origin === 'legacy-unknown' && ['confirmed', 'reverted', 'replaced'].includes(oldPhase)
      ? o.txHash
        ? 'broadcast'
        : 'awaiting-wallet'
      : oldPhase
  const nonce =
    typeof o.nonce === 'number' && Number.isSafeInteger(o.nonce) && o.nonce >= 0 ? o.nonce : null

  return {
    ...(o as unknown as PendingOpRecord),
    nonce,
    phase,
    origin,
    nonceAuthoritative:
      o.nonceAuthoritative === true && (o.origin === 'local' || o.origin === 'wallet-verified'),
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
      'PENDING_STORAGE_WRITE_FAILED: Browser storage is full or unavailable. Do not clear site data or resend. Check wallet Activity and reconcile pending transactions first.'
    )
  }
}

function appendRecord(record: PendingOpRecord): void {
  appendStorageEvent({ recordId: record.id, updatedAt: record.updatedAt, record })
  if ((unpersistedBroadcasts.get(record.id)?.updatedAt ?? Infinity) <= record.updatedAt)
    unpersistedBroadcasts.delete(record.id)
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

export function parsePendingStorageEvent(raw: string): PendingStorageEvent {
  const parsed = JSON.parse(raw) as Partial<PendingStorageEvent> | null
  const record = parsed?.record === null ? null : normalizeRecord(parsed?.record)
  if (
    !parsed ||
    typeof parsed.recordId !== 'string' ||
    typeof parsed.updatedAt !== 'number' ||
    !Number.isFinite(parsed.updatedAt) ||
    (parsed.record !== null && (!record || record.id !== parsed.recordId))
  )
    throw new Error('Invalid pending transaction event')
  return { recordId: parsed.recordId, updatedAt: parsed.updatedAt, record }
}

function readStoredEvents(): StoredPendingEvent[] {
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index)
  ).filter((key): key is string => Boolean(key?.startsWith(EVENT_KEY_PREFIX)))
  const events: StoredPendingEvent[] = []
  for (const key of keys) {
    const raw = localStorage.getItem(key)
    if (raw === null) continue
    events.push({ key, value: parsePendingStorageEvent(raw) })
  }
  return events
}

function migrateLegacyRecords(): void {
  const raw = localStorage.getItem(LEGACY_KEY)
  if (raw === null) return
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('Invalid legacy pending transaction list')
  const records = parsed.map(normalizeRecord)
  if (records.some((record) => !record))
    throw new Error('Invalid legacy pending transaction record')
  for (const record of records) {
    if (record) appendRecord(record)
  }
  localStorage.removeItem(LEGACY_KEY)
}

function readAll(): PendingOpRecord[] {
  assertLockStorageReadable()
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
    const combined = new Map(records.map((record) => [record.id, record]))
    for (const record of unpersistedBroadcasts.values()) {
      const stored = winners.get(record.id)?.value
      if (!stored || stored.updatedAt < record.updatedAt) combined.set(record.id, record)
    }
    const pruned = prunePendingRecords([...combined.values()])
    const retainedIds = new Set(pruned.map((record) => record.id))

    // Compact only keys observed in this snapshot. A concurrent writer uses a
    // unique key and therefore cannot be deleted or overwritten here.
    for (const event of events) {
      const winner = winners.get(event.value.recordId)
      if (winner?.key !== event.key || !retainedIds.has(event.value.recordId)) {
        try {
          localStorage.removeItem(event.key)
        } catch {
          /* Retaining old events is safe. */
        }
      }
    }
    return pruned
  } catch (cause) {
    throw new Error(
      'PENDING_STORAGE_READ_FAILED: Local transaction records could not be read. Do not clear site data or resend. Check wallet Activity and restore storage access before rechecking.',
      { cause }
    )
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
    a.nonce === b.nonce &&
    a.origin === b.origin &&
    a.nonceAuthoritative === b.nonceAuthoritative &&
    a.preVmuCount === b.preVmuCount &&
    JSON.stringify(a.beforeRanks) === JSON.stringify(b.beforeRanks) &&
    JSON.stringify(a.receipt) === JSON.stringify(b.receipt) &&
    JSON.stringify(a.outcome) === JSON.stringify(b.outcome)
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

function releaseRecordLocks(record: PendingOpRecord): void {
  releaseLock(record.id, record)
  if (record.txHash)
    releaseLocksByTxHash(record.txHash, { chain: record.chain, wallet: record.wallet })
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
  origin?: PendingOpRecord['origin']
  nonceAuthoritative?: boolean
  settlement?: WalletSettlement
  preVmuCount?: number
  beforeRanks?: Record<number, number>
  outcome?: OperationOutcome
}): PendingOpRecord {
  if (params.phase === 'confirmed' || params.phase === 'reverted' || params.phase === 'replaced') {
    if (
      !isWalletSettlement(params.settlement, params) ||
      params.settlement.phase !== params.phase
    ) {
      throw new Error(
        'WALLET_EVIDENCE_REQUIRED: Unverified RPC observations cannot settle transactions.'
      )
    }
  }
  let all: PendingOpRecord[]
  try {
    all = readAll()
  } catch (error) {
    if (
      /^0x[0-9a-f]{64}$/i.test(params.txHash) &&
      isUnresolvedPending({ phase: params.phase ?? 'broadcast' })
    ) {
      const key = broadcastKey(params)
      unreadBroadcasts.set(key, { ...params, ids: [...params.ids] })
      cacheBroadcast({
        ...params,
        id: params.id ?? key,
        submittedAt: params.submittedAt ?? Date.now()
      })
    }
    throw error
  }
  const validatedSettlement = isWalletSettlement(params.settlement, params)
    ? params.settlement
    : undefined
  const normalizedHash = params.txHash.toLowerCase()
  const scoped = all.filter(
    (record) =>
      record.chain === params.chain && record.wallet.toLowerCase() === params.wallet.toLowerCase()
  )
  const owned = params.id ? scoped.find((record) => record.id === params.id) : undefined
  const conflictingHash = owned?.txHash && owned.txHash.toLowerCase() !== normalizedHash
  if (conflictingHash && !normalizedHash)
    throw new Error(
      'PENDING_IDENTITY_CONFLICT: A recorded broadcast cannot be overwritten by an unsigned request.'
    )
  const hashMatch = normalizedHash
    ? scoped.find((record) => record.txHash.toLowerCase() === normalizedHash)
    : undefined
  // Requested nonces are not transaction identities. Preserve independent wallet requests.
  const existing = conflictingHash ? hashMatch : (owned ?? hashMatch)
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
    id:
      existing?.id ??
      (conflictingHash ? `${params.id}:hash:${normalizedHash}` : params.id) ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chain: params.chain,
    wallet: params.wallet,
    op: params.op,
    ids: params.ids.length ? params.ids : (existing?.ids ?? []),
    count: params.count || existing?.count || 0,
    term: params.term || existing?.term || 0,
    txHash: params.txHash,
    nonce: params.nonce ?? existing?.nonce ?? null,
    phase,
    origin: validatedSettlement
      ? 'wallet-verified'
      : (params.origin ?? existing?.origin ?? 'local'),
    nonceAuthoritative:
      params.nonceAuthoritative ??
      existing?.nonceAuthoritative ??
      (params.origin !== 'legacy-unknown' && params.nonce != null),
    receipt: validatedSettlement?.receipt ?? existing?.receipt,
    preVmuCount: params.preVmuCount ?? existing?.preVmuCount,
    beforeRanks: params.beforeRanks ?? existing?.beforeRanks,
    outcome: params.outcome ?? existing?.outcome,
    // Earliest known time ≈ when the tx entered the mempool from our perspective.
    // Pending txs have no on-chain block timestamp until mined.
    submittedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
    updatedAt: nextUpdatedAt(existing?.updatedAt)
  }
  try {
    appendRecord(rec)
    unreadBroadcasts.delete(broadcastKey(rec))
  } catch (error) {
    if (rec.txHash && isUnresolvedPending(rec)) unpersistedBroadcasts.set(rec.id, rec)
    throw error
  } finally {
    if (rec.txHash && isUnresolvedPending(rec)) cacheBroadcast(rec)
  }
  // Publish the replacement before removing any duplicate evidence.
  for (const duplicate of all) {
    if (
      duplicate.id !== rec.id &&
      duplicate.chain === rec.chain &&
      duplicate.wallet.toLowerCase() === rec.wallet.toLowerCase() &&
      normalizedHash.length > 0 &&
      duplicate.txHash.toLowerCase() === normalizedHash
    ) {
      try {
        appendTombstone(duplicate)
      } catch {
        /* Reconciliation can retry deduplication. */
      }
    }
  }
  if (!isUnresolvedPending(rec)) {
    releaseRecordLocks(rec)
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
    releaseRecordLocks(updated)
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
    releaseRecordLocks(record)
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
  await ensureHealthyReadProvider(chain)
  const { transaction: tx, settlement } = await readWalletEvidence(chain, wallet, hash)
  if (settlement) {
    const existing = listPendingOps(chain, wallet).find(
      (record) => record.txHash.toLowerCase() === hash.toLowerCase()
    )
    if (existing) {
      const decoded = tx ? decodeFactoryCalldata(tx.input) : null
      return toView(
        recordPendingOp({ ...existing, ...decoded, phase: settlement.phase, settlement })
      )
    }
    throw new Error('This transaction is already mined (no longer pending)')
  }
  if (!tx) throw new Error('Transaction not found through the wallet. Check the hash / network.')

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
    origin: 'wallet-verified',
    nonceAuthoritative: true,
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
  settlement?: WalletSettlement
  walletTransactionVerified?: boolean
}

/** Resolve only from affirmative chain evidence; absence alone stays blocking. */
export function reconcilePendingOp(
  record: PendingOpRecord,
  observation: PendingObservation,
  now = Date.now()
): PendingOpRecord {
  if (!isUnresolvedPending(record)) return record

  const observedNonce = observation.walletTransactionVerified
    ? normalizeNonce(observation.observedNonce)
    : null
  const nonce = record.nonce ?? observedNonce
  let phase = record.phase

  if (isWalletSettlement(observation.settlement, record)) {
    phase = observation.settlement.phase
  } else if (record.txHash && phase === 'awaiting-wallet') {
    phase = 'broadcast'
  }

  if (phase === record.phase && nonce === record.nonce) return record
  return {
    ...record,
    nonce,
    phase,
    origin: isWalletSettlement(observation.settlement, record) ? 'wallet-verified' : record.origin,
    receipt: observation.settlement?.receipt ?? record.receipt,
    updatedAt: now
  }
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
  if (data.length > 65_536 || !/^0x[0-9a-f]*$/i.test(data)) return null
  const decoded = decodeFactoryCalldataUnchecked(data)
  if (
    !decoded ||
    decoded.ids.length > 1_000 ||
    new Set(decoded.ids).size !== decoded.ids.length ||
    decoded.ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    !Number.isSafeInteger(decoded.count) ||
    decoded.count < 0 ||
    decoded.count > 1_000 ||
    !Number.isSafeInteger(decoded.term) ||
    decoded.term < 0 ||
    decoded.term > 10_000
  )
    return null
  if ((decoded.op === 'GENERAL_MINT' || decoded.op === 'CREATE_EMPTY_SLOT') && decoded.count === 0)
    return null
  if (
    decoded.op !== 'GENERAL_MINT' &&
    decoded.op !== 'CREATE_EMPTY_SLOT' &&
    decoded.ids.length === 0
  )
    return null
  if (
    (decoded.op === 'GENERAL_MINT' ||
      decoded.op === 'MINT_EMPTY_SLOT' ||
      decoded.op === 'CLAIM_REUSE') &&
    decoded.term === 0
  )
    return null
  return decoded
}

function decodeFactoryCalldataUnchecked(
  data: string
): { op: OpType; ids: number[]; count: number; term: number } | null {
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

async function discoverPendingFactoryTxs(
  chain: ChainKey,
  wallet: string,
  signal?: AbortSignal
): Promise<void> {
  const rpc = getReadProvider(chain, signal)
  try {
    const block = await withReadDeadline(
      () => rpc.send('eth_getBlockByNumber', ['pending', true]),
      'Pending block',
      { signal }
    )
    const txs = (block as { transactions?: unknown[] } | null)?.transactions
    if (!Array.isArray(txs)) return
    // Discovery is advisory and bounded; the wallet must authenticate each candidate.
    for (const value of txs.slice(0, 200)) {
      assertReadActive(signal)
      if (!value || typeof value !== 'object') continue
      const tx = value as Record<string, unknown>
      if (
        typeof tx.from !== 'string' ||
        tx.from.toLowerCase() !== wallet.toLowerCase() ||
        typeof tx.to !== 'string' ||
        tx.to.toLowerCase() !== CONTRACTS[chain].factory.toLowerCase() ||
        typeof tx.hash !== 'string' ||
        !/^0x[0-9a-f]{64}$/i.test(tx.hash)
      )
        continue
      try {
        const evidence = await readWalletEvidence(chain, wallet, tx.hash, { signal })
        if (!evidence.transaction || evidence.settlement) continue
        const decoded = decodeFactoryCalldata(evidence.transaction.input)
        if (!decoded) continue
        assertReadActive(signal)
        recordPendingOp({
          chain,
          wallet,
          ...decoded,
          txHash: evidence.transaction.hash,
          nonce: evidence.transaction.nonce,
          phase: 'broadcast',
          origin: 'wallet-verified',
          nonceAuthoritative: true
        })
      } catch {
        assertReadActive(signal)
      }
    }
  } catch {
    assertReadActive(signal)
  }
}

/**
 * Hydrate pending-ops store from VMU locks that already have a txHash
 * (covers older sessions that predate sm.pendingOps).
 */
function hydrateFromLocks(chain: ChainKey, wallet: string): void {
  for (const params of unreadBroadcasts.values()) {
    if (params.chain === chain && params.wallet.toLowerCase() === wallet.toLowerCase())
      recordPendingOp(params)
  }
  for (const record of unpersistedBroadcasts.values()) {
    if (record.chain === chain && record.wallet.toLowerCase() === wallet.toLowerCase())
      appendRecord(record)
  }
  const locks = pendingLocks(chain, wallet)
  for (const lock of locks) {
    const existing = listPendingOps(chain, wallet).find(
      (r) => r.txHash.toLowerCase() === lock.txHash.toLowerCase()
    )
    if (existing) {
      if (!isUnresolvedPending(existing)) releaseRecordLocks(existing)
      continue
    }
    // Prefer lock metadata; if missing, still store the hash so we can decode calldata next.
    recordPendingOp({
      id: lock.batch,
      chain,
      wallet,
      op: (lock.op as OpType) || 'GENERAL_MINT',
      ids: lock.ids,
      count: lock.count ?? 0,
      term: lock.term ?? 0,
      txHash: lock.txHash,
      nonce: null,
      phase: 'broadcast',
      submittedAt: lock.lockedAt,
      origin: 'legacy-unknown',
      nonceAuthoritative: false
    })
  }
}

/**
 * Refresh pending-op list against the chain and wallet provider.
 */
export async function refreshPendingOps(
  chain: ChainKey,
  wallet: string,
  options: { freshRpc?: boolean; reverifyResults?: boolean; signal?: AbortSignal } = {}
): Promise<{
  views: PendingOpView[]
  pendingNonceGap: number
  unresolvedCount: number
  confirmedOps: PendingOpRecord[]
}> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException('Pending reconciliation timed out', 'AbortError')),
    30_000
  )
  try {
    return await refreshPendingOpsWithinDeadline(chain, wallet, {
      ...options,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

async function refreshPendingOpsWithinDeadline(
  chain: ChainKey,
  wallet: string,
  options: { freshRpc?: boolean; reverifyResults?: boolean; signal: AbortSignal }
): Promise<{
  views: PendingOpView[]
  pendingNonceGap: number
  unresolvedCount: number
  confirmedOps: PendingOpRecord[]
}> {
  await withReadDeadline(
    () =>
      options.freshRpc === false
        ? ensureRecentReadProvider(chain, 30_000)
        : ensureHealthyReadProvider(chain),
    'RPC health check',
    options
  )
  const session = await walletReadSession(chain, options.signal)
  try {
    const [rawLatest, rawPending] = await Promise.all([
      session.request('eth_getTransactionCount', [wallet, 'latest']),
      session.request('eth_getTransactionCount', [wallet, 'pending'])
    ])
    const latest = walletQuantity(rawLatest, 'latest nonce')
    const pendingNonce = walletQuantity(rawPending, 'pending nonce')
    if (pendingNonce < latest)
      throw new Error('PENDING_STATE_UNCERTAIN: Wallet nonce observations are inconsistent.')
    const pendingNonceGap = pendingNonce - latest
    await session.validate()
    assertReadActive(options.signal)
    hydrateFromLocks(chain, wallet)
    const covered = new Set(
      listPendingOps(chain, wallet)
        .filter(isUnresolvedPending)
        .flatMap((record) =>
          record.nonceAuthoritative && record.nonce !== null ? [record.nonce] : []
        )
    )
    const explained = [...covered].filter((nonce) => nonce >= latest && nonce < pendingNonce).length
    const key = `${chain}:${wallet.toLowerCase()}`
    if (
      pendingNonceGap > explained &&
      Date.now() - (lastDiscoveryAt.get(key) ?? 0) >= DISCOVERY_THROTTLE_MS
    ) {
      lastDiscoveryAt.set(key, Date.now())
      await discoverPendingFactoryTxs(chain, wallet, options.signal)
    }
    const local = listPendingOps(chain, wallet).filter(isUnresolvedPending)
    const outcomes = await mapWithConcurrency(local, RECONCILE_CONCURRENCY, async (source) => {
      assertReadActive(options.signal)
      let record = source
      let found = false
      try {
        if (source.txHash) {
          const { transaction, settlement } = await readWalletEvidence(
            chain,
            wallet,
            source.txHash,
            {
              nonce: source.nonce,
              nonceAuthoritative: source.nonceAuthoritative,
              signal: options.signal
            }
          )
          found = transaction !== null
          const decoded = transaction ? decodeFactoryCalldata(transaction.input) : null
          if (transaction && decoded)
            record = {
              ...record,
              ...decoded,
              nonce: transaction.nonce,
              origin: 'wallet-verified',
              nonceAuthoritative: true
            }
          record = reconcilePendingOp(record, {
            receipt: null,
            transactionFound: found,
            latestNonce: latest,
            pendingNonce,
            settlement,
            walletTransactionVerified: found,
            observedNonce: transaction?.nonce
          })
        }
      } catch {
        assertReadActive(options.signal)
        // Unavailable or malformed wallet evidence never unlocks an operation.
      }
      return {
        source,
        record,
        status:
          isUnresolvedPending(record) && !found
            ? ('unknown' as const)
            : statusForPhase(record.phase)
      }
    })
    await session.validate()
    assertReadActive(options.signal)
    const candidates = new Map(outcomes.map((outcome) => [outcome.source.id, outcome]))
    const accepted = new Map<string, PendingOpView['status']>()
    const confirmedOps: PendingOpRecord[] = []
    for (const current of readAll()) {
      const candidate = candidates.get(current.id)
      if (!candidate || !sameRecordRevision(current, candidate.source)) continue
      accepted.set(current.id, candidate.status)
      if (!sameRecordRevision(current, candidate.record)) appendRecord(candidate.record)
      if (candidate.record.phase === 'confirmed') confirmedOps.push(candidate.record)
      if (!isUnresolvedPending(candidate.record)) {
        releaseRecordLocks(candidate.record)
      }
    }
    const unresolved = listPendingOps(chain, wallet).filter(isUnresolvedPending)
    const views = unresolved.map((record) =>
      toView(record, accepted.get(record.id) ?? statusForPhase(record.phase))
    )
    if (pendingNonceGap > 0 && unresolved.length === 0)
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
        origin: 'legacy-unknown',
        nonceAuthoritative: false,
        submittedAt: Date.now(),
        updatedAt: Date.now(),
        label: 'Pending transaction',
        detail: `${pendingNonceGap} in-flight nonce(s) - open MetaMask Activity for the hash`,
        explorerUrl: `${CHAINS[chain].blockExplorerUrl}/address/${wallet}`,
        status: 'pending'
      })
    // Restored result warnings do not block sending or trigger reads on every poll.
    const unverified = listPendingOps(chain, wallet)
      .filter(
        (record) =>
          record.phase === 'confirmed' &&
          record.receipt &&
          record.outcome?.classification !== 'full'
      )
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, 3)
    if (options.reverifyResults) {
      for (const source of unverified) {
        try {
          const { transaction, settlement } = await readWalletEvidence(
            chain,
            wallet,
            source.txHash,
            {
              signal: options.signal
            }
          )
          if (settlement?.phase !== 'confirmed' || !settlement.receipt) continue
          const decoded = transaction ? decodeFactoryCalldata(transaction.input) : null
          // Receipt identity proves settlement, not the operation described by old storage.
          if (!decoded) continue
          const authenticated = { ...source, ...decoded, receipt: settlement.receipt }
          const outcome = await verifyOperationOutcomeWithRetry(authenticated, {
            signal: options.signal
          })
          assertReadActive(options.signal)
          const current = readAll().find((record) => record.id === source.id)
          if (current && sameRecordRevision(current, source))
            recordPendingOp({ ...authenticated, phase: 'confirmed', settlement, outcome })
        } catch {
          assertReadActive(options.signal)
        }
      }
    }
    for (const source of unverified) {
      const record = readAll().find((candidate) => candidate.id === source.id)
      if (!record || record.phase !== 'confirmed' || record.outcome?.classification === 'full')
        continue
      const view = toView(record)
      view.detail +=
        record.outcome?.classification === 'partial'
          ? ` · Result partially verified (${record.outcome.matchingCount}/${record.outcome.expectedCount} VMUs). Recheck before repeating this operation.`
          : ' · Transaction confirmed; result verification incomplete. Recheck or inspect the explorer before repeating this operation.'
      views.push(view)
    }
    views.sort((a, b) => b.submittedAt - a.submittedAt)
    return { views, pendingNonceGap, unresolvedCount: unresolved.length, confirmedOps }
  } finally {
    session.dispose()
  }
}
