import { expect, test, type Page, type Route } from '@playwright/test'
import { Interface } from 'ethers'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'
const ZERO_HASH = `0x${'0'.repeat(64)}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const FACTORY = '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11'
const XEN_BY_CHAIN = {
  1: '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8',
  137: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e'
} as const
const factoryInterface = new Interface([
  'function vmuCount(address) view returns (uint256)',
  'function FEE() view returns (uint256)'
])
const xenInterface = new Interface([
  'function globalRank() view returns (uint256)',
  'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
])
const multicallInterface = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)'
])

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
    timestamp: `0x${Math.floor(Date.now() / 1_000).toString(16)}`,
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

function contractReadResult(chainId: 1 | 137, params: unknown[]): string {
  const call = params[0] as { to?: string; data?: string }
  const to = call.to?.toLowerCase()
  const data = call.data ?? '0x'
  if (to === FACTORY.toLowerCase()) {
    const parsed = factoryInterface.parseTransaction({ data })
    if (parsed?.name === 'vmuCount') {
      return factoryInterface.encodeFunctionResult('vmuCount', [1n])
    }
    if (parsed?.name === 'FEE') {
      return factoryInterface.encodeFunctionResult('FEE', [18_000_000_000_000n])
    }
  }
  if (to === XEN_BY_CHAIN[chainId].toLowerCase()) {
    const parsed = xenInterface.parseTransaction({ data })
    if (parsed?.name === 'globalRank') {
      return xenInterface.encodeFunctionResult('globalRank', [1_000_000n])
    }
  }
  if (to === MULTICALL.toLowerCase()) {
    const decoded = multicallInterface.decodeFunctionData('aggregate3', data)
    const calls = decoded.calls as Array<{ callData: string }>
    const results = calls.map(({ callData }) => {
      const [proxy] = xenInterface.decodeFunctionData('userMints', callData)
      return [
        true,
        xenInterface.encodeFunctionResult('userMints', [
          proxy,
          100n,
          1_700_000_000n,
          100n,
          3_000n,
          0n
        ])
      ]
    })
    return multicallInterface.encodeFunctionResult('aggregate3', [results])
  }
  throw new Error(`Unhandled contract read to ${call.to} data=${data.slice(0, 10)}`)
}

function rpcResult(method: string, chainId: 1 | 137, params: unknown[]): unknown {
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
      return contractReadResult(chainId, params)
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
  const chainId = request.url().includes('polygon') || request.url().includes('matic') ? 137 : 1
  const payload = request.postDataJSON() as
    | { id: number; method: string; params: unknown[] }
    | Array<{ id: number; method: string; params: unknown[] }>
  const requests = Array.isArray(payload) ? payload : [payload]
  const replies = requests.map(({ id, method, params }) => ({
    jsonrpc: '2.0',
    id,
    result: rpcResult(method, chainId, params)
  }))

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(payload) ? replies : replies[0])
  })
}

async function mockSameOriginRpc(page: Page): Promise<void> {
  for (const endpoint of [
    'https://ethereum.publicnode.com/**',
    'https://ethereum-rpc.publicnode.com/**',
    'https://polygon-bor-rpc.publicnode.com/**',
    'https://polygon.publicnode.com/**',
    'https://polygon.drpc.org/**',
    'https://1rpc.io/matic/**'
  ]) {
    await page.route(endpoint, handleRpcRoute)
  }
}

async function mockControllableEthereumRpc(page: Page): Promise<{
  requestCount: () => number
  setAvailable: (next: boolean) => void
}> {
  let requests = 0
  let available = false
  for (const endpoint of [
    'https://ethereum.publicnode.com/**',
    'https://ethereum-rpc.publicnode.com/**'
  ]) {
    await page.route(endpoint, async (route) => {
      requests += 1
      if (available) await handleRpcRoute(route)
      else await route.fulfill({ status: 503, contentType: 'text/plain', body: 'offline' })
    })
  }
  return {
    requestCount: () => requests,
    setAvailable: (next) => {
      available = next
    }
  }
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
            case 'eth_call':
              return `0x${18_000_000_000_000n.toString(16).padStart(64, '0')}`
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
  const footer = page.getByRole('contentinfo')
  await expect(footer).toContainText('Copyright 2026 · Miner.XENTurbo.io')
  await expect(footer).toContainText(
    'All code is open source. GitHub: maiqiu-cat/XENTurbo-XEN-Miner'
  )
  await expect(footer.getByRole('link', { name: 'Miner.XENTurbo.io' })).toHaveAttribute(
    'href',
    'https://miner.xenturbo.io/'
  )
  await expect(
    footer.getByRole('link', { name: /maiqiu-cat\/XENTurbo-XEN-Miner/ })
  ).toHaveAttribute('href', 'https://github.com/maiqiu-cat/XENTurbo-XEN-Miner')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.locator('script[src*="/assets/"]')).toHaveCount(1)
  await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0)
  await expect.poll(() => consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])

  const headers = response?.headers() ?? {}
  expect(headers['content-security-policy']).toContain("default-src 'self'")
  expect(headers['content-security-policy']).toContain("script-src 'self'")
  expect(headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
  expect(headers['content-security-policy']).toContain("img-src 'self' data: chrome-extension:")
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

test('all unavailable RPC endpoints block chain actions and can be rechecked', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await installInjectedWallet(page)
  const rpc = await mockControllableEthereumRpc(page)

  await page.goto('/')

  await expect(page.getByText(/No usable Ethereum RPC endpoints \(0\/2\)/)).toBeVisible()
  await expect(page.getByText(/Your RPC list was not changed/)).toBeVisible()
  await expect(page.getByText(/DNS, firewall, and proxy\/VPN settings/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'RPC', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeDisabled()
  const requestsBeforeRecheck = rpc.requestCount()

  await page.getByRole('button', { name: 'Recheck RPC' }).click()

  await expect.poll(rpc.requestCount).toBeGreaterThan(requestsBeforeRecheck)
  await expect(page.getByText(/Chain reads and transactions are blocked/)).toBeVisible()

  rpc.setAvailable(true)
  await page.getByRole('button', { name: 'Recheck RPC' }).click()

  await expect(page.getByText(/No usable Ethereum RPC endpoints/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
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

test('wallet initialization, connect, account changes, and chain changes update the page', async ({
  page
}) => {
  let nonceReads = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    try {
      const payload = request.postDataJSON() as { method?: string } | Array<{ method?: string }>
      const requests = Array.isArray(payload) ? payload : [payload]
      nonceReads += requests.filter((entry) => entry.method === 'eth_getTransactionCount').length
    } catch {
      // Ignore non-JSON requests; RPC mocks below are JSON-RPC only.
    }
  })
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Connect Wallet' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: '0x1111...1111' }).first()).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveValue('eth')
  await page.waitForTimeout(250)
  expect(nonceReads).toBe(2)

  await page.evaluate((account) => window.__walletMock.emitAccounts([account]), ACCOUNT_B)
  await expect(page.getByRole('button', { name: '0x2222...2222' }).first()).toBeVisible()

  await page.evaluate(() => window.__walletMock.emitChain('0x89'))
  await expect(page.getByRole('combobox')).toHaveValue('polygon')
})

test('claim selection is cleared when the connected wallet changes', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()

  const checkbox = page.locator('tbody input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible()
  await checkbox.click()
  await expect(page.getByText('1 VMUs selected')).toBeVisible()

  await page.evaluate((account) => window.__walletMock.emitAccounts([account]), ACCOUNT_B)
  await expect(page.getByRole('button', { name: '0x2222...2222' }).first()).toBeVisible()
  await expect(page.getByText('1 VMUs selected')).toHaveCount(0)
  await expect(checkbox).not.toBeChecked()
})

test('an unsigned prepared operation is invalidated by an account change', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()

  await page.getByRole('button', { name: 'Confirm Mint' }).click()
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()

  await page.evaluate((account) => window.__walletMock.emitAccounts([account]), ACCOUNT_B)

  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '0x2222...2222' }).first()).toBeVisible()
})

test('an account change during the initial pending check cancels the requested operation', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: 'Recheck', exact: true })).toBeEnabled()
  // Let ethers' short-lived identical-read cache expire before installing the
  // route gate for the operation's fresh pending check.
  await page.waitForTimeout(500)

  let releasePendingCheck!: () => void
  const pendingCheckGate = new Promise<void>((resolve) => {
    releasePendingCheck = resolve
  })
  let blockedPendingChecks = 0
  const blockPendingCheck = async (route: Route) => {
    const payload = route.request().postDataJSON() as { method: string } | Array<{ method: string }>
    const requests = Array.isArray(payload) ? payload : [payload]
    if (requests.some(({ method }) => method === 'eth_getTransactionCount')) {
      blockedPendingChecks += 1
      await pendingCheckGate
    }
    await handleRpcRoute(route)
  }
  for (const endpoint of [
    'https://ethereum.publicnode.com/**',
    'https://ethereum-rpc.publicnode.com/**'
  ]) {
    await page.unroute(endpoint, handleRpcRoute)
    await page.route(endpoint, blockPendingCheck)
  }

  await page.getByRole('button', { name: 'Confirm Mint' }).click()
  await expect.poll(() => blockedPendingChecks).toBeGreaterThan(0)
  await page.evaluate(
    ({ accountA, accountB }) => {
      window.__walletMock.emitAccounts([accountB])
      window.__walletMock.emitAccounts([accountA])
    },
    { accountA: ACCOUNT_A, accountB: ACCOUNT_B }
  )
  releasePendingCheck()

  await expect(page.getByRole('button', { name: '0x1111...1111' }).first()).toBeVisible()
  await page.waitForTimeout(750)
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
})

test('cancel during the final pending check never opens a wallet request', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await page.getByRole('button', { name: 'Confirm Mint' }).click()
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
  // JsonRpcProvider briefly caches identical reads. Let the preparation reads
  // expire so the final pending check is guaranteed to hit the routed RPC.
  await page.waitForTimeout(500)

  let releasePendingCheck!: () => void
  const pendingCheckGate = new Promise<void>((resolve) => {
    releasePendingCheck = resolve
  })
  let blockedPendingChecks = 0
  const blockPendingCheck = async (route: Route) => {
    const payload = route.request().postDataJSON() as { method: string } | Array<{ method: string }>
    const requests = Array.isArray(payload) ? payload : [payload]
    if (requests.some(({ method }) => method === 'eth_getTransactionCount')) {
      blockedPendingChecks += 1
      await pendingCheckGate
    }
    await handleRpcRoute(route)
  }
  for (const endpoint of [
    'https://ethereum.publicnode.com/**',
    'https://ethereum-rpc.publicnode.com/**'
  ]) {
    await page.unroute(endpoint, handleRpcRoute)
    await page.route(endpoint, blockPendingCheck)
  }

  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await expect.poll(() => blockedPendingChecks).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  releasePendingCheck()

  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toHaveCount(0)
  await page.waitForTimeout(750)
  await expect(page.getByText('Preparation cancelled. No transaction was submitted.')).toBeVisible()
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
})

test('a code-4001 wallet rejection reports failure without a successful broadcast', async ({
  page
}) => {
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
