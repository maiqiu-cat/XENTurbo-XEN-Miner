import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '@/config/security'

describe('analytics content security policy', () => {
  it('allows the Cloudflare module beacon without allowing inline scripts or the removed GA endpoints', () => {
    const csp = contentSecurityPolicy()
    const scriptDirective = csp.split('; ').find((directive) => directive.startsWith('script-src'))

    expect(scriptDirective).toBe("script-src 'self' https://static.cloudflareinsights.com")
    expect(scriptDirective).not.toContain("'unsafe-inline'")
    expect(csp).toContain("img-src 'self' data: chrome-extension:")
    expect(csp).not.toMatch(/google-analytics|googletagmanager/)
  })

  it('keeps the production Nginx policy aligned with the application policy', () => {
    const nginx = readFileSync('ops/nginx/security-headers.conf', 'utf8')

    expect(nginx).toContain(contentSecurityPolicy())
    expect(nginx).not.toMatch(/google-analytics|googletagmanager/)
    expect(nginx).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})

describe('source and workflow secret guardrails', () => {
  it.each(['ci.yml', 'release-probe.yml'])(
    'does not persist checkout credentials in %s',
    (workflow) => {
      const text = readFileSync(`.github/workflows/${workflow}`, 'utf8')
      expect(text).toMatch(/permissions:\s+contents: read/)
      expect(text).toMatch(/persist-credentials: false/)
      expect(text).not.toContain('pull_request_target')
    }
  )

  it('ignores private environment variants and explicitly retains public build templates', () => {
    const rules = readFileSync('.gitignore', 'utf8').split(/\r?\n/)
    expect(rules).toContain('.env')
    expect(rules).toContain('.env.*')
    expect(rules).toContain('!.env.example')
    expect(rules).toContain('!.env.production')
  })
})
