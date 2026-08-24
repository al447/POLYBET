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
 * 🚩 **It is a mitigation, not a fix — do not read a clean run as "no burst".**
 * Measured 2026-08-24 on the 17:00Z deploy: 134 of that day's 135 504s landed in
 * the two hours after it, and **7 of the 8 worst-hit market slugs were already
 * in this script's top-20 list**. They 504'd anyway.
 *
 * The reason is arithmetic. The browse surface alone reaches
 * 13 categories x 5 sorts x 27 range-filter combos x 2 variants = **3,510**
 * entries (`TOP_CATEGORIES`, `EVENT_SORTS`, `VOLUME_FILTERS`/`LIQUIDITY_FILTERS`/
 * `ENDING_FILTERS` in `lib/polymarket/gamma-types.ts`), before any market page.
 * This script warms ~46. Cold renders are individually cheap — `/` at 4.9s,
 * market pages at 2-4s — but enough of them at once saturates isolate
 * concurrency, and queued requests hit the 100s edge ceiling. That is why
 * `/api/auth/me`, which cannot be cached or warmed at all, took 29 of the 135.
 *
 * The lever that actually addresses this is a `queue` in `open-next.config.ts`
 * so revalidation stops happening inline in a visitor's request. Read that
 * file's docstring first — the override was tried and reverted once.
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

/**
 * 🚩 One path is TWO cache entries, and only the first was ever warmed.
 *
 * Next serves the flight payload from a separate entry keyed on the `RSC`
 * request header (its responses carry `Vary: RSC, ...`), and every client-side
 * navigation asks for that variant rather than the HTML. So each `<Link>` click
 * after a deploy was a guaranteed miss no matter how many paths we listed here.
 *
 * Measured 2026-08-24 against `/` with the HTML entry already warm:
 *
 *   GET /            -> 200  4.92s  1,421,279 bytes
 *   GET / (RSC: 1)   -> 200  7.04s  1,222,951 bytes   <- different entry, cold
 *
 * The RSC request was *slower* than the warm HTML one sitting beside it, which
 * is what a cold entry looks like.
 *
 * ⚠️ There is a known third variant — a prefetch sends `Next-Router-Prefetch: 1`
 * alongside `RSC`, and `Vary` names it. It was NOT measured, so it is not warmed
 * here. Measure before adding it; a third variant is +50% deploy time.
 */
const VARIANTS = [
  { id: "html", headers: {} },
  { id: "rsc", headers: { RSC: "1" } },
];

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

async function warm({ path, variant }) {
  const started = Date.now();
  try {
    const response = await fetch(`${ORIGIN}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Cache-busting is deliberately NOT used: we want to populate the same
      // entry a real visitor will read, not a variant of it.
      headers: { "user-agent": "polybets-cache-warmer", ...variant.headers },
    });
    // Drain the body. The response is only "built" once it has streamed —
    // stopping at headers would warm nothing, because the Suspense boundaries
    // resolve during the body.
    const body = await response.arrayBuffer();
    return {
      path,
      variant: variant.id,
      status: response.status,
      bytes: body.byteLength,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      path,
      variant: variant.id,
      status: "ERR",
      bytes: 0,
      ms: Date.now() - started,
      error: error.message,
    };
  }
}

/** Fixed-size worker pool — simpler than batching, and keeps the pipe full. */
async function warmAll(jobs) {
  const queue = [...jobs];
  const results = [];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      let job;
      while ((job = queue.shift()) !== undefined) {
        const result = await warm(job);
        results.push(result);
        const kb = `${Math.round(result.bytes / 1024)}k`.padStart(6);
        log(
          `  ${String(result.status).padEnd(3)} ${(result.ms / 1000).toFixed(2)}s ${kb}  ` +
            `${result.path} [${result.variant}]`,
        );
      }
    }),
  );

  return results;
}

async function main() {
  log(`Warming ${ORIGIN} …`);

  const slugs = await topSlugs();
  const paths = [...STATIC_ROUTES, ...slugs.map((slug) => `/market/${slug}`)];

  // Path-major, not variant-major: both entries for `/` land before
  // `/leaderboard` starts. If the warmup is cut short, that leaves the most
  // popular paths fully warm rather than every path half warm — and it
  // preserves STATIC_ROUTES' "cheapest first" ordering.
  const jobs = paths.flatMap((path) => VARIANTS.map((variant) => ({ path, variant })));

  const started = Date.now();
  const results = await warmAll(jobs);

  const failed = results.filter((r) => r.status !== 200);
  log(
    `Warmed ${results.length - failed.length}/${results.length} entries ` +
      `(${paths.length} paths x ${VARIANTS.length} variants) ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
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
