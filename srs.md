# Software Requirements Specification
## Polymarket Integration Platform

| Field | Value |
|---|---|
| **Project** | Polymarket Integration Platform (white-label CLOB frontend) |
| **Platform** | Next.js 16 (App Router) — see C-7 |
| **Hosting** | Cloudflare Workers (OpenNext) — see C-6 |
| **Chain** | Polygon Mainnet |
| **Document version** | 1.3 (analyzed & fact-checked) |
| **Last updated** | 2026-08-02 |
| **Source** | Client SRS v1.0 + `Polymarket_Cost_Analysis.pdf` |
| **Status** | ⚠️ Not approved — 6 blocking open issues (see §9) |

---

## 1. Introduction

### 1.1 Purpose
Define the architecture, features, and technical requirements for a custom prediction market platform acting as a third-party frontend that routes user orders through the Polymarket Central Limit Order Book (CLOB) under the Polymarket Builder Program.

### 1.2 Scope
A fully white-labeled Polymarket trading experience on the client's domain. Users log in with email, fund an account, browse markets, and trade. Phase 2 adds AI-driven sports insights and a copy-trading module.

### 1.3 Definitions

| Term | Meaning |
|---|---|
| **CLOB** | Central Limit Order Book — Polymarket's off-chain matching engine, on-chain settlement |
| **Gamma API** | Read-only market discovery/metadata API |
| **Data API** | Positions, holdings, PnL, activity |
| **Relayer** | Polymarket service that submits gasless transactions on a user's behalf |
| **Builder code** | `bytes32` identifier embedded in a signed order for attribution + fee accrual |
| **pUSD** | Polymarket USD — ERC-20 on Polygon, 1:1 USDC-backed; the actual collateral token |
| **Deposit Wallet** | Current standard smart wallet (ERC-1967 beacon proxy) |
| **CTF** | Conditional Token Framework — ERC-1155 outcome tokens |

---

## 2. Verified Platform Facts

All values below were verified against `docs.polymarket.com` on **2026-08-02**. Re-verify before Milestone 1 sign-off — Polymarket shipped breaking infrastructure changes in April–May 2026.

### 2.1 Endpoints

| Service | URL |
|---|---|
| Gamma API | `https://gamma-api.polymarket.com` |
| CLOB API | `https://clob.polymarket.com` |
| Data API | `https://data-api.polymarket.com` |
| Relayer API | `https://relayer-v2.polymarket.com` |
| CLOB market channel | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| CLOB user channel | `wss://ws-subscriptions-clob.polymarket.com/ws/user` |
| Real-time data service | `wss://ws-live-data.polymarket.com` |
| Sports websocket | `wss://sports-api.polymarket.com/ws` |
| Geoblock check | `GET https://polymarket.com/api/geoblock` |

### 2.2 Corrections to the Original SRS

The source SRS is accurate on Builder tier limits and the 4% holding-rewards APY. The following points are **outdated** and are superseded by this document:

| # | Original SRS says | Current reality | Impact |
|---|---|---|---|
| C-1 | "deploys a Gnosis Safe proxy wallet" | **Safe wallets are legacy.** All accounts created on/after 2026-05-04 use a **Deposit Wallet** (ERC-1967 beacon proxy) deployed via factory `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | Rewrites the onboarding flow |
| C-2 | "deposit USDC", "using USDC" | Deposits accept USDC but are **auto-converted to pUSD** on arrival. pUSD is the collateral and fee-settlement token. pUSD replaced bridged USDC.e in the 2026-04-28 exchange upgrade | Balance/PnL displays, fee math |
| C-3 | `@polymarket/clob-client` (implied) | Current recommended SDK is **`@polymarket/client`** (`createSecureClient`) | Dependency choice |
| C-4 | "sign user orders with Builder credentials" | Attribution is a **`bytes32` builder code inside the signed V2 order struct**, surfaced in on-chain `OrderFilled` events and settled via `CTFExchangeV2.matchOrders()` | Order construction |
| C-5 | Silent on collateral fee headroom | Users must hold enough pUSD for **trade + platform fees + builder fees** combined | Pre-trade balance checks |
| C-6 | "Cloudflare Pages" + `@cloudflare/next-on-pages` | **Superseded.** Cloudflare and the Next.js team recommend **Workers + `@opennextjs/cloudflare`** (GA Feb 2026, recommended since Mar 2026). Pages/next-on-pages is Edge-runtime only; OpenNext provides the full **Node.js runtime**. Requires the Workers **Paid** plan (3 MiB gzipped cap on free vs 10 MiB paid) | Deployment target — and it **resolves risk A-2** |
| C-7 | "Next.js 14 (App Router)" | **Target is Next.js 16.** Not a preference — **OpenNext ended Next.js 14 support in Q1 2026**, so 14 is not a deployable Cloudflare target. 16 requires Node ≥20.9, TS ≥5.1, React 19.2, and Turbopack by default | Breaking changes across auth, routing, and caching — see below |

#### C-7 detail — Next.js 16 changes affecting requirements

| Change | Requirement affected |
|---|---|
| `middleware.ts` → **`proxy.ts`** (Node runtime, cannot be Edge) | FR-6.1 geoblock gate |
| `cookies()` / `headers()` / `params` / `searchParams` are **Promise-only** | FR-1.1 sessions, FR-2.4 market routes, all API handlers |
| **Cache Components** — dynamic by default, `use cache` opt-in | FR-2.5 caching. Suits this app: stale prices are a correctness fault, and 16 makes not-caching the default |
| `revalidateTag` requires a `cacheLife` second argument | FR-2.5 |
| `next lint` removed; `next build` no longer lints | NFR quality gates — ESLint becomes an explicit CI step |
| `images.domains` deprecated → `remotePatterns` | FR-2.3 market imagery |
| `serverRuntimeConfig` removed | SEC-1 — secrets read at request time via `getCloudflareContext()` |

### 2.3 Auth Model

- **L1** — wallet signs an EIP-712 `ClobAuth` message → exchanged at `/auth/api-key` or `/auth/derive-api-key` for `{apiKey, secret, passphrase}`.
- **L2** — each private CLOB request signed **HMAC-SHA256** with those credentials.
- Builder credentials are separate from user credentials: the builder signs infrastructure requests; **each Deposit Wallet remains controlled by its own user signer.** The builder manages deployment, never custody.

### 2.4 Builder Fees

| Parameter | Value |
|---|---|
| Taker fee cap | 100 bps (1.00%) |
| Maker fee cap | 50 bps (0.50%) |
| Granularity | 1 bps |
| Formula | `notional × bps ÷ 10_000` |
| Payer | **The end user** |
| Relationship to platform fees | **Stacks on top** — never replaces |
| Settlement | Builders Service indexes `OrderFilled` events, accrues to the builder profile wallet |

> **Product decision required (OI-6):** the fee rate is the platform's entire revenue model and is paid by users on top of Polymarket's own fees. It has not been specified.

### 2.5 Builder Tiers — Confirmed Accurate

| Tier | Relay transactions/day | Approval |
|---|---|---|
| Unverified | **100** | None — self-serve at `polymarket.com/settings` |
| Verified | **10,000** | Manual, email `builder@polymarket.com` |
| Partner | **Unlimited** | Strategic — demonstrated volume required |

---

## 3. System Architecture

### 3.1 Stack

| Layer | Technology |
|---|---|
| Framework | **Next.js 16** (16.2.x), App Router, React 19.2 (see C-7) |
| Styling | Tailwind CSS + shadcn/ui |
| Hosting | **Cloudflare Workers via `@opennextjs/cloudflare`** (see C-6) |
| Server logic | Next.js route handlers on Workers, Node.js runtime |
| Auth / wallets | Embedded wallet provider — Privy, Turnkey, or Magic (**undecided, OI-4**) |
| Chain | Polygon Mainnet |
| Web3 library | `viem` — both Polymarket SDKs are viem-based; do not add `ethers` |
| Copy-trade worker | Node.js — **cannot run on Workers, see §3.3** |

### 3.2 Component Responsibilities

```
┌─────────────────────────────────────────────────────┐
│  Browser — Next.js 16 App Router (Workers/OpenNext) │
│  • market browsing   • order ticket   • portfolio   │
└───────────────┬─────────────────────────────────────┘
                │  never sees builder credentials
┌───────────────▼─────────────────────────────────────┐
│  Cloudflare Workers — server-side API routes        │
│  • builder-code order signing  • geoblock gate      │
│  • Gamma/Data proxy + cache    • rate limiting      │
└───────────────┬─────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────┐
│  Polymarket: Gamma · CLOB · Data · Relayer · WSS    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Copy-trade daemon — SEPARATE HOST (not CF Pages)   │
│  • whale watcher   • risk engine   • executor       │
└─────────────────────────────────────────────────────┘
```

### 3.3 Known Architectural Conflicts

**A-1 — The copy-trading daemon cannot run on Cloudflare Workers.**
§4.2 of the source SRS requires "a Node.js daemon running in parallel to the Next.js frontend." Cloudflare Workers are request-scoped and cannot hold a long-lived WebSocket subscription or run an unbounded loop. Options:

| Option | Notes |
|---|---|
| Durable Objects + Cron Triggers | Stays on Cloudflare; DO hibernation supports long-lived WS; requires Workers Paid plan |
| Separate host (Railway / Fly.io / VPS) | Simplest for a true daemon; adds a second deploy target and monthly cost |
| Polling via Cron Trigger only | Cheapest; adds latency, likely unacceptable for copy trading |

**Recommendation:** separate host. Decision required (OI-3).

**A-2 — Workers runtime compatibility. ✅ Largely resolved by C-6.** Adopting OpenNext gives the full Node.js runtime on Workers, so EIP-712 signing (`viem`) and HMAC-SHA256 should work normally rather than fighting Edge-runtime restrictions. Downgraded from a go/no-go risk to a verification step: confirm in a **deployed** Worker before building on it (implementation.md Step 1.6), and set `nodejs_compat` if a dependency requires it. Fallback if it still fails: move signing to the separate Node host from A-1.

---

## 4. Functional Requirements

### 4.1 Phase 1 — Core

#### FR-1 Onboarding
| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | Email login provisioning an embedded EOA via the chosen wallet provider | Must |
| FR-1.2 | Deploy a **Deposit Wallet** through the Relayer factory `0x0000…Cc07` (not a Gnosis Safe — see C-1) | Must |
| FR-1.3 | Derive CLOB L2 credentials via EIP-712 `ClobAuth` → `/auth/derive-api-key` | Must |
| FR-1.4 | Deposit flow: USDC on Polygon → auto-converted to pUSD | Must |
| FR-1.5 | Gasless operation — all wallet ops via Relayer, no user-held POL | Must |
| FR-1.6 | **Geoblock check before any trading UI is enabled** (see FR-6.1) | Must |

#### FR-2 Market Discovery
| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | List active events/markets from Gamma API with pagination | Must |
| FR-2.2 | Filter by category, volume, liquidity, end date | Must |
| FR-2.3 | Display live implied probability from best bid/ask | Must |
| FR-2.4 | Search across market titles and metadata | Should |
| FR-2.5 | Edge-cache Gamma responses in Workers to stay within rate limits | Must |

#### FR-3 Trading
| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Buy/Sell Yes & No outcome tokens | Must |
| FR-3.2 | Market orders (FOK/FAK) | Must |
| FR-3.3 | Limit orders (GTC/GTD) with open-order management + cancel | Must |
| FR-3.4 | Live order book + last trade via `wss://ws-subscriptions-clob…/ws/market` | Must |
| FR-3.5 | Server-side order signing with builder code — **credentials never reach the client** | Must |
| FR-3.6 | Pre-trade balance check covering notional **+ platform fees + builder fees** (C-5) | Must |
| FR-3.7 | Slippage estimate and confirmation before submit | Should |

#### FR-4 Portfolio
| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | pUSD balance (labeled clearly given the USDC→pUSD conversion) | Must |
| FR-4.2 | Open positions with size, avg entry, current mark | Must |
| FR-4.3 | Realized + unrealized PnL from Data API | Must |
| FR-4.4 | Trade history | Must |
| FR-4.5 | Live position updates via user channel WSS | Should |
| FR-4.6 | Withdrawal flow (pUSD → USDC → external address) | Must |

> **Gap:** the source SRS never specified withdrawals. FR-4.6 is added — a platform users can deposit into but not withdraw from is not shippable.

#### FR-5 Rewards
| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | Surface Liquidity Rewards eligibility on qualifying limit orders | Should |
| FR-5.2 | Display Holding Rewards (4% APY, accrued daily, rate subject to change) | Should |
| FR-5.3 | Read accrued rewards via `/get-account-rewards` | Should |

#### FR-6 Compliance — **added, absent from source SRS**
| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | Call `GET polymarket.com/api/geoblock` on session start; gate trading UI on the result | Must |
| FR-6.2 | Enforce three tiers: **blocked** (OFAC — Iran, Syria, Cuba, North Korea, Crimea/Donetsk/Luhansk), **close-only** (30+ jurisdictions incl. US, UK, France, Germany, Singapore, Australia, Brazil, Russia, Taiwan; BC/Ontario/Alberta/Quebec), **frontend-restricted** (Ireland, Japan, Netherlands, Malta — sports only) | Must |
| FR-6.3 | Close-only users may exit positions but not open new ones | Must |
| FR-6.4 | Terms of Service + risk disclosure at signup | Must |

> ⚠️ **Commercial risk (OI-1):** the close-only list covers the US, UK, and most of Western Europe. Client must confirm the target market is actually reachable before build starts.

### 4.2 Phase 2 — Advanced

> **These are in no milestone in §8 and are unfunded.** See OI-2.

#### FR-7 Predict AI — Predict Sport
| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | Sports-filtered market category | Must |
| FR-7.2 | AI-generated insight/sentiment alongside odds | Must |
| FR-7.3 | Consume `wss://sports-api.polymarket.com/ws` for live sports state | Should |
| FR-7.4 | Label AI output as non-advice; never present as a guaranteed outcome | Must |

**Unspecified:** model/provider, data sources, generation cadence, caching, per-insight cost, and who pays inference. Not estimable as written.

#### FR-8 Copy Top Traders
| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | Monitor target "whale" wallets via Data API / on-chain events | Must |
| FR-8.2 | Users subscribe to a whale with an allocation cap | Must |
| FR-8.3 | Mirror trades proportionally with position sizing | Must |
| FR-8.4 | Risk controls: slippage limits, max position, fee-aware balance checks | Must |
| FR-8.5 | Kill switch — instant unsubscribe, per-user and global | Must |
| FR-8.6 | Full audit log of every auto-executed trade | Must |

> 🚨 **FR-8 conflicts with §6.1 non-custodial architecture. See OI-5 — this is the single largest unresolved item in the project.**

---

## 5. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Order book update latency | < 500 ms p95 |
| NFR-2 | Market list first contentful paint | < 2 s |
| NFR-3 | Uptime | 99.5% |
| NFR-4 | Mobile responsive | 375 px and up |
| NFR-5 | Respect Polymarket rate limits with backoff + edge caching | No sustained 429s |
| NFR-6 | Graceful WSS reconnect with state resync | Auto, < 5 s |
| NFR-7 | Accessibility | WCAG 2.1 AA on core flows |

---

## 6. Security & Compliance

### 6.1 Non-Custodial Architecture
The platform holds no user funds. Each user's assets live in their own Deposit Wallet, controlled by their signer. The builder operates deployment infrastructure only.

> **Contradicted by FR-8** — see OI-5.

### 6.2 Credential Security
| ID | Requirement |
|---|---|
| SEC-1 | Builder API key/secret/passphrase live only in Cloudflare env vars — never in client bundles, never in `NEXT_PUBLIC_*` |
| SEC-2 | All order signing server-side in Workers |
| SEC-3 | Rate-limit and authenticate signing routes to prevent builder-quota abuse |
| SEC-4 | No private keys in logs, error traces, or analytics |
| SEC-5 | Secret scanning in CI |
| SEC-6 | Strict CSP; no third-party scripts on trading routes |

### 6.3 Compliance
Geoblocking per FR-6. Orders from blocked regions are rejected server-side by Polymarket regardless; client-side checks exist to give users correct feedback rather than opaque failures.

---

## 7. Builder Program Strategy

**Stage 1 — Unverified (Weeks 1–4).** 100 relay tx/day. Sufficient only for development and internal QA. Verify gasless wallet ops and attribution end-to-end.

**Stage 2 — Verified (submit ~Week 3).** 10,000/day. Apply to `builder@polymarket.com` with the builder API key, use case, expected volume, and a live demo URL. Approval takes several business days.

> ⚠️ **Schedule risk:** the source SRS plans a public launch at Week 4 while still Unverified. **100 tx/day cannot support a public launch** — roughly 100 users making one trade each, and copy trading would exhaust it within minutes. Verified approval is a hard gate on launch, is not self-serve, and its timing is outside the team's control.

---

## 8. Milestones

Fixed-price engagement, **$550 total**, 4 weeks. Payment due on delivery of each milestone. Dates assume a 2026-08-03 start — **confirm (OI-7)**.

| Week | Dates | Deliverables | Price | % |
|---|---|---|---|---|
| 1 | Aug 3–9 | Architecture, Builder setup, Web3 auth, Deposit Wallet provisioning, **Workers-signing spike (A-2)** | $150 | 27.3% |
| 2 | Aug 10–16 | Market discovery UI, Gamma data engine, edge caching | $150 | 27.3% |
| 3 | Aug 17–23 | CLOB trading engine, WebSockets, order signing; **submit Verified application** | $150 | 27.3% |
| 4 | Aug 24–30 | Portfolio dashboard, withdrawals, E2E testing, production launch | $100 | 18.1% |
| | | **Total** | **$550** | **100%** |

**Maintenance:** $125/month, beginning after Week 4 deployment, covering this platform **and the client's existing site**.

> The existing site appears to be `polybet365` (`/Users/sayem/projects/PREDICT-ME`) — a separate prediction-market codebase with its own contracts, backend, and frontend. **Its maintenance scope is undefined (OI-8).**

### 8.1 Scope Assessment
Phase 2 (FR-7, FR-8) appears in **none** of the four milestones. As written, the $550/4-week schedule buys Phase 1 only. Phase 2 — AI insight generation plus a copy-trading daemon with a risk engine and delegated execution — is unscoped, unpriced, and unscheduled, and is the larger engineering effort of the two phases. It needs its own SRS, quote, and timeline.

---

## 9. Open Issues — Blocking

| ID | Issue | Why it blocks | Owner |
|---|---|---|---|
| **OI-1** | Target market vs. close-only geoblocking | US/UK/EU are close-only. If that's the intended market, the product cannot legally take new orders there. Changes the business case, not just the code | Client |
| **OI-2** | Phase 2 unscoped and unfunded | FR-7 and FR-8 are in no milestone. Build to §8 as written and they don't get built | Client |
| **OI-3** | Copy-trade daemon host | Cannot run on Cloudflare Workers (A-1). Needs a host, a budget line, and a deploy target | Both |
| **OI-4** | Wallet provider undecided | Privy / Turnkey / Magic have different SDKs, pricing, and Workers compatibility. Blocks Week 1 | Both |
| **OI-5** | **Copy trading vs. non-custodial** | Auto-executing on a user's behalf requires either server-held delegated signing authority or a session-key scheme. Either weakens §6.1 and changes the platform's regulatory posture from "interface" toward "discretionary trading service." **Unresolvable in code — needs a product and legal decision** | Client + legal |
| **OI-6** | Builder fee rate unset | The revenue model. Capped at 100 bps taker / 50 bps maker, paid by users on top of platform fees | Client |
| **OI-7** | Project start date unconfirmed | All §8 dates derive from it | Client |
| **OI-8** | Existing-site maintenance scope | $125/mo covers "the existing site" with no defined SLA, scope, or hour cap | Client |

---

## 10. Acceptance Criteria

**Milestone 1** — email login provisions an embedded EOA; a Deposit Wallet deploys via the Relayer; CLOB L2 credentials derive successfully; builder credentials confirmed absent from the client bundle; **a signed, builder-attributed test order executes on Polygon mainnet and appears in `get-builder-trades`**; Workers signing spike resolved (A-2).

**Milestone 2** — markets list and filter from Gamma with correct implied probabilities; edge caching verified under load with no sustained 429s.

**Milestone 3** — market and limit orders place, fill, and cancel; order book streams live within NFR-1; every order carries the builder code; Verified application submitted.

**Milestone 4** — portfolio shows accurate balances, positions, and PnL against on-chain truth; withdrawals complete end-to-end; geoblocking enforced per FR-6; production deploy live on the client domain.

---

## 11. Change Log

| Version | Date | Change |
|---|---|---|
| 1.0 | — | Client-supplied SRS |
| 1.1 | 2026-08-02 | Fact-checked against live docs. Added §2 (verified facts + 5 corrections), FR-4.6 withdrawals, FR-6 compliance, §3.3 architectural conflicts, §9 open issues, §10 acceptance criteria |
| 1.2 | 2026-08-02 | Added C-6 (Cloudflare Pages → Workers + OpenNext); A-2 downgraded to a verification step as a result; stack table updated; `viem` fixed as the Web3 library. Build steps split into [implementation.md](implementation.md) |
| 1.3 | 2026-08-02 | Added C-7 — **target version Next.js 14 → 16** (14 is past OpenNext's Q1 2026 EOL), with the breaking-change impact mapped to affected requirements. Workers Paid plan noted in C-6 |
