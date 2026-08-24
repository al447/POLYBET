import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";

/**
 * OpenNext adapter config — the cache layer behind every `"use cache"` entry.
 *
 * 🚩 **`withRegionalCache` and `memoryQueue` were both here and were REVERTED
 * on 2026-08-23. `memoryQueue` is back as of 2026-08-24, ALONE.
 * `withRegionalCache` is still out — do not re-add it from improvement.md's
 * "Deploy 2" section without reading this whole file first.**
 *
 * They shipped in `c11700d` and the homepage stopped completing. Measured the
 * same day, 17 anonymous requests to `https://polybets.xyz/`: **one** returned
 * (2.8s, 1,172,270 bytes) and **sixteen** flushed the static shell in ~0.03s,
 * stopped at 52,500 bytes, and never sent another byte. The captured partial
 * body ends at `$RC("B:0","S:0")` — the first Suspense boundary resolving —
 * with `FeaturedHero`, `DiscoverySection` and `RightSidebar` never arriving.
 *
 * It was homepage-only. Every other route measured healthy in the same session,
 * including `/api/markets` at 2.55s for 1.8 MB — which calls the *same*
 * `getCachedEvents`. So Gamma and the cached fetch were never the fault; what
 * is unique to `/` is that one render fans out **16 cache entries** (1 event
 * list + 5 hero slides x [2 price histories + 1 comments]).
 *
 * The suspected mechanism, from the adapter's own source: on Next 16
 * `shouldLazilyUpdateOnCacheHit` defaults to `true`, so **every regional cache
 * hit schedules a background R2 re-read plus a full `JSON.stringify` and
 * `cache.put` of the entry** through `ctx.waitUntil`. Sixteen multi-megabyte
 * entries parsed inline *and* re-read and re-serialised in the background, in a
 * 128 MB isolate. That also explains why the first request of a batch survived
 * and the rest did not: the first missed the regional cache and took the
 * single-pass path.
 *
 * ⚠️ **Suspected, not proven.** `c11700d` shipped three changes at once —
 * this file, the `featured-hero.tsx` ceiling and the `fixtures.ts` loop bound —
 * in direct contradiction of improvement.md's own rule that they be deployed
 * one at a time because "a combined regression is unattributable". It duly was.
 * The other live suspect is the hero's `Promise.race`, which deliberately
 * abandons ~15 in-flight cache operations on timeout.
 *
 * Before reintroducing either override: land the payload projection in
 * `gamma.ts` (6.80 MB -> 1.79 MB per entry) first, then add ONE override on its
 * own, and measure with the 20-request loop in improvement.md's Verification
 * section. A row reading `size=52500` is this bug returning.
 *
 * ── `queue: memoryQueue`, added 2026-08-24 ───────────────────────────────────
 *
 * The precondition above is met: `projectEventForList` / `projectEventForDetail`
 * (`gamma.ts:300,316`) now run INSIDE the `"use cache"` functions, so the
 * trimmed object is what R2 stores. And this is one override on its own — the
 * other suspect, `withRegionalCache`, deliberately stays out, so a regression
 * here is attributable in a way `c11700d`'s three-at-once change was not.
 *
 * **Why it is worth the risk.** With `queue` defaulting to `"dummy"`, `send()`
 * throws immediately (see improvement.md Trap 12) and **nothing revalidates in
 * the background at all**. An entry goes fresh -> stale -> expired and is only
 * ever rebuilt by a visitor paying for it inline. That makes `expire` the real
 * refresh interval rather than a safety net, and it is why market detail pages
 * (`getCachedEventBySlug`, `expire: 300`) are rebuilt inline every five minutes
 * by whoever arrives first. This override is what makes `revalidate` mean
 * anything.
 *
 * **What it actually does** (`dist/api/overrides/queue/memory-queue.js`): on a
 * STALE serve it sends one `HEAD` through the `WORKER_SELF_REFERENCE` binding
 * (already declared in wrangler.jsonc), bounded by
 * `AbortSignal.timeout(10_000)`, de-duplicated per isolate. It is invoked from
 * `OpenNextNodeResponse`'s **`onEnd`** hook — verified by reading the minified
 * handler — so it runs after the body has finished streaming, not before.
 * `NEXT_PREVIEW_MODE_ID` is baked into the bundle, so the revalidation
 * authorises rather than silently 401ing.
 *
 * ⚠️ **Two things to watch that are NOT the old bug.**
 * 1. Each stale serve can now hold an isolate for up to 10s after the response.
 *    At this traffic level most serves are stale, so if 504s rise rather than
 *    fall, this is the first thing to suspect — revert before theorising.
 * 2. Those self-`HEAD`s appear in zone analytics as extra requests. Any future
 *    504 count MUST filter `clientRequestHTTPMethodName: GET`, or it will
 *    double-count. Measured 2026-08-24, before this change, all 504s were GET.
 */
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: memoryQueue,
});
