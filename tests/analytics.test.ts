// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const MEASUREMENT_ID = 'G-JZYF7G3X2N'
const HOSTNAME = 'miner.xenturbo.io'

type AnalyticsModule = typeof import('@/core/analytics')

function createScriptCapture() {
  let script: HTMLScriptElement | null = null
  return {
    appendTagScript(tag: HTMLScriptElement) {
      script = tag
    },
    getScript() {
      return script
    }
  }
}

async function loadAnalytics(): Promise<AnalyticsModule> {
  return import('@/core/analytics')
}

function clearAnalyticsDom() {
  document.querySelectorAll('script[data-xenturbo-ga]').forEach((node) => node.remove())
  localStorage.clear()
  document.cookie.split(';').forEach((entry) => {
    const name = entry.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`
  })
  delete window.dataLayer
  delete window.gtag
  delete (window as unknown as Record<string, unknown>)[`ga-disable-${MEASUREMENT_ID}`]
}

describe('GA4 analytics client', () => {
  beforeEach(clearAnalyticsDom)
  afterEach(clearAnalyticsDom)

  it('does not load Google Analytics before the user grants consent', async () => {
    const { createAnalyticsClient } = await loadAnalytics()
    const client = createAnalyticsClient({
      measurementId: MEASUREMENT_ID,
      allowedHostname: HOSTNAME,
      hostname: HOSTNAME
    })

    await client.initialize()

    expect(client.isAvailable()).toBe(true)
    expect(client.getConsent()).toBeNull()
    expect(document.querySelector('script[data-xenturbo-ga]')).toBeNull()
    expect(window.dataLayer).toBeUndefined()
  })

  it('loads the direct Google tag once after consent and disables advertising features', async () => {
    const { createAnalyticsClient } = await loadAnalytics()
    const scripts = createScriptCapture()
    const client = createAnalyticsClient({
      measurementId: MEASUREMENT_ID,
      allowedHostname: HOSTNAME,
      hostname: HOSTNAME,
      appendTagScript: scripts.appendTagScript
    })

    const firstGrant = client.grant()
    const script = scripts.getScript()

    expect(script?.async).toBe(true)
    expect(script?.src).toBe(`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`)
    expect(script?.dataset.xenturboGa).toBe(MEASUREMENT_ID)

    script?.dispatchEvent(new Event('load'))
    await expect(firstGrant).resolves.toBe(true)
    await expect(client.grant()).resolves.toBe(true)
    expect(scripts.getScript()).toBe(script)

    expect(window.dataLayer).toContainEqual([
      'consent',
      'default',
      {
        ad_personalization: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        analytics_storage: 'denied'
      }
    ])
    expect(window.dataLayer).toContainEqual([
      'config',
      MEASUREMENT_ID,
      {
        allow_ad_personalization_signals: false,
        allow_google_signals: false,
        send_page_view: true
      }
    ])
  })

  it('sends only allow-listed anonymous event values', async () => {
    const { createAnalyticsClient } = await loadAnalytics()
    const scripts = createScriptCapture()
    const client = createAnalyticsClient({
      measurementId: MEASUREMENT_ID,
      allowedHostname: HOSTNAME,
      hostname: HOSTNAME,
      appendTagScript: scripts.appendTagScript
    })

    const granting = client.grant()
    scripts.getScript()?.dispatchEvent(new Event('load'))
    await granting

    const sent = client.track('miner_operation', {
      operation: 'general_mint',
      stage: 'confirmed',
      wallet: '0x1111111111111111111111111111111111111111',
      tx_hash: `0x${'a'.repeat(64)}`,
      rpc_url: 'https://private.example/key'
    } as never)

    expect(sent).toBe(true)
    expect(window.dataLayer?.at(-1)).toEqual([
      'event',
      'miner_operation',
      { operation: 'general_mint', stage: 'confirmed' }
    ])
    expect(JSON.stringify(window.dataLayer?.at(-1))).not.toMatch(/0x1111|private\.example|aaaa/)
  })

  it('stops events and removes GA cookies when consent is denied', async () => {
    const { ANALYTICS_CONSENT_KEY, createAnalyticsClient } = await loadAnalytics()
    const scripts = createScriptCapture()
    const client = createAnalyticsClient({
      measurementId: MEASUREMENT_ID,
      allowedHostname: HOSTNAME,
      hostname: HOSTNAME,
      appendTagScript: scripts.appendTagScript
    })
    const granting = client.grant()
    scripts.getScript()?.dispatchEvent(new Event('load'))
    await granting
    document.cookie = '_ga=test-client; path=/'
    document.cookie = '_ga_TEST=test-session; path=/'

    client.deny()

    expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('denied')
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${MEASUREMENT_ID}`]).toBe(
      true
    )
    expect(document.cookie).not.toContain('_ga=')
    expect(document.cookie).not.toContain('_ga_TEST=')
    expect(client.track('chain_selected', { chain: 'ethereum' })).toBe(false)

    await expect(client.grant()).resolves.toBe(true)
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${MEASUREMENT_ID}`]).toBe(
      false
    )
    expect(client.track('chain_selected', { chain: 'ethereum' })).toBe(true)
  })

  it('is unavailable for an invalid ID or a non-production hostname', async () => {
    const { createAnalyticsClient } = await loadAnalytics()

    expect(
      createAnalyticsClient({
        measurementId: 'not-a-ga-id',
        allowedHostname: HOSTNAME,
        hostname: HOSTNAME
      }).isAvailable()
    ).toBe(false)
    expect(
      createAnalyticsClient({
        measurementId: MEASUREMENT_ID,
        allowedHostname: HOSTNAME,
        hostname: '127.0.0.1'
      }).isAvailable()
    ).toBe(false)
  })

  it('never lets a broken Google tag interrupt Miner actions', async () => {
    const { createAnalyticsClient } = await loadAnalytics()
    const scripts = createScriptCapture()
    const client = createAnalyticsClient({
      measurementId: MEASUREMENT_ID,
      allowedHostname: HOSTNAME,
      hostname: HOSTNAME,
      appendTagScript: scripts.appendTagScript
    })
    const granting = client.grant()
    scripts.getScript()?.dispatchEvent(new Event('load'))
    await granting
    window.gtag = () => {
      throw new Error('extension replaced gtag')
    }

    expect(() => client.track('chain_selected', { chain: 'ethereum' })).not.toThrow()
    expect(client.track('chain_selected', { chain: 'ethereum' })).toBe(false)
    expect(() => client.deny()).not.toThrow()
  })
})
