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
  /**
   * Short label for one leg of a multi-market event — "David Crowley (D)"
   * where `question` is the full "Will David Crowley win the Wisconsin
   * governor election?". Absent on standalone binary markets.
   */
  groupItemTitle?: string;
  /** Resolution criteria prose — what the "Rules" tab shows, verbatim. */
  description?: string;
  /** Where resolution is verified from, e.g. `https://www.dotabuff.com`. */
  resolutionSource?: string;
  /**
   * JSON-encoded string array like `'["proposed"]'` — same Gamma encoding
   * quirk as `outcomes`, so read it with `parseGammaJsonArray`. Non-empty
   * means UMA has been asked to resolve and the price is no longer a live
   * probability.
   */
  umaResolutionStatuses?: string;
};

/**
 * A comment under an event.
 *
 * Verified live 2026-08-16 against
 * `GET /comments?parent_entity_type=Event&parent_entity_id=45915&limit=2`.
 * `profile.profileImage` is hosted on the same S3 bucket as market icons, so
 * it needs no new CSP or `images.remotePatterns` entry.
 */
export type GammaComment = {
  id: string;
  body: string;
  createdAt: string;
  reactionCount?: number;
  profile?: {
    name?: string;
    pseudonym?: string;
    profileImage?: string;
  };
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
  /**
   * Event-level resolution source. Verified 2026-08-16 to differ from the
   * market's own (an event pointed at a Twitch stream while its market pointed
   * at Dotabuff), so the market's is preferred where both exist.
   */
  resolutionSource?: string;
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

/**
 * Full-catalogue search (FR-2.4), served by Gamma's `/public-search`.
 *
 * 🚩 A different endpoint with a different vocabulary from `/events/keyset` —
 * see `searchEvents`. Page-numbered rather than cursor-based, and it ignores
 * every sort and range-filter param, which is why the discovery UI hides those
 * controls while a search is active.
 */
export type SearchEventsParams = {
  query: string;
  page?: number;
  limit?: number;
};

export type SearchPage<T> = {
  items: T[];
  page: number;
  hasMore: boolean;
  totalResults: number;
};

/** `limit_per_type` is capped at 50 upstream — larger values silently clamp. */
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_PAGE_SIZE = 24;

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

/**
 * Lower `endDate` bound that excludes markets which have already ended —
 * always applied to the browse feed.
 *
 * 🚩 `closed: false` does NOT mean "still tradeable". Gamma leaves expired
 * events open long after their end date, and measured 2026-08-15 that is not a
 * rare edge: the "Ending soon" sort (`order=endDate` ascending) returned
 * **24 of 24 already-ended events** — an entire first page of dead markets,
 * since sorting by soonest end naturally surfaces the oldest expired ones
 * first. Volume sorts were milder (2-3 of 24) but still wrong.
 *
 * Quantised to the hour: same cache-key argument as `endingBefore`, but an
 * hour rather than a day because a market that ended 20 minutes ago should
 * drop out reasonably promptly. 24 cache buckets a day is a small key space.
 *
 * ⚠️ Known cost: this also drops events with no `endDate` at all — measured at
 * 2 per 100, and they can be real (undated esports tournament winners with
 * $1M+ volume). Gamma has no "endDate is null OR in the future" filter, so the
 * choice is between losing those two and shipping a dead "Ending soon" tab.
 * `isLiveEvent` keeps nulls where filtering happens client-side.
 */
export function endingAfter(now: Date = new Date()): string {
  const bound = new Date(now);
  bound.setUTCMinutes(0, 0, 0);
  return bound.toISOString();
}

/**
 * Whether an event is still open, for filtering where the API can't do it —
 * `/public-search` ignores `end_date_min` along with every other filter, so
 * search results are filtered here instead (~1 in 20 come back ended).
 *
 * Unlike `endingAfter`, this keeps events with no `endDate`: filtering in
 * memory can express "undated or future", which the API query cannot.
 */
export function isLiveEvent(event: Pick<GammaEvent, "endDate" | "closed">, now: Date = new Date()): boolean {
  if (event.closed) return false;
  if (!event.endDate) return true;

  const end = Date.parse(event.endDate);
  return Number.isNaN(end) || end >= now.getTime();
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

/** One row of an event's outcome list — what the hero and cards rank on. */
export type RankedOutcome = {
  label: string;
  /** 0-100, rounded. `null` when Gamma gave no usable price. */
  pct: number | null;
  /** CLOB token for this outcome's "yes" side — the series a chart plots. */
  tokenId: string | null;
};

/**
 * An event's outcomes, best-priced first.
 *
 * Gamma models the same idea two different ways and the caller shouldn't have
 * to care which:
 *
 * - **Binary event** (one market): the outcomes are that market's own
 *   `["Yes","No"]`, priced by `outcomePrices`.
 * - **Multi-outcome event** (many markets): each *market* is an outcome —
 *   "Democratic Presidential Nominee 2028" holds 128 of them — labelled by
 *   `groupItemTitle` and priced by `snapshotPrice`.
 *
 * Same browse-snapshot caveat as `snapshotPrice`: fine to rank and display,
 * never to fill an order against.
 *
 * 🚩 **Legs settle individually, long before the event does.** Verified live
 * 2026-08-16 on "Israel x Iran ceasefire continues through…?": 17 of its 22
 * markets were `closed: true` with `acceptingOrders: false` and a price of
 * exactly 1, while the event itself was open with an end date two weeks out.
 * Ranking without filtering put three settled legs at 100% at the top —
 * dead markets presented as the headline. Note `active` is useless here: it
 * was `true` on every one of them. `closed` is the flag that separates them.
 */
export function rankEventOutcomes(event: Pick<GammaEvent, "markets">): RankedOutcome[] {
  const markets = event.markets ?? [];
  if (markets.length === 0) return [];

  const tradeable = markets.filter((market) => market.closed !== true);
  if (tradeable.length === 0) return [];

  // Binary-vs-multi is decided on the ORIGINAL market count, not the filtered
  // one. A 22-leg event with 21 settled legs is still a multi-outcome event;
  // reading its lone survivor as a Yes/No pair would relabel "August 31" as
  // "Yes".
  const rows: RankedOutcome[] =
    markets.length === 1
      ? binaryOutcomes(tradeable[0])
      : tradeable.map((market) => {
          const price = snapshotPrice(market);
          return {
            label: market.groupItemTitle ?? market.question,
            pct: price !== null ? Math.round(price * 100) : null,
            tokenId: outcomeTokens(market)[0]?.tokenId ?? null,
          };
        });

  return rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

function binaryOutcomes(market: GammaMarket): RankedOutcome[] {
  const labels = parseGammaJsonArray<string>(market.outcomes);
  const prices = outcomePriceFractions(market);
  const tokens = outcomeTokens(market);

  // Falls back to the market's own question when `outcomes` is missing or
  // unparseable — better a labelled single row than an empty outcome list.
  if (labels.length === 0) {
    const price = snapshotPrice(market);
    return [
      {
        label: market.groupItemTitle ?? market.question,
        pct: price !== null ? Math.round(price * 100) : null,
        // Read straight off `clobTokenIds` rather than through `outcomeTokens`:
        // that helper returns nothing when it can't pair labels to tokens, so
        // a market with a corrupt `outcomes` string would lose a token id it
        // demonstrably has — and with it, its chart line. Index 0 is the "yes"
        // side by Gamma's own ordering, the same assumption `snapshotPrice`
        // already makes about `outcomePrices[0]`.
        tokenId: parseGammaJsonArray<string>(market.clobTokenIds)[0] ?? null,
      },
    ];
  }

  return labels.map((label, index) => {
    const price = prices[index];
    return {
      label,
      pct: Number.isFinite(price) ? Math.round(price * 100) : null,
      tokenId: tokens[index]?.tokenId ?? null,
    };
  });
}
