import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { contentSecurityPolicy } from './src/config/security'

const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy(),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY'
}

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion)
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5300,
    headers: {
      ...securityHeaders,
      'Content-Security-Policy': contentSecurityPolicy(true)
    }
  },
  preview: {
    headers: securityHeaders
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,vue}', 'scripts/*.mjs'],
      // CLI subprocess tests complement the in-process utility and scan coverage.
      exclude: ['src/abis/**', 'src/env.d.ts'],
      thresholds: {
        lines: 53,
        functions: 47,
        statements: 49,
        branches: 46,
        'src/core/txManager.ts': {
          lines: 57,
          branches: 55
        },
        'src/core/pendingOps.ts': {
          lines: 69,
          branches: 55
        }
      }
    }
  }
})
