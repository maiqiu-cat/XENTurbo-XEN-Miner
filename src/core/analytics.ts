export const ANALYTICS_CONSENT_KEY = 'xenturbo.analytics-consent.v1'

export type AnalyticsConsent = 'granted' | 'denied'

export interface AnalyticsEventPayloads {
  browser_guard_shown: { reason: 'mobile' | 'non_chrome' }
  wallet_connect_result: { result: 'success' | 'rejected' | 'no_wallet' | 'error' }
  chain_selected: { chain: 'ethereum' | 'polygon' }
  rpc_health_state: { state: 'healthy' | 'degraded' | 'unavailable' }
  miner_operation: {
    operation: 'general_mint' | 'create_empty_slot' | 'mint_empty_slot' | 'claim' | 'claim_reuse'
    stage: 'prepared' | 'wallet_opened' | 'submitted' | 'confirmed' | 'failed'
  }
}

export type AnalyticsEventName = keyof AnalyticsEventPayloads

interface AnalyticsClientConfig {
  measurementId?: string
  allowedHostname?: string
  /** Explicit hostname keeps the client deterministic in tests. */
  hostname?: string
  appendTagScript?: (script: HTMLScriptElement) => void
}

const EVENT_VALUES = {
  browser_guard_shown: { reason: ['mobile', 'non_chrome'] },
  wallet_connect_result: { result: ['success', 'rejected', 'no_wallet', 'error'] },
  chain_selected: { chain: ['ethereum', 'polygon'] },
  rpc_health_state: { state: ['healthy', 'degraded', 'unavailable'] },
  miner_operation: {
    operation: ['general_mint', 'create_empty_slot', 'mint_empty_slot', 'claim', 'claim_reuse'],
    stage: ['prepared', 'wallet_opened', 'submitted', 'confirmed', 'failed']
  }
} as const satisfies {
  [K in AnalyticsEventName]: {
    [P in keyof AnalyticsEventPayloads[K]]: readonly AnalyticsEventPayloads[K][P][]
  }
}

const DEFAULT_CONSENT = {
  ad_personalization: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  analytics_storage: 'denied'
} as const

const GRANTED_ANALYTICS_CONSENT = {
  ...DEFAULT_CONSENT,
  analytics_storage: 'granted'
} as const

const TAG_CONFIG = {
  allow_ad_personalization_signals: false,
  allow_google_signals: false,
  send_page_view: true
} as const

function currentHostname(): string {
  return typeof window === 'undefined' ? '' : window.location.hostname
}

function readStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function queueGtag(...args: unknown[]): void {
  window.dataLayer ??= []
  window.dataLayer.push(args)
}

function removeAnalyticsCookies(hostname: string): void {
  if (typeof document === 'undefined') return
  const cookieNames = document.cookie
    .split(';')
    .map((entry) => entry.split('=')[0]?.trim())
    .filter((name): name is string => Boolean(name && (name === '_ga' || name.startsWith('_ga_'))))

  const parts = hostname.split('.')
  const parentDomain = parts.length >= 2 ? parts.slice(-2).join('.') : hostname
  const domains = new Set(['', hostname, `.${hostname}`, parentDomain, `.${parentDomain}`])

  for (const name of cookieNames) {
    for (const domain of domains) {
      const domainPart = domain ? `; domain=${domain}` : ''
      document.cookie = `${name}=; Max-Age=0; path=/${domainPart}; SameSite=Lax; Secure`
    }
  }
}

function sanitizeEvent<K extends AnalyticsEventName>(
  name: K,
  payload: AnalyticsEventPayloads[K]
): Record<string, string> | null {
  const input = payload as Record<string, unknown>
  const schema = EVENT_VALUES[name] as Record<string, readonly string[]>
  const clean: Record<string, string> = {}

  for (const [key, allowedValues] of Object.entries(schema)) {
    const value = input[key]
    if (typeof value !== 'string' || !allowedValues.includes(value)) return null
    clean[key] = value
  }
  return clean
}

export function createAnalyticsClient(config: AnalyticsClientConfig) {
  const measurementId = config.measurementId?.trim() ?? ''
  const allowedHostname = config.allowedHostname?.trim().toLowerCase() ?? ''
  const hostname = (config.hostname ?? currentHostname()).toLowerCase()
  const validConfig =
    Boolean(allowedHostname) && /^G-[A-Z0-9]+$/i.test(measurementId) && hostname === allowedHostname
  let configured = false
  let consentDefaultQueued = false
  let loadPromise: Promise<boolean> | null = null

  const setDisabled = (disabled: boolean) => {
    if (typeof window !== 'undefined' && measurementId) {
      ;(window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] = disabled
    }
  }

  const setConsent = (consent: AnalyticsConsent) => {
    try {
      readStorage()?.setItem(ANALYTICS_CONSENT_KEY, consent)
    } catch {
      // Storage may be disabled; analytics remains optional and must not affect the Miner.
    }
  }

  const ensureQueue = () => {
    window.dataLayer ??= []
    window.gtag ??= queueGtag
    if (!consentDefaultQueued) {
      window.gtag('consent', 'default', DEFAULT_CONSENT)
      consentDefaultQueued = true
    }
  }

  const configureLoadedTag = () => {
    ensureQueue()
    window.gtag?.('consent', 'update', GRANTED_ANALYTICS_CONSENT)
    window.gtag?.('js', new Date())
    window.gtag?.('config', measurementId, TAG_CONFIG)
    configured = true
  }

  const load = (): Promise<boolean> => {
    if (!validConfig || typeof document === 'undefined' || typeof window === 'undefined') {
      return Promise.resolve(false)
    }
    if (configured) {
      ensureQueue()
      setDisabled(false)
      window.gtag?.('consent', 'update', GRANTED_ANALYTICS_CONSENT)
      return Promise.resolve(true)
    }
    if (loadPromise) return loadPromise

    ensureQueue()
    setDisabled(false)
    loadPromise = new Promise<boolean>((resolve, reject) => {
      const script = document.createElement('script')
      script.async = true
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`
      script.dataset.xenturboGa = measurementId
      script.addEventListener(
        'load',
        () => {
          try {
            configureLoadedTag()
            resolve(true)
          } catch {
            script.remove()
            loadPromise = null
            reject(new Error('Google Analytics could not be configured'))
          }
        },
        { once: true }
      )
      script.addEventListener(
        'error',
        () => {
          script.remove()
          loadPromise = null
          reject(new Error('Google Analytics could not be loaded'))
        },
        { once: true }
      )
      const appendTagScript = config.appendTagScript ?? ((tag) => document.head.append(tag))
      appendTagScript(script)
    })
    return loadPromise
  }

  return {
    isAvailable(): boolean {
      return validConfig
    },

    getConsent(): AnalyticsConsent | null {
      if (!validConfig) return null
      try {
        const value = readStorage()?.getItem(ANALYTICS_CONSENT_KEY)
        return value === 'granted' || value === 'denied' ? value : null
      } catch {
        return null
      }
    },

    async initialize(): Promise<boolean> {
      return this.getConsent() === 'granted' ? load() : false
    },

    grant(): Promise<boolean> {
      if (!validConfig) return Promise.resolve(false)
      setConsent('granted')
      return load()
    },

    deny(): void {
      if (!validConfig) return
      setConsent('denied')
      setDisabled(true)
      try {
        if (typeof window !== 'undefined' && window.gtag) {
          window.gtag('consent', 'update', DEFAULT_CONSENT)
        }
      } catch {
        // Analytics is optional; revocation must still complete if a tag or extension misbehaves.
      }
      removeAnalyticsCookies(hostname)
    },

    track<K extends AnalyticsEventName>(name: K, payload: AnalyticsEventPayloads[K]): boolean {
      try {
        if (
          !validConfig ||
          !configured ||
          typeof window === 'undefined' ||
          this.getConsent() !== 'granted' ||
          !window.gtag
        ) {
          return false
        }
        const clean = sanitizeEvent(name, payload)
        if (!clean) return false
        window.gtag('event', name, clean)
        return true
      } catch {
        return false
      }
    }
  }
}

export const analytics = createAnalyticsClient({
  measurementId: import.meta.env.VITE_GA_MEASUREMENT_ID,
  allowedHostname: import.meta.env.VITE_GA_ALLOWED_HOSTNAME
})

export function trackAnalyticsEvent<K extends AnalyticsEventName>(
  name: K,
  payload: AnalyticsEventPayloads[K]
): boolean {
  return analytics.track(name, payload)
}
