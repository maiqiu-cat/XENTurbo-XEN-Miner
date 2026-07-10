export interface ExclusiveGate {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

export function operationKey(chain: string, wallet: string): string {
  return `xenturbo:${chain}:${wallet.toLowerCase()}:send`
}

export async function runWalletExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('Web Locks unavailable in this browser')
  }

  return await navigator.locks.request(key, work)
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
