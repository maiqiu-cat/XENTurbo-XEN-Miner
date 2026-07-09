# XENTurbo XEN Miner

A pure-frontend batch miner for XEN, rewritten from the XENTurbo `miner` module.
**No backend. No database.** Every piece of state is derived from on-chain data,
so the app is a single static site you can host anywhere.

## Why no backend is needed

The original platform used a Java service + MySQL to store VMU proxy addresses,
per-VMU mint state, and locks. All of that is reconstructible from the chain:

| Original backend responsibility | Replacement here |
| --- | --- |
| VMU proxy addresses (`xm_wallet_proxy_contract`) | Computed locally via CREATE2 (`src/core/create2.ts`) |
| VMU count (`xm_wallet.vmu_count`) | `factory.vmuCount(wallet)` |
| Per-VMU rank/term/maturity | `XENCrypto.userMints(proxy)`, batched via Multicall3 |
| Mint-list grouping | Grouped client-side by `(term, maturityTs)` |
| VMU concurrency lock (`xm_vmu_lock`) | Best-effort `localStorage` lock + re-read before send |
| Pending-tx monitor (Puppeteer scraper) | Session tx tracking + resume-on-reload |
| Cache | Browser IndexedDB (safe to clear anytime) |

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
live from the contract (`FEE()`), so it still flows to the original fee receiver.
Add more chains in `src/config/chains.ts` + `src/config/contracts.ts`.

## Setup

```bash
npm install
cp .env.example .env   # set VITE_WALLETCONNECT_PROJECT_ID (from cloud.walletconnect.com)
npm run dev
```

## Scripts

- `npm run dev` - dev server
- `npm run build` - typecheck + production build
- `npm run test` - unit tests (CREATE2 derivation)
- `npm run verify:create2 [wallet] [rpcUrl]` - verify derivation against live chain

## Notes / limitations

- Requires an EOA wallet. The contract enforces `tx.origin == msg.sender`, so
  smart-contract wallets (Safe, etc.) are detected and blocked in the UI.
- The VMU lock is per-browser only. Operating the same wallet on multiple devices
  simultaneously can waste gas; the UI re-reads chain state before each send.
- Large wallets (tens of thousands of VMUs) take a moment on first load; results
  are cached in IndexedDB, and the source of truth is always the chain.
- If you hit RPC error `-32603`, add your own RPC endpoint via the in-app RPC button.
