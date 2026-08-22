import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { POLYMARKET_ENDPOINTS } from "./config";
import { GammaApiError, SEARCH_MAX_LIMIT, SEARCH_PAGE_SIZE } from "./gamma-types";
import type {
  GammaComment,
  GammaEvent,
  GammaMarket,
  GammaTag,
  KeysetPage,
  ListEventsParams,
  ListMarketsParams,
  SearchEventsParams,
  SearchPage,
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
  GammaComment,
  GammaEvent,
  GammaMarket,
  GammaTag,
  KeysetPage,
  ListEventsParams,
  ListMarketsParams,
  SearchEventsParams,
  SearchPage,
} from "./gamma-types";

const DEFAULT_LIMIT = 50;

/**
 * Retry budget for `gammaFetch`. Read the two together — they are a pair.
 *
 * `TOTAL_BUDGET_MS` bounds the WHOLE call including every retry and backoff,
 * not each attempt. The old shape (`MAX_RETRIES = 3`, 8s per attempt) had no
 * total bound at all and could run ~34.5s; see the note on `gammaFetch`.
 */
const MAX_RETRIES = 1;
const TOTAL_BUDGET_MS = 6000;

/**
 * Lists active events with their nested markets, sortable via `order` and
 * narrowable via the `*Min`/`*Max` range filters (FR-2.2).
 *
 * 🚩 A keyset cursor is bound to the sort that produced it. Whatever
 * `order`/`ascending` fetched page 1 must be passed again for page 2 or Gamma
 * returns 422 — including the case of dropping them entirely. Callers that
 * paginate must carry their sort with them; see `/api/markets`.
 */
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
    volume_min: params.volumeMin,
    liquidity_min: params.liquidityMin,
    end_date_min: params.endDateMin,
    end_date_max: params.endDateMax,
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

/**
 * Full-catalogue event search (FR-2.4).
 *
 * 🚩 `/public-search` is a different endpoint from `/events/keyset` with its
 * own vocabulary — verified live 2026-08-15, and none of it is guessable from
 * the listing endpoints:
 *
 * - **`events_status=active` is what excludes resolved markets.** `closed=false`
 *   and `active=true` are accepted and then silently ignored: the same query
 *   returned 3 closed events out of 10 with them set, and 0 with
 *   `events_status=active`. Getting this wrong surfaces resolved 2025 markets
 *   at the top of search with no error anywhere.
 * - **Pagination is `page=N`, 1-based** — there is no cursor. Response carries
 *   `pagination: { hasMore, totalResults }` instead of a `next_cursor`.
 * - **`limit_per_type` clamps at 50**; asking for 100 returns 50.
 * - **Sort and range filters do nothing here.** `order`, `ascending` and
 *   `volume_min` are all ignored — same first result with or without them.
 *
 * Events come back in the same shape as the listing endpoints, nested markets
 * included, so they render through `MarketCard` unchanged.
 */
export async function searchEvents(params: SearchEventsParams): Promise<SearchPage<GammaEvent>> {
  const page = Math.max(1, Math.trunc(params.page ?? 1));
  const query = buildQuery({
    q: params.query,
    limit_per_type: Math.min(params.limit ?? SEARCH_PAGE_SIZE, SEARCH_MAX_LIMIT),
    page,
    events_status: "active",
  });

  const data = await gammaFetch<{
    events?: GammaEvent[];
    pagination?: { hasMore?: boolean; totalResults?: number };
  }>(`/public-search?${query}`);

  return {
    items: data.events ?? [],
    page,
    hasMore: data.pagination?.hasMore ?? false,
    totalResults: data.pagination?.totalResults ?? 0,
  };
}

export type CachedSearchResult =
  | { ok: true; generatedAt: string; items: GammaEvent[]; page: number; hasMore: boolean; totalResults: number }
  | { ok: false; error: string; status: number };

/**
 * Cached search — same ~30-60s policy and the same
 * errors-as-data contract as `getCachedEvents` (a `GammaApiError` thrown
 * across a `"use cache"` boundary stops passing `instanceof`; see that
 * function's note).
 *
 * The query is part of the cache key, so this trades an unbounded key space
 * for repeat-search hits. That's the right way round: popular queries are
 * exactly what a cache should absorb, and the entries expire in five minutes.
 */
export async function getCachedSearch(params: SearchEventsParams): Promise<CachedSearchResult> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag("gamma:search");

  try {
    const page = await searchEvents(params);
    return { ok: true, generatedAt: new Date().toISOString(), ...page };
  } catch (error) {
    if (error instanceof GammaApiError) {
      return { ok: false, error: error.message, status: error.status };
    }
    throw error;
  }
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

/**
 * Comments under an event — the community line in the featured hero.
 *
 * 🚩 The endpoint takes a **numeric event id**, not a slug, and needs both
 * `parent_entity_type=Event` and `parent_entity_id`. Verified live 2026-08-16;
 * it returns a bare array, not the `{events, next_cursor}` envelope the
 * listing routes use.
 *
 * There is no news feed to pair this with: Gamma has no `/news` route (404)
 * and no `news` field on an event. Comments are the only first-party
 * commentary available, which is why the hero shows them where the reference
 * design shows headlines.
 *
 * Returns `[]` on any failure — a missing comment costs the hero one line,
 * and is never worth failing a page render over.
 */
export async function listEventComments(eventId: string, limit = 2): Promise<GammaComment[]> {
  const query = buildQuery({
    parent_entity_type: "Event",
    parent_entity_id: eventId,
    limit,
  });

  try {
    const data = await gammaFetch<GammaComment[]>(`/comments?${query}`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Cached comments — slower-moving than prices, so a longer window than events. */
export async function getCachedEventComments(eventId: string, limit = 2): Promise<GammaComment[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag(`gamma:comments:${eventId}`);

  return listEventComments(eventId, limit);
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

/**
 * 🚩 429 is deliberately NOT retryable.
 *
 * It used to be. Retrying a rate limit is the one response where retrying makes
 * the situation strictly worse: Gamma is asking for fewer requests, and a retry
 * loop answers by multiplying them. Under load that closes into a feedback loop
 * — traffic rises, 429s appear, every request fans out into several more, which
 * produces more 429s. That is the mechanism by which a slow site becomes a down
 * one, and it is worth giving up a rare recovered request to remove it.
 *
 * A 429 now surfaces immediately as a `GammaApiError`, which `getCachedEvents`
 * already converts to `{ok: false}` and the UI already renders as its error box.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt + Math.random() * 150;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a **whole-call** budget and one retry on 5xx / network errors.
 *
 * 🚩 The budget is per call, not per attempt, and that distinction is the whole
 * point of this function's shape.
 *
 * It previously ran a per-attempt 8s timeout with `MAX_RETRIES = 3`, giving
 * `4 x 8s + backoff ≈ 34.5s` for one logical call — with no ceiling on the
 * total. The homepage fans out several of these across its Suspense boundaries,
 * so the page could stall far past any edge timeout while every individual
 * `AbortController` looked correctly configured. Measured 2026-08-22: homepage
 * first byte 0.03s, last byte up to 26s.
 *
 * `deadline` is computed once, before the loop, and each attempt gets only the
 * time actually remaining. So the caller's worst case is `TOTAL_BUDGET_MS` plus
 * one backoff, whatever happens upstream.
 *
 * For scale: Gamma answers in ~0.11s when healthy (measured the same day, with
 * no rate limiting across a 10-request burst). A 6s budget is ~50x that — it
 * bounds a genuine outage without touching a normal request.
 */
async function gammaFetch<T>(path: string): Promise<T> {
  const url = `${POLYMARKET_ENDPOINTS.gamma}${path}`;
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new GammaApiError(`Gamma ${path} exceeded ${TOTAL_BUDGET_MS}ms budget`, 0, path);
    }

    let shouldRetry = false;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(remaining),
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
    }

    // Only sleep if the backoff still fits inside the budget — otherwise the
    // retry could not run anyway, and sleeping first would spend the caller's
    // remaining time to arrive at the same failure.
    if (shouldRetry) {
      const backoff = backoffMs(attempt);
      if (Date.now() + backoff >= deadline) {
        throw new GammaApiError(`Gamma ${path} exceeded ${TOTAL_BUDGET_MS}ms budget`, 0, path);
      }
      await sleep(backoff);
    }
  }

  throw new GammaApiError(`Gamma ${path} exhausted retries`, 0, path);
}
