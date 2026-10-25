import { defineStore } from 'pinia'
import { CHAINS, type ChainKey } from '@/config/chains'
import {
  initWallet,
  smartConnect,
  onAccountChange,
  switchToChain,
  chainIdToKey
} from '@/core/wallet'
import { ensureHealthyReadProvider, getRpcGeneration, withRetry } from '@/core/rpc'
import { assertReadActive, ReadTimeoutError, withReadDeadline } from '@/core/readDeadline'

interface State {
  address: string | null
  chainId: number | null
  isContractWallet: boolean
  contractWalletChecked: boolean
  contractWalletChecking: boolean
  contractWalletError: string | null
  ready: boolean
  connectError: string | null
  /** True while waiting for the wallet to approve / finish a chain switch. */
  switchingChain: boolean
  switchError: string | null
  /** Monotonic token that invalidates wallet-scoped asynchronous work. */
  contextGen: number
}

interface WalletStoreLifecycle {
  initializing?: Promise<void>
  unsubscribe?: () => void
  detection?: {
    contextGen: number
    rpcGeneration: number
    address: string
    chainId: number
    controller: AbortController
    promise: Promise<void>
  }
}

const walletStoreLifecycles = new WeakMap<object, WalletStoreLifecycle>()

function getWalletStoreLifecycle(store: object): WalletStoreLifecycle {
  const existing = walletStoreLifecycles.get(store)
  if (existing) return existing
  const lifecycle: WalletStoreLifecycle = {}
  walletStoreLifecycles.set(store, lifecycle)
  return lifecycle
}

/**
 * Decide whether an account's code means it is a true smart-contract wallet.
 * EIP-7702 delegated EOAs carry code prefixed with 0xef0100 but are still EOAs
 * (tx.origin == msg.sender holds), so they must NOT be flagged.
 */
function isContractCode(code: string | null | undefined): boolean {
  if (!code || code === '0x') return false
  if (code.toLowerCase().startsWith('0xef0100')) return false // EIP-7702 delegation
  return true
}

function connectionReadTimeout(error: unknown, message: string): string | null {
  if (!/READ_TIMEOUT/i.test(message)) return null
  const detail = error instanceof ReadTimeoutError ? ` ${error.diagnostic}` : ''
  return `Wallet connection read timed out.${detail} Open your wallet extension, check network access, then retry Connect Wallet.`
}

export const useWalletStore = defineStore('wallet', {
  state: (): State => ({
    address: null,
    chainId: null,
    isContractWallet: false,
    contractWalletChecked: false,
    contractWalletChecking: false,
    contractWalletError: null,
    ready: false,
    connectError: null,
    switchingChain: false,
    switchError: null,
    contextGen: 0
  }),
  getters: {
    isConnected: (s): boolean => !!s.address,
    // The active chain key, only if it is a supported chain.
    chainKey: (s): ChainKey | null => (s.chainId ? (chainIdToKey[s.chainId] ?? null) : null),
    isSupportedChain(): boolean {
      return this.chainKey !== null
    }
  },
  actions: {
    async init() {
      const lifecycle = getWalletStoreLifecycle(this)
      if (this.ready) return
      if (lifecycle.initializing) return lifecycle.initializing
      if (!lifecycle.unsubscribe) {
        lifecycle.unsubscribe = onAccountChange((address, chainId) =>
          this.applyAccount(address, chainId)
        )
      }

      const initializing = (async () => {
        try {
          await initWallet()
        } catch (err: any) {
          const message = err?.message || String(err)
          this.connectError = connectionReadTimeout(err, message) ?? message
        } finally {
          this.ready = true
        }
      })()
      lifecycle.initializing = initializing
      try {
        await initializing
      } finally {
        if (lifecycle.initializing === initializing) lifecycle.initializing = undefined
      }
    },

    async applyAccount(address?: string, chainId?: number) {
      getWalletStoreLifecycle(this).detection?.controller.abort()
      const gen = ++this.contextGen
      this.address = address ?? null
      this.chainId = chainId ?? null
      this.isContractWallet = false
      this.contractWalletChecked = false
      this.contractWalletChecking = false
      this.contractWalletError = null
      this.switchingChain = false
      this.switchError = null
      if (address && chainId) {
        await this.detectContractWallet(address, chainId, gen)
      }
    },

    // The factory enforces tx.origin == msg.sender (ONLY_EOA); smart-contract
    // wallets cannot use it, so detect and warn. Read code via OUR reliable RPC
    // (not the wallet RPC, which may be broken and cause false positives).
    async detectContractWallet(_address: string, chainId: number, requestedGen?: number) {
      const gen = requestedGen ?? this.contextGen
      const key = chainIdToKey[chainId]
      const rpcGeneration = key ? getRpcGeneration(key) : 0
      const isCurrent = () =>
        gen === this.contextGen &&
        this.address?.toLowerCase() === _address.toLowerCase() &&
        this.chainId === chainId &&
        (!key || getRpcGeneration(key) === rpcGeneration)
      if (!isCurrent()) return
      if (!key) {
        if (isCurrent()) {
          this.isContractWallet = false
          this.contractWalletChecked = false
        }
        return
      }
      const lifecycle = getWalletStoreLifecycle(this)
      const existing = lifecycle.detection
      if (
        existing?.contextGen === gen &&
        existing.rpcGeneration === rpcGeneration &&
        existing.address.toLowerCase() === _address.toLowerCase() &&
        existing.chainId === chainId &&
        !existing.controller.signal.aborted
      )
        return existing.promise
      existing?.controller.abort()
      const controller = new AbortController()
      this.contractWalletChecked = false
      this.contractWalletChecking = true
      this.contractWalletError = null
      const promise = (async () => {
        try {
          const code = await withReadDeadline(
            async () => {
              const provider = await ensureHealthyReadProvider(key)
              assertReadActive(controller.signal)
              return withRetry((signal) => provider.withSignal(signal).getCode(_address), {
                retries: 1,
                signal: controller.signal
              })
            },
            'Wallet type verification',
            { signal: controller.signal }
          )
          if (isCurrent() && !controller.signal.aborted) {
            this.isContractWallet = isContractCode(code)
            this.contractWalletChecked = true
          }
        } catch (error) {
          if (isCurrent() && !controller.signal.aborted) {
            this.isContractWallet = false
            this.contractWalletChecked = false
            this.contractWalletError =
              error instanceof Error && /READ_TIMEOUT/.test(error.message)
                ? 'Wallet type verification timed out. Check internet access and your RPC endpoints, then recheck.'
                : 'Wallet type could not be verified. Check internet access and your RPC endpoints, then recheck.'
          }
        } finally {
          if (isCurrent() && !controller.signal.aborted) this.contractWalletChecking = false
        }
      })()
      const flight = {
        contextGen: gen,
        rpcGeneration,
        address: _address,
        chainId,
        controller,
        promise
      }
      lifecycle.detection = flight
      const clearFlight = () => {
        controller.abort()
        if (lifecycle.detection === flight) lifecycle.detection = undefined
      }
      void promise.then(clearFlight, clearFlight)
      return promise
    },

    async connect() {
      if (!this.ready) await this.init()
      this.connectError = null
      try {
        const result = await smartConnect()
        if (result === 'no-wallet') {
          this.connectError =
            'No injected wallet detected. Open this page in desktop Chrome with MetaMask (or another injected extension wallet) installed.'
        }
      } catch (err: any) {
        const msg: string = err?.shortMessage || err?.message || String(err)
        this.connectError =
          connectionReadTimeout(err, msg) ??
          (/rejected|denied/i.test(msg) ? 'Connection request rejected.' : msg)
      }
    },

    async switchChain(key: ChainKey) {
      const lifecycle = getWalletStoreLifecycle(this)
      if (!lifecycle.unsubscribe) {
        lifecycle.unsubscribe = onAccountChange((address, chainId) =>
          this.applyAccount(address, chainId)
        )
      }
      if (this.chainKey === key || this.switchingChain) return
      const gen = this.contextGen
      const address = this.address
      const chainId = this.chainId
      const isCurrent = () =>
        gen === this.contextGen && this.address === address && this.chainId === chainId
      this.switchError = null
      this.switchingChain = true
      try {
        await switchToChain(key)
      } catch (err: any) {
        if (isCurrent()) {
          const msg: string = err?.shortMessage || err?.message || String(err)
          this.switchError = /rejected|denied|cancel/i.test(msg)
            ? 'Chain switch rejected in wallet.'
            : msg
        }
        throw err
      } finally {
        if (isCurrent()) this.switchingChain = false
      }
    },

    chainName(): string {
      return this.chainKey ? CHAINS[this.chainKey].name : 'Unsupported'
    }
  }
})
