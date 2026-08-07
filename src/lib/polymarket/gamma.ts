import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { POLYMARKET_ENDPOINTS } from "./config";
import { GammaApiError } from "./gamma-types";
import type {
  GammaEvent,
  GammaMarket,
  GammaTag,
  KeysetPage,
  ListEventsParams,
  ListMarketsParams,
} from "./gamma-types";

/**
 * Gamma API client (FR-2.1, FR-2.5).
 *
 * Read-only market/event discovery. No auth, no secrets — but never call this
 * from the browser regardless: it leaks our traffic shape to Polymarket, loses
 * the edge cache, and invites rate limiting. Always go through `/api/markets`.
 *
 * Verified against docs.polymarket.com (api-reference/events, /markets,
 * /tags) on 2026-08-07. Endpoints use keyset (cursor) pagination — `offset`
 * is rejected with a 422 on the `/keyset` routes.
 *
 * `outcomes` and `outcomePrices` on a Market are JSON-encoded *strings*
 * (Gamma's own quirk, not ours) — use `parseGammaJsonArray` (from
 * `gamma-types.ts`) to read them. Those prices are a cached/point-in-time
 * snapshot, fine for a discovery grid (implementation.md's ~30-60s cache
 * policy) but NOT the live implied probability FR-2.3 asks for — that comes
 * from the CLOB order book over WebSocket (Milestone 3), which is never
 * cached.
 *
 * Types + `parseGammaJsonArray` live in `gamma-types.ts`, not here — that
 * file has no `server-only` guard, so client components (the discovery
 * grid's cards) can depend on shape/parsing without depending on network
 * access. Re-exported below so existing server-side imports from "./gamma"
 * keep working unchanged.
 */

export { GammaApiError, parseGammaJsonArray } from "./gamma-types";
export type {
  GammaEvent,
  GammaMarket,
  GammaTag,
  KeysetPage,
  ListEventsParams,
  ListMarketsParams,
} from "./gamma-types";

const DEFAULT_LIMIT = 50;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 8000;

/** Lists active events with their nested markets, newest-filterable via `order`. */
export async function listEvents(
  params: ListEventsParams = {},
): Promise<KeysetPage<GammaEvent>> {
  const query = buildQuery({
    after_cursor: params.cursor,
    limit: params.limit ?? DEFAULT_LIMIT,
    tag_id: params.tagId,
    active: params.active,
    closed: params.closed,
    featured: params.featured,
    order: params.order,
    ascending: params.ascending,
  });
  const data = await gammaFetch<{ events: GammaEvent[]; next_cursor?: string }>(
    `/events/keyset?${query}`,
  );
  return { items: data.events, nextCursor: data.next_cursor ?? null };
}

/** Lists markets directly (flatter than events — one row per outcome market). */
export async function listMarkets(
  params: ListMarketsParams = {},
): Promise<KeysetPage<GammaMarket>> {
  const query = buildQuery({
    after_cursor: params.cursor,
    limit: params.limit ?? DEFAULT_LIMIT,
    tag_id: params.tagId,
    active: params.active,
    closed: params.closed,
    order: params.order,
    ascending: params.ascending,
  });
  const data = await gammaFetch<{ markets: GammaMarket[]; next_cursor?: string }>(
    `/markets/keyset?${query}`,
  );
  return { items: data.markets, nextCursor: data.next_cursor ?? null };
}

/** Fetches one market by slug, for the market detail page. Returns null on 404. */
export async function getMarketBySlug(
  slug: string,
  opts: { includeTag?: boolean } = {},
): Promise<GammaMarket | null> {
  const query = buildQuery({ include_tag: opts.includeTag });
  const path = `/markets/slug/${encodeURIComponent(slug)}${query ? `?${query}` : ""}`;
  try {
    return await gammaFetch<GammaMarket>(path);
  } catch (error) {
    if (error instanceof GammaApiError && error.status === 404) return null;
    throw error;
  }
}

/** Fetches one event (with all its nested markets) by slug — the market detail page. Returns null on 404. */
export async function getEventBySlug(slug: string): Promise<GammaEvent | null> {
  const path = `/events/slug/${encodeURIComponent(slug)}`;
  try {
    return await gammaFetch<GammaEvent>(path);
  } catch (error) {
    if (error instanceof GammaApiError && error.status === 404) return null;
    throw error;
  }
}

/** Cached event-by-slug — same ~30-60s policy as `getCachedEvents`. */
export async function getCachedEventBySlug(slug: string): Promise<GammaEvent | null> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag(`gamma:event:${slug}`);

  return getEventBySlug(slug);
}

/**
 * Lists the category taxonomy (FR-2.2's "filter by category"). Reads Gamma's
 * live tags rather than a hardcoded list, so the discovery UI covers whatever
 * categories actually exist on Polymarket without a code change.
 */
export async function listTags(
  params: { limit?: number; offset?: number; isCarousel?: boolean } = {},
): Promise<GammaTag[]> {
  const query = buildQuery({
    limit: params.limit ?? 200,
    offset: params.offset ?? 0,
    is_carousel: params.isCarousel,
  });
  return gammaFetch<GammaTag[]>(`/tags?${query}`);
}

/**
 * Cached event listing — shared by `/api/markets` (client-side
 * pagination/filtering) and the discovery page's initial SSR fetch, so
 * there's exactly one cache policy for this data, not two independently
 * drifting ones. ~30-60s per implementation.md's Step 2.2 caching table.
 * Verified working (identical `generatedAt` on rapid repeat calls, fresh
 * after the revalidate window) on 2026-08-07 under this exact
 * cacheComponents:false + experimental.useCache:true config.
 */
export type CachedEventsResult =
  | { ok: true; generatedAt: string; items: GammaEvent[]; nextCursor: string | null }
  | { ok: false; error: string; status: number };

export async function getCachedEvents(params: ListEventsParams = {}): Promise<CachedEventsResult> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag("gamma:events");

  // Errors are caught and returned as plain data, not thrown. Discovered
  // 2026-08-07: a `GammaApiError` thrown from inside a `"use cache"` function
  // reaches the caller with `environmentName: 'Cache'` attached and no longer
  // passes `instanceof GammaApiError` — it crosses the cache boundary as a
  // different object, so a caller's `catch { if (error instanceof
  // GammaApiError) ... }` silently misses it and the error surfaces as an
  // unhandled 500 instead of the intended clean 502. Returning a discriminated
  // result sidesteps relying on Error-subclass identity surviving that
  // boundary at all. A non-`GammaApiError` (a real bug, not an expected
  // upstream failure) still throws — that should surface loudly, not be
  // swallowed here.
  try {
    const page = await listEvents(params);
    return { ok: true, generatedAt: new Date().toISOString(), ...page };
  } catch (error) {
    if (error instanceof GammaApiError) {
      return { ok: false, error: error.message, status: error.status };
    }
    throw error;
  }
}

// No cached "list all categories" wrapper here — see `TOP_CATEGORIES` in
// gamma-types.ts. Tried both an unfiltered `/tags` listing and
// `isCarousel: true`; neither produced a usable category nav (garbage and
// too-sparse, respectively — see that file's comment for specifics). `
// listTags` itself is kept as a general-purpose primitive, just not wired
// into the discovery UI.

function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.append(key, String(value));
  }
  return search.toString();
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt + Math.random() * 150;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch with a timeout and exponential backoff retry on 429/5xx and network errors. */
async function gammaFetch<T>(path: string): Promise<T> {
  const url = `${POLYMARKET_ENDPOINTS.gamma}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let shouldRetry = false;

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      if (response.ok) return (await response.json()) as T;

      if (response.status === 404) {
        throw new GammaApiError(`Gamma ${path} returned 404`, 404, path);
      }

      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        shouldRetry = true;
      } else {
        throw new GammaApiError(`Gamma ${path} returned ${response.status}`, response.status, path);
      }
    } catch (error) {
      if (error instanceof GammaApiError) throw error;

      if (attempt >= MAX_RETRIES) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GammaApiError(`Gamma ${path} failed: ${message}`, 0, path);
      }
      shouldRetry = true;
    } finally {
      clearTimeout(timeout);
    }

    if (shouldRetry) await sleep(backoffMs(attempt));
  }

  throw new GammaApiError(`Gamma ${path} exhausted retries`, 0, path);
}
