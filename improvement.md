# Performance & 504 Remediation

> **Status:** ✅ **Resolved 2026-08-23** — Deploys 1–7 all shipped. `/` went from **18 of 20 requests hanging** to 6/6 at 1.1–2.1s; `/market/*` from the largest 504 source to 12/12 at 0.74–1.31s *immediately after a deploy*. · **Last updated:** 2026-08-23 · **Branch:** `feat/504-fix-2` (`b37fe70`)
>
> Working record of the 504 investigation and the fixes for it.
>
> **🚩 Read [How to read a 504 report](#how-to-read-a-504-report) FIRST.** Three separate external analyses recommended the same three fixes — add fetch timeouts, add caching, batch the subrequests — and all three were already done or measurably false every time. That misreading cost three rounds.
>
> **⚠️ The afternoon of 2026-08-23 invalidated much of the original diagnosis.** The "slot-time, not slowness" mechanism below explains the *morning*, not what followed. Where an older section conflicts with [Phase 2](#phase-2--the-real-remaining-causes-2026-08-23-afternoon), Phase 2 wins — the earlier text is kept because the reasoning is still instructive, not because it is still true.
>
> **Deploy naming.** 1–4 were the original plan. 5–7 were added during Phase 2. `10e0a4d` is "the 22 Aug deploy".

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

> ⚠️ **Superseded 2026-08-23 afternoon — see [Phase 2](#phase-2--the-real-remaining-causes-2026-08-23-afternoon).**
> This mechanism was real for the morning's data and is no longer what produces 504s here.
> Two later mechanisms replaced it, and both are route-specific rather than site-wide: an
> unbounded Suspense boundary holding one response open ([Trap 9](#trap-9--a-settimeout-ceiling-cannot-be-trusted-to-fire-in-a-starved-isolate)),
> and the post-deploy cache stampede ([Trap 8](#trap-8--every-deploy-orphans-the-entire-r2-cache)).
> The ranking-by-slot-time argument stands; the diagnosis it was applied to does not.

⚠️ **An earlier pass concluded the opposite** — that failures peak in the *quietest* hours — from `clientDisconnected` counts alone. That population is only 113 of ~761 and is not representative. The quiet-hour effect is real but is the *post-fix residue* (the 05:00 burst, 34 errors, during an hour with just 44 successful requests): entries expire at `expire: 300` and the next visitor pays a cold render. Both mechanisms exist; the busy-hour one dominated the 761 and is largely fixed.

### 🚩 There is no origin server — ignore origin-shaped advice

Verified 2026-08-23 after a Cloudflare support agent diagnosed "origin server overload", recommending checks for OOM kills, database lock contention, connection-pool exhaustion and a CPU/RAM upgrade.

`polybets.xyz` resolves to Cloudflare anycast (`104.21.76.136`, `172.67.195.190`) and every response carries `x-opennext: 1`. It is a Worker. **There is no VPS, no database, no connection pool, no OOM killer and no restart cycle**, so none of that advice has anything to act on.

Its *data* was valuable — the per-hour and per-path 504 breakdown is what made this diagnosable, and our API token cannot read zone analytics (see [Verification](#verification)). Two of its suggestions were right under different names: "cache market pages" and "serve stale instead of timing out" are Deploys 2 and 3.

Also note: the 100s timeout is **not** a Free-plan property, as that agent stated. This account is on Workers Paid.

### 🚩 The decisive evidence: `/terms`

`/terms` timed out **19 times**. It makes no Gamma, CLOB or Privy call, and it builds as `○ (Static)` — prerendered HTML.

**A prerendered static page cannot be slow to render.** For it to exceed 100 seconds, the time was spent *queueing*, not rendering. No upstream provider can explain a `/terms` 504, which rules out the entire "slow external API" family of causes.

> ⚠️ **This argument was still sound and stopped being applicable on 2026-08-23.** By the
> afternoon `/terms` measured **0.49–0.58s on every sample** while `/` hung on 18 of 20 — so
> the same page that proved queueing in the morning disproved it later the same day. The
> lesson generalises: `/terms` is the control variable for this app. If it is fast, the fault
> is in a specific route, not in isolate contention. Re-measure it before reusing any
> reasoning in this section.

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

**The homepage is the one unfixed route.** *(True when written, on 2026-08-23 morning. It
was fixed that afternoon by Deploys 5 and 6 — see [Phase 2](#phase-2--the-real-remaining-causes-2026-08-23-afternoon)
for the mechanism, which was not the one this section predicts.)*

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

> ✅ **All four shipped 2026-08-23.** Deploy 2 was subsequently **reverted** — see
> [Phase 2](#phase-2--the-real-remaining-causes-2026-08-23-afternoon) and the docstring in
> `open-next.config.ts`. Deploys 5–7 followed and are recorded in Phase 2. This section is
> kept as the original reasoning; it is a record, not a to-do list.
>
> **What is actually left:**
> - **Deploy 8 — cache the geo lookup.** `resolveGeoStatus` (`lib/geo/edge.ts`) fetches
>   `polymarket.com/api/geoblock` on **every** request: 0.30s measured, serial, before any
>   render, and ~71% of all subrequest volume. An isolate-local `Map` keyed on
>   `cf-ipcountry` + `cf-region-code` with a 10-minute TTL, caching only when a country is
>   known so an unknown one still fetches and still fails closed.
> - **R2 lifecycle rule** — ops only, no deploy. See [Trap 8](#trap-8--every-deploy-orphans-the-entire-r2-cache).
> - **Zone Analytics: Read** on the `.env.cloudflare` token, so 504 breakdowns stop having to
>   come from the dashboard.
>
> ⚠️ **The rule below was written and then broken the same day.** Deploys 1–4 went out in two
> deploys, exactly as warned, and the resulting regression took most of an afternoon to
> unpick. It is a good rule. Follow it.

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

### Deploy 3 — Cache lifetime and shape — ✍️ written, preview-verified

**3a — Let stale entries survive.** `src/lib/polymarket/gamma.ts`

`expire: 300` means an entry is **gone** after 5 minutes and the next visitor blocks on a live refetch. Raising it is what actually delivers "fallback responses".

| Function | Now | Proposed | Why |
|---|---|---|---|
| `getCachedEvents` (:250) | `{30, 60, 300}` | `{30, 60, 1800}` | Home + discovery cards |
| `getCachedSearch` (:170) | `{30, 60, 300}` | `{30, 60, 1800}` | Search results |
| `getCachedEventBySlug` (:213) | `{30, 60, 300}` | **unchanged** | Detail page, beside the order ticket |

**The trade-off, plainly.** CLAUDE.md's rule is "never cache anything price-derived", and a market card shows a price — so during an outage a browse card could show a 30-minute-old price. Acceptable **because nobody trades against these numbers**: the order book and trading panel read live CLOB data in the browser (`market-data.ts` over WSS, `browser-client.ts`), never from these server caches. Display staleness, not execution risk. `getCachedEventBySlug` stays tight precisely because it sits next to the trade surface.

**3b — Shrink what goes into the cache.** `src/lib/polymarket/gamma.ts`

🚩 **This turned out to be the biggest remaining lever, not the smallest.** It was ranked last here; the measurement moved it to first.

Measured on the deployed site 2026-08-23, *after* Deploys 1, 2 and 4 were live and the homepage was still pinned at its 8s hero ceiling on 11 of 12 requests:

| | |
|---|---|
| Gamma direct, same query | **0.07–0.55s** |
| Our `/api/markets` (same `getCachedEvents`) | **1.46–3.56s** |
| One response payload | **6.80 MB** |
| Events / nested markets in it | 50 / **1,619** |
| Heaviest single event | 584 KB — 123 nested markets, `markets` = 99% of it |
| Keys per market Gamma sends | **88** |
| Keys per market `GammaMarket` declares | **29** |

The earlier estimate in this section — "~1 MB per entry" — was **off by nearly 7×**, and it is why this was mis-ranked. Upstream was never slow; the cost is R2 transfer and JSON parse of a payload that is mostly fields nothing can read.

**The 59 undeclared keys are unreadable by any TypeScript consumer**, which is what makes dropping them provable rather than hopeful. Measured projections against the real payload:

| Level | Size | vs before |
|---|---|---|
| Raw Gamma | 6.80 MB | 100% |
| Drop the 59 undeclared keys | 3.51 MB | 52% |
| **+ drop `description`/`resolutionSource` on nested markets** ← shipped | **1.87 MB** | **28%** |
| + cap nested markets at 6/event | 0.44 MB | 6% — *not done, changes ranking behaviour* |

Confirmed under `npm run preview`: **6.80 MB → 1.79 MB.**

Those two prose fields are read only by `MarketRules` and `MarketFaq`, both on `/market/[slug]`, which is served by `getCachedEventBySlug` — a different cache, deliberately left at the full shape. `MarketCard` reads only `event.{endDate,icon,markets,slug,title,volume}` and `market.{id,question}`; `rankEventOutcomes` needs `outcomes`, `outcomePrices`, `clobTokenIds`, `groupItemTitle`, `question`, `closed`. All survive, and `gamma.test.ts` asserts each one.

⚠️ **Highest-care change in this document.** A dropped field shows as *missing content*, not an error — so the guard is the compiler, not review. `LIST_MARKET_FIELDS` is typed `Record<keyof GammaMarket, boolean>`: **adding a field to `GammaMarket` without deciding keep-or-drop is a build failure.** Do not loosen that to `Partial<>` or a bare array.

### Explicitly not doing

- **`enableCacheInterception`** — only helps prerendered/ISR routes. `/` and `/market/[slug]` are `ƒ Dynamic`; the static routes already serve in ~0.45s.
- **`tagCache`** — nothing in the repo calls `revalidateTag`. Machinery with no caller.
- **A second R2 store as an "API fallback"** — B and C get the same outcome from the bucket already deployed.
- **Middleware short-circuit / geo caching** — was planned as defence-in-depth against Trap 1, but the WAF rule addresses it at lower risk. Revisit only if new scanner patterns get through.

---

## Phase 2 — the real remaining causes (2026-08-23 afternoon)

Deploys 1–4 all went out in two deploys (`08:34`, `08:59` UTC) rather than one at a time, in
direct contradiction of the rule stated above them. The combined regression was duly
unattributable, and unpicking it is most of what follows.

### The measurement that reframed everything

Taken 12:00–12:20 UTC, with Deploys 1–4 live:

| Probe | Result |
|---|---|
| `/` — 20 samples | **18 hung to the 90s ceiling**; 2 returned (2.78s, 3.36s) |
| `/terms`, `/leaderboard`, `/portfolio`, `/market/[slug]`, `/copy-trade`, `/predict-ai` | **0.29–1.56s, every sample** |
| Gamma direct, every query we make | 0.15–0.80s |

**If isolates were saturated, `/terms` would be slow. It was 0.5s throughout.** So the
colo-queueing mechanism was no longer the story — the fault was one route, and it was a
*hang*, not slowness. `/terms` had been the decisive evidence *for* queueing in the morning
and became the decisive evidence *against* it in the afternoon.

### Deploy 5 — revert Deploy 2, and bound `DiscoverySection` (`a13704c`, 12:42 UTC)

`withRegionalCache` + `memoryQueue` were reverted (reasoning preserved in
`open-next.config.ts`'s own docstring) and `DiscoverySection` — the last unbounded Suspense
boundary on `/` — got an 8s ceiling with a client-side fallback.

Result: `/` went from 18-of-20 hanging to **30/30 completing, slowest 4.97s**. Attribution
came from the HTML: the grid was server-rendered, so the config revert carried it and the
ceiling never fired.

### Deploy 6 — align the cache key (13:23 UTC)

`/` then settled onto the fallback path permanently — 12/12 at exactly 8.3s / 94,985 bytes.
The cause was a divergence nobody had noticed:

`DiscoverySection` called `getCachedEvents({limit, order, ascending})` while `/api/markets`
defaults `active`, `closed` **and** `endDateMin`. Three consequences from one omission:

1. **It owned a cache key nothing else warmed**, so it went stale every revalidate window and
   each visitor paid the rebuild inline.
2. **The grid was mostly dead markets.** Measured on that exact query: **21 of 24 events
   `closed: true`, 17 already ended, 477 of 864 nested markets closed.** Invisible because
   `MarketGrid` refetches with the filters and paints over the first render.
3. **The cursor was mismatched** — minted without those params, replayed by `MarketGrid` with
   them.

Fixed by passing all three, plus `revalidate` 60 → 300 on the browse caches (with no queue,
rebuilds are back inside the visitor's request, so making them rarer matters).

Result: **12/12 at 1.16–1.42s server-rendered**, and `closed: 0 | ended: 0`.

### Deploy 7 — `/market/[slug]` (`b37fe70`, 14:15 UTC)

The last route with no ceiling: the event fetch was awaited outside every Suspense boundary,
so a slow rebuild held the whole page to the 100s edge timeout. Three changes:

- **A ceiling** via `withBudget`, with a third outcome distinct from "errored" and "missing".
- **`projectEventForDetail`** — the detail cache was the only one still storing Gamma's raw
  87-key shape. Keeps all 29 declared keys (including the prose `MarketRules`/`MarketFaq`
  read), drops the 58 nothing can read.
- **`pickKeys`** replaced `Object.entries → filter → Object.fromEntries`, which had been
  rebuilding ~137,000 key-value pairs per browse refresh to keep 24 of them.

| `/market/what-price-will-bitcoin-hit-before-2027` | Before | After |
|---|---|---|
| Response time | 2.09s | **0.74–1.31s** (12/12) |
| Payload | 328,363 B | **239,288 B** (−27%) |
| 504s in the 13:24–13:50 window | 8 | — |

Bundle went **down** 5262.86 → 5255.50 KiB gzip.

---

## How to read a 504 report

**Four** external analyses of this app's 504s have now reached the same wrong conclusion —
the fourth is recorded at the foot of this section. Before acting on a fifth:

**1. Check what "since the last deployment" means.** One report was windowed from
`08:59:34Z` when the live version was from `13:23:58Z` — it was counting a fixed period as
if it were the current state. Always confirm against `npx wrangler deployments list`.

**2. A window that starts at a deploy will always look terrible.** See [Trap 8](#trap-8--every-deploy-orphans-the-entire-r2-cache).
Window from at least 15 minutes after.

**3. Check the claim against a live probe before believing it.** "Systemic across all
routes" was disproved in 30 seconds by curling six of them. "18+ sequential fetches" was
1.41 subrequests per request. "Slow upstream API" was Gamma at 0.15s.

**4. These three are already done. Do not re-propose them:**

| Recommendation | Reality |
|---|---|
| Add `AbortSignal.timeout()` to fetches | All five have had one since before this work: `gamma.ts` 6s, `price-history.ts` 6s, `leaderboard.ts` 6s, `market-social.ts` 6s, `geo/edge.ts` 2.5s |
| Cache API responses / serve stale | The R2 bucket **is** the Next incremental cache. `expire` already serves stale rather than blocking |
| Batch/reduce subrequests | Measured **1.41 per request** |

**5. Check that the report is even about this codebase.** Added after report #4 named a
Render backend that exists in a *different* project on the same machine. Grep for any host
it mentions before believing the causal chain built on it.

**6. Read the report's own numbers against its own headline.** Report #4 asserted a "504
burst" above a table showing `ok 161, canceled 2, exceededCpu 0, exception 0` and statuses
`200 x 167`, `0 (canceled) x 2` — **no 5xx at all**.

---

### Report #4 (2026-08-23, Cloudflare agent) — `/predict-ai` revalidation

Blamed a 504 burst at 15:21–15:22 UTC on `/predict-ai` ISR revalidation calling
`polybet365-api-live-0s8z.onrender.com` and hanging past the 100s limit. Every load-bearing
claim was false:

| Claim | Reality |
|---|---|
| A 504 burst occurred | Its own outcome table contains **zero** 5xx (see point 6) |
| Revalidation calls a Render backend | **0 hits** for that host across `src/`, `scripts/`, configs. It belongs to `/Users/sayem/projects/PREDICT-ME`, a separate repo |
| `/predict-ai` uses ISR with `revalidate` | **No `export const revalidate` or `dynamic` anywhere in `src/app/`.** Caching is `"use cache"` + `cacheLife` |
| The revalidation fetch hangs | It is a synchronous throw from a stub — see [Trap 12](#trap-12--every-stale-serve-logs-a-revalidation-error-by-design) |
| Roll back to `a153ad17-1935-4e4d-b2a6-0f4ffb797119` | **Not one of the Worker's 10 versions.** Live was `9801dc72` (14:17:23Z) |
| Set `revalidate: 0` / `force-dynamic` | Would make it **worse** — drops the cache so every visitor pays the full twelve-page Gamma walk |

Live probes taken while reading it: `/predict-ai` 10/10 x 200 (0.22–1.85s), seven routes all
200, homepage 20/20 x 200 with a 5.57s tail.

⚠️ **It was still worth reading.** Its *observation* — 4 requests over 5s, all `/predict-ai`,
CPU 9–18ms — was real and correctly identified the slowest path on the site. Low CPU with
high wall time is the signature of waiting, not computing. The fix that came out of it
(an 8s `withBudget` ceiling on the page plus `expire` 900 -> 3600) is in the commit that
added this section. **Separate a report's measurements from its conclusions** — the first
can be sound while the second is unrelated to this codebase.

---

### Trap 12 — Every stale serve logs a revalidation error, by design

`Failed to revalidate stale page <path>` is **not a timeout and not a hang.** OpenNext's
`queue` defaults to `"dummy"`:

```js
// @opennextjs/cloudflare/dist/api/config.js
function resolveQueue(value = "dummy") { ... }

// @opennextjs/aws/dist/overrides/queue/dummy.js
send: async () => { throw new FatalError("Dummy queue is not implemented"); },
```

`revalidateIfRequired` (`@opennextjs/aws/dist/core/routing/util.js:298`) calls
`globalThis.queue.send(...)`, catches the throw and logs it. **No fetch is made, nothing
waits, and the response is unaffected.** It has fired on every stale serve of every route
since `open-next.config.ts` was written, and `open-next.config.ts` explains why no queue is
configured (`memoryQueue` broke the homepage and was reverted).

Two consequences that matter more than the log line:

- **Nothing is ever revalidated in the background.** An entry goes fresh -> stale -> expired
  and is only ever rebuilt by a visitor paying for it inline. `expire` is therefore not a
  safety net, it is the actual refresh interval, and on a low-traffic route most visits land
  past it. This is what made `/predict-ai` — the site's most expensive entry, up to twelve
  sequential Gamma pages — the slowest path on the site.
- **The log correlates with slow requests without causing them.** It fires exactly when a
  page is served stale, which is the same condition that makes the *foreground* rebuild
  expensive. Reading the correlation as causation is what report #4 did.

---

### Trap 8 — Every deploy orphans the entire R2 cache

`getR2Key` in `@opennextjs/cloudflare/dist/api/overrides/incremental-cache/r2-incremental-cache.js`
composes every key with `buildId: process.env.OPEN_NEXT_BUILD_ID`. **A deploy therefore
invalidates every cache entry at once**, and with no `queue` configured the first visitor to
each route pays a full rebuild inside their own request.

Measured: the 26 minutes after the 13:23:58 deploy produced **49 × 504 across 15 paths**,
13 of them `/market/*`. The same slugs answered in 1.6–2.3s once warm, and six slugs never
visited before answered in 1.7–2.6s — so neither the warm nor the cold path was broken. They
were simply the requests that had to build the cache.

Two consequences:

- **A post-deploy 504 burst is expected and self-limiting.** Do not diagnose it as a
  regression. `scripts/warm-cache.mjs` now runs as part of `npm run deploy` and pays that
  cost for us — 23 paths in 12.7s, after which the same slug measured 12/12 sub-1.31s.
- **The bucket accumulates dead entries forever.** 330 objects / 349 MB → **956 / 2.03 GB**,
  almost all orphaned builds. The only lifecycle rule is the default multipart-abort. Nothing
  reads an entry past its `expire` (longest 1800s), so a 1-day expiry rule is safe.

⚠️ This also invalidates Verification step 7's prediction that the bucket would *shrink*
after the projection landed. It grew, because `expire` 300 → 1800 shipped in the same commit.

### Trap 9 — A `setTimeout` ceiling cannot be trusted to fire in a starved isolate

**The single most expensive mistake of this investigation.**

A partial stream capture of `/` showed one boundary resolving to `null` and was read as
"`FeaturedHero`'s 8s ceiling fired, so the hero is fine — `DiscoverySection` is the hang."
That was wrong. The `null` was **`GeoBanner`**, which is first in document order and returns
`null` for an allowed region. `FeaturedHero` had *not* resolved within 25 seconds — despite a
correctly-written `Promise.race` against `setTimeout(8000)`.

Timers only run when the isolate gets to execute them. Under 16 concurrent multi-megabyte
`JSON.stringify` + `cache.put` operations in a 128 MB isolate, the timer queues behind the
very work it is meant to bound. The CPU P99 of 1,576 ms was the same signal read from
outside.

**So a ceiling is insurance, not a fix.** It bounds work that is *waiting*; it cannot bound
work that is *burning CPU*. Fix the cause and keep the ceiling for the tail — never the
other way round.

⚠️ Corollary for reading stream captures: `$RC("B:0","S:0")` identifies the boundary by
*document order*, not by which component you were thinking about. Count the boundaries in
`page.tsx` before attributing one.

### Trap 10 — `notFound()` cannot set a 404 from inside a Suspense boundary

Hit and reverted within the hour on 2026-08-23, while trying to make `/market/[slug]` render
its shell before its data.

Moving the event fetch into a `<Suspense>` child means the response is
`Transfer-Encoding: chunked` and **the status line is flushed with the shell**. A
`notFound()` that resolves afterwards renders the correct 404 *UI* under an HTTP **200**:

```
status=200 bytes=34849
  4  404
  2  could not be found
```

That is worse than it looks here: this site is actively probed by scanners ([Trap 1](#trap-1--scanner-probes-made-the-app-call-polymarket)),
and answering 200 to every `/market/<garbage>` is a real regression.

**Anything that determines the HTTP status must complete before the first byte.** The fetch
stays in the page function, bounded by `withBudget`. The bound is what fixes the 504; the
Suspense split was a first-paint nicety that cost correctness.

### Trap 11 — A Server Component and its API route can silently diverge

`DiscoverySection` and `/api/markets` call the same `getCachedEvents` with *different*
params, so they never shared a cache entry and never returned the same data — the server
render was 21-of-24 closed events. Nobody saw it because the client refetched with the right
filters and painted over it within a second.

Two smells worth grepping for: a Server Component and a route handler calling one cached
function with hand-written argument lists, and defaults living in the route
(`?? true` / `?? false`) rather than in the shared function. If the first paint and the first
refetch disagree, the bug is invisible by construction.

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
