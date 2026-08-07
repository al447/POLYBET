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
};

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
