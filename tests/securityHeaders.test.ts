import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../src/config/security'

describe('wallet-extension content security policy', () => {
  it('allows injected wallet images without allowing extension scripts', () => {
    const nginxHeaders = readFileSync(
      fileURLToPath(new URL('../ops/nginx/security-headers.conf', import.meta.url)),
      'utf8'
    )

    for (const policy of [contentSecurityPolicy(), nginxHeaders]) {
      expect(policy).toContain("img-src 'self' data: chrome-extension:")
      expect(policy).not.toMatch(/script-src[^;]*chrome-extension:/)
    }
  })
})
