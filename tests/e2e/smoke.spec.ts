import { expect, test, type Page, type Route } from '@playwright/test'
import { join } from 'node:path'
import { Interface } from 'ethers'
import { computeProxyAddress, minimalProxyRuntimeCode } from '../../src/core/create2'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'
const ZERO_HASH = `0x${'0'.repeat(64)}`
const TX_HASH = `0x${'a'.repeat(64)}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const FACTORY = '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
const VMU_TEMPLATE = '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'
const BLOCK_TIMESTAMP = Math.floor(Date.now() / 1000)
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

async function captureQaScreenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.XENTURBO_QA_SCREENSHOT_DIR
  if (directory) await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true })
}

interface WalletMockStats {
  sendAttempts: number
  successfulBroadcasts: number
}

declare global {
  interface Window {
    __walletMock: {
      emitAccounts(accounts: string[]): void
      emitChain(chainId: string): void
      setStalled(method: string, stalled: boolean): void
      setRejected(method: string, rejected: boolean): void
      setSendDelay(delayMs: number): void
      nonceReadCount(): number
      stats(): WalletMockStats
    }
    __confirmedWrites: Array<{ id: string; hasOutcome: boolean }>
    __pendingCheckGate: { reads: number; reject(): void; release(): void }
  }
}

function blockResult(chainId: number, timestamp = BLOCK_TIMESTAMP) {
  return {
    hash: `0x${'b'.repeat(64)}`,
    parentHash: ZERO_HASH,
    number: '0x1',
    timestamp: `0x${timestamp.toString(16)}`,
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

interface RpcMockState {
  successfulTx?: boolean
  confirmed?: boolean
  operation?: 'GENERAL_MINT' | 'CREATE_EMPTY_SLOT' | 'MINT_EMPTY_SLOT' | 'CLAIM' | 'CLAIM_REUSE'
  blockTimestamp?: number
  maturityTimestamp?: number
}

function contractReadResult(chainId: 1 | 137, params: unknown[], state: RpcMockState = {}): string {
  const call = params[0] as { to?: string; data?: string }
  const to = call.to?.toLowerCase()
  const data = call.data ?? '0x'
  if (to === FACTORY.toLowerCase()) {
    const parsed = factoryInterface.parseTransaction({ data })
    if (parsed?.name === 'vmuCount') {
      const allocated =
        state.confirmed &&
        (state.operation === 'GENERAL_MINT' || state.operation === 'CREATE_EMPTY_SLOT')
      return factoryInterface.encodeFunctionResult('vmuCount', [allocated ? 3n : 1n])
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
      const firstProxy = computeProxyAddress({
        factory: FACTORY,
        vmuTemplate: VMU_TEMPLATE,
        wallet: ACCOUNT_A,
        vmuId: 1
      })
      const allocated =
        state.operation === 'GENERAL_MINT' || state.operation === 'CREATE_EMPTY_SLOT'
      const changed =
        state.confirmed && (!allocated || proxy.toLowerCase() !== firstProxy.toLowerCase())
      const minting =
        changed &&
        (state.operation === 'GENERAL_MINT' ||
          state.operation === 'MINT_EMPTY_SLOT' ||
          state.operation === 'CLAIM_REUSE')
      const empty =
        (state.operation === 'MINT_EMPTY_SLOT' && !state.confirmed) || (changed && !minting)
      return [
        true,
        xenInterface.encodeFunctionResult('userMints', [
          proxy,
          minting ? 10n : empty ? 0n : 100n,
          minting
            ? BigInt(BLOCK_TIMESTAMP + 10 * 86_400)
            : empty
              ? 0n
              : BigInt(state.maturityTimestamp ?? 1_700_000_000),
          minting ? 200n : empty ? 0n : 100n,
          3_000n,
          0n
        ])
      ]
    })
    return multicallInterface.encodeFunctionResult('aggregate3', [results])
  }
  throw new Error(`Unhandled contract read to ${call.to} data=${data.slice(0, 10)}`)
}

function rpcResult(
  method: string,
  chainId: 1 | 137,
  params: unknown[],
  state: RpcMockState = {}
): unknown {
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
      if (
        state.confirmed &&
        state.operation === 'CREATE_EMPTY_SLOT' &&
        params[0] !== ACCOUNT_A &&
        params[0] !== ACCOUNT_B
      )
        return minimalProxyRuntimeCode(VMU_TEMPLATE)
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
      return blockResult(chainId, state.blockTimestamp)
    case 'eth_call':
      return contractReadResult(chainId, params, state)
    case 'eth_estimateGas':
      return '0x4c4b40'
    case 'eth_getLogs':
      return []
    case 'eth_getTransactionReceipt':
      if (!state.successfulTx) return null
      state.confirmed = true
      return {
        blockHash: `0x${'b'.repeat(64)}`,
        blockNumber: '0x1',
        contractAddress: null,
        cumulativeGasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        from: ACCOUNT_A,
        gasUsed: '0x5208',
        logs: [],
        logsBloom: `0x${'0'.repeat(512)}`,
        status: '0x1',
        to: FACTORY,
        transactionHash: TX_HASH,
        transactionIndex: '0x0',
        type: '0x2'
      }
    case 'eth_getTransactionByHash':
      return null
    default:
      throw new Error(`Unhandled mocked RPC method: ${method}`)
  }
}

async function handleRpcRouteWithState(route: Route, state: RpcMockState): Promise<void> {
  const request = route.request()
  const chainId = request.url().includes('polygon') || request.url().includes('matic') ? 137 : 1
  const payload = request.postDataJSON() as
    | { id: number; method: string; params: unknown[] }
    | Array<{ id: number; method: string; params: unknown[] }>
  const requests = Array.isArray(payload) ? payload : [payload]
  const replies = requests.map(({ id, method, params }) => ({
    jsonrpc: '2.0',
    id,
    result: rpcResult(method, chainId, params, state)
  }))

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(payload) ? replies : replies[0])
  })
}

async function handleRpcRoute(route: Route): Promise<void> {
  return handleRpcRouteWithState(route, {})
}

const ETHEREUM_RPC_ROUTES = [
  /^https:\/\/ethereum\.publicnode\.com(?:\/.*)?$/,
  /^https:\/\/ethereum-rpc\.publicnode\.com(?:\/.*)?$/,
  /^https:\/\/rpc\.mevblocker\.io(?:\/.*)?$/,
  /^https:\/\/public\.1rpc\.io\/eth(?:[/?].*)?$/
]

async function mockSameOriginRpc(page: Page, state?: RpcMockState): Promise<void> {
  for (const endpoint of [
    ...ETHEREUM_RPC_ROUTES,
    'https://polygon-bor-rpc.publicnode.com/**',
    'https://polygon.publicnode.com/**',
    'https://polygon.drpc.org/**',
    'https://1rpc.io/matic/**'
  ]) {
    if (state) await page.route(endpoint, (route) => handleRpcRouteWithState(route, state))
    else await page.route(endpoint, handleRpcRoute)
  }
}

async function mockControllableEthereumRpc(page: Page): Promise<{
  requestCount: () => number
  setAvailable: (next: boolean) => void
}> {
  let requests = 0
  let available = false
  for (const endpoint of ETHEREUM_RPC_ROUTES) {
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

async function installInjectedWallet(
  page: Page,
  options: { successfulSend?: boolean; initiallyStalled?: string[] } = {}
): Promise<void> {
  await page.addInitScript(
    ({ accountA, successfulSend, txHash, countSelector, initiallyStalled }) => {
      type Listener = (...args: unknown[]) => void
      const listeners = new Map<string, Set<Listener>>()
      let accounts: string[] = []
      let requestedAccounts = [accountA]
      let chainId = '0x1'
      let sendAttempts = 0
      let successfulBroadcasts = 0
      let sendDelayMs = 0
      let nonceReads = 0
      const stalledMethods = new Set<string>(initiallyStalled)
      const rejectedMethods = new Set<string>()

      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value)
      }

      const provider = {
        async request({
          method,
          params
        }: {
          method: string
          params?: unknown[]
        }): Promise<unknown> {
          if (method === 'eth_getTransactionCount') nonceReads += 1
          if (stalledMethods.has(method)) return new Promise(() => {})
          if (rejectedMethods.has(method)) throw new Error(`Offline fixture rejected ${method}`)
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
            case 'eth_estimateGas':
              return '0x4c4b40'
            case 'eth_getBlockByNumber':
              return { gasLimit: '0x1c9c380' }
            case 'eth_getTransactionByHash':
              return null
            case 'eth_getTransactionReceipt':
              return successfulBroadcasts > 0
                ? {
                    transactionHash: txHash,
                    blockHash: `0x${'b'.repeat(64)}`,
                    blockNumber: '0x1',
                    status: '0x1',
                    from: accountA,
                    to: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
                  }
                : null
            case 'eth_call':
              if ((params?.[0] as { data?: string })?.data?.startsWith(countSelector))
                return `0x${1n.toString(16).padStart(64, '0')}`
              return `0x${18_000_000_000_000n.toString(16).padStart(64, '0')}`
            case 'wallet_switchEthereumChain':
              return null
            case 'eth_sendTransaction': {
              sendAttempts += 1
              if (sendDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, sendDelayMs))
              }
              if (successfulSend) {
                successfulBroadcasts += 1
                return txHash
              }
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
        setStalled(method: string, stalled: boolean) {
          if (stalled) stalledMethods.add(method)
          else stalledMethods.delete(method)
        },
        setRejected(method: string, rejected: boolean) {
          if (rejected) rejectedMethods.add(method)
          else rejectedMethods.delete(method)
        },
        setSendDelay(delayMs: number) {
          sendDelayMs = delayMs
        },
        nonceReadCount() {
          return nonceReads
        },
        stats() {
          return { sendAttempts, successfulBroadcasts }
        }
      }
    },
    {
      accountA: ACCOUNT_A,
      successfulSend: options.successfulSend ?? false,
      initiallyStalled: options.initiallyStalled ?? [],
      txHash: TX_HASH,
      countSelector: factoryInterface.getFunction('vmuCount')!.selector
    }
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
  await expect(page.getByTestId('app-version')).toHaveText(/^v\d+\.\d+\.\d+$/)
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
  expect(headers['content-security-policy']).toContain(
    "script-src 'self' https://static.cloudflareinsights.com"
  )
  expect(headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'")
  expect(headers['content-security-policy']).not.toMatch(/google-analytics|googletagmanager/)
  await expect(page.locator('script[data-cf-beacon]')).toHaveCount(0)
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
  await captureQaScreenshot(page, 'desktop')
  expect(headers['permissions-policy']).toContain('camera=()')
  expect(headers['x-frame-options']).toBe('DENY')
})

test('all unavailable RPC endpoints block chain actions and can be rechecked', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await installInjectedWallet(page)
  const rpc = await mockControllableEthereumRpc(page)

  await page.goto('/')

  await expect(page.getByText(/No usable Ethereum RPC endpoints \(0\/4\)/)).toBeVisible()
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
  await captureQaScreenshot(page, 'mobile-guard')
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
  expect(nonceReads).toBe(0)

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

test('a stalled wallet nonce read times out without opening a transaction request', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()

  const checkbox = page.locator('tbody input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible()
  await checkbox.click()
  await page.evaluate(() => window.__walletMock.setStalled('eth_getTransactionCount', true))

  await page.getByRole('button', { name: 'Claim & Re-Mint (100d)' }).click()

  await expect(page.getByText('Estimate gas')).toBeVisible()
  await expect(page.locator('.steps .step-icon.run')).toHaveText('...')
  await expect(page.getByText('Checking pending transactions through the wallet...')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(
    page
      .getByText(/READ_TIMEOUT: Wallet eth_getTransactionCount exceeded 15000 ms/, { exact: false })
      .first()
  ).toBeVisible({ timeout: 17_000 })
  await expect(
    page.getByText(
      'Pending check failed: READ_TIMEOUT: Wallet eth_getTransactionCount exceeded 15000 ms'
    )
  ).toBeVisible()
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible()
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

test('prepared signing stays blocked if a shared pending check fails during a trailing retry', async ({
  page
}) => {
  await page.clock.install()
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  await page.getByRole('button', { name: 'Confirm Mint' }).click()
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
  await page.evaluate(() => {
    const provider = (
      window as unknown as {
        ethereum: { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
      }
    ).ethereum
    const original = provider.request.bind(provider)
    let reject!: (error: Error) => void
    let release!: () => void
    const first = new Promise<unknown>((_resolve, fail) => {
      reject = fail
    })
    const retry = new Promise<void>((resolve) => {
      release = resolve
    })
    window.__pendingCheckGate = {
      reads: 0,
      reject: () => reject(new Error('Pending check offline fixture')),
      release: () => release()
    }
    provider.request = async (args) => {
      if (args.method === 'eth_getTransactionCount') {
        window.__pendingCheckGate.reads += 1
        if (window.__pendingCheckGate.reads <= 2) return first
        await retry
      }
      return original(args)
    }
  })
  await page.clock.runFor(30_001)
  await expect.poll(() => page.evaluate(() => window.__pendingCheckGate.reads)).toBe(2)
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await page.evaluate(() => window.__pendingCheckGate.reject())
  await expect.poll(() => page.evaluate(() => window.__pendingCheckGate.reads)).toBe(4)
  await expect(page.locator('.modal-body .err-text')).toContainText(
    'verifying pending transactions'
  )
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  await page.evaluate(() => window.__pendingCheckGate.release())
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
})

for (const kind of ['wallet', 'chain'] as const) {
  test(`pending polling continues after a synchronous ${kind} round trip`, async ({ page }) => {
    await page.clock.install()
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
    await page.evaluate(
      ({ kind, account }) => {
        if (kind === 'wallet') {
          window.__walletMock.emitAccounts([])
          window.__walletMock.emitAccounts([account])
        } else {
          window.__walletMock.emitChain('0x89')
          window.__walletMock.emitChain('0x1')
        }
      },
      { kind, account: ACCOUNT_A }
    )
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
    const reads = await page.evaluate(() => window.__walletMock.nonceReadCount())
    await page.clock.runFor(30_001)
    await expect
      .poll(() => page.evaluate(() => window.__walletMock.nonceReadCount()))
      .toBeGreaterThan(reads)
    const nextReads = await page.evaluate(() => window.__walletMock.nonceReadCount())
    await page.clock.runFor(30_001)
    await expect
      .poll(() => page.evaluate(() => window.__walletMock.nonceReadCount()))
      .toBeGreaterThan(nextReads)
  })
}

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
  for (const endpoint of ETHEREUM_RPC_ROUTES) {
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
  for (const endpoint of ETHEREUM_RPC_ROUTES) {
    await page.unroute(endpoint, handleRpcRoute)
    await page.route(endpoint, blockPendingCheck)
  }

  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await expect.poll(() => blockedPendingChecks).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  releasePendingCheck()

  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toHaveCount(0)
  await page.waitForTimeout(750)
  await expect(page.locator('.modal-mask')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
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

test('a successful claim is confirmed and its on-chain result is verified', async ({ page }) => {
  const rpcState: RpcMockState = { successfulTx: true, confirmed: false, operation: 'CLAIM' }
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page, rpcState)
  await installInjectedWallet(page, { successfulSend: true })
  await page.addInitScript(() => {
    window.__confirmedWrites = []
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('sm.pendingOps.event.')) {
        const record = JSON.parse(value).record
        if (record?.phase === 'confirmed') {
          window.__confirmedWrites.push({ id: record.id, hasOutcome: !!record.outcome })
        }
      }
      return write.call(this, key, value)
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()

  const checkbox = page.locator('tbody input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible()
  await checkbox.click()
  await page.getByRole('button', { name: 'Claim only' }).click()
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()

  await expect(page.getByText('Transaction result verified.')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__walletMock.stats()))
    .toEqual({ sendAttempts: 1, successfulBroadcasts: 1 })
  const writes = await page.evaluate(() => window.__confirmedWrites)
  expect(writes.filter((write) => !write.hasOutcome)).toHaveLength(1)
  expect(writes.filter((write) => write.hasOutcome)).toHaveLength(1)
})

test('a stalled initial wallet read times out and Connect Wallet can recover', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page, { initiallyStalled: ['eth_accounts'] })
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'XENTurbo XEN Miner' })).toBeVisible()
  await page.clock.runFor(15_100)
  await expect(page.locator('.connect-err')).toContainText('READ_TIMEOUT')

  await page.evaluate(() => window.__walletMock.setStalled('eth_accounts', false))
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: '0x1111...1111' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  await captureQaScreenshot(page, 'wallet-init-recovered')
})

test('a failed wallet type read stays blocked until the user safely rechecks it', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  let failCodeRead = true
  for (const endpoint of ETHEREUM_RPC_ROUTES) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON() as
        | { id: number; method: string; params: unknown[] }
        | Array<{ id: number; method: string; params: unknown[] }>
      const requests = Array.isArray(body) ? body : [body]
      if (failCodeRead && requests.some(({ method }) => method === 'eth_getCode')) {
        const replies = requests.map(({ id, method, params }) => ({
          jsonrpc: '2.0',
          id,
          ...(method === 'eth_getCode'
            ? { error: { code: -32000, message: 'wallet type read unavailable' } }
            : { result: rpcResult(method, 1, params) })
        }))
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(Array.isArray(body) ? replies : replies[0])
        })
      } else {
        await handleRpcRoute(route)
      }
    })
  }
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(
    page.getByText(
      'Wallet type could not be verified. Check internet access and your RPC endpoints, then recheck.'
    )
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeDisabled()
  failCodeRead = false
  await page.getByRole('button', { name: 'Recheck wallet' }).click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  await captureQaScreenshot(page, 'wallet-type-recovered')
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
})

test('saving a new RPC recovers an in-flight wallet check without another recheck', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await installInjectedWallet(page)
  const held: Route[] = []
  for (const endpoint of ETHEREUM_RPC_ROUTES) {
    await page.route(endpoint, async (route) => {
      const payload = route.request().postDataJSON()
      const requests = Array.isArray(payload) ? payload : [payload]
      if (requests.some(({ method }) => method === 'eth_getCode')) held.push(route)
      else await handleRpcRoute(route)
    })
  }
  let replacementReads = 0
  await page.route('https://replacement.rpc.test/**', async (route) => {
    const payload = route.request().postDataJSON()
    const requests = Array.isArray(payload) ? payload : [payload]
    replacementReads += requests.filter(({ method }) => method === 'eth_getCode').length
    await handleRpcRoute(route)
  })
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await expect.poll(() => held.length).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeDisabled()
    await page.getByRole('button', { name: 'RPC', exact: true }).click()
    await page.locator('textarea').fill('https://replacement.rpc.test/')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
    await expect(page.locator('tbody tr')).toBeVisible()
    expect(replacementReads).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
    await captureQaScreenshot(page, 'rpc-replacement-recovered')
  } finally {
    for (const route of held) await route.abort().catch(() => {})
  }
})

test('resuming a sleeping page corrects the countdown without a VMU rescan', async ({ page }) => {
  await emulateDesktopGoogleChrome(page)
  await installInjectedWallet(page)
  await page.clock.install()
  await page.addInitScript(() => {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => 100 })
  })
  const state: RpcMockState = {
    blockTimestamp: BLOCK_TIMESTAMP,
    maturityTimestamp: BLOCK_TIMESTAMP + 7_200
  }
  let scans = 0
  for (const endpoint of ETHEREUM_RPC_ROUTES) {
    await page.route(endpoint, async (route) => {
      const payload = route.request().postDataJSON()
      const requests = Array.isArray(payload) ? payload : [payload]
      scans += requests.filter(
        ({ method, params }) =>
          method === 'eth_call' && params[0]?.to?.toLowerCase() === MULTICALL.toLowerCase()
      ).length
      await handleRpcRouteWithState(route, state)
    })
  }
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.locator('tbody tr')).toContainText('2h 0m')
  const scansBeforeResume = scans
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward(3_600_000)
  state.blockTimestamp = BLOCK_TIMESTAMP + 3_600
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.locator('tbody tr')).toContainText('1h 0m')
  await expect(page.locator('tbody tr')).toContainText('Maturing')
  expect(scans).toBe(scansBeforeResume)
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
  await captureQaScreenshot(page, 'chain-clock-resumed')
})

for (const blocked of [false, true]) {
  test(`Cloudflare production-host beacon ${blocked ? 'can be blocked without disrupting mining' : 'loads with the supplied token and no Google requests'}`, async ({
    page,
    baseURL
  }) => {
    const googleRequests: string[] = []
    const pageErrors: string[] = []
    let beaconRequests = 0
    const payloads: unknown[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('request', (request) => {
      if (/google-analytics|googletagmanager/.test(request.url()))
        googleRequests.push(request.url())
    })
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    // Only the hostname is emulated: HTML/assets are fetched from the local preview, never production.
    const productionPreview = new URL(baseURL!)
    productionPreview.hostname = 'miner.xenturbo.io'
    await page.route(`${productionPreview.origin}/**`, async (route) => {
      const url = new URL(route.request().url())
      url.hostname = '127.0.0.1'
      const response = await route.fetch({ url: url.href })
      await route.fulfill({ response })
    })
    await page.route('https://static.cloudflareinsights.com/beacon.min.js', async (route) => {
      beaconRequests += 1
      if (blocked) return route.abort('blockedbyclient')
      await route.fulfill({
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: `const beacon = document.querySelector('script[data-cf-beacon]');
          void fetch('https://cloudflareinsights.com/cdn-cgi/rum', {
            method: 'POST', body: beacon.getAttribute('data-cf-beacon')
          });`
      })
    })
    await page.route('https://cloudflareinsights.com/cdn-cgi/rum', async (route) => {
      payloads.push(JSON.parse(route.request().postData()!))
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
    })
    await page.goto(productionPreview.href)
    await expect(page.locator('script[data-cf-beacon]')).toHaveCount(1)
    await expect(page.locator('script[data-cf-beacon]')).toHaveAttribute('type', 'module')
    expect(
      JSON.parse((await page.locator('script[data-cf-beacon]').getAttribute('data-cf-beacon'))!)
    ).toEqual({ token: 'd47010c2cf564339b8ad6c17afef3e0c' })
    await expect.poll(() => beaconRequests).toBe(1)
    if (!blocked)
      await expect.poll(() => payloads).toEqual([{ token: 'd47010c2cf564339b8ad6c17afef3e0c' }])
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
    await page.getByRole('button', { name: 'Confirm Mint' }).click()
    await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
    expect(googleRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 0,
      successfulBroadcasts: 0
    })
  })
}

for (const operation of [
  'GENERAL_MINT',
  'CREATE_EMPTY_SLOT',
  'MINT_EMPTY_SLOT',
  'CLAIM_REUSE'
] as const) {
  test(`a successful ${operation} verifies the exact receipt-block result`, async ({ page }) => {
    const state: RpcMockState = { successfulTx: true, confirmed: false, operation }
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page, state)
    await installInjectedWallet(page, { successfulSend: true })
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    if (operation === 'GENERAL_MINT') {
      await page.getByLabel(/^Mint VMUs/).fill('2')
      await page.getByLabel(/^Term \(days, max/).fill('10')
      await page.getByRole('button', { name: 'Confirm Mint' }).click()
    } else if (operation === 'CREATE_EMPTY_SLOT') {
      await page.getByRole('button', { name: 'Slots Management' }).click()
      await page.getByLabel(/^Create Empty Slots/).fill('2')
      await page.getByRole('button', { name: 'Create Slots', exact: true }).click()
    } else if (operation === 'MINT_EMPTY_SLOT') {
      await page.getByRole('button', { name: 'Empty Slots Mint', exact: true }).click()
      await page.getByLabel(/^Empty VMUs/).fill('1')
      await page.getByLabel('Term (days)', { exact: true }).fill('10')
      await page.getByRole('button', { name: 'Re-Mint Empty Slots' }).click()
    } else {
      await page.locator('tbody input[type="checkbox"]').first().check()
      await page.locator('.reuse-term input').fill('10')
      await page.getByRole('button', { name: 'Claim & Re-Mint (10d)' }).click()
    }
    await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
    await expect(page.getByText('Transaction result verified.')).toBeVisible()
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 1,
      successfulBroadcasts: 1
    })
  })
}

test('legacy RPC configuration errors explain limits and recover only after explicit reset', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await page.addInitScript(() =>
    localStorage.setItem(
      'sm.customRpc',
      JSON.stringify({ eth: Array.from({ length: 17 }, (_, id) => `https://rpc${id}.example/`) })
    )
  )
  await page.goto('/')
  const banner = page.locator('.rpc-health-banner')
  await expect(banner).toContainText('at most 16 RPC endpoints')
  await expect(banner).not.toContainText('Check internet access')
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('sm.customRpc')!).eth.length)
  ).toBe(17)
  await captureQaScreenshot(page, 'rpc-config-explained')
  await page.getByRole('button', { name: 'RPC', exact: true }).click()
  await page.getByRole('button', { name: 'Reset to default', exact: true }).click()
  await expect(banner).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('sm.customRpc')!).eth)
  ).toBeUndefined()
})

test('a failed first pending check on a new wallet stays blocked until a successful recheck', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
  await expect(mint).toBeEnabled()
  await page.evaluate((account) => {
    window.__walletMock.setRejected('eth_getTransactionCount', true)
    window.__walletMock.emitAccounts([account])
  }, ACCOUNT_B)
  await expect(
    page
      .getByText('Blocked: pending transaction check failed. Recheck before submitting.', {
        exact: false
      })
      .first()
  ).toBeVisible()
  await expect(mint).toBeDisabled()
  expect((await page.evaluate(() => window.__walletMock.stats())).sendAttempts).toBe(0)
  await captureQaScreenshot(page, 'pending-check-blocked')
  await page.evaluate(() => window.__walletMock.setRejected('eth_getTransactionCount', false))
  await page.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(mint).toBeEnabled()
})

test('a late wallet hash restores a broadcast lock after the UI timeout', async ({ page }) => {
  await page.clock.install()
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page, { successfulSend: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  await page.locator('tbody input[type="checkbox"]').first().check()
  await page.getByRole('button', { name: 'Claim only', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
  await page.evaluate(() => {
    window.__walletMock.setSendDelay(130_000)
    window.__walletMock.setRejected('eth_getTransactionReceipt', true)
  })
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await expect.poll(() => page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(1)
  await page.clock.fastForward(120_100)
  await expect(
    page.getByText(/MetaMask did not return a result within 2 minutes/).first()
  ).toBeVisible()
  await page.clock.fastForward(10_000)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]').filter(
            (lock: { txHash?: string }) => !!lock.txHash
          ).length
      )
    )
    .toBe(1)
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]')[0])
  ).toMatchObject({ ids: [1], txHash: TX_HASH })
  await expect(page.getByText('No VMUs in this category.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 1,
    successfulBroadcasts: 1
  })
  await captureQaScreenshot(page, 'late-hash-lock-restored')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]').length)
  ).toBe(1)
  await page.evaluate(() => window.__walletMock.setRejected('eth_getTransactionReceipt', false))
  await page.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]').length))
    .toBe(0)
})

test('two tabs serialize wallet sends with a shared Web Lock', async ({ page, context }) => {
  const second = await context.newPage()
  for (const candidate of [page, second]) {
    await emulateDesktopGoogleChrome(candidate)
    await mockSameOriginRpc(candidate)
    await installInjectedWallet(candidate)
    await candidate.goto('/')
    await candidate.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await candidate.getByRole('button', { name: 'Confirm Mint' }).click()
    await expect(candidate.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
  }

  await page.evaluate(() => window.__walletMock.setSendDelay(1_000))
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await expect.poll(() => page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(1)

  await second.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await second.waitForTimeout(250)
  expect(await second.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)

  await expect(page.getByText('Transaction rejected', { exact: true })).toBeVisible()
  await expect.poll(() => second.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(1)
  await second.close()
})
