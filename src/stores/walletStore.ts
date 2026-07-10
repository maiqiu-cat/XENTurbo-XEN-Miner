import { defineStore } from 'pinia'
import { CHAINS, type ChainKey } from '@/config/chains'
import {
  initWallet,
  smartConnect,
  onAccountChange,
  currentAccount,
  switchToChain,
  chainIdToKey
} from '@/core/wallet'
import { getReadProvider } from '@/core/rpc'

interface State {
  address: string | null
  chainId: number | null
  isContractWallet: boolean
  ready: boolean
  connectError: string | null
  /** True while waiting for the wallet to approve / finish a chain switch. */
  switchingChain: boolean
  switchError: string | null
  /** Monotonic token that invalidates wallet-scoped asynchronous work. */
  contextGen: number
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

export const useWalletStore = defineStore('wallet', {
  state: (): State => ({
    address: null,
    chainId: null,
    isContractWallet: false,
    ready: false,
    connectError: null,
    switchingChain: false,
    switchError: null,
    contextGen: 0
  }),
  getters: {
    isConnected: (s): boolean => !!s.address,
    // The active chain key, only if it is a supported chain.
    chainKey: (s): ChainKey | null => (s.chainId ? chainIdToKey[s.chainId] ?? null : null),
    isSupportedChain(): boolean {
      return this.chainKey !== null
    }
  },
  actions: {
    init() {
      if (this.ready) return
      initWallet()
      const acc = currentAccount()
      this.applyAccount(acc.address, acc.chainId)
      onAccountChange((address, chainId) => this.applyAccount(address, chainId))
      this.ready = true
    },

    async applyAccount(address?: string, chainId?: number) {
      const gen = ++this.contextGen
      this.address = address ?? null
      this.chainId = chainId ?? null
      this.isContractWallet = false
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
      const isCurrent = () =>
        gen === this.contextGen &&
        this.address?.toLowerCase() === _address.toLowerCase() &&
        this.chainId === chainId
      const key = chainIdToKey[chainId]
      if (!key) {
        if (isCurrent()) this.isContractWallet = false
        return
      }
      try {
        const code = await getReadProvider(key).getCode(_address)
        if (isCurrent()) this.isContractWallet = isContractCode(code)
      } catch {
        if (isCurrent()) this.isContractWallet = false
      }
    },

    async connect() {
      this.connectError = null
      try {
        const result = await smartConnect()
        if (result === 'no-wallet') {
          this.connectError =
            'No injected wallet detected. Open this page in a normal browser (Chrome/Brave/Firefox) with MetaMask (or another extension wallet) installed. If you are viewing inside the IDE preview pane, open http://localhost:5300 in your system browser instead. Alternatively, set VITE_WALLETCONNECT_PROJECT_ID in .env to enable WalletConnect (mobile QR).'
        }
      } catch (err: any) {
        const msg: string = err?.shortMessage || err?.message || String(err)
        this.connectError = /rejected|denied/i.test(msg) ? 'Connection request rejected.' : msg
      }
    },

    async switchChain(key: ChainKey) {
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
