import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const allowedEmail = /@(?:users\.noreply\.github\.com|cryptocell\.cloud)$/i
const blockedHistoryPaths = new Set(['DEPLOY-TENCENT.md', 'RELEASE-FOR-CODEX.txt'])
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKID[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bSecret(?:Id|Key)\s*[:=]\s*[^<$\s]+/i
]

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

const failures = []
const identities = git(['log', '--all', '--format=%H\t%ae\t%ce']).trim().split('\n').filter(Boolean)

for (const row of identities) {
  const [commit, authorEmail, committerEmail] = row.split('\t')
  for (const [kind, email] of [
    ['author', authorEmail],
    ['committer', committerEmail]
  ]) {
    if (!allowedEmail.test(email)) failures.push(`${commit}: disallowed ${kind} email domain`)
  }
}

const historicalPaths = git(['log', '--all', '--name-only', '--format='])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
for (const path of historicalPaths) {
  if (blockedHistoryPaths.has(path)) failures.push(`blocked path remains in Git history: ${path}`)
}

const historicalText = git([
  'log',
  '--all',
  '-p',
  '--',
  '.',
  ':!package-lock.json',
  ':!scripts/check-public-safety.mjs'
])
if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(historicalText)) {
  failures.push('local user home path detected in Git history')
}
for (const email of historicalText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
  if (!allowedEmail.test(email))
    failures.push('non-corporate email address detected in Git history')
}
for (const pattern of secretPatterns) {
  if (pattern.test(historicalText))
    failures.push(`potential secret detected in Git history: ${pattern}`)
}

const trackedFiles = git(['ls-files', '-z']).split('\0').filter(Boolean)
for (const path of trackedFiles) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)) {
    failures.push(`${path}: local user home path detected`)
  }
  if (path !== 'package-lock.json') {
    const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
    for (const email of emails) {
      if (!allowedEmail.test(email)) failures.push(`${path}: non-corporate email address detected`)
    }
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) failures.push(`${path}: potential secret matched ${pattern}`)
  }
  if (
    path.startsWith('ops/') &&
    /\b(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])(?:\.(?:\d{1,3})){3}\b/.test(text)
  ) {
    failures.push(`${path}: raw IPv4 address detected in public operations config`)
  }
}

if (failures.length) {
  console.error('Public-safety check failed:')
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Public-safety check passed: ${identities.length} commits and ${trackedFiles.length} tracked files checked.`
)
