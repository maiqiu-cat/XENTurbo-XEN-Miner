import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5300
    // Explorer HTML scrape proxy removed: many networks MITM etherscan.io
    // (TLS altname mismatch → Vite 500 spam). Pending age uses pasted
    // "Time Last Seen" text or local first-seen instead.
  }
})
