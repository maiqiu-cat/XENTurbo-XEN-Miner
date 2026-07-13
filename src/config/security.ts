export function contentSecurityPolicy(includeDevWebSockets = false): string {
  const connectSources = ["'self'", 'https:']
  if (includeDevWebSockets) connectSources.push('ws://127.0.0.1:*', 'ws://localhost:*')

  return [
    "default-src 'self'",
    "script-src 'self' https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: chrome-extension: https://*.google-analytics.com https://*.googletagmanager.com",
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:"
  ].join('; ')
}
