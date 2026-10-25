import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
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

async function expectPendingNonceReads(page: Page, expected: number): Promise<void> {
  // With the clock paused, advance only the short timers needed by wallet/RPC batching.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(50)
        return page.evaluate(() => window.__pendingCheckGate.reads)
      },
      { timeout: 15_000, intervals: [100] }
    )
    .toBe(expected)
}

async function expectEnabledWithClock(page: Page, button: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.clock.runFor(50)
        return (await button.count()) > 0 && (await button.isEnabled())
      },
      // Advance paused timers frequently without skipping the readiness gate or background polls.
      { timeout: 15_000, intervals: [100] }
    )
    .toBe(true)
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
      setMinedReceipt(value: boolean): void
      nonceReadCount(): number
      stats(): WalletMockStats
    }
    __confirmedWrites: Array<{ id: string; hasOutcome: boolean }>
    __pendingCheckGate: { reads: number; reject(): void; release(): void }
    __trackingReads: number
    __recoveryRead: { reads: number; release(): void }
    __restoreStorage?: () => void
    __rateLimitHeaders: Array<string | null>
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
  vmuCount?: number
  unreadableVmuId?: number
  successfulTx?: boolean
  confirmed?: boolean
  operation?: 'GENERAL_MINT' | 'CREATE_EMPTY_SLOT' | 'MINT_EMPTY_SLOT' | 'CLAIM' | 'CLAIM_REUSE'
  blockTimestamp?: number
  maturityTimestamp?: number
  maturityVmuId?: number
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
      return factoryInterface.encodeFunctionResult('vmuCount', [
        state.vmuCount ?? (allocated ? 3n : 1n)
      ])
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
      if (
        state.unreadableVmuId &&
        proxy.toLowerCase() ===
          computeProxyAddress({
            factory: FACTORY,
            vmuTemplate: VMU_TEMPLATE,
            wallet: ACCOUNT_A,
            vmuId: state.unreadableVmuId
          }).toLowerCase()
      )
        return [false, '0x']
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
      const maturityApplies =
        !state.maturityVmuId ||
        proxy.toLowerCase() ===
          computeProxyAddress({
            factory: FACTORY,
            vmuTemplate: VMU_TEMPLATE,
            wallet: ACCOUNT_A,
            vmuId: state.maturityVmuId
          }).toLowerCase()
      return [
        true,
        xenInterface.encodeFunctionResult('userMints', [
          proxy,
          minting ? 10n : empty ? 0n : 100n,
          minting
            ? BigInt(BLOCK_TIMESTAMP + 10 * 86_400)
            : empty
              ? 0n
              : BigInt(
                  maturityApplies ? (state.maturityTimestamp ?? 1_700_000_000) : 1_700_000_000
                ),
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
  /^https:\/\/mainnet\.gateway\.tenderly\.co(?:\/.*)?$/
]

const POLYGON_RPC_ROUTES = [
  /^https:\/\/polygon-bor-rpc\.publicnode\.com(?:\/.*)?$/,
  /^https:\/\/polygon\.publicnode\.com(?:\/.*)?$/,
  /^https:\/\/polygon\.drpc\.org(?:\/.*)?$/,
  /^https:\/\/polygon\.gateway\.tenderly\.co(?:\/.*)?$/
]

async function mockSameOriginRpc(page: Page, state?: RpcMockState): Promise<void> {
  for (const endpoint of [...ETHEREUM_RPC_ROUTES, ...POLYGON_RPC_ROUTES]) {
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
      let minedReceipt: boolean | null = null
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
              return (minedReceipt ?? successfulBroadcasts > 0)
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
        setMinedReceipt(value: boolean) {
          minedReceipt = value
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

test('loads both production chunks on a cold visit and a Chinese reload without missing assets', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  const assets: Array<{ path: string; status: number }> = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js'))
      assets.push({ path: url.pathname, status: response.status() })
  })
  await page.goto('/')
  await expect(
    page.getByRole('button', { name: 'Connect Wallet', exact: true }).first()
  ).toBeVisible()
  expect(assets).toHaveLength(2)
  const paths = assets.map(({ path }) => path).sort()
  expect(paths.some((path) => /vendor-ethers-[\w-]+\.js$/.test(path))).toBe(true)
  expect(assets.every(({ status }) => status === 200)).toBe(true)
  await expect(page.locator('link[rel="modulepreload"][href*="vendor-ethers-"]')).toHaveCount(1)
  await page.getByTestId('language-selector').selectOption('zh-Hant')
  assets.length = 0
  await page.reload()
  await expect(page.getByRole('button', { name: '連接錢包', exact: true }).first()).toBeVisible()
  expect(assets.map(({ path }) => path).sort()).toEqual(paths)
  expect(assets.every(({ status }) => status === 200)).toBe(true)
  expect(errors).toEqual([])
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
  const networkMessage =
    'No configured RPC endpoint responded on the expected network. Your RPC list was preserved. Check internet access, DNS, firewall, and proxy/VPN settings, then retry; or change endpoints in RPC settings.'
  await expect(page.locator('.err-banner')).toHaveText(networkMessage)
  const pendingError = page.locator('p.dim[role="status"]').filter({
    hasText: 'Blocked: pending transaction check failed'
  })
  await expect(pendingError).toContainText(networkMessage)
  await expect(page.locator('body')).not.toContainText('RPC_UNAVAILABLE')
  await captureQaScreenshot(page, 'rpc-network-unavailable')
  const requestsBeforeRecheck = rpc.requestCount()

  await page.getByRole('button', { name: 'Recheck RPC' }).click()

  await expect.poll(rpc.requestCount).toBeGreaterThan(requestsBeforeRecheck)
  await expect(page.getByText(/Chain reads and transactions are blocked/)).toBeVisible()

  rpc.setAvailable(true)
  await page.getByRole('button', { name: 'Recheck RPC' }).click()

  await expect(page.getByText(/No usable Ethereum RPC endpoints/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  await expect(page.locator('.err-banner')).toHaveCount(0)
  await expect(pendingError).toHaveCount(0)
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
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

test('the unsupported desktop guard keeps the language control centered in both languages', async ({
  browser,
  baseURL
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0'
  })
  try {
    const page = await context.newPage()
    await mockSameOriginRpc(page)
    await page.goto('/')
    const guard = page.getByRole('alertdialog')
    await expect(guard).toBeVisible()
    for (const language of ['en', 'zh-Hant']) {
      await guard.getByTestId('language-selector').selectOption(language)
      const panel = await guard.locator('.chrome-guard__panel').boundingBox()
      const control = await guard.locator('.language-control').boundingBox()
      expect(
        Math.abs(control!.x + control!.width / 2 - panel!.x - panel!.width / 2)
      ).toBeLessThanOrEqual(1)
      await captureQaScreenshot(page, `desktop-guard-${language}`)
    }
  } finally {
    await context.close()
  }
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
  await expect(page.getByRole('combobox', { name: 'Network', exact: true })).toHaveValue('eth')
  await page.waitForTimeout(250)
  expect(nonceReads).toBe(0)

  await page.evaluate((account) => window.__walletMock.emitAccounts([account]), ACCOUNT_B)
  await expect(page.getByRole('button', { name: '0x2222...2222' }).first()).toBeVisible()

  await page.evaluate(() => window.__walletMock.emitChain('0x89'))
  await expect(page.getByRole('combobox', { name: 'Network', exact: true })).toHaveValue('polygon')
})

test('paused-clock readiness waits for delayed wallet nonce checks without bypassing the gate', async ({
  page
}) => {
  await page.clock.install()
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
  await page.evaluate(() => {
    const provider = (
      window as unknown as {
        ethereum: { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
      }
    ).ethereum
    const request = provider.request.bind(provider)
    provider.request = async (args) => {
      if (args.method === 'eth_getTransactionCount') {
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
      return request(args)
    }
  })
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
  await expect(mint).toBeDisabled()
  await expectEnabledWithClock(page, mint)
  await expect(mint).toBeEnabled()
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
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
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  const timeoutMessage =
    'Wallet or network read timed out. Wallet eth_getTransactionCount exceeded 15000 ms. Check your connection and wallet, then recheck transaction records. Do not resend.'
  await expect(page.locator('.modal-body .err-text')).toHaveText(timeoutMessage, {
    timeout: 17_000
  })
  await expect(page.getByRole('region', { name: 'Transaction activity' })).toContainText(
    `Pending check failed: ${timeoutMessage}`
  )
  await expect(page.getByText(/READ_TIMEOUT/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await captureQaScreenshot(page, 'nonce-timeout-detail')
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

for (const { width, stableGutter } of [1280, 390].flatMap((width) =>
  [false, true].map((stableGutter) => ({ width, stableGutter }))
)) {
  test(`manual hash tracking explains a real wallet read timeout and allows a safe retry (${width}px${stableGutter ? ', stable gutter' : ''})`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.clock.install()
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    if (stableGutter) {
      await page.addStyleTag({ content: 'html { overflow-y: scroll; scrollbar-gutter: stable; }' })
    }
    await expect(page.getByRole('heading', { name: 'XENTurbo XEN Miner' })).toBeVisible()
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
    await expect(mint).toBeEnabled()
    await expect(page.locator('tbody tr')).toHaveCount(1)
    const layoutBefore = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      scrollbarGutter: getComputedStyle(document.documentElement).scrollbarGutter
    }))
    if (stableGutter) expect(layoutBefore.scrollbarGutter).toBe('stable')
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
    await page.evaluate(() => {
      const provider = (
        window as unknown as {
          ethereum: { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
        }
      ).ethereum
      const request = provider.request.bind(provider)
      window.__trackingReads = 0
      window.__walletMock.setStalled('eth_getTransactionByHash', true)
      provider.request = async (args) => {
        if (args.method === 'eth_getTransactionByHash') window.__trackingReads += 1
        return request(args)
      }
    })
    const storedRecords = () =>
      page.evaluate(() =>
        Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) => key.startsWith('sm.pendingOps') || key === 'sm.vmuLocks')
            .map((key) => [key, localStorage.getItem(key)])
        )
      )
    const original = await storedRecords()
    await page.locator('.paste-input').fill(TX_HASH)
    await page.getByRole('button', { name: 'Track', exact: true }).click()
    await expect
      .poll(async () => {
        await page.clock.runFor(50)
        return page.evaluate(() => window.__trackingReads)
      })
      .toBe(1)
    await page.clock.runFor(15_001)
    const warning = page.locator('.warn-card')
    await expect(warning).toContainText('Wallet or network read timed out.')
    await expect(warning).toContainText('Wallet eth_getTransactionByHash exceeded 15000 ms.')
    await expect(warning).toContainText('Do not resend.')
    await expect(warning).not.toContainText('READ_TIMEOUT')
    await warning.scrollIntoViewIfNeeded()
    await expect(warning).toBeInViewport()
    const layoutAfter = await warning.evaluate((element) => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth
    }))
    await test.info().attach('manual-track-layout', {
      body: JSON.stringify({ before: layoutBefore, after: layoutAfter }),
      contentType: 'application/json'
    })
    // Verify this warning fits and adds no overflow; the rest of the narrow desktop layout is unchanged.
    expect(layoutAfter.documentWidth).toBe(layoutBefore.documentWidth)
    expect(layoutAfter.documentClientWidth).toBe(layoutBefore.documentClientWidth)
    expect(layoutAfter.left).toBeGreaterThanOrEqual(0)
    expect(layoutAfter.right).toBeLessThanOrEqual(layoutAfter.viewportWidth)
    expect(layoutAfter.scrollWidth).toBeLessThanOrEqual(layoutAfter.clientWidth)
    expect(await storedRecords()).toEqual(original)
    await expect(mint).toBeEnabled()
    await captureQaScreenshot(
      page,
      `manual-track-timeout-${width}${stableGutter ? '-stable-gutter' : ''}`
    )

    await page.evaluate(() => window.__walletMock.setStalled('eth_getTransactionByHash', false))
    await page.locator('.paste-input').fill(TX_HASH)
    await page.getByRole('button', { name: 'Track', exact: true }).click()
    await expect
      .poll(async () => {
        await page.clock.runFor(50)
        return (await warning.allTextContents()).join('')
      })
      .toBe('Transaction not found through the wallet. Check the hash / network.')
    expect(await page.evaluate(() => window.__trackingReads)).toBe(2)
    expect(await storedRecords()).toEqual(original)
    await expect(mint).toBeEnabled()
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 0,
      successfulBroadcasts: 0
    })
    expect(errors).toEqual([])
  })
}

for (const width of [1280, 390]) {
  for (const kind of ['count', 'length'] as const) {
    test(`legacy RPC configuration ${kind} has actionable Track guidance and recovers after an explicit correction (${width}px)`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await emulateDesktopGoogleChrome(page)
      await mockSameOriginRpc(page)
      await installInjectedWallet(page)
      const urls =
        kind === 'count'
          ? Array.from({ length: 17 }, (_, index) => `https://legacy-rpc${index}.example/`)
          : [`https://legacy-rpc.example/${'x'.repeat(2048)}`]
      const stored = JSON.stringify({ eth: urls })
      await page.addInitScript((value) => localStorage.setItem('sm.customRpc', value), stored)
      let invalidEndpointRequests = 0
      await page.route(/^https:\/\/legacy-rpc[0-9]*\.example\//, async (route) => {
        invalidEndpointRequests += 1
        await route.abort()
      })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'XENTurbo XEN Miner' })).toBeVisible()
      await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
      const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
      await expect(mint).toBeDisabled()
      const banner = page.locator('.rpc-health-banner')
      const reason = kind === 'count' ? 'Use at most 16 RPC endpoints' : '2048 characters'
      await expect(banner).toContainText(reason)
      await page.locator('.paste-input').fill(TX_HASH)
      await page.getByRole('button', { name: 'Track', exact: true }).click()
      const warning = page.locator('.warn-card')
      await expect(warning).toContainText(`RPC configuration is invalid:`)
      await expect(warning).toContainText(reason)
      await expect(warning).toContainText('Open the RPC settings')
      await expect(warning).not.toContainText('Check internet access')
      await expect(warning).not.toContainText('RPC_UNAVAILABLE')
      await expect(warning).toHaveText(await banner.locator(':scope > span').innerText())
      const listError = page.locator('.err-banner')
      const pendingError = page.locator('p.dim[role="status"]').filter({
        hasText: 'Blocked: pending transaction check failed'
      })
      await expect(listError).toHaveText(await banner.locator(':scope > span').innerText())
      await expect(pendingError).toContainText(reason)
      await expect(pendingError).toContainText('Open the RPC settings')
      await expect(pendingError).not.toContainText('Check internet access')
      await expect(page.locator('body')).not.toContainText('RPC_UNAVAILABLE')
      expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBe(stored)
      expect(invalidEndpointRequests).toBe(0)
      await expect(mint).toBeDisabled()
      await warning.scrollIntoViewIfNeeded()
      await expect(warning).toBeInViewport()
      const layout = await warning.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        viewport: innerWidth,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth
      }))
      expect(layout.left).toBeGreaterThanOrEqual(0)
      expect(layout.right).toBeLessThanOrEqual(layout.viewport)
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
      await captureQaScreenshot(page, `rpc-config-${kind}-${width}`)

      await page.getByRole('button', { name: 'RPC', exact: true }).click()
      await page.locator('textarea').fill('https://ethereum.publicnode.com/')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(mint).toBeEnabled()
      await expect(banner).toHaveCount(0)
      await expect(listError).toHaveCount(0)
      await expect(pendingError).toHaveCount(0)
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('sm.customRpc')!).eth)
      ).toEqual(['https://ethereum.publicnode.com/'])
      await page.locator('.paste-input').fill(TX_HASH)
      await page.getByRole('button', { name: 'Track', exact: true }).click()
      await expect(warning).toHaveText(
        'Transaction not found through the wallet. Check the hash / network.'
      )
      await expect(mint).toBeEnabled()
      expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
        sendAttempts: 0,
        successfulBroadcasts: 0
      })
      expect(errors).toEqual([])
    })
  }
}

for (const width of [1280, 390]) {
  test(`selected claim actions explain invalid RPC configuration and recover after correction (${width}px)`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    let invalidEndpointRequests = 0
    await page.route(/^https:\/\/legacy-rpc[0-9]*\.example\//, async (route) => {
      invalidEndpointRequests += 1
      await route.abort()
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
    await expect(mint).toBeEnabled()
    const checkbox = page.locator('tbody input[type="checkbox"]').first()
    await checkbox.click()
    await expect(page.getByText('1 VMUs selected')).toBeVisible()
    const stored = JSON.stringify({
      eth: Array.from({ length: 17 }, (_, index) => `https://legacy-rpc${index}.example/`)
    })
    await page.evaluate((value) => localStorage.setItem('sm.customRpc', value), stored)
    await page.locator('.paste-input').fill(TX_HASH)
    await page.getByRole('button', { name: 'Track', exact: true }).click()
    const reason = page.locator('.action-bar .blocked-reason')
    await expect(reason).toHaveText(
      'Blocked: invalid Ethereum RPC configuration. Open RPC settings to correct it.'
    )
    await expect(checkbox).toBeChecked()
    const claim = page.getByRole('button', { name: 'Claim only', exact: true })
    const remint = page.getByRole('button', { name: 'Claim & Re-Mint (100d)', exact: true })
    await expect(claim).toBeDisabled()
    await expect(remint).toBeDisabled()
    await expect(mint).toBeDisabled()
    expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBe(stored)
    expect(invalidEndpointRequests).toBe(0)
    await captureQaScreenshot(page, `selected-rpc-config-${width}`)

    await page.getByRole('button', { name: 'RPC', exact: true }).click()
    await page.locator('textarea').fill('https://ethereum.publicnode.com/')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(mint).toBeEnabled()
    await expect(checkbox).not.toBeChecked()
    await checkbox.click()
    await expect(claim).toBeEnabled()
    await expect(remint).toBeEnabled()
    await expect(reason).toHaveCount(0)
    expect(invalidEndpointRequests).toBe(0)
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 0,
      successfulBroadcasts: 0
    })
    expect(errors).toEqual([])
  })
}

test('marking an unknown transaction dropped explains storage failure without clearing its gate', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  const original = await page.evaluate(
    ({ wallet, hash }) => {
      const record = {
        id: 'manual-drop-fixture',
        chain: 'eth',
        wallet,
        op: 'CLAIM',
        ids: [1],
        count: 1,
        term: 0,
        txHash: hash,
        nonce: null,
        phase: 'broadcast',
        submittedAt: Date.now(),
        updatedAt: Date.now(),
        origin: 'local'
      }
      const raw = JSON.stringify({ recordId: record.id, updatedAt: record.updatedAt, record })
      localStorage.setItem('sm.pendingOps.event.manual-drop-fixture', raw)
      return raw
    },
    { wallet: ACCOUNT_A, hash: TX_HASH }
  )
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const drop = page.getByRole('button', { name: 'Mark dropped', exact: true })
  const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
  await expect(drop).toBeVisible()
  await expect(page.getByRole('button', { name: 'Recheck', exact: true })).toBeEnabled()
  await expect(mint).toBeDisabled()
  page.once('dialog', (dialog) => dialog.dismiss())
  await drop.click()
  expect(
    await page.evaluate(() => localStorage.getItem('sm.pendingOps.event.manual-drop-fixture'))
  ).toBe(original)
  await expect(mint).toBeDisabled()

  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith('sm.pendingOps.event.'))
        throw new DOMException('Offline storage write fixture', 'QuotaExceededError')
      return set.call(this, key, value)
    }
    window.__restoreStorage = () => {
      Storage.prototype.setItem = set
    }
  })
  page.once('dialog', (dialog) => dialog.accept())
  await drop.click()
  await expect(page.locator('.warn-card')).toContainText(
    'Local transaction storage is unavailable or damaged.'
  )
  await expect(page.locator('.warn-card')).toContainText('Open transaction storage recovery.')
  await expect(page.locator('.warn-card')).toContainText('Do not clear site data or resend')
  await expect(page.locator('.warn-card')).not.toContainText('PENDING_STORAGE_WRITE_FAILED')
  expect(
    await page.evaluate(() => localStorage.getItem('sm.pendingOps.event.manual-drop-fixture'))
  ).toBe(original)
  await expect(mint).toBeDisabled()
  await expect(drop).toBeVisible()
  await captureQaScreenshot(page, 'manual-drop-storage-failure')

  await page.evaluate(() => window.__restoreStorage?.())
  page.once('dialog', (dialog) => dialog.accept())
  await drop.click()
  await expect(mint).toBeEnabled()
  await expect(page.locator('.warn-card')).toHaveCount(0)
  await expect(drop).toHaveCount(0)
  const dropped = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('sm.pendingOps.event.'))
      .map((key) => JSON.parse(localStorage.getItem(key)!).record)
      .filter((record) => record?.id === 'manual-drop-fixture' && record.phase === 'dropped')
  )
  expect(dropped).toHaveLength(1)
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  expect(errors).toEqual([])
})

test('prepared signing stays blocked if a shared pending check fails during a trailing retry', async ({
  page
}) => {
  await page.clock.install()
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  // Freeze before wallet connection starts the idle poll; host delays cannot age its deadline.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expectEnabledWithClock(page, page.getByRole('button', { name: 'Confirm Mint' }))
  await page.getByRole('button', { name: 'Confirm Mint' }).click()
  await expect
    .poll(
      async () => {
        await page.clock.runFor(50)
        return page.getByRole('button', { name: 'Open MetaMask & Sign' }).isVisible()
      },
      { timeout: 15_000, intervals: [100] }
    )
    .toBe(true)
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
        // Require the polling helper to handle delayed dispatch on the paused clock.
        await new Promise((resolve) => setTimeout(resolve, 600))
        window.__pendingCheckGate.reads += 1
        if (window.__pendingCheckGate.reads <= 2) return first
        await retry
      }
      return original(args)
    }
  })
  await page.clock.runFor(30_001)
  await expectPendingNonceReads(page, 2)
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  await page.evaluate(() => window.__pendingCheckGate.reject())
  await expectPendingNonceReads(page, 4)
  await expect(page.locator('.modal-body .err-text')).toContainText('Pending check offline fixture')
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  await page.evaluate(() => window.__pendingCheckGate.release())
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expectEnabledWithClock(page, page.getByRole('button', { name: 'Confirm Mint' }))
  expect(await page.evaluate(() => window.__pendingCheckGate.reads)).toBe(4)
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
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
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
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
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'XENTurbo XEN Miner' })).toBeVisible()
  await page.clock.runFor(15_100)
  await expect(page.locator('.connect-err')).toContainText('Wallet connection read timed out.')
  await expect(page.locator('.connect-err')).toContainText(
    'Initial wallet accounts exceeded 15000 ms.'
  )
  await expect(page.locator('.connect-err')).not.toContainText('READ_TIMEOUT')
  await captureQaScreenshot(page, 'wallet-init-timeout-detail')

  await page.evaluate(() => window.__walletMock.setStalled('eth_accounts', false))
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: '0x1111...1111' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 0,
    successfulBroadcasts: 0
  })
  expect(errors).toEqual([])
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

for (const stage of ['preparing', 'send-preflight'] as const) {
  test(`waits for ${stage} cleanup after an automatic refresh before retrying the same VMU`, async ({
    page
  }) => {
    await page.clock.install()
    await emulateDesktopGoogleChrome(page)
    const state: RpcMockState = {
      vmuCount: 2,
      maturityVmuId: 2,
      maturityTimestamp: BLOCK_TIMESTAMP + 5
    }
    await mockSameOriginRpc(page, state)
    await installInjectedWallet(page)
    let hold = false
    let held = 0
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const endpoint of ETHEREUM_RPC_ROUTES) {
      await page.route(endpoint, async (route) => {
        const payload = route.request().postDataJSON()
        const calls = (Array.isArray(payload) ? payload : [payload]) as Array<{
          method: string
          params: unknown[]
        }>
        const selectedRead = calls.some(({ method, params }) => {
          const call = params[0] as { to?: string; data?: string } | undefined
          return (
            method === 'eth_call' &&
            call?.to?.toLowerCase() === MULTICALL.toLowerCase() &&
            multicallInterface.decodeFunctionData('aggregate3', call.data!).calls.length === 1
          )
        })
        if (
          hold &&
          (stage === 'preparing'
            ? calls.some((call) => call.method === 'eth_estimateGas')
            : selectedRead)
        ) {
          held += 1
          await delayed
        }
        return route.fallback()
      })
    }
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeEnabled()
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100))
    await page.locator('tbody input[type="checkbox"]').first().check()
    hold = stage === 'preparing'
    await page.getByRole('button', { name: 'Claim only', exact: true }).click()
    if (stage === 'send-preflight') {
      await expectEnabledWithClock(page, page.getByRole('button', { name: 'Open MetaMask & Sign' }))
      hold = true
      await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
    }
    await expect
      .poll(async () => {
        await page.clock.runFor(50)
        return held
      })
      .toBe(1)
    try {
      state.blockTimestamp = BLOCK_TIMESTAMP + 10
      await expect
        .poll(
          async () => {
            await page.clock.runFor(100)
            const error = page.locator('.modal-body .err-text')
            return (await error.count()) ? error.textContent() : ''
          },
          { timeout: 15_000, intervals: [50] }
        )
        .toContain('No transaction was submitted.')
      await expect(page.locator('.modal-body .err-text')).toContainText(
        'No transaction was submitted.'
      )
      await expect
        .poll(
          async () => {
            await page.clock.runFor(50)
            return page.getByTestId('stale-vmu-warning').count()
          },
          { timeout: 15_000, intervals: [100] }
        )
        .toBe(0)
      await expect(page.getByTestId('operation-blocked-reason')).toContainText(
        'previous operation to finish cancelling'
      )
      await page.getByRole('button', { name: 'Close transaction dialog' }).click()
      await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeDisabled()
      // Selection is allowed while busy, but retrying the same VMU must stay blocked.
      // Both rows are now mature; the last group contains the original VMU.
      await page.locator('tbody input[type="checkbox"]').last().check()
      await expect(page.getByRole('button', { name: 'Claim only', exact: true })).toBeDisabled()
      await expect(
        page.getByRole('button', { name: 'Claim & Re-Mint (100d)', exact: true })
      ).toBeDisabled()
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]'))
      ).toContainEqual(expect.objectContaining({ ids: [1] }))
      await page.getByTestId('language-selector').selectOption('zh-Hant')
      await expect(page.getByTestId('operation-blocked-reason')).toContainText(
        '等待前一次操作完成取消'
      )
      await captureQaScreenshot(page, `refresh-cancelling-${stage}-zh`)
      hold = false
      release()
      await expectEnabledWithClock(
        page,
        page.getByRole('button', { name: '確認鑄造', exact: true })
      )
      await expect(page.getByTestId('operation-blocked-reason')).toHaveCount(0)
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]'))
      ).toEqual([])
      await expect(page.getByRole('button', { name: '僅領取', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: '僅領取', exact: true }).click()
      await expectEnabledWithClock(page, page.getByRole('button', { name: '開啟 MetaMask 並簽署' }))
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]'))
      ).toContainEqual(expect.objectContaining({ ids: [1] }))
      await expect(page.locator('.modal-body .err-text')).toHaveCount(0)
      await captureQaScreenshot(page, `refresh-retry-${stage}-zh`)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
        sendAttempts: 0,
        successfulBroadcasts: 0
      })
      expect(errors).toEqual([])
    } finally {
      hold = false
      release()
    }
  })
}

for (const change of ['account', 'chain', 'disconnect'] as const) {
  test(`closes an in-flight preparation on ${change} and ignores its late response`, async ({
    page
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    let held = 0
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    for (const endpoint of ETHEREUM_RPC_ROUTES) {
      await page.route(endpoint, async (route) => {
        const payload = route.request().postDataJSON()
        if (
          (Array.isArray(payload) ? payload : [payload]).some(
            (call: { method: string }) => call.method === 'eth_estimateGas'
          )
        ) {
          held += 1
          await delayed
        }
        return route.fallback()
      })
    }
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Confirm Mint', exact: true }).click()
    await expect.poll(() => held).toBe(1)
    await expect(page.locator('.modal-body')).toBeVisible()
    try {
      await page.evaluate(
        ({ change, account }) => {
          if (change === 'chain') window.__walletMock.emitChain('0x89')
          else window.__walletMock.emitAccounts(change === 'disconnect' ? [] : [account])
        },
        { change, account: ACCOUNT_B }
      )
      await expect(page.locator('.modal-body')).toHaveCount(0)
      release()
      if (change === 'disconnect')
        await expect(page.getByRole('button', { name: 'Connect Wallet' }).first()).toBeVisible()
      else
        await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeEnabled()
      await expect(page.locator('.modal-body')).toHaveCount(0)
      expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
        sendAttempts: 0,
        successfulBroadcasts: 0
      })
    } finally {
      release()
    }
  })
}

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
  await expect(page.locator('.modal-body .err-text')).toHaveText(
    'Transaction submitted, but confirmation could not be completed. Do not resend. Check wallet Activity and the explorer, then recheck pending operations.'
  )
  await page.getByTestId('language-selector').selectOption('zh-Hant')
  await expect(page.locator('.modal-body .err-text')).toContainText('請勿重送')
  await captureQaScreenshot(page, 'late-hash-do-not-resend-zh')
  await page.getByTestId('language-selector').selectOption('en')
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

test.describe('Traditional Chinese interface', () => {
  test.use({ locale: 'zh-TW' })

  for (const chainId of [1, 137] as const) {
    for (const method of [
      'eth_getTransactionCount',
      'eth_estimateGas',
      'eth_getBlockByNumber'
    ] as const) {
      for (const failure of ['http-429', 'json-rate-limit'] as const) {
        test(`explains a preflight RPC rate limit (${chainId}, ${method}, ${failure}) without signing or retaining a soft lock`, async ({
          page
        }) => {
          await emulateDesktopGoogleChrome(page)
          const state: RpcMockState = { vmuCount: 2 }
          await mockSameOriginRpc(page, state)
          await installInjectedWallet(page)
          let limited = false
          const healthyProbes: string[] = []
          const failedCalls: Array<{ url: string; params: unknown[] }> = []
          const errors: string[] = []
          const unexpected: string[] = []
          const endpoints = chainId === 1 ? ETHEREUM_RPC_ROUTES : POLYGON_RPC_ROUTES
          page.on('pageerror', (error) => errors.push(error.message))
          await page.route('https://**/*', async (route) => {
            const url = route.request().url()
            if (url === 'https://gasstation.polygon.technology/v2')
              return route.fulfill({ json: { standard: { maxFee: 40, maxPriorityFee: 30 } } })
            if (
              ![...ETHEREUM_RPC_ROUTES, ...POLYGON_RPC_ROUTES].some((pattern) => pattern.test(url))
            ) {
              unexpected.push(url)
              return route.abort()
            }
            const payload = route.request().postDataJSON() as
              | { id: number; method: string; params: unknown[] }
              | Array<{ id: number; method: string; params: unknown[] }>
            const batch = Array.isArray(payload) ? payload : [payload]
            if (limited && endpoints.some((pattern) => pattern.test(url))) {
              const isHealthProbe =
                batch.some((call) => call.method === 'eth_getBlockByNumber') &&
                batch.some((call) => {
                  const tx = call.params[0] as { to?: string; data?: string } | undefined
                  return (
                    call.method === 'eth_call' &&
                    tx?.to?.toLowerCase() === FACTORY.toLowerCase() &&
                    tx.data === factoryInterface.getFunction('FEE')!.selector
                  )
                })
              // Keep availability probes healthy; fail the subsequent direct preflight read.
              if (isHealthProbe) {
                healthyProbes.push(url)
                return route.fallback()
              }
              const targets = batch.filter((call) => call.method === method)
              if (targets.length) {
                for (const call of targets) failedCalls.push({ url, params: call.params })
                if (failure === 'http-429')
                  return route.fulfill({ status: 429, body: 'Fixture rate limit' })
                const replies = batch.map((call) => ({
                  jsonrpc: '2.0',
                  id: call.id,
                  ...(call.method === method
                    ? { error: { code: -32005, message: 'project ID request rate exceeded' } }
                    : { result: rpcResult(call.method, chainId, call.params, state) })
                }))
                return route.fulfill({ json: Array.isArray(payload) ? replies : replies[0] })
              }
            }
            return route.fallback()
          })

          await page.goto('/')
          await expect(page).toHaveTitle('XENTurbo XEN Miner')
          await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
          await page.evaluate(
            (id) => window.__walletMock.emitChain(id),
            `0x${chainId.toString(16)}`
          )
          await page.getByRole('button', { name: '連接錢包' }).first().click()
          await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
          await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
          // Mint has no selected-ID timestamp read, so its block failure targets gas preflight.
          const isMint = method === 'eth_getBlockByNumber'
          if (!isMint) await page.locator('tbody input[type="checkbox"]').first().check()
          // Expire ethers' 250ms latest-block cache so the block case reaches the transport.
          if (isMint) await page.waitForTimeout(300)
          limited = true
          await page
            .getByRole('button', { name: isMint ? '確認鑄造' : '僅領取', exact: true })
            .click()
          const chinese = 'RPC 節點受到限流。請稍候再重試。RPC 清單已保留。'
          const english =
            'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
          await expect(page.locator('.modal-body .err-text')).toHaveText(chinese)
          await expect(page.getByTestId('tx-log')).toContainText(`準備失敗：${chinese}`)
          await expect(page.getByRole('button', { name: '開啟 MetaMask 並簽署' })).toHaveCount(0)
          await expect(page.locator('.modal-body')).not.toContainText('missing revert data')
          await expect(page.locator('.modal-body')).not.toContainText('server response 429')
          expect(
            await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]'))
          ).toEqual([])
          // Submit reconciliation, preparation, and failure reconciliation each probe the pool.
          await expect.poll(() => healthyProbes.length).toBe(12)
          for (const endpoint of endpoints) {
            expect(healthyProbes.filter((url) => endpoint.test(url))).toHaveLength(3)
            const calls = failedCalls.filter(({ url }) => endpoint.test(url))
            if (method === 'eth_getTransactionCount') {
              expect(calls.filter(({ params }) => params[1] === 'latest')).toHaveLength(1)
              expect(calls.filter(({ params }) => params[1] === 'pending')).toHaveLength(1)
            } else {
              expect(calls).toHaveLength(1)
            }
          }
          await captureQaScreenshot(page, `preflight-rate-${chainId}-${method}-${failure}-zh`)
          await page.getByTestId('language-selector').selectOption('en')
          await expect(page.locator('.modal-body .err-text')).toHaveText(english)
          await expect(page.getByTestId('tx-log')).toContainText(`Preparation failed: ${english}`)
          await page.getByRole('button', { name: 'Close', exact: true }).click()
          limited = false
          // A rejected direct read is also cached for 250ms; recovery must make a fresh read.
          await page.waitForTimeout(300)
          await page
            .getByRole('button', { name: isMint ? 'Confirm Mint' : 'Claim only', exact: true })
            .click()
          await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
          expect(
            await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]'))
          ).toHaveLength(isMint ? 0 : 1)
          await page.getByRole('button', { name: 'Cancel', exact: true }).click()
          await expect(page.locator('.modal-body .err-text')).toHaveText(
            'Preparation cancelled. No transaction was submitted.'
          )
          await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toHaveCount(0)
          expect(
            await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]'))
          ).toEqual([])
          await page.getByRole('button', { name: 'Close', exact: true }).click()
          await expect(page.locator('.modal-mask')).toHaveCount(0)
          expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
            sendAttempts: 0,
            successfulBroadcasts: 0
          })
          expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBeNull()
          expect(errors).toEqual([])
          expect(unexpected).toEqual([])
        })
      }
    }
  }

  for (const chainId of [1, 137] as const) {
    for (const failure of [
      'no-retry-after',
      'hidden-retry-after',
      'json-rate-limit',
      'visible-retry-after'
    ] as const) {
      test(`explains an exhausted RPC rate limit (${chainId}, ${failure}) and restores the list without signing`, async ({
        page
      }) => {
        await emulateDesktopGoogleChrome(page)
        await mockSameOriginRpc(page, { vmuCount: 2 })
        await installInjectedWallet(page)
        await page.addInitScript(() => {
          const originalFetch = window.fetch
          window.__rateLimitHeaders = []
          window.fetch = async (...args) => {
            const response = await originalFetch(...args)
            if (response.status === 429)
              window.__rateLimitHeaders.push(response.headers.get('retry-after'))
            return response
          }
        })
        let limited = false
        const limitedPosts: string[] = []
        const batchSizes: number[] = []
        const errors: string[] = []
        const unexpected: string[] = []
        const endpoints = chainId === 1 ? ETHEREUM_RPC_ROUTES : POLYGON_RPC_ROUTES
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('https://**/*', async (route) => {
          const url = route.request().url()
          if (url === 'https://gasstation.polygon.technology/v2')
            return route.fulfill({ json: { standard: { maxFee: 40, maxPriorityFee: 30 } } })
          if (
            ![...ETHEREUM_RPC_ROUTES, ...POLYGON_RPC_ROUTES].some((pattern) => pattern.test(url))
          ) {
            unexpected.push(url)
            return route.abort()
          }
          const payload = route.request().postDataJSON() as
            | { id: number; method: string; params: unknown[] }
            | Array<{ id: number; method: string; params: unknown[] }>
          const batch = Array.isArray(payload) ? payload : [payload]
          batchSizes.push(batch.length)
          const isCount = (call: (typeof batch)[number]) => {
            const transaction = call.params[0] as { to?: string; data?: string } | undefined
            return (
              call.method === 'eth_call' &&
              transaction?.to?.toLowerCase() === FACTORY.toLowerCase() &&
              transaction.data?.startsWith(factoryInterface.getFunction('vmuCount')!.selector)
            )
          }
          if (limited && batch.some(isCount) && endpoints.some((pattern) => pattern.test(url))) {
            limitedPosts.push(url)
            if (failure === 'json-rate-limit') {
              const replies = batch.map((call) =>
                isCount(call)
                  ? {
                      jsonrpc: '2.0',
                      id: call.id,
                      error: { code: -32005, message: 'project ID request rate exceeded' }
                    }
                  : {
                      jsonrpc: '2.0',
                      id: call.id,
                      result: rpcResult(call.method, chainId, call.params, { vmuCount: 2 })
                    }
              )
              return route.fulfill({ json: Array.isArray(payload) ? replies : replies[0] })
            }
            const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }
            if (failure !== 'no-retry-after') headers['Retry-After'] = '1'
            if (failure === 'visible-retry-after')
              headers['Access-Control-Expose-Headers'] = 'Retry-After'
            return route.fulfill({ status: 429, headers, body: 'Fixture rate limit' })
          }
          return route.fallback()
        })
        await page.goto('/')
        await expect(page).toHaveTitle('XENTurbo XEN Miner')
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
        await page.evaluate((id) => window.__walletMock.emitChain(id), `0x${chainId.toString(16)}`)
        await page.getByRole('button', { name: '連接錢包' }).first().click()
        await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
        await expect(page.getByRole('button', { name: '重新整理', exact: true })).toBeEnabled()
        const oldRows = await page.locator('tbody tr').allTextContents()
        await page.locator('tbody input[type="checkbox"]').first().check()
        await expect(page.locator('.action-bar')).toBeVisible()
        limited = true
        await page.getByRole('button', { name: '重新整理', exact: true }).click()
        await expect(
          page.getByRole('button', { name: '正在重新整理…', exact: true })
        ).toBeDisabled()
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
        await expect(page.locator('.action-bar')).toHaveCount(0)
        await expect(page.locator('tbody input[type="checkbox"]').first()).toBeDisabled()
        const chinese =
          failure === 'visible-retry-after'
            ? 'RPC 節點受到限流。請於 1 秒後重試。RPC 清單已保留。'
            : 'RPC 節點受到限流。請稍候再重試。RPC 清單已保留。'
        const english =
          failure === 'visible-retry-after'
            ? 'RPC endpoints are rate-limited. Retry in 1s. Your RPC list was preserved.'
            : 'RPC endpoints are rate-limited. Please wait and retry. Your RPC list was preserved.'
        await expect(page.locator('.err-banner')).toHaveText(chinese, { timeout: 10_000 })
        await expect(page.getByRole('button', { name: '重新整理', exact: true })).toBeEnabled()
        // Retry backoff >= pool cooldown (both 1s); equality is eligible, not a skipped attempt.
        expect(limitedPosts).toHaveLength(16)
        for (const endpoint of endpoints)
          expect(limitedPosts.filter((url) => endpoint.test(url))).toHaveLength(4)
        expect(await page.evaluate(() => window.__rateLimitHeaders)).toEqual(
          failure === 'json-rate-limit'
            ? []
            : Array(16).fill(failure === 'visible-retry-after' ? '1' : null)
        )
        await expect(page.locator('body')).not.toContainText('missing revert data')
        await expect(page.locator('body')).not.toContainText('server response 429')
        expect(await page.locator('tbody tr').allTextContents()).toEqual(oldRows)
        await expect(page.getByTestId('stale-vmu-warning')).toContainText(
          '目前顯示先前載入的 VMU 資料，可能已過期。完整重新整理成功前，所有交易操作均已停用。'
        )
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('上次載入：')
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
        await captureQaScreenshot(page, `rpc-exhausted-${chainId}-${failure}-zh`)
        await page.getByTestId('language-selector').selectOption('en')
        await expect(page.locator('.err-banner')).toHaveText(english)
        await expect(page.getByTestId('stale-vmu-warning')).toContainText(
          'Previously loaded VMU data may be outdated. Transactions are disabled until a complete refresh succeeds.'
        )
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('Last loaded:')
        await captureQaScreenshot(page, `rpc-exhausted-${chainId}-${failure}-en`)
        await page.getByRole('button', { name: 'RPC', exact: true }).click()
        await expect(page.locator('textarea')).toHaveValue('')
        const defaults = (await page.locator('textarea').getAttribute('placeholder'))!.split('\n')
        expect(defaults).toHaveLength(4)
        endpoints.forEach((endpoint, index) => expect(defaults[index]).toMatch(endpoint))
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        limited = false
        await page.getByRole('button', { name: 'Refresh', exact: true }).click()
        await expect(page.getByTestId('stale-vmu-warning')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeEnabled()
        await expect(page.locator('tbody input[type="checkbox"]').first()).toBeEnabled()
        await expect(page.locator('tbody input[type="checkbox"]').first()).not.toBeChecked()
        await expect(page.locator('.group-note')).toContainText('2 VMUs total')
        await expect(page.locator('.err-banner,.rank-banner,.tag-warn')).toHaveCount(0)
        expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
          sendAttempts: 0,
          successfulBroadcasts: 0
        })
        await page.getByTestId('language-selector').selectOption('zh-Hant')
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
        await expect(page.getByTestId('language-selector')).toHaveValue('zh-Hant')
        await page.evaluate((id) => window.__walletMock.emitChain(id), `0x${chainId.toString(16)}`)
        await page.getByRole('button', { name: '連接錢包' }).first().click()
        await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
        await expect(page.locator('.err-banner,.rank-banner,.tag-warn')).toHaveCount(0)
        expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBeNull()
        expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
          sendAttempts: 0,
          successfulBroadcasts: 0
        })
        expect(batchSizes.every((size) => size <= 3)).toBe(true)
        expect(errors).toEqual([])
        expect(unexpected).toEqual([])
        await captureQaScreenshot(page, `rpc-exhausted-${chainId}-${failure}-recovered-zh`)
      })
    }
  }

  for (const chainId of [1, 137] as const) {
    for (const failure of ['offline', 'partial'] as const) {
      test(`retains a stale snapshot through ${failure}, reload and recovery (${chainId})`, async ({
        page
      }) => {
        await page.setViewportSize({ width: chainId === 1 ? 1280 : 390, height: 900 })
        await emulateDesktopGoogleChrome(page)
        const state: RpcMockState = { vmuCount: 2 }
        await mockSameOriginRpc(page, state)
        await installInjectedWallet(page)
        let unavailable = false
        let holdCount = false
        let release!: () => void
        const delayed = new Promise<void>((resolve) => {
          release = resolve
        })
        const errors: string[] = []
        const unexpected: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('https://**/*', async (route) => {
          const url = route.request().url()
          if (url === 'https://gasstation.polygon.technology/v2')
            return route.fulfill({ json: { standard: { maxFee: 40, maxPriorityFee: 30 } } })
          if (
            ![...ETHEREUM_RPC_ROUTES, ...POLYGON_RPC_ROUTES].some((pattern) => pattern.test(url))
          ) {
            unexpected.push(url)
            return route.abort()
          }
          const payload = route.request().postDataJSON() as
            { method: string; params: unknown[] } | Array<{ method: string; params: unknown[] }>
          const batch = Array.isArray(payload) ? payload : [payload]
          const isCount = batch.some((call) => {
            const transaction = call.params[0] as { to?: string; data?: string } | undefined
            return (
              call.method === 'eth_call' &&
              transaction?.to?.toLowerCase() === FACTORY.toLowerCase() &&
              transaction.data?.startsWith(factoryInterface.getFunction('vmuCount')!.selector)
            )
          })
          if (isCount && holdCount) await delayed
          if (isCount && unavailable)
            return route.fulfill({ status: 401, body: 'Fixture endpoint unavailable' })
          return route.fallback()
        })
        await page.goto('/')
        await page.evaluate((id) => window.__walletMock.emitChain(id), `0x${chainId.toString(16)}`)
        await page.getByRole('button', { name: '連接錢包' }).first().click()
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
        await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
        const rows = await page.locator('tbody tr').allTextContents()
        await page.locator('tbody input[type="checkbox"]').first().check()
        holdCount = true
        unavailable = failure === 'offline'
        state.unreadableVmuId = failure === 'partial' ? 2 : undefined
        await page.getByRole('button', { name: '重新整理', exact: true }).click()
        await expect(
          page.getByRole('button', { name: '正在重新整理…', exact: true })
        ).toBeDisabled()
        expect(await page.locator('tbody tr').allTextContents()).toEqual(rows)
        await expect(page.locator('.action-bar')).toHaveCount(0)
        await expect(page.locator('tbody input[type="checkbox"]').first()).toBeDisabled()
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
        release()
        holdCount = false
        await expect(page.getByRole('button', { name: '重新整理', exact: true })).toBeEnabled()
        await expect(page.locator('.err-banner')).toBeVisible()
        expect(await page.locator('tbody tr').allTextContents()).toEqual(rows)
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('可能已過期')
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('上次載入：')
        await captureQaScreenshot(page, `retained-${chainId}-${failure}-zh`)
        const formReason = page.getByTestId('operation-blocked-reason')
        await expect(formReason).toContainText('完整重新整理成功前，所有交易操作均已停用。')
        const formBox = await page.locator('.form-grid').boundingBox()
        const reasonBox = await formReason.boundingBox()
        expect(reasonBox!.y - (formBox!.y + formBox!.height)).toBeGreaterThanOrEqual(0)
        expect(reasonBox!.y - (formBox!.y + formBox!.height)).toBeLessThan(40)
        expect(reasonBox!.x).toBeGreaterThanOrEqual(0)
        expect(reasonBox!.x + reasonBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
        await page.getByTestId('language-selector').selectOption('en')
        await expect(formReason).toContainText(
          'Transactions are disabled until a complete refresh succeeds.'
        )
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('may be outdated')
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('Last loaded:')
        await captureQaScreenshot(page, `retained-${chainId}-${failure}-en`)
        await page.getByTestId('language-selector').selectOption('zh-Hant')
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
        await expect(page.getByTestId('language-selector')).toHaveValue('zh-Hant')
        await page.evaluate((id) => window.__walletMock.emitChain(id), `0x${chainId.toString(16)}`)
        await page.getByRole('button', { name: '連接錢包' }).first().click()
        await expect(page.getByRole('button', { name: '重新整理', exact: true })).toBeEnabled()
        await expect(page.locator('.err-banner')).toBeVisible()
        await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
        await expect(page.getByTestId('stale-vmu-warning')).toContainText('可能已過期')
        await expect(page.locator('tbody input[type="checkbox"]').first()).toBeDisabled()
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
        expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
          sendAttempts: 0,
          successfulBroadcasts: 0
        })
        const warningBox = await page.getByTestId('stale-vmu-warning').boundingBox()
        const viewport = page.viewportSize()!
        expect(warningBox!.x).toBeGreaterThanOrEqual(0)
        expect(warningBox!.x + warningBox!.width).toBeLessThanOrEqual(viewport.width)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
        unavailable = false
        state.unreadableVmuId = undefined
        state.vmuCount = 3
        await page.getByRole('button', { name: '重新整理', exact: true }).click()
        await expect(page.getByTestId('stale-vmu-warning')).toHaveCount(0)
        await expect(formReason).toHaveCount(0)
        await expect(page.locator('.err-banner')).toHaveCount(0)
        await expect(page.locator('.group-note')).toContainText('共 3 個 VMU')
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
        await expect(page.locator('tbody input[type="checkbox"]').first()).toBeEnabled()
        await expect(page.locator('tbody input[type="checkbox"]').first()).not.toBeChecked()
        await captureQaScreenshot(page, `retained-${chainId}-${failure}-recovered-zh`)
        expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
          sendAttempts: 0,
          successfulBroadcasts: 0
        })
        expect(errors).toEqual([])
        expect(unexpected).toEqual([])
      })
    }
  }

  for (const failure of ['stalled', 'http-503', 'http-429', 'json-rate-limit'] as const) {
    test(`recovers a list read from ${failure} after a successful health check without signing`, async ({
      page
    }) => {
      await emulateDesktopGoogleChrome(page)
      await mockSameOriginRpc(page, { vmuCount: 2 })
      await installInjectedWallet(page)
      const unexpected: string[] = []
      const errors: string[] = []
      const batchSizes: number[] = []
      const used = new Set<string>()
      let firstFailures = 0
      let release!: () => void
      const stalled = new Promise<void>((resolve) => {
        release = resolve
      })
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('https://**/*', async (route) => {
        const url = route.request().url()
        if (![...ETHEREUM_RPC_ROUTES, ...POLYGON_RPC_ROUTES].some((pattern) => pattern.test(url))) {
          unexpected.push(url)
          return route.abort()
        }
        const payload = route.request().postDataJSON() as
          | { id: number; method: string; params: unknown[] }
          | Array<{ id: number; method: string; params: unknown[] }>
        const batch = Array.isArray(payload) ? payload : [payload]
        const isMulticall = (call: (typeof batch)[number]) =>
          call.method === 'eth_call' &&
          (call.params[0] as { to: string }).to.toLowerCase() === MULTICALL.toLowerCase()
        batchSizes.push(batch.length)
        if (batch.some(isMulticall)) {
          used.add(new URL(url).hostname)
          if (ETHEREUM_RPC_ROUTES[0].test(url)) {
            firstFailures += 1
            if (failure === 'stalled') await stalled
            if (failure === 'http-503' || failure === 'http-429')
              return route.fulfill({
                status: failure === 'http-503' ? 503 : 429,
                headers: { 'Retry-After': '1' },
                body: 'temporary failure'
              })
            if (failure === 'json-rate-limit') {
              const replies = batch.map((call) =>
                isMulticall(call)
                  ? {
                      jsonrpc: '2.0',
                      id: call.id,
                      error: { code: -32005, message: 'Too Many Requests' }
                    }
                  : {
                      jsonrpc: '2.0',
                      id: call.id,
                      result: rpcResult(call.method, 1, call.params, { vmuCount: 2 })
                    }
              )
              return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(Array.isArray(payload) ? replies.reverse() : replies[0])
              })
            }
          }
        }
        return route.fallback()
      })
      try {
        await page.goto('/')
        await expect(page).toHaveTitle('XENTurbo XEN Miner')
        await page.getByRole('button', { name: '連接錢包' }).first().click()
        await expect(page.locator('.group-note')).toContainText('共 2 個 VMU', { timeout: 8_000 })
        expect(firstFailures).toBe(1)
        expect(used.has('ethereum-rpc.publicnode.com')).toBe(true)
        await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
        release()
        await page.getByTestId('language-selector').selectOption('en')
        await expect(page.locator('.group-note')).toContainText('2 VMUs total')
        await page.getByTestId('language-selector').selectOption('zh-Hant')
        await page.getByRole('button', { name: '重新整理', exact: true }).click()
        await expect(page.getByRole('button', { name: '重新整理', exact: true })).toBeEnabled()
        await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
        expect(batchSizes.every((size) => size <= 3)).toBe(true)
        expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBeNull()
        expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
          sendAttempts: 0,
          successfulBroadcasts: 0
        })
        expect(unexpected).toEqual([])
        expect(errors).toEqual([])
        await captureQaScreenshot(page, `rpc-failover-${failure}-zh`)
      } finally {
        release()
      }
    })
  }

  test('shows the complete Chinese confirmation-timeout warning and retains the broadcast record', async ({
    page
  }) => {
    await page.clock.install()
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page, { successfulSend: true })
    await page.goto('/')
    await page.getByRole('button', { name: '連接錢包' }).first().click()
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
    await page.locator('tbody input[type="checkbox"]').first().check()
    await page.getByRole('button', { name: '僅領取', exact: true }).click()
    await expect(page.getByRole('button', { name: '開啟 MetaMask 並簽署' })).toBeVisible()
    await page.evaluate(() => window.__walletMock.setMinedReceipt(false))
    await page.getByRole('button', { name: '開啟 MetaMask 並簽署' }).click()
    await expect(page.locator('.modal-body a')).toHaveAttribute('href', new RegExp(TX_HASH))
    await expect(page.getByTestId('tx-log')).toContainText('正在等待鏈上確認交易')
    // The injected wallet is a local fixture, not a real wallet or broadcast endpoint.
    await page.clock.fastForward(190_000)
    await expect(page.locator('.err-text')).toHaveText(
      '確認逾時。交易可能仍待確認。請勿重送。請檢查錢包 Activity 與區塊瀏覽器，再重新檢查待確認交易。'
    )
    expect(await page.evaluate(() => localStorage.getItem('sm.vmuLocks'))).toContain(TX_HASH)
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith('sm.pendingOps.event.'))
          .map((key) => JSON.parse(localStorage.getItem(key)!).record)
          .filter((record) => record?.txHash === `0x${'a'.repeat(64)}`)
      )
    ).toContainEqual(expect.objectContaining({ phase: 'broadcast', txHash: TX_HASH }))
    await page.getByTestId('language-selector').selectOption('en')
    await expect(page.locator('.err-text')).toContainText('Do not resend')
    await page.evaluate((account) => window.__walletMock.emitAccounts([account]), ACCOUNT_A)
    await expect(page.locator('.err-text')).toContainText('Do not resend')
    await expect(page.locator('.modal-body a')).toHaveAttribute('href', new RegExp(TX_HASH))
    await page.getByTestId('language-selector').selectOption('zh-Hant')
    await expect(page.locator('.err-text')).toHaveText(
      '確認逾時。交易可能仍待確認。請勿重送。請檢查錢包 Activity 與區塊瀏覽器，再重新檢查待確認交易。'
    )
    expect(await page.evaluate(() => localStorage.getItem('sm.vmuLocks'))).toContain(TX_HASH)
    await captureQaScreenshot(page, 'confirmation-timeout-zh')
    await page.getByRole('button', { name: '關閉交易對話框' }).click()
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(1)
  })

  for (const failure of ['health', 'receipt'] as const) {
    test(`finishes a broadcast after background ${failure} failure without a resend`, async ({
      page
    }) => {
      await page.clock.install()
      await emulateDesktopGoogleChrome(page)
      const state: RpcMockState = { operation: 'CLAIM', successfulTx: false }
      await mockSameOriginRpc(page, state)
      let failHealth = false
      let failedProbes = 0
      const receiptNodes: string[] = []
      for (const endpoint of ETHEREUM_RPC_ROUTES) {
        await page.route(endpoint, async (route) => {
          const payload = route.request().postDataJSON()
          const calls = (Array.isArray(payload) ? payload : [payload]) as Array<{
            id: number
            method: string
            params: unknown[]
          }>
          if (failHealth && calls.every((call) => call.method === 'eth_chainId')) {
            failedProbes += 1
            return route.fulfill({ status: 503, body: 'Fixture health failure' })
          }
          const host = new URL(route.request().url()).hostname
          if (calls.some((call) => call.method === 'eth_getTransactionReceipt')) {
            receiptNodes.push(host)
            if (failure === 'receipt' && host === 'ethereum.publicnode.com') {
              const replies = calls.map(({ id, method, params }) =>
                method === 'eth_getTransactionReceipt'
                  ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } }
                  : { jsonrpc: '2.0', id, result: rpcResult(method, 1, params, state) }
              )
              return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify(Array.isArray(payload) ? replies : replies[0])
              })
            }
          }
          return handleRpcRouteWithState(route, state)
        })
      }
      await installInjectedWallet(page, { successfulSend: true })
      await page.goto('/')
      await page.getByRole('button', { name: '連接錢包' }).first().click()
      await page.locator('tbody input[type="checkbox"]').first().check()
      await page.getByRole('button', { name: '僅領取', exact: true }).click()
      await expect(page.getByRole('button', { name: '開啟 MetaMask 並簽署' })).toBeVisible()
      await page.evaluate(() => window.__walletMock.setMinedReceipt(false))
      await page.getByRole('button', { name: '開啟 MetaMask 並簽署' }).click()
      await expect(page.getByTestId('tx-log')).toContainText('正在等待鏈上確認交易')
      await expect.poll(() => receiptNodes.length).toBeGreaterThan(0)
      if (failure === 'health') {
        failHealth = true
        await page.clock.fastForward(35_000)
        await expect.poll(() => failedProbes).toBeGreaterThanOrEqual(4)
        await expect(page.locator('.modal-body .err-text')).toHaveCount(0)
        await expect(page.getByText(/沒有可用的 Ethereum RPC 節點（0\/4）/)).toBeVisible()
        await captureQaScreenshot(page, 'confirmation-health-unavailable-zh')
        failHealth = false
      } else {
        await expect.poll(() => receiptNodes.includes('ethereum-rpc.publicnode.com')).toBe(true)
      }
      state.successfulTx = true
      await page.evaluate(() => window.__walletMock.setMinedReceipt(true))
      await page.clock.fastForward(5_000)
      await expect(page.getByText('交易結果已驗證。', { exact: true })).toBeVisible()
      await expect(page.locator('.outcome-text')).toContainText('完整結果已驗證：1/1 個 VMU')
      expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
        sendAttempts: 1,
        successfulBroadcasts: 1
      })
      await captureQaScreenshot(page, `confirmation-${failure}-recovered-zh`)
    })
  }

  for (const [chain, chainId, gateway, endpoints] of [
    ['eth', '0x1', 'https://mainnet.gateway.tenderly.co', ETHEREUM_RPC_ROUTES],
    ['polygon', '0x89', 'https://polygon.gateway.tenderly.co', POLYGON_RPC_ROUTES]
  ] as const) {
    test(`uses the ${chain} Tenderly default when the other defaults fail and preserves language on reload`, async ({
      page
    }) => {
      await emulateDesktopGoogleChrome(page)
      await mockSameOriginRpc(page)
      await installInjectedWallet(page)
      const errors: string[] = []
      const failedDefaults = new Set<string>()
      const gatewayMethods = new Set<string>()
      const batchSizes: number[] = []
      const unexpectedRequests: string[] = []
      await page.route('https://**/*', async (route) => {
        const url = route.request().url()
        if (
          [...ETHEREUM_RPC_ROUTES, ...POLYGON_RPC_ROUTES].some((pattern) => pattern.test(url)) ||
          url === 'https://gasstation.polygon.technology/v2'
        )
          return route.fallback()
        unexpectedRequests.push(url)
        await route.abort()
      })
      let multicallReads = 0
      page.on('pageerror', (error) => errors.push(error.message))
      for (const endpoint of endpoints) {
        await page.route(endpoint, async (route) => {
          const origin = new URL(route.request().url()).origin
          if (origin !== gateway) {
            failedDefaults.add(origin)
            return route.fulfill({ status: 503, contentType: 'text/plain', body: 'offline' })
          }
          const payload = route.request().postDataJSON() as
            { method: string; params: unknown[] } | Array<{ method: string; params: unknown[] }>
          const requests = Array.isArray(payload) ? payload : [payload]
          batchSizes.push(requests.length)
          for (const { method, params } of requests) {
            gatewayMethods.add(method)
            if (
              method === 'eth_call' &&
              (params[0] as { to: string }).to.toLowerCase() === MULTICALL.toLowerCase()
            )
              multicallReads += 1
          }
          await handleRpcRouteWithState(route, { vmuCount: 2 })
        })
      }
      await page.route('https://gasstation.polygon.technology/v2', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ standard: { maxFee: 40, maxPriorityFee: 30 } })
        })
      )

      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
      await expect(page.getByTestId('language-selector')).toHaveValue('auto')
      await page.evaluate((id) => window.__walletMock.emitChain(id), chainId)
      await page.getByRole('button', { name: '連接錢包' }).first().click()
      await expect(page.getByRole('combobox', { name: '網路', exact: true })).toHaveValue(chain)
      await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
      await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
      await page.getByTestId('language-selector').selectOption('en')
      const beforeRefresh = multicallReads
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect.poll(() => multicallReads).toBeGreaterThan(beforeRefresh)
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
      await expect(page.locator('.group-note')).toContainText('2 VMUs total')
      await page.getByTestId('language-selector').selectOption('zh-Hant')
      expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
      await page.reload()
      await expect(page.getByTestId('language-selector')).toHaveValue('zh-Hant')
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
      await page.evaluate((id) => window.__walletMock.emitChain(id), chainId)
      await page.getByRole('button', { name: '連接錢包' }).first().click()
      await expect(page.locator('.group-note')).toContainText('共 2 個 VMU')
      await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: 'RPC', exact: true }).click()
      await expect(page.locator('textarea')).toHaveValue('')
      const defaultList = await page.locator('textarea').getAttribute('placeholder')
      expect(defaultList?.split('\n')).toContain(gateway)
      expect(defaultList).not.toContain('1rpc.io')
      expect(failedDefaults.size).toBe(3)
      expect([...gatewayMethods]).toEqual(
        expect.arrayContaining(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'])
      )
      expect(multicallReads).toBeGreaterThanOrEqual(2)
      expect(batchSizes.length).toBeGreaterThan(0)
      expect(batchSizes.every((size) => size >= 1 && size <= 3)).toBe(true)
      expect(errors).toEqual([])
      expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBeNull()
      expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
        sendAttempts: 0,
        successfulBroadcasts: 0
      })
      await captureQaScreenshot(page, `rpc-tenderly-${chain}-zh`)
      expect(unexpectedRequests).toEqual([])
    })
  }

  test('loads and refreshes a large Polygon wallet through constrained RPCs while preserving language choice', async ({
    page
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    const errors: string[] = []
    const rpcBatchSizes: number[] = []
    const multicallSizes: number[] = []
    const rejected: string[] = []
    const externalRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const polygonEndpoints = POLYGON_RPC_ROUTES
    for (const endpoint of polygonEndpoints) {
      await page.route(endpoint, async (route) => {
        const payload = route.request().postDataJSON() as
          | { id: number; method: string; params: unknown[] }
          | Array<{ id: number; method: string; params: unknown[] }>
        const requests = Array.isArray(payload) ? payload : [payload]
        rpcBatchSizes.push(requests.length)
        const replies = requests.map(({ id, method, params }) => {
          if (requests.length > 3) {
            rejected.push('JSON-RPC batch exceeds 3')
            return { jsonrpc: '2.0', id, error: { code: 31, message: rejected.at(-1) } }
          }
          const result = rpcResult(method, 137, params, { vmuCount: 601 })
          if (
            method === 'eth_call' &&
            (params[0] as { to: string }).to.toLowerCase() === MULTICALL.toLowerCase()
          ) {
            const data = (params[0] as { data: string }).data
            multicallSizes.push(
              multicallInterface.decodeFunctionData('aggregate3', data).calls.length
            )
            if ((String(result).length - 2) / 2 > 100_000) {
              rejected.push('Multicall response exceeds 100000 bytes')
              return { jsonrpc: '2.0', id, error: { code: -32000, message: rejected.at(-1) } }
            }
          }
          return { jsonrpc: '2.0', id, result }
        })
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(Array.isArray(payload) ? replies.reverse() : replies[0])
        })
      })
    }
    // All network access stays in local fixtures; unexpected endpoints fail this test.
    await page.route('https://**/*', async (route) => {
      const url = route.request().url()
      if (
        ETHEREUM_RPC_ROUTES.some((pattern) => pattern.test(url)) ||
        polygonEndpoints.some((pattern) => pattern.test(url))
      )
        return route.fallback()
      if (url === 'https://gasstation.polygon.technology/v2') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ standard: { maxFee: 40, maxPriorityFee: 30 } })
        })
      }
      externalRequests.push(url)
      await route.abort()
    })

    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
    await page.evaluate(() => window.__walletMock.emitChain('0x89'))
    await page.getByRole('button', { name: '連接錢包' }).first().click()
    await expect(page.getByRole('combobox', { name: '網路', exact: true })).toHaveValue('polygon')
    await expect(page.locator('.group-note')).toContainText('共 601 個 VMU')
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
    await expect(page.getByText('讀取錯誤', { exact: false })).toHaveCount(0)
    expect(multicallSizes).toEqual([300, 300, 1])
    await captureQaScreenshot(page, 'rpc-polygon-large-wallet-zh')

    await page.getByTestId('language-selector').selectOption('en')
    await expect(page.locator('.group-note')).toContainText('601 VMUs total')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => multicallSizes.length).toBe(6)
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    await expect(page.locator('.group-note')).toContainText('601 VMUs total')
    await page.getByTestId('language-selector').selectOption('zh-Hant')
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 0,
      successfulBroadcasts: 0
    })
    await page.reload()
    await expect(page.getByTestId('language-selector')).toHaveValue('zh-Hant')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
    await page.evaluate(() => window.__walletMock.emitChain('0x89'))
    await page.getByRole('button', { name: '連接錢包' }).first().click()
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
    await expect(page.locator('.group-note')).toContainText('共 601 個 VMU')
    await expect.poll(() => multicallSizes.length).toBe(9)
    expect(multicallSizes).toEqual([300, 300, 1, 300, 300, 1, 300, 300, 1])
    expect(rpcBatchSizes.length).toBeGreaterThan(0)
    expect(rpcBatchSizes.every((size) => size >= 1 && size <= 3)).toBe(true)
    expect(rejected).toEqual([])
    expect(externalRequests).toEqual([])
    expect(errors).toEqual([])
    expect(await page.evaluate(() => localStorage.getItem('sm.customRpc'))).toBeNull()
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 0,
      successfulBroadcasts: 0
    })
    await captureQaScreenshot(page, 'rpc-polygon-large-wallet-zh-reloaded')
  })

  test('follows browser language, remembers a manual choice, and restores automatic selection', async ({
    page
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
    const language = page.getByTestId('language-selector')
    await expect(language).toHaveValue('auto')
    await expect(page.getByRole('button', { name: '連接錢包' }).first()).toBeVisible()
    await captureQaScreenshot(page, 'language-zh-desktop')
    await language.selectOption('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.reload()
    await expect(language).toHaveValue('en')
    await expect(page.getByRole('button', { name: 'Connect Wallet' }).first()).toBeVisible()
    await language.selectOption('auto')
    expect(await page.evaluate(() => localStorage.getItem('xenturbo.language.v1'))).toBeNull()
    await page.reload()
    await expect(page.getByRole('button', { name: '連接錢包' }).first()).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(language).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await captureQaScreenshot(page, 'language-zh-narrow')
    expect(errors).toEqual([])
  })

  test('preserves wallet, form and VMU selection on a switch and relocalizes an open preparation across tabs', async ({
    page,
    context
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    await page.goto('/')
    await page.getByRole('button', { name: '連接錢包' }).first().click()
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeEnabled()
    await page.getByLabel('鑄造 VMU（最多 128 個）', { exact: true }).fill('2')
    await page.getByLabel('期限（天，最多 250 天）', { exact: true }).fill('10')
    const selected = page.locator('tbody input[type="checkbox"]').first()
    await selected.check()
    await page.getByTestId('language-selector').selectOption('en')
    await expect(selected).toBeChecked()
    await expect(page.getByLabel('Mint VMUs (max 128)', { exact: true })).toHaveValue('2')
    await expect(page.getByLabel('Term (days, max 250)', { exact: true })).toHaveValue('10')
    await expect(page.getByRole('button', { name: '0x1111...1111' })).toBeVisible()
    await page.getByRole('button', { name: 'Claim only', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
    const second = await context.newPage()
    await emulateDesktopGoogleChrome(second)
    await mockSameOriginRpc(second)
    await second.goto('/')
    await second.getByTestId('language-selector').selectOption('zh-Hant')
    await expect(page.getByRole('button', { name: '開啟 MetaMask 並簽署' })).toBeVisible()
    await expect(page.getByTestId('tx-log')).toContainText('Gas 估算已完成。')
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 0,
      successfulBroadcasts: 0
    })
    await captureQaScreenshot(page, 'language-zh-prepared')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByText('準備已取消。未送出任何交易。', { exact: true })).toBeVisible()
    await second.close()
  })

  test('completes a wallet-mocked claim in Chinese without changing transaction semantics', async ({
    page
  }) => {
    const rpcState: RpcMockState = { successfulTx: true, confirmed: false, operation: 'CLAIM' }
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page, rpcState)
    await installInjectedWallet(page, { successfulSend: true })
    await page.goto('/')
    await page.getByRole('button', { name: '連接錢包' }).first().click()
    await page.locator('tbody input[type="checkbox"]').first().check()
    await page.getByRole('button', { name: '僅領取', exact: true }).click()
    await page.getByRole('button', { name: '開啟 MetaMask 並簽署' }).click()
    await expect(page.getByText('交易結果已驗證。', { exact: true })).toBeVisible()
    await expect(page.locator('.outcome-text')).toContainText(
      '完整結果已驗證：1/1 個 VMU 的狀態為 空槽。'
    )
    expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
      sendAttempts: 1,
      successfulBroadcasts: 1
    })
    await captureQaScreenshot(page, 'language-zh-confirmed')
  })

  test('retains the no-hash damaged-lock gate and explains recovery in Chinese', async ({
    page
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    await page.goto('/')
    const damaged = JSON.stringify([
      { chain: 'eth', wallet: ACCOUNT_A, ids: ['1'], batch: 'damaged-no-hash', lockedAt: 1 }
    ])
    await page.evaluate((value) => localStorage.setItem('sm.vmuLocks', value), damaged)
    await page.getByRole('button', { name: '連接錢包' }).first().click()
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
    await page.getByTestId('language-selector').selectOption('en')
    await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeDisabled()
    await page.getByTestId('language-selector').selectOption('zh-Hant')
    await page.getByRole('button', { name: '交易記錄恢復', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '交易記錄恢復' })
    await expect(dialog).toContainText('缺少交易雜湊的損壞記錄無法在此驗證。')
    await expect(dialog).toContainText('損壞記錄：1 筆')
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '匯出備份' }).click()
    await download
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '驗證並修復' }).click()
    await expect(dialog.getByRole('status')).toContainText('1 筆記錄仍保持鎖定')
    await expect(dialog.getByRole('status')).toContainText('1 筆交易識別資料缺失或無法讀取')
    expect(await page.evaluate(() => localStorage.getItem('sm.vmuLocks'))).toBe(damaged)
    await captureQaScreenshot(page, 'language-zh-recovery')
    await dialog.getByRole('button', { name: '關閉交易記錄恢復' }).click()
    await expect(page.getByRole('button', { name: '確認鑄造', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
  })

  test('translates RPC validation without persisting an insecure endpoint', async ({ page }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await page.goto('/')
    const before = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
    await page.getByRole('button', { name: 'RPC', exact: true }).click()
    await page.locator('textarea').fill('http://insecure.invalid')
    await page.getByRole('button', { name: '儲存', exact: true }).click()
    await expect(page.locator('.rpc-error')).toHaveText('RPC 節點必須使用 HTTPS')
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(
      before
    )
    await captureQaScreenshot(page, 'language-zh-rpc')
  })

  test('offers a language switch inside the mobile guard without bypassing it', async ({
    browser,
    baseURL
  }) => {
    const context = await browser.newContext({
      baseURL,
      locale: 'zh-HK',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'
    })
    try {
      const page = await context.newPage()
      await mockSameOriginRpc(page)
      await page.goto('/')
      const guard = page.getByRole('alertdialog')
      await expect(guard).toContainText('請使用電腦版 Chrome')
      await guard.getByTestId('language-selector').selectOption('en')
      await expect(guard).toContainText('Mobile browsers are not supported')
      await guard.getByTestId('language-selector').selectOption('zh-Hant')
      await expect(guard).toContainText('不支援行動裝置瀏覽器')
      const bounds = await guard.locator('.chrome-guard__panel').boundingBox()
      const control = await guard.locator('.language-control').boundingBox()
      expect(
        Math.abs(control!.x + control!.width / 2 - bounds!.x - bounds!.width / 2)
      ).toBeLessThanOrEqual(1)
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
      await captureQaScreenshot(page, 'language-zh-mobile-guard')
    } finally {
      await context.close()
    }
  })
})

test('a timely hash survives journal failure with a clear submitted state and recovery link', async ({
  page
}) => {
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
    const set = Storage.prototype.setItem
    window.__restoreStorage = () => {
      Storage.prototype.setItem = set
    }
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('sm.pendingOps.event.') && JSON.parse(value).record?.phase === 'broadcast')
        throw new DOMException('Offline fixture journal full', 'QuotaExceededError')
      return set.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
  const modal = page.locator('.modal-body').filter({ has: page.getByTestId('tx-log') })
  await expect(modal.locator('.err-text')).toContainText('Transaction submitted')
  for (const message of ['MetaMask request opened', 'Transaction submitted:']) {
    await expect(
      modal.getByTestId('tx-log-entry').filter({ hasText: message }).locator('.tx-log-marker')
    ).toHaveText('OK')
  }
  await expect(modal.locator('.err-text')).toContainText('Do not resend')
  await expect(modal.locator('.steps li').nth(1).locator('.step-icon')).toHaveText('OK')
  await expect(modal.locator('.step-icon.run')).toHaveCount(0)
  await expect(modal.getByRole('link', { name: 'View on explorer' })).toHaveAttribute(
    'href',
    `https://etherscan.io/tx/${TX_HASH}`
  )
  await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks') ?? '[]')[0])
  ).toMatchObject({ txHash: TX_HASH })
  expect(await page.evaluate(() => window.__walletMock.stats())).toEqual({
    sendAttempts: 1,
    successfulBroadcasts: 1
  })
  await captureQaScreenshot(page, 'broadcast-storage-recovery')
  await page.evaluate(() => {
    window.__restoreStorage?.()
    window.__walletMock.setMinedReceipt(false)
  })
  await modal.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(page.getByText(/Blocked: 1 unresolved transaction/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeDisabled()
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(1)
})

test('storage recovery exports original evidence and repairs only wallet-settled damage', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  await page.goto('/')
  await page.evaluate(
    ({ wallet, hash }) => {
      localStorage.setItem(
        'sm.vmuLocks',
        JSON.stringify([
          { chain: 'eth', wallet, txHash: hash, ids: ['1'], batch: 'corrupt', lockedAt: Date.now() }
        ])
      )
      window.__walletMock.setMinedReceipt(true)
    },
    { wallet: ACCOUNT_A, hash: TX_HASH }
  )
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Transaction storage recovery' })
  await expect(dialog).toContainText('Damaged records: 1')
  await expect(dialog.getByRole('button', { name: 'Verify and repair' })).toBeDisabled()
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export backup' }).click()
  expect((await download).suggestedFilename()).toMatch(/^xenturbo-transaction-backup-/)
  await dialog.getByRole('checkbox').check()
  await captureQaScreenshot(page, 'storage-recovery-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  await captureQaScreenshot(page, 'storage-recovery-narrow')
  await dialog.getByRole('button', { name: 'Verify and repair' }).click()
  await expect(dialog.getByRole('status')).toContainText(
    '1 settled record(s) archived and repaired. 0 record(s) remain blocked.'
  )
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks')!))).toEqual([])
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith('sm.storageRecovery.backup.'))
          .length
    )
  ).toBe(1)
  await dialog.getByRole('button', { name: 'Close recovery' }).click()
  await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeEnabled()
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
})

test('storage recovery stops after a durable backup if transaction evidence changes', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeEnabled()
  const original = await page.evaluate(
    ({ wallet, hash }) => {
      const raw = JSON.stringify([
        { chain: 'eth', wallet, txHash: hash, batch: 'damaged', ids: ['1'] }
      ])
      localStorage.setItem('sm.vmuLocks', raw)
      window.__walletMock.setMinedReceipt(true)
      const set = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        set.call(this, key, value)
        if (key.startsWith('sm.storageRecovery.backup.')) {
          set.call(this, 'sm.pendingOps.event.concurrent', '{unreadable-concurrent-evidence')
        }
      }
      return raw
    },
    { wallet: ACCOUNT_A, hash: TX_HASH }
  )
  await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Transaction storage recovery' })
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export backup' }).click()
  await download
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Verify and repair' }).click()
  await expect(dialog.getByRole('status')).toContainText('Transaction records changed')
  await expect(dialog.getByRole('status')).not.toContainText('archived and repaired')
  const stored = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith('sm.storageRecovery.backup.')
    )
    return {
      locks: localStorage.getItem('sm.vmuLocks'),
      concurrent: localStorage.getItem('sm.pendingOps.event.concurrent'),
      backups: keys.map((key) => JSON.parse(localStorage.getItem(key)!))
    }
  })
  expect(stored.locks).toBe(original)
  expect(stored.concurrent).toBe('{unreadable-concurrent-evidence')
  expect(stored.backups).toHaveLength(1)
  expect(stored.backups[0].entries).toContainEqual({ key: 'sm.vmuLocks', raw: original })
  await captureQaScreenshot(page, 'recovery-post-backup-change')
  await dialog.getByRole('button', { name: 'Close recovery' }).click()
  await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
  expect(errors).toEqual([])
})

test('closing a repaired dialog stays blocked until post-recovery wallet reconciliation succeeds', async ({
  page
}) => {
  await page.clock.install()
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  // Start wallet reconciliation on a paused clock, before any idle poll can accumulate host time.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
  await expectEnabledWithClock(page, mint)
  await page.evaluate(
    ({ wallet, hash }) => {
      localStorage.setItem(
        'sm.vmuLocks',
        JSON.stringify([{ chain: 'eth', wallet, txHash: hash, batch: 'damaged', ids: ['1'] }])
      )
      window.__walletMock.setMinedReceipt(true)
      const provider = (
        window as unknown as {
          ethereum: { request: (args: { method: string }) => Promise<unknown> }
        }
      ).ethereum
      const request = provider.request.bind(provider)
      let reject!: (error: Error) => void
      let release!: (value: string) => void
      let blocked = true
      const gate = new Promise<string>((resolve, fail) => {
        release = resolve
        reject = fail
      })
      window.__pendingCheckGate = {
        reads: 0,
        reject: () => reject(new Error('Recovery reconciliation offline fixture')),
        release: () => {
          blocked = false
          release('0x0')
        }
      }
      provider.request = async (args) => {
        if (args.method === 'eth_getTransactionCount') {
          window.__pendingCheckGate.reads += 1
          if (blocked) return gate
        }
        return request(args)
      }
    },
    { wallet: ACCOUNT_A, hash: TX_HASH }
  )
  await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Transaction storage recovery' })
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export backup' }).click()
  await download
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Verify and repair' }).click()
  await expect(dialog.getByRole('status')).toContainText(
    '1 settled record(s) archived and repaired. 0 record(s) remain blocked.'
  )
  await expectPendingNonceReads(page, 2)
  await dialog.getByRole('button', { name: 'Close recovery' }).click()
  await expect(mint).toBeDisabled()
  await expect(
    page.getByText('Blocked: verifying pending transactions for this account and network.').first()
  ).toBeVisible()
  await page.evaluate(() => window.__pendingCheckGate.reject())
  await expect(
    page.getByText('Blocked: pending transaction check failed. Recheck before submitting.').first()
  ).toBeVisible()
  await expect(mint).toBeDisabled()
  // Even an idle poll must keep failing until this fixture explicitly restores the wallet.
  await page.clock.runFor(30_001)
  await expectPendingNonceReads(page, 4)
  await expect(mint).toBeDisabled()
  await expect(
    page.getByText('Blocked: pending transaction check failed. Recheck before submitting.').first()
  ).toBeVisible()
  await page.evaluate(() => window.__pendingCheckGate.release())
  await page.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect
    .poll(async () => {
      await page.clock.runFor(50)
      return mint.isEnabled()
    })
    .toBe(true)
  expect(await page.evaluate(() => window.__pendingCheckGate.reads)).toBe(6)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks')!))).toEqual([])
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
  expect(errors).toEqual([])
})

for (const kind of ['journal', 'lock without hash'] as const) {
  test(`unidentifiable ${kind} corruption stays blocked after recovery and reload`, async ({
    page
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    const key = kind === 'journal' ? 'sm.pendingOps.event.broken' : 'sm.vmuLocks'
    const original =
      kind === 'journal'
        ? '{'
        : JSON.stringify([{ chain: 'eth', wallet: ACCOUNT_A, batch: 'damaged', ids: ['1'] }])
    await page.evaluate(({ key, original }) => localStorage.setItem(key, original), {
      key,
      original
    })
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Transaction storage recovery' })
    await expect(dialog).toContainText('without a transaction hash cannot be verified here')
    await expect(dialog).toContainText('mining stays blocked for this site in this browser profile')
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Export backup' }).click()
    await download
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Verify and repair' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      '0 settled record(s) archived and repaired. 1 record(s) remain blocked.'
    )
    await captureQaScreenshot(
      page,
      kind === 'journal' ? 'storage-recovery-blocked' : 'storage-recovery-no-hash'
    )
    await dialog.getByRole('button', { name: 'Close recovery' }).click()
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeDisabled()
    await page.reload()
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await expect(page.getByRole('button', { name: 'Confirm Mint' })).toBeDisabled()
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original)
    expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
    expect(errors).toEqual([])
  })
}

for (const change of ['disconnect', 'unsupported-chain', 'same-account'] as const) {
  test(`recovery dialog releases its UI gate after ${change}`, async ({ page }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    const mint = page.getByRole('button', { name: 'Confirm Mint', exact: true })
    await expect(mint).toBeEnabled()
    await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
    await expect(mint).toBeDisabled()
    await page.evaluate(
      ({ kind, account }) => {
        if (kind === 'disconnect') window.__walletMock.emitAccounts([])
        else if (kind === 'same-account') window.__walletMock.emitAccounts([account])
        else window.__walletMock.emitChain('0x3e7')
      },
      { kind: change, account: ACCOUNT_A }
    )
    await expect(page.getByRole('dialog', { name: 'Transaction storage recovery' })).toBeHidden()
    await page.evaluate(
      ({ kind, account }) => {
        if (kind === 'disconnect') window.__walletMock.emitAccounts([account])
        else if (kind === 'unsupported-chain') window.__walletMock.emitChain('0x1')
      },
      { kind: change, account: ACCOUNT_A }
    )
    await expect(mint).toBeEnabled()
    expect(errors).toEqual([])
    expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
    await captureQaScreenshot(page, `recovery-${change}-restored`)
  })
}

test('recovery presents a friendly wallet timeout and retains damaged evidence', async ({
  page
}) => {
  await emulateDesktopGoogleChrome(page)
  await mockSameOriginRpc(page)
  await installInjectedWallet(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await page.evaluate(
    ({ wallet, hash }) => {
      localStorage.setItem(
        'sm.vmuLocks',
        JSON.stringify([
          { chain: 'eth', wallet, txHash: hash, ids: ['1'], batch: 'damaged', lockedAt: Date.now() }
        ])
      )
      window.__walletMock.setStalled('eth_getTransactionReceipt', true)
    },
    { wallet: ACCOUNT_A, hash: TX_HASH }
  )
  await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Transaction storage recovery' })
  await expect(dialog).toContainText('Invalid record structure')
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export backup' }).click()
  await download
  await expect(dialog.getByRole('button', { name: 'Verify and repair' })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Verify and repair' }).click()
  await expect(dialog.getByRole('status')).toContainText('Wallet or network read timed out', {
    timeout: 17_000
  })
  await expect(dialog.getByRole('status')).toContainText(
    'Wallet eth_getTransactionReceipt exceeded 15000 ms.'
  )
  await expect(dialog.getByRole('status')).not.toContainText('READ_TIMEOUT')
  await captureQaScreenshot(page, 'recovery-error-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.width).toBeLessThanOrEqual(390)
  await captureQaScreenshot(page, 'recovery-error-narrow')
  await dialog.getByRole('button', { name: 'Close recovery' }).click()
  await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sm.vmuLocks')!).length)).toBe(1)
  expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
  expect(errors).toEqual([])
})

for (const interaction of ['close button', 'backdrop'] as const) {
  test(`in-flight recovery can close through the ${interaction} without clearing damaged evidence`, async ({
    page
  }) => {
    await emulateDesktopGoogleChrome(page)
    await mockSameOriginRpc(page)
    await installInjectedWallet(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    const original = JSON.stringify([
      { chain: 'eth', wallet: ACCOUNT_A, txHash: TX_HASH, batch: 'damaged', ids: ['1'] }
    ])
    await page.evaluate((original) => {
      localStorage.setItem('sm.vmuLocks', original)
      window.__walletMock.setMinedReceipt(true)
      const provider = (
        window as unknown as {
          ethereum: { request: (args: { method: string }) => Promise<unknown> }
        }
      ).ethereum
      const request = provider.request.bind(provider)
      let release!: () => void
      window.__recoveryRead = { reads: 0, release: () => release() }
      provider.request = async (args) => {
        if (args.method === 'eth_getTransactionReceipt') {
          window.__recoveryRead.reads += 1
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return request(args)
      }
    }, original)
    await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await page.getByRole('button', { name: 'Transaction storage recovery', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Transaction storage recovery' })
    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Export backup' }).click()
    await download
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Verify and repair' }).click()
    await expect.poll(() => page.evaluate(() => window.__recoveryRead.reads)).toBe(1)
    await dialog.locator('#recovery-title').click()
    await expect(dialog).toBeVisible()
    if (interaction === 'close button')
      await dialog.getByRole('button', { name: 'Close recovery' }).click()
    else await page.locator('.recovery-mask').click({ position: { x: 2, y: 2 } })
    await expect(dialog).toBeHidden()
    await page.evaluate(() => window.__recoveryRead.release())
    await page.getByRole('button', { name: 'Recheck', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm Mint', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => localStorage.getItem('sm.vmuLocks'))).toBe(original)
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).some((key) => key.startsWith('sm.storageRecovery.backup.'))
      )
    ).toBe(false)
    expect(await page.evaluate(() => window.__walletMock.stats().sendAttempts)).toBe(0)
    expect(errors).toEqual([])
  })
}

test('simultaneous tab submissions produce only one broadcast while reconciliation is unresolved', async ({
  page,
  context
}) => {
  const second = await context.newPage()
  for (const candidate of [page, second]) {
    await emulateDesktopGoogleChrome(candidate)
    await mockSameOriginRpc(candidate)
    await installInjectedWallet(candidate, { successfulSend: true })
    await candidate.goto('/')
    await candidate.getByRole('button', { name: 'Connect Wallet' }).first().click()
    await candidate.getByRole('button', { name: 'Confirm Mint' }).click()
    await expect(candidate.getByRole('button', { name: 'Open MetaMask & Sign' })).toBeVisible()
    await candidate.evaluate(() => {
      window.__walletMock.setSendDelay(500)
      window.__walletMock.setRejected('eth_getTransactionReceipt', true)
    })
  }
  await Promise.all(
    [page, second].map((candidate) =>
      candidate.getByRole('button', { name: 'Open MetaMask & Sign' }).click()
    )
  )
  await expect
    .poll(async () => {
      const errors = await Promise.all(
        [page, second].map((candidate) =>
          candidate.locator('.modal-body .err-text').allTextContents()
        )
      )
      return errors
        .flat()
        .some((error) => error.includes('previous local transaction record is unresolved'))
    })
    .toBe(true)
  const counts = await Promise.all(
    [page, second].map((candidate) => candidate.evaluate(() => window.__walletMock.stats()))
  )
  expect(counts.reduce((total, stats) => total + stats.sendAttempts, 0)).toBe(1)
  expect(counts.reduce((total, stats) => total + stats.successfulBroadcasts, 0)).toBe(1)
  await second.close()
})
