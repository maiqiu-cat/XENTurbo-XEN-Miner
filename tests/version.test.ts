import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '@/config/version'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

describe('application version', () => {
  it('keeps production environment files ignored', () => {
    const ignore = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      input: '.env.production\n',
      encoding: 'utf8'
    })
    expect(ignore.stdout.trim()).toBe('.env.production')
  })

  it('documents the package version command', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain('`npm run check:version`')
  })

  it('documents the deliberately strict release-tag policy', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain('release tags only')
  })

  it('intentionally rejects prerelease tags until a separate prerelease policy is approved', () => {
    const result = spawnSync(process.execPath, ['scripts/check-version.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: `v${packageJson.version}-rc.1`
      }
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match')
  })
  it('uses the package version as the UI version source', () => {
    expect(APP_VERSION).toBe(`v${packageJson.version}`)
  })

  it('rejects a GitHub release tag that does not match the source version', () => {
    const result = spawnSync(process.execPath, ['scripts/check-version.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v0.0.0'
      }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`GitHub tag v0.0.0 does not match v${packageJson.version}`)
  })
})
