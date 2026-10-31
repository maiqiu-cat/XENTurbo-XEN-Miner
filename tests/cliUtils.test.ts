import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  cliValue,
  diagnosticError,
  isMainModule,
  normalizeProbeUrl,
  safeLogText
} from '../scripts/cli-utils.mjs'
import { getChainConfig } from '../scripts/chain-config.mjs'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('CLI release gates', () => {
  it('escapes controls and truncates only at complete escape boundaries', () => {
    expect(safeLogText('a\n\x1b\u202e')).toBe('a\\u000a\\u001b\\u202e')
    expect(safeLogText('ab\\u001bmore', 5)).toBe('ab...')
    const text = diagnosticError(new Error('a'.repeat(498) + '\\u001b' + 'z'.repeat(10)))
    expect(text).toBe('a'.repeat(498) + '...')
  })
  it('summarizes bounded aggregate causes without empty trailing separators or controls', () => {
    const cause = new AggregateError(
      [Object.assign(new Error(''), { code: 'ECONNREFUSED' }), new Error('reset\n')],
      ''
    )
    const text = diagnosticError(new Error('fetch failed', { cause }))
    expect(text).toBe('fetch failed (ECONNREFUSED; reset\\u000a)')
    expect(text).not.toContain('ECONNREFUSED: ')
  })
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
  it.each([false, true])('fails the SEO CLI gate for a missing build (symlink: %s)', (symlink) => {
    const directory = mkdtempSync(join(tmpdir(), 'miner-seo-cli-'))
    directories.push(directory)
    const source = fileURLToPath(new URL('../scripts/check-seo.mjs', import.meta.url))
    const alias = join(directory, 'seo #?%.mjs')
    if (symlink) symlinkSync(source, alias)
    const result = spawnSync(process.execPath, [symlink ? alias : source], {
      cwd: directory,
      env: {},
      encoding: 'utf8',
      timeout: 8_000
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Public SEO gate failed: build directory is not readable.')
    expect(result.stdout).not.toContain('passed')
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
