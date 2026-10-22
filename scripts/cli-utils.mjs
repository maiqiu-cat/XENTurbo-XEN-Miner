import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function safeLogText(value, limit = Infinity) {
  let output = ''
  // Treat existing escapes as units so nested diagnostic formatting cannot cut them in half.
  for (const match of String(value).matchAll(/\\u[0-9a-fA-F]{4,6}|./gsu)) {
    const token = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(match[0])
      ? `\\u${match[0].codePointAt(0).toString(16).padStart(4, '0')}`
      : match[0]
    if (output.length + token.length > limit) return `${output}...`
    output += token
  }
  return output
}

export function diagnosticError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error.cause : null
  const seen = new Set()
  const describeCause = (value, depth = 0) => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 2) return ''
    seen.add(value)
    const parts = [value.code, value.message].filter(
      (part) => typeof part === 'string' && part.trim()
    )
    if (Array.isArray(value.errors)) {
      const nested = value.errors
        .slice(0, 3)
        .map((item) => describeCause(item, depth + 1))
        .filter(Boolean)
      if (nested.length) parts.push(nested.join('; '))
    }
    return parts.join(': ')
  }
  const detail = describeCause(cause)
  return safeLogText(message, 500) + (detail ? ` (${safeLogText(detail, 200)})` : '')
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
