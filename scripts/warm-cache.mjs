#!/usr/bin/env node
/**
 * Post-deploy cache warmup.
 *
 * 🚩 Why this exists. OpenNext's R2 incremental cache composes every key with
 * the build id — see `getR2Key` in
 * `@opennextjs/cloudflare/dist/api/overrides/incremental-cache/r2-incremental-cache.js`,
 * which passes `buildId: process.env.OPEN_NEXT_BUILD_ID`. **So a deploy orphans
 * the entire cache**, every route goes cold at once, and with no `queue`
 * configured (see open-next.config.ts) the first visitor to each route pays a
 * full rebuild inside their own request.
 *
 * Measured 2026-08-23: the 26 minutes after a deploy produced 49 x 504, with
 * `/market/*` accounting for 13 of the 15 affected paths. The same slugs
 * answered in 1.6-2.3s once warm. Nothing was wrong upstream — Gamma answers in
 * ~0.15s — the requests were simply the ones that had to build the cache.
 *
 * This script makes us pay that instead of the first real visitors.
 *
 * Usage:
 *   node scripts/warm-cache.mjs            # runs automatically after `npm run deploy`
 *   node scripts/warm-cache.mjs --quiet
 *
 * ⚠️ It must NEVER fail the deploy. A warmup that exits non-zero turns a
 * perfectly good release into a red one, and a cold cache is a slow site, not a
 * broken one. Every path below swallows its error and the process always exits 0.
 */

/**
 * Hardcoded rather than read from an env var, same reasoning as `metadataBase`
 * in `app/layout.tsx`: a `NEXT_PUBLIC_*` would reintroduce the build-time
 * inlining trap, and this is the one production origin either way.
 */
const ORIGIN = "https://polybets.xyz";

const GAMMA = "https://gamma-api.polymarket.com";

/** Static routes worth warming, cheapest first so the common ones land early. */
const STATIC_ROUTES = ["/", "/leaderboard", "/predict-ai"];

/** How many market detail pages to warm. Each is its own cache key. */
const MARKET_COUNT = 20;

/** Requests in flight at once. Low on purpose — we are warming, not load testing. */
const CONCURRENCY = 4;

/** Per-request ceiling. A page that needs longer than this is a separate problem. */
const TIMEOUT_MS = 30_000;

const quiet = process.argv.includes("--quiet");
const log = (...args) => {
  if (!quiet) console.log(...args);
};

/**
 * Top event slugs, using the SAME filters `/api/markets` defaults to.
 *
 * That matters: `active`/`closed`/`end_date_min` are what make an event live,
 * and warming slugs for resolved markets would spend the budget on pages nobody
 * opens. Returns [] on any failure — a warmup with no slugs still warms the
 * static routes, which is better than aborting.
 */
async function topSlugs() {
  const endDateMin = new Date();
  endDateMin.setUTCMinutes(0, 0, 0);

  const query = new URLSearchParams({
    limit: String(MARKET_COUNT),
    active: "true",
    closed: "false",
    order: "volume",
    ascending: "false",
    end_date_min: endDateMin.toISOString(),
  });

  try {
    const response = await fetch(`${GAMMA}/events/keyset?${query}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      log(`  ! Gamma returned ${response.status}; warming static routes only`);
      return [];
    }
    const data = await response.json();
    return (data.events ?? []).map((event) => event.slug).filter(Boolean);
  } catch (error) {
    log(`  ! Could not list events (${error.message}); warming static routes only`);
    return [];
  }
}

async function warm(path) {
  const started = Date.now();
  try {
    const response = await fetch(`${ORIGIN}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Cache-busting is deliberately NOT used: we want to populate the same
      // entry a real visitor will read, not a variant of it.
      headers: { "user-agent": "polybets-cache-warmer" },
    });
    // Drain the body. The response is only "built" once it has streamed —
    // stopping at headers would warm nothing, because the Suspense boundaries
    // resolve during the body.
    await response.arrayBuffer();
    return { path, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { path, status: "ERR", ms: Date.now() - started, error: error.message };
  }
}

/** Fixed-size worker pool — simpler than batching, and keeps the pipe full. */
async function warmAll(paths) {
  const queue = [...paths];
  const results = [];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      let path;
      while ((path = queue.shift()) !== undefined) {
        const result = await warm(path);
        results.push(result);
        log(`  ${String(result.status).padEnd(3)} ${(result.ms / 1000).toFixed(2)}s  ${result.path}`);
      }
    }),
  );

  return results;
}

async function main() {
  log(`Warming ${ORIGIN} …`);

  const slugs = await topSlugs();
  const paths = [...STATIC_ROUTES, ...slugs.map((slug) => `/market/${slug}`)];

  const started = Date.now();
  const results = await warmAll(paths);

  const failed = results.filter((r) => r.status !== 200);
  log(
    `Warmed ${results.length - failed.length}/${results.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (failed.length > 0) {
    log(`  ${failed.length} did not return 200 — not fatal, they will build on first visit`);
  }
}

// See the docstring: a warmup failure must not read as a failed deploy.
main().catch((error) => {
  log(`Warmup skipped: ${error.message}`);
  process.exit(0);
});
