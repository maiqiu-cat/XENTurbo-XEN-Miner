# XENTurbo XEN Miner

A pure-frontend batch miner for XEN, rewritten from the XENTurbo `miner` module.
**No backend. No database.** Every piece of state is derived from on-chain data,
so the app is a single static site you can host anywhere.

## Why no backend is needed

The original platform used a Java service + MySQL to store VMU proxy addresses,
per-VMU mint state, and locks. All of that is reconstructible from the chain:

| Original backend responsibility                  | Replacement here                                      |
| ------------------------------------------------ | ----------------------------------------------------- |
| VMU proxy addresses (`xm_wallet_proxy_contract`) | Computed locally via CREATE2 (`src/core/create2.ts`)  |
| VMU count (`xm_wallet.vmu_count`)                | `factory.vmuCount(wallet)`                            |
| Per-VMU rank/term/maturity                       | `XENCrypto.userMints(proxy)`, batched via Multicall3  |
| Mint-list grouping                               | Grouped client-side by `(term, maturityTs)`           |
| VMU concurrency lock (`xm_vmu_lock`)             | Best-effort `localStorage` lock + re-read before send |
| Pending-tx monitor (Puppeteer scraper)           | Session tx tracking + resume-on-reload                |
| Cache                                            | Browser IndexedDB (safe to clear anytime)             |

The miner contract (`XENFactoryUpgradeable`) is reused as-is; users' wallets call
it directly. The app never holds keys or sends transactions on the user's behalf.

## Browser and wallet requirements

- Desktop Google Chrome is the supported browser.
- Install MetaMask or another injected EIP-1193 extension wallet.
- Mobile browsers, WalletConnect, Web3Modal, Reown, and Wagmi are not supported.
- Wallet requests go directly through `window.ethereum`; no wallet relay or QR service is used.

## How the mining works

Minting happens entirely on-chain. The factory uses CREATE2 to deploy EIP-1167
minimal-proxy VMUs and calls the official `XENCrypto`:

```
salt   = keccak256(abi.encodePacked(wallet, uint256(id)))       // id = 1..vmuCount
proxy  = create2(factory, salt, keccak256(minimalProxyInitCode)) // initCode targets VMUTemplate
```

`src/core/create2.ts` reproduces this exactly. It is verified to be byte-identical
to the project's own production derivation (`contract/.../utils/contract.util.ts`)
in `tests/create2.test.ts`, and against live mainnet data via
`npm run verify:create2`.

## Supported operations

Same five on-chain operations as the original Manual Batch tool:

1. General Mint - `bulkClaimRank(term, count)`
2. Create Empty Slots - `createVMUs(count)`
3. Empty Slots Mint (reuse) - `reuseVMUs(ids, term)`
4. Claim - `bulkClaimMintReward(ids)`
5. Claim & Re-Mint - `bulkClaimMintRewardAndClaimRank(ids, term)`

## Chains

Ethereum and Polygon (both use the deployed factory
`0xfEF2359e77Df8B769760D62cbB5eE676FE78f6C2`). The per-VMU service fee is read
through the active injected wallet (`FEE()`) and cross-checked against the read RPC
at send time. Gas pricing is left to the wallet rather than copied from a public RPC.
Add more chains in `src/config/chains.ts` + `src/config/contracts.ts`.

## Setup

```bash
nvm use                    # Node 24, from .nvmrc
npm ci
cp .env.example .env   # optional: set custom Ethereum or Polygon RPC URLs
npm run dev
```

## Scripts

- `npm run dev` - dev server
- `npm run build` - typecheck + production build
- `npm run test` - unit and wallet integration tests
- `npm run test:coverage` - run tests with the release coverage threshold gate
- `npm run test:e2e` - build and run the production-preview Playwright suite
- `npm run typecheck` - TypeScript and Vue type checking
- `npm run lint` - ESLint checks for Vue and TypeScript
- `npm run format:check` - Prettier formatting check
- `npm run check:bundle` - enforce gzip bundle budgets against `dist/`
- `npm run check:rpc-health` - check every script-configured default RPC for HTTPS, chain ID, and factory `FEE()`
- `npm run verify` - run unit, type, build, bundle, audit, and browser release gates
- `npm run verify:create2 -- --chain eth --wallet 0x...` - verify derivation against the selected live chain

`verify:create2` requires an explicit witness address for the selected chain: pass
`--wallet 0x...`, or set `CREATE2_WITNESS_ETH` / `CREATE2_WITNESS_POLYGON`. It scans
successive VMU batches until it finds an active derived proxy. Use `--rpc https://...`
to override the script's default RPC for the selected chain.

## Security headers

Vite development and preview responses include the release security headers so they
can be validated locally. A matching Nginx snippet is prepared at
`ops/nginx/security-headers.conf` for production deployment. The CSP allows
same-origin requests and HTTPS RPC endpoints, including user-configured RPCs.

## Bundle budget

Before removing the unused WalletConnect/Web3Modal/Wagmi stack, the main application
bundle measured **674.61 KiB gzip**. The enforced production budgets are:

- largest JavaScript chunk: at most **180 KiB gzip**
- all JavaScript files in `dist/`: at most **220 KiB gzip**

Run `npm run build && npm run check:bundle` before publishing. The check prints every
measured JavaScript chunk and exits non-zero when either limit is exceeded.

## Notes / limitations

- Requires an EOA wallet. The contract enforces `tx.origin == msg.sender`, so
  smart-contract wallets (Safe, etc.) are detected and blocked in the UI.
- The VMU lock is per-browser only. Operating the same wallet on multiple devices
  simultaneously can waste gas; the UI re-reads chain state before each send.
- Large wallets (tens of thousands of VMUs) take a moment on first load; results
  are cached in IndexedDB, and the source of truth is always the chain.
- If you hit RPC error `-32603`, add your own RPC endpoint via the in-app RPC button.
  Custom endpoints must use HTTPS and return the selected chain ID before they are saved.
