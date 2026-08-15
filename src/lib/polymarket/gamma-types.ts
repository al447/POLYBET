/**
 * Gamma API types + pure parsing helpers — deliberately NOT `server-only`.
 *
 * `gamma.ts` (the actual fetch client) IS `server-only`, but its types and the
 * `outcomes`/`outcomePrices` JSON-string parser are needed by client
 * components too (e.g. the discovery grid, which fetches `/api/markets`
 * client-side for pagination/filtering and renders cards from the result).
 * Importing gamma.ts there would drag `server-only`'s throwing guard into the
 * browser bundle. This file is the shape both sides can safely depend on.
 */

export class GammaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "GammaApiError";
  }
}

export type GammaTag = {
  id: string;
  label: string | null;
  slug: string | null;
};

/**
 * Curated top-level categories for the discovery grid's filter chips — NOT
 * derived from Gamma's `/tags` listing at request time. Two dynamic
 * approaches were tried and rejected 2026-08-07:
 *   1. The unfiltered `/tags` list returns hundreds of narrow per-event
 *      sub-tags ("keith gill", "product marekt fit", "virgins" — real
 *      examples), most with zero currently-active markets.
 *   2. `is_carousel: true` narrowed it to essentially one tag ("ai") — too
 *      sparse to be a category nav.
 * Every ID below was verified live via `GET /tags/slug/{slug}` on
 * 2026-08-07 (not guessed) — low IDs (Politics=2, Sports=1, Crypto=21, ...)
 * confirm these are foundational tags, not recent additions — and
 * `tag_id`-filtered event queries were spot-checked to return real,
 * currently-active markets. Trades "fully dynamic" for "reliably shows
 * content when clicked"; revisit if a better live signal for "these are the
 * real top-level categories" turns up.
 */
export const TOP_CATEGORIES: GammaTag[] = [
  { id: "2", label: "Politics", slug: "politics" },
  { id: "1", label: "Sports", slug: "sports" },
  { id: "21", label: "Crypto", slug: "crypto" },
  { id: "596", label: "Culture", slug: "pop-culture" },
  { id: "315", label: "Entertainment", slug: "entertainment" },
  { id: "107", label: "Business", slug: "business" },
  { id: "100328", label: "Economy", slug: "economy" },
  { id: "1401", label: "Tech", slug: "tech" },
  { id: "74", label: "Science", slug: "science" },
  { id: "144", label: "Elections", slug: "elections" },
  { id: "100265", label: "Geopolitics", slug: "geopolitics" },
  { id: "101970", label: "World", slug: "world" },
];

/**
 * Practical subset of the Market object — Gamma returns several dozen
 * fields (volume/liquidity broken down by window and venue, UMA resolution
 * status, sports metadata, fee schedule, ...). Extend as new fields are
 * actually needed rather than mirroring the full schema.
 */
export type GammaMarket = {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  /** JSON-encoded string array, e.g. `'["Yes","No"]'` — see `parseGammaJsonArray`. */
  outcomes: string;
  /** JSON-encoded string array of decimal prices, same encoding as `outcomes`. */
  outcomePrices: string;
  /** JSON-encoded string array of CLOB token IDs. Present on single-market fetches. */
  clobTokenIds?: string;
  volume: string;
  volumeNum: number;
  liquidity: string;
  liquidityNum: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  startDate?: string;
  endDate?: string;
  category?: string;
  image?: string;
  icon?: string;
  tags?: GammaTag[];
};

export type GammaEvent = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  image?: string;
  icon?: string;
  startDate?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  featured?: boolean;
  liquidity?: number;
  volume?: number;
  category?: string;
  tags?: GammaTag[];
  markets: GammaMarket[];
};

export type KeysetPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ListEventsParams = {
  cursor?: string;
  limit?: number;
  tagId?: number;
  active?: boolean;
  closed?: boolean;
  featured?: boolean;
  order?: string;
  ascending?: boolean;
  volumeMin?: number;
  liquidityMin?: number;
  endDateMin?: string;
  endDateMax?: string;
};

/** Finds an option by id, falling back to the first (always the "no-op" one). */
function resolveOption<T extends { id: string }>(options: readonly T[], id: string | null | undefined): T {
  return options.find((option) => option.id === id) ?? options[0];
}

function hasOptionId(options: readonly { id: string }[], value: string): boolean {
  return options.some((option) => option.id === value);
}

/**
 * Discovery sort options (FR-2.2).
 *
 * Each entry pairs a Gamma `order` value with the `ascending` that makes it
 * mean what its label says — "Ending soon" is `endDate` ASC, everything else
 * is DESC. They travel together deliberately: `/api/markets` takes a sort
 * *id*, never a raw `order`/`ascending` pair, so a caller cannot request
 * `endDate` DESC ("furthest away first") or otherwise split the two apart.
 *
 * All five probed live against `/events/keyset` on 2026-08-15 and confirmed to
 * change the result order, not merely return 200. Every one paginates — but
 * only if the cursor is replayed under the same sort it was generated with;
 * see the binding note in `listEvents`.
 */
export const EVENT_SORTS = [
  { id: "top", label: "Top", order: "volume", ascending: false },
  { id: "trending", label: "Trending", order: "volume24hr", ascending: false },
  { id: "liquidity", label: "Most liquid", order: "liquidity", ascending: false },
  { id: "ending", label: "Ending soon", order: "endDate", ascending: true },
  { id: "new", label: "Newest", order: "startDate", ascending: false },
] as const;

export type EventSort = (typeof EVENT_SORTS)[number];
export type EventSortId = EventSort["id"];

export const DEFAULT_SORT_ID: EventSortId = "top";

/** Resolves a wire value to a sort, falling back to the default on anything unrecognised. */
export function resolveSort(id: string | null | undefined): EventSort {
  return resolveOption(EVENT_SORTS, id);
}

/** Narrows an arbitrary string to a known sort id — for validating query params. */
export function isEventSortId(value: string): value is EventSortId {
  return hasOptionId(EVENT_SORTS, value);
}

/**
 * Range filters (FR-2.2's "volume, liquidity, end date").
 *
 * Presets rather than free-form numeric inputs, following the same reasoning
 * as the GTD expiry durations in config.ts: a small closed set is easier to
 * use, impossible to send nonsense through, and — the part that matters here —
 * keeps the `getCachedEvents` key space small. Arbitrary numbers would give
 * nearly every request its own cache entry and quietly undo FR-2.5's edge
 * caching.
 *
 * `volume_min` / `liquidity_min` / `end_date_max` were all confirmed to
 * actually filter (not just return 200) against `/events/keyset` on
 * 2026-08-15. The first option of each is the no-op and must stay first —
 * `resolveOption` falls back to it.
 */
export const VOLUME_FILTERS = [
  { id: "any", label: "Any", min: undefined },
  { id: "100k", label: "$100k+", min: 100_000 },
  { id: "1m", label: "$1M+", min: 1_000_000 },
] as const;

export const LIQUIDITY_FILTERS = [
  { id: "any", label: "Any", min: undefined },
  { id: "50k", label: "$50k+", min: 50_000 },
  { id: "500k", label: "$500k+", min: 500_000 },
] as const;

export const ENDING_FILTERS = [
  { id: "any", label: "Any", days: undefined },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
] as const;

export type VolumeFilterId = (typeof VOLUME_FILTERS)[number]["id"];
export type LiquidityFilterId = (typeof LIQUIDITY_FILTERS)[number]["id"];
export type EndingFilterId = (typeof ENDING_FILTERS)[number]["id"];

export const DEFAULT_FILTER_ID = "any";

export function resolveVolumeFilter(id: string | null | undefined) {
  return resolveOption(VOLUME_FILTERS, id);
}

export function resolveLiquidityFilter(id: string | null | undefined) {
  return resolveOption(LIQUIDITY_FILTERS, id);
}

export function resolveEndingFilter(id: string | null | undefined) {
  return resolveOption(ENDING_FILTERS, id);
}

export function isVolumeFilterId(value: string): value is VolumeFilterId {
  return hasOptionId(VOLUME_FILTERS, value);
}

export function isLiquidityFilterId(value: string): value is LiquidityFilterId {
  return hasOptionId(LIQUIDITY_FILTERS, value);
}

export function isEndingFilterId(value: string): value is EndingFilterId {
  return hasOptionId(ENDING_FILTERS, value);
}

/**
 * Upper `endDate` bound for an "ending within N days" filter, as an ISO string.
 *
 * 🚩 Quantised to the end of the UTC day, deliberately. The obvious
 * implementation — `now + N days` to the millisecond — gives every single
 * request a unique `end_date_max`, so every request becomes its own
 * `getCachedEvents` entry and the ~60s cache stops doing anything. Rounding to
 * a day boundary makes the whole day share one key, and "ending within 7 days"
 * is not a claim anyone reads to the second.
 *
 * `now` is a parameter so this stays pure and testable, matching
 * `computeGtdExpiration` in config.ts.
 */
export function endingBefore(days: number, now: Date = new Date()): string {
  const bound = new Date(now);
  bound.setUTCDate(bound.getUTCDate() + days);
  bound.setUTCHours(23, 59, 59, 999);
  return bound.toISOString();
}

export type ListMarketsParams = {
  cursor?: string;
  limit?: number;
  tagId?: number;
  active?: boolean;
  closed?: boolean;
  order?: string;
  ascending?: boolean;
};

/** Parses Gamma's JSON-encoded-string array fields (`outcomes`, `outcomePrices`, `clobTokenIds`). */
export function parseGammaJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/** `{ label, tokenId }` per outcome, e.g. `[{label:"Yes",tokenId:"123"},{label:"No",tokenId:"456"}]`. */
export type OutcomeToken = { label: string; tokenId: string };

/**
 * Pairs `outcomes` with `clobTokenIds` positionally — Gamma returns them as
 * two same-length JSON-string arrays, index-aligned. Empty if either is
 * missing or the lengths disagree (defensive: a market Gamma hasn't fully
 * indexed yet, or one fetched without `clobTokenIds` — see that field's doc).
 */
export function outcomeTokens(market: GammaMarket): OutcomeToken[] {
  const labels = parseGammaJsonArray<string>(market.outcomes);
  const tokenIds = parseGammaJsonArray<string>(market.clobTokenIds);
  if (labels.length === 0 || labels.length !== tokenIds.length) return [];
  return labels.map((label, i) => ({ label, tokenId: tokenIds[i] }));
}

/**
 * A single 0-1 snapshot price for a market's *first* outcome — the same
 * "good enough to browse by, not to trade at" snapshot described in
 * gamma.ts's header. `bestBid === 0 && bestAsk === 1` shows up on
 * closed/no-liquidity markets in observed data — treated as "no real quote,"
 * falling back to the last outcome price. Inferred from a small sample, not
 * documented by Polymarket; revisit if it misfires on a real
 * illiquid-but-open market.
 */
export function snapshotPrice(market: GammaMarket): number | null {
  const { bestBid, bestAsk } = market;
  const hasRealQuote =
    typeof bestBid === "number" && typeof bestAsk === "number" && !(bestBid === 0 && bestAsk === 1);
  if (hasRealQuote) return (bestBid + bestAsk) / 2;

  const [firstPrice] = parseGammaJsonArray<string>(market.outcomePrices);
  const parsed = firstPrice ? Number(firstPrice) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 0-1 price per outcome, index-aligned with `outcomeTokens`. Reads
 * `outcomePrices` directly rather than deriving the second entry as `1 -
 * first` — observed live data shows Yes+No cents summing to slightly over
 * 100 (e.g. 8.9¢ + 92.3¢), confirming they're independent order-book-derived
 * quotes, not exact complements. Same "browse-by snapshot, not a live quote"
 * caveat as `snapshotPrice`.
 */
export function outcomePriceFractions(market: GammaMarket): number[] {
  return parseGammaJsonArray<string>(market.outcomePrices)
    .map((raw) => Number(raw))
    .map((n) => (Number.isFinite(n) ? n : NaN));
}
