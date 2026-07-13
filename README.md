# XENTurbo XEN Miner

A pure-frontend, open-source batch miner for XEN.

XENTurbo Miner has no application backend and no user database. Mining state is
read directly from Ethereum or Polygon, and transactions are submitted through
the wallet installed in your browser.

## Use XENTurbo Miner

Both Miner addresses are currently available:

| Version      | Address                   | Status                     |
| ------------ | ------------------------- | -------------------------- |
| New Miner    | https://miner.xenturbo.io | Recommended                |
| Legacy Miner | https://xenturbo.io/miner | Available during migration |

You may continue using either address for now. We recommend gradually switching
to the new independent Miner at:

https://miner.xenturbo.io

The new Miner is designed to operate independently from the legacy XENTurbo
backend. It reads mining state directly from the blockchain and stores temporary
cache and pending-transaction information only in your browser.

## Browser and wallet requirements

- Use Google Chrome on a desktop computer.
- Install MetaMask or another injected EIP-1193 extension wallet.
- Ethereum and Polygon are supported.
- Mobile browsers are not supported.
- WalletConnect, Web3Modal, Reown, and Wagmi are not required.
- Smart-contract wallets are not supported because the Miner contract requires
  `tx.origin == msg.sender`.

## Security notice

Before connecting a wallet or signing a transaction:

- Verify that the address is `miner.xenturbo.io` or `xenturbo.io/miner`.
- Review every transaction carefully in your wallet before signing.
- CryptoCell and XENTurbo will never ask for your seed phrase or private key.
- Gas fees are determined and displayed by your wallet.
- Blockchain transactions involve gas fees and smart-contract risks.
- Avoid operating the same wallet from multiple devices at the same time.

The application never holds your private keys and never sends transactions on
your behalf.

## Download and run locally

All source code is open source. You may download this repository and run
XENTurbo Miner locally on your own computer.

Repository:

https://github.com/maiqiu-cat/XENTurbo-XEN-Miner

Requirements:

- Node.js 24
- npm
- Desktop Google Chrome
- MetaMask or another injected browser wallet

```bash
git clone https://github.com/maiqiu-cat/XENTurbo-XEN-Miner.git
cd XENTurbo-XEN-Miner
nvm use
npm ci
npm run dev
```

Open the local address printed by Vite, normally:

http://127.0.0.1:5173

To test a production build locally:

```bash
npm run build
npm run preview
```

The `.env` file is optional. You can copy `.env.example` if you want to configure
additional Ethereum or Polygon read RPC endpoints:

```bash
cp .env.example .env
```

Custom RPC endpoints can also be added through the RPC control in the Miner.
Only HTTPS endpoints that return the expected chain ID are accepted.

## Optional usage analytics

The production site at `miner.xenturbo.io` offers optional Google Analytics 4
usage analytics. The Google tag is not requested and no analytics event is sent
until the visitor selects **Allow analytics**.

When enabled, GA4 records page and session statistics, approximate location, and
browser/device information. It may store a first-party `_ga` client identifier.
XENTurbo's custom events contain only fixed categories for browser support,
wallet connection outcome, selected chain, RPC health, and Miner operation stage.
They never include wallet addresses, transaction hashes, nonces, RPC URLs, VMU
IDs, form values, or error text.

Advertising storage, advertising user data, ad personalization, and Google
Signals remain disabled. Visitors can change their choice at any time through
**Analytics settings** in the page footer; declining or revoking analytics does
not affect mining. Google explains how it processes partner-site data at
https://policies.google.com/technologies/partner-sites.

Analytics is restricted by hostname and is disabled by default for local builds
and forks unless their operator explicitly supplies a GA4 Measurement ID and an
allowed hostname.

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

## Development and verification

```bash
nvm use                    # Node 24, from .nvmrc
npm ci
cp .env.example .env # optional: set custom Ethereum or Polygon RPC URLs
npm run dev
```

## RPC availability

The Miner checks configured read RPC endpoints before chain operations and uses
only endpoints that pass the health check.

If every configured endpoint is unavailable:

- Chain reads and transaction preparation are blocked.
- The existing RPC list is preserved.
- The Miner asks the user to check internet access, DNS, firewall, proxy, or VPN.
- Users can recheck the existing endpoints or add a custom HTTPS RPC.

Transaction signing and broadcasting still go through the injected wallet.
Public and custom RPC endpoints are used only for chain reads, state validation,
and estimates.

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
same-origin requests, HTTPS RPC endpoints (including user-configured RPCs), and
the minimum Google tag and GA4 image endpoints needed after analytics consent.

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
- For a stuck pending transaction, use MetaMask Activity to choose **Speed up** or
  **Cancel**, then recheck the pending status in the Miner.

## Open-source notice

All code is open source:

https://github.com/maiqiu-cat/XENTurbo-XEN-Miner

Copyright 2026 · [Miner.XENTurbo.io](https://miner.xenturbo.io)
