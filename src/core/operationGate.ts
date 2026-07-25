export interface ExclusiveGate {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

export function operationKey(chain: string, wallet: string): string {
  return `xenturbo:${chain}:${wallet.toLowerCase()}:send`
}

export interface WalletLockOptions {
  timeoutMs?: number
}

const DEFAULT_WALLET_LOCK_TIMEOUT_MS = 30_000

export async function runWalletExclusive<T>(
  key: string,
  work: () => Promise<T>,
  options: WalletLockOptions = {}
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('Web Locks unavailable in this browser')
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_WALLET_LOCK_TIMEOUT_MS
  let acquired = false
  const timer = setTimeout(() => {
    if (!acquired) controller.abort()
  }, timeoutMs)

  try {
    return await navigator.locks.request(key, { signal: controller.signal }, async () => {
      acquired = true
      clearTimeout(timer)
      return await work()
    })
  } catch (error) {
    if (!acquired && controller.signal.aborted) {
      throw new Error(
        `WALLET_LOCK_TIMEOUT: Another tab is using this wallet. Retry after its transaction finishes.`
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function createInMemoryExclusiveGate(): ExclusiveGate {
  const tails = new Map<string, Promise<unknown>>()

  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const current = previous.catch(() => undefined).then(work)
      tails.set(key, current)

      return current.finally(() => {
        if (tails.get(key) === current) tails.delete(key)
      })
    }
  }
}
