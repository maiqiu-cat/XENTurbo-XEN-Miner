import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(
  readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
)
const version = packageJson.version
const expectedTag = `v${version}`
const failures = []

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  failures.push(`package.json version is not semantic: ${JSON.stringify(version)}`)
}
if (packageLock.version !== version) {
  failures.push(`package-lock.json version ${packageLock.version} does not match ${version}`)
}
if (packageLock.packages?.['']?.version !== version) {
  failures.push(
    `package-lock.json root package version ${packageLock.packages?.['']?.version} does not match ${version}`
  )
}

if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== expectedTag) {
  failures.push(`GitHub tag ${process.env.GITHUB_REF_NAME} does not match ${expectedTag}`)
}

if (failures.length) {
  console.error('Version consistency check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

let exactTag = null
let versionFilesDirty = false
try {
  exactTag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
} catch {
  // Development commits are not required to carry a release tag.
}

try {
  execFileSync('git', ['diff', '--quiet', '--', 'package.json', 'package-lock.json'], {
    stdio: 'ignore'
  })
} catch {
  versionFilesDirty = true
}

if (exactTag && exactTag !== expectedTag && !versionFilesDirty) {
  console.error(
    `Version consistency check failed: Git tag ${exactTag} does not match ${expectedTag}`
  )
  process.exit(1)
}

const tagStatus =
  exactTag === expectedTag
    ? exactTag
    : versionFilesDirty
      ? `${expectedTag} pending`
      : 'not-release-tag'
console.log(`Version consistency passed: source=${version} ui=${expectedTag} tag=${tagStatus}`)
