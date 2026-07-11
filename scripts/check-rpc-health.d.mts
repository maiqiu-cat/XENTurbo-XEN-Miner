export interface RpcHealthConfig {
  chainId: number
  factory: string
}

export interface RpcHealthResult {
  url: string
  healthy: boolean
  chainId?: number
  fee?: bigint
  error?: string
}

export function checkRpcEndpoint(
  url: string,
  config: RpcHealthConfig,
  fetchImpl?: typeof fetch
): Promise<RpcHealthResult>
