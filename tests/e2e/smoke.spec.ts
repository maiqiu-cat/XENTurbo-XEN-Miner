import { expect, test, type Page, type Route } from '@playwright/test'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'
const ZERO_HASH = `0x${'0'.repeat(64)}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface WalletMockStats {
  sendAttempts: number
  successfulBroadcasts: number
}

declare global {
  interface Window {
    __walletMock: {
      emitAccounts(accounts: string[]): void
      emitChain(chainId: string): void
      stats(): WalletMockStats
    }
  }
}

function blockResult(chainId: number) {
  return {
    hash: ZERO_HASH,
    parentHash: ZERO_HASH,
    number: '0x1',
    timestamp: '0x1',
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    miner: ZERO_ADDRESS,
    extraData: '0x',
    transactions: [],
    baseFeePerGas: '0x3b9aca00',
    chainId: `0x${chainId.toString(16)}`
  }
}

function rpcResult(method: string, chainId: number): unknown {
  switch (method) {
    case 'eth_chainId':
      return `0x${chainId.toString(16)}`
    case 'net_version':
      return String(chainId)
    case 'eth_blockNumber':
      return '0x1'
    case 'eth_getTransactionCount':
      return '0x0'
    case 'eth_getCode':
      return '0x'
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00'
    case 'eth_feeHistory':
      return {
        oldestBlock: '0x1',
        baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
        gasUsedRatio: [0],
        reward: [['0x3b9aca00']]
      }
    case 'eth_getBlockByNumber':
      return blockResult(chainId)
    case 'eth_call':
      return `0x${'0'.repeat(64)}`
    case 'eth_estimateGas':
      return '0x4c4b40'
    case 'eth_getLogs':
      return []
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return null
    default:
      throw new Error(`Unhandled mocked RPC method: ${method}`)
  }
}

async function handleRpcRoute(route: Route): Promise<void> {
  const request = route.request()
  const chainId = new URL(request.url()).pathname.endsWith('/polygon') ? 137 : 1
  const payload = request.postDataJSON() as
    | { id: number; method: string }
    | Array<{ id: number; method: string }>
  const requests = Array.isArray(payload) ? payload : [payload]
  const replies = requests.map(({ id, method }) => ({
    jsonrpc: '2.0',
    id,
    result: rpcResult(method, chainId)
  }))

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(payload) ? replies : replies[0])
  })
}

async function mockSameOriginRpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'sm.customRpc',
      JSON.stringify({
        eth: [`${location.origin}/rpc/eth`],
        polygon: [`${location.origin}/rpc/polygon`]
      })
    )
  })
  await page.route('**/rpc/{eth,polygon}', handleRpcRoute)
}

async function emulateDesktopGoogleChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: {
        brands: [
          { brand: 'Chromium', version: '140' },
          { brand: 'Google Chrome', version: '140' }
        ],
        mobile: false
      }
    })
  })
}

async function installInjectedWallet(page: Page): Promise<void> {
  await page.addInitScript(
    ({ accountA }) => {
      type Listener = (...args: unknown[]) => void
      const listeners = new Map<string, Set<Listener>>()
      let accounts: string[] = []
      let requestedAccounts = [accountA]
      let chainId = '0x1'
      let sendAttempts = 0
      let successfulBroadcasts = 0

      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value)
      }

      const provider = {
        async request({ method }: { method: string; params?: unknown[] }): Promise<unknown> {
          switch (method) {
            case 'eth_accounts':
              return [...accounts]
            case 'eth_requestAccounts':
              accounts = [...requestedAccounts]
              return [...accounts]
            case 'eth_chainId':
              return chainId
            case 'eth_getTransactionCount':
              return '0x0'
            case 'wallet_switchEthereumChain':
              return null
            case 'eth_sendTransaction': {
              sendAttempts += 1
              const error = new Error('User rejected the request') as Error & { code: number }
              error.code = 4001
              throw error
            }
            default:
              throw new Error(`Unhandled injected wallet method: ${method}`)
          }
        },
        on(event: string, listener: Listener) {
          const eventListeners = listeners.get(event) ?? new Set<Listener>()
          eventListeners.add(listener)
          listeners.set(event, eventListeners)
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener)
        }
      }

      Object.defineProperty(window, 'ethereum', {
        configurable: true,
        value: provider
      })
      window.__walletMock = {
        emitAccounts(nextAccounts: string[]) {
          accounts = [...nextAccounts]
          requestedAccounts = [...nextAccounts]
          emit('accountsChanged', [...accounts])
        },
        emitChain(nextChainId: string) {
          chainId = nextChainId
          emit('chainChanged', nextChainId)
        },
        stats() {
          return { sendAttempts, successfulBroadcasts }
        }
      }
    },
    { accountA: ACCOUNT_A }
  )
}

test('production preview renders in desktop Chrome without console errors and sends security headers', async ({
  page
}) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)

  const response = await page.goto('/')

  await expect(page.getByRole('heading', { name: 'XENTurbo XEN Miner' })).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.locator('script[src*="/assets/"]')).toHaveCount(1)
  await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0)
  await expect.poll(() => consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])

  const headers = response?.headers() ?? {}
  expect(headers['content-security-policy']).toContain("default-src 'self'")
  expect(headers['content-security-policy']).toContain("script-src 'self'")
  expect(headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
  expect(headers['content-security-policy']).toContain(
    "img-src 'self' data: chrome-extension:"
  )
  expect(headers['content-security-policy']).toContain("font-src 'self'")
  expect(headers['content-security-policy']).toContain("object-src 'none'")
  expect(headers['content-security-policy']).toContain("base-uri 'self'")
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['content-security-policy']).toContain("form-action 'self'")
  expect(headers['content-security-policy']).toContain("connect-src 'self' https:")
  expect(headers['strict-transport-security']).toContain('max-age=31536000')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['permissions-policy']).toContain('camera=()')
  expect(headers['x-frame-options']).toBe('DENY')
})

test('mobile Chrome is blocked by the PC Chrome guard', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true
  })
  const page = await context.newPage()
  await mockSameOriginRpc(page)

  await page.goto('/')

  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.getByText('Mobile browsers are not supported.')).toBeVisible()
  await context.close()
})

test('wallet initialization, connect, account changes, and chain changes update the page', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Connect Wallet' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: '0x1111...1111' }).first()).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveValue('eth')

  await page.evaluate((account) => window.__walletMock.emitAccounts([account]), ACCOUNT_B)
  await expect(page.getByRole('button', { name: '0x2222...2222' }).first()).toBeVisible()

  await page.evaluate(() => window.__walletMock.emitChain('0x89'))
  await expect(page.getByRole('combobox')).toHaveValue('polygon')
})

test('a code-4001 wallet rejection reports failure without a successful broadcast', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()

  await page.getByRole('button', { name: 'Confirm Mint' }).click()
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()

  await expect(page.getByText('Transaction rejected', { exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__walletMock.stats()))
    .toEqual({ sendAttempts: 1, successfulBroadcasts: 0 })
})
