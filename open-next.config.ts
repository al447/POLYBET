import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";

/**
 * OpenNext adapter config — the cache layer behind every `"use cache"` entry.
 *
 * 🚩 Both overrides here exist to stop a request holding a Worker isolate.
 * Cloudflare 504s a request at 100s, and a request that runs long queues every
 * request behind it — which is how `/api/health` and `/terms` ended up timing
 * out on 2026-08-22 despite doing no work of their own. See improvement.md,
 * "The mechanism: slot-time, not slowness".
 *
 * `withRegionalCache` — a cold homepage render issues **16** separate cache
 * entries (1 event list + 5 hero slides x [2 price histories + 1 comments]).
 * With the bare R2 store each of those is a network round trip out of the
 * colo. Wrapping it in the Cache API keeps repeat reads data-centre-local.
 *
 * ⚠️ The adapter's own docstring says the regional cache "does not directly
 * improve performance much" and that the real win is bypassing the tag cache.
 * **That caveat does not apply here** — we configure no `tagCache`, so there is
 * nothing to bypass; the entire gain is the avoided R2 round trips, which is
 * exactly this app's problem. Do not let the doc talk you out of this.
 *
 * `memoryQueue` — without a queue, ISR revalidation runs *inside* the visitor's
 * request, so whoever arrives on a stale entry pays for refreshing it. The
 * queue moves that off the request path. It needs no new binding and no
 * Durable Object migration: `WORKER_SELF_REFERENCE` is already in
 * wrangler.jsonc, which is the only thing it requires.
 *
 * It de-dupes per isolate, so revalidation can run more than once across
 * isolates. Fine at this volume; move to `doQueue` if traffic grows enough
 * that duplicate revalidations start costing real Gamma requests.
 */
export default defineCloudflareConfig({
  // `long-lived` reuses an ISR/`use cache` entry per region for up to 30
  // minutes. On Next 16 `shouldLazilyUpdateOnCacheHit` defaults to true, so R2
  // is re-read in the background via waitUntil — refreshed without blocking.
  //
  // ⚠️ Do NOT set `bypassTagCacheOnCacheHit`. It defaults to false on Next 16
  // and is incompatible with SWR-style revalidation, which is what we use.
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: "long-lived" }),
  queue: memoryQueue,
});
