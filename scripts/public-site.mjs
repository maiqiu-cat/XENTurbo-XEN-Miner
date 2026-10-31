import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const SITE_ORIGIN = 'https://miner.xenturbo.io'
export const REPOSITORY = 'https://github.com/maiqiu-cat/XENTurbo-XEN-Miner'
export const LOCALES = ['en', 'zh-hant']
export const TOPICS = ['overview', 'operations', 'rpc-and-pending', 'security', 'versions']
export const SITE_CONTENT = JSON.parse(
  readFileSync(new URL('../site/content.json', import.meta.url), 'utf8')
)
export const PREVIEW_ROBOTS = 'User-agent: *\nDisallow: /\n'
const DOCS_CSS = readFileSync(new URL('../site/docs.css', import.meta.url), 'utf8')
const IMAGE = '/site-assets/miner-preview.png'

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  )
}

export function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function docPath(locale, topic = 'overview') {
  if (!LOCALES.includes(locale) || !TOPICS.includes(topic))
    throw new Error('Unknown public document')
  return `/docs/${locale}/${topic === 'overview' ? '' : `${topic}/`}`
}

function link(href, label) {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
}

function meta(name, content, property = false) {
  return `<meta ${property ? 'property' : 'name'}="${name}" content="${escapeHtml(content)}">`
}

function metadata({ title, description, path, locale = 'en', topic, schema }) {
  const canonical = SITE_ORIGIN + path
  return [
    meta('description', description),
    `<link rel="canonical" href="${canonical}">`,
    meta('og:type', 'website', true),
    meta('og:site_name', 'XENTurbo XEN Miner', true),
    meta('og:title', title, true),
    meta('og:description', description, true),
    meta('og:url', canonical, true),
    meta('og:locale', locale === 'en' ? 'en_US' : 'zh_TW', true),
    meta('og:image', SITE_ORIGIN + IMAGE, true),
    meta('og:image:width', '1200', true),
    meta('og:image:height', '630', true),
    meta('og:image:alt', SITE_CONTENT[locale].previewAlt, true),
    meta('twitter:card', 'summary_large_image'),
    meta('twitter:title', title),
    meta('twitter:description', description),
    meta('twitter:image', SITE_ORIGIN + IMAGE),
    ...(topic
      ? [
          ...LOCALES.map(
            (language) =>
              `<link rel="alternate" hreflang="${language === 'en' ? 'en' : 'zh-Hant'}" href="${SITE_ORIGIN}${docPath(language, topic)}">`
          ),
          `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${docPath('en', topic)}">`
        ]
      : []),
    `<script type="application/ld+json">${safeJson(schema)}</script>`
  ].join('\n')
}

export function rootMetadata(version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid public version')
  return metadata({
    title: 'XENTurbo XEN Miner',
    description: SITE_CONTENT.en.topics.overview.description,
    path: '/',
    schema: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      '@id': `${SITE_ORIGIN}/#app`,
      name: 'XENTurbo XEN Miner',
      url: `${SITE_ORIGIN}/`,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Desktop',
      browserRequirements: 'Google Chrome and an injected EIP-1193 wallet',
      softwareVersion: version,
      inLanguage: ['en', 'zh-Hant'],
      sameAs: REPOSITORY
    }
  })
}

function contractSection(locale, chains, contracts) {
  const text = SITE_CONTENT[locale]
  return `<section><h2>${escapeHtml(text.contracts)}</h2>${['eth', 'polygon']
    .map((key) => {
      const chain = chains[key]
      const addresses = contracts[key]
      if (!chain || !addresses) throw new Error('Missing public chain configuration')
      const explorer = new URL(chain.blockExplorerUrl)
      if (explorer.protocol !== 'https:' || explorer.username || explorer.password)
        throw new Error('Unsafe explorer URL')
      return `<h3>${escapeHtml(chain.name)} (chain ID ${escapeHtml(chain.chainId)})</h3><ul class="addresses">${[
        'factory',
        'xenCrypto',
        'vmuTemplate',
        'multicall3'
      ]
        .map((name) => {
          const address = addresses[name]
          if (!/^0x[0-9a-fA-F]{40}$/.test(address))
            throw new Error('Invalid public contract address')
          return `<li>${name}: ${link(`${explorer.origin}/address/${address}`, address)}</li>`
        })
        .join('')}</ul>`
    })
    .join('')}</section>`
}

function renderDocument(locale, topic, facts) {
  const text = SITE_CONTENT[locale]
  const doc = text.topics[topic]
  const title =
    topic === 'overview' ? `${doc.title} | ${text.documentation}` : `${doc.title} | XENTurbo`
  const path = docPath(locale, topic)
  const language = locale === 'en' ? 'en' : 'zh-Hant'
  const alternate = locale === 'en' ? 'zh-hant' : 'en'
  const source = `${REPOSITORY}/tree/v${SITE_CONTENT.reviewedVersion}`
  const header = metadata({
    title,
    description: doc.description,
    path,
    locale,
    topic,
    schema: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': SITE_ORIGIN + path,
      url: SITE_ORIGIN + path,
      name: title,
      description: doc.description,
      inLanguage: language,
      dateModified: SITE_CONTENT.reviewedOn,
      about: { '@id': `${SITE_ORIGIN}/#app` },
      citation: source
    }
  })
  return `<!doctype html>
<html lang="${language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>${header}<link rel="stylesheet" href="/site-assets/docs.css"></head>
<body><a class="skip-link" href="#content">${locale === 'en' ? 'Skip to content' : '跳至內容'}</a>
<header><a class="brand" href="${docPath(locale)}">XENTurbo XEN Miner</a><nav class="utility" aria-label="${text.documentation}">${link('/', text.openMiner)}${link(docPath(alternate, topic), SITE_CONTENT[alternate].language)}${link(REPOSITORY, 'GitHub')}</nav></header>
<main class="layout"><nav class="topics" aria-label="${text.documentation}"><ul>${TOPICS.map((item) => `<li><a href="${docPath(locale, item)}"${item === topic ? ' aria-current="page"' : ''}>${escapeHtml(text.topics[item].title)}</a></li>`).join('')}</ul></nav>
<article id="content"><h1>${escapeHtml(doc.title)}</h1><p class="summary">${escapeHtml(doc.description)}</p>
<p class="review-date">${text.reviewed}: <time datetime="${SITE_CONTENT.reviewedOn}">${SITE_CONTENT.reviewedOn}</time> · ${text.documentedVersion}: v${SITE_CONTENT.reviewedVersion} · ${link(source, text.source)}</p>
${topic === 'overview' ? `<figure><img src="${IMAGE}" alt="${text.previewAlt}" width="1200" height="630" loading="lazy" decoding="async"><figcaption>${text.previewAlt}</figcaption></figure>` : ''}
${doc.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${(section.paragraphs ?? []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}${section.items ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</section>`).join('')}
${['security', 'versions'].includes(topic) ? `<p>${link(`${REPOSITORY}/blob/v${SITE_CONTENT.reviewedVersion}/README.md#pr-7-validation-scope`, 'README')}</p>` : ''}
${topic === 'overview' ? contractSection(locale, facts.chains, facts.contracts) : ''}
</article></main><footer>Copyright 2026 · ${link(`${SITE_ORIGIN}/`, 'Miner.XENTurbo.io')} · ${link(REPOSITORY, 'GitHub')}</footer></body></html>`
}

export function createPublicSite(facts) {
  rootMetadata(facts.version)
  const files = new Map()
  const add = (path, body, type) => files.set(path, { body, type })
  for (const locale of LOCALES) {
    for (const topic of TOPICS)
      add(docPath(locale, topic), renderDocument(locale, topic, facts), 'text/html; charset=utf-8')
  }
  add('/site-assets/docs.css', DOCS_CSS, 'text/css; charset=utf-8')
  add(
    '/robots.txt',
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    'text/plain; charset=utf-8'
  )
  const paths = ['/', ...LOCALES.flatMap((locale) => TOPICS.map((topic) => docPath(locale, topic)))]
  add(
    '/sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${SITE_ORIGIN}${path}</loc>${path === '/' ? '' : `<lastmod>${SITE_CONTENT.reviewedOn}</lastmod>`}</url>`).join('')}</urlset>\n`,
    'application/xml; charset=utf-8'
  )
  add(
    '/404.html',
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Page not found | XENTurbo</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/site-assets/docs.css"></head><body><main class="not-found"><h1>Page not found</h1><p>This address does not exist.</p><p lang="zh-Hant">此網址不存在。</p><p>${link('/', 'XENTurbo XEN Miner')}</p><p>${link('/docs/en/', 'Documentation')} · ${link('/docs/zh-hant/', '使用文件')}</p></main></body></html>`,
    'text/html; charset=utf-8'
  )
  return files
}

export function publicRoute(url, files) {
  let path
  let search
  try {
    ;({ pathname: path, search } = new URL(url, SITE_ORIGIN))
  } catch {
    return { status: 400 }
  }
  if (path === '/index.html') return { status: 301, location: '/' + search }
  if (path === '/docs' || path === '/docs/') return { status: 301, location: '/docs/en/' + search }
  // Only known documents have aliases. Unknown paths never fall back to the app.
  for (const target of files.keys()) {
    if (!target.endsWith('/')) continue
    if (path === target.slice(0, -1) || path === `${target}index.html`)
      return { status: 301, location: target + search }
  }
  if (files.has(path)) return { status: path === '/404.html' ? 404 : 200, file: files.get(path) }
  return { status: 404, file: files.get('/404.html') }
}

export function publicSitePlugin(facts) {
  const files = createPublicSite(facts)
  function middleware(isDev, outputDirectory) {
    return (request, response, next) => {
      let pathname
      try {
        pathname = new URL(request.url || '/', SITE_ORIGIN).pathname
      } catch {
        response.statusCode = 400
        return response.end()
      }
      for (const [name, value] of Object.entries(facts.headers ?? {}))
        response.setHeader(name, value)
      response.setHeader('X-Robots-Tag', 'noindex, nofollow')
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405
        response.setHeader('Allow', 'GET, HEAD')
        return response.end()
      }
      if (
        pathname === '/' ||
        pathname.startsWith('/assets/') ||
        pathname === IMAGE ||
        (isDev && /^\/(?:@|src\/|node_modules\/)/.test(pathname))
      )
        return next()
      const result = publicRoute(request.url || '/', files)
      response.statusCode = result.status
      response.setHeader('Cache-Control', 'no-cache')
      if (result.location) response.setHeader('Location', result.location)
      if (result.file) response.setHeader('Content-Type', result.file.type)
      let body = pathname === '/robots.txt' ? PREVIEW_ROBOTS : result.file?.body
      if (!isDev && result.file && pathname !== '/robots.txt') {
        const assetPath = result.status === 404 ? '/404.html' : pathname
        try {
          body = readFileSync(
            resolve(
              outputDirectory,
              assetPath.slice(1) + (assetPath.endsWith('/') ? 'index.html' : '')
            ),
            'utf8'
          )
        } catch {
          response.statusCode = 404
          response.setHeader('Content-Type', 'text/plain; charset=utf-8')
          body = 'Not found'
        }
      }
      response.end(request.method === 'HEAD' ? undefined : body)
    }
  }
  return {
    name: 'xenturbo-public-documents',
    transformIndexHtml(html, context) {
      if (context.path !== '/index.html' && context.path !== '/') return html
      return html.replace('</head>', `${rootMetadata(facts.version)}\n</head>`)
    },
    generateBundle() {
      for (const [path, { body }] of files) {
        const fileName = path.slice(1) + (path.endsWith('/') ? 'index.html' : '')
        this.emitFile({ type: 'asset', fileName, source: body })
      }
    },
    configureServer(server) {
      server.middlewares.use(middleware(true))
    },
    configurePreviewServer(server) {
      server.middlewares.use(
        middleware(false, resolve(server.config.root, server.config.build.outDir))
      )
    }
  }
}
