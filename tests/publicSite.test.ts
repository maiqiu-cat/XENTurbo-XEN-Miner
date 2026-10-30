import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { CHAINS } from '../src/config/chains'
import { CONTRACTS } from '../src/config/contracts'
import { contentSecurityPolicy } from '../src/config/security'
import { checkPublicBuild } from '../scripts/check-seo.mjs'
import {
  createPublicSite,
  rootMetadata,
  publicRoute,
  publicSitePlugin,
  docPath,
  safeJson,
  escapeHtml,
  SITE_CONTENT,
  SITE_ORIGIN,
  TOPICS,
  LOCALES,
  PREVIEW_ROBOTS
} from '../scripts/public-site.mjs'

const facts = {
  version: '1.1.12',
  chains: CHAINS,
  contracts: CONTRACTS,
  headers: { 'Content-Security-Policy': contentSecurityPolicy() }
}
const files = createPublicSite(facts)
const window = new Window({
  settings: { enableJavaScriptEvaluation: false, enableCSSFileLoading: false }
})
const parse = (html: string) => new window.DOMParser().parseFromString(html, 'text/html')
const temporary: string[] = []
afterAll(() => window.happyDOM.close())
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('allowlisted static public documents', () => {
  it('outputs exactly ten documents and four support files, never repository directories', () => {
    expect(files.size).toBe(14)
    expect([...files.keys()].filter((path) => path.endsWith('/'))).toHaveLength(10)
    expect([...files.keys()].join('\n')).not.toMatch(/backups|reviews|superpowers|\.env|DEPLOY/)
  })
  for (const locale of LOCALES)
    for (const topic of TOPICS) {
      it(`${locale}/${topic} contains complete static, translated and self-canonical content`, () => {
        const path = docPath(locale, topic)
        const doc = parse(files.get(path)!.body)
        expect(doc.documentElement.lang).toBe(locale === 'en' ? 'en' : 'zh-Hant')
        expect(doc.querySelectorAll('h1')).toHaveLength(1)
        expect(doc.querySelector('h1')?.textContent).toBe(SITE_CONTENT[locale].topics[topic].title)
        expect(doc.querySelector('article')!.textContent.length).toBeGreaterThan(300)
        expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
          SITE_ORIGIN + path
        )
        const schema = JSON.parse(doc.querySelector('script')!.textContent)
        expect(schema.dateModified).toBe('2026-10-30')
        expect(schema.citation).toContain('/tree/v1.1.12')
        expect(doc.querySelectorAll('script:not([type="application/ld+json"])')).toHaveLength(0)
        expect(doc.querySelectorAll('link[rel="alternate"]')).toHaveLength(3)
        for (const alternate of LOCALES)
          expect(
            doc
              .querySelector(`link[hreflang="${alternate === 'en' ? 'en' : 'zh-Hant'}"]`)
              ?.getAttribute('href')
          ).toBe(SITE_ORIGIN + docPath(alternate, topic))
        expect(doc.querySelectorAll('form, iframe')).toHaveLength(0)
      })
    }
  it('uses the same configured contract addresses, not manually maintained copies', () => {
    const doc = parse(files.get('/docs/en/')!.body)
    for (const chain of ['eth', 'polygon'] as const)
      for (const address of Object.values(CONTRACTS[chain])) {
        expect(
          doc.querySelector(`a[href="${CHAINS[chain].blockExplorerUrl}/address/${address}"]`)
        ).not.toBeNull()
      }
  })
  it('retains explicit safety limits in both languages without promising complete security', () => {
    for (const locale of LOCALES) {
      const text = files.get(docPath(locale, 'security'))!.body
      expect(text).toContain('P2-C')
      expect(text).toContain(
        locale === 'en' ? 'has no automatic in-app deletion path' : '沒有可自動刪除'
      )
    }
  })
  it('escapes text and structured data rather than accepting markup from content', () => {
    expect(escapeHtml(`<script a="'">&`)).toBe('&lt;script a=&quot;&#39;&quot;&gt;&amp;')
    const input = { text: '</script><img src=x onerror=alert(1)>\u2028\u2029' }
    expect(safeJson(input)).not.toContain('<')
    expect(JSON.parse(safeJson(input))).toEqual(input)
  })
  it('rejects invalid version, paths and contract metadata', () => {
    expect(() => rootMetadata('not-a-version')).toThrow('Invalid public version')
    expect(() => docPath('../private')).toThrow('Unknown public document')
    expect(() => docPath('en', '../private')).toThrow('Unknown public document')
    expect(() =>
      createPublicSite({
        ...facts,
        contracts: { ...CONTRACTS, eth: { ...CONTRACTS.eth, factory: '<unsafe>' } }
      })
    ).toThrow('Invalid public contract address')
    expect(() =>
      createPublicSite({
        ...facts,
        chains: { ...CHAINS, eth: { ...CHAINS.eth, blockExplorerUrl: 'http://example.invalid' } }
      })
    ).toThrow('Unsafe explorer URL')
  })
  it('does not invent ratings, price, license, root language URLs or a new training-bot policy', () => {
    const doc = parse(rootMetadata(facts.version))
    expect(doc.querySelectorAll('link[rel="alternate"]')).toHaveLength(0)
    const schema = JSON.parse(doc.querySelector('script')!.textContent)
    expect(schema.softwareVersion).toBe(facts.version)
    for (const name of ['aggregateRating', 'offers', 'license'])
      expect(schema).not.toHaveProperty(name)
    expect(files.get('/robots.txt')!.body).not.toMatch(/GPTBot|Google-Extended/)
  })
})

describe('public routes and preview isolation', () => {
  it.each([
    '/docs/en/',
    '/docs/zh-hant/security/',
    '/robots.txt',
    '/sitemap.xml',
    '/site-assets/docs.css'
  ])('serves %s with its own content type', (path) => {
    expect(publicRoute(path, files)).toEqual({ status: 200, file: files.get(path) })
  })
  it.each([
    ['/index.html?utm_source=test', '/?utm_source=test'],
    ['/docs', '/docs/en/'],
    ['/docs/', '/docs/en/'],
    ['/docs/en', '/docs/en/'],
    ['/docs/zh-hant/security/index.html', '/docs/zh-hant/security/']
  ])('canonicalizes only the known alias %s', (from, to) => {
    expect(publicRoute(from, files)).toEqual({ status: 301, location: to })
  })
  it.each(['/missing', '/docs/reviews/private.md', '/docs/en/missing', '/404.html', '/%2eenv'])(
    'does not turn %s into a successful app response',
    (path) => {
      const result = publicRoute(path, files)
      expect(result.status).toBe(404)
      expect(
        parse(result.file!.body).querySelector('meta[name="robots"]')?.getAttribute('content')
      ).toBe('noindex')
    }
  )
  it('adds restrictive preview headers and robots without altering production artifacts', () => {
    const plugin = publicSitePlugin(facts) as any
    let middleware: any
    plugin.configurePreviewServer({
      config: { root: process.cwd(), build: { outDir: 'dist' } },
      middlewares: {
        use: (fn: any) => {
          middleware = fn
        }
      }
    })
    for (const method of ['GET', 'HEAD', 'POST']) {
      const headers = new Map()
      let body
      const response = {
        statusCode: 0,
        setHeader: (key: string, value: string) => headers.set(key, value),
        end: (value: unknown) => {
          body = value
        }
      }
      middleware({ url: '/robots.txt', method }, response, () => {
        throw new Error('Unexpected fallback')
      })
      expect(headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
      expect(headers.get('Content-Security-Policy')).toBe(contentSecurityPolicy())
      expect(response.statusCode).toBe(method === 'POST' ? 405 : 200)
      expect(body).toBe(method === 'GET' ? PREVIEW_ROBOTS : undefined)
    }
    expect(files.get('/robots.txt')!.body).toContain('Allow: /')
  })
})

async function fixtureBuild() {
  const directory = await mkdtemp(join(tmpdir(), 'miner-public-site-'))
  temporary.push(directory)
  for (const [path, file] of files) {
    const target = join(directory, path + (path.endsWith('/') ? 'index.html' : ''))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.body)
  }
  await writeFile(
    join(directory, 'index.html'),
    `<!doctype html><html lang="en"><head><title>XENTurbo XEN Miner</title>${rootMetadata(facts.version)}</head><body><div id="app"></div></body></html>`
  )
  await writeFile(
    join(directory, 'site-assets/miner-preview.png'),
    await readFile('public/site-assets/miner-preview.png')
  )
  return directory
}

describe('built SEO release gate', () => {
  it('passes a complete allowlisted build', async () => {
    expect(await checkPublicBuild(await fixtureBuild())).toEqual({ errors: [], documents: 10 })
  })
  it.each([
    'noindex',
    'canonical',
    'language',
    'script',
    'sitemap',
    'artifact',
    'robots',
    'json',
    'image',
    'missing'
  ])('fails closed for a %s regression', async (kind) => {
    const directory = await fixtureBuild()
    const page = join(directory, 'docs/en/security/index.html')
    const html = await readFile(page, 'utf8')
    if (kind === 'noindex')
      await writeFile(
        page,
        html.replace('</head>', '<meta name="robots" content="noindex"></head>')
      )
    if (kind === 'canonical')
      await writeFile(page, html.replace('rel="canonical"', 'rel="invalid"'))
    if (kind === 'language') await writeFile(page, html.replace('lang="en"', 'lang="zh-Hant"'))
    if (kind === 'script')
      await writeFile(
        page,
        html.replace('</body>', '<script src="/assets/app.js"></script></body>')
      )
    if (kind === 'json') await writeFile(page, html.replace('"@context"', 'invalid-json'))
    if (kind === 'sitemap')
      await writeFile(join(directory, 'sitemap.xml'), '<html>Not a sitemap</html>')
    if (kind === 'robots') await writeFile(join(directory, 'robots.txt'), PREVIEW_ROBOTS)
    if (kind === 'artifact')
      await writeFile(join(directory, 'private-notes.txt'), 'must not publish')
    if (kind === 'image')
      await writeFile(join(directory, 'site-assets/miner-preview.png'), 'not an image')
    if (kind === 'missing') await rm(page)
    expect((await checkPublicBuild(directory)).errors.length).toBeGreaterThan(0)
  })
})
