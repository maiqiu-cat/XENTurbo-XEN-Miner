import { describe, expect, it } from 'vitest'
import { checkBrowserSupport, type BrowserNavigator } from '../src/core/browserGuard'

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function navigatorSnapshot(overrides: Partial<BrowserNavigator> = {}): BrowserNavigator {
  return {
    userAgent: DESKTOP_CHROME_UA,
    maxTouchPoints: 0,
    userAgentData: {
      brands: [
        { brand: 'Chromium', version: '140' },
        { brand: 'Google Chrome', version: '140' }
      ],
      mobile: false
    },
    ...overrides
  }
}

describe('browser support guard', () => {
  it('allows desktop Google Chrome', () => {
    expect(checkBrowserSupport(navigatorSnapshot())).toEqual({ supported: true, message: '' })
  })

  it('blocks Microsoft Edge even though it is Chromium-based', () => {
    const result = checkBrowserSupport(
      navigatorSnapshot({
        userAgent: `${DESKTOP_CHROME_UA} Edg/140.0.0.0`,
        userAgentData: {
          brands: [
            { brand: 'Chromium', version: '140' },
            { brand: 'Microsoft Edge', version: '140' }
          ],
          mobile: false
        }
      })
    )

    expect(result.supported).toBe(false)
    expect(result.message).toContain('Microsoft Edge')
  })

  it('blocks Brave even when its brands include Google Chrome', () => {
    const result = checkBrowserSupport(navigatorSnapshot({ brave: {} }))

    expect(result.supported).toBe(false)
    expect(result.message).toContain('Brave')
  })

  it('blocks unbranded Chromium when client hints omit Google Chrome', () => {
    const result = checkBrowserSupport(
      navigatorSnapshot({
        userAgentData: {
          brands: [{ brand: 'Chromium', version: '140' }],
          mobile: false
        }
      })
    )

    expect(result.supported).toBe(false)
  })

  it('blocks Android Chrome', () => {
    const result = checkBrowserSupport(
      navigatorSnapshot({
        userAgent:
          'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
        maxTouchPoints: 5,
        userAgentData: {
          brands: [{ brand: 'Google Chrome', version: '140' }],
          mobile: true
        }
      })
    )

    expect(result.supported).toBe(false)
    expect(result.message).toContain('Mobile browsers are not supported')
  })

  it('blocks iPadOS when it presents a desktop Macintosh user agent', () => {
    const result = checkBrowserSupport(
      navigatorSnapshot({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        maxTouchPoints: 5,
        userAgentData: undefined
      })
    )

    expect(result.supported).toBe(false)
    expect(result.message).toContain('Mobile browsers are not supported')
  })
})
