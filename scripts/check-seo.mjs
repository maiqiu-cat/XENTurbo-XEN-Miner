import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'
import { SITE_ORIGIN, SITE_CONTENT, LOCALES, TOPICS, docPath } from './public-site.mjs'

export async function checkPublicBuild(directory = resolve('dist')) {
  const errors = []
  const documents = LOCALES.flatMap((locale) =>
    TOPICS.map((topic) => ({ locale, topic, path: docPath(locale, topic) }))
  )
  const allowed = new Set([
    'index.html',
    'robots.txt',
    'sitemap.xml',
    '404.html',
    'site-assets/docs.css',
    'site-assets/miner-preview.png',
    ...documents.map(({ path }) => path.slice(1) + 'index.html')
  ])
  async function visit(folder = '') {
    for (const item of await readdir(resolve(directory, folder), { withFileTypes: true })) {
      const path = folder + item.name
      if (item.isDirectory()) await visit(path + '/')
      else if (!item.isFile() || (!allowed.has(path) && !/^assets\/[^/]+\.(?:js|css)$/.test(path)))
        errors.push(`Unexpected public artifact: ${path}`)
    }
  }
  await visit()
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: false,
      enableCSSFileLoading: false,
      disableJavaScriptFileLoading: true
    }
  })
  const parser = new window.DOMParser()
  const load = (path) => readFile(resolve(directory, path), 'utf8')
  const require = (valid, label) => {
    if (!valid) errors.push(label)
  }
  try {
    const robots = await load('robots.txt')
    require(robots ===
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`, 'Invalid production robots policy')
    const sitemap = parser.parseFromString(await load('sitemap.xml'), 'application/xml')
    const expectedUrls = [
      `${SITE_ORIGIN}/`,
      ...documents.map(({ path }) => SITE_ORIGIN + path)
    ].sort()
    const urls = [...sitemap.querySelectorAll('loc')].map((node) => node.textContent).sort()
    require(JSON.stringify(urls) ===
      JSON.stringify(expectedUrls), 'Sitemap must contain exactly the public canonical pages')
    const image = await readFile(resolve(directory, 'site-assets/miner-preview.png'))
    require(image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
      image.length > 24 &&
      image.readUInt32BE(16) === 1200 &&
      image.readUInt32BE(20) === 630, 'Share image must be a 1200 x 630 PNG')
    const pages = [{ path: '/', locale: 'en' }, ...documents]
    for (const { path, locale, topic } of pages) {
      const html = await load(path === '/' ? 'index.html' : path.slice(1) + 'index.html')
      const doc = parser.parseFromString(html, 'text/html')
      const canonical = doc.querySelectorAll('link[rel="canonical"]')
      require(canonical.length === 1 &&
        canonical[0].getAttribute('href') === SITE_ORIGIN + path, `${path}: incorrect canonical`)
      require(doc.documentElement.lang ===
        (locale === 'en' ? 'en' : 'zh-Hant'), `${path}: incorrect language`)
      require(!!doc.title &&
        !!doc
          .querySelector('meta[name="description"]')
          ?.getAttribute('content'), `${path}: missing title or description`)
      require(!/noindex/i.test(
        doc.querySelector('meta[name="robots"]')?.getAttribute('content') ?? ''
      ), `${path}: unexpected noindex`)
      require(doc.querySelector('meta[property="og:url"]')?.getAttribute('content') ===
        SITE_ORIGIN + path, `${path}: incorrect share URL`)
      require(doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ===
        `${SITE_ORIGIN}/site-assets/miner-preview.png`, `${path}: missing share image`)
      const structured = doc.querySelectorAll('script[type="application/ld+json"]')
      require(structured.length === 1, `${path}: missing or duplicate structured data`)
      const schema = JSON.parse(structured[0]?.textContent ?? '{}')
      require(schema.url === SITE_ORIGIN + path &&
        schema['@context'] === 'https://schema.org', `${path}: incorrect structured data`)
      require(!('aggregateRating' in schema) &&
        !('offers' in schema) &&
        !('license' in schema), `${path}: unsupported review, price or license claims`)
      if (!topic) continue
      require(doc.querySelectorAll('h1').length === 1 &&
        (doc.querySelector('article')?.textContent.length ?? 0) >
          300, `${path}: incomplete static content`)
      require(doc.querySelectorAll('script:not([type="application/ld+json"]), iframe, form')
        .length === 0, `${path}: documentation must not execute scripts or accept input`)
      require(schema.dateModified === SITE_CONTENT.reviewedOn, `${path}: incorrect review date`)
      require(doc.querySelectorAll('link[rel="alternate"]').length ===
        3, `${path}: incorrect language alternates`)
      for (const alternative of ['en', 'zh-Hant', 'x-default']) {
        const target = docPath(alternative === 'zh-Hant' ? 'zh-hant' : 'en', topic)
        require(doc.querySelector(`link[hreflang="${alternative}"]`)?.getAttribute('href') ===
          SITE_ORIGIN + target, `${path}: broken ${alternative} alternate`)
      }
      for (const anchor of doc.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href')
        require(href.startsWith('#') ||
          href === '/' ||
          documents.some((item) => item.path === href) ||
          href.startsWith('https://'), `${path}: invalid link`)
      }
    }
    const notFound = parser.parseFromString(await load('404.html'), 'text/html')
    require(notFound.querySelector('meta[name="robots"]')?.getAttribute('content') ===
      'noindex', '404 page must be noindex')
    require(notFound.querySelector('link[rel="canonical"]') ===
      null, '404 must not canonicalize to the app')
  } catch (error) {
    errors.push(`Public artifact validation failed: ${error.code ?? error.name}`)
  } finally {
    await window.happyDOM.close()
  }
  return { errors, documents: documents.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkPublicBuild()
    .then(({ errors, documents }) => {
      if (errors.length) {
        console.error(errors.join('\n'))
        process.exitCode = 1
      } else
        console.log(
          `Public SEO gate passed: root, ${documents} static documents, sitemap, robots, image and artifact allowlist.`
        )
    })
    .catch(() => {
      console.error('Public SEO gate failed: build directory is not readable.')
      process.exitCode = 1
    })
}
