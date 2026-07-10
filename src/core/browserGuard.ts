export interface BrowserNavigator {
  userAgent: string
  maxTouchPoints: number
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>
    mobile?: boolean
  }
  brave?: unknown
}

export interface BrowserCheck {
  supported: boolean
  message: string
}

const EXCLUDED_CHROMIUM_UA =
  /Edg\/|EdgiOS\/|OPR\/|Opera|SamsungBrowser|DuckDuckGo|YaBrowser|Firefox\/|FxiOS\//

function isMobileEnvironment(nav: BrowserNavigator): boolean {
  if (nav.userAgentData?.mobile) return true
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(nav.userAgent)) {
    return true
  }
  // iPadOS can present a desktop Safari or Chrome user agent.
  return /Macintosh/i.test(nav.userAgent) && nav.maxTouchPoints > 1
}

function isGoogleChrome(nav: BrowserNavigator): boolean {
  if (typeof nav.brave !== 'undefined' || EXCLUDED_CHROMIUM_UA.test(nav.userAgent)) return false

  const brands = nav.userAgentData?.brands ?? []
  if (brands.some((brand) => brand.brand === 'Google Chrome')) return true

  return /Chrome\//.test(nav.userAgent)
}

function detectBrowserName(nav: BrowserNavigator): string {
  if (typeof nav.brave !== 'undefined') return 'Brave'
  if (/Edg\/|EdgiOS\//.test(nav.userAgent)) return 'Microsoft Edge'
  if (/Firefox\/|FxiOS\//.test(nav.userAgent)) return 'Firefox'
  if (/OPR\/|Opera/.test(nav.userAgent)) return 'Opera'
  if (/SamsungBrowser/.test(nav.userAgent)) return 'Samsung Browser'
  if (/Safari\//.test(nav.userAgent) && !/Chrome\/|CriOS\//.test(nav.userAgent)) return 'Safari'
  return 'this browser'
}

export function checkBrowserSupport(nav: BrowserNavigator): BrowserCheck {
  if (isMobileEnvironment(nav)) {
    return {
      supported: false,
      message: 'Mobile browsers are not supported. Open this site on a desktop or laptop with Google Chrome.'
    }
  }

  if (isGoogleChrome(nav)) return { supported: true, message: '' }

  return {
    supported: false,
    message: `XENTurbo XEN Miner requires PC Google Chrome. You are currently using ${detectBrowserName(nav)}.`
  }
}
