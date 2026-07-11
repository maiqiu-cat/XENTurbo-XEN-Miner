import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { contentSecurityPolicy } from './src/config/security'

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
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 65,
        'src/core/txManager.ts': {
          lines: 85,
          branches: 75
        },
        'src/core/pendingOps.ts': {
          lines: 85,
          branches: 75
        }
      }
    }
  }
})
