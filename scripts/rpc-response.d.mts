export function rpcBatchResults(
  payload: unknown,
  ids: readonly number[]
): Map<number, { result?: unknown; error?: { message?: unknown } }>
export function rpcStringResult(
  results: ReturnType<typeof rpcBatchResults>,
  id: number,
  label: string
): string
export function rpcChainId(value: string): bigint
export function rpcAbiWord(value: string, label: string): string
