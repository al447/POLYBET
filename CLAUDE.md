# CLAUDE.md

Working context for the Polymarket Integration Platform. **Keep this file current** — see [Maintenance Protocol](#maintenance-protocol) at the bottom.

> **Last updated:** 2026-08-19 (rebrand to Polybets) · **Phase:** Milestone 1 substantially complete (auth, geo-gate, fee engine, Deposit Wallet + deposit UI, pre-trade authorization, client-side market-order signing all built and verified on local workerd) · Weeks 2–4 (**Market Discovery, Trading Engine & WebSockets, Portfolio/Testing & Launch**) now being executed as **one combined build phase** — see the Milestones section below · **Repo:** on `feat/milestone_2`, 6+ commits
>
> **Deploy status — updated 2026-08-09.** First deploy **attempted and rejected 2026-08-05** — the client's Cloudflare account was on **Workers Free** and the upload failed with `exceeded the size limit of 3 MiB [code: 10027]`. **Resolved 2026-08-09: the client upgraded to Workers Paid, and a deploy has now succeeded** on the default `*.workers.dev` subdomain. All six request-time secrets are pushed (`wrangler secret put` — the four `POLYMARKET_BUILDER_*`, `PRIVY_APP_SECRET`, `POLYGON_RPC_URL`), and both build-time vars (`NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_POLYMARKET_BUILDER_CODE`) were exported before this build — so the deployed instance should be running in **live mode** with login and builder attribution both wired, not mock mode. **Not yet done:** the custom domain is not wired (still on `*.workers.dev`, not `POLYBETS.XYZ`), and none of [deployment.md §5](deployment.md#5-post-deploy-verification)'s 9 post-deploy checks (signing spike, health, geoblock, security headers, login end-to-end, etc.) have actually been run or recorded against this deployment — the config being in place is not the same as confirming it works. Run §5 before treating this as verified.
>
> - **P-7 — resolved 2026-08-09.** Workers Paid active, first deploy succeeded, secrets pushed, build-time vars set. Remaining: wire custom domain, run §5 verification.
> - **P-8 (domain) — updated 2026-08-19.** Production domain is **`POLYBETS.XYZ`**, client states it's already pointed at Cloudflare. **Not yet independently verified** — no Cloudflare zone/DNS check has been run from this environment. Confirm zone delegation is active before wiring `wrangler.jsonc` custom-domain routes or relying on it for the Verified-tier application's live-demo URL.
>   **The brand now exists in code (2026-08-19).** The app had never been named — the wordmark was the literal string `Prediction Markets` and the favicon was the untouched `create-next-app` icon. It is now **`Polybets`** in sentence case (nav wordmark, `<title>`, Privy `landingHeader`), with the full `POLYBETS.XYZ` reserved for where the *domain* is meant. `metadataBase` in `app/layout.tsx` is **hardcoded** to `https://polybets.xyz` — deliberately not an env var, because a `NEXT_PUBLIC_*` would reintroduce the build-time-inlining trap and fail silently.
>   ⚠️ **The Worker, R2 bucket and `package.json` were deliberately NOT renamed.** `wrangler.jsonc` `name`/`service` stay `polymarket-integration-platform` and the bucket stays `polymarket-platform-cache`. Renaming a Worker does not rename in place — it creates a *new* script, orphaning the six pushed secrets and the R2 binding, and requires re-pushing every secret by hand. The worker name is never user-visible once the custom domain routes, so the cost buys nothing.
> - **P-9 — resolved 2026-08-09.** `POLYGON_RPC_URL` pushed as part of the same secrets batch.
>
> Everything not requiring client access is done and verified on local workerd. See [deployment.md](deployment.md).

## Layout

```
src/
  middleware.ts            geo gate (Edge — NOT proxy.ts, see below)
  app/
    icon.svg               favicon — same geometry as `LogoMark`, literal hex (no `currentColor`), on a filled field
    opengraph-image.tsx    1200x630 share card via next/og (built 2026-08-19)
    apple-icon.tsx         180x180 iOS icon via next/og — full-bleed, iOS applies its own corner radius
    restricted/            geoblocked landing
    market/[slug]/         market detail page, keyed by EVENT slug (Step 2.4, built 2026-08-07)
    portfolio/             positions + PnL (Steps 4.1-4.2, built 2026-08-09) — browser-side reads, no server fetch
    copy-trade/            Copy Trading landing + signed-in dashboard (built 2026-08-17) — engine runs DRY, see Traps
    leaderboard/           full trader board (built 2026-08-17) — server-rendered incl. tabs, no client JS
    api/health             secret presence + builder readiness
    api/geoblock           per-request geo tier (never cached)
    api/auth/me            server-verified session (FR-1.1)
    api/builder/sign       HMAC signing for client-side order signing (SEC-1/2)
    api/orders             pre-trade authorization — NOT order placement, see Traps
    api/markets            Gamma event-list proxy, cached (FR-2.1/2.2/2.5) — sort + range filters
    api/markets/search     Gamma /public-search proxy, cached (FR-2.4) — page-numbered, NOT cursor
    api/markets/price-history  CLOB /prices-history proxy, cached — takes a range ID, all series in one call
    api/spike/signing      Workers signing diagnostic (Milestone 1 gate)
  lib/
    env.ts                 request-time secrets via getCloudflareContext
    geo/{jurisdictions,edge,index}.ts
    auth/{types,privy,session}.ts
    polymarket/gamma-types.ts                   types + parsing, NOT server-only (client-safe)
    polymarket/{config,fees,builder,gamma}.ts   clob.ts removed 2026-08-07, was dead code
    polymarket/price-history-types.ts           PricePoint, PRICE_RANGES, toSparklinePath — client-safe, NOT server-only
    polymarket/price-history.ts                 CLOB /prices-history fetch + cache (server-only)
    polymarket/leaderboard-types.ts             LEADERBOARD_PERIODS/ORDERINGS + traderDisplayName — client-safe, NOT server-only
    polymarket/leaderboard.ts                   Data API /v1/leaderboard fetch + cache (server-only, built 2026-08-17)
    format.ts                                   formatUsd / formatUsdExact / formatEndDate / formatRelativeTime / shortenAddress — shared; `ui/primitives` re-exports shortenAddress, lib must not import components
    polymarket/browser-client.ts                client-side signing, balance/approvals (market orders; limit orders pending) — `createBrowserClient` dedupes concurrent connects, see the ky-timeout trap
    polymarket/clob-credentials.ts              sessionStorage cache of the user's L2 CLOB creds + connect-error vocabulary (built 2026-08-19) — client-safe, NOT server-only; exists to keep `POST /auth/api-key` off the hot path
    polymarket/market-data.ts                   unauthenticated public client + order-book WS reducer (Step 3.1, built 2026-08-09)
    polymarket/user-events.ts                   authenticated user-channel subscribe + pure fill/order reducer (Step 3.7, built 2026-08-09)
    polymarket/portfolio.ts                     browser-side Data API positions + pure PnL aggregation (Steps 4.1-4.2, built 2026-08-09) — NOT a cached server proxy, see its docstring
    polymarket/withdraw.ts                      Bridge API client + pure validateWithdrawal (FR-4.6, built 2026-08-09) — SDK does NOT wrap this API
    copy-trade/types.ts                         shapes + COPY_EXECUTION_MODE, the one switch that decides whether copies spend money — now "live" (built 2026-08-17)
    copy-trade/engine.ts                        PURE decision core: fill grouping, cursor, caps, exit fractions (built 2026-08-17) — no fetch, no Date.now()
    copy-trade/execute.ts                       post-approval checks + `placeCopy`, the ONLY signer in this feature (built 2026-08-18, placement 2026-08-19) — reached only from a user click
    copy-trade/trader-feed.ts                   browser-side Data API /trades + /positions for a FOLLOWED trader — never authenticated
    copy-trade/store.ts                         localStorage follows + ledger, sanitisers treat stored JSON as untrusted input
  hooks/
    use-orderbook.ts         live order book, reconnect + full resync on reopen (Step 3.1, built 2026-08-09)
    use-user-channel.ts      live fills/order status on the user's own authenticated client (Step 3.7, built 2026-08-09) — emits a `revision` counter to refetch on, NOT state to render
    use-browser-client.ts    shared connect/auto-reconnect state machine (built 2026-08-09); portfolio uses it, trading-panel + deposit-wallet-panel still on their own copies. ⚠️ a hook, not a context — every caller gets its own client, which is why `createBrowserClient` dedupes
    use-copy-engine.ts       the copy "daemon" — a poll loop in a browser TAB, not a server (built 2026-08-17); mounted once via CopyEngineProvider
  components/
    auth/, wallet/, geo/, layout/{nav-bar,nav-search,right-sidebar,privy-auth-area}, ui/{primitives,icons}
    markets/{market-card,market-grid,discovery-section}   Milestone 2, live — cards link to /market/[slug], don't trade inline
    markets/{outcome-list,market-trading-section}         detail-page layout: outcome list + sticky panel, matches Polymarket's own event-page pattern (built 2026-08-07)
    markets/{market-chart,market-chart-section}           detail-page multi-outcome price chart + range tabs (built 2026-08-16); server fetches the opening range, client refetches on tab change
    markets/{featured-hero,featured-hero-carousel}        home hero: featured events, price lines, comments (built 2026-08-16); autoplay pauses on hover/focus
    layout/{nav-menu,nav-categories}                      two-row masthead: hamburger menu + feed/category tabs (built 2026-08-16); tabs are links, selection lives in the URL
    ui/menu.tsx                                           hand-rolled dropdown (click-outside, Escape, aria) — no Radix, bundle budget
    ui/avatar.tsx                                         TraderAvatar — coloured letter fallback (built 2026-08-17); the fallback is the 94% case, see leaderboard traps
    copy-trade/{copy-cta,trader-card,follow-dialog}.tsx   CopyCta is the ONLY thing deciding what a "Copy trader" click does; signed in it opens FollowDialog (caps + sizing)
    copy-trade/{copy-trade-shell,copy-dashboard,copy-tabs,copy-stats,engine-status-bar}.tsx   signed-in dashboard (built 2026-08-17); CopyEngineProvider mounts the engine EXACTLY once — two instances double every copy
    copy-trade/copy-queue.tsx                            the Place button (built 2026-08-19) — the only route from a queued copy to a signed order; also the trading-approvals gate
    trade/trading-panel.tsx                               sticky order ticket, market + limit (Step 3.6, built 2026-08-09), Milestone 3 — not yet confirmed against a real mainnet fill
    trade/order-book.tsx                                  live bid/ask depth (Step 3.2, built 2026-08-09), also anchors the trading-panel slippage guard when live; also feeds the limit-price prefill on toggle
    trade/open-orders-panel.tsx                           resting limit orders for the selected outcome + per-order cancel (Step 3.6, built 2026-08-09); no bulk cancel-all yet
    trade/fill-toasts.tsx                                 fill notifications, rendered by both TradingPanel and PortfolioView (Step 3.7, built 2026-08-09)
    portfolio/{portfolio-view,position-list}.tsx          positions + PnL dashboard (Steps 4.1-4.2, built 2026-08-09), live-refreshing since Step 3.7; trade history + rewards still pending
    portfolio/withdraw-panel.tsx                          pUSD → USDC withdrawal to an external Polygon address (FR-4.6, built 2026-08-09) — irreversible, gated behind an unskippable confirm step
scripts/
  check-client-bundle.mjs  CI leak guard
  provision-builder.mjs    P-1..P-5 provisioning + handover
  smoke-builder.mjs        Milestone 1 acceptance, run when P-1..P-5 land
deployment.md              operational runbook — read before any deploy
```

**Commands:** `npm run dev` · `lint` · `typecheck` · `test` · `build` · `check:secrets` · `preview` · `deploy` · `smoke:builder` · `builder:provision`

**🚩 The user runs all testing — do not run verification commands yourself.** When a change needs checking (`typecheck`, `test`, `lint`, `build`, `preview`, `dev`, a mainnet pass, a browser check), **stop and hand the user the exact commands to run**, then work from the output they paste back. Do not run them proactively, and do not treat a change as verified until they report the result. This composes with the existing rule to pause after each testable unit rather than chaining through a todo list: finish one coherent piece → list the commands → wait.

**Mock mode.** With no builder credentials set, the app builds and every path runs, but no order is signed. `/api/health` reports `mode` plus presence of the **five** keys in `SECRET_KEYS` (`lib/env.ts`) — the four `POLYMARKET_BUILDER_*` and `PRIVY_APP_SECRET`. It does **not** cover all of P-1…P-9: `POLYGON_RPC_URL` (P-9) is absent from that list, so an empty RPC URL is invisible to the probe and `problems: []` does not mean fully provisioned. Track P-9 by hand.

---

## What this is

A white-label prediction market frontend on the client's own domain. It does **not** run its own market or matching engine — it routes user orders into the **Polymarket CLOB** under the **Polymarket Builder Program**, earning a builder fee on attributed volume.

| Doc | Role |
|---|---|
| [srs.md](srs.md) | Requirements — source of truth |
| [deployment.md](deployment.md) | Operational runbook — deploys, secret rotation, rollback, troubleshooting, limits |
| [implementation.md](implementation.md) | Step-by-step build plan, prerequisites, acceptance checks |
| [builder-account-actions.md](builder-account-actions.md) | Open actions on the Polymarket Builder Program account — tier application, fee verification, profile ownership |
| **CLAUDE.md** (this) | Working context — what's needed to act |

**Commercials:** $550 fixed price, 4 weeks, milestone payments. $125/mo maintenance afterward covering this platform *and* the client's existing site.

---

## Current state

*(This section is stale from project inception — kept only until the remaining OIs below resolve; see the top banner and Milestones section for actual build status.)*

**3 decisions remain blocking** (full list in [srs.md §9](srs.md)):

| ID | Blocking question |
|---|---|
| ~~OI-4~~ | ✅ **Resolved: Privy.** Confirmed by a first-party `@polymarket/client/privy` signer — the embedded wallet plugs straight into order signing. Provider still sits behind `lib/auth/types.ts` so a switch is contained. |
| OI-5 | Copy trading vs. non-custodial architecture — irreconcilable as specified. Needs a product + legal call. |
| OI-1 | Is the target market inside the close-only geoblock list (US/UK/EU)? |
| OI-3 | Where does the copy-trade daemon run? Not Cloudflare Workers. |

---

## Stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16** (16.2.x), App Router, React 19.2 |
| Build | Turbopack (default in 16 — no `--turbopack` flag, no custom webpack config) |
| UI | Tailwind CSS + shadcn/ui |
| Hosting | **Cloudflare Workers via `@opennextjs/cloudflare`** — *not* Pages, see below |
| Server logic | Next.js route handlers running on Workers (Node.js runtime) |
| Chain | Polygon Mainnet |
| Wallets | Embedded provider — **undecided (OI-4)**, Privy recommended |
| Polymarket SDKs | `@polymarket/client`, `@polymarket/builder-relayer-client` |
| Web3 lib | `viem` — **not `ethers`**; both Polymarket SDKs are viem-based |
| Local env | Node v22.22.3 (16 needs ≥20.9; Polymarket SDKs *declare* ≥24 — advisory, see Traps), TS ≥5.1 |
| Package manager | **npm 10.9.8** + `package-lock.json`, always `--legacy-peer-deps`. Not yarn, not pnpm |

> ⚠️ **The client SRS says Next.js 14 on Cloudflare Pages + `@cloudflare/next-on-pages`. Both are superseded.**
> - **Next.js 14 → 16.** OpenNext **ended Next.js 14 support in Q1 2026** — 14 is not a supported Cloudflare target at all anymore.
> - **Pages → Workers.** Cloudflare and the Next.js team both recommend **Workers + `@opennextjs/cloudflare`** (GA Feb 2026). Pages/next-on-pages is Edge-runtime only; OpenNext gives the **full Node.js runtime**, which is what makes EIP-712 signing straightforward.
>
> ⚠️ **Workers Paid plan required** — free caps Workers at 3 MiB gzipped; this app will exceed it (paid: 10 MiB).

### Next.js 16 rules

| Rule | Why |
|---|---|
| ⚠️ Geo gate stays in **`src/middleware.ts`** (Edge), **not `proxy.ts`** | **OpenNext cannot build Next 16 Node middleware** — hard failure, [opennextjs-cloudflare#962](https://github.com/opennextjs/opennextjs-cloudflare/issues/962). `proxy` is Node-only and unconfigurable, so Edge `middleware.ts` is the only form that deploys. Next prints a deprecation warning on every build; that is expected. Revisit when OpenNext adds support |
| Edge-safe geo code lives in `lib/geo/edge.ts`; `lib/geo/index.ts` is the `server-only` re-export | Middleware runs on Edge and cannot import `server-only` |
| `await cookies()`, `await headers()`, `await params`, `await searchParams` | Sync access fully **removed** in 16. Use `npx next typegen` → `PageProps<'/market/[slug]'>` |
| `cacheComponents: true`; caching is opt-in via `use cache` | Everything dynamic by default. **Never `use cache` anything price-derived** — a cached price is a correctness bug |
| `revalidateTag('tag', 'max')` — 2 args | Single-arg form is a TS error in 16. `updateTag()` for read-your-writes in Server Actions |
| `import { cacheLife, cacheTag } from "next/cache"` | Stable in 16 — drop `unstable_` prefixes |
| ESLint CLI (flat config) as its own CI step | `next lint` is **removed**; `next build` no longer lints |
| `images.remotePatterns`, not `images.domains` | Deprecated in 16. Also `qualities` defaults to `[75]`, `minimumCacheTTL` to 4h |
| Secrets via `await getCloudflareContext()` | `serverRuntimeConfig` removed in 16; build-time `process.env` gets baked into the bundle |

---

## Polymarket integration — verified 2026-08-02

### Endpoints

```
Gamma   (discovery)  https://gamma-api.polymarket.com
CLOB    (trading)    https://clob.polymarket.com
Data    (positions)  https://data-api.polymarket.com
Relayer (gasless)    https://relayer-v2.polymarket.com

WSS market   wss://ws-subscriptions-clob.polymarket.com/ws/market
WSS user     wss://ws-subscriptions-clob.polymarket.com/ws/user
WSS live     wss://ws-live-data.polymarket.com
WSS sports   wss://sports-api.polymarket.com/ws
Geoblock     GET https://polymarket.com/api/geoblock
```

### Five things the original SRS gets wrong

Polymarket shipped breaking changes in April–May 2026. **Do not follow the client SRS on these points:**

1. **Deposit Wallet, not Gnosis Safe.** Safe and legacy Proxy wallets are deprecated. Accounts from 2026-05-04 onward use a **Deposit Wallet** (ERC-1967 beacon proxy) deployed through the Relayer factory at `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`.
2. **pUSD, not USDC.** Deposits accept USDC and auto-convert to **pUSD** on arrival (ERC-20 on Polygon, 1:1 USDC-backed, replaced bridged USDC.e in the 2026-04-28 upgrade). All balances, PnL, and fees are pUSD.
3. **`@polymarket/client`**, not `@polymarket/clob-client`. Entry point is `createSecureClient`.
4. **Builder attribution is a `bytes32` builder code inside the signed V2 order struct** — not a wrapper around the request. Surfaces in on-chain `OrderFilled`, settles via `CTFExchangeV2.matchOrders()`.
5. **Fee headroom.** Users need pUSD for notional **+ platform fees + builder fees** combined. Naive balance checks will let orders through that then fail.

### Auth

- **L1** — wallet signs EIP-712 `ClobAuth` → exchange at `/auth/api-key` or `/auth/derive-api-key` for `{apiKey, secret, passphrase}`.
- **L2** — sign every private CLOB request with **HMAC-SHA256** using those credentials.
- Builder credentials ≠ user credentials. The builder signs infrastructure requests; **each Deposit Wallet stays controlled by its own user signer.** Never custody.

### Builder fees

Taker cap **100 bps**, maker cap **50 bps**, 1 bps granularity. `fee = notional × bps ÷ 10_000`. **The user pays**, stacked on top of Polymarket's own fees.

**Our rate (OI-6, resolved 2026-08-04): 50 bps taker (0.50%), 0 bps maker.** Set in two places that must agree — the builder profile on Polymarket, and `BUILDER_FEE_BPS_*`. The profile rate is what gets charged; the env rate is what the user is shown *before* committing. Drift between them means the disclosed number is a lie, so `npm run builder:provision -- verify-fees` asserts equality against `fetchBuilderFeeRates`.

**The builder code is UI-only; the API credentials are not.** P-1 is assigned to a builder *profile* created at `polymarket.com` → Settings → Builders, and in the SDK it is only ever an **input** (`builderCode?: BuilderCode`) — nothing returns one. P-2…P-4 *can* be minted in code once the profile exists, with **`createBuilderApiKey()`** (`/actions`) → `BuilderApiKeyCreds {key, secret, passphrase}`. **`createApiKey()` is a different function** returning *user* CLOB creds (`ApiKeyCreds`); using it for builder setup yields credentials that attribute nothing. `scripts/provision-builder.mjs` covers the whole sequence.

**🚩 There is NO configurable payout wallet. Fees go to the wallet that owns the builder profile.** Verified in the Builders panel and against docs 2026-08-04 — the only address field there is labelled *"Do not send funds to this address. For API use only."* The docs state exactly one thing: *"Collected builder fees are distributed to the wallet associated with your builder profile."*

**Consequence:** whoever holds the profile-owner key controls all commission revenue. There is no way to separate "who registered the profile" from "who gets paid", so a profile registered on a developer-generated key routes the client's revenue through a key the developer has seen. **Migrating later is expensive** — a new profile means a new `bytes32` code, new API keys, and forfeiting the attributed volume history that the Verified tier application depends on. Register on the key that should ultimately own the money, from the start.

*(An earlier version of this file claimed the recipient was configurable. It is not — that was inferred from a doc summary, not verified.)*

### Builder tiers

| Tier | Relay tx/day | How |
|---|---|---|
| Unverified | **100** | Self-serve, `polymarket.com/settings` |
| Verified | **10,000** | Email `builder@polymarket.com`, several business days |
| Partner | Unlimited | Strategic, demonstrated volume |

**100/day cannot support a public launch.** Submit the Verified application in Week 3 — approval is externally controlled and gates launch.

---

## Traps

**✅ RESOLVED 2026-08-04 — `cacheComponents: false` + `experimental.useCache: true`.** Pages serve 200 under workerd, and `use cache` / `cacheLife` / `cacheTag` stay available for Milestone 2. `useCache` is a **separate experimental flag** from `cacheComponents`, which is what makes this a real third option rather than a compromise.

Measured cost of dropping Cache Components: `/` and `/restricted` go from `◐ Partial Prerender` to `ƒ Dynamic`, and **nothing becomes static**. Every page reads `cookies()` (auth) and `headers()` (geo), so Next marks them fully dynamic anyway. We lose a streaming static shell, not correctness — a stale price is still impossible by default. Do not "restore" `cacheComponents: true` without re-testing under `wrangler dev`; the failure does not reproduce under `next dev`.

**The original problem, for context.** Verified 2026-08-04 on `@opennextjs/cloudflare@1.20.2` (latest published; no canary, no config toggle). API routes are fine; both PPR pages (`/`, `/restricted`) return **500** with:

> `Cannot perform I/O on behalf of a different request. I/O objects ... created in the context of one request handler cannot be accessed from a different request's handler.`

Stack is `patchedClearImmediate` → `CacheSignal.pendingTimeoutCleanup` → `trackPendingChunkLoad` — OpenNext's `clearImmediate` patch retains an I/O context across requests, then the runtime cancels the hung request. **Confirmed by direct experiment**: flipping only `cacheComponents` to `false` and rebuilding turns both pages 200 under `wrangler dev`, then back to 500 when re-enabled.

`next dev` does **not** show this — it only appears under workerd, so it must be checked with `npm run preview` before every deploy. Neither workaround is free: `cacheComponents: false` gives up the dynamic-by-default polarity chosen precisely because a cached price is a correctness bug (every price-derived route would then need explicit `dynamic = "force-dynamic"`), while keeping it `true` means the site cannot serve a page on Workers at all. **This is a real decision, not a config tweak — do not flip it silently.**

**Workers cannot run the copy-trade daemon.** Request-scoped; no long-lived WebSocket, no unbounded loop. Needs Durable Objects + Cron Triggers, or a separate host (recommended). OI-3.

**Signing on Workers — passes on local workerd, still gated on a deployed Worker.** OpenNext gives the full Node.js runtime, so EIP-712 (`viem`) + HMAC-SHA256 work normally. Set `nodejs_compat` if a dependency needs it.

Measured 2026-08-04 under `opennextjs-cloudflare preview`: `/api/spike/signing` returns `passed: true` with `runtime: "workerd"` and all four checks green — EIP-712 via viem, HMAC-SHA256 via Web Crypto (RFC 4231 vector), the `@polymarket/client` signer, and a viem `WalletClient` in the shape Privy's embedded wallet exposes.

⚠️ **This is not yet the Step 1.6 acceptance.** That gate specifies a *deployed* Worker, and `preview` is local workerd — same engine, different environment (no real edge networking, no production bindings). The local pass substantially de-risks the deploy but does not substitute for it. Re-run against the deployed host and record the result.

**100 relay tx/day is shared across dev, QA, and demos.** Every Deposit Wallet deployment spends one. Call `getDeployed()` before deploying, reuse test wallets, don't burn deploys on throwaway accounts.

**No testnet for the production CLOB.** Milestone 1 acceptance requires a real mainnet order. Client must fund the builder wallet with ~$50 pUSD for testing.

**Cache Components breaks pages that read `headers()`/`cookies()` outside `<Suspense>`.** Not a warning — the build fails with "Uncached data was accessed outside of `<Suspense>`". Wrap the dynamic part in a child component inside `<Suspense>`; the route then renders as `◐ Partial Prerender`. Hit this on `/restricted`.

**`@polymarket/builder-relayer-client` is redundant.** `@polymarket/client` already exports `deployDepositWallet`, `isWalletDeployed`, `setupTradingApprovals`. Removed it — the Worker bundle is near the size limit and a second SDK is dead weight.

**🚩 Builder fee changes take ~4 days to take effect.** Observed 2026-08-04: editing a rate in Settings → Builders shows `Pending: 0.5% (8/8/2026)` — a **4-day lead time**, not an immediate change. `fetchBuilderFeeRates` returns the **effective** rate and gives no visibility into pending ones, so during the window it reports the *old* value and `verify-fees` fails through no fault of the config. Consequences: (1) the fee must be set several days before launch, not on launch day; (2) an attributed order placed inside the window earns **0** — attribution still works, revenue does not; (3) every later repricing carries the same delay, so it is not a dial you can turn reactively.

**The Builders panel is not a reliable read of profile state.** Observed 2026-08-04: the panel said *"No builder API keys yet"* while `fetchBuilderApiKeys` returned a live key matching `.dev.vars`. It also renders `Max 1%` under the **maker** field, which is the *taker* cap — the docs say maker maxes at 50 bps (0.5%). Trust the API (`npm run builder:provision -- status`), not the screen, and never re-mint a credential on the strength of that message.

**Fee rate fields in the Builders panel are PERCENT, not basis points.** Everything in this codebase is bps. `50` in that field means 50%, not 50 bps — it is rejected as over-cap. 50 bps is entered as `0.5`.

**`createSecureClient` without `wallet` tries to deploy a Deposit Wallet — circular during provisioning.** Omitting `wallet` targets the signer's deterministic Deposit Wallet and deploys it during client setup; deployment goes through the Relayer, which requires a builder API key. So minting the *first* builder API key fails with `InvariantError: Deposit Wallet deployment requires a Relayer API Key or Builder API Key in the client configuration`. Fix: pass `wallet: <signer's own EOA address>` to select EOA mode, which needs no deployment. Auth-only operations (minting credentials, reading fee rates) never need a Deposit Wallet.

**User flows need the opposite fix — `apiKey`, not EOA mode.** `createUserClient` deliberately omits `wallet` so the user's deterministic Deposit Wallet *is* the account, which means it hits the same deployment path and needs Relayer authorization. Supply it with **`builderApiKey()` from `@polymarket/client/node`** (a `/node` subpath with no `node:` builtins, so workerd-safe) fed from `resolveBuilderAuth(env)`. Without it every authenticated route — status, deploy, qr, orders — fails at client construction and surfaces as `wallet_status_failed`. Confirmed by direct A/B: same call throws without `apiKey`, succeeds with it. Note the SDK's `apiKey` option is typed `apiKey?:` — optional to the compiler, mandatory in practice, so nothing catches its absence at build time.

**Standalone actions are on the `/actions` subpath**, not the root: `import { deployDepositWallet, isWalletDeployed } from "@polymarket/client/actions"`. But `placeMarketOrder`, `fetchClosedOnlyMode`, `listBuilderTrades`, `setupTradingApprovals` **are** client methods. The split is not obvious — check `dist/actions/index.d.ts` before assuming.

**The user WebSocket reports events, not state — and one trade arrives several times.** Verified against the shipped bindings `.d.ts` 2026-08-09. Two things bite here:
- A `trade` event carries no post-trade position size or cash balance, and the channel has **no snapshot to replay on reconnect** (unlike the market channel's `book`). So the socket can only ever mean "refetch" — `useUserChannel` exposes a `revision` counter for exactly that, and bumps it on every successful connect too, since events during a gap are simply lost. Anything that renders socket-derived numbers directly will drift from on-chain truth.
- A single trade id repeats as its status walks `TRADE_STATUS_MATCHED → MINED → CONFIRMED` (or `FAILED`/`RETRYING`). Appending each event toasts the user three times for one fill; `applyUserEvent` replaces the entry in place instead.

**npm only — never yarn.** All three Polymarket packages (`@polymarket/client`, `bindings`, `types`) declare `engines.node >= 24`. npm prints an `EBADENGINE` warning and installs; **yarn v1 hard-fails** with `Found incompatible module` and installs nothing. The requirement is advisory here — the published `dist/` has zero `node:` imports, and everything builds and tests clean on Node 22.22.3. Yarn also can't express the `--legacy-peer-deps` workaround below. If you want the warning gone, move to Node 24 LTS; don't switch package managers.

**Privy peer conflict — install with `--legacy-peer-deps`.** Privy's optional `permissionless` peer wants `ox@^0.8`; the Polymarket viem stack pulls `ox@0.14`. We don't use `permissionless` (Polymarket has its own Relayer, no ERC-4337), so the mismatch is inert. CI does the same.

**…which then breaks Privy itself: `@stripe/stripe-js` must be installed by hand.** `--legacy-peer-deps` also stops npm auto-installing *legitimate* peers. `@privy-io/react-auth` → `@stripe/crypto` → peer `@stripe/stripe-js@^1.46.0`, required, not optional. Missing it fails the build with `Module not found: Can't resolve '@stripe/stripe-js'` traced through `FiatOnrampScreen`, on **every** page — the fiat onramp is statically imported, so it breaks even though we never render it and even in mock mode where `<PrivyProvider>` is skipped entirely. It is a pinned direct dependency for this reason; don't "clean up" the unused-looking package.

**Cache Components forbids the clock before request data — `serverEnv()` calls `await connection()` first.** `getCloudflareContext()` reads the clock internally, so any Server Component touching it dies at build with ``Route "/" used `new Date()` before accessing ... Request data``. **A `<Suspense>` boundary does not satisfy this** — different rule from the uncached-data one below, same symptom of a failing build. `connection()` marks the scope dynamic, which is correct anyway: nothing that reads secrets may ever prerender.

**🚩 `NEXT_PUBLIC_PRIVY_APP_ID` must be a BUILD-time variable — `.dev.vars` does not work.** Verified empirically 2026-08-04 with sentinel values: Next inlines `NEXT_PUBLIC_*` into the bundle at build, reading only real env vars and `.env*` files. **Neither `.dev.vars` nor `wrangler.jsonc` `vars` reach it** — both are request-time. Put it in `.env.local` locally and in a CI build-step env var for deploys; `wrangler secret put` is always too late, the bundle is already built. The failure is silent and total: the app id inlines as `""`, `isAuthConfigured` is false, `<PrivyProvider>` never mounts, and login is simply absent with no error. Contrast `PRIVY_APP_SECRET`, which is server-side and *does* belong in `.dev.vars`.

**…and `NEXT_PUBLIC_POLYMARKET_BUILDER_CODE` has the same trap with no way to detect it yet.** Verified 2026-08-05 by grepping the built bundle: the Privy app id inlines into a client chunk, but the builder code appears **nowhere** — not in `assets`, not in the server bundle, not in `worker.js`. That is currently *correct*, not a bug: nothing in the shipped UI calls `placeMarketBuy`/`placeMarketSell` (0 chunk matches), so `builderCode()` is tree-shaken, and the sole surviving reader — `isTradingConfigured` in `lib/auth/public-config.ts` — constant-folds to a boolean without needing the literal. Every `builderCode` string in the bundle is `@polymarket/client`'s own zod schemas.

The consequence is the dangerous part: **you cannot verify this variable inlined by inspecting the bundle**, and it goes load-bearing the moment order UI ships in Milestone 3. A CI build that forgets to export it will produce a bundle that looks identical to a correct one and silently attributes every order to nobody — losing revenue with no error anywhere. Add a bundle assertion for the code literal *in the same PR* as the first order-placing component, not after.

**A wrong Privy app id fails the build, not the request.** With a non-empty but invalid id, prerender dies with `Error: Cannot initialize the Privy provider with an invalid Privy app ID` on `/_not-found`. Fail-fast, but it means a typo presents as a build error far from its cause.

**🚩 `hasAcceptedTerms` CANNOT be read server-side — the identity-token parser hardcodes it to `false`.** Diagnosed 2026-08-16 after the legal gate rejected every order from every user with **451 `terms_not_accepted`** — "Please accept the Terms of Service and Risk Disclosure before trading" — for users who had just accepted. Two independent causes, both now fixed:

1. **The boolean does not exist in the token.** `parseUserFromIdentityTokenPayload` (`@privy-io/node/lib/identity-token.js`) builds its `User` with a literal `has_accepted_terms: false`; the claim isn't in the JWT and the SDK substitutes a constant. Any server check on it fails 100% of the time, permanently, and no amount of re-accepting or token refreshing helps. **`custom_metadata` *is* a real claim** and parses correctly — so the versioned record we write ourselves is the only usable server-side evidence. `userNeedsAcceptance` now gates on the version alone, and `AuthenticatedUser` deliberately has no `hasAcceptedTerms` field so nothing can regress into using it. This is not weaker: custom metadata needs the app secret to write, so it is server-controlled, whereas the boolean is client-set.
2. **The version claim is stale until the token rotates.** `AcceptanceGate` writes both halves, then must `await refreshUser()` (`useUser()` from `@privy-io/react-auth` — "updates the user object **and identity token** in the client"), or the freshly-written metadata isn't in the cookie the server reads.

⚠️ **A user who accepted before fix (2) needs one sign-out/sign-in.** Their Privy record is correct but their cookie predates it, and the client-side gate won't re-prompt (it reads the real user object, which looks accepted), so there is no in-app way to remint it. `/api/auth/me` → `legal.acceptedVersion` shows what the server actually sees; `null` there with the gate passing is exactly this state.

**Privy issues two tokens, and identity tokens are OFF by default.** `privy-token` (access, authenticates, 1h) and `privy-id-token` (identity, carries linked accounts, 10h). The embedded wallet address/id come from the **identity** token — verifying only the access token gets you a user with no wallet, so `verifySession` returns null and every authenticated route 401s.

Enable at **User management → Authentication → Advanced → "Return user data in an identity token"** (verified against docs.privy.io 2026-08-04). Until it is on, the symptom is a *client* session that looks fine — email and signer address render — while every server route reports `unauthorized`. `/api/auth/me` distinguishes this case explicitly as `missing_identity_token` rather than a bare 401.

**🚩 Bundle is 4.79 MiB gzipped with almost no UI — up from 2.90 MiB.** Re-measured 2026-08-04 via `wrangler deploy --dry-run` (`22432.58 KiB / gzip: 4904.02 KiB`). It **already exceeds the 3 MiB free cap**, so Workers **Paid** is now proven mandatory rather than merely prudent (P-7). More importantly it is **~48% of the 10 MiB paid cap** with Milestone 1 only — no discovery UI, no order book, no charts, no portfolio. It grew 65% during Milestone 1 alone, which makes implementation.md's "Low probability" rating for exceeding the paid cap look optimistic. Treat the remaining headroom as a budget, not slack; re-measure every deploy (`deployment.md` §7.3).

**Fonts are self-hosted — never reintroduce `next/font/google`.** It resolves over the network during `next build`, so every build, CI run and deploy depends on `fonts.googleapis.com`. That failed a build here on 2026-08-04 (`Failed to fetch Geist from Google Fonts`) on a transient blip, with nothing wrong in the code. The latin-subset variable woff2 files live in `src/app/fonts/` and are loaded with `next/font/local`; Geist is SIL OFL so redistribution is fine. Builds are now reproducible and offline-capable. Use `weight: "100 900"` — a single value collapses a variable font to one weight.

**…but those woff2 files CANNOT be used by `next/og`.** Satori, the renderer behind `ImageResponse`, reads **TTF, OTF and WOFF — not WOFF2**, and woff2 is the only format committed here. So `opengraph-image.tsx` and `apple-icon.tsx` fall back to `next/og`'s bundled default sans, and the share card is deliberately not set in Geist. Matching the site font would mean committing a *second* copy of Geist in another format purely for two images. Don't "fix" this by pointing `ImageResponse` at `Geist-Variable.woff2` — it throws at build.

**`public/` no longer exists** (removed 2026-08-19). It held only the five untouched `create-next-app` SVGs — `next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg` — none referenced anywhere in `src/`, two of them Vercel's own logo shipping inside a client deliverable. Next builds fine without the directory; recreate it only when there is a real static asset to serve.

**`tsc` caches aggressively.** After changing `tsconfig.json`, delete `*.tsbuildinfo` or you will debug errors that no longer exist. The same applies to `.next/types/` — a stale `validator.ts` there references routes that no longer exist and fails typecheck with `Cannot find module '../../src/app/…/page.js'` for pages you never wrote. `rm -rf .next tsconfig.tsbuildinfo` and rebuild.

**`npm run cf-typegen` changes global types and will surface new type errors.** `cloudflare-env.d.ts` is not just the `CloudflareEnv` interface — it is ~13k lines including the **full workerd runtime types**, and `tsconfig.json` picks it up via `**/*.ts`. Those types are stricter than the DOM lib: most notably `response.json()` becomes `Promise<unknown>` instead of `Promise<any>`, which broke 6 previously-compiling call sites on 2026-08-04.

This is a **correctness win, not a nuisance** — the runtime really does return unknown-shaped data, and the DOM lib's `any` was hiding it. Fix by declaring the wire shape and casting (`(await response.json()) as MeResponse`), never by widening back to `any`. The file is gitignored and generated per-checkout, so a fresh clone hits this the first time someone runs the command.

**Security headers live in `next.config.ts`'s `headers()`, and the CSP is currently REPORT-ONLY.** Added 2026-08-04, verified emitting under workerd. `CSP_ENFORCE = false` at the top of the file is the switch. Two things to know before flipping it:
- `script-src` carries `'unsafe-inline'` because Next's hydration bootstrap is an inline script, so this CSP is **not meaningful XSS protection** yet. The real value today is `connect-src` (exfiltration), `frame-ancestors 'none'` (clickjacking a UI that signs orders), and `form-action`/`base-uri`. The upgrade is per-request nonces from `middleware.ts`, deferred because a nonce bug in the gate takes down every route.
- The origin list is **derived**, not templated — from `lib/polymarket/config.ts`, Privy's dist bundle, and `browser-client.ts`. Re-derive when any of those change. Note `POLYGON_RPC_URL` deliberately does **not** appear: the browser reaches Polygon through Privy's EIP-1193 provider, and the RPC URL is a server-side secret that is not a browser origin.

**`/api/geoblock` returns `country`/`region`, NOT `countryCode`/`regionCode`.** Live shape, verified 2026-08-04: `{"blocked":false,"ip":"…","country":"BD","region":"C"}`. Reading the `*Code` spelling yields `undefined`, falls through to `cf-ipcountry` (absent off Cloudflare), and lands on the fail-closed branch — so **unrestricted users get told they are close-only**. That failure mode looks like correct conservative behaviour from the outside, which is exactly why it went unnoticed. `lib/geo/edge.ts` now accepts both spellings, and `edge.test.ts` pins the live shape. The endpoint is undocumented with no stability guarantee — re-verify it each milestone.

**Geoblocking is absent from the client SRS.** Three tiers, all must be enforced:
- **Blocked** (no trading at all): Iran, Syria, Cuba, North Korea, Crimea/Donetsk/Luhansk
- **Close-only** (exit positions only, no new orders): 30+ jurisdictions — US, UK, France, Germany, Singapore, Australia, Brazil, Russia, Taiwan, and BC/Ontario/Alberta/Quebec
- **Frontend-restricted**: Ireland, Japan, Netherlands, Malta (sports only)

Polymarket rejects blocked orders server-side regardless; our check exists so users get real feedback instead of opaque failures.

**🚩 A Gamma keyset cursor is bound to the sort that produced it — replay `order`/`ascending` on EVERY page.** Re-probed live 2026-08-15. Passing a cursor back under a different sort returns **422**, and "no sort at all" counts as a different sort:

| Cursor generated with | Replayed with | Result |
|---|---|---|
| `order=volume` | `order=volume` | **200** |
| `order=volume` | *(nothing)* | **422** |
| *(nothing)* | *(nothing)* | 200 |
| `order=liquidity` | `order=liquidity` | 200 |

**This corrects an entry recorded here on 2026-08-07 that had it exactly backwards** — it concluded "`/events/keyset` 422s on `order=volume` + `after_cursor`, so cursor pagination doesn't support a volume sort" and made `/api/markets` *drop* `order` once paginating. Every sort paginates fine; dropping the sort is what 422s. The consequence ran in production unnoticed: page 1 sorted by volume, page 2 asked the same cursor for an unsorted page, Gamma 422'd, and **"Load more" never worked** — surfacing as a generic "Failed to load more markets" with nothing pointing at the cause. Fixed 2026-08-15 alongside the FR-2.2 sort UI.

Two things follow. Any server-rendered first page must use the *same* sort the client will paginate under (`DiscoverySection` and `MarketGrid` share `DEFAULT_SORT_ID` for this reason). And `order`/`ascending` travel as a single opaque **sort id** through `/api/markets`, never as a separable pair, so a caller cannot construct a combination that was never verified.

**Gamma range filters work and are verified: `volume_min`, `liquidity_min`, `end_date_min`, `end_date_max`.** Confirmed 2026-08-15 to actually filter, not merely return 200 (min volume seen tracked the bound 114k → 1.4M → 52.6M; result counts shrink). Exposed as presets (`VOLUME_FILTERS` etc. in `gamma-types.ts`), not free-form numbers — **arbitrary values would give nearly every request its own `getCachedEvents` key** and quietly undo FR-2.5's edge caching. For the same reason `endingBefore()` quantises "ending within N days" to the end of the UTC day rather than `now + N days` to the millisecond.

⚠️ `active:true`/`closed:false` still don't fully exclude stale events — an `end_date_max` query returned an event with a 2025 end date. Known Gamma looseness, not a filter bug.

**🚩 `closed: false` does NOT mean "still tradeable" — filter on `end_date_min` too.** Gamma leaves expired events flagged open indefinitely. Measured 2026-08-15 across a 24-event first page, all with `active=true&closed=false`:

| Sort | Already-ended in page 1 |
|---|---|
| `endDate` ascending ("Ending soon") | **24 / 24** |
| `volume24hr` | 3 / 24 |
| `volume` | 2 / 24 |
| `liquidity`, `startDate` | 0 / 24 |

The "Ending soon" case is total — sorting by soonest end surfaces the *oldest expired* events first, so the entire tab was dead markets. Adding `end_date_min=<now>` takes every sort to zero. `/api/markets` now always sends it (`endingAfter()`, quantised to the hour for cache-key stability), which also repairs the "Ending in 7 days" filter: with only `end_date_max` it meant "any time before then", including last year.

⚠️ Known cost: `end_date_min` also drops events with **no** `endDate` — ~2 per 100, and some are real (undated esports tournament winners, $1M+ volume). Gamma has no "null OR future" filter. Where filtering happens in memory instead, `isLiveEvent()` keeps them.

⚠️ Search needs the same fix by a different route: `/public-search` **ignores `end_date_min`** like every other filter, and `events_status=active` only excludes *closed* events — ~1 result in 20 comes back ended-but-open. `/api/markets/search` filters with `isLiveEvent()` **after** the cached call, deliberately: the predicate reads the clock, and running it inside a `"use cache"` function would freeze "now" into the entry.

**🚩 Search is `/public-search`, and almost nothing you know about `/events/keyset` transfers.** Verified live 2026-08-15 (`/search` is 401 auth-only; `/events/search` 422s — `/public-search` is the one). Four separate traps:

- **`closed=false` and `active=true` are accepted and silently ignored.** The param that actually excludes resolved markets is **`events_status=active`**. Measured: the same query returned **3 closed events out of 10** with `closed=false` set, and **0** with `events_status=active`. Get this wrong and resolved 2025 markets sit at the top of search results with no error anywhere.
- **Pagination is `page=N`, 1-based — there is no cursor.** The response carries `pagination: { hasMore, totalResults }` instead of `next_cursor`, so the cursor/sort binding rule above simply doesn't apply here.
- **`limit_per_type` clamps at 50.** Asking for 100 returns 50.
- **Sort and range filters do nothing.** `order`, `ascending` and `volume_min` are all ignored — identical first result with and without them. This is why the discovery UI *hides* the sort/filter chips during a search rather than disabling them: leaving them on screen would imply they still apply.

Events come back in the same shape as the listing endpoints, nested markets included, so they render through `MarketCard` unchanged. Lives behind `/api/markets/search` — a separate route from `/api/markets` precisely because the two contracts differ this much; folding them together would mean one route returning two shapes.

**🚩 `prices-history` returns an EMPTY array with a 200 when `fidelity` doesn't suit `interval`.** `GET clob.polymarket.com/prices-history?market=<tokenId>&interval=<i>&fidelity=<minutes>` → `{"history":[{"t":<unix s>,"p":<0-1>}]}`. `market` is a **CLOB token id** (one side of one market), so a two-outcome market is two separate series. Measured 2026-08-16 on one token:

| interval | fid 1 | fid 5 | fid 60 |
|---|---|---|---|
| `1h` | 61 | 13 | 2 |
| `6h` | 361 | 72 | 7 |
| `1d` | 1441 | 289 | 25 |
| `1w` | **0** | 2017 | 169 |
| `1m` | **0** | **0** | 743 |
| `max` | 4452 | 4452 | 743 |

One fidelity across every range tab silently blanks some of them — 60 everywhere gives a 2-point "1H", 1 everywhere gives an empty "1W" and "1M", with no error either way. The verified pairings are `PRICE_RANGES` in `price-history-types.ts` and travel as a single opaque **range id**, same discipline as `EVENT_SORTS` pairing `order` with `ascending`. Re-probe live before changing one.

**🚩 The trader leaderboard's window parameter is `timePeriod`, and `window` is silently ignored.** `GET data-api.polymarket.com/v1/leaderboard?timePeriod=WEEK&orderBy=PNL&limit=6` → bare array of `{rank, proxyWallet, userName, xUsername, verifiedBadge, vol, pnl, profileImage}`. Verified live 2026-08-17 against `docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings.md`. Params: `timePeriod` (`DAY`/`WEEK`/`MONTH`/`ALL`, default DAY), `orderBy` (`PNL`/`VOL`), `category` (`OVERALL`/`POLITICS`/`SPORTS`/…), `limit` (**clamps at 50**), `offset` (max 1000), `user`, `userName`.

The trap is the failure mode, not the spelling: passing `window=1w` returns a clean **200 of the DAY board**, so a page headed "this week" quietly shows today's numbers with nothing to notice. Same class of bug as `closed:false` not meaning tradeable — the wrong answer arrives looking exactly like the right one. `LEADERBOARD_PERIODS` in `leaderboard-types.ts` pins the verified enum values and travels as an opaque **period id**, same discipline as `EVENT_SORTS` and `PRICE_RANGES`.

Three parsing quirks, measured across a 50-row sample the same day: **`rank` is a string** (`"1"`); **`profileImage` is empty on 47 of 50 rows**, so a letter-avatar fallback (`ui/avatar.tsx`) is the normal case, not the edge case — the few real ones are on the already-allowed `polymarket-upload` S3 bucket, so no CSP or `remotePatterns` change was needed; and **`userName` is often the account's own address with a creation timestamp glued on** (`0x3DFb…eeabAf-1722957908185`, 55 chars) or empty outright — `traderDisplayName` falls back to `shortenAddress` for both. `vol: 0` on a top-PnL trader is **real data**, not a missing field.

**Gamma has comments but NO news.** `GET /comments?parent_entity_type=Event&parent_entity_id=<numeric id>&limit=N` → bare array of `{body, createdAt, profile:{name, pseudonym, profileImage}}` (verified 2026-08-16; takes the numeric event id, not a slug, and returns no `{events,next_cursor}` envelope). `GET /news` and `/events/{id}/news` both **404**, and there is no `news` field on an event — the reference design's NYT/AP headlines have no first-party source. Avatars are on the same S3 bucket as market icons, so they need no new CSP or `remotePatterns` entry.

**🚩 Event legs settle individually, long before the event closes.** Measured 2026-08-16 on "Israel x Iran ceasefire continues through…?": **17 of 22** markets were `closed: true` / `acceptingOrders: false` at a price of exactly `1`, while the event itself was open with an end date two weeks out. Ranking outcomes without filtering put three settled legs at **100%** at the top of the hero. Note `active` is useless here — it was `true` on every settled leg; **`closed` is the flag that separates them**. `rankEventOutcomes` (gamma-types.ts) drops them, and decides binary-vs-multi on the *original* market count so a lone survivor isn't relabelled as a Yes/No pair.

**Withdrawals were never in the client SRS.** Added as FR-4.6. Deposit-only is not shippable. **Built 2026-08-09** — see the next two entries for what the research turned up.

**🚩 Withdrawals go through the Bridge API, which the SDK does NOT wrap.** Verified live 2026-08-09. `https://bridge.polymarket.com`: `GET /supported-assets` → `POST /quote` → `POST /withdraw` (returns a one-off bridge address) → **transfer pUSD to that address** via the SDK's `transferErc20` → `GET /status/{address}`. Polymarket unwraps pUSD→USDC through their Collateral Offramp + a Uniswap v3 pool; we never touch those contracts, and they charge no withdrawal fee (the quote's cost is gas + swap impact, ~$0.0006 on a $10 test quote, ~27s to arrive).

Two wrong turns to avoid: `planCollateralReturn`/`executeCollateralReturnPlan` is **not** withdrawal — it unwinds *positions* into collateral. And `withdrawFromPerps` is a different endpoint on a different host (`api.perpetuals.polymarket.com`) for the perps account.

**🚩 The Polymarket docs misidentify the pUSD address as USDC — verify token addresses against the live API, never the docs prose.** The bridge docs state *"For a USDC withdrawal to Polygon, you would reference the Polygon USDC address … `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`"*. That address is **pUSD**. Using it as `toTokenAddress` makes a "withdraw to USDC" a pUSD→pUSD round trip. Verified against `bridge.polymarket.com/supported-assets` on 2026-08-09 (chainId `137`): pUSD `0xC011a7E1…82DFB`, native USDC `0x3c499c54…5c3359`, USDC.e `0x2791Bca1…a84174`, all 6 decimals, `minCheckoutUsd` $2.

Both live in `POLYGON_TOKENS` (`lib/polymarket/config.ts`), and `withdraw.ts`'s `assertBridgeAssetsUnchanged()` re-checks them against the live list before every withdrawal and **refuses** on drift. That check is deliberate belt-and-braces on the one code path where a stale constant costs real money — don't remove it as redundant.

**The SDK's own `transferErc20` example doesn't typecheck.** Its JSDoc reads `client.environment.contracts.collateralToken`, but the published `EnvironmentConfig` type is only `{ name: string; chainId: number }` — `contracts` appears solely on `EnvironmentConfigFork`. Reading it needs an unchecked cast, which is not something to do on the call that moves money, hence the verified constant above instead.

**🚩 Server-side signing needs BOTH user delegation AND a Privy authorization key — neither exists yet.** Hit 2026-08-04. With auth working and builder credentials wired, `/api/wallet/status` still fails:

> `401 {"error":"No valid authorization keys or user signing keys available"}`

That message names the two missing things exactly. Verified against docs.privy.io:
1. **User delegation** — a user's embedded wallet cannot be signed with server-side until *the user explicitly delegates it*, client-side via `useHeadlessDelegatedActions().delegateWallet({address, chainType})`. We never call it.
2. **Authorization key** — created in the Privy dashboard; it "produces authorization signatures when submitting requests" and is passed server-side as the `authorizationContext` on `signerFrom({privy, walletId, authorizationContext})`. We pass `undefined`.

Diagnosis note: a local `privateKey()` signer succeeds on the identical code path (`isWalletDeployed: true`, balance reads fine), so this is **not** a builder-credential or SDK-wiring problem. Only the Privy remote-signer path fails.

**✅ RESOLVED 2026-08-04 — client-side signing chosen.** The user's browser signs with their own Privy wallet; we never request delegation and never hold signing authority. Builder authorization is fetched per request from **`/api/builder/sign`** using the SDK's `remoteBuilderSigning({ url })`, so the builder **secret stays server-side** while the client runs in the browser. **Verified working end-to-end 2026-08-04**: user signs in-browser → `/api/builder/sign` supplies builder auth → Relayer deploys the Deposit Wallet → balance reads. The panel makes no server wallet calls at all; the QR is rendered client-side.

Gotcha inside this: the viem wallet client **must** be built with `account` set. `signerFrom` asserts `invariant(client.account !== undefined, "Wallet client with account is required")`, but viem allows an account-less client for read paths — so omitting it compiles and only fails at signing.

**🚩 `createSecureClient` has a hard 10-second ceiling you cannot raise, and CLOB login is a POST, which is never retried.** Diagnosed 2026-08-19 after "Set up trading wallet" failed with the raw string `Request timed out: POST https://clob.polymarket.com/auth/api-key`. That message is **ky's**, not Polymarket's — ky is the HTTP library inside `@polymarket/client`, and the SDK builds it as `ky.create({prefixUrl, throwHttpErrors:false})`, overriding neither timeout nor retry. So it inherits `timeout: options.timeout ?? 10_000` and ky's default `retryMethods` of get/put/head/delete/options/trace — **POST is absent**, and `retryOnTimeout` is `false`. `SecureClientOptions` exposes no timeout knob (`environment`, `apiKey`, `wallet`, `signer`, `credentials`, `nonce` only), so this cannot be configured away.

Not a network problem: measured the same day, `clob.polymarket.com` answers in **~0.21s** and the CORS preflight returns 204 with `access-control-allow-origin: *`. One slow write is all it takes.

Three consequences, all now handled in `browser-client.ts` / `clob-credentials.ts`:

- **Cache the credentials.** `createSecureClient` without `credentials` re-runs the *entire* first-time login — EIP-712 signature plus `POST /auth/api-key` — on every construction, so the fragile call was on every page load forever. Passing `credentials` back skips both: `beginAuthentication` validates them with `GET /auth/api-keys` (a GET, so ky *does* retry) and only falls back to a signature on a 401, which means a revoked key self-heals. The SDK's own docstring on `BaseSecureClient.credentials` sanctions exactly this. Stored in **`sessionStorage`**, keyed by lowercased EOA — contrast the `polymarket:wallet-deployed:` flag next door, which is `localStorage` because it is a permanent on-chain fact and not a secret. ⚠️ A stolen L2 credential **cannot place an order** (that needs the user's EIP-712 signature over the order struct) but **can** read their private CLOB data and cancel resting orders.
- **Retry once, but only on a timeout.** The ceiling is client-side, so a timed-out POST probably still created the key — the retry then takes the SDK's cheap `POST → 400 → GET /auth/derive-api-key` fallback. Exactly one retry: each attempt can re-prompt the wallet to sign.
- **🚩 Deduplicate concurrent connects.** `createBrowserClient` keeps a module-level `Map<address, Promise>` so two callers share one login. Two separate bugs fed it: React StrictMode (**on by default for the App Router** — `reactStrictMode` unset resolves to `true`, `next/dist/build/define-env.js:144`) double-invokes effects while the auto-connect guards in `useBrowserClient` and `DepositWalletPanel` read a **stale closure** of their own status, so both invocations proceed; and `useBrowserClient` is a plain hook rather than a context, so every caller built its own client. `CopyStats` was doing that on `/copy-trade` in direct contradiction of `useCopyEngine`'s stated "exactly one signer on this page" — fixed 2026-08-19 to read `useCopyEngineContext()`. `TradingPanel` + `MarketPositionsTab` still hold separate copies on `/market/[slug]`; the dedupe makes that harmless rather than correct.

**Orders migrated 2026-08-04.** Signing lives in `browser-client.ts` (`placeMarketBuy` / `placeMarketSell`, builder code inside the signed struct). **`/api/orders` no longer places orders** — it is now pre-trade authorization: auth, geo gate, input validation, fee disclosure. Call it before signing.

**SEC-2 is narrowed, not abandoned.** Its purpose was stopping a caller dictating price/size/counterparty *on someone else's behalf*. Client-side signing removes that attack by construction — an order is only valid if the user's own key signed it, so a tampered page can only harm the user operating it. The geo gate is likewise advisory now (a user can submit to Polymarket directly), which is fine because it never was the only control: **Polymarket enforces jurisdiction upstream regardless**; ours exists to give real feedback instead of an opaque rejection.

**Dead code awaiting removal:** `/api/wallet/{status,deploy,qr}` and all of `lib/polymarket/clob.ts`. Nothing in the UI calls them and they fail on the abandoned server-signer path. They are inert (auth-gated, then error), not a hole — but delete them rather than let someone wire them back up.

Two consequences to keep straight:
- **SEC-2 is narrowed, not deleted.** Orders are no longer rebuilt server-side. What protects us is that `builderCode` is inside the *signed* order struct — a tampered order is attributed elsewhere, not a way to move someone else's funds. Nothing the browser constructs can spend funds the user's own signer did not authorise.
- **Accepted residual exposure**: the SDK's remote-signing contract returns `POLY_BUILDER_API_KEY` and `POLY_BUILDER_PASSPHRASE` to the client so it can set headers. Any signed-in user can read them. They cannot forge requests without the secret, but they do identify our builder account. The route is authentication-gated; rotate P-2…P-4 via `builder:provision -- derive-keys` if abused.

**Historical context — why this was forced.** The architecture signs every order server-side (SEC rule), which means *every user must delegate their wallet*, not just copy-trade users. Delegation is revocable and Privy still splits key custody, so it is not custody in the strict sense — but the server gains the ability to sign without per-action user approval, which is the same property that makes copy trading a legal question. It also sits awkwardly with the homepage copy *"Your wallet, your keys — deposits and positions stay under your own signer."* The alternative is client-side order signing, which avoids delegation entirely but conflicts with SEC-2 (orders rebuilt server-side, never accepted from the client). **Pick deliberately; do not let this get decided by whoever implements the next route.**

**Copy trading breaks the non-custodial guarantee — *if* it runs on a server.** Auto-executing on a user's behalf needs server-held delegated signing or session keys. Either one moves the platform from "interface" toward "discretionary trading service." Don't design around this quietly — it's OI-5, a product and legal decision. What the built engine does instead is below.

**🚩 The copy engine is LIVE and places real orders — one user click at a time. `COPY_EXECUTION_MODE = "live"` in `lib/copy-trade/types.ts` is the switch.** Flipped 2026-08-19, when the click-to-place path landed. ⚠️ **Not yet exercised against a real mainnet fill** — the path is built and unit-tested, nothing more. Read this before touching anything under `lib/copy-trade/` or `/copy-trade`.

What runs: `useCopyEngine` polls each followed trader's `/trades` every 20s **in a browser tab**, groups fills into intents, sizes them against the user's caps, and writes each approved copy to the ledger as `queued`. It stops there. `CopyQueue` renders those rows with a **Place** button, and `placeCopy` (`execute.ts`) is the only thing in this feature that ever signs — reached only from that click.

Set the constant back to `"simulated"` to test engine changes without money: the dry run then resolves the same queue through `planResolution` instead, exercising auth, geo, legal acceptance and fee disclosure via `/api/orders` (pre-trade *authorization*, not placement) and recording `simulated` rows.

Six things to keep straight:

- **The "daemon" is a browser tab, and that is the design.** Copies only happen while the tab is open, and browsers throttle background-tab timers to ~1/min. This is what keeps OI-5 narrowed: no delegation is requested, no key is held server-side, the engine has no more authority than the user sitting at the screen. **A "small" server-side helper that signs, or a cron that polls on the user's behalf, re-opens the custody question this design exists to avoid** — and Workers can't host it regardless (OI-3).
- **🚩 The click is the load-bearing part, not a UI nicety.** An engine that signs approved copies by itself is a different product with a different legal answer, however similar the code looks. Auto-placement was considered and deliberately not built (decision 2026-08-19); every user-facing string — `FollowDialog`, `EngineStatusBar`, `CopyQueue` — promises a click, so removing it silently would make those strings lies.
- **Everything is re-checked at click time and nothing is reused from the decision except the size.** A queued row's preflight answer, market state and balance are all restated in `placeCopy`; a five-minute-old preflight says nothing about now. `checkCopyPreconditions` is shared by the dry run and the live click precisely so the two cannot drift.
- **`market_closed` now fires** — `isMarketAcceptingOrders` (`browser-client.ts`) reads it at click time. ⚠️ Both flags live under **`market.state`**, not on the market: the SDK restructures Gamma's flat JSON, so `market.closed` is `undefined` and reads as open. `decideCopy`'s `marketClosed` parameter is still unwired in the poll loop, which is fine — the click is where a fresh answer exists.
- **Copies carry a price guard** (`COPY_MAX_SLIPPAGE`, 5% around the trader's own fill, plus up to one tick from the snapping below), so a click can legitimately produce no position. A copy that cannot fill inside the band lands as `failed` with the reason visible — that is the guard working, not a bug.

- **🚩 A price bound must be snapped to the market's OWN tick size, and tick size is per-market.** Found and fixed 2026-08-19, before the first live copy. `priceGuard` formatted the bound with `.toFixed(3)` and its comment claimed *"three decimals … is the CLOB's price granularity"* — it is not. Sampled ten markets that live leaderboard traders had just traded: **nine had `tick_size: 0.01`**, and **7 of 10 bounds were rejected** by the SDK *before the order was signed*:

  ```
  maxPrice must conform to tick size 0.01 with at most 2 decimal places.
  ```

  The validator is `nr()` in `@polymarket/client`, reached via `placeMarketOrder`, and it throws on three separate counts: outside `[tick, 1 - tick]`, more decimals than the tick has, or not a whole multiple of the tick. Note the old `clampPrice` range `[0.001, 0.999]` is *outside* the legal range on any market coarser than 0.001, so high anchors failed the range check instead.

  ⚠️ **It failed intermittently, which is what made it dangerous.** `PositiveDecimalNumberSchema` coerces the string to a number, so `"0.420"` arrives as `0.42` and passes while `"0.336"` throws — the old code worked about 1 time in 10, depending on whether the third decimal happened to be zero.

  `quantiseToTick` (`execute.ts`) now snaps the bound, rounding **up for a buy, down for a sell** (both = "keep the copy placeable"; the opposite direction buys silent no-fills). Two things in it are load-bearing and look like noise: the result goes through `toFixed(decimals)` because `34 * 0.01` is `0.34000000000000002`, and the *quotient* is de-noised before rounding because `0.29 / 0.01` is `28.999999999999996` and `0.34 / 0.01` is `34.000000000000004` — a bare floor/ceil moves an already-on-grid price a full tick the wrong way. Verified by porting `nr()` out of the SDK bundle and running 3,996 anchor × tick × direction combinations through it: all accepted.

  `priceGuard` now returns the **intended** band only and is display-only; `placeableGuard(entry, tickSize)` is what an order may carry. A `null` tick sends **no guard** rather than an invalid one — unguarded is worse than guarded, but invalid fails 100% of the time.

- **⚠️ `MIN_COPY_USD = 1` is well below Polymarket's real floor.** The CLOB's `min_order_size` is **5 shares** — $2.50 at a price of 0.50, $4.50 at 0.90 — so a $1–2 copy is rejected upstream and lands as `failed` rather than skipping cleanly as `below_minimum`. Size test copies at **$5 or more**. Wiring `minOrderSize` into `decideCopy` so it skips honestly is still to do.
- **The ledger and follow list live in `localStorage`, per-device.** Cleared site data loses them. `store.ts` treats everything it reads back as untrusted input for that reason — most importantly a corrupt cursor normalises to `null` ("seed me"), never `0`, which would mean *replay this trader's entire history as live orders*.

- **🚩 In `selectCopyableIntents`, group the whole page FIRST and let the cursor filter the *intents*. Filtering the trades first double-copies orders.** Found and fixed 2026-08-19. A bucket is named after its earliest fill (`address:tokenId:side:timestamp`), so dropping that fill by cursor makes the same order re-form as a **new bucket under a new key** — which the ledger's `intentKey` dedup cannot catch, and which passes the caps a second time. Measured on one order with fills at t=1000, t=1000, t=1001:

  ```text
  tick 1 (cursor 500)  -> 0xabc:tok1:BUY:1000, 300 shares, cursor -> 1000
  tick 2 (cursor 1000) -> 0xabc:tok1:BUY:1001,  50 shares   ← the tail, copied again
  ```

  It needs a fill to land across a second boundary, which the 2026-08-17 sample happened not to show — but the 2s grouping window exists precisely for that case, so it was reachable in production. The user's click is the only reason it was not silent: both rows queue, and the second reads as an ordinary separate trade. Pinned by `engine.test.ts` → "an order whose fills straddle a second boundary". Grouping the full 100-row page each tick is what makes the bucket start stable across ticks; the cost is nothing and the `intentKey` dedup becomes a real backstop instead of an accident of timing.

---

## SDK surface

```ts
// @polymarket/client — CLOB auth, markets, orders
import { createSecureClient, OrderSide } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";

const client = await createSecureClient({ wallet, signer });
const market  = await client.fetchMarket({ slug });
const tokenId = market.outcomes.yes.tokenId!;
await client.placeMarketOrder({ tokenId, side: OrderSide.BUY, amount: "10" });
```

```
// @polymarket/builder-relayer-client — gasless wallet ops
deriveDepositWalletAddress()   predict address before deploy
getDeployed()                  check existence — call before deploying
deployDepositWallet()          gasless deploy via Relayer
executeDepositWalletBatch()    batched calls with signatures
```
Configured with: relayer URL, chainId `137`, a viem wallet client, and builder auth. Supports **Local Builder Auth** (key/secret/passphrase in-process) or **Remote Builder Auth** (external signing URL + token) — prefer Remote if signing ever splits into its own service.

---

## Credentials

**All accounts and API keys are provided by the client.** Do not self-register — builder credentials tie to the client's Polymarket profile and fee revenue accrues to whichever wallet owns it. Full checklist in [implementation.md §1](implementation.md).

Needed: builder code + API key/secret/passphrase (P-1…P-4), payout wallet, wallet-provider account, Cloudflare account, domain, Polygon RPC, GitHub repo.

Secrets go into Cloudflare via `wrangler secret put` — the dev team needs Cloudflare *access*, not copies of the secrets. Builder secret and passphrase are **shown once** by Polymarket; losing them means rotation.

---

## Security rules

- Builder API key / secret / passphrase live **only** in Cloudflare env vars. Never in the client bundle, never behind `NEXT_PUBLIC_*`.
- Order signing happens **client-side**, by the user's own key (see "RESOLVED 2026-08-04 — client-side signing chosen" in Traps). The builder secret never leaves the server; the browser only ever receives short-lived HMAC headers from `/api/builder/sign`.
- `/api/builder/sign` must stay authenticated and rate-limited — every private CLOB call goes through it, so it spends our builder quota regardless of which order operation triggered it.
- No private keys in logs, error traces, or analytics.
- Secret scanning in CI; strict CSP on trading routes.

---

## Milestones

Dates assume a 2026-08-03 start (unconfirmed, OI-7).

| Week | Dates | Deliverable | $ |
|---|---|---|---|
| 1 | Aug 3–9 | Architecture, Builder setup, auth, Deposit Wallets, **Workers signing spike** | 150 |
| 2 | Aug 10–16 | Market discovery UI, Gamma engine, edge caching | 150 |
| 3 | Aug 17–23 | CLOB trading, WebSockets, signing; **submit Verified application** | 150 |
| 4 | Aug 24–30 | Portfolio, withdrawals, E2E tests, production launch | 100 |

**Phase 2 (Predict AI, Copy Trading) is in no milestone and is unfunded.** Building to this schedule delivers Phase 1 only. OI-2.

**Weeks 2–4 combined (decision, 2026-08-07).** Engineering now treats Market Discovery, Trading Engine & WebSockets, and Portfolio/Testing & Launch as one continuous build rather than three sequentially-gated weeks — several Week 3 items (fee engine, pre-trade authorization, client-side market-order signing) were already built ahead of schedule during Milestone 1, and the remaining work in all three weeks shares dependencies (Gamma client → discovery UI → order ticket → WebSockets → portfolio) that don't naturally split at week boundaries. **Billing milestones and the $550/4-week total in [srs.md §8](srs.md) are unchanged** — this is a sequencing decision, not a scope or commercial change. Detailed step-by-step breakdown (with what's already built vs. remaining) is in [implementation.md §5–7](implementation.md).

**Revisions:** up to 4 client revision rounds included in the fixed price (see [srs.md §8](srs.md)).

### Gap analysis — "complete Polymarket-parity platform" wishlist vs. current scope (2026-08-07)

The client has separately described wanting full Polymarket.com feature parity: entire market categories/segments/events, copy trading, sports-betting AI, deposits, signup/signin, and "the entire available features on the polymarket platform." Checked against the combined Weeks 2–4 plan above:

| Wishlist item | Status |
|---|---|
| Entire market categories/segments/events | **Covered at no extra cost.** Discovery UI (Step 2.3, implementation.md) browses the whole Gamma catalogue with category, sort and range filters. ⚠️ Correction 2026-08-15: the category chips come from the curated `TOP_CATEGORIES` constant in `gamma-types.ts`, **not** a live tags fetch — an earlier version of this line claimed otherwise. `listTags` exists but is deliberately unwired; see the comment at the foot of `gamma.ts` (unfiltered `/tags` was garbage, `isCarousel:true` too sparse). |
| Users' deposits | **Done.** Client-provisioned Deposit Wallet, QR + address + balance-polling flow (`deposit-wallet-panel.tsx`). |
| Signup/signin | **Done, kept as-is per client direction 2026-08-07.** Privy embedded wallet, email-only login. No standalone `/login` page — auth is embedded in the nav bar / home page. |
| Copy trade feature | **Feature-complete as of 2026-08-19: the engine watches, sizes and queues, and the user places each copy with one click.** ⚠️ Built and unit-tested, **not yet confirmed against a real mainnet fill**. See the copy-trading trap below. `/leaderboard` is a complete feature. OI-5 is **narrowed, not resolved** — poll loop in the user's own browser tab, no delegation, no server-held key, and every order signed behind a human click; hands-off auto-signing remains the open product + legal question and was deliberately not built. FR-8 in srs.md. |
| Sports betting AI | **Not in scope — Phase 2, unfunded, unspecified.** FR-7 in srs.md has no chosen model/provider/data source/cost — "not estimable as written." |
| Domain `POLYBETS.XYZ` → Cloudflare | **Supplied, unverified.** Client states it's pointed at Cloudflare; DNS zone/nameserver delegation not yet checked from this environment (P-8, deployment.md). |
| Up to 4 revisions | **Commercial term, recorded** in srs.md §8 — no code impact. |

**The two real gaps against "complete platform" are copy trading and sports AI** — both are deliberately excluded from the current build per their existing blockers (legal/custody question for copy trading, undefined spec/budget for sports AI), not oversights. Revisit as a separately scoped, separately priced Phase 2 once OI-5 is resolved and a sports-AI provider/budget is chosen (see [implementation.md §8](implementation.md)).

---

## Related

`/Users/sayem/projects/PREDICT-ME` — `polybet365`, a separate prediction-market codebase (own contracts, backend, frontend, Goldsky subgraph; npm workspaces, deployed on Vercel). Appears to be the "existing site" the $125/mo maintenance also covers. **Not this repo — do not modify it as part of this project.** Its maintenance scope is undefined (OI-8).

---

## Maintenance Protocol

**This file must stay current with the project.** When any of the following happens, update it in the same session:

| Trigger | Update |
|---|---|
| A decision is made (OI-1…OI-8) | Move it out of "Current state" into the relevant section as settled fact; note the decision |
| Stack or dependency chosen | Update the Stack table |
| Code structure appears | Add a "Layout" section — key directories, entry points, commands |
| A Polymarket API detail is verified or found stale | Update the integration section **and** the verification date in its heading |
| A new trap or gotcha is hit | Add it to Traps — that section exists to stop the same mistake twice |
| A **deploy** trap, limit, or recovery step is hit | Record it in [deployment.md](deployment.md) §8, not here. That file is the one someone reads at 2am; a deploy fix buried in this file will not be found in time |
| A milestone completes | Mark it in the Milestones table |
| A requirement changes | Update [srs.md](srs.md) first, then reflect the summary here |

**Rules:**
- Update the "Last updated" date at the top on every edit.
- Keep this file skimmable — it's working context, not documentation. Details go in [srs.md](srs.md); this file holds what's needed to act.
- Never record a Polymarket API fact from memory. Verify against `docs.polymarket.com` (index: `docs.polymarket.com/llms.txt`) and note the date. This platform changes fast — the client SRS was already outdated on 5 points when written.
- When something here turns out to be wrong, correct it rather than appending a contradiction.
