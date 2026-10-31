import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { diagnosticError, isMainModule } from './cli-utils.mjs'
import { checkPublicBuild } from './check-seo.mjs'
import { LOCALES, TOPICS, docPath } from './public-site.mjs'

const host = '127.0.0.1'
const immutable = 'public, max-age=2592000, immutable'
const quote = (value) => `"${value.replace(/[\\"$]/g, '\\$&')}"`

async function freePort() {
  const socket = createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, host, resolve)
  })
  const port = socket.address().port
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

export async function checkNginx() {
  assert.notEqual(process.getuid?.(), 0, 'Run the permission/cache checks as a non-root user.')
  const validation = await checkPublicBuild()
  assert.deepEqual(validation.errors, [], 'Build must pass the public artifact gate first')
  const binary = process.env.NGINX_BIN || 'nginx'
  execFileSync(binary, ['-v'], { stdio: 'pipe' })
  const directory = await mkdtemp(join(tmpdir(), 'miner-nginx-'))
  let child
  let exited
  let browser
  const results = []
  const check = async (name, run) => {
    try {
      await run()
      results.push({ name, passed: true })
    } catch (error) {
      results.push({ name, passed: false, error: diagnosticError(error) })
    }
  }
  try {
    const root = join(directory, 'public')
    await cp(resolve('dist'), root, { recursive: true, errorOnExist: true })
    const security = await readFile('ops/nginx/security-headers.conf', 'utf8')
    const routes = (await readFile('ops/nginx/public-routes.conf', 'utf8')).replaceAll(
      'include /etc/nginx/snippets/xenturbo-security-headers.conf;',
      security
    )
    assert.doesNotMatch(routes, /^\s*include\s/m, 'Unexpected external Nginx include')
    const expectedHeaders = [...security.matchAll(/add_header\s+([\w-]+)\s+"([^"]*)"\s+always;/g)]
    assert.equal(expectedHeaders.length, 6, 'Expected the six existing security headers')
    const port = await freePort()
    const origin = `http://${host}:${port}`
    const logPath = join(directory, 'access.log')
    const configPath = join(directory, 'nginx.conf')
    const config = `pid ${quote(join(directory, 'nginx.pid'))};
error_log ${quote(join(directory, 'error.log'))};
events { worker_connections 64; }
http {
  log_format fixture '$request_method $uri $status';
  access_log ${quote(logPath)} fixture;
  client_body_temp_path ${quote(join(directory, 'body'))};
  proxy_temp_path ${quote(join(directory, 'proxy'))};
  fastcgi_temp_path ${quote(join(directory, 'fastcgi'))};
  uwsgi_temp_path ${quote(join(directory, 'uwsgi'))};
  scgi_temp_path ${quote(join(directory, 'scgi'))};
  types { text/html html; text/css css; application/javascript js; text/xml xml; text/plain txt; image/png png; }
  server {
    listen ${host}:${port}; server_name localhost;
    root ${quote(root)};
    ${security}
    ${routes}
  }
}`
    await writeFile(configPath, config)
    const args = ['-p', directory + '/', '-c', configPath]
    execFileSync(binary, ['-t', ...args], { stdio: 'pipe' })
    child = spawn(binary, [...args, '-g', 'daemon off; master_process off;'], { stdio: 'ignore' })
    let spawnError
    exited = new Promise((resolve) => {
      child.once('exit', resolve)
      child.once('error', (error) => {
        spawnError = error
        resolve()
      })
    })
    const request = (path, options = {}) =>
      fetch(origin + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
        ...options
      })
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError) throw spawnError
      assert.equal(child.exitCode, null, 'Isolated Nginx exited before readiness')
      try {
        await request('/')
        ready = true
        break
      } catch {
        await sleep(100)
      }
    }
    assert.ok(ready, 'Isolated Nginx did not become ready')
    const headers = (response) => {
      for (const [, name, value] of expectedHeaders)
        assert.equal(response.headers.get(name), value, `${name}: missing, changed or duplicated`)
    }
    const documents = LOCALES.flatMap((locale) => TOPICS.map((topic) => docPath(locale, topic)))
    for (const path of [
      '/',
      '/robots.txt',
      '/sitemap.xml',
      '/site-assets/docs.css',
      '/site-assets/miner-preview.png',
      ...documents
    ]) {
      await check(`GET ${path}`, async () => {
        const response = await request(path)
        assert.equal(response.status, 200)
        headers(response)
        assert.equal(response.headers.get('x-robots-tag'), null)
        assert.equal(response.headers.get('cache-control'), 'no-cache')
        const body = path.endsWith('.png') ? null : await response.text()
        if (path === '/robots.txt') {
          assert.match(response.headers.get('content-type'), /text\/plain/)
          assert.match(body, /Allow: \/\n/)
          assert.doesNotMatch(body, /Disallow/)
        } else if (path === '/sitemap.xml') {
          assert.match(response.headers.get('content-type'), /(?:application|text)\/xml/)
          assert.match(body, /<urlset\b/)
        } else if (path.endsWith('/')) {
          assert.match(response.headers.get('content-type'), /text\/html/)
          assert.doesNotMatch(body, /content="noindex/)
        }
      })
    }
    const aliases = [
      ['/index.html', '/'],
      ['/docs', '/docs/en/'],
      ['/docs/', '/docs/en/'],
      ...documents.flatMap((path) => [
        [path.slice(0, -1), path],
        [path + 'index.html', path]
      ])
    ]
    for (const [path, target] of aliases) {
      await check(`canonical redirect ${path}`, async () => {
        const response = await request(path + '?reference=one&lang=two')
        assert.equal(response.status, 301)
        headers(response)
        assert.equal(response.headers.get('cache-control'), 'no-cache')
        assert.equal(response.headers.get('x-robots-tag'), null)
        const location = new URL(response.headers.get('location'), origin)
        assert.equal(location.origin, origin)
        assert.equal(location.pathname + location.search, target + '?reference=one&lang=two')
        assert.equal((await request(location.pathname + location.search)).status, 200)
      })
    }
    // A real file proves the route allowlist blocks it, not just a missing-file 404.
    await mkdir(join(root, 'docs/reviews'), { recursive: true })
    await writeFile(join(root, 'docs/reviews/private.md'), 'Private-route regression fixture.\n')
    for (const path of [
      '/missing',
      '/docs/en/missing/',
      '/docs/reviews/private.md',
      '/assets/missing.js',
      '/site-assets/missing.png',
      '/404.html'
    ]) {
      await check(`not found ${path}`, async () => {
        const response = await request(path)
        assert.equal(response.status, 404)
        headers(response)
        assert.equal(response.headers.get('x-robots-tag'), 'noindex')
        assert.equal(response.headers.get('cache-control'), 'no-cache')
        assert.match(await response.text(), /<title>Page not found \| XENTurbo<\/title>/)
      })
    }
    await check('documentation HEAD', async () => {
      const response = await request('/docs/en/', { method: 'HEAD' })
      assert.equal(response.status, 200)
      headers(response)
      assert.equal(await response.text(), '')
    })

    // Fixtures live only in the temporary build copy, never the real build or server.
    const asset = '/assets/cache-probe.js'
    const file = join(root, asset)
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(file, 'document.body.dataset.cacheProbe = "ready";\n')
    for (const [status, options] of [
      [200, {}],
      [206, { headers: { Range: 'bytes=0-7' } }],
      [304, { headers: { 'If-None-Match': (await request(asset)).headers.get('etag') } }]
    ]) {
      await check(`asset ${status} keeps immutable cache`, async () => {
        const response = await request(asset, options)
        assert.equal(response.status, status)
        headers(response)
        assert.equal(response.headers.get('cache-control'), immutable)
        await response.arrayBuffer()
      })
    }
    await check('asset 405 is not immutable', async () => {
      const response = await request(asset, { method: 'POST' })
      assert.equal(response.status, 405)
      headers(response)
      assert.doesNotMatch(response.headers.get('cache-control') ?? '', /immutable|max-age/)
    })
    await chmod(file, 0)
    await check('asset permission-denied 403 is not immutable', async () => {
      const response = await request(asset)
      assert.equal(response.status, 403)
      headers(response)
      assert.doesNotMatch(response.headers.get('cache-control') ?? '', /immutable|max-age/)
    })
    await check(
      'real Chromium cache recovers after a 403 without changing the asset URL',
      async () => {
        const probe = '/docs/en/security/'
        await writeFile(
          join(root, probe, 'index.html'),
          `<!doctype html><html><head><title>Cache regression fixture</title></head><body><script src="${asset}" defer></script></body></html>`
        )
        browser = await chromium.launch({ headless: true, timeout: 15_000 })
        const context = await browser.newContext({ serviceWorkers: 'block' })
        // No page/context routing or CDP cache disabling: intercepted requests bypass HTTP cache.
        const count = async () =>
          (await readFile(logPath, 'utf8'))
            .split('\n')
            .filter((line) => line.startsWith(`GET ${asset} `)).length
        const first = await context.newPage()
        const denied = first.waitForResponse((response) => response.url() === origin + asset)
        await first.goto(origin + probe, { waitUntil: 'load' })
        assert.equal((await denied).status(), 403)
        assert.equal(await first.locator('body').getAttribute('data-cache-probe'), null)
        await chmod(file, 0o644)
        const before = await count()
        const second = await context.newPage()
        await second.goto(origin + probe, { waitUntil: 'load' })
        assert.equal(
          await second.locator('body').getAttribute('data-cache-probe'),
          'ready',
          'Recovered asset must execute in a new page'
        )
        assert.equal(await count(), before + 1, 'Recovered URL must be requested from Nginx')
        const warmed = await count()
        const third = await context.newPage()
        await third.goto(origin + probe, { waitUntil: 'load' })
        assert.equal(await third.locator('body').getAttribute('data-cache-probe'), 'ready')
        assert.equal(
          await count(),
          warmed,
          'Successful asset must really be served from browser cache'
        )
        await first.reload({ waitUntil: 'load' })
        assert.equal(
          await first.locator('body').getAttribute('data-cache-probe'),
          'ready',
          'The original page must also recover on reload'
        )
        await context.close()
      }
    )
    return { results }
  } finally {
    try {
      await browser?.close()
    } finally {
      if (child?.exitCode === null && child.pid) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
        try {
          await exited
        } finally {
          clearTimeout(timer)
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
}

if (isMainModule(import.meta.url)) {
  checkNginx()
    .then(({ results }) => {
      for (const result of results)
        console.log(
          `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`
        )
      const passed = results.filter((result) => result.passed).length
      console.log(
        `Local Nginx checks: ${passed}/${results.length} passed (loopback only; not production acceptance).`
      )
      if (passed !== results.length) process.exitCode = 1
    })
    .catch((error) => {
      console.error(`Local Nginx checks failed: ${diagnosticError(error)}`)
      process.exitCode = 1
    })
}
