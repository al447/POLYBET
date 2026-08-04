# CLAUDE.md

Working context for the Polymarket Integration Platform. **Keep this file current** — see [Maintenance Protocol](#maintenance-protocol) at the bottom.

> **Last updated:** 2026-08-04 · **Phase:** Milestone 1 in progress · **Repo:** initialized, 2 commits

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
  provision-builder.mjs    P-1..P-5 provisioning + handover
  smoke-builder.mjs        Milestone 1 acceptance, run when P-1..P-5 land
```

**Commands:** `npm run dev` · `lint` · `typecheck` · `test` · `build` · `check:secrets` · `preview` · `deploy` · `smoke:builder` · `builder:provision`

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

**Signing on Workers — largely de-risked, still gated.** OpenNext gives the full Node.js runtime, so EIP-712 (`viem`) + HMAC-SHA256 should work normally. Still verify in a *deployed* Worker before building on it ([implementation.md](implementation.md) Step 1.6). Set `nodejs_compat` if a dependency needs it.

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

**npm only — never yarn.** All three Polymarket packages (`@polymarket/client`, `bindings`, `types`) declare `engines.node >= 24`. npm prints an `EBADENGINE` warning and installs; **yarn v1 hard-fails** with `Found incompatible module` and installs nothing. The requirement is advisory here — the published `dist/` has zero `node:` imports, and everything builds and tests clean on Node 22.22.3. Yarn also can't express the `--legacy-peer-deps` workaround below. If you want the warning gone, move to Node 24 LTS; don't switch package managers.

**Privy peer conflict — install with `--legacy-peer-deps`.** Privy's optional `permissionless` peer wants `ox@^0.8`; the Polymarket viem stack pulls `ox@0.14`. We don't use `permissionless` (Polymarket has its own Relayer, no ERC-4337), so the mismatch is inert. CI does the same.

**…which then breaks Privy itself: `@stripe/stripe-js` must be installed by hand.** `--legacy-peer-deps` also stops npm auto-installing *legitimate* peers. `@privy-io/react-auth` → `@stripe/crypto` → peer `@stripe/stripe-js@^1.46.0`, required, not optional. Missing it fails the build with `Module not found: Can't resolve '@stripe/stripe-js'` traced through `FiatOnrampScreen`, on **every** page — the fiat onramp is statically imported, so it breaks even though we never render it and even in mock mode where `<PrivyProvider>` is skipped entirely. It is a pinned direct dependency for this reason; don't "clean up" the unused-looking package.

**Cache Components forbids the clock before request data — `serverEnv()` calls `await connection()` first.** `getCloudflareContext()` reads the clock internally, so any Server Component touching it dies at build with ``Route "/" used `new Date()` before accessing ... Request data``. **A `<Suspense>` boundary does not satisfy this** — different rule from the uncached-data one below, same symptom of a failing build. `connection()` marks the scope dynamic, which is correct anyway: nothing that reads secrets may ever prerender.

**🚩 `NEXT_PUBLIC_PRIVY_APP_ID` must be a BUILD-time variable — `.dev.vars` does not work.** Verified empirically 2026-08-04 with sentinel values: Next inlines `NEXT_PUBLIC_*` into the bundle at build, reading only real env vars and `.env*` files. **Neither `.dev.vars` nor `wrangler.jsonc` `vars` reach it** — both are request-time. Put it in `.env.local` locally and in a CI build-step env var for deploys; `wrangler secret put` is always too late, the bundle is already built. The failure is silent and total: the app id inlines as `""`, `isAuthConfigured` is false, `<PrivyProvider>` never mounts, and login is simply absent with no error. Contrast `PRIVY_APP_SECRET`, which is server-side and *does* belong in `.dev.vars`.

**A wrong Privy app id fails the build, not the request.** With a non-empty but invalid id, prerender dies with `Error: Cannot initialize the Privy provider with an invalid Privy app ID` on `/_not-found`. Fail-fast, but it means a typo presents as a build error far from its cause.

**Privy issues two tokens, and identity tokens are OFF by default.** `privy-token` (access, authenticates, 1h) and `privy-id-token` (identity, carries linked accounts, 10h). The embedded wallet address/id come from the **identity** token — verifying only the access token gets you a user with no wallet, so `verifySession` returns null and every authenticated route 401s.

Enable at **User management → Authentication → Advanced → "Return user data in an identity token"** (verified against docs.privy.io 2026-08-04). Until it is on, the symptom is a *client* session that looks fine — email and signer address render — while every server route reports `unauthorized`. `/api/auth/me` distinguishes this case explicitly as `missing_identity_token` rather than a bare 401.

**Bundle is at 2.90 MiB gzipped with almost no UI.** The 3 MiB free-tier cap will be exceeded as soon as real screens land. Workers **Paid** is not optional (P-7). Watch this number.

**Fonts are self-hosted — never reintroduce `next/font/google`.** It resolves over the network during `next build`, so every build, CI run and deploy depends on `fonts.googleapis.com`. That failed a build here on 2026-08-04 (`Failed to fetch Geist from Google Fonts`) on a transient blip, with nothing wrong in the code. The latin-subset variable woff2 files live in `src/app/fonts/` and are loaded with `next/font/local`; Geist is SIL OFL so redistribution is fine. Builds are now reproducible and offline-capable. Use `weight: "100 900"` — a single value collapses a variable font to one weight.

**`tsc` caches aggressively.** After changing `tsconfig.json`, delete `*.tsbuildinfo` or you will debug errors that no longer exist.

**`/api/geoblock` returns `country`/`region`, NOT `countryCode`/`regionCode`.** Live shape, verified 2026-08-04: `{"blocked":false,"ip":"…","country":"BD","region":"C"}`. Reading the `*Code` spelling yields `undefined`, falls through to `cf-ipcountry` (absent off Cloudflare), and lands on the fail-closed branch — so **unrestricted users get told they are close-only**. That failure mode looks like correct conservative behaviour from the outside, which is exactly why it went unnoticed. `lib/geo/edge.ts` now accepts both spellings, and `edge.test.ts` pins the live shape. The endpoint is undocumented with no stability guarantee — re-verify it each milestone.

**Geoblocking is absent from the client SRS.** Three tiers, all must be enforced:
- **Blocked** (no trading at all): Iran, Syria, Cuba, North Korea, Crimea/Donetsk/Luhansk
- **Close-only** (exit positions only, no new orders): 30+ jurisdictions — US, UK, France, Germany, Singapore, Australia, Brazil, Russia, Taiwan, and BC/Ontario/Alberta/Quebec
- **Frontend-restricted**: Ireland, Japan, Netherlands, Malta (sports only)

Polymarket rejects blocked orders server-side regardless; our check exists so users get real feedback instead of opaque failures.

**Withdrawals were never in the client SRS.** Added as FR-4.6. Deposit-only is not shippable.

**🚩 Server-side signing needs BOTH user delegation AND a Privy authorization key — neither exists yet.** Hit 2026-08-04. With auth working and builder credentials wired, `/api/wallet/status` still fails:

> `401 {"error":"No valid authorization keys or user signing keys available"}`

That message names the two missing things exactly. Verified against docs.privy.io:
1. **User delegation** — a user's embedded wallet cannot be signed with server-side until *the user explicitly delegates it*, client-side via `useHeadlessDelegatedActions().delegateWallet({address, chainType})`. We never call it.
2. **Authorization key** — created in the Privy dashboard; it "produces authorization signatures when submitting requests" and is passed server-side as the `authorizationContext` on `signerFrom({privy, walletId, authorizationContext})`. We pass `undefined`.

Diagnosis note: a local `privateKey()` signer succeeds on the identical code path (`isWalletDeployed: true`, balance reads fine), so this is **not** a builder-credential or SDK-wiring problem. Only the Privy remote-signer path fails.

**✅ RESOLVED 2026-08-04 — client-side signing chosen.** The user's browser signs with their own Privy wallet; we never request delegation and never hold signing authority. Builder authorization is fetched per request from **`/api/builder/sign`** using the SDK's `remoteBuilderSigning({ url })`, so the builder **secret stays server-side** while the client runs in the browser. **Verified working end-to-end 2026-08-04**: user signs in-browser → `/api/builder/sign` supplies builder auth → Relayer deploys the Deposit Wallet → balance reads. The panel makes no server wallet calls at all; the QR is rendered client-side.

Gotcha inside this: the viem wallet client **must** be built with `account` set. `signerFrom` asserts `invariant(client.account !== undefined, "Wallet client with account is required")`, but viem allows an account-less client for read paths — so omitting it compiles and only fails at signing.

**Orders migrated 2026-08-04.** Signing lives in `browser-client.ts` (`placeMarketBuy` / `placeMarketSell`, builder code inside the signed struct). **`/api/orders` no longer places orders** — it is now pre-trade authorization: auth, geo gate, input validation, fee disclosure. Call it before signing.

**SEC-2 is narrowed, not abandoned.** Its purpose was stopping a caller dictating price/size/counterparty *on someone else's behalf*. Client-side signing removes that attack by construction — an order is only valid if the user's own key signed it, so a tampered page can only harm the user operating it. The geo gate is likewise advisory now (a user can submit to Polymarket directly), which is fine because it never was the only control: **Polymarket enforces jurisdiction upstream regardless**; ours exists to give real feedback instead of an opaque rejection.

**Dead code awaiting removal:** `/api/wallet/{status,deploy,qr}` and all of `lib/polymarket/clob.ts`. Nothing in the UI calls them and they fail on the abandoned server-signer path. They are inert (auth-gated, then error), not a hole — but delete them rather than let someone wire them back up.

Two consequences to keep straight:
- **SEC-2 is narrowed, not deleted.** Orders are no longer rebuilt server-side. What protects us is that `builderCode` is inside the *signed* order struct — a tampered order is attributed elsewhere, not a way to move someone else's funds. Nothing the browser constructs can spend funds the user's own signer did not authorise.
- **Accepted residual exposure**: the SDK's remote-signing contract returns `POLY_BUILDER_API_KEY` and `POLY_BUILDER_PASSPHRASE` to the client so it can set headers. Any signed-in user can read them. They cannot forge requests without the secret, but they do identify our builder account. The route is authentication-gated; rotate P-2…P-4 via `builder:provision -- derive-keys` if abused.

**Historical context — why this was forced.** The architecture signs every order server-side (SEC rule), which means *every user must delegate their wallet*, not just copy-trade users. Delegation is revocable and Privy still splits key custody, so it is not custody in the strict sense — but the server gains the ability to sign without per-action user approval, which is the same property that makes copy trading a legal question. It also sits awkwardly with the homepage copy *"Your wallet, your keys — deposits and positions stay under your own signer."* The alternative is client-side order signing, which avoids delegation entirely but conflicts with SEC-2 (orders rebuilt server-side, never accepted from the client). **Pick deliberately; do not let this get decided by whoever implements the next route.**

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
