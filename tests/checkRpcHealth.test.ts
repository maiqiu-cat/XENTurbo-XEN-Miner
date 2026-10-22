import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Interface } from 'ethers'
import { checkRpcEndpoint } from '../scripts/check-rpc-health.mjs'

const config = {
  chainId: 1,
  factory: '0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2'
}

const factoryInterface = new Interface(['function FEE() view returns (uint256)'])

function healthyPayload() {
  return [
    { id: 1, jsonrpc: '2.0', result: '0x1' },
    { id: 2, jsonrpc: '2.0', result: factoryInterface.encodeFunctionResult('FEE', [123n]) }
  ]
}

async function runHealthGate(payload: unknown) {
  const entrypoint = new URL('../scripts/check-rpc-health.mjs', import.meta.url)
  const source = `
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entrypoint))},
      '--chain', 'eth', '--rpc', 'https://bad.example.test', '--rpc', 'https://good.example.test'];
    globalThis.fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => url === 'https://bad.example.test'
        ? ${JSON.stringify(payload)} : ${JSON.stringify(healthyPayload())}
    });
    await import(${JSON.stringify(entrypoint.href)});
  `
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 4_000,
      killSignal: 'SIGKILL'
    })
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

describe('RPC health release gate', () => {
  it('reports the wrong chain before an accompanying FEE call failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, jsonrpc: '2.0', result: '0x89' },
        { id: 2, jsonrpc: '2.0', error: { message: 'contract is absent' } }
      ]
    })
    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)
    expect(result).toMatchObject({
      healthy: false,
      error: expect.stringContaining('CHAIN_ID_MISMATCH')
    })
    expect(result.error).not.toContain('FEE_CALL_FAILED')
  })

  it('preserves a nested transport cause in a bounded single-line diagnostic', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connection refused\nforged PASS'), { code: 'ECONNREFUSED' })
      })
    )
    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)
    expect(result.error).toContain('ECONNREFUSED')
    expect(result.error).toContain('connection refused')
    expect(result.error).not.toContain('\n')
    expect(result.healthy).toBe(false)
  })

  it.each(['\nPASS forged\r', '\u001b[2J\u001b[H', '\u202ePASS\u2028forged'])(
    'escapes untrusted terminal controls (%j)',
    async (message) => {
      const result = await runHealthGate([
        healthyPayload()[0],
        { id: 2, jsonrpc: '2.0', error: { message } }
      ])
      expect(result.code).toBe(1)
      expect(result.stderr.trim().split('\n')).toHaveLength(1)
      expect(result.stderr).not.toContain(message)
      for (const control of ['\u001b', '\u202e', '\u2028', '\r'])
        expect(result.stderr).not.toContain(control)
      expect(result.stderr).toContain('FEE_CALL_FAILED')
      expect(result.stdout).toContain('PASS https://good.example.test')
    }
  )

  it('requires HTTPS before probing an RPC endpoint', async () => {
    const fetchImpl = vi.fn()

    const result = await checkRpcEndpoint('http://rpc.example.test', config, fetchImpl)

    expect(result.healthy).toBe(false)
    expect(result.error).toContain('HTTPS_REQUIRED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts an HTTPS endpoint only when chain ID and factory FEE() both succeed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, jsonrpc: '2.0', result: '0x1' },
        {
          id: 2,
          jsonrpc: '2.0',
          result: factoryInterface.encodeFunctionResult('FEE', [123n])
        }
      ]
    })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result).toMatchObject({ healthy: true, chainId: 1, fee: 123n })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error')
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body as string)
    expect(request).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'eth_chainId' }),
        expect.objectContaining({ method: 'eth_call' })
      ])
    )
  })

  it('rejects a reachable endpoint that reports a different chain', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, jsonrpc: '2.0', result: '0x89' },
        {
          id: 2,
          jsonrpc: '2.0',
          result: factoryInterface.encodeFunctionResult('FEE', [123n])
        }
      ]
    })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result.healthy).toBe(false)
    expect(result.error).toContain('CHAIN_ID_MISMATCH')
  })

  it('returns a structured failure for an invalid endpoint URL', async () => {
    const fetchImpl = vi.fn()

    await expect(checkRpcEndpoint('not a URL', config, fetchImpl)).resolves.toMatchObject({
      healthy: false,
      error: expect.stringContaining('INVALID_RPC_URL')
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'null body', payload: null },
    { name: 'non-array body', payload: healthyPayload()[0] },
    { name: 'null member', payload: [null] },
    { name: 'boolean member', payload: [false] },
    { name: 'array member', payload: [[]] },
    { name: 'string ID', payload: [{ id: '1', jsonrpc: '2.0', result: '0x1' }] },
    { name: 'unknown ID', payload: [{ id: 3, jsonrpc: '2.0', result: '0x1' }] },
    { name: 'wrong RPC version', payload: [{ id: 1, jsonrpc: '1.0', result: '0x1' }] },
    { name: 'duplicate IDs', payload: [healthyPayload()[0], healthyPayload()[0]] },
    { name: 'extra member', payload: [...healthyPayload(), healthyPayload()[0]] },
    {
      name: 'RPC error',
      payload: [{ id: 1, jsonrpc: '2.0', error: { code: -32000 } }, healthyPayload()[1]]
    },
    {
      name: 'result and error',
      payload: [{ ...healthyPayload()[0], error: { code: -32000 } }, healthyPayload()[1]]
    },
    {
      name: 'numeric chain ID',
      payload: [{ ...healthyPayload()[0], result: 1 }, healthyPayload()[1]]
    },
    { name: 'null FEE', payload: [healthyPayload()[0], { ...healthyPayload()[1], result: null }] },
    { name: 'empty batch', payload: [] }
  ])('rejects malformed batches without throwing: $name', async ({ payload }) => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result).toMatchObject({ healthy: false, error: expect.any(String) })
  })

  it.each([
    '1',
    ' 0x1',
    '0x01',
    '-0x1',
    '0x',
    '0xgg',
    '0x1.0',
    '9'.repeat(4096),
    `0x${'f'.repeat(65)}`
  ])('rejects malformed or oversized chain IDs before numeric conversion (%s)', async (chainId) => {
    const payload = healthyPayload()
    payload[0].result = chainId
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result.healthy).toBe(false)
    expect(result.error).toContain('INVALID_CHAIN_ID')
  })

  it('compares a full-width valid hex chain ID without rounding it to a number', async () => {
    const payload = healthyPayload()
    payload[0].result = `0x${'f'.repeat(64)}`
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result.healthy).toBe(false)
    expect(result.error).toContain(`received ${(1n << 256n) - 1n}`)
  })

  it.each(['0x', '0x01', `0x${'0'.repeat(66)}`, `0x${'g'.repeat(64)}`])(
    'requires one bounded ABI word for FEE() (%s)',
    async (fee) => {
      const payload = healthyPayload()
      payload[1].result = fee
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })

      const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

      expect(result.healthy).toBe(false)
      expect(result.error).toContain('FEE_CALL_FAILED')
    }
  )

  it('accepts valid batch results in reverse order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => healthyPayload().reverse()
    })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result).toMatchObject({ healthy: true, fee: 123n })
  })

  it('accepts a valid zero FEE without treating it as a missing result', async () => {
    const payload = healthyPayload()
    payload[1].result = factoryInterface.encodeFunctionResult('FEE', [0n])
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })

    const result = await checkRpcEndpoint('https://rpc.example.test', config, fetchImpl)

    expect(result).toMatchObject({ healthy: true, fee: 0n })
  })

  it.each([
    { name: 'null member', payload: [null], error: 'INVALID_BATCH_MEMBER' },
    {
      name: 'duplicate IDs',
      payload: [healthyPayload()[0], healthyPayload()[0]],
      error: 'DUPLICATE_ID'
    },
    {
      name: 'invalid chain ID',
      payload: [{ ...healthyPayload()[0], result: 'invalid' }, healthyPayload()[1]],
      error: 'INVALID_CHAIN_ID'
    },
    {
      name: 'oversized numeric chain ID',
      payload: [{ ...healthyPayload()[0], result: '9'.repeat(4096) }, healthyPayload()[1]],
      error: 'INVALID_CHAIN_ID'
    },
    {
      name: 'invalid FEE',
      payload: [healthyPayload()[0], { ...healthyPayload()[1], result: '0x' }],
      error: 'FEE_CALL_FAILED'
    }
  ])('keeps scanning and exits failclosed: $name', async ({ payload, error }) => {
    const result = await runHealthGate(payload)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('FAIL https://bad.example.test')
    expect(result.stderr).toContain(error)
    expect(result.stdout).toContain('PASS https://good.example.test')
  })
})
