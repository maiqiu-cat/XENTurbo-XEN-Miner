import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '@/config/security'

describe('analytics content security policy', () => {
  it('allows only the direct Google tag script without allowing inline scripts', () => {
    const csp = contentSecurityPolicy()
    const scriptDirective = csp.split('; ').find((directive) => directive.startsWith('script-src'))

    expect(scriptDirective).toBe("script-src 'self' https://www.googletagmanager.com")
    expect(scriptDirective).not.toContain("'unsafe-inline'")
    expect(csp).toContain(
      "img-src 'self' data: chrome-extension: https://*.google-analytics.com https://*.googletagmanager.com"
    )
  })

  it('keeps the production Nginx policy aligned with the application policy', () => {
    const nginx = readFileSync('ops/nginx/security-headers.conf', 'utf8')

    expect(nginx).toContain("script-src 'self' https://www.googletagmanager.com")
    expect(nginx).toContain(
      "img-src 'self' data: chrome-extension: https://*.google-analytics.com https://*.googletagmanager.com"
    )
    expect(nginx).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})
