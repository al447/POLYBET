# CLAUDE.md

Working context for the Polymarket Integration Platform. **Keep this file current** — see [Maintenance Protocol](#maintenance-protocol) at the bottom.

> **Last updated:** 2026-08-02 · **Phase:** Milestone 1 in progress · **Repo:** initialized, 1 commit

## Layout

```
src/
  middleware.ts            geo gate (Edge — NOT proxy.ts, see below)
  app/
    restricted/            geoblocked landing
    api/health             secret presence + builder readiness
    api/geoblock           per-request geo tier (never cached)
    api/wallet/deploy      Deposit Wallet provisioning
    api/orders             order placement (security-critical)
  lib/
    env.ts                 request-time secrets via getCloudflareContext
    geo/{jurisdictions,edge,index}.ts
    auth/{types,privy,session}.ts
    polymarket/{config,fees,builder,clob}.ts
scripts/
  check-client-bundle.mjs  CI leak guard
  smoke-builder.mjs        Milestone 1 acceptance, run when P-1..P-5 land
```

**Commands:** `npm run dev` · `lint` · `typecheck` · `test` · `build` · `check:secrets` · `preview` · `deploy` · `smoke:builder`

**Mock mode.** With no builder credentials set, the app builds and every path runs, but no order is signed. `/api/health` reports `mode` and which of P-1…P-9 are missing.

---

## What this is

A white-label prediction market frontend on the client's own domain. It does **not** run its own market or matching engine — it routes user orders into the **Polymarket CLOB** under the **Polymarket Builder Program**, earning a builder fee on attributed volume.

| Doc | Role |
|---|---|
| [srs.md](srs.md) | Requirements — source of truth |
| [implementation.md](implementation.md) | Step-by-step build plan, prerequisites, acceptance checks |
| **CLAUDE.md** (this) | Working context — what's needed to act |

**Commercials:** $550 fixed price, 4 weeks, milestone payments. $125/mo maintenance afterward covering this platform *and* the client's existing site.

---

## Current state

Nothing is built. The directory is empty — no `package.json`, no git repo.

**Before writing code, 4 decisions are blocking** (full list in [srs.md §9](srs.md)):

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
| Local env | Node v22.22.3 (16 needs ≥20.9), npm 10.9.8, pnpm 11.5.2, TS ≥5.1 |

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

Taker cap **100 bps**, maker cap **50 bps**, 1 bps granularity. `fee = notional × bps ÷ 10_000`. **The user pays**, stacked on top of Polymarket's own fees. Our rate is unset — OI-6.

### Builder tiers

| Tier | Relay tx/day | How |
|---|---|---|
| Unverified | **100** | Self-serve, `polymarket.com/settings` |
| Verified | **10,000** | Email `builder@polymarket.com`, several business days |
| Partner | Unlimited | Strategic, demonstrated volume |

**100/day cannot support a public launch.** Submit the Verified application in Week 3 — approval is externally controlled and gates launch.

---

## Traps

**Workers cannot run the copy-trade daemon.** Request-scoped; no long-lived WebSocket, no unbounded loop. Needs Durable Objects + Cron Triggers, or a separate host (recommended). OI-3.

**Signing on Workers — largely de-risked, still gated.** OpenNext gives the full Node.js runtime, so EIP-712 (`viem`) + HMAC-SHA256 should work normally. Still verify in a *deployed* Worker before building on it ([implementation.md](implementation.md) Step 1.6). Set `nodejs_compat` if a dependency needs it.

**100 relay tx/day is shared across dev, QA, and demos.** Every Deposit Wallet deployment spends one. Call `getDeployed()` before deploying, reuse test wallets, don't burn deploys on throwaway accounts.

**No testnet for the production CLOB.** Milestone 1 acceptance requires a real mainnet order. Client must fund the builder wallet with ~$50 pUSD for testing.

**Cache Components breaks pages that read `headers()`/`cookies()` outside `<Suspense>`.** Not a warning — the build fails with "Uncached data was accessed outside of `<Suspense>`". Wrap the dynamic part in a child component inside `<Suspense>`; the route then renders as `◐ Partial Prerender`. Hit this on `/restricted`.

**`@polymarket/builder-relayer-client` is redundant.** `@polymarket/client` already exports `deployDepositWallet`, `isWalletDeployed`, `setupTradingApprovals`. Removed it — the Worker bundle is near the size limit and a second SDK is dead weight.

**Standalone actions are on the `/actions` subpath**, not the root: `import { deployDepositWallet, isWalletDeployed } from "@polymarket/client/actions"`. But `placeMarketOrder`, `fetchClosedOnlyMode`, `listBuilderTrades`, `setupTradingApprovals` **are** client methods. The split is not obvious — check `dist/actions/index.d.ts` before assuming.

**Privy peer conflict — install with `--legacy-peer-deps`.** Privy's optional `permissionless` peer wants `ox@^0.8`; the Polymarket viem stack pulls `ox@0.14`. We don't use `permissionless` (Polymarket has its own Relayer, no ERC-4337), so the mismatch is inert. CI does the same.

**Privy issues two tokens.** `privy-token` (access, authenticates) and `privy-id-token` (identity, carries linked accounts). The embedded wallet address/id come from the identity token — verifying only the access token gets you a user with no wallet.

**Bundle is at 2.90 MiB gzipped with almost no UI.** The 3 MiB free-tier cap will be exceeded as soon as real screens land. Workers **Paid** is not optional (P-7). Watch this number.

**`tsc` caches aggressively.** After changing `tsconfig.json`, delete `*.tsbuildinfo` or you will debug errors that no longer exist.

**Geoblocking is absent from the client SRS.** Three tiers, all must be enforced:
- **Blocked** (no trading at all): Iran, Syria, Cuba, North Korea, Crimea/Donetsk/Luhansk
- **Close-only** (exit positions only, no new orders): 30+ jurisdictions — US, UK, France, Germany, Singapore, Australia, Brazil, Russia, Taiwan, and BC/Ontario/Alberta/Quebec
- **Frontend-restricted**: Ireland, Japan, Netherlands, Malta (sports only)

Polymarket rejects blocked orders server-side regardless; our check exists so users get real feedback instead of opaque failures.

**Withdrawals were never in the client SRS.** Added as FR-4.6. Deposit-only is not shippable.

**Copy trading breaks the non-custodial guarantee.** Auto-executing on a user's behalf needs server-held delegated signing or session keys. Either one moves the platform from "interface" toward "discretionary trading service." Don't design around this quietly — it's OI-5, a product and legal decision.

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
- All order signing happens server-side in Workers.
- Signing routes must be authenticated and rate-limited — they spend our builder quota.
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
| A milestone completes | Mark it in the Milestones table |
| A requirement changes | Update [srs.md](srs.md) first, then reflect the summary here |

**Rules:**
- Update the "Last updated" date at the top on every edit.
- Keep this file skimmable — it's working context, not documentation. Details go in [srs.md](srs.md); this file holds what's needed to act.
- Never record a Polymarket API fact from memory. Verify against `docs.polymarket.com` (index: `docs.polymarket.com/llms.txt`) and note the date. This platform changes fast — the client SRS was already outdated on 5 points when written.
- When something here turns out to be wrong, correct it rather than appending a contradiction.
