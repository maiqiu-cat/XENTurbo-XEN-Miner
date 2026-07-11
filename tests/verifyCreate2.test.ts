import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import {
  Interface,
  concat,
  getAddress,
  getCreate2Address,
  keccak256,
  solidityPackedKeccak256
} from 'ethers'

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

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  )
  servers.clear()
})

function proxyForId(wallet: string, id: number): string {
  const initHash = keccak256(concat([PROXY_PREFIX, getAddress(VMU_TEMPLATE), PROXY_SUFFIX]))
  const salt = solidityPackedKeccak256(['address', 'uint256'], [getAddress(wallet), id])
  return getCreate2Address(getAddress(FACTORY), salt, initHash)
}

function rpcResult(
  method: string,
  params: unknown[],
  options: {
    activeIds: number[]
    chainId: number
    vmuCount: number
    wallet: string
    xen: string
  }
): string {
  if (method === 'eth_chainId') return `0x${options.chainId.toString(16)}`
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
    return xenInterface.encodeFunctionResult('userMints', [
      proxy,
      active ? 100 : 0,
      0,
      active ? 1 : 0,
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
  env = {},
  vmuCount = 1
}: {
  activeIds?: number[]
  chain?: 'eth' | 'polygon'
  chainId?: number
  cliWallet?: string | null
  env?: NodeJS.ProcessEnv
  vmuCount?: number
} = {}) {
  const xen = chain === 'eth' ? ETH_XEN : POLYGON_XEN
  const wallet =
    cliWallet ?? (chain === 'eth' ? env.CREATE2_WITNESS_ETH : env.CREATE2_WITNESS_POLYGON) ?? WALLET
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
      const replies = requests.map(({ id, method, params }) => ({
        jsonrpc: '2.0',
        id,
        result: rpcResult(method, params, { activeIds, chainId, vmuCount, wallet, xen })
      }))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]))
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock RPC failed to bind')

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const childEnv = { ...process.env, ...env }
    if (!Object.hasOwn(env, 'CREATE2_WITNESS_ETH')) delete childEnv.CREATE2_WITNESS_ETH
    if (!Object.hasOwn(env, 'CREATE2_WITNESS_POLYGON')) delete childEnv.CREATE2_WITNESS_POLYGON
    const child = spawn(
      process.execPath,
      [
        'scripts/verify-create2.mjs',
        '--chain',
        chain,
        ...(cliWallet ? ['--wallet', cliWallet] : []),
        '--rpc',
        `http://127.0.0.1:${address.port}`
      ],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
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
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('CREATE2 verification release gate', () => {
  it('requires a per-chain witness address rather than using a default wallet', async () => {
    const result = await runVerification({ cliWallet: null })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('WITNESS_REQUIRED')
  })

  it('uses the selected chain witness environment variable when --wallet is omitted', async () => {
    const result = await runVerification({
      activeIds: [1],
      cliWallet: null,
      env: { CREATE2_WITNESS_ETH: ENV_WALLET }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`wallet=${getAddress(ENV_WALLET)}`)
  })

  it('uses Polygon chain configuration when --chain polygon is selected', async () => {
    const result = await runVerification({ activeIds: [1], chain: 'polygon', chainId: 137 })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('chain=polygon chainId=137')
  })

  it('fails before contract reads when the RPC chain ID differs from the selected chain', async () => {
    const result = await runVerification({ activeIds: [1], chainId: 137 })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CHAIN_ID_MISMATCH')
  })

  it('scans later batches until it finds an active VMU that records the derived proxy as minter', async () => {
    const result = await runVerification({ activeIds: [6], vmuCount: 6 })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('batch=6-6')
    expect(result.stdout).toContain('CREATE2 derivation VERIFIED')
    expect(result.stdout).not.toContain('NOT_VERIFIED')
    expect(result.stderr).toBe('')
  })

  it('returns NOT_VERIFIED with exit code 2 when no VMU is active', async () => {
    const result = await runVerification({ activeIds: [] })

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
  })
})
