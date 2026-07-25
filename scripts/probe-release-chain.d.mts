export interface ReleaseProbeConfig {
  chainId: number
  factory: string
  xenCrypto: string
  vmuTemplate: string
}

export interface ReleaseProbeResult {
  healthy: boolean
  url: string
  chainId?: number
  fee?: bigint
  vmuCount?: bigint
  error?: string
}

export function probeReleaseEndpoint(
  url: string,
  config: ReleaseProbeConfig,
  fetchImpl?: typeof fetch
): Promise<ReleaseProbeResult>
