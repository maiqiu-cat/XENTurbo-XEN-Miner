import { defineStore } from 'pinia'
import type { ChainKey } from '@/config/chains'
import type { Vmu, VmuGroup, VmuStatus } from '@/core/types'
import {
  readWalletVmus,
  readGlobalRank,
  readVmuCount,
  readChainTimestamp,
  readVmuStates,
  classifyVmuStatus
} from '@/core/chainReader'
import { loadSnapshot, saveSnapshot } from '@/core/idb'
import { broadcastLockedIds } from '@/core/localLock'
import {
  ensureHealthyReadProvider,
  RpcConfigurationError,
  rpcConfigurationMessage,
  rpcUnavailableMessage
} from '@/core/rpc'
import { assertReadActive, ReadTimeoutError, withReadDeadline } from '@/core/readDeadline'
import { RpcRateLimitError } from '@/core/rpcPolicy'
import { estimateGroupXen } from '@/utils/rewards'
import { formatDate } from '@/utils/format'

function readFailureMessage(error: unknown): string {
  if (error instanceof RpcConfigurationError) return rpcConfigurationMessage(error.message)
  if (error instanceof RpcRateLimitError) return error.message
  if (error instanceof ReadTimeoutError)
    return `RPC read timed out. ${error.diagnostic} Refresh or check RPC settings.`
  if (error instanceof Error && /RPC_UNAVAILABLE|RPC_NOT_VALIDATED/i.test(error.message))
    return rpcUnavailableMessage()
  // Keep raw endpoint diagnostics out of UI copy; do not serialize causes to telemetry.
  console.warn('VMU refresh failed', error)
  return 'RPC read failed. Refresh or check RPC settings.'
}

function retainedSnapshotMessage(syncedAt: number): string {
  return `The last refresh did not complete; the list below was loaded at ${formatDate(syncedAt)}.`
}

interface State {
  chain: ChainKey | null
  wallet: string | null
  vmuCount: number
  vmus: Vmu[]
  globalRank: number
  rankAvailable: boolean
  rankError: string | null
  syncedAt: number | null
  chainTimestampMs: number | null
  loading: boolean
  /** Display-only until a complete current-context inventory has been read. */
  stale: boolean
  progress: { loaded: number; total: number }
  error: string | null
  /** Number of VMUs whose Multicall read failed (not EMPTY). */
  readErrors: number
  /** Monotonic token to discard stale refresh results after wallet/chain switch. */
  refreshGen: number
}

const OPERABLE: VmuStatus[] = ['EMPTY', 'MINTING', 'CLAIMABLE']
let maturityTimer: ReturnType<typeof setTimeout> | null = null
const refreshFlights = new WeakMap<
  object,
  {
    chain: ChainKey
    wallet: string
    kind: 'full' | 'affected'
    controller: AbortController
    promise: Promise<void>
  }
>()
const clockFlights = new WeakMap<
  object,
  {
    controller: AbortController
    promise: Promise<number | null>
  }
>()

function abortClockRefresh(store: object): void {
  clockFlights.get(store)?.controller.abort()
  clockFlights.delete(store)
}

function abortRefresh(store: object): void {
  refreshFlights
    .get(store)
    ?.controller.abort(new DOMException('Wallet or chain changed', 'AbortError'))
  refreshFlights.delete(store)
}

function clearMaturityTimer(): void {
  if (maturityTimer) clearTimeout(maturityTimer)
  maturityTimer = null
}

function normalizeVmu(v: Vmu): Vmu {
  // Older IndexedDB snapshots may lack readOk — treat as ok.
  if (typeof v.readOk !== 'boolean') {
    return { ...v, readOk: v.status !== 'READ_ERROR' }
  }
  return v
}

export const useVmuStore = defineStore('vmu', {
  state: (): State => ({
    chain: null,
    wallet: null,
    vmuCount: 0,
    vmus: [],
    globalRank: 0,
    rankAvailable: false,
    rankError: null,
    syncedAt: null,
    chainTimestampMs: null,
    loading: false,
    stale: true,
    progress: { loaded: 0, total: 0 },
    error: null,
    readErrors: 0,
    refreshGen: 0
  }),
  getters: {
    transactionReady(state): boolean {
      return !state.stale && !state.loading && state.syncedAt !== null
    },
    emptyIds(state): number[] {
      // Only hide ids that already have a broadcast tx (not soft pre-sign locks).
      const locked =
        state.chain && state.wallet
          ? broadcastLockedIds(state.chain, state.wallet)
          : new Set<number>()
      return state.vmus
        .filter((v) => v.status === 'EMPTY' && v.readOk && !locked.has(v.id))
        .map((v) => v.id)
    },
    // Per-status VMU counts. Broadcast-pending ids are excluded so the header
    // numbers stay consistent with the grouped Mint list below.
    // READ_ERROR is tracked separately via readErrors.
    counts(state): Record<'EMPTY' | 'MINTING' | 'CLAIMABLE', number> {
      const locked =
        state.chain && state.wallet
          ? broadcastLockedIds(state.chain, state.wallet)
          : new Set<number>()
      const c = { EMPTY: 0, MINTING: 0, CLAIMABLE: 0 }
      state.vmus.forEach((v) => {
        if (locked.has(v.id)) return
        if (v.status === 'EMPTY' || v.status === 'MINTING' || v.status === 'CLAIMABLE')
          c[v.status] += 1
      })
      return c
    },
    // Group non-empty VMUs by (term, maturityTs) - the same grouping the old
    // backend produced for the Mint list.
    groups(state): VmuGroup[] {
      const locked =
        state.chain && state.wallet
          ? broadcastLockedIds(state.chain, state.wallet)
          : new Set<number>()
      const map = new Map<string, VmuGroup>()
      for (const v of state.vmus) {
        if (v.status === 'EMPTY' || v.status === 'READ_ERROR') continue
        if (locked.has(v.id)) continue
        if (!OPERABLE.includes(v.status)) continue
        const key = `${v.term}-${v.maturityTs}`
        let g = map.get(key)
        if (!g) {
          g = {
            key,
            term: v.term,
            maturityTs: v.maturityTs,
            status: v.status as 'MINTING' | 'CLAIMABLE',
            rank: v.rank,
            ranks: [],
            amplifier: v.amplifier,
            eaaRate: v.eaaRate,
            ids: [],
            count: 0
          }
          map.set(key, g)
        }
        g.ranks.push(v.rank)
        g.ids.push(v.id)
        g.count += 1
        if (v.rank < g.rank) g.rank = v.rank
      }
      const list = Array.from(map.values())
      if (state.rankAvailable) {
        for (const g of list) {
          g.estXen = estimateGroupXen({
            globalRank: state.globalRank,
            ranks: g.ranks,
            term: g.term,
            amplifier: g.amplifier,
            eaaRate: g.eaaRate,
            maturityMs: g.maturityTs,
            currentTimeMs: state.chainTimestampMs ?? undefined
          })
        }
      }
      return list.sort((a, b) => b.maturityTs - a.maturityTs)
    },
    claimableGroups(): VmuGroup[] {
      return (this.groups as VmuGroup[])
        .filter((g) => g.status === 'CLAIMABLE')
        .sort((a, b) => a.maturityTs - b.maturityTs)
    },
    mintingGroups(): VmuGroup[] {
      return (this.groups as VmuGroup[]).filter((g) => g.status === 'MINTING')
    }
  },
  actions: {
    reset() {
      this.stale = true
      abortClockRefresh(this)
      clearMaturityTimer()
      this.vmuCount = 0
      this.vmus = []
      this.globalRank = 0
      this.rankAvailable = false
      this.rankError = null
      this.syncedAt = null
      this.chainTimestampMs = null
      this.loading = false
      this.progress = { loaded: 0, total: 0 }
      this.error = null
      this.readErrors = 0
    },

    detach() {
      this.stale = true
      abortRefresh(this)
      this.refreshGen += 1
      this.chain = null
      this.wallet = null
      this.reset()
    },

    /** Load cached snapshot instantly, then refresh from chain in the background. */
    async load(chain: ChainKey, wallet: string) {
      this.stale = true
      abortRefresh(this)
      const gen = ++this.refreshGen
      this.chain = chain
      this.wallet = wallet
      this.reset()

      const isCurrent = () =>
        gen === this.refreshGen && this.chain === chain && this.wallet === wallet

      const cached = await loadSnapshot(chain, wallet)
      if (!isCurrent()) return
      if (cached) {
        this.vmuCount = cached.vmuCount
        this.vmus = cached.vmus.map(normalizeVmu)
        this.syncedAt = cached.syncedAt
        this.chainTimestampMs = cached.chainTimestampMs
        this.readErrors = this.vmus.filter((v) => !v.readOk || v.status === 'READ_ERROR').length
      }
      if (!isCurrent()) return
      await this.refresh()
    },

    /** Full re-read from chain (source of truth). */
    async refresh(options: { afterCurrent?: boolean; restart?: boolean } = {}): Promise<void> {
      if (!this.chain || !this.wallet) return
      const chain = this.chain
      const wallet = this.wallet
      if (options.restart) abortRefresh(this)
      const existing = refreshFlights.get(this)
      if (
        existing?.chain === chain &&
        existing.wallet.toLowerCase() === wallet.toLowerCase() &&
        !existing.controller.signal.aborted
      ) {
        if (existing.kind === 'full' && !options.afterCurrent) return existing.promise
        await existing.promise
        if (this.chain === chain && this.wallet === wallet) return this.refresh(options)
        return
      }

      const controller = new AbortController()
      abortClockRefresh(this)
      clearMaturityTimer()
      const promise = (async () => {
        const gen = ++this.refreshGen
        const isCurrent = () =>
          !controller.signal.aborted &&
          gen === this.refreshGen &&
          this.chain === chain &&
          this.wallet === wallet
        this.loading = true
        this.stale = true
        this.error = null
        this.progress = { loaded: 0, total: 0 }
        try {
          await withReadDeadline(() => ensureHealthyReadProvider(chain), 'RPC health check', {
            signal: controller.signal
          })
          if (!isCurrent()) return
          const [count, rankResult, chainTimestampMs] = await Promise.all([
            readVmuCount(chain, wallet, { signal: controller.signal }),
            readGlobalRank(chain, { signal: controller.signal }).then(
              (rank) => ({ ok: true as const, rank }),
              (error: unknown) => ({ ok: false as const, error })
            ),
            readChainTimestamp(chain, { signal: controller.signal })
          ])
          if (!isCurrent()) return

          const scannedVmus = await readWalletVmus(chain, wallet, {
            vmuCount: count,
            chainTimestampMs,
            signal: controller.signal,
            onProgress: (p) => {
              if (isCurrent()) this.progress = p
            }
          })
          if (!isCurrent()) return

          const latestChainTimestampMs = await readChainTimestamp(chain, {
            signal: controller.signal
          }).catch(() => chainTimestampMs)
          if (!isCurrent()) return
          const vmus = scannedVmus.map((vmu) =>
            vmu.readOk && vmu.status !== 'READ_ERROR'
              ? {
                  ...vmu,
                  status: classifyVmuStatus(vmu.rank, vmu.maturityTs, latestChainTimestampMs)
                }
              : vmu
          )
          const readErrors = vmus.filter((v) => !v.readOk || v.status === 'READ_ERROR').length
          if (readErrors > 0) {
            this.error = `${readErrors} VMU(s) failed to read. Refresh or check RPC — do not treat them as empty.`
            // A partial retry must not overwrite the last complete display snapshot or cache.
            if (
              this.syncedAt !== null &&
              this.vmus.length === this.vmuCount &&
              this.vmus.every((vmu) => vmu.readOk && vmu.status !== 'READ_ERROR')
            ) {
              this.error = retainedSnapshotMessage(this.syncedAt)
              return
            }
          }

          this.vmuCount = count
          this.vmus = vmus
          this.chainTimestampMs = latestChainTimestampMs
          this.globalRank = rankResult.ok ? rankResult.rank : 0
          this.rankAvailable = rankResult.ok
          const rankError = rankResult.ok ? null : (rankResult.error as any)
          this.rankError = rankResult.ok
            ? null
            : rankError?.shortMessage ||
              rankError?.message ||
              'Global rank is unavailable on the active chain'
          this.readErrors = readErrors
          this.syncedAt = Date.now()
          await saveSnapshot({
            chain,
            wallet,
            vmuCount: count,
            vmus,
            syncedAt: this.syncedAt,
            chainTimestampMs: latestChainTimestampMs
          })
          if (isCurrent()) {
            this.stale = this.readErrors > 0
            this.scheduleMaturityRefresh()
          }
        } catch (err: any) {
          if (controller.signal.aborted || err?.name === 'AbortError') return
          if (!isCurrent()) return
          this.error = readFailureMessage(err)
        } finally {
          if (isCurrent()) this.loading = false
        }
      })()

      const flight = { chain, wallet, kind: 'full' as const, controller, promise }
      refreshFlights.set(this, flight)
      const clearFlight = () => {
        if (refreshFlights.get(this) === flight) refreshFlights.delete(this)
      }
      void promise.then(clearFlight, clearFlight)
      return promise
    },

    /** Re-read only the affected ids when the cached wallet inventory is complete. */
    async refreshAffected(ids: number[]): Promise<void> {
      if (!this.chain || !this.wallet) return
      const active = refreshFlights.get(this)
      if (
        active &&
        active.chain === this.chain &&
        active.wallet === this.wallet &&
        !active.controller.signal.aborted
      ) {
        await active.promise
        if (this.chain === active.chain && this.wallet === active.wallet)
          return this.refreshAffected(ids)
        return
      }
      const selected = [...new Set(ids)]
      if (
        this.stale ||
        !selected.length ||
        selected.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        this.vmus.length !== this.vmuCount ||
        this.syncedAt === null
      )
        return this.refresh()
      const chain = this.chain
      const wallet = this.wallet
      const oldCount = this.vmuCount
      const newIds = selected.filter((id) => id > oldCount).sort((a, b) => a - b)
      abortRefresh(this)
      abortClockRefresh(this)
      clearMaturityTimer()
      const controller = new AbortController()
      const gen = ++this.refreshGen
      const isCurrent = () =>
        !controller.signal.aborted &&
        gen === this.refreshGen &&
        this.chain === chain &&
        this.wallet === wallet
      const promise = (async () => {
        this.loading = true
        this.stale = true
        this.error = null
        try {
          await withReadDeadline(() => ensureHealthyReadProvider(chain), 'RPC health check', {
            signal: controller.signal
          })
          if (!isCurrent()) return
          const [count, rank, timestamp] = await Promise.all([
            readVmuCount(chain, wallet, { signal: controller.signal }),
            readGlobalRank(chain, { signal: controller.signal }).catch(() => null),
            readChainTimestamp(chain, { signal: controller.signal })
          ])
          if (!isCurrent()) return
          if (
            count !== oldCount + newIds.length ||
            newIds.some((id, index) => id !== oldCount + index + 1)
          ) {
            refreshFlights.delete(this)
            return this.refresh()
          }
          const affected = await readVmuStates(chain, wallet, selected, {
            signal: controller.signal
          })
          if (!isCurrent()) return
          const updates = new Map(affected.map((vmu) => [vmu.id, vmu]))
          if (updates.size !== selected.length) throw new Error('Incomplete affected VMU result')
          const failed = affected.filter((vmu) => !vmu.readOk || vmu.status === 'READ_ERROR').length
          if (failed > 0) {
            this.error = retainedSnapshotMessage(this.syncedAt!)
            return
          }
          const vmus = this.vmus.map((vmu) => {
            const value = updates.get(vmu.id) ?? vmu
            return value.readOk
              ? { ...value, status: classifyVmuStatus(value.rank, value.maturityTs, timestamp) }
              : { ...value }
          })
          for (const id of newIds) vmus.push(updates.get(id)!)
          this.vmus = vmus
          this.vmuCount = count
          this.chainTimestampMs = timestamp
          this.globalRank = rank ?? 0
          this.rankAvailable = rank !== null
          this.rankError = rank === null ? 'Global rank is unavailable on the active chain' : null
          this.syncedAt = Date.now()
          this.readErrors = vmus.filter((vmu) => !vmu.readOk || vmu.status === 'READ_ERROR').length
          if (this.readErrors)
            this.error = `${this.readErrors} VMU(s) failed to read. Refresh or check RPC.`
          await saveSnapshot({
            chain,
            wallet,
            vmuCount: count,
            vmus,
            syncedAt: this.syncedAt,
            chainTimestampMs: timestamp
          })
          if (isCurrent()) {
            this.stale = this.readErrors > 0
            this.scheduleMaturityRefresh()
          }
        } catch (error) {
          if (isCurrent()) this.error = readFailureMessage(error)
        } finally {
          if (isCurrent()) this.loading = false
        }
      })()
      const flight = { chain, wallet, kind: 'affected' as const, controller, promise }
      refreshFlights.set(this, flight)
      void promise.finally(() => {
        if (refreshFlights.get(this) === flight) refreshFlights.delete(this)
      })
      return promise
    },

    /** Re-anchor a resumed page without rescanning its complete VMU inventory. */
    async refreshChainTime(signal?: AbortSignal): Promise<number | null> {
      if (!this.chain || !this.wallet || signal?.aborted) return null
      const existing = clockFlights.get(this)
      if (existing && !existing.controller.signal.aborted) return existing.promise
      const chain = this.chain
      const wallet = this.wallet
      const gen = this.refreshGen
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      const promise = (async () => {
        try {
          const timestamp = await withReadDeadline(
            async () => {
              const active = refreshFlights.get(this)
              if (active) await active.promise
              assertReadActive(controller.signal)
              await ensureHealthyReadProvider(chain)
              assertReadActive(controller.signal)
              return readChainTimestamp(chain, { signal: controller.signal })
            },
            'Chain time refresh',
            { signal: controller.signal }
          )
          if (
            controller.signal.aborted ||
            gen !== this.refreshGen ||
            chain !== this.chain ||
            wallet !== this.wallet
          )
            return null
          this.chainTimestampMs = timestamp
          this.scheduleMaturityRefresh()
          return timestamp
        } catch (error) {
          if (controller.signal.aborted) return null
          throw error
        } finally {
          signal?.removeEventListener('abort', abort)
          controller.abort()
        }
      })()
      const flight = { controller, promise }
      clockFlights.set(this, flight)
      const clearFlight = () => {
        if (clockFlights.get(this) === flight) clockFlights.delete(this)
      }
      void promise.then(clearFlight, clearFlight)
      return promise
    },

    async hardRefresh() {
      await this.refresh({ restart: true })
    },

    scheduleMaturityRefresh() {
      clearMaturityTimer()
      if (this.stale || !this.chain || !this.wallet || this.chainTimestampMs === null) return
      const nearest = this.vmus
        .filter((vmu) => vmu.status === 'MINTING' && vmu.maturityTs > 0)
        .reduce((value, vmu) => Math.min(value, vmu.maturityTs), Number.POSITIVE_INFINITY)
      if (!Number.isFinite(nearest)) return

      const chain = this.chain
      const wallet = this.wallet
      const delay = Math.min(
        Math.max(1_000, nearest - this.chainTimestampMs + 1_500),
        2_147_000_000
      )
      maturityTimer = setTimeout(() => {
        maturityTimer = null
        if (!this.stale && this.chain === chain && this.wallet === wallet) void this.refresh()
      }, delay)
    }
  }
})
