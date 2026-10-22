import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
