export const CLOUDFLARE_BEACON_URL = 'https://static.cloudflareinsights.com/beacon.min.js'
export const CLOUDFLARE_ANALYTICS_TOKEN = 'd47010c2cf564339b8ad6c17afef3e0c'

/** Loads trusted third-party measurement code with the same page privileges as the Miner. */
export function loadCloudflareAnalytics(): void {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    window.location.hostname !== 'miner.xenturbo.io'
  )
    return

  try {
    if (document.querySelector('script[data-cf-beacon]')) return
    const script = document.createElement('script')
    script.type = 'module'
    script.src = CLOUDFLARE_BEACON_URL
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: CLOUDFLARE_ANALYTICS_TOKEN }))
    document.body.appendChild(script)
  } catch {
    // Analytics must never prevent wallet initialization or mining.
  }
}
