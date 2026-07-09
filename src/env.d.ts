/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
  readonly VITE_RPC_ETH?: string
  readonly VITE_RPC_POLYGON?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
