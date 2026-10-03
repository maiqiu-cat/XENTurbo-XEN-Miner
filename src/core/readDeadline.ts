export const READ_TIMEOUT_MS = 15_000

/** Bounds reads only. A wallet send is non-cancellable and must never use this helper. */
export function withReadDeadline<T>(
  read: () => Promise<T>,
  label: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const { signal, timeoutMs = READ_TIMEOUT_MS } = options
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (result: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      result()
    }
    const aborted = () => finish(() => reject(signal?.reason ?? abortError()))
    const timer = setTimeout(
      () => finish(() => reject(new Error(`READ_TIMEOUT: ${label} exceeded ${timeoutMs} ms`))),
      timeoutMs
    )
    signal?.addEventListener('abort', aborted, { once: true })
    Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw signal.reason ?? abortError()
        return read()
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

export function abortError(): DOMException {
  return new DOMException('The read was cancelled', 'AbortError')
}

export function assertReadActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError()
}
