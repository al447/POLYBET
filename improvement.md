# Performance & 504 Remediation

> **Status:** Deploy 1 ✅ typecheck/test/lint clean, preview OK · Deploy 2 written, untested · Deploys 3–4 pending · **Last updated:** 2026-08-23 · **Branch:** `feat/504-fix`
>
> Working record of the 504 investigation and the fixes for it. Read [Diagnosis](#diagnosis) before changing anything here — three plausible-sounding causes were ruled out with evidence, and re-proposing them wastes a deploy.
>
> **⚠️ Deploy naming changed 2026-08-23.** The old A/B/C labels were ambiguous — "Deploy A" referred both to the shipped commit `10e0a4d` *and* to the uncommitted hero ceiling. They are now numbered 1–4 in [Remaining work](#remaining-work), reordered by measured impact. `10e0a4d` is simply "the 22 Aug deploy".

---

## Problem

Measured **2026-08-23**: **761–773 504s in 24 hours** against ~7,111 requests — an **~11% error rate**. Cloudflare times these out at **100 seconds**.

The earlier figure, for the record: ~459 504s against 8,091 requests (5.7%), as traffic grew from 850 to 8,091 requests/day inside a week.

🚩 **The 761 is mostly a pre-fix backlog — read the split before concluding the fix failed.** The 22 Aug deploy landed at **17:10 UTC**:

| Window | 504s | Rate |
|---|---|---|
| Before 17:10 (12:00–16:00) | 590 | ~118/hr |
| 17:00 hour (straddles the deploy) | 91 | — |
| After 17:10 (18:00 → 07:00 next day) | **83** | **~6/hr** |

That is roughly a **95% reduction in rate**. What is left is a real residue, not a failed fix.

Affected paths, from Cloudflare's 5xx breakdown:

| Path | 504s | Calls an external API? |
|---|---|---|
| `/market/world-cup-winner` | 28 | Yes — Gamma, awaited **outside** Suspense |
| `/market/fed-decision-in-september-762` | 26 | Yes |
| `/terms` | **19** | **No — zero external calls** |
| `/market/us-strikes-iran-by` | 18 | Yes |
| `/market/presidential-election-winner-2024` | 18 | Yes |
| `/market/english-premier-league-winner` | 14 | Yes |
| `/api/markets` | 11 | Yes |
| `/api/auth/session` | 8 | **Route does not exist** — only `/api/auth/me` |
| Scanner probes (`/.env*`, `/wp-config.php`, `/Jenkinsfile`, `/info.php`, `/.git/*`) | large share | See [Trap 1](#trap-1--scanner-probes-made-the-app-call-polymarket) |

---

## Diagnosis

### Ruled out, with evidence

Three causes were proposed externally (a handover brief and a Cloudflare engineer). All three are wrong, and each was checked rather than argued:

| Claim | Finding |
|---|---|
| Slow Polymarket APIs hang the Worker | **Gamma answers in 0.11s.** Direct probe: `2.67s` (TLS) then `0.12 / 0.11 / 0.12 / 0.11s`. A burst of 10 returned `200` ten times — **no rate limiting**. |
| Need a premium Polymarket tier | No premium tier exists for these endpoints — Gamma/CLOB/Data reads are public and unauthenticated. Polymarket's Unverified→Verified→Partner tiers govern **relay transactions**, not market-data throughput. |
| Need a premium Polygon RPC (Alchemy) | **The Worker makes zero RPC calls.** `POLYGON_RPC_URL` appears exactly once in the codebase — `lib/env.ts:27`, a type declaration that is never read. The browser reaches Polygon via Privy's provider. |
| External fetches lack `AbortController` | **All five already had one** before this work: `gamma.ts` (8s), `price-history.ts` (8s), `leaderboard.ts` (8s), `market-social.ts` (8s), `geo/edge.ts` (2.5s). |
| "Serve R2 as a fallback" is unbuilt | The bucket **already is** the Next incremental cache — bound as `NEXT_INC_CACHE_R2_BUCKET`, wired as `r2IncrementalCache`. It needs tuning, not building. See [Deploy 2](#deploy-2--regional-cache--queue). |

### 🚩 The mechanism: slot-time, not slowness — corrected 2026-08-23

Two datasets only make sense together. Zone-level 504 counts cluster in the **busiest** hours (12:00 → 219, 15:00 → 194, 16:00 → 108). Worker-level `workersInvocationsAdaptive` for the same 24h:

| status | requests | subreq/req | p99 wall time |
|---|---|---|---|
| `success` | 2,845 | 2.1 | 9.4s |
| `clientDisconnected` | 113 | **12.6** | **130s** |

**Most 504s never produced a Worker invocation at all.** At 12:00 the zone logged 219 504s while the Worker logged 804 invocations at a p99 of 4.3s — those 219 are not in the success population and not in the disconnected one. They were **queued at the colo and timed out before dispatch**.

So the chain is: a slow render holds a Worker isolate for tens of seconds → concurrency saturates → new requests queue → queued requests hit 100s → **504 on every path, including ones that do no work**. That is the real reason `/api/health` (16) and `/terms` also 504 — they were never slow, they were stuck behind requests that were.

**The metric that matters is slot-time held per request, not average latency.** Fixes are therefore ranked by how much wall-clock a request stops occupying, which is why the fixtures loop ([Trap 7](#trap-7--a-per-call-budget-is-not-a-per-loop-budget)) outranks anything on the homepage despite causing fewer 504s.

⚠️ **An earlier pass concluded the opposite** — that failures peak in the *quietest* hours — from `clientDisconnected` counts alone. That population is only 113 of ~761 and is not representative. The quiet-hour effect is real but is the *post-fix residue* (the 05:00 burst, 34 errors, during an hour with just 44 successful requests): entries expire at `expire: 300` and the next visitor pays a cold render. Both mechanisms exist; the busy-hour one dominated the 761 and is largely fixed.

### 🚩 There is no origin server — ignore origin-shaped advice

Verified 2026-08-23 after a Cloudflare support agent diagnosed "origin server overload", recommending checks for OOM kills, database lock contention, connection-pool exhaustion and a CPU/RAM upgrade.

`polybets.xyz` resolves to Cloudflare anycast (`104.21.76.136`, `172.67.195.190`) and every response carries `x-opennext: 1`. It is a Worker. **There is no VPS, no database, no connection pool, no OOM killer and no restart cycle**, so none of that advice has anything to act on.

Its *data* was valuable — the per-hour and per-path 504 breakdown is what made this diagnosable, and our API token cannot read zone analytics (see [Verification](#verification)). Two of its suggestions were right under different names: "cache market pages" and "serve stale instead of timing out" are Deploys 2 and 3.

Also note: the 100s timeout is **not** a Free-plan property, as that agent stated. This account is on Workers Paid.

### 🚩 The decisive evidence: `/terms`

`/terms` timed out **19 times**. It makes no Gamma, CLOB or Privy call, and it builds as `○ (Static)` — prerendered HTML.

**A prerendered static page cannot be slow to render.** For it to exceed 100 seconds, the time was spent *queueing*, not rendering. No upstream provider can explain a `/terms` 504, which rules out the entire "slow external API" family of causes.

### Actual causes, in the order they were found

**1. Scanner traffic saturating the Worker** — see [Trap 1](#trap-1--scanner-probes-made-the-app-call-polymarket). Dominant cause. Fixed by a WAF rule.

**2. Retry amplification.** `gammaFetch`'s 8s timeout was **per attempt** with `MAX_RETRIES = 3` → 4 attempts + backoff ≈ **34.5s for one logical call**, with no total ceiling. `/market/[slug]` awaits Gamma **outside** any Suspense boundary (`market/[slug]/page.tsx:40`), so the chain ran: middleware 2.5s → Gamma 34.5s → Suspense children (comments 34.5s, chart 5×8s, holders + trades 8s each) ≈ **71s before contention**. That is the ~104 `/market/*` timeouts. Fixed in the 22 Aug deploy (`10e0a4d`).

**3. Privy's SDK defaults.** `new PrivyClient({appId, appSecret})` with no options resolves to `timeout: 60s, maxRetries: 2` → **180s worst case**, verified in `@privy-io/node@0.28.0` (`client.js:134,144`; `:408` retries on timeout). Exposed on `/api/legal/accept`. The only single call able to breach the edge ceiling unaided.

**4. The cache layer on the homepage.** Still open — see [Deploy 2](#deploy-2--regional-cache--queue).

---

## Traps

### Trap 1 — Scanner probes made the app call Polymarket

Automated scanners probing for exposed credentials were a large share of the 504s, and the cost was far higher than "wasted 404s".

Verified by running the real matcher from `src/middleware.ts` against the logged paths:

```
true   /.env.private        true   /wp-config.php     true   /Jenkinsfile
true   /config/paypal.php   true   /info.php          true   /terms
false  /icon.svg            false  /_next/static/chunks/a.js
```

Every probe **matched the middleware**, and `middleware.ts:35` makes a live `fetch` to `polymarket.com/api/geoblock` (2.5s timeout) before anything can return. So each junk request cost an outbound HTTPS call to Polymarket, then rendered a 404 — measured at **3.1s per 404**.

Two consequences: Worker capacity spent on traffic that was never ours, and plausible rate-limiting of our egress at polymarket.com, which would degrade the geo gate for real users.

**Fixed by a Cloudflare WAF rule** (edge-level, no deploy). Blocks now land in **0.02–0.04s** and never reach the Worker.

⚠️ **Use Block, not Managed Challenge.** A challenge still invokes the Worker, which still triggers the outbound Polymarket call. Only an outright block stops it at the edge.

⚠️ **The WAF rule must not match a real route.** Verify after any change to it:
```bash
for p in / /terms /market/world-cup-winner /api/health /api/markets /icon.svg; do
  printf "%-32s " "$p"; curl -s -o /dev/null -w "http=%{http_code}\n" "https://polybets.xyz$p"
done
```
Anything other than `403` is fine. A `403` on any of these means the pattern is too broad.

### Trap 2 — A per-attempt timeout is not a timeout

`gammaFetch` had a correctly-configured `AbortController` on every attempt and was still unbounded, because `MAX_RETRIES` multiplied it. **Every individual timeout looked right while the total had no ceiling.** The fix computes a deadline once, before the retry loop, and derives each attempt's signal from the time remaining.

This is why "add AbortController timeouts to every external fetch" was a no-op as advice — they were all already there.

### Trap 3 — Retrying a 429 amplifies the thing it is retrying

`isRetryableStatus` included `429`. Gamma asking for fewer requests was answered with four times as many, which closes into a feedback loop under load: traffic rises → 429s → each request fans out → more 429s. 429 is now terminal. Pinned by a test in `gamma.test.ts`.

### Trap 4 — Brand assets are Worker-rendered routes, not static files

`/icon.svg`, `/apple-icon.png` and `/opengraph-image.png` are committed bytes, but Next serves each through a *metadata route* — so the Worker re-rendered them per request at `Cache-Control: public, max-age=0, must-revalidate`. Since `<link rel="icon">` is in the root layout, **every page navigation** revalidated the icon.

Measured on the deployed Worker at the exact URLs the HTML references:

```
/icon.svg             0.65  2.61  6.91  7.15  7.58  7.92  11.62 s
/apple-icon.png       0.95  1.23 s
/opengraph-image.png  4.19  6.24 s
```

⚠️ Deliberately **not** `immutable` with a one-year age: the app was rebranded on 2026-08-19, and pinning a stale logo into browsers for a year is worse than a slow icon.

### Trap 5 — `wrangler dev` uses a *local* R2 simulation

Local preview never touches the production 349 MB bucket, so local timings do not predict production. Measured the same day, same code, same Gamma:

| | Cache | Homepage |
|---|---|---|
| Local preview | empty local sim | **0.3s** |
| Production | 349 MB R2, 330 objects | **3.7–26s** |

Useful as a signal that the *code* is not what is slow. Useless as a performance measurement.

### Trap 6 — Six samples do not clear a 5% failure

After the WAF rule landed, 16 samples showed no outliers and the tail was called "gone". It was not — a later run caught **120s** on the homepage. A ~5% event needs a far larger sample. Always sort and inspect the slowest of ≥30:

```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w "%{time_total}\n" --max-time 60 https://polybets.xyz/ ; done | sort -n | tail -5
```

### Trap 7 — A per-call budget is not a per-loop budget

Found 2026-08-23. The 22 Aug deploy fixed [Trap 2](#trap-2--a-per-attempt-timeout-is-not-a-timeout) by giving `gammaFetch` a `TOTAL_BUDGET_MS` covering all its retries. **The same bug was one level up, untouched.**

`fetchFixtures()` (`lib/polymarket/fixtures.ts`) walks Gamma's keyset pagination in a sequential loop:

```
MAX_PAGES = 12  x  TOTAL_BUDGET_MS = 6s  =  72 seconds, one request, no ceiling
```

`MAX_PAGES` bounds how many pages are walked. It does not bound how long that takes. Twelve slow pages is 72s of Gamma time before R2, middleware or render get a turn — against a 100s edge timeout. `/predict-ai` was the second-worst single 504 path on the site (**54**), and this is why.

**The generalisation worth keeping:** every time a bounded call gets wrapped in a loop, the bound is gone again. `gammaFetch` is bounded; `listEvents` is bounded; twelve `listEvents` is not. Grep for `for (…) { await` before trusting any budget.

Fixed by computing a deadline once before the loop and breaking on it — the same shape `gammaFetch` uses internally. On expiry it returns the fixtures collected so far rather than throwing: a partial board beats a 504. Pinned by `fixtures.test.ts`.

⚠️ The deadline is checked **between** pages, so one in-flight call can overrun it by up to 6s. Worst case is ~16s, not 10s.

---

## Measured effect so far

WAF rule + the 22 Aug deploy (`10e0a4d`), both live:

| Route | Before | After |
|---|---|---|
| `/market/world-cup-winner` | 28 × 504 | 0.72–2.45s ✅ |
| `/api/markets` | 5.4–6.3s | 1.34–5.25s ✅ |
| `/portfolio` | 0.5–**34.4s** | 0.43–0.91s ✅ |
| `/icon.svg` | 6.9–7.9s | 0.21s ✅ |
| `/terms` | 0.6–3.2s | 0.43–0.52s ✅ |
| **`/`** | 3.7–**26s** | 1.73–4.91s, **one sample hit 120s** ❌ |

Bundle went **down** 59.5 KiB gzip (5320.33 → 5260.80).

**The homepage is the one unfixed route.**

---

## Why the homepage specifically

It is the only page with a large fan-out. A cold render issues **16 `"use cache"` entries**:

```
getCachedEvents                 1
  └─ 5 slides in parallel        (SLIDE_COUNT)
       ├─ 2 price histories     10   (CHARTED_SERIES)
       └─ 1 comments call        5
```

Every call is capped at 6s and Gamma answers in ~110ms, **so the fetches are not what runs long**. Each of those 16 is a separate **R2 read and write**, and `open-next.config.ts` configures no `queue` — so revalidation runs *inside the request*. The cache layer is the unbounded part.

`/market/[slug]` has far fewer entries in play and was fixed by the Gamma budget alone. That contrast is the evidence.

Homepage server-side exposure after the 22 Aug deploy:

| Suspense boundary | Cache entries | Bounded? |
|---|---|---|
| `GeoBanner` | 0 | n/a |
| `FeaturedHero` | **16** | ✅ 8s ceiling (Deploy 4) |
| `DiscoverySection` | 1 | ❌ still unbounded |
| `RightSidebar` | 0 | n/a |

---

## Remaining work

Four separate deploys, **ship in this order** — 1 → 2 → 3 → 4, verified one at a time. **Do not combine them**: 2 is build config and 3 changes cache semantics; a combined regression is unattributable.

Ordered by *slot-time freed per request*, which is the quantity that actually clears the queue — see [the mechanism](#-the-mechanism-slot-time-not-slowness--corrected-2026-08-23). The hero ceiling moved from first to last: it is a guarantee, not a cause fix, and it is worth least until the causes are addressed.

### Deploy 1 — Bound the fixtures pagination loop — ✍️ written, untested

`src/lib/polymarket/fixtures.ts`, pinned by a new `src/lib/polymarket/fixtures.test.ts`.

The largest single unbounded span in the codebase: **72s worst case → ~16s**. Full reasoning in [Trap 7](#trap-7--a-per-call-budget-is-not-a-per-loop-budget).

A deadline computed once before the loop, checked between pages, returning a partial board on expiry:

```ts
const FIXTURES_BUDGET_MS = 10_000;
const deadline = Date.now() + FIXTURES_BUDGET_MS;

for (let page = 0; page < MAX_PAGES; page += 1) {
  if (Date.now() >= deadline) break;   // partial board beats a 504
  const result = await listEvents({ /* unchanged */ });
  // ...
}
```

`listEvents` needs no signature change — the deadline lives entirely in the caller. Lowest-risk change in this document: the worst case is a fixture board with fewer matches on it when Gamma is slow.

### Deploy 4 — Hero ceiling — ship LAST

`src/components/markets/featured-hero.tsx` — **written, uncommitted, untested.**

Races the whole hero fetch against `HERO_BUDGET_MS = 8000`; on loss returns `null` and the page renders without it. This makes real a contract the file's docstring already states — *"degrading to 'no hero' is always better than degrading to 'no home page'"* — which until now held only for errors, not slowness.

`Promise.race` deliberately leaves the slow branch running so its cache writes still land and warm the entry for the next visitor.

**This is a guarantee, not a fix.** It stops the homepage 504ing from this cause whatever the cache does underneath. B and C address the cause.

### Deploy 2 — Regional cache + queue — ✍️ written, untested

`open-next.config.ts` — the concrete form of "leverage the R2 cache."

⚠️ **This is build config, so `npm run preview` is not optional.** It is the one change in this document that can break every route at once, and the repo has a documented trap where pages 500 under workerd while working fine in `next dev` (CLAUDE.md, `cacheComponents`). Verified present in the installed `@opennextjs/cloudflare@1.20.2`; `memoryQueue`'s required `WORKER_SELF_REFERENCE` binding is already in `wrangler.jsonc`.

Today each of the 16 lookups is a network round trip to R2. `withRegionalCache` wraps the store with Cloudflare's **Cache API**, which is data-centre-local, so repeat reads never leave the colo.

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";

export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: "long-lived" }),
  queue: memoryQueue,
});
```

- **`mode: "long-lived"`** — reuses an ISR/`use cache` entry per region for up to 30 minutes. On Next 16 `shouldLazilyUpdateOnCacheHit` defaults to `true`, so R2 is re-read in the background via `waitUntil` — refreshing without blocking the request.
- **`queue: memoryQueue`** — revalidation stops running inside a visitor's request. Needs no new binding and no Durable Object migration, so it carries no deploy risk. It can duplicate revalidation across isolates, fine at 8k req/day. Move to `doQueue` only if volume grows.

⚠️ **The adapter's own docstring says the regional cache *"does not directly improve performance much"*, and that the real gain is bypassing the tag cache. That caveat does not apply here** — we configure no `tagCache`, so there is nothing to bypass; our entire gain is the avoided R2 round trips, which is exactly the homepage's problem. Do not let the doc talk you out of this change.

⚠️ Do **not** enable `bypassTagCacheOnCacheHit`. It defaults to `false` on Next 16 and is incompatible with SWR-style revalidation.

### Deploy 3 — Cache lifetime and shape

**3a — Let stale entries survive.** `src/lib/polymarket/gamma.ts`

`expire: 300` means an entry is **gone** after 5 minutes and the next visitor blocks on a live refetch. Raising it is what actually delivers "fallback responses".

| Function | Now | Proposed | Why |
|---|---|---|---|
| `getCachedEvents` (:250) | `{30, 60, 300}` | `{30, 60, 1800}` | Home + discovery cards |
| `getCachedSearch` (:170) | `{30, 60, 300}` | `{30, 60, 1800}` | Search results |
| `getCachedEventBySlug` (:213) | `{30, 60, 300}` | **unchanged** | Detail page, beside the order ticket |

**The trade-off, plainly.** CLAUDE.md's rule is "never cache anything price-derived", and a market card shows a price — so during an outage a browse card could show a 30-minute-old price. Acceptable **because nobody trades against these numbers**: the order book and trading panel read live CLOB data in the browser (`market-data.ts` over WSS, `browser-client.ts`), never from these server caches. Display staleness, not execution risk. `getCachedEventBySlug` stays tight precisely because it sits next to the trade surface.

**3b — Shrink what goes into the cache.** `src/lib/polymarket/gamma.ts`

The bucket holds **330 objects / 349 MB — ~1 MB per entry**. The cache stores raw Gamma responses: full event objects, every nested market, every field. The cards use a fraction. Project to a narrow shape **before** returning from the `"use cache"` function.

Cuts R2 transfer *and* the JSON parse per render, and compounds with Deploy 2 — smaller entries make the regional Cache API far more effective.

⚠️ **Highest-care change in this document.** A dropped field shows as *missing content*, not an error. Type the projected shape explicitly so the compiler catches omissions.

### Explicitly not doing

- **`enableCacheInterception`** — only helps prerendered/ISR routes. `/` and `/market/[slug]` are `ƒ Dynamic`; the static routes already serve in ~0.45s.
- **`tagCache`** — nothing in the repo calls `revalidateTag`. Machinery with no caller.
- **A second R2 store as an "API fallback"** — B and C get the same outcome from the bucket already deployed.
- **Middleware short-circuit / geo caching** — was planned as defence-in-depth against Trap 1, but the WAF rule addresses it at lower risk. Revisit only if new scanner patterns get through.

---

## Risk

| Change | Worst case | Site down? |
|---|---|---|
| 4 — hero ceiling | Hero disappears on slow renders; grid still renders | No |
| 2 — regional cache + queue | A region serves an entry up to 30 min stale; duplicated revalidation across isolates | No |
| 3a — `expire` raise | Browse cards up to 30 min stale during an outage | No |
| 3b — narrowed cache shape | **A dropped field shows as missing content on cards** | No |

**The real downtime risk is the deploy, not the diff.** This repo has a documented trap where pages 500 under workerd while working fine in `next dev` (CLAUDE.md, `cacheComponents`). `npm run preview` before `npm run deploy` is mandatory — and doubly so for Deploy 2, which is a build-config change.

Rollback:
```bash
npx wrangler deployments list
npx wrangler rollback --message "revert <deploy>"
```
Cloudflare keeps the current version live until the new one is ready — a normal deploy has no gap.

---

## Verification

**Per project rule, the user runs these.**

**1. After each deploy's edits:**
```bash
npm run typecheck && npm test && npm run lint
```

**2. Local workerd — mandatory, `next dev` does not reproduce Worker behaviour:**
```bash
npm run preview
```
```bash
for i in $(seq 1 8); do curl -s -o /dev/null -w "%{time_total} " --max-time 60 http://localhost:8787/ ; done; echo
```
⚠️ Port is **8787** (wrangler's default), and see [Trap 5](#trap-5--wrangler-dev-uses-a-local-r2-simulation) — this confirms nothing broke, not that the fix works.

**3. Bundle check before deploy** — two-command form required; `--dry-run` alone measures a stale `.open-next/`:
```bash
npx opennextjs-cloudflare build && npx wrangler deploy --dry-run
```
Baseline **5260.80 KiB gzip** against a 10 MiB cap.

⚠️ `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_POLYMARKET_BUILDER_CODE` are **build-time** — they must be present in `.env.local` before the build. Missing them ships a site with no login and zero builder attribution, silently. Confirm the build log prints `- Environments: .env.local`.

**4. Deploy:** `npm run deploy`

**5. Post-deploy — sample the homepage tail properly** (see [Trap 6](#trap-6--six-samples-do-not-clear-a-5-failure)):
```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w "%{time_total}\n" --max-time 60 https://polybets.xyz/ ; done | sort -n | tail -5
```
**Success = the slowest of thirty is under ~8s**, and nothing hits the `--max-time` ceiling.

**6. Sign in on the live site.** A broken `NEXT_PUBLIC_PRIVY_APP_ID` presents as a login button that silently does nothing, not an error.

**7. Confirm cache size dropped** after C2:
```bash
npx wrangler r2 bucket info polymarket-platform-cache
```
Baseline 330 objects / 349 MB. Oversized entries age out rather than vanishing — expect this to fall over hours.

**8. The number that closes this out** — the Cloudflare 24-hour 5xx breakdown. Baseline **761–773 504s / ~7,111 requests (~11%)** measured 2026-08-23, of which only **~83 are post-`10e0a4d`**. (The older 459 / 8,091 / 5.7% figure predates that deploy.)

⚠️ **The API token in `.env.cloudflare` cannot read this.** It authenticates and resolves the zone, then the GraphQL analytics query fails:

```
Actor 'com.cloudflare.api.token.…' does not have permission
'com.cloudflare.api.account.zone.analytics.read' for zone …
```

Add **Zone Analytics: Read** to the token, or get the breakdown from the Cloudflare dashboard/support agent after each deploy.

What *is* readable with the current token is account-level Workers analytics, which is enough to track the mechanism directly:

```bash
# subrequests-per-request on clientDisconnected is the number to watch —
# it should fall from ~12.6 toward the ~2.1 that healthy requests show.
set -a && . ./.env.cloudflare && set +a
# POST to https://api.cloudflare.com/client/v4/graphql
#   viewer { accounts(filter:{accountTag:$CLOUDFLARE_ACCOUNT_ID}) {
#     workersInvocationsAdaptive(filter:{ scriptName:"polymarket-integration-platform", ... })
#       { sum { requests subrequests } quantiles { wallTimeP99 } dimensions { status datetimeHour } } } }
```

---

## Communicating this

**No vendor upgrades are needed.** Polymarket answers in 110ms and does not rate-limit us on a direct probe; there is no premium tier for these endpoints. The Polygon RPC is not used server-side at all. The fault was ours and it costs nothing to fix.

**Do not promise "no 504s or 404s, permanently."** 404 is the correct response to a URL that does not exist, and no deploy makes a site immune to an upstream outage. Promise: fast cached responses, and a clear error instead of a hang when a provider has a bad day.

**Credit where it is due:** the single largest improvement so far was the WAF rule, not application code — because each scanner probe was making the app call Polymarket before returning a 404. That is a detail no external reviewer could have found without reading our middleware.
