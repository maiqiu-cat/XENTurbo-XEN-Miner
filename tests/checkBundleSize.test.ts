import { describe, expect, it } from 'vitest'
import {
  MAX_CHUNK_GZIP_BYTES,
  MAX_TOTAL_GZIP_BYTES,
  evaluateBundleBudget
} from '../scripts/check-bundle-size.mjs'

describe('bundle size release gate', () => {
  it('uses the 180 KiB per-chunk and 220 KiB total gzip budgets', () => {
    expect(MAX_CHUNK_GZIP_BYTES).toBe(180 * 1024)
    expect(MAX_TOTAL_GZIP_BYTES).toBe(220 * 1024)
  })

  it('rejects a chunk that exceeds the per-chunk gzip budget', () => {
    const result = evaluateBundleBudget([
      { path: 'assets/index.js', rawBytes: 1, gzipBytes: 180 * 1024 + 1 }
    ])

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('largest chunk')])
    )
  })

  it('rejects total JavaScript gzip bytes above the total budget', () => {
    const result = evaluateBundleBudget([
      { path: 'assets/a.js', rawBytes: 1, gzipBytes: 110 * 1024 },
      { path: 'assets/b.js', rawBytes: 1, gzipBytes: 110 * 1024 + 1 }
    ])

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('total JavaScript')])
    )
  })
})
