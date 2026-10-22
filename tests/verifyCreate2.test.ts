import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  Interface,
  concat,
  getAddress,
  getCreate2Address,
  keccak256,
  solidityPackedKeccak256
} from 'ethers'
import { parseVerificationArgs, verifyCreate2 } from '../scripts/verify-create2.mjs'
import { minimalProxyRuntimeCode } from '../src/core/create2'

const FACTORY = '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
const ETH_XEN = '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8'
const POLYGON_XEN = '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e'
const VMU_TEMPLATE = '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'
const WALLET = '0x50d30cdae2ec9384eb890e0906e54f709cc02c16'
const ENV_WALLET = '0x6f21bd7b63433a74b8bda4ea7bdb35a1ccb41f95'
const PROXY_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73'
const PROXY_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3'

const factoryInterface = new Interface(['function vmuCount(address) view returns (uint256)'])
const xenInterface = new Interface([
  'function userMints(address) view returns (address user, uint256 term, uint256 maturityTs, uint256 rank, uint256 amplifier, uint256 eaaRate)'
])

const servers = new Set<Server>()
const timers = new Set<ReturnType<typeof setTimeout>>()

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const server of servers) {
    server.closeAllConnections()
    if (server.listening) server.close()
  }
  servers.clear()
})

function proxyForId(wallet: string, id: number | bigint): string {
  const initHash = keccak256(concat([PROXY_PREFIX, getAddress(VMU_TEMPLATE), PROXY_SUFFIX]))
  const salt = solidityPackedKeccak256(['address', 'uint256'], [getAddress(wallet), id])
  return getCreate2Address(getAddress(FACTORY), salt, initHash)
}

function rpcResult(
  method: string,
  params: unknown[],
  options: {
    activeIds: Array<number | bigint>
    chainId: number
    misdirectedIds: number[]
    vmuCount: number | bigint
    wallet: string
    xen: string
    proxyShift: number
  }
): string {
  if (method === 'eth_chainId') return `0x${options.chainId.toString(16)}`
  if (method === 'eth_blockNumber') return '0x1'
  if (method === 'eth_getCode') {
    const address = getAddress(params[0] as string)
    const count = BigInt(options.vmuCount)
    const shifted = [1n, count]
      .map((id) => id + BigInt(options.proxyShift))
      .filter((id) => id >= 0n && id < 1n << 256n)
    return shifted.some((id) => address === getAddress(proxyForId(options.wallet, id)))
      ? minimalProxyRuntimeCode(VMU_TEMPLATE)
      : '0x'
  }
  if (method !== 'eth_call') throw new Error(`Unexpected RPC method ${method}`)

  const call = params[0] as { data?: string; to?: string }
  if (call.to?.toLowerCase() === FACTORY.toLowerCase()) {
    return factoryInterface.encodeFunctionResult('vmuCount', [options.vmuCount])
  }
  if (call.to?.toLowerCase() === options.xen.toLowerCase()) {
    const [proxy] = xenInterface.decodeFunctionData('userMints', call.data ?? '0x')
    const active = options.activeIds.some(
      (id) => getAddress(proxy) === getAddress(proxyForId(options.wallet, id))
    )
    const misdirected = options.misdirectedIds.some(
      (id) => getAddress(proxy) === getAddress(proxyForId(options.wallet, id))
    )
    return xenInterface.encodeFunctionResult('userMints', [
      misdirected ? getAddress(WALLET) : proxy,
      active || misdirected ? 100 : 0,
      0,
      active || misdirected ? 1 : 0,
      0,
      0
    ])
  }
  throw new Error(`Unexpected contract ${call.to}`)
}

async function runVerification({
  activeIds = [],
  chain = 'eth',
  chainId = 1,
  cliWallet = WALLET,
  countDelayMs = 0,
  env = {},
  extraArgs = [],
  hang,
  mintDelayMs = 0,
  misdirectedIds = [],
  redirect = false,
  vmuCount = 1,
  proxyShift = 0,
  rateLimitOnce = false,
  retryAfter
}: {
  activeIds?: Array<number | bigint>
  chain?: 'eth' | 'polygon'
  chainId?: number
  cliWallet?: string | null
  countDelayMs?: number
  env?: NodeJS.ProcessEnv
  extraArgs?: string[]
  hang?: 'network' | 'count' | 'mint' | 'laterMint'
  mintDelayMs?: number
  misdirectedIds?: number[]
  redirect?: boolean
  vmuCount?: number | bigint
  proxyShift?: number
  rateLimitOnce?: boolean
  retryAfter?: string
} = {}) {
  const xen = chain === 'eth' ? ETH_XEN : POLYGON_XEN
  const wallet =
    cliWallet ?? (chain === 'eth' ? env.CREATE2_WITNESS_ETH : env.CREATE2_WITNESS_POLYGON) ?? WALLET
  const connections = new Set<Socket>()
  const mintProxies: string[] = []
  const rpcMethods: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const payload = JSON.parse(body) as
        | { id: number; method: string; params: unknown[] }
        | Array<{ id: number; method: string; params: unknown[] }>
      const requests = Array.isArray(payload) ? payload : [payload]
      if (rateLimitOnce) {
        rateLimitOnce = false
        response.writeHead(429, {
          Connection: 'close',
          ...(retryAfter ? { 'Retry-After': retryAfter } : {})
        })
        response.end()
        return
      }
      if (redirect) {
        rpcMethods.push(...requests.map(({ method }) => method))
        response.writeHead(302, { Location: '/redirect-target', Connection: 'close' })
        response.end()
        return
      }
      let readsCount = false
      let readsMint = false
      for (const { method, params } of requests) {
        rpcMethods.push(method)
        if (method !== 'eth_call') continue
        const call = params[0] as { data: string; to: string }
        if (call.to.toLowerCase() === FACTORY.toLowerCase()) readsCount = true
        if (call.to.toLowerCase() === xen.toLowerCase()) {
          readsMint = true
          const [proxy] = xenInterface.decodeFunctionData('userMints', call.data)
          mintProxies.push(getAddress(proxy))
        }
      }
      if (
        (hang === 'network' && requests.some(({ method }) => method === 'eth_chainId')) ||
        (hang === 'count' && readsCount) ||
        (hang === 'mint' && readsMint) ||
        (hang === 'laterMint' && readsMint && mintProxies.length > 5)
      ) {
        return
      }
      const replies = requests.map(({ id, method, params }) => ({
        jsonrpc: '2.0',
        id,
        result: rpcResult(method, params, {
          activeIds,
          chainId,
          misdirectedIds,
          vmuCount,
          wallet,
          xen,
          proxyShift
        })
      }))
      const reply = () => {
        response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]))
      }
      const delay = Math.max(readsCount ? countDelayMs : 0, readsMint ? mintDelayMs : 0)
      if (delay > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer)
          reply()
        }, delay)
        timers.add(timer)
        response.once('close', () => {
          clearTimeout(timer)
          timers.delete(timer)
        })
      } else {
        reply()
      }
    })
  })
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock RPC failed to bind')

  const entrypoint = new URL('../scripts/verify-create2.mjs', import.meta.url)
  const bootstrap = `
    import { JsonRpcProvider } from 'ethers';
    const destroy = JsonRpcProvider.prototype.destroy;
    JsonRpcProvider.prototype.destroy = function () {
      console.log('TEST_PROVIDER_DESTROYED');
      return destroy.call(this);
    };
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entrypoint))}, ...process.argv.slice(1)];
    await import(${JSON.stringify(entrypoint.href)});
  `

  return new Promise<{
    code: number | null
    stdout: string
    stderr: string
    mintProxies: string[]
    rpcMethods: string[]
    providerDestroyCount: number
    openConnections: number
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        bootstrap,
        '--',
        '--chain',
        chain,
        ...(cliWallet ? ['--wallet', cliWallet] : []),
        '--rpc',
        `http://127.0.0.1:${address.port}`,
        ...extraArgs
      ],
      {
        cwd: process.cwd(),
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        killSignal: 'SIGKILL'
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      setImmediate(() =>
        resolve({
          code,
          stdout,
          stderr,
          mintProxies,
          rpcMethods,
          providerDestroyCount: stdout.match(/^TEST_PROVIDER_DESTROYED$/gm)?.length ?? 0,
          openConnections: connections.size
        })
      )
    })
  })
}

describe('CREATE2 verification release gate', () => {
  it('ends with NOT_VERIFIED when DNS lookup never completes in an isolated fixture', () => {
    const entrypoint = new URL('../scripts/verify-create2.mjs', import.meta.url)
    const script = `
      import dns from 'node:dns';
      dns.lookup = () => {};
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entrypoint))}, '--chain', 'eth', '--wallet', ${JSON.stringify(WALLET)}, '--rpc', 'https://unresolved.fixture.invalid', '--deadline-ms', '250'];
      await import(${JSON.stringify(entrypoint.href)});
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: {},
      encoding: 'utf8',
      timeout: 8_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED: DEADLINE_EXCEEDED')
  })
  it.each([-1, 1])(
    'rejects a proxy numbering shift of %s instead of accepting another active VMU',
    async (proxyShift) => {
      const result = await runVerification({ vmuCount: 3, activeIds: [2], proxyShift })
      expect(result.code).toBe(3)
      expect(result.stderr).toContain('CREATE2_MISMATCH')
      expect(result.stdout).not.toContain('CREATE2 derivation VERIFIED')
      expect(result.providerDestroyCount).toBe(1)
    }
  )

  it('retries one transient rate limit inside the owned transport', async () => {
    const result = await runVerification({ activeIds: [1], rateLimitOnce: true })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('CREATE2 derivation VERIFIED')
    expect(result.openConnections).toBe(0)
  })

  it('respects Retry-After without outliving the total scan budget', async () => {
    const result = await runVerification({
      activeIds: [1],
      rateLimitOnce: true,
      retryAfter: '60',
      extraArgs: ['--deadline-ms', '250']
    })
    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED: DEADLINE_EXCEEDED')
    expect(result.openConnections).toBe(0)
  })

  it.each(['--wallet', '--rpc', '--chain'])(
    'rejects a missing %s value without silently choosing defaults',
    async (flag) => {
      const result = await runVerification({ extraArgs: [flag] })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('ARGUMENT_VALUE_REQUIRED')
      expect(result.rpcMethods).toEqual([])
    }
  )
  it('requires a per-chain witness address rather than using a default wallet', async () => {
    const result = await runVerification({ cliWallet: null })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('WITNESS_REQUIRED')
    expect(result.rpcMethods).toEqual([])
    expect(result.providerDestroyCount).toBe(0)
  })

  it('rejects redirects without following them outside the owned transport', async () => {
    const result = await runVerification({ redirect: true })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('RPC_REDIRECT_REQUIRES_EXPLICIT_URL')
    expect(result.rpcMethods.every((method) => method === 'eth_chainId')).toBe(true)
    expect(result.providerDestroyCount).toBe(1)
    expect(result.openConnections).toBe(0)
  })

  it('uses the selected chain witness environment variable when --wallet is omitted', async () => {
    const result = await runVerification({
      activeIds: [1],
      cliWallet: null,
      env: { CREATE2_WITNESS_ETH: ENV_WALLET }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`wallet=${getAddress(ENV_WALLET)}`)
    expect(result.providerDestroyCount).toBe(1)
  })

  it('uses Polygon chain configuration when --chain polygon is selected', async () => {
    const result = await runVerification({ activeIds: [1], chain: 'polygon', chainId: 137 })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('chain=polygon chainId=137')
    expect(result.providerDestroyCount).toBe(1)
  })

  it('fails before contract reads when the RPC chain ID differs from the selected chain', async () => {
    const result = await runVerification({ activeIds: [1], chainId: 137 })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CHAIN_ID_MISMATCH')
    expect(result.rpcMethods).not.toContain('eth_call')
    expect(result.providerDestroyCount).toBe(1)
  })

  it('scans later batches until it finds an active VMU that records the derived proxy as minter', async () => {
    const result = await runVerification({ activeIds: [6], vmuCount: 6 })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('batch=6-6')
    expect(result.stdout).toContain('CREATE2 derivation VERIFIED')
    expect(result.stdout).not.toContain('NOT_VERIFIED')
    expect(result.stderr).toBe('')
    expect(result.providerDestroyCount).toBe(1)
  })

  it('returns NOT_VERIFIED with exit code 2 when no VMU is active', async () => {
    const result = await runVerification({ activeIds: [] })

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
    expect(result.providerDestroyCount).toBe(1)
  })

  it('does not reuse an Ethereum environment witness for Polygon', async () => {
    const result = await runVerification({
      chain: 'polygon',
      chainId: 137,
      cliWallet: null,
      env: { CREATE2_WITNESS_ETH: ENV_WALLET }
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CREATE2_WITNESS_POLYGON')
    expect(result.rpcMethods).toEqual([])
  })

  it('accepts an explicit Polygon environment witness', async () => {
    const result = await runVerification({
      activeIds: [1],
      chain: 'polygon',
      chainId: 137,
      cliWallet: null,
      env: { CREATE2_WITNESS_POLYGON: ENV_WALLET }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`wallet=${getAddress(ENV_WALLET)}`)
    expect(result.providerDestroyCount).toBe(1)
  })

  it('bounds a uint256-sized VMU count without reporting a derivation mismatch', async () => {
    const result = await runVerification({
      vmuCount: (1n << 256n) - 1n,
      extraArgs: ['--scan-limit', '6']
    })

    expect(result.code).toBe(2)
    expect(result.mintProxies).toHaveLength(6)
    expect(result.stdout).toContain('NOT_VERIFIED: SCAN_LIMIT')
    expect(result.stdout).toContain('--from-id 7')
    expect(result.stdout).not.toContain('MISMATCH')
    expect(result.stdout).not.toContain('CREATE2 derivation VERIFIED')
    expect(result.providerDestroyCount).toBe(1)
  })

  it.each([
    { chain: 'eth' as const, chainId: 1 },
    { chain: 'polygon' as const, chainId: 137 }
  ])('resumes on $chain and verifies the next page', async ({ chain, chainId }) => {
    const first = await runVerification({
      chain,
      chainId,
      activeIds: [6],
      vmuCount: 6,
      extraArgs: ['--scan-limit', '5']
    })
    expect(first.code).toBe(2)
    expect(first.mintProxies).toHaveLength(5)
    expect(first.stdout).toContain('--from-id 6')

    const second = await runVerification({
      chain,
      chainId,
      activeIds: [6],
      vmuCount: 6,
      extraArgs: ['--from-id', '6', '--scan-limit', '5']
    })
    expect(second.code).toBe(0)
    expect(second.mintProxies).toEqual([proxyForId(WALLET, 6)])
    expect(second.stdout).toContain('batch=6-6')
    expect(second.stdout).toContain('CREATE2 derivation VERIFIED')
    expect(first.providerDestroyCount).toBe(1)
    expect(second.providerDestroyCount).toBe(1)
  })

  it('keeps looking past an active record with a different minter', async () => {
    const result = await runVerification({ activeIds: [6], misdirectedIds: [1], vmuCount: 6 })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('batch=6-6')
    expect(result.stdout).toContain('CREATE2 derivation VERIFIED')
    expect(result.stdout).not.toContain('MISMATCH')
  })

  it('does not treat an active record with a different minter as proof of mismatch', async () => {
    const result = await runVerification({ misdirectedIds: [1] })

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
    expect(result.stdout).not.toContain('MISMATCH')
    expect(result.stdout).not.toContain('CREATE2 derivation VERIFIED')
  })

  it.each(['network', 'count', 'mint', 'laterMint'] as const)(
    'bounds a stalled %s read and destroys the provider and sockets',
    async (hang) => {
      const result = await runVerification({
        hang,
        vmuCount: 100,
        extraArgs: ['--deadline-ms', '1500']
      })

      expect(result.code).toBe(2)
      expect(result.stdout).toContain('NOT_VERIFIED: DEADLINE_EXCEEDED')
      expect(result.stdout).not.toContain('MISMATCH')
      expect(result.stdout).not.toContain('CREATE2 derivation VERIFIED')
      expect(result.mintProxies.length).toBeLessThanOrEqual(hang === 'laterMint' ? 10 : 5)
      expect(result.providerDestroyCount).toBe(1)
      expect(result.openConnections).toBe(0)
      if (hang === 'laterMint') expect(result.stdout).toContain('--from-id 6')
    }
  )

  it('uses one total deadline rather than restarting the budget for each read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { config, wallet } = parseVerificationArgs(['--chain', 'eth', '--wallet', WALLET], {})
    const provider = {
      provider: null,
      getNetwork: vi.fn(async () => ({ chainId: 1n })),
      getBlockNumber: vi.fn(async () => 1),
      getCode: vi.fn(async (address: string) =>
        getAddress(address) === getAddress(proxyForId(WALLET, 1))
          ? minimalProxyRuntimeCode(VMU_TEMPLATE)
          : '0x'
      ),
      call: vi.fn(async (transaction: { to: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return transaction.to.toLowerCase() === FACTORY.toLowerCase()
          ? factoryInterface.encodeFunctionResult('vmuCount', [1])
          : xenInterface.encodeFunctionResult('userMints', [proxyForId(WALLET, 1), 100, 0, 1, 0, 0])
      })
    }
    const log = vi.fn()
    const result = verifyCreate2({ config, wallet, provider, log, deadlineMs: 350 })
    await vi.advanceTimersByTimeAsync(350)
    expect(await result).toBe(false)
    expect(provider.call).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT_VERIFIED: DEADLINE_EXCEEDED'))
    expect(log).not.toHaveBeenCalledWith('CREATE2 derivation VERIFIED against on-chain data.')
  })

  it('accepts uint256-sized page offsets without lossy number conversion', async () => {
    const id = (1n << 256n) - 1n
    const result = await runVerification({
      activeIds: [id],
      vmuCount: id,
      extraArgs: ['--from-id', id.toString(), '--scan-limit', '1']
    })

    expect(result.code).toBe(0)
    expect(result.mintProxies).toEqual([proxyForId(WALLET, id)])
    expect(result.stdout).toContain(`batch=${id}-${id}`)
  })

  it.each([0, 5])('does not scan beyond a VMU count of %s', async (vmuCount) => {
    const result = await runVerification({ vmuCount, extraArgs: ['--from-id', '6'] })

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
    expect(result.mintProxies).toEqual([])
    expect(result.providerDestroyCount).toBe(1)
  })

  it.each([
    ['--scan-limit', '0'],
    ['--scan-limit', '-1'],
    ['--scan-limit', '1.5'],
    ['--scan-limit', '100001'],
    ['--deadline-ms', '0'],
    ['--deadline-ms', '300001'],
    ['--deadline-ms', 'Infinity'],
    ['--from-id', '0'],
    ['--from-id', (1n << 256n).toString()],
    ['--from-id', '9'.repeat(4096)],
    ['--scan-limit']
  ])('rejects invalid scan options before RPC reads: %s %s', async (...extraArgs) => {
    const result = await runVerification({ extraArgs })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      extraArgs.length === 1 ? 'ARGUMENT_VALUE_REQUIRED' : 'INVALID_SCAN_OPTION'
    )
    expect(result.rpcMethods).toEqual([])
    expect(result.providerDestroyCount).toBe(0)
  })

  it('parses the maximum bounded budgets and defaults without losing bigint page offsets', () => {
    const defaults = parseVerificationArgs(['--chain', 'eth', '--wallet', WALLET], {})
    expect(defaults).toMatchObject({ fromId: 1n, scanLimit: 1_000, deadlineMs: 30_000 })

    const fromId = (1n << 256n) - 1n
    const maximum = parseVerificationArgs(
      [
        '--chain',
        'eth',
        '--wallet',
        WALLET,
        '--from-id',
        fromId.toString(),
        '--scan-limit',
        '100000',
        '--deadline-ms',
        '300000'
      ],
      {}
    )
    expect(maximum).toMatchObject({ fromId, scanLimit: 100_000, deadlineMs: 300_000 })
  })

  it('does not destroy a borrowed provider or continue after a late network response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { config, wallet } = parseVerificationArgs(['--chain', 'eth', '--wallet', WALLET], {})
    let resolveNetwork!: (network: { chainId: bigint }) => void
    const provider = {
      provider: null,
      getNetwork: vi.fn(
        () =>
          new Promise<{ chainId: bigint }>((resolve) => {
            resolveNetwork = resolve
          })
      ),
      call: vi.fn(),
      getBlockNumber: vi.fn(async () => 1),
      getCode: vi.fn(async () => '0x'),
      destroy: vi.fn()
    }
    const log = vi.fn()

    const verification = verifyCreate2({ config, provider, wallet, log, deadlineMs: 20 })
    const settled = expect(verification).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    await settled
    resolveNetwork({ chainId: 1n })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(provider.getNetwork).toHaveBeenCalledOnce()
    expect(provider.call).not.toHaveBeenCalled()
    expect(provider.destroy).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT_VERIFIED: DEADLINE_EXCEEDED'))
    expect(log).not.toHaveBeenCalledWith('CREATE2 derivation VERIFIED against on-chain data.')
  })

  it('rechecks an unfinished batch after expiry during inspection', async () => {
    const { config, wallet } = parseVerificationArgs(['--chain', 'eth', '--wallet', WALLET], {})
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const provider = {
      provider: null,
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getBlockNumber: vi.fn(async () => 1),
      getCode: vi.fn(async (address: string) =>
        getAddress(address) === getAddress(proxyForId(WALLET, 1))
          ? minimalProxyRuntimeCode(VMU_TEMPLATE)
          : '0x'
      ),
      call: vi
        .fn()
        .mockResolvedValueOnce(factoryInterface.encodeFunctionResult('vmuCount', [1]))
        .mockResolvedValueOnce(
          xenInterface.encodeFunctionResult('userMints', [proxyForId(WALLET, 1), 100, 0, 1, 0, 0])
        ),
      destroy: vi.fn()
    }
    const log = vi.fn((message: string) => {
      if (message.startsWith('id=1 ')) clock.mockReturnValue(1_000)
    })

    const verified = await verifyCreate2({ config, provider, wallet, log, deadlineMs: 500 })

    expect(verified).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT_VERIFIED: DEADLINE_EXCEEDED'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--from-id 1'))
    expect(log).not.toHaveBeenCalledWith('CREATE2 derivation VERIFIED against on-chain data.')
    expect(provider.destroy).not.toHaveBeenCalled()
  })
})
