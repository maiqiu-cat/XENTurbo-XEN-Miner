import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '@/config/version'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }

describe('application version', () => {
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
