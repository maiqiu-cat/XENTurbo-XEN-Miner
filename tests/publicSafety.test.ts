import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  files: new Map<string, string | Error>(),
  git: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFileSync: fixtures.git }))
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    const value = fixtures.files.get(path)
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error('missing fixture')
    return value
  }
}))

beforeEach(() => {
  vi.resetModules()
  fixtures.files.clear()
  fixtures.git.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'ls-files') return [...fixtures.files.keys()].join('\0')
    if (args.some((arg) => arg.startsWith('--format=%H'))) {
      return 'abc\tfixture@users.noreply.github.com\tfixture@users.noreply.github.com\n'
    }
    return ''
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('EXIT_NONZERO')
  })
})
afterEach(() => vi.restoreAllMocks())

describe('public safety scanner fails closed', () => {
  it('fails when a tracked file cannot be read without printing file contents', async () => {
    fixtures.files.set('missing.txt', new Error('private diagnostic that must not be printed'))
    await expect(import('../scripts/check-public-safety.mjs')).rejects.toThrow('EXIT_NONZERO')
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith('- missing.txt: tracked file could not be read')
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('private diagnostic')
  })

  it('accepts public analytics configuration without treating it as an API credential', async () => {
    fixtures.files.set('src/config.ts', 'export const token = "d47010c2cf564339b8ad6c17afef3e0c"')
    await import('../scripts/check-public-safety.mjs')
    expect(process.exit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Public-safety check passed'))
  })
})
