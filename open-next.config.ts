import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

/**
 * OpenNext adapter config — the cache layer behind every `"use cache"` entry.
 *
 * 🚩 **`withRegionalCache` and `memoryQueue` were here and were REVERTED on
 * 2026-08-23. Do not re-add them from improvement.md's "Deploy 2" section
 * without reading this first.**
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
 */
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
