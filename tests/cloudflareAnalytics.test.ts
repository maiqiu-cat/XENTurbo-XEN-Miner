// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Window as HappyDomWindow } from 'happy-dom'
import {
  CLOUDFLARE_ANALYTICS_TOKEN,
  CLOUDFLARE_BEACON_URL,
  loadCloudflareAnalytics
} from '@/core/cloudflareAnalytics'

const browserSettings = (window as unknown as HappyDomWindow).happyDOM.settings
const originalDisabledLoading = browserSettings.handleDisabledFileLoadingAsSuccess
beforeEach(() => {
  // Neither this DOM test nor the controlled Playwright beacon fixture verifies the live script.
  browserSettings.handleDisabledFileLoadingAsSuccess = true
})

afterEach(() => {
  browserSettings.handleDisabledFileLoadingAsSuccess = originalDisabledLoading
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.querySelectorAll('script[data-cf-beacon]').forEach((script) => script.remove())
})

function hostname(value: string) {
  vi.stubGlobal('window', { location: { hostname: value } })
}

describe('Cloudflare page analytics', () => {
  it('loads the supplied module beacon once on the production hostname without a consent prompt', () => {
    hostname('miner.xenturbo.io')
    loadCloudflareAnalytics()
    loadCloudflareAnalytics()

    const scripts = document.querySelectorAll<HTMLScriptElement>('script[data-cf-beacon]')
    expect(scripts).toHaveLength(1)
    expect(scripts[0].src).toBe(CLOUDFLARE_BEACON_URL)
    expect(scripts[0].type).toBe('module')
    expect(JSON.parse(scripts[0].getAttribute('data-cf-beacon')!)).toEqual({
      token: CLOUDFLARE_ANALYTICS_TOKEN
    })
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull()
  })

  it.each(['localhost', '127.0.0.1', 'fork.example', 'miner.xenturbo.io.attacker.example'])(
    'does not measure local development or other hosts: %s',
    (host) => {
      hostname(host)
      loadCloudflareAnalytics()
      expect(document.querySelector('script[data-cf-beacon]')).toBeNull()
    }
  )

  it('does not duplicate a beacon already injected by Cloudflare', () => {
    hostname('miner.xenturbo.io')
    const existing = document.createElement('script')
    existing.setAttribute('data-cf-beacon', '{"token":"already-configured"}')
    document.body.appendChild(existing)
    loadCloudflareAnalytics()
    expect(document.querySelectorAll('script[data-cf-beacon]')).toHaveLength(1)
    expect(existing.getAttribute('data-cf-beacon')).toContain('already-configured')
  })

  it('is inert outside a browser and does not propagate optional DOM failures', () => {
    vi.stubGlobal('window', undefined)
    expect(() => loadCloudflareAnalytics()).not.toThrow()
    hostname('miner.xenturbo.io')
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => {
      throw new Error('analytics blocked')
    })
    expect(() => loadCloudflareAnalytics()).not.toThrow()
  })
})
