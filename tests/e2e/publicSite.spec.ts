import { expect, test } from '@playwright/test'
import { SITE_ORIGIN, SITE_CONTENT, LOCALES, TOPICS, docPath } from '../../scripts/public-site.mjs'

test.describe('static documentation without JavaScript', () => {
  test.use({ javaScriptEnabled: false })
  for (const locale of LOCALES)
    for (const topic of TOPICS) {
      test(`${locale}/${topic} is readable and has reciprocal language links`, async ({ page }) => {
        const requests: string[] = []
        page.on('request', (request) => requests.push(request.url()))
        const response = await page.goto(docPath(locale, topic))
        expect(response?.status()).toBe(200)
        expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow')
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          SITE_CONTENT[locale].topics[topic].title
        )
        await expect(page.locator('article section')).toHaveCount(
          topic === 'overview' || topic === 'rpc-and-pending' ? 4 : 3
        )
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          'href',
          SITE_ORIGIN + docPath(locale, topic)
        )
        await expect(page.getByRole('alertdialog')).toHaveCount(0)
        const other = locale === 'en' ? 'zh-hant' : 'en'
        await page.getByRole('link', { name: SITE_CONTENT[other].language, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(docPath(other, topic) + '$'))
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          SITE_CONTENT[other].topics[topic].title
        )
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute(
          'lang',
          other === 'en' ? 'en' : 'zh-Hant'
        )
        expect(
          requests.filter(
            (url) => !url.startsWith('http://127.0.0.1:') || /\/assets\/.*\.js(?:\?|$)/.test(url)
          )
        ).toEqual([])
      })
    }
})

for (const width of [390, 1440, 1920])
  for (const locale of LOCALES) {
    test(`documentation is isolated and fits ${width}px in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const failures: string[] = []
      const posts: string[] = []
      page.on('pageerror', (error) => failures.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text())
      })
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(request.url())
      })
      await page.addInitScript(() => {
        localStorage.setItem('xenturbo.language.v1', 'zh-Hant')
        localStorage.setItem('seo-test-pending-sentinel', 'keep')
        Object.defineProperty(window, 'ethereum', {
          get() {
            throw new Error('Documentation touched the wallet')
          }
        })
      })
      const response = await page.goto(docPath(locale))
      await expect(page.locator('article img')).toBeVisible()
      await expect
        .poll(() =>
          page.locator('article img').evaluate((image) => (image as HTMLImageElement).naturalWidth)
        )
        .toBe(1200)
      expect(response?.headers()['content-security-policy']).toContain(
        "script-src 'self' https://static.cloudflareinsights.com"
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      expect(await page.evaluate(() => localStorage.getItem('xenturbo.language.v1'))).toBe(
        'zh-Hant'
      )
      expect(await page.evaluate(() => localStorage.getItem('seo-test-pending-sentinel'))).toBe(
        'keep'
      )
      await expect(page.locator('script:not([type="application/ld+json"])')).toHaveCount(0)
      expect(failures).toEqual([])
      expect(posts).toEqual([])
      const directory = process.env.XENTURBO_QA_SCREENSHOT_DIR
      if (directory)
        await page.screenshot({ path: `${directory}/docs-${locale}-${width}.png`, fullPage: true })
    })
  }

test('root metadata is present in the initial HTML without changing the app title', async ({
  request
}) => {
  const response = await request.get('/')
  expect(response.status()).toBe(200)
  const html = await response.text()
  expect(html).toContain('<title>XENTurbo XEN Miner</title>')
  expect(html).toContain('<link rel="canonical" href="https://miner.xenturbo.io/">')
  expect(html).toContain('name="description"')
  expect(html).toContain('property="og:image"')
  expect(html).toContain('application/ld+json')
  expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow')
})

test('preview serves robots, XML, canonical redirects and real 404s', async ({ request }) => {
  const robots = await request.get('/robots.txt')
  expect(robots.headers()['content-type']).toContain('text/plain')
  expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n')
  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.headers()['content-type']).toContain('application/xml')
  expect((await sitemap.text()).match(/<loc>/g)).toHaveLength(11)
  for (const path of [
    '/missing-document',
    '/docs/en/missing/',
    '/docs/reviews/private.md',
    '/assets/missing.js'
  ]) {
    const response = await request.get(path)
    expect(response.status()).toBe(404)
  }
  for (const [path, target] of [
    ['/docs', '/docs/en/'],
    ['/docs/zh-hant/security', '/docs/zh-hant/security/'],
    ['/docs/en/index.html', '/docs/en/'],
    ['/index.html?source=test', '/?source=test']
  ]) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(301)
    expect(response.headers().location).toBe(target)
    expect((await request.get(target)).status()).toBe(200)
  }
  expect((await request.head('/docs/en/')).status()).toBe(200)
  expect((await request.post('/docs/en/')).status()).toBe(405)
})
