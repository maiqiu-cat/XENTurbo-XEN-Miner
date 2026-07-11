export interface BundleMeasurement {
  path: string
  rawBytes: number
  gzipBytes: number
}

export const MAX_CHUNK_GZIP_BYTES: number
export const MAX_TOTAL_GZIP_BYTES: number
export function measureJavaScriptBundles(distDirectory?: string): Promise<BundleMeasurement[]>
export function evaluateBundleBudget(measurements: BundleMeasurement[]): {
  largest: BundleMeasurement
  totalGzipBytes: number
  errors: string[]
}
