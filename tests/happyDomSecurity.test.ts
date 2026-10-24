import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'

const windows: Window[] = []
const origin = 'https://happy-dom-regression.invalid'
const fixtures = new Map([
  [`${origin}/dep.json`, { body: '{"answer":42}', type: 'application/json' }],
  [`${origin}/dep.js`, { body: 'export const answer = 42;', type: 'text/javascript' }]
])

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close()
})

function createWindow(enableJavaScriptEvaluation = false) {
  const requested: string[] = []
  const unexpected: string[] = []
  const window = new Window({
    url: `${origin}/`,
    settings: {
      // Only fixed, harmless DOM markers run; external requests fail closed.
      enableJavaScriptEvaluation,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      fetch: {
        interceptor: {
          async beforeAsyncRequest({ request, window: requestWindow }) {
            requested.push(request.url)
            const fixture = fixtures.get(request.url)
            if (!fixture) {
              unexpected.push(request.url)
              throw new Error('Unexpected fixture request')
            }
            return new requestWindow.Response(fixture.body, {
              headers: { 'Content-Type': fixture.type }
            })
          },
          beforeSyncRequest({ request }) {
            unexpected.push(request.url)
            throw new Error('Synchronous network is not allowed in this fixture')
          }
        }
      }
    }
  })
  windows.push(window)
  return { window, requested, unexpected }
}

async function appendScript(window: Window, source: string, type = 'module') {
  const script = window.document.createElement('script')
  script.type = type
  script.textContent = source
  window.document.body.appendChild(script)
  await window.happyDOM.waitUntilComplete()
}

describe('Happy DOM module compiler security (GHSA-834v-8h66-3h79)', () => {
  it.each([
    ['assignment', 'document.documentElement.dataset.injected = `executed`'],
    ['function call', 'document.documentElement.toggleAttribute(`data-injected`)']
  ])('does not execute an invalid import alias containing %s', async (_name, expression) => {
    const { window, unexpected } = createWindow(true)
    await appendScript(
      window,
      `import { missing as injected = ${expression} } from './dep.json' with { type: 'json' };`
    )

    expect(window.document.documentElement.hasAttribute('data-injected')).toBe(false)
    expect(unexpected).toEqual([])
  })

  it.each([
    ['named alias', '/dep.js', "import { answer as result } from './dep.js';", 'result'],
    [
      'JSON default',
      '/dep.json',
      "import data from './dep.json' with { type: 'json' };",
      'data.answer'
    ]
  ])(
    'still executes a valid %s import through the same boundary',
    async (_name, path, source, value) => {
      const { window, requested, unexpected } = createWindow(true)
      await appendScript(
        window,
        `${source} document.documentElement.dataset.control = String(${value});`
      )

      expect(window.document.documentElement.dataset.control).toBe('42')
      expect(requested).toEqual([`${origin}${path}`])
      expect(unexpected).toEqual([])
    }
  )

  it('keeps ordinary DOM fixtures inert when JavaScript evaluation is not enabled', async () => {
    const { window, requested, unexpected } = createWindow()
    for (const type of ['text/javascript', 'module']) {
      await appendScript(window, 'document.documentElement.dataset.injected = `executed`;', type)
    }

    expect(window.document.documentElement.hasAttribute('data-injected')).toBe(false)
    expect(requested).toEqual([])
    expect(unexpected).toEqual([])
  })
})
