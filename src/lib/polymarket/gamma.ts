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

/**
 * 🚩 What a *browse* cache entry is allowed to carry.
 *
 * Measured 2026-08-23 on the live `/api/markets` response: **6.80 MB** for 50
 * events, holding 1,619 nested markets. Gamma returns **88 keys per market**;
 * this file declares types for **29**. The other 59 are unreadable by any
 * TypeScript consumer and were being stored, transferred and parsed on every
 * render regardless.
 *
 * That payload is the reason the homepage sat at its 8s hero ceiling: Gamma
 * itself answered in 0.07–0.55s while our cached layer took 1.46–3.56s for the
 * same data. The cost is R2 transfer and JSON parse, not the upstream fetch.
 *
 * `true` = keep, `false` = drop. Typing these as `Record<keyof …, boolean>` is
 * the load-bearing part: **adding a field to `GammaMarket` or `GammaEvent`
 * without deciding here is a compile error**, which is what stops this drifting
 * back into "store everything". A dropped field surfaces as *missing content*
 * rather than an error, so the compiler has to be the thing that catches it.
 *
 * ⚠️ Applies to the **list** caches only — `getCachedEvents` and
 * `getCachedSearch`. `getCachedEventBySlug` is deliberately untouched: it feeds
 * the detail page beside the order ticket, and `MarketRules` / `MarketFaq` read
 * exactly the two prose fields dropped below.
 */
const LIST_MARKET_FIELDS: Record<keyof GammaMarket, boolean> = {
  id: true,
  conditionId: true,
  slug: true,
  question: true,
  outcomes: true,
  outcomePrices: true,
  clobTokenIds: true,
  volume: true,
  volumeNum: true,
  liquidity: true,
  liquidityNum: true,
  bestBid: true,
  bestAsk: true,
  lastTradePrice: true,
  active: true,
  closed: true,
  archived: true,
  startDate: true,
  endDate: true,
  category: true,
  image: true,
  icon: true,
  tags: true,
  groupItemTitle: true,
  sportsMarketType: true,
  acceptingOrders: true,
  umaResolutionStatuses: true,
  // Prose, ~1.6 KB per market and 1,619 markets to a page — the single
  // heaviest field in the payload. Read only by MarketRules/MarketFaq on
  // /market/[slug], which is served by getCachedEventBySlug, not this cache.
  description: false,
  resolutionSource: false,
};

/** Event-level fields. Everything is kept — the weight is all in `markets`. */
const LIST_EVENT_FIELDS: Record<keyof GammaEvent, boolean> = {
  id: true,
  slug: true,
  title: true,
  description: true,
  image: true,
  icon: true,
  startDate: true,
  endDate: true,
  active: true,
  closed: true,
  archived: true,
  featured: true,
  liquidity: true,
  volume: true,
  category: true,
  resolutionSource: true,
  tags: true,
  markets: true,
};

const keptKeys = <T extends object>(fields: Record<keyof T, boolean>) =>
  (Object.keys(fields) as (keyof T)[]).filter((key) => fields[key]);

const LIST_MARKET_KEYS = keptKeys<GammaMarket>(LIST_MARKET_FIELDS);
const LIST_EVENT_KEYS = keptKeys<GammaEvent>(LIST_EVENT_FIELDS);

/**
 * Detail keeps every **declared** key, including the two prose fields browse
 * drops — `MarketRules` and `MarketFaq` read them. What it sheds is the 58 keys
 * Gamma sends that this file never declares, which no TypeScript consumer can
 * read by definition. Measured at ~52% of the raw payload.
 *
 * Derived from the same maps rather than a second pair, so adding a field to
 * `GammaMarket` flows here automatically while still forcing an explicit
 * keep-or-drop decision for browse.
 */
const DETAIL_MARKET_KEYS = Object.keys(LIST_MARKET_FIELDS) as (keyof GammaMarket)[];
const DETAIL_EVENT_KEYS = Object.keys(LIST_EVENT_FIELDS) as (keyof GammaEvent)[];

/**
 * 🚩 Reads the kept keys directly instead of rebuilding every key.
 *
 * The previous shape was `Object.entries -> filter -> Object.fromEntries`, which
 * for a browse page meant ~137,000 key-value pairs allocated, filtered and
 * rebuilt (1,579 nested markets x 87 keys) to keep 24 of them. This touches only
 * the keys it keeps.
 *
 * The `undefined` check reproduces the old behaviour exactly: `Object.entries`
 * only yields keys actually present, so a field Gamma omitted stayed omitted.
 * (JSON never produces a present-but-undefined value, so nothing else changes.)
 * Output key order now follows our declaration rather than Gamma's, which
 * affects serialised byte order and nothing else.
 *
 * ⚠️ The cast stays INSIDE this helper. At a call site it would weaken the
 * `Record<keyof GammaMarket, boolean>` guard on the field maps above, which is
 * what makes adding an undecided field a build failure.
 */
function pickKeys<T extends object>(source: T, keys: readonly (keyof T)[]): T {
  const out = {} as T;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Narrows one event to the browse shape. Called **inside** the `"use cache"`
 * functions so the trimmed object is what gets written to R2 — projecting
 * after the cache boundary would save the render nothing.
 *
 * Exported for `gamma.test.ts`: a dropped field shows up as missing content on
 * a card rather than as an error, so this is pinned directly rather than
 * inferred from a route test.
 */
export function projectEventForList(event: GammaEvent): GammaEvent {
  const projected = pickKeys(event, LIST_EVENT_KEYS);
  projected.markets = (event.markets ?? []).map((market) => pickKeys(market, LIST_MARKET_KEYS));
  return projected;
}

/**
 * Narrows one event to the detail shape — everything declared, nothing else.
 *
 * Separate from `projectEventForList` because the detail page genuinely reads
 * `description`/`resolutionSource` and a browse card does not. Both drop the
 * undeclared majority; only this one keeps the prose.
 *
 * Exported for `gamma.test.ts` for the same reason as its browse sibling: the
 * failure mode is missing content, not an error.
 */
export function projectEventForDetail(event: GammaEvent): GammaEvent {
  const projected = pickKeys(event, DETAIL_EVENT_KEYS);
  projected.markets = (event.markets ?? []).map((market) => pickKeys(market, DETAIL_MARKET_KEYS));
  return projected;
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
 * exactly what a cache should absorb.
 */
export async function getCachedSearch(params: SearchEventsParams): Promise<CachedSearchResult> {
  "use cache";
  // `revalidate` raised 60 -> 300 on 2026-08-23, same reasoning as
  // `getCachedEvents` below — see the note there.
  cacheLife({ stale: 30, revalidate: 300, expire: 1800 });
  cacheTag("gamma:search");

  try {
    const page = await searchEvents(params);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      ...page,
      items: page.items.map(projectEventForList),
    };
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

/**
 * Cached event-by-slug — the market detail page.
 *
 * Deliberately keeps the tight `{30, 60, 300}` window that the browse caches
 * moved off: this one sits beside the order ticket, so a stale event here is a
 * different class of wrong from a stale browse card.
 *
 * Projected since 2026-08-23, but through `projectEventForDetail` rather than
 * the browse projection — it keeps every declared field including the two prose
 * ones `MarketRules`/`MarketFaq` read, and drops only the keys nothing can read.
 */
export async function getCachedEventBySlug(slug: string): Promise<GammaEvent | null> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag(`gamma:event:${slug}`);

  const event = await getEventBySlug(slug);
  return event === null ? null : projectEventForDetail(event);
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
  // `expire` raised 300 -> 1800 on 2026-08-23. Past `expire` an entry is GONE
  // and the next visitor blocks on a live refetch — which at this traffic
  // level (bursty, with long gaps between sessions) was most of them, and is
  // what produced the quiet-hour 504 bursts. `stale`/`revalidate` are
  // unchanged, so content still refreshes every 60s under traffic; the only
  // difference is that a cold gap now serves stale instead of blocking.
  //
  // Trade-off: during an upstream outage a browse card can show a 30-minute-old
  // price. Acceptable because nothing trades against these numbers — the order
  // book and trading panel read live CLOB data in the browser. Note
  // getCachedEventBySlug deliberately stays at 300 for exactly that reason.
  // 🚩 `revalidate` raised 60 -> 300 on 2026-08-23. Read this with the
  // `expire` note above — they were changed for related but distinct reasons.
  //
  // `expire` governs what happens when an entry is GONE. `revalidate` governs
  // how often a live one is rebuilt, and with no `queue` configured in
  // open-next.config.ts that rebuild runs **inside a visitor's request**. At 60s
  // roughly one visitor a minute per cache key paid a full rebuild — Gamma
  // fetch, multi-megabyte JSON parse, projection, R2 write — and on the home
  // page that reliably blew through `DISCOVERY_BUDGET_MS`, so every request
  // fell back to the client-rendered grid. 300s cuts that fivefold.
  //
  // Trade-off: a browse card can be up to 5 minutes old on the normal path,
  // where before it was 1. Same justification as `expire` — nothing trades
  // against these numbers; the order book and trading panel read live CLOB
  // data in the browser. `getCachedEventBySlug` deliberately keeps its 60s
  // because it sits next to the order ticket.
  //
  // ⚠️ If `memoryQueue` is ever restored, revisit this: the pressure to keep
  // rebuilds rare comes from them being on the request path at all.
  cacheLife({ stale: 30, revalidate: 300, expire: 1800 });
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
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      ...page,
      items: page.items.map(projectEventForList),
    };
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
