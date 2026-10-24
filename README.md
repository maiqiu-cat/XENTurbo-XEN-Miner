# XENTurbo XEN Miner

Current release: **v1.1.8**. The page header displays the same version as the source package and Git release tag.

### v1.1.8 Keyless RPC Defaults

- Replaced the Ethereum and Polygon 1RPC defaults with `https://mainnet.gateway.tenderly.co` and `https://polygon.gateway.tenderly.co`, respectively. Other endpoints and their order are unchanged, and saved custom RPC lists are not overwritten.
- Kept the JSON-RPC batch limit at three requests and Multicall limits at 400 entries for Ethereum and 300 for Polygon. Read-only CLI and browser default lists remain aligned.
- Added regressions for Tenderly-only fallback, list refresh and Traditional Chinese language persistence. Contracts, wallet signing, transaction safety gates and language behavior are unchanged.
- Keyless gateways remain subject to provider limits. Live frontend reads passed validation, but an additional Tenderly-specific CREATE2 CLI probe encountered HTTP 429; this is not evidence of contract verification failure or unlimited gateway capacity. The CLI's existing batch settings and strict failure exits are unchanged.

### v1.1.7 RPC Batch Compatibility

- Limited Polygon Multicall reads to 300 entries per call to stay below public-node response limits; Ethereum retains 400. Full scans, targeted reads and failed-read retries use the same chain-specific limit.
- Limited each read provider's JSON-RPC transport batch to three requests, including providers inside the fallback pool. Transport batches and Multicall entries are separate limits.
- Added real ABI/transport regressions and a 601-VMU Polygon browser scenario covering refresh, English/Traditional Chinese switching and reload persistence. Failed reads remain errors, never empty slots.
- Existing RPC lists, contracts, wallet signing, pending reconciliation and safety gates are unchanged. Damaged locks without a hash remain preserved; P2-C remains unproven with no gate relaxation.

### v1.1.6 Traditional Chinese And Test Dependency Security

- Added English and Traditional Chinese interface switching, defaulting to the browser's preferred supported language. Manual choices persist locally and synchronize between tabs without reloading or changing transaction state.
- Localized known application diagnostics, RPC settings, transaction progress, storage recovery and browser requirements. Unrecognized wallet and RPC messages remain verbatim.
- Pinned the development-only `happy-dom` dependency to 21.0.4, fixing GHSA-834v-8h66-3h79. Regression tests cover malformed import aliases and valid module imports; dependency JavaScript evaluation remains disabled by default.
- Added language-selection, transaction-state preservation and dependency-security regressions. Contracts, ABI, RPC defaults, wallet signing and transaction safety gates are unchanged.
- Damaged locks without a hash remain preserved and blocking. P2-C remains unproven; no safety gate has been relaxed.

### v1.1.5 Transaction Recovery And RPC Hardening

- Preserved configured RPC lists on failures, bounded configuration validation, and distinguished invalid settings from unavailable networks consistently across the interface.
- Strengthened pending reconciliation, wallet-context invalidation and cross-tab transaction serialization. A failed check cannot revive an earlier signing intent.
- Preserved timely and late transaction hashes when browser storage fails. Damaged transaction records can be exported and repaired only with matching wallet-authenticated mined receipts.
- Damaged locks without a transaction hash remain preserved and block mining in that browser profile. There is no automatic deletion or in-app bypass; retain the backup for manual investigation.
- Hardened read cancellation, pinned-block CREATE2 probes, CLI entry validation and rate-limit diagnostics. Updated compatible development dependencies without changing major versions.
- P2-C remains **unproven**: historical destroy/count semantics lack a complete evidence match to both current deployments. Strict boundary checks, active witnesses and nonzero NOT_VERIFIED exits remain required.
- Contracts, ABI, deployment addresses, default RPC lists, wallet-selected Gas and Cloudflare Analytics behavior are unchanged. Transaction tests use mock wallets and RPC; they do not establish real-wallet or historical contract semantics.

### v1.1.4 Read Recovery And Analytics

- Updated compatible Vue and transitive dependency patches without changing Pinia, TypeScript or Node major versions.
- Bounded initial wallet, wallet-type and Gas display reads. Timed-out reads release their waiting state, ignore late responses and allow retry; unchecked wallets remain blocked.
- Saving RPC settings restarts wallet verification and stale VMU scans against the new configuration. Late responses from the previous configuration cannot replace the new results.
- Reused receipt-block VMU snapshots for result verification and removed one redundant confirmed-record write, retaining the first terminal record and final outcome.
- Derived failed VMU addresses in bounded retry batches, with cancellation checks before each batch.
- Based maturity countdowns on chain time and monotonic elapsed time, not the computer's clock. Reaching zero does not enable claiming without chain confirmation.
- Resuming a page refreshes its chain-time anchor without rescanning the full VMU inventory. Concurrent recovery reads are coalesced and bounded; unavailable chain time never enables claiming.
- Removed Google Analytics and its custom events. The production hostname uses the supplied Cloudflare Web Analytics module beacon instead.

### v1.1.3 Reliability And Security

- Final transaction gas is estimated and simulated through the injected wallet. Configured RPC estimates remain advisory; gas prices remain wallet-selected.
- Remote pending candidates are authenticated through the wallet before persistence. Receipt and replacement reconciliation use chain-bound wallet evidence; ambiguous and legacy records remain conservative.
- Reads have bounded timeouts and cancellation. Corrupted RPC settings or blocked IndexedDB caches no longer prevent recovery; configured RPC lists are preserved on network failure.
- Result verification reads the receipt block and checks requested mint terms, maturity and changed rank. Selected VMUs refresh incrementally when the wallet inventory is complete.
- Existing contracts, chain support and wallet-signing consent are unchanged.

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

The interface supports English and Traditional Chinese. The header language menu
defaults to the first supported language in the browser's preference list. Chinese
locales (including `zh-TW`, `zh-HK` and `zh-CN`) use Traditional Chinese; other
unsupported languages fall back to English. Select **English** or **繁體中文** to
remember a manual choice, or **Browser language / 跟隨瀏覽器** to restore automatic
selection. This preference is stored only in this browser. Language changes do not
reload the page, reconnect the wallet, or change transaction data. External wallet
and RPC diagnostics without a known translation are kept verbatim.

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

http://localhost:5300

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
Custom lists allow up to 16 distinct endpoints, with a 2,048-character limit per
normalized URL. The raw input text is limited to 32,784 characters, including
whitespace and line separators. Saving settings validates at most four endpoints
concurrently; after failure it stops dispatching and waits for in-flight checks
before allowing another save. Operation
health checks probe the bounded list in parallel to preserve wallet read
deadlines. Failed checks preserve the configured list; check the local network
or edit RPC settings to recover. Legacy entries exceeding the new limits remain
visible and are rejected explicitly until edited, rather than silently selecting
defaults or deleting the saved configuration. Configuration errors are shown
separately from network failures. Transaction controls remain blocked until the
current wallet and chain have completed pending reconciliation successfully.
Returning from a hidden tab requires a new reconciliation. An explicit Recheck
also retains its stronger RPC and result-verification options when another
check is already running.

If browser transaction storage fails after the wallet returns a hash, the
transaction remains submitted. The Miner keeps the hash in the current tab and
attempts a separate recovery copy; the earlier pending record continues to block
resubmission. Keep the page open, save the explorer link, and check wallet Activity.
Do not clear site data or resend to resolve a storage error. When both durable
writes fail, the hash cannot be guaranteed to survive a reload. Unreadable pending
records block submission and are preserved for recovery.

The **Transaction storage recovery** control inspects the journal and lock cache
without clearing them. Export and retain the private JSON backup first. Repair
requires the connected wallet to return a mined receipt matching the damaged
record's account, network, transaction hash and Miner contract. The original
snapshot is also archived in browser storage and read back before any repair.
Valid records and unrelated accounts are preserved; changes from another tab
invalidate the preview. A zero nonce gap, an expired lock, or a public RPC
response cannot authorize deletion. Unreadable JSON, unidentified records and
unconfirmed transactions remain blocked for manual investigation. This is not a
reset-site-data control and does not guarantee recovery of lost transaction identity.

The recovery panel distinguishes unreadable JSON, invalid containers and malformed
records. Unidentified records, other wallet/network records, missing mined receipts
and the 20-record verification limit are reported separately. A deferred record is
not a settled record. Closing recovery or changing the wallet context cancels its
read-only work; submitting again still requires successful pending reconciliation.

Cancelling a prepared operation invalidates that preparation, including its shared
UI references. A fresh preparation is required before sending. Once the request
has been handed to the wallet, cancellation cannot remove its pending evidence or
make the same prepared object reusable.

### PR #7 Validation Scope

The previously reported **147 tests / 6 failures** was an early, focused negative
control: production source and scripts were at `ead7a18`; only
`tests/concurrency.test.ts`, `tests/localLock.test.ts` and
`tests/transactionSafety.integration.test.ts` contained the new regression tests.
Eight files were run (those three plus `usePendingTx`, `checkRpcHealth`,
`releaseProbe`, `rpc` and `verifyCreate2`): 141 passed and 6 failed. It was not the
final test suite running against old code, nor old tests failing on new code.
The six failures covered three lock-cache preservation cases, two timely-hash
storage-failure states and one late-hash fallback. The later `194355b` candidate
passed 548 unit/integration tests and 30 browser tests in isolated local validation.
These historical counts are not a claim about subsequent revisions.

P2-C remains **unproven**: the historical destroy/count semantics have not been
matched to both current deployed implementations and historical chain evidence.
CREATE2 verification still requires pinned-block boundary bytecode checks and
an active on-chain witness. Exit code 2 means **not verified**, including a budget
limit, no VMUs, no active witness, an out-of-range start, or a rate-limit delay
that cannot fit the budget; none of these is a release pass. Exit code 3 denotes
a proven boundary/derivation mismatch; other errors use exit code 1.

RPC and transport failures require fixing the cause and starting a fresh full
verification; only scan limits and scan deadlines advertise continuation. Rate-limit
diagnostics distinguish a server `Retry-After` from fallback exponential backoff
that cannot fit the budget. Both remain **not verified**. During a failed ethers
network bootstrap, its outstanding one-second retry delay can briefly postpone
process exit; provider and HTTP resources are still destroyed. Network detection
and CREATE2 boundary checks are not disabled to hide that dependency behavior.

## Page and performance analytics

The production hostname `miner.xenturbo.io` automatically loads the configured
[Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/)
module beacon. There is no analytics confirmation dialog. Google Analytics,
Google tags and the previous custom operation events have been removed.

The beacon provides page traffic and browser performance measurements. The
Miner does not attach wallet addresses, transaction hashes, nonces, RPC URLs,
VMU IDs, form values or error messages to analytics. It does not send custom
wallet, RPC or transaction-stage events. An unavailable or blocked beacon must
not affect wallet connections or mining.

The remote beacon is trusted third-party JavaScript and shares the page's
privileges; `type="module"` is not a security sandbox. Local tests replace the
beacon with a fixture to verify the loader and mining behavior. They do not
verify the real remote script's data collection or its future changes.

The loader checks the exact production hostname and avoids adding a second
beacon when Cloudflare has already injected one. Analytics is disabled on
localhost, IP-address previews and forks hosted on other domains, so local
verification does not send traffic to the production analytics site.

When publishing to another hostname, configure its own Cloudflare Analytics
site and update `src/core/cloudflareAnalytics.ts`. The browser beacon token is
public configuration, not a Cloudflare API credential. Manual beacon setup does
not require changing the site's DNS or CDN provider; see
[Cloudflare's setup guide](https://developers.cloudflare.com/web-analytics/get-started/).

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
through the active injected wallet (`FEE()`) and multiplied by the actual operation
units immediately before sending. The public RPC fee is advisory, not an authority
for transaction value. Gas pricing is left to the wallet rather than copied from a public RPC.
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
successive VMU batches until it finds an active derived proxy, with a default
budget of 1,000 VMUs and 30 seconds for the whole check. Budget exhaustion returns
`NOT_VERIFIED` (exit code 2), not a derivation mismatch. Resume with the reported
`--from-id`, or adjust `--scan-limit` (up to 100,000) and `--deadline-ms` (up to
300,000). Reads are pinned to one block. Before accepting an active witness, the
gate checks exact proxy runtime code at the first and last allocated IDs and
absence at the next ID (when representable), catching constant numbering shifts.
This supplements fixed-address unit tests; it does not prove every intermediate ID.

Exit codes are `0` for verified, `1` for arguments/RPC errors, `2` for unverified
(including budget exhaustion, no VMUs, an out-of-range start, or no active witness),
and `3` for a proxy boundary mismatch. Scan progress and continuation IDs are
reported on interruption. The scan budget bounds verification, not an OS-level
process kill deadline.
Chain and proxy-boundary mismatches require investigating the configuration or
RPC response; continuing at another page does not resolve those failures. A
boundary mismatch alone does not establish a faulty derivation: historical proxy
destruction or inconsistent RPC state requires separate investigation. The gate
remains non-successful until a complete witness check passes.

Use `--rpc https://...` to override the selected chain's default RPC. Plain HTTP
is permitted only for explicit loopback test endpoints. Redirects are rejected;
supply the final endpoint URL. HTTP 429 responses receive at most two retries,
respecting Retry-After within the total verification budget. Release probes use
strict JSON-RPC batch/ABI validation and reject redirects. Their chain IDs must
use canonical hexadecimal quantities, so a noncanonical `0x01` is rejected.
Remote diagnostic control characters are escaped to keep each CLI result on one
line, and transport failures include their available underlying cause.

Playwright uses a dedicated local production-preview server on port 4173. If that
port is occupied by another application, keep that application running and set
`PLAYWRIGHT_PORT`, for example `PLAYWRIGHT_PORT=4184 npm run verify`. The same
override works with `npm run test:e2e`; CI retains the default port.

## Security headers

Vite development and preview responses include the release security headers so they
can be validated locally. A matching Nginx snippet is prepared at
`ops/nginx/security-headers.conf` for production deployment. The CSP allows
same-origin requests, HTTPS RPC endpoints (including user-configured RPCs), and
the Cloudflare beacon script endpoint. Inline scripts remain disallowed; the
removed Google tag and GA4 image endpoints are no longer allowlisted. Publishing
this analytics change also requires updating the production CSP snippet; changing
the local snippet does not modify a live server.

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
