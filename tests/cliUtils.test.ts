import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { cliValue, isMainModule, normalizeProbeUrl } from '../scripts/cli-utils.mjs'
import { getChainConfig } from '../scripts/chain-config.mjs'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('CLI release gates', () => {
  it.each([
    ['verify-create2.mjs', [], 'CHAIN_REQUIRED'],
    ['check-rpc-health.mjs', ['--chain', 'bogus'], 'Unsupported chain'],
    ['probe-release-chain.mjs', ['--invalid'], 'UNEXPECTED_ARGUMENT']
  ] as const)('executes %s even through a reserved-character symlink', (name, args, error) => {
    const directory = mkdtempSync(join(tmpdir(), 'miner-cli-'))
    directories.push(directory)
    const alias = join(directory, 'entry #?%.mjs')
    symlinkSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), alias)
    const result = spawnSync(process.execPath, [alias, ...args], {
      env: {},
      encoding: 'utf8',
      timeout: 8_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
    expect(result.stdout).not.toContain('PASS')
  })
  it('does not mistake an imported utility for a main program', () => {
    expect(isMainModule(import.meta.url, process.execPath)).toBe(false)
    expect(() => isMainModule(import.meta.url, 'nonexistent-entry.mjs')).toThrow()
  })
  it.each([[], ['--other'], ['']])('rejects a missing CLI value: %j', (...argv) => {
    expect(() => cliValue(argv as string[], 0, '--rpc')).toThrow('ARGUMENT_VALUE_REQUIRED')
  })
  it.each(['toString', '__proto__', 'constructor'])('rejects inherited chain key %s', (key) => {
    expect(() => getChainConfig(key)).toThrow('Unsupported chain')
  })
  it('allows HTTP only when explicitly permitted for loopback test fixtures', () => {
    const credentials = new URL('https://rpc.example')
    credentials.username = 'fixture'
    credentials.password = 'fixture'
    expect(normalizeProbeUrl('http://127.0.0.1:1234', true)).toBe('http://127.0.0.1:1234/')
    for (const value of ['http://rpc.example', 'http://127.0.0.1:1234', credentials.toString()]) {
      expect(() => normalizeProbeUrl(value)).toThrow()
    }
    expect(() => normalizeProbeUrl('http://rpc.example', true)).toThrow('HTTPS_REQUIRED')
  })
})
