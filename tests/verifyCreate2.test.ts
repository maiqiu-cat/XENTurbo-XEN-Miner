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
const XEN = '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8'
const VMU_TEMPLATE = '0x1D65d25b1D90Ef6Dd9F64b10d6B079a015085855'
const WALLET = '0x50d30cdae2ec9384eb890e0906e54f709cc02c16'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
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

function proxyForId(id: number): string {
  const initHash = keccak256(concat([PROXY_PREFIX, getAddress(VMU_TEMPLATE), PROXY_SUFFIX]))
  const salt = solidityPackedKeccak256(['address', 'uint256'], [getAddress(WALLET), id])
  return getCreate2Address(getAddress(FACTORY), salt, initHash)
}

function rpcResult(
  method: string,
  params: unknown[],
  vmuCount: number,
  active: boolean,
  term: number,
  rank: number
): string {
  if (method === 'eth_chainId') return '0x1'
  if (method !== 'eth_call') throw new Error(`Unexpected RPC method ${method}`)

  const call = params[0] as { to?: string }
  if (call.to?.toLowerCase() === FACTORY.toLowerCase()) {
    return factoryInterface.encodeFunctionResult('vmuCount', [vmuCount])
  }
  if (call.to?.toLowerCase() === XEN.toLowerCase()) {
    const user = active ? proxyForId(1) : ZERO_ADDRESS
    return xenInterface.encodeFunctionResult('userMints', [user, term, 0, rank, 0, 0])
  }
  throw new Error(`Unexpected contract ${call.to}`)
}

async function runVerification(vmuCount: number, active: boolean, term = active ? 100 : 0, rank = active ? 1 : 0) {
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
        result: rpcResult(method, params, vmuCount, active, term, rank)
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
    const child = spawn(
      process.execPath,
      ['scripts/verify-create2.mjs', WALLET, `http://127.0.0.1:${address.port}`],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
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
  it('returns NOT_VERIFIED with exit code 2 when the wallet has no VMUs', async () => {
    const result = await runVerification(0, false)

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
  })

  it('returns NOT_VERIFIED with exit code 2 when no sampled VMU is active', async () => {
    const result = await runVerification(1, false)

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
  })

  it('succeeds only when an active VMU records the derived proxy as minter', async () => {
    const result = await runVerification(1, true)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('CREATE2 derivation VERIFIED')
    expect(result.stdout).not.toContain('NOT_VERIFIED')
    expect(result.stderr).toBe('')
  })

  it('does not treat a matching minter with zero rank and term as active', async () => {
    const result = await runVerification(1, true, 0, 0)

    expect(result.code).toBe(2)
    expect(result.stdout).toContain('NOT_VERIFIED')
  })
})
