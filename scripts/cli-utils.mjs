import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function safeLogText(value) {
  return String(value).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
  )
}

export function diagnosticError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error.cause : null
  const detail =
    cause && typeof cause === 'object'
      ? [cause.code, cause.message].filter((part) => typeof part === 'string').join(': ')
      : typeof cause === 'string'
        ? cause
        : ''
  return safeLogText(message.slice(0, 500) + (detail ? ` (${detail.slice(0, 200)})` : ''))
}

export function isMainModule(moduleUrl, entrypoint = process.argv[1]) {
  if (!entrypoint) return false
  return realpathSync(entrypoint) === realpathSync(fileURLToPath(moduleUrl))
}

export function cliValue(argv, index, flag) {
  const value = argv[index]
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new Error(`ARGUMENT_VALUE_REQUIRED: ${flag} requires a value.`)
  }
  return value
}

export function normalizeProbeUrl(value, allowLoopbackHttp = false) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('INVALID_RPC_URL: use a valid HTTPS URL.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    throw new Error(
      'HTTPS_REQUIRED: RPC endpoint must use https:// (HTTP is allowed only for local loopback tests).'
    )
  }
  if (url.username || url.password)
    throw new Error('INVALID_RPC_URL: embedded credentials are not allowed.')
  return url.toString()
}
