/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_RPC_ETH?: string
  readonly VITE_RPC_POLYGON?: string
  readonly VITE_GA_MEASUREMENT_ID?: string
  readonly VITE_GA_ALLOWED_HOSTNAME?: string
}

interface Window {
  dataLayer?: unknown[][]
  gtag?: (...args: unknown[]) => void
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
