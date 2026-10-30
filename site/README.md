# Public documentation and SEO maintenance

This directory contains curated public content, not an application runtime or a
deployment credential store. Only explicitly generated HTML, CSS, crawl files,
the 404 page and the approved screenshot enter the build. Never copy all of
`docs/`, `backups/`, review material or private operations notes into `dist/`.

## Scope and content review

- The Miner stays at `/`, with the existing UI and language preference. The only
  visible app addition is a localized footer documentation link that opens a new tab.
- `content.json` has five topics in `en` and `zh-hant`. `reviewedOn` and
  `reviewedVersion` describe an actual content review, not a build or visit timestamp.
  Recheck statements against source before changing either field.
- Canonical language URLs are `/docs/en/` and `/docs/zh-hant/`, with
  `operations/`, `rpc-and-pending/`, `security/`, and `versions/` below each.
  Each translation has its own canonical and reciprocal language alternatives.
  There are no language-dependent server redirects or locale-specific cache variants.
- Contract addresses come from the app's existing configuration. The docs do not
  import app runtime modules into the browser, load ethers, request a wallet,
  contact a public RPC, or load analytics. The production app's Cloudflare beacon
  is unchanged.
- The screenshot is a local capture of the disconnected desktop interface with
  controlled read responses; it contains no real wallet or transaction activity.
- No fake reviews, offers, license claims or audit certifications are added.
  P2-C remains unproven. Hashless damaged locks, stale-data restrictions, RPC
  lists/order, batching, concurrency, retries and safety gates are unchanged.

## Local verification

1. Run `npm run verify`. This includes the output allowlist and SEO gate, existing
   unit/component checks and browser E2E tests. Browsers and RPCs are mocked in
   transaction tests; passing them is not a live-chain or real-wallet claim.
2. Run `npm run preview -- --host 127.0.0.1 --port 4175 --strictPort` on a free port.
   Confirm English/Traditional Chinese navigation and refresh, static text with
   JavaScript disabled, image loading, no overflow, no console/CSP errors, and no
   wallet/RPC activity on documentation pages.
3. Compare the app at desktop and narrow viewports with the prior build. Only the
   approved footer addition should change layout. Do not suppress differences in
   transaction forms, warnings, controls or list geometry to make screenshots pass.
4. Check real 404s and canonical redirects in preview. Preview middleware serves
   built document bodies, not regenerated source, and prevents preview indexing.
   A Vite preview result alone does not prove production Nginx behavior.
5. Keep the existing JS budgets: 100 KiB gzip per chunk and 190 KiB total. Do not
   add runtime SEO dependencies to the application bundle.

## Production gate (requires separate release authorization)

1. Follow the project's private deployment/operations manual. Back up the current
   release, site configuration and relevant CDN settings, record checksums and
   the prior release target, and retain both server and off-host backup copies.
2. Reconcile `ops/nginx/public-routes.conf` against the live HTTPS virtual host.
   It is a candidate replacement for the index/assets/catch-all locations, not
   an additional include beside duplicate locations. Retain existing TLS,
   hostname, root, HTTP-to-HTTPS redirect and security headers. Do not overwrite
   unrelated local Nginx edits. Verify syntax before reloading only the affected site.
3. Publish the complete build atomically using the existing release procedure.
   Deploying files alone does not fix the old catch-all fallback for unknown URLs.
4. Validate origin and CDN separately: `/` and ten documents return 200; known
   index/slash aliases return one canonical redirect; missing pages and assets
   return 404; `robots.txt` is text and `sitemap.xml` is XML. All public canonical
   URLs use the Miner HTTPS origin. Public pages must not have preview `noindex`.
5. Purge changed HTML, document/CSS/image URLs, robots and sitemap as needed.
   Keep hashed app assets immutable. Verify security headers, document content,
   language links, app interactions and TLS through the CDN after cache refresh.
6. Update the private manual with the release, backup, verification and rollback
   evidence. Do not publish the private manual in this repository or website.

## Discovery and measurement (not automatic)

- After deployment, verify site ownership in Google Search Console and Bing
  Webmaster Tools using the owner's approved method; submit the sitemap and
  inspect representative URLs. Do not commit access tokens or ownership material
  without a separate, reviewed decision.
- Check public document access at the CDN/WAF using verified crawler identity
  where available. Never broadly disable firewall rules based on a User-Agent.
- The generic robots policy permits public crawling. No specific GPTBot or
  Google-Extended training policy change is made here. Search and training
  choices are separate owner decisions.
- Keep traffic measurement with the existing Cloudflare integration. Do not
  transmit wallet addresses, hashes, RPC credentials or recovery exports into
  analytics, URL parameters or public diagnostics. The docs add no tracking.
- Observe crawl errors, indexing, impressions, clicks and identifiable AI referral
  traffic after 7, 28 and 56 days. No ranking, rich result or AI citation is promised.
  `llms.txt` is deferred; it is not required for this release.

## Rollback

For a functional or visual regression, a weakened gate, a wrong canonical/noindex
or a broken legitimate route, stop the rollout and restore the previous release
and matching site configuration. Check syntax, reload only when necessary and
refresh affected CDN entries. Never erase browser storage, snapshots, pending
records or locks as part of SEO rollback. Do not touch unrelated sites or mail jobs.

Recheck both origin and CDN after rollback. Reverted crawl directives can take
time to be recrawled; a successful server rollback is not an immediate search-index
rollback. Record what was restored and which public checks passed.

## References

- [Google AI features and websites](https://developers.google.com/search/docs/appearance/ai-features)
- [Google multilingual URLs](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
- [OpenAI crawler roles](https://developers.openai.com/api/docs/bots)
