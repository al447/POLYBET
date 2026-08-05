# Deployment Runbook

Operational guide for the Polymarket Integration Platform on Cloudflare Workers.

> **Last updated:** 2026-08-05 · **Target:** Cloudflare Workers via `@opennextjs/cloudflare` · **Status:** account authenticated + R2 bucket created; **first deploy rejected — client account is on Workers Free** (§2.1)

**Scope.** [implementation.md](implementation.md) is the one-time build plan; [CLAUDE.md](CLAUDE.md) is working context. **This file is what you open to ship a change, rotate a credential, or work out why production is broken.** If a deploy sends you back to either of the others, that is a gap here — fix it here, while the friction is fresh.

---

## 0. Quick reference

```bash
# Routine deploy (details in §3 — the exports are NOT optional)
export NEXT_PUBLIC_PRIVY_APP_ID="<P-6 app id>"
export NEXT_PUBLIC_POLYMARKET_BUILDER_CODE="<P-1 builder code>"
npm run deploy

# Verify (§5)
curl -s https://<host>/api/health | python3 -m json.tool
curl -s https://<host>/api/spike/signing | python3 -m json.tool

# Roll back (§6)
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

| Thing | Value |
|---|---|
| Worker name | `polymarket-integration-platform` |
| R2 cache bucket | `polymarket-platform-cache` |
| Compat date / flags | `2026-08-01` · `nodejs_compat`, `global_fetch_strictly_public` |
| Bundle (2026-08-04) | **4.79 MiB gzipped** — Workers **Paid** required (free caps at 3 MiB) |
| Health probe | `GET /api/health` |

---

## 1. The one rule that breaks everything

**`NEXT_PUBLIC_*` variables are baked into the JavaScript bundle at BUILD time.**

Next reads only real environment variables and `.env*` files when it inlines them. It does **not** read `.dev.vars`, and it does **not** read `wrangler.jsonc` `vars` — both are resolved at *request* time, long after the bundle exists. `wrangler secret put NEXT_PUBLIC_ANYTHING` is **always too late**.

The failure is silent and total: the app id inlines as `""`, `isAuthConfigured` goes false, `<PrivyProvider>` never mounts, and **login is simply absent with no error in any log**.

| Variable | Set where | Read when |
|---|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | `.env.local` (local) · CI build-step env (deploy) | Build |
| `NEXT_PUBLIC_POLYMARKET_BUILDER_CODE` | `.env.local` (local) · CI build-step env (deploy) | Build |
| `NEXT_PUBLIC_CHAIN_ID` | `wrangler.jsonc` `vars` | Request |
| `BUILDER_FEE_BPS_TAKER` / `_MAKER` | `wrangler.jsonc` `vars` | Request |
| `POLYMARKET_BUILDER_*` (4) | `wrangler secret put` · `.dev.vars` locally | Request |
| `PRIVY_APP_SECRET` | `wrangler secret put` · `.dev.vars` locally | Request |
| `POLYGON_RPC_URL` | `wrangler secret put` · `.dev.vars` locally | Request |

Fee rates are in `wrangler.jsonc` rather than secrets **on purpose**: they are not sensitive, and version-controlling them makes a rate change a reviewable commit instead of an invisible dashboard edit. They must match the rates on the Polymarket builder profile — see §7.2.

---

## 2. First-time account setup

Once per Cloudflare account. Skip to §3 for routine deploys.

### 2.1 Authenticate

Prefer a scoped API token over `wrangler login` — it is the same mechanism CI uses, so this validates the real path:

Credentials live in **`.env.cloudflare`** (gitignored, `chmod 600` — template at `.env.cloudflare.example`), sourced per command so the token never lands in shell history:

```bash
set -a && . ./.env.cloudflare && set +a
npx wrangler whoami        # confirm before proceeding
```

Token permissions: **Workers Scripts: Edit**, **Workers R2 Storage: Edit**, **Account Settings: Read**, and **Zone: DNS: Edit** + **Zone: Workers Routes: Edit** for the custom domain (add the zone scopes only once P-8 lands — there is no zone to scope to before that).

⚠️ **Check which account `whoami` prints.** A token minted with *All accounts* rather than a single account will list several, and `CLOUDFLARE_ACCOUNT_ID` is then the only thing pinning deploys to the right one. Any command run without sourcing `.env.cloudflare` makes wrangler pick or prompt. Verified 2026-08-05: the client account is **`Polybet365@gmail.com's Account`** (`bba4558448a9e49d3826ea947daa5869`); a personal account also being visible to the token is the failure mode to watch for.

⚠️ **Confirm the Workers Paid plan is active — this is a hard gate, verified the hard way.** At 4.79 MiB gzipped a free account rejects the upload outright. **Observed 2026-08-05 on the client's account:** deploy failed with `exceeded the size limit of 3 MiB … [code: 10027]`. The plan page is `dash.cloudflare.com/<account-id>/workers/plans`.

**Correction, 2026-08-05:** "account left clean" understated it slightly. The failed deploy left an **empty Worker service shell** named `polymarket-integration-platform` — visible in the dashboard at `workers/services/view/polymarket-integration-platform/production` with "No URLs enabled," 0 domains, 0 bindings, 0 versions, 0 invocations. Cloudflare's newer dashboard appears to create the *service* (name + `production` environment slot) as one step and upload the actual code bundle as a separate step; the 3 MiB validation killed the second step, so the name got reserved but no code ever landed. This shell does **not** show up in `wrangler deployments list --name polymarket-integration-platform` (empty output, exit 0) or `GET /accounts/:id/workers/scripts` (`"result": []`) — both only report scripts with actual deployed code. Confirmed live 2026-08-05: nothing is running, nothing is billed, 0 invocations. No action needed — do **not** delete it or create a new Worker from the dashboard. It's the correct deploy target already; `npm run deploy` will populate it once Paid is active.

### 2.2 Create the R2 bucket

`wrangler.jsonc` binds `NEXT_INC_CACHE_R2_BUCKET` to a bucket that must already exist:

```bash
npx wrangler r2 bucket create polymarket-platform-cache
```

Skipping this fails the deploy at binding validation.

### 2.3 First deploy — the self-reference chicken-and-egg

`wrangler.jsonc` declares `WORKER_SELF_REFERENCE` pointing at the Worker *itself*, which does not exist before the first deploy. If wrangler rejects the binding:

1. Comment out the `services` block → `npm run deploy` (creates the Worker)
2. Restore the block → `npm run deploy` again

Do **not** resolve this by renaming the service or dropping the binding — OpenNext requires it.

### 2.4 Push secrets

```bash
for k in POLYMARKET_BUILDER_CODE POLYMARKET_BUILDER_API_KEY \
         POLYMARKET_BUILDER_SECRET POLYMARKET_BUILDER_PASSPHRASE \
         PRIVY_APP_SECRET POLYGON_RPC_URL; do
  npx wrangler secret put "$k"
done

npx wrangler secret list      # names only — values are never readable back
```

### 2.5 Privy dashboard

Both are required, and both fail *silently* if missed:

1. **Allowed domains** — add the production origin (App settings). Privy rejects auth from unregistered origins; the symptom is a login that fails only in production.
2. **Identity tokens** — User management → Authentication → Advanced → **"Return user data in an identity token"** must be ON. Privy issues `privy-token` (access, 1h) *and* `privy-id-token` (identity, 10h); the embedded wallet address lives in the **identity** token. With it off, the client session looks perfectly healthy while every server route 401s. `/api/auth/me` reports this specific case as `missing_identity_token`.

### 2.6 Custom domain

In `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "app.example.com", "custom_domain": true }],
"workers_dev": false
```

Requires DNS delegated to Cloudflare (zone active). TLS is issued automatically.

`workers_dev: false` matters: two live origins means a canonical-URL problem, a second origin the CSP and Privy allowed-domains must both cover, and a bypass path around anything domain-scoped.

---

## 3. Routine deploy

```bash
# 1. Gate — never deploy past a red one
npm run lint && npm run typecheck && npm test && npm run build && npm run check:secrets

# 2. Verify on workerd. `next dev` does NOT reproduce OpenNext failures.
npm run preview
#    → confirm / and /restricted return 200, NOT 500

# 3. Build-time vars, then deploy
export NEXT_PUBLIC_PRIVY_APP_ID="<P-6 app id>"
export NEXT_PUBLIC_POLYMARKET_BUILDER_CODE="<P-1 builder code>"
npm run deploy

# 4. Verify the deployment (§5)
```

`npm run deploy` = `opennextjs-cloudflare build && opennextjs-cloudflare deploy`.

**A healthy build prints:**
- `▲ Next.js 16.2.12 (Turbopack)` and `- Environments: .env.local`
- `⚠ The "middleware" file convention is deprecated` — **expected, not a defect.** OpenNext cannot build Next 16 Node middleware ([#962](https://github.com/opennextjs/opennextjs-cloudflare/issues/962)), so Edge `middleware.ts` is the only form that deploys.
- esbuild warnings about `-0` comparison and a duplicate `options` key — third-party, harmless.
- `Worker saved in .open-next/worker.js 🚀`

**Check the size line** on every deploy: `Total Upload: … / gzip: …`. See §7.3.

---

## 4. Secret rotation

Values are never readable back from Cloudflare — `wrangler secret list` shows names only.

| Credential | How |
|---|---|
| `POLYMARKET_BUILDER_API_KEY` / `_SECRET` / `_PASSPHRASE` (P-2…P-4) | `npm run builder:provision -- derive-keys`, then `wrangler secret put` each. ⚠️ Polymarket shows secret + passphrase **once** |
| `POLYMARKET_BUILDER_CODE` (P-1) | Tied to the builder profile. **Cannot be rotated without a new profile** — see §7.4 |
| `PRIVY_APP_SECRET` (P-6) | dashboard.privy.io → App settings → rotate, then `wrangler secret put` |
| `POLYGON_RPC_URL` (P-9) | Reissue at the RPC provider, then `wrangler secret put` |

```bash
npx wrangler secret put <NAME>       # rotate
npm run builder:provision -- status  # verify builder creds against the live API
```

⚠️ **Trust the API, not the Builders panel.** Observed 2026-08-04: the panel showed *"No builder API keys yet"* while `fetchBuilderApiKeys` returned a live key matching `.dev.vars`. Never re-mint a credential on the strength of that message.

Rotating a **request-time** secret takes effect immediately — no rebuild. Rotating anything `NEXT_PUBLIC_*` requires a **full rebuild and redeploy** (§1).

---

## 5. Post-deploy verification

Run in order against the deployed host. Stop at the first failure.

| # | Check | Pass condition |
|---|---|---|
| 1 | `GET /api/spike/signing` | `passed: true` **and** `runtime.runtime: "workerd"`. 🔴 If this fails, **stop and escalate** — signing moves off Workers and the architecture changes |
| 2 | `GET /api/health` | `mode: "live"`, every secret `true`, `builder.codeValid: true`, `problems: []` |
| 3 | `GET /` and `/restricted` | **200**, not 500. A 500 is the OpenNext I/O-context bug — see §8 |
| 4 | `GET /api/geoblock` | `degraded: false` **and** a non-null `countryCode`. ⚠️ Read this carefully: **our** route returns `countryCode`/`regionCode`; **Polymarket's upstream** returns `country`/`region`. Do not "correct" ours to match the upstream — that inverts the fix. `degraded: true` is the real failure signal, and it presents as a *plausible* close-only answer |
| 5 | Geo gate | Blocked region → redirect to `/restricted`; `POST /api/orders` from close-only → **451** |
| 6 | Login end-to-end | Real browser: Privy login → `/api/auth/me` returns a user **with** `signerAddress` |
| 7 | `POST /api/builder/sign` | 401 anonymous; four `POLY_BUILDER_*` fields when signed in |
| 8 | Security headers | `curl -sI https://<host>/` shows CSP, HSTS, `x-frame-options: DENY` |
| 9 | Deposit Wallet | One wallet deploys via the Relayer. ⚠️ Spends 1 of 100 daily relay tx |

```bash
HOST=https://app.example.com
curl -s $HOST/api/spike/signing | python3 -m json.tool
curl -s $HOST/api/health        | python3 -m json.tool
for p in / /restricted; do printf "%-14s %s\n" $p "$(curl -s -o /dev/null -w '%{http_code}' $HOST$p)"; done
curl -sI $HOST/ | grep -iE "content-security|x-frame|strict-transport"
```

Only after 1–9 pass, the Milestone 1 acceptance test:

```bash
npm run smoke:builder -- --token <tokenId> --amount 1 --live
```

⚠️ `--live` places a **real mainnet order with real money** — there is no testnet for the production CLOB. The fill must appear under our builder code in `listBuilderTrades`.

---

## 6. Rollback

```bash
npx wrangler deployments list      # find the last good version
npx wrangler rollback [<version-id>]
npx wrangler deployments status
```

⚠️ **Rollback does not revert `NEXT_PUBLIC_*` values.** They are compiled into each bundle (§1), so rolling back also rolls back to whatever app id and builder code that build was made with. If those changed between builds, a rollback silently changes auth and attribution config. When a rollback is really about reverting a build variable, **rebuild and redeploy** instead.

Rollback also does not revert secrets (request-time, current values always) or R2 cache contents.

---

## 7. Operational limits

### 7.1 Relay quota — 100 tx/day (Unverified)

Shared across dev, QA, demos and production. **Every Deposit Wallet deployment spends one.** Call `getDeployed()` before deploying, reuse test wallets, never burn deploys on throwaway accounts.

100/day cannot support a public launch. Verified tier (10,000/day) requires emailing `builder@polymarket.com` and takes several business days — it is externally controlled and **gates launch**.

### 7.2 Builder fee changes take ~4 days

Observed 2026-08-04: editing a rate in Settings → Builders showed `Pending: 0.5% (8/8/2026)`.

Consequences:
1. Set the fee **days before launch**, never on launch day.
2. An attributed order placed inside the window earns **0** — attribution works, revenue does not.
3. `fetchBuilderFeeRates` returns the **effective** rate with no visibility into pending ones, so `verify-fees` fails during the window through no fault of the config.
4. Repricing is not a dial you can turn reactively.

```bash
npm run builder:provision -- verify-fees   # asserts wrangler.jsonc == profile
```

⚠️ Fee fields in the Builders panel are **percent, not basis points**. Everything in this codebase is bps. 50 bps is entered as `0.5`; entering `50` means 50% and is rejected as over-cap.

### 7.3 Bundle size

| Cap | Limit |
|---|---|
| Workers Free | 3 MiB gzipped |
| Workers **Paid** | 10 MiB gzipped |
| **Measured 2026-08-04** | **4.79 MiB** (`22432.58 KiB / gzip: 4904.02 KiB`) |
| **Re-measured 2026-08-05** | **4.79 MiB** (`22432.58 KiB / gzip: 4904.03 KiB`) — flat, +0.01 KiB |

✅ **The Paid requirement is no longer a projection.** Cloudflare rejected the real upload on the client's account with code 10027 (§2.1). Free is not a fallback to keep in reserve — it cannot host this app at all, and never will: the bundle only grows.

```bash
npx opennextjs-cloudflare build
npx wrangler deploy --dry-run --outdir=/tmp/cf-size    # read the "Total Upload" line
```

🚩 This is **~48% of the paid cap with Milestone 1 only** — no market discovery UI, no order book, no charts, no portfolio. It grew from 2.90 MiB to 4.79 MiB during Milestone 1 alone. Treat the remaining headroom as a budget, not slack, and re-measure every deploy.

### 7.4 Builder profile ownership

🚩 **There is no configurable payout wallet.** Fees go to the wallet that owns the builder profile. Whoever holds that key controls all commission revenue.

Migrating later is expensive: a new profile means a new `bytes32` code, new API keys, and forfeiting the attributed volume history the Verified application depends on.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pages **500**, `Cannot perform I/O on behalf of a different request` | `cacheComponents: true` + OpenNext's `clearImmediate` patch retaining an I/O context | Keep `cacheComponents: false` in `next.config.ts`. **Do not "restore" it** — verified broken on 1.20.2. Does not reproduce under `next dev` |
| **Login button absent**, no errors anywhere | `NEXT_PUBLIC_PRIVY_APP_ID` empty at **build** time | §1. Export it before the build; `wrangler secret put` cannot fix this |
| Build fails: `Cannot initialize the Privy provider with an invalid Privy app ID` | Non-empty but wrong app id | Fail-fast on `/_not-found` prerender. Check for a typo |
| Client session fine, **every server route 401s** | Privy identity tokens disabled | §2.5. `/api/auth/me` reports `missing_identity_token` |
| `wallet_status_failed` on authenticated routes | `createUserClient` without `apiKey` — hits the Deposit Wallet deploy path, which needs Relayer auth | Pass `builderApiKey()` from `@polymarket/client/node`. Typed optional, mandatory in practice |
| `InvariantError: Deposit Wallet deployment requires a Relayer API Key or Builder API Key` during provisioning | `createSecureClient` without `wallet` tries to deploy a Deposit Wallet — circular when minting the *first* builder key | Pass `wallet: <signer's own EOA>` to select EOA mode. Auth-only ops never need a Deposit Wallet |
| Unrestricted users told they are **close-only** | Reading `countryCode`/`regionCode` off **Polymarket's upstream** `https://polymarket.com/api/geoblock`, which returns `country`/`region`. (Our own `/api/geoblock` route deliberately returns the `*Code` spelling — the two are different shapes and only the upstream one is the trap) | `lib/geo/edge.ts` accepts both spellings. Undocumented endpoint — re-verify each milestone |
| `verify-fees` fails right after a rate change | ~4-day fee lead time, not a config error | §7.2. Wait for the effective date |
| Builders panel says "No builder API keys yet" | Panel is unreliable | `npm run builder:provision -- status`. **Never re-mint on the panel's say-so** |
| `✘ Your Worker failed validation because it exceeded size limits` / `exceeded the size limit of 3 MiB` **[code: 10027]** | Account is on Workers **Free**. 3 MiB is the *free* cap — seeing 3 MiB rather than 10 MiB in the message is itself the diagnosis | Upgrade at `dash.cloudflare.com/<account-id>/workers/plans`, then redeploy. §7.3. **No deployed code is created on this failure** — size validation runs before the script bundle is committed. An empty *service shell* (name + `production` environment, no code, no bindings) may still appear in the dashboard — that's expected, not a sign of a partial deploy; see §2.1. No rollback needed |
| Build fails: `Module not found: '@stripe/stripe-js'` | `--legacy-peer-deps` stops npm auto-installing legitimate peers; Privy statically imports the fiat onramp | Keep `@stripe/stripe-js` as a pinned direct dependency. Do not "clean up" the unused-looking package |
| `Failed to fetch Geist from Google Fonts` | Something reintroduced `next/font/google` | Fonts are self-hosted in `src/app/fonts/` via `next/font/local`. Never reintroduce the network dependency |
| `tsc` errors that make no sense after a config change | Aggressive caching | `rm -rf .next tsconfig.tsbuildinfo` and rebuild |
| `response.json()` is `unknown` | `cloudflare-env.d.ts` ships workerd runtime types — stricter than the DOM lib's `any` | Correct behaviour. Declare the wire shape and cast; do not widen to `any` |
| yarn: `Found incompatible module` | Polymarket packages declare `engines.node >= 24`; yarn v1 hard-fails | **npm only.** `npm ci --legacy-peer-deps`. Advisory on Node 22 — npm warns and installs fine |

---

## 9. Disaster recovery

If the Cloudflare account, Worker, or bucket is lost, rebuild in this order:

1. **Account** — Workers **Paid** plan (§2.1)
2. **R2 bucket** — must be named exactly `polymarket-platform-cache` (§2.2)
3. **Worker** — deploy, working around the self-reference binding (§2.3)
4. **Secrets** — all six (§2.4). Builder secret/passphrase are shown once by Polymarket; if lost, re-derive with `builder:provision -- derive-keys`
5. **Privy** — allowed domains + identity tokens (§2.5)
6. **Domain** — route + `workers_dev: false` (§2.6)
7. **Verify** — §5, all nine

**Not recoverable by redeploying:** the builder profile (P-1) and its attributed volume history. It lives on Polymarket, tied to the owning wallet's key — see §7.4.

---

## 10. Change log

| Date | Change |
|---|---|
| 2026-08-04 | Created during Phase 0. Bumped `compatibility_date` 2025-03-25 → 2026-08-01; added CSP + security headers to `next.config.ts` (report-only); generated `cloudflare-env.d.ts`, whose workerd types surfaced 6 real `unknown` type errors now fixed; measured bundle at **4.79 MiB gzipped** (up from 2.90). Verified on local workerd: `/` and `/restricted` 200, all security headers present, `/api/spike/signing` `passed: true` with `runtime: workerd` |
| 2026-08-05 | **First deploy attempted against the client's Cloudflare account — rejected, account is on Workers Free** (`code: 10027`, §2.1/§7.3). Completed before the block: scoped API token convention (`.env.cloudflare`, §2.1), R2 bucket `polymarket-platform-cache` created (§2.2), full gate green (lint/typecheck/34 tests/build/`check:secrets`), bundle re-measured flat at 4.79 MiB, and all §5 probes passing on local workerd. Corrected **§5 check 4**, which described Polymarket's upstream `country`/`region` shape while pointing at *our* `/api/geoblock` route (returns `countryCode`/`regionCode`); as written it would have led someone to "fix" the correct code and reintroduce the fail-closed bug. Same clarification applied to the §8 row |
| 2026-08-05 | **Correction:** "account left clean (0 scripts)" was imprecise. Verified via dashboard screenshot + `wrangler deployments list` (empty, exit 0) + `GET /workers/scripts` (`result: []`) that an empty **Worker service shell** (`polymarket-integration-platform`, no code, no bindings, no versions, 0 invocations) exists in the newer dashboard even though no script API lists it. Harmless, not billed, is the correct deploy target — see §2.1 |
