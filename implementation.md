# Implementation Plan
## Polymarket Integration Platform

> Companion to [srs.md](srs.md) (requirements) and [CLAUDE.md](CLAUDE.md) (working context).
> **Last updated:** 2026-08-02 · **Status:** not started
> **Target:** Next.js 16 · React 19.2 · Cloudflare Workers (OpenNext) · Polygon mainnet
> **Verified against** `docs.polymarket.com`, `nextjs.org`, and `opennext.js.org` on 2026-08-02

---

## 0. How to use this document

Steps are grouped by milestone and ordered by dependency. Each step has a **✅ Done when** check — treat that as the exit criterion, not "the code compiles."

Anything marked 🔴 is **blocked on the client** (a decision or a credential). Anything marked ⚠️ is a known trap with a documented workaround.

---

## 1. Client-Provided Prerequisites

**All accounts and API keys are supplied by the client.** Nothing here should be self-registered by the dev team — builder credentials tie to the client's Polymarket profile, and fee revenue accrues to whichever wallet owns that profile. Registering under a dev account would send the platform's revenue to the wrong place and require a painful migration later.

### 1.1 Credentials Checklist

| # | Item | Where it comes from | Format | Needed by | Blocks |
|---|---|---|---|---|---|
| P-1 | **Polymarket Builder Code** | `polymarket.com` → Settings → Builders | `bytes32` hex | Week 1 D1 | All order attribution |
| P-2 | **Builder API Key** | Same panel | UUID | Week 1 D1 | Relayer, wallet deploy |
| P-3 | **Builder Secret** | Same panel — **shown once** | base64 string | Week 1 D1 | L2 HMAC signing |
| P-4 | **Builder Passphrase** | Same panel — **shown once** | string | Week 1 D1 | L2 HMAC signing |
| ~~P-5~~ | ~~Builder payout wallet~~ | ✅ **Resolved 2026-08-04** — not a separate wallet. Commission accrues to the profile-owner wallet `0xdd288d80…D0Ba`, accepted as-is. Handover transfers custody to the client | — | — | — |
| P-6 | **Embedded wallet provider account** | Privy / Turnkey / Magic dashboard | App ID + App Secret | Week 1 D2 | Login (🔴 OI-4) |
| P-7 | **Cloudflare account — Workers *Paid* plan** | Client's Cloudflare | Account ID + API token (Workers Scripts: Edit) | Week 1 D1 | Deploys. ⚠️ Paid required: free tier caps Workers at 3 MiB gzipped, which this app will exceed (10 MiB on paid) |
| P-8 | **Production domain** | Client registrar | DNS delegated to Cloudflare | Week 3 | Launch, Verified application |
| P-9 | **Polygon RPC endpoint** | Alchemy / Infura / QuickNode | HTTPS URL + key | Week 1 D3 | On-chain reads |
| P-10 | **GitHub repo** | Client org | Repo + push access | Week 1 D1 | CI/CD |
| P-11 | **AI provider key** (Phase 2) | Anthropic / OpenAI | API key | Phase 2 | Predict AI (🔴 OI-2) |
| P-12 | **Error tracking** (optional) | Sentry | DSN | Week 2 | Observability |

> ⚠️ **P-1 cannot be generated programmatically.** The `bytes32` builder code is assigned to a builder *profile*, and profiles are created only through `polymarket.com` → Settings → Builders. In the SDK it is exclusively an **input** — every builder function takes `builderCode?: BuilderCode`; none returns one. A script that "generates builder keys" without a registered profile produces credentials that attribute nothing and earn nothing.
>
> P-2…P-4 *can* be minted programmatically once the profile exists, via `createBuilderApiKey()` — **not** `createApiKey()`, which returns *user* CLOB credentials. See `scripts/provision-builder.mjs`.

> ⚠️ **P-5 is not a separate wallet — it IS the profile-owner wallet.** Verified 2026-08-04: the Builders panel has no payout field (its only address is marked *"For API use only"*), and the docs say only *"Collected builder fees are distributed to the wallet associated with your builder profile."* Whoever holds that key controls all commission revenue, and it cannot be reassigned. **Register the builder profile on the key that should ultimately own the money** — migrating afterwards costs a new builder code, new API credentials, and the attributed volume history the Verified tier application rests on.

### 1.2 Handover Rules

- Deliver secrets through a **password manager share or Cloudflare dashboard entry** — never Slack, email, or a chat message. P-3 and P-4 are displayed once by Polymarket; if lost, credentials must be rotated.
- The dev team needs **Cloudflare access to set secrets**, not copies of the secrets themselves. Preferred: client enters P-1…P-5 directly into Cloudflare via `wrangler secret put` on a screenshare, or grants dashboard access.
- **Never commit any of these.** `.dev.vars` and `.env*` are gitignored from commit #1 (Step 1.2).

### 1.3 Client Actions Before Kickoff

1. Create the builder profile at `polymarket.com/settings` → Builders tab → record P-1…P-5.
2. Fund the builder wallet with a small amount of pUSD (~$50) for end-to-end testing on mainnet. **There is no testnet for the production CLOB** — Milestone 1 acceptance requires a real order.
3. Decide the wallet provider (OI-4) and create that account (P-6).
4. ~~Decide the builder fee rate (OI-6)~~ — ✅ **resolved 2026-08-04: 50 bps taker (0.50%), 0 bps maker.** Within the 100/50 caps. Set on the builder profile at registration *and* in `BUILDER_FEE_BPS_*`; `npm run builder:provision -- verify-fees` asserts the two agree, because a mismatch means every fee disclosed to a user is wrong.
5. Confirm the target market against the close-only geoblock list (OI-1).

---

## 2. Locked Architecture Decisions

### 2.1 ⚠️ Correction: Workers + OpenNext, not Pages

The client SRS specifies **Cloudflare Pages**. That path is now wrong:

| | `@cloudflare/next-on-pages` (SRS) | `@opennextjs/cloudflare` (use this) |
|---|---|---|
| Target | Cloudflare Pages | Cloudflare **Workers** |
| Runtime | Edge only — restricted API surface | **Full Node.js runtime** |
| Status | Superseded | Recommended by Cloudflare **and** the Next.js team since March 2026; GA Feb 2026 |
| Next.js 16 | Not supported | **Supported** — all 16.x minors/patches |
| Impact here | EIP-712 signing is fragile on Edge | Signing works normally |

**This resolves architectural risk A-2.** The Week-1 "can we sign on `workerd`?" spike shrinks from a go/no-go risk to a routine verification. Still verified explicitly in Step 1.6 — trust, then check.

⚠️ **Workers Paid plan is required.** Worker size limits are 3 MiB gzipped on free, 10 MiB on paid. A Next.js app of this scope will exceed 3 MiB. Add to P-7.

### 2.2 Next.js 16 — Target Version

**Target: Next.js 16 (current: 16.2.x), React 19.2, Node 20.9+, TypeScript 5.1+.**

> The original SRS specified Next.js 14. That was not merely dated — **OpenNext ended Next.js 14 support in Q1 2026**, so it is no longer a supported deployment target on Cloudflare at all. Next.js 16 is the correct target.

Breaking changes that directly shape this build:

| Change | Effect here |
|---|---|
| **`middleware.ts` → `proxy.ts`** | The geoblock gate moves to `proxy.ts`. **`proxy` runs the Node.js runtime and cannot be configured to Edge** — a net win: the gate can use Node APIs freely. `middleware.ts` still works but is deprecated and Edge-only |
| **Async request APIs enforced** | `cookies()`, `headers()`, `params`, `searchParams` are Promise-only; synchronous access is fully removed. Affects session reads, `market/[slug]`, and every route handler |
| **Cache Components** | `cacheComponents: true` replaces PPR/`dynamicIO`/`useCache`. **Everything is dynamic by default**; caching is explicit opt-in via `use cache` |
| **`revalidateTag` signature** | Now requires a second `cacheLife` argument — `revalidateTag('markets', 'max')`. Single-arg form is a TypeScript error |
| **`cacheLife` / `cacheTag` stable** | Drop the `unstable_` prefix on imports |
| **`serverRuntimeConfig` / `publicRuntimeConfig` removed** | Env vars only. Reinforces §2.5 — secrets come from the Cloudflare env, not build-time `process.env` |
| **`next lint` removed** | `next build` no longer lints. Run ESLint CLI (flat config) or Biome directly in CI |
| **Turbopack default** | No `--turbopack` flag. A custom webpack config will **fail** the build |
| **`images.domains` deprecated** | Polymarket market images need `images.remotePatterns`. Also: `qualities` now defaults to `[75]`, `minimumCacheTTL` to 4h |
| **Parallel routes need `default.js`** | Builds fail without it — relevant if the order ticket is a modal route |

> **The "dynamic by default" caching model suits this app.** In a trading UI, stale prices are a correctness bug, not a performance trade-off. Next 16 makes non-caching the default and forces caching to be a deliberate, tagged decision — which is exactly the posture we want. See Step 2.2.

**Migration codemod** (if scaffolding from an older template):
```bash
npx @next/codemod@canary upgrade latest
```
It handles the `middleware` → `proxy` rename, `next lint` → ESLint CLI, turbopack config relocation, and `unstable_` prefix removal.

### 2.3 SDKs

| Package | Purpose |
|---|---|
| `@polymarket/client` | CLOB auth, market fetch, order placement. Entry: `createSecureClient` |
| `@polymarket/builder-relayer-client` | Gasless wallet deployment + relayed transactions |
| `viem` | Signing, typed data, chain reads. **Both Polymarket SDKs are viem-based** — do not add `ethers` |

### 2.4 Repository Layout

```
polymarket-integration-platform/
├── src/
│   ├── proxy.ts                   geoblock gate (Next 16 — was middleware.ts)
│   ├── app/
│   │   ├── (public)/              landing, legal, geoblocked notice
│   │   ├── (app)/
│   │   │   ├── markets/           discovery
│   │   │   ├── market/[slug]/     detail + order ticket
│   │   │   └── portfolio/         positions, PnL, history
│   │   └── api/                   server-only — Workers
│   │       ├── geoblock/route.ts
│   │       ├── markets/route.ts        Gamma proxy + cache
│   │       ├── wallet/deploy/route.ts  Deposit Wallet provisioning
│   │       ├── orders/route.ts         POST place / DELETE cancel
│   │       └── portfolio/route.ts      Data API proxy
│   ├── lib/
│   │   ├── polymarket/
│   │   │   ├── gamma.ts           discovery client
│   │   │   ├── clob.ts            createSecureClient wrapper
│   │   │   ├── data.ts            positions / PnL
│   │   │   ├── relayer.ts         builder-relayer-client wrapper
│   │   │   ├── builder.ts         builder code + fee attachment
│   │   │   ├── fees.ts            fee math, balance headroom
│   │   │   └── types.ts
│   │   ├── auth/                  wallet provider adapter (OI-4)
│   │   ├── geo/                   geoblock gate + tier logic
│   │   └── cache/                 KV / Cache API helpers
│   ├── components/{ui,markets,trade,portfolio}/
│   └── hooks/
│       ├── use-orderbook.ts       market WSS
│       └── use-user-channel.ts    user WSS
├── tests/{unit,e2e}/
├── next.config.ts                 cacheComponents, images.remotePatterns
├── open-next.config.ts            OpenNext + R2 incremental cache
├── wrangler.jsonc                 bindings, compat flags
├── cloudflare-env.d.ts            generated by `npm run cf-typegen`
├── eslint.config.mjs              flat config (Next 16 removed `next lint`)
└── .dev.vars                      gitignored
```

### 2.5 Secrets Map

**Server-only** — Cloudflare secrets, never in a client bundle:
```
POLYMARKET_BUILDER_CODE          P-1
POLYMARKET_BUILDER_API_KEY       P-2
POLYMARKET_BUILDER_SECRET        P-3
POLYMARKET_BUILDER_PASSPHRASE    P-4
BUILDER_FEE_BPS_TAKER            OI-6, ≤100
BUILDER_FEE_BPS_MAKER            OI-6, ≤50
WALLET_PROVIDER_APP_SECRET       P-6
POLYGON_RPC_URL                  P-9
```

**Public** — safe in the bundle:
```
NEXT_PUBLIC_WALLET_PROVIDER_APP_ID
NEXT_PUBLIC_CHAIN_ID=137
```

> ⚠️ **Rule:** if a variable name doesn't start with `NEXT_PUBLIC_`, it must never be imported into a Client Component. Enforced by CI grep in Step 1.7.

**Reading secrets on Workers (Next 16 + OpenNext).** `serverRuntimeConfig` is removed in Next 16, and build-time `process.env` reads get baked into the bundle. Always read Cloudflare secrets at request time:

```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";

const { env } = await getCloudflareContext();
env.POLYMARKET_BUILDER_SECRET;   // request-time, never bundled
```
Run `npm run cf-typegen` to generate `CloudflareEnv` types for these bindings. Where a plain `process.env` read is unavoidable in a Server Component, call `await connection()` from `next/server` first to force runtime evaluation.

---

## 3. Phase 0 — Pre-Flight (before Week 1)

**Step 0.1 — Resolve blocking decisions.** OI-4 (wallet provider) and OI-6 (fee rate) block Week 1. OI-1 (target market) and OI-5 (copy trading vs. non-custodial) block Phase 2 but should be settled now — OI-1 can invalidate the business case.

**Step 0.2 — Collect P-1…P-10** per §1.

**Step 0.3 — Wallet provider selection (OI-4).** Evaluate against: Workers/Node compatibility, viem signer export (both SDKs need a viem account), email + social login, pricing at expected MAU, and self-custody model.

| Provider | Notes |
|---|---|
| **Privy** | Broadest embedded-wallet feature set, first-class viem support, well-trodden with Polymarket-style apps. **Default recommendation** |
| **Turnkey** | Strongest key-management/security posture; more infrastructure to assemble |
| **Magic** | Simplest email login; thinnest wallet feature set |

✅ **Done when:** provider chosen, account created (P-6), and a hello-world signer produces a valid EIP-712 signature in a Worker.

---

## 4. Week 1 — Foundation, Auth & Wallets
**Aug 3–9 · $150 · Architecture, Builder setup, Web3 authentication**

### Step 1.1 — Scaffold
```bash
npm create cloudflare@latest polymarket-integration-platform -- \
  --framework=next --platform=workers
cd polymarket-integration-platform

# confirm Next 16 + React 19.2; pin them
npm i next@latest react@latest react-dom@latest
npm i @opennextjs/cloudflare@latest
npm i -D wrangler@latest          # >= 3.99.0 required

npx shadcn@latest init
npm i @polymarket/client @polymarket/builder-relayer-client viem
```

`next.config.ts`:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,          // Next 16 caching model — see Step 2.2
  images: {
    remotePatterns: [             // images.domains is deprecated in 16
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
    ],
  },
};
export default nextConfig;
```

`wrangler.jsonc` essentials:
```jsonc
{
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-12-30",          // or later
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "binding": "ASSETS", "directory": ".open-next/assets" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "<worker-name>" }]
}
```

`package.json` scripts:
```json
{
  "dev": "next dev",
  "build": "next build",
  "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
  "deploy":  "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
  "cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts"
}
```
⚠️ No `--turbopack` flag — Turbopack is the Next 16 default. Do **not** add a custom webpack config; it fails the build.

Call `initOpenNextCloudflareForDev()` in `next.config.ts` to get local bindings during `next dev`.

✅ **Done when:** `npm run dev` serves locally, `npm run preview` runs on workerd, and `npm run deploy` puts a placeholder on `*.workers.dev`. Confirm `next --version` reports 16.x.

### Step 1.2 — Repo hygiene (do this before any secret exists)
- `.gitignore`: `.dev.vars`, `.env*`, `.wrangler/`, `.open-next/`, `node_modules`, `.next`
- TypeScript `strict: true` (5.1+ required by Next 16)
- ⚠️ **`next lint` is removed in Next 16 and `next build` no longer lints.** Wire ESLint CLI with **flat config** (`eslint.config.mjs`) or Biome as an explicit CI step — otherwise linting silently never runs
- Conventional commits; branch protection on `main`
- Push to P-10

✅ **Done when:** clean `git status`, and CI runs lint + typecheck as separate steps on PR.

### Step 1.3 — Secrets wiring
Local `.dev.vars` (gitignored) mirrors §2.5. Production:
```bash
wrangler secret put POLYMARKET_BUILDER_SECRET
# repeat for each server-only key
```
Generate binding types with `npm run cf-typegen`, then access via `await getCloudflareContext()` — **never** build-time `process.env` for secrets (§2.5).

✅ **Done when:** a temporary `/api/health` route reads a secret server-side and reports presence (never the value) in both local and deployed environments.

### Step 1.4 — Geoblock gate (FR-6) — build first, not last
This is a launch blocker and shapes every downstream flow. Building it now means every screen is developed against the real gating model.

- `src/lib/geo/`: call `GET https://polymarket.com/api/geoblock` server-side, cache per-IP briefly.
- Model four states: `blocked` / `close-only` / `frontend-restricted` / `allowed`.
- **`src/proxy.ts`** gates `(app)` routes; close-only users reach portfolio and *closing* actions but never an open-position ticket.

⚠️ **Use Edge `middleware.ts` — NOT `proxy.ts`.** *(Corrected during the Milestone 1 build; the earlier plan said the opposite.)*

Next 16 renamed middleware to `proxy` and made it Node-runtime-only. But **`@opennextjs/cloudflare` cannot build Node middleware** — it fails hard with `Node.js middleware is not currently supported` ([opennextjs-cloudflare#962](https://github.com/opennextjs/opennextjs-cloudflare/issues/962)). Since `proxy` cannot be set to Edge, the only form that deploys to Workers today is the deprecated Edge `middleware.ts`:
```ts
// src/middleware.ts
export async function middleware(request: NextRequest) { /* geoblock gate */ }
```
Next prints a deprecation warning on every build — expected, not a defect. Practical cost is low: the gate only does a fetch plus string/Set comparisons, all Edge-compatible. Route handlers still run on Node via OpenNext, so **EIP-712 signing is unaffected**.

Because Edge code cannot import `server-only`, the geo implementation lives in `lib/geo/edge.ts`, with `lib/geo/index.ts` as the `server-only` re-export for server callers.

Revisit when OpenNext ships Node middleware support; the gate then becomes `proxy.ts` unchanged.

✅ **Done when:** all four states render correct UI, verified with a forced override flag in dev.

### Step 1.5 — Authentication (FR-1.1)
Integrate the chosen provider. Email login → embedded EOA → expose a **viem account** for signing. Session in an httpOnly cookie; server routes verify the provider's token before any signing.

⚠️ **Next 16: `cookies()` and `headers()` are async-only.** Synchronous access was removed entirely, so every session read awaits:
```ts
const session = (await cookies()).get("session");
```

✅ **Done when:** a user logs in with email, an EOA address is provisioned and displayed, and the session survives reload.

### Step 1.6 — ⚠️ Signing verification (was risk A-2)
Before building on it, confirm in a **deployed** Worker (not just local):
1. `viem` EIP-712 `signTypedData` produces a valid signature.
2. HMAC-SHA256 L2 signing works (Web Crypto is fine).
3. `@polymarket/client` imports and initializes.

Set `nodejs_compat` in `wrangler.jsonc` if any dependency needs it.

✅ **Done when:** a deployed Worker returns a verifiable EIP-712 signature. **If this fails, stop and escalate** — signing moves to a separate Node host and §2 changes.

### Step 1.7 — Credential leak guard (SEC-1)
CI step that fails the build if a builder secret name appears in `.next` client output:
```bash
! grep -rE "BUILDER_(SECRET|PASSPHRASE|API_KEY)" .next/static
```
Add secret scanning (`gitleaks`).

✅ **Done when:** CI fails on a deliberately planted leak, passes when reverted.

### Step 1.8 — Deposit Wallet provisioning (FR-1.2) ⚠️ **not Gnosis Safe**
In `src/lib/polymarket/relayer.ts`, wrap `@polymarket/builder-relayer-client`:
- Configure with relayer `https://relayer-v2.polymarket.com`, chainId `137`, the user's viem wallet client, and builder auth from P-2/P-3/P-4.
- `deriveDepositWalletAddress()` → show the address before deployment.
- `getDeployed()` → skip if it already exists.
- `deployDepositWallet()` → gasless deploy via Relayer.

> Prefer the client's **Remote Builder Auth** mode (external signing URL + token) if the team later splits signing into its own service — it keeps builder credentials out of the app process entirely.

⚠️ Uses one of 100 daily relay transactions. Budget dev/QA deploys carefully.

✅ **Done when:** a fresh email signup deploys a Deposit Wallet on Polygon mainnet, the user pays no gas, and the address is verifiable on Polygonscan.

### Step 1.9 — CLOB credential derivation (FR-1.3)
L1: sign EIP-712 `ClobAuth` with the user's signer → `POST /auth/derive-api-key` → `{apiKey, secret, passphrase}`. Store **server-side only**, keyed to the user session. L2-sign subsequent private requests with HMAC-SHA256.

✅ **Done when:** a logged-in user's L2 credentials authenticate a private CLOB read.

### Step 1.10 — Deposit flow (FR-1.4)
Display the Deposit Wallet address + QR for USDC on Polygon. Explain the **USDC → pUSD** conversion in plain language ("$1 in, $1 available"). Poll balance until it lands.

✅ **Done when:** a real USDC deposit appears as a pUSD balance in the UI.

### 🎯 Milestone 1 Acceptance
Email login → EOA provisioned → Deposit Wallet deployed gaslessly → CLOB L2 credentials derived → builder credentials absent from client bundle (CI-proven) → **a signed, builder-attributed test order executes on mainnet and appears in `get-builder-trades`** → signing verified in a deployed Worker.

> The test order is deliberately pulled forward from Week 3. Attribution is the entire commercial premise; discovering in Week 3 that it doesn't work would be fatal to the schedule.

---

## 5. Week 2 — Market Discovery
**Aug 10–16 · $150 · Gamma API data engine**

### Step 2.1 — Gamma client
`src/lib/polymarket/gamma.ts` against `https://gamma-api.polymarket.com`. Typed models for events, markets, outcomes. Cursor pagination. Timeouts + retry with exponential backoff on 429/5xx.

✅ **Done when:** typed fetches for active events and a single market by slug, with tests against recorded fixtures.

### Step 2.2 — Caching (FR-2.5, NFR-5) — Next 16 Cache Components
Proxy Gamma through `/api/markets` — **never call Gamma from the browser** (leaks traffic shape, loses caching, invites rate limits).

With `cacheComponents: true`, **everything is dynamic by default** and caching is explicit. Opt in per function with `use cache`:

```ts
import { cacheLife, cacheTag } from "next/cache";   // stable in 16, no unstable_ prefix

async function getMarketList(category: string) {
  "use cache";
  cacheLife("minutes");            // market lists
  cacheTag(`markets:${category}`);
  return gamma.listMarkets(category);
}
```

| Data | Policy |
|---|---|
| Market lists | `use cache`, ~30–60 s |
| Market metadata (question, resolution, end date) | `use cache`, ~5 min |
| **Prices, order book, positions** | **Never cached** — WSS is the source of truth |

⚠️ **`revalidateTag` now requires a `cacheLife` argument:** `revalidateTag('markets:sports', 'max')`. The single-argument form is a TypeScript error in 16. Use `updateTag()` in Server Actions when the user must immediately see their own write (read-your-writes), and `refresh()` to refresh the client router after an action.

Add R2 incremental cache in `open-next.config.ts`:
```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache });
```

> **Getting this wrong is a correctness bug, not a slowness bug.** A cached price renders a market at odds the user cannot actually trade at. Default to *not* caching anything price-derived and let the WebSocket own it.

✅ **Done when:** repeat market-list loads hit cache (verify via header), no price-derived value is ever served from cache, and a 100-concurrent-request burst triggers no sustained 429s.

### Step 2.3 — Discovery UI (FR-2.1–2.4)
Market grid/list with implied probability from best bid/ask, volume, liquidity, end date. Category filters, sort, search. Skeleton loaders. Server Components for the initial paint; client hydration only for interactivity.

✅ **Done when:** browsing, filtering, and searching work on mobile (375 px) and desktop, FCP < 2 s (NFR-2).

### Step 2.4 — Market detail page
Route `market/[slug]`. Question, resolution criteria, end date, outcomes with prices, volume/liquidity, price history chart. Order ticket is a disabled placeholder this week.

⚠️ **Next 16: `params` and `searchParams` are Promises.** Run `npx next typegen` to generate the `PageProps` / `LayoutProps` / `RouteContext` helpers, then:
```ts
export default async function Page(props: PageProps<'/market/[slug]'>) {
  const { slug } = await props.params;
  const query   = await props.searchParams;
}
```

✅ **Done when:** detail page renders any live market correctly, including multi-outcome markets.

### Step 2.5 — Error and empty states
Market resolved/closed, no results, Gamma unreachable, geoblocked. Every one designed, not a raw error.

✅ **Done when:** each state is reachable in dev and renders deliberately.

### 🎯 Milestone 2 Acceptance
Markets list, filter, search, and detail-render from Gamma with correct implied probabilities; edge caching verified under load; responsive; no client-side Gamma calls.

---

## 6. Week 3 — CLOB Trading Engine
**Aug 17–23 · $150 · Orders, WebSockets, signing**

### Step 3.1 — Market WebSocket (FR-3.4)
`use-orderbook.ts` → `wss://ws-subscriptions-clob.polymarket.com/ws/market`. Subscribe per token ID. Handle book snapshots + deltas. **Reconnect with exponential backoff and full state resync on reopen** (NFR-6) — a stale book after a silent disconnect is how users get filled at prices they didn't expect.

✅ **Done when:** book updates stream < 500 ms p95, survive a forced network drop, and resync correctly.

### Step 3.2 — Order book UI
Bids/asks with depth, spread, last trade. Click-to-fill price into the ticket.

✅ **Done when:** the rendered book matches polymarket.com for the same market, side by side.

### Step 3.3 — Fee + balance engine (FR-3.6, C-5)
`src/lib/polymarket/fees.ts`:
```
builderFee = notional × bps ÷ 10_000
required   = notional + platformFees + builderFee
```
Block submission unless pUSD balance ≥ `required`. Show the full breakdown in the ticket before confirm — the user pays our builder fee **on top of** Polymarket's, and hiding that is both a trust problem and a support burden.

✅ **Done when:** unit tests cover rounding at 1 bps granularity; an underfunded order is blocked client- and server-side.

### Step 3.4 — Order signing service (FR-3.5, SEC-2) 🔒 **security-critical**
`POST /api/orders` — server-only:
1. Verify session + geoblock tier (reject `blocked` and `close-only` opens).
2. Rebuild the order server-side from token ID, side, size, price — **never trust a client-supplied order object**.
3. Re-run the balance/fee check.
4. Attach the **`bytes32` builder code** (P-1) into the signed V2 order struct.
5. Sign and submit via `@polymarket/client`.
6. Rate-limit per user and globally (SEC-3) — these routes spend our builder quota.

✅ **Done when:** orders place successfully, every fill shows the builder code in its on-chain `OrderFilled` event, and a tampered client payload is rejected.

### Step 3.5 — Market orders (FR-3.2)
`placeMarketOrder({ tokenId, side, amount })` with `OrderSide.BUY/SELL`. Slippage estimate from live book depth + confirmation step (FR-3.7).

✅ **Done when:** a market buy and sell each fill on mainnet and appear in positions.

### Step 3.6 — Limit orders (FR-3.3)
Price + size + expiry (GTC/GTD). Open-orders panel with cancel (`DELETE /api/orders`). Surface Liquidity Rewards eligibility where applicable (FR-5.1).

✅ **Done when:** a limit order rests in the book, is visible on polymarket.com, and cancels cleanly.

### Step 3.7 — User WebSocket (FR-4.5)
`use-user-channel.ts` → `.../ws/user`, L2-authenticated. Live fills, order status, balance changes. Toast on fill.

✅ **Done when:** a fill updates the UI with no manual refresh.

### Step 3.8 — 🔴 Submit Verified tier application
Email `builder@polymarket.com` with P-2, the use case, expected volume, and the live demo URL (P-8). **Do this at the start of Week 3, not the end** — approval takes several business days, is outside our control, and gates launch.

✅ **Done when:** application submitted and acknowledged; tracked to resolution.

### 🎯 Milestone 3 Acceptance
Market and limit orders place, fill, and cancel on mainnet; book streams live within NFR-1; every order carries the builder code; fee math correct and disclosed; Verified application submitted.

---

## 7. Week 4 — Portfolio, Withdrawals & Launch
**Aug 24–30 · $100 · Dashboard, testing, production**

### Step 4.1 — Data API client
`src/lib/polymarket/data.ts` against `https://data-api.polymarket.com` — positions, holdings, activity, PnL. Proxy and cache like Gamma.

✅ **Done when:** typed positions and history for a real wallet.

### Step 4.2 — Portfolio dashboard (FR-4.1–4.4)
pUSD balance (labeled to explain the USDC relationship), open positions with size / avg entry / current mark, **realized and unrealized PnL**, trade history. Live updates from the user channel.

✅ **Done when:** every figure reconciles against on-chain truth and polymarket.com for the same wallet.

### Step 4.3 — Rewards display (FR-5.2, FR-5.3)
Read `/get-account-rewards`. Show Holding Rewards (4% APY, accrued daily) and liquidity rewards earned. Label the rate as subject to change.

✅ **Done when:** accrued rewards match the Polymarket UI.

### Step 4.4 — Withdrawals (FR-4.6) ⚠️ **not in the client SRS — do not skip**
pUSD → USDC → external Polygon address, via Relayer. Address validation, confirmation step, pending/complete states.

✅ **Done when:** a real withdrawal completes end-to-end and funds arrive at an external wallet.

### Step 4.5 — Testing
- **Unit:** fee math, implied probability, geoblock tier logic, order construction
- **Integration:** Gamma/CLOB/Data clients against fixtures
- **E2E (Playwright):** signup → deposit → browse → trade → portfolio → withdraw
- **Manual mainnet pass:** small real-money run of every flow
- **Security:** confirm no secrets in the bundle; test tampered order payloads; verify rate limits

✅ **Done when:** CI green, E2E passing, manual mainnet checklist signed off.

### Step 4.6 — Production hardening
Custom domain (P-8) with DNS + TLS. Strict CSP, security headers, no third-party scripts on trading routes (SEC-6). Error tracking (P-12) with PII and key redaction. Structured logs — **never log keys or signatures** (SEC-4). Uptime monitor on `/api/health`.

✅ **Done when:** security headers score clean and errors report without leaking sensitive data.

### Step 4.7 — Launch
Deploy to production. Verify Verified-tier status (Step 3.8) — ⚠️ **if still Unverified, the 100 tx/day cap makes public launch untenable.** Options: soft-launch to a waitlist, or hold public launch until approval. Escalate to the client as a go/no-go.

✅ **Done when:** platform live on the client domain with a documented tier status and launch decision.

### Step 4.8 — Handover
Runbook: deploys, secret rotation, tier upgrades, incident response. Architecture notes. Update [CLAUDE.md](CLAUDE.md) to reflect built reality. Confirm maintenance scope, including the existing site (OI-8).

✅ **Done when:** the client can deploy and rotate secrets unaided.

### 🎯 Milestone 4 Acceptance
Portfolio accurate against on-chain truth; withdrawals working; geoblocking enforced; E2E green; production live on the client domain.

---

## 8. Phase 2 — Not Funded by This Engagement

🔴 **FR-7 (Predict AI) and FR-8 (Copy Trading) appear in no milestone in §4–7 and are not covered by the $550.** Outlined here so the Phase 1 build doesn't foreclose them — not scheduled.

### 8.1 Predict AI — Predict Sport (FR-7)
Sports category filter over Gamma; ingest `wss://sports-api.polymarket.com/ws` for live game state; generate insight per market on a cadence (not per page view — inference cost scales with traffic otherwise); cache aggressively in KV; label all output as non-advice (FR-7.4).

**Unspecified and not estimable as written:** model/provider, data sources, generation cadence, and who absorbs inference cost.

### 8.2 Copy Trading (FR-8) — ⚠️ blocked on OI-5
**Do not start until the custody question is answered.** Auto-executing on a user's behalf requires either server-held delegated signing authority or a session-key scheme. Both weaken the non-custodial guarantee in [srs.md §6.1](srs.md) and shift the platform's regulatory posture from "interface" toward "discretionary trading service." That is a legal determination, not an engineering one.

Also unresolved:
- **Host** (OI-3) — cannot run on Workers; a persistent daemon needs Durable Objects + Cron or a separate host.
- **Relay quota** — mirroring one whale trade across *N* subscribers is *N* relay transactions. Even the Verified 10,000/day tier constrains this.
- **Risk engine** — slippage caps, position sizing, fee-aware balance checks, global kill switch (FR-8.5), full audit log (FR-8.6).

---

## 9. Cross-Cutting Standards

**Security (every step)**
- Secrets server-side only; no `NEXT_PUBLIC_` for anything sensitive
- All signing server-side; never trust a client-supplied order
- Rate-limit signing routes — they spend builder quota
- No keys or signatures in logs, traces, or analytics

**Rate limits.** Unverified = **100 relay tx/day, shared across dev, QA, and demos.** Budget deliberately: prefer `getDeployed()` before deploying, reuse test wallets, and avoid burning deploys on throwaway accounts.

**Verify, don't remember.** Polymarket shipped breaking changes in April–May 2026. Before relying on any API detail, check `docs.polymarket.com` (index: `docs.polymarket.com/llms.txt`) and record the date in [CLAUDE.md](CLAUDE.md).

**Definition of done (every step):** typechecks, lint clean, tests pass, no secret leaked to the client bundle, works on mobile, error and loading states handled, CLAUDE.md updated if context changed.

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Verified tier not approved by Week 4 | **High** | **Critical** — blocks public launch | Apply start of Week 3 (3.8); soft-launch fallback |
| 100 tx/day exhausted during development | High | Medium | Reuse test wallets; `getDeployed()` guard; budget deploys |
| Wallet provider incompatible with Workers | Low | High | Verified in Step 0.3 before Week 1 |
| Polymarket ships another breaking change mid-build | Medium | Medium | Version-pin SDKs; re-verify docs each milestone |
| Target market is close-only (OI-1) | **Unknown** | **Critical** — invalidates business case | Resolve before Week 1 |
| Signing fails on Workers | Low (OpenNext Node runtime) | High | Step 1.6 gate; fallback to separate Node host |
| Worker bundle exceeds the 10 MiB paid limit | Low | High — blocks deploy | Watch bundle size from Week 1; keep server deps lean; Workers Paid plan (P-7) |
| Cached price served in the trading UI | Medium | High — user trades on stale odds | `cacheComponents` is dynamic-by-default; never `use cache` anything price-derived (Step 2.2) |
| Lint silently stops running | Medium | Low | `next build` no longer lints in 16 — ESLint is a separate CI step (Step 1.2) |
| Phase 2 assumed in scope | High | High | Stated explicitly in §8 and [srs.md §8.1](srs.md) |

---

## 11. Change Log

| Date | Change |
|---|---|
| 2026-08-02 | Initial plan. Corrected deployment target from Cloudflare Pages → Workers + OpenNext (§2.1); added client prerequisites (§1); pulled the builder-attribution test order forward into Milestone 1 |
| 2026-08-02 | **Target set to Next.js 16** (§2.2). Next.js 14 is past OpenNext's Q1 2026 EOL. Updated: geoblock gate `middleware.ts` → `proxy.ts` (Node runtime, Step 1.4); async `cookies`/`params`/`searchParams` (Steps 1.5, 2.4); caching rewritten for Cache Components + `use cache` (Step 2.2); ESLint CLI now a separate CI step (Step 1.2); scaffold config for Turbopack/`images.remotePatterns` (Step 1.1); Workers **Paid** plan added to P-7 |
| 2026-08-02 | **Milestone 1 build.** ⚠️ **Step 1.4 reversed: the gate is Edge `middleware.ts`, not `proxy.ts`** — OpenNext cannot build Next 16 Node middleware ([#962](https://github.com/opennextjs/opennextjs-cloudflare/issues/962)); the previous entry's guidance was wrong for our deployment target. OI-4 resolved to Privy. `builder-relayer-client` dropped as redundant. Workers **Paid** confirmed empirically (2.90 MiB gzipped with no UI yet vs a 3 MiB free cap) |
