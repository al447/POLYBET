import { shortenAddress } from "@/lib/format";

/**
 * Trader leaderboard shapes and presets — deliberately NOT `server-only`,
 * mirroring the `gamma-types.ts` / `gamma.ts` split.
 *
 * `leaderboard.ts` (the fetch client) IS `server-only`, but the /leaderboard
 * page re-fetches in the browser when the user switches period or ordering, so
 * the tab component needs these ids and `traderDisplayName` without dragging
 * `server-only`'s throwing guard into the client bundle.
 */

/**
 * One row of the leaderboard, normalised.
 *
 * Named for what the UI shows, not what the wire calls it: the API's
 * `proxyWallet` / `vol` become `address` / `volume`. The raw `userName` never
 * escapes the parser — see `traderDisplayName` for why.
 */
export type LeaderboardTrader = {
  rank: number;
  address: string;
  name: string;
  avatar?: string;
  verified: boolean;
  /** Profit and loss in pUSD for the selected period. Can be negative. */
  pnl: number;
  /** Traded notional in pUSD for the selected period. Genuinely 0 for some top-PnL traders. */
  volume: number;
};

/**
 * Leaderboard windows.
 *
 * 🚩 The query parameter is **`timePeriod`**, and `window` is not a parameter
 * at all. Verified live 2026-08-17: passing `window=1w` is accepted, silently
 * ignored, and returns the `DAY` default — so a "this week" board would quietly
 * be showing today's numbers with no error anywhere. Values are the exact
 * enum from `docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings.md`
 * and each was confirmed to return a genuinely different set of traders.
 *
 * Ids travel as one opaque token, same discipline as `EVENT_SORTS` and
 * `PRICE_RANGES` — a caller must not be able to hand us a `timePeriod` string
 * nobody verified, and a closed set keeps the `getCachedLeaderboard` key space
 * to a handful of entries.
 */
export const LEADERBOARD_PERIODS = [
  { id: "1d", label: "Today", timePeriod: "DAY" },
  { id: "1w", label: "This week", timePeriod: "WEEK" },
  { id: "1m", label: "This month", timePeriod: "MONTH" },
  { id: "all", label: "All time", timePeriod: "ALL" },
] as const satisfies readonly { id: string; label: string; timePeriod: string }[];

export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];
export type LeaderboardPeriodId = LeaderboardPeriod["id"];

/** The copy-trade page advertises "Top traders this week", so the week is the default everywhere. */
export const DEFAULT_PERIOD_ID: LeaderboardPeriodId = "1w";

/** What the board is ranked by. `PNL` and `VOL` are the only two values the API accepts. */
export const LEADERBOARD_ORDERINGS = [
  { id: "pnl", label: "Profit", orderBy: "PNL" },
  { id: "volume", label: "Volume", orderBy: "VOL" },
] as const satisfies readonly { id: string; label: string; orderBy: string }[];

export type LeaderboardOrdering = (typeof LEADERBOARD_ORDERINGS)[number];
export type LeaderboardOrderingId = LeaderboardOrdering["id"];

export const DEFAULT_ORDERING_ID: LeaderboardOrderingId = "pnl";

/** The API's own ceiling — asking for 51 returns 50 (verified live 2026-08-17). */
export const LEADERBOARD_MAX_LIMIT = 50;

// Looked up by id, not by index, so reordering the tabs can never silently
// change what an unrecognised value falls back to.
const DEFAULT_PERIOD: LeaderboardPeriod =
  LEADERBOARD_PERIODS.find((period) => period.id === DEFAULT_PERIOD_ID) ?? LEADERBOARD_PERIODS[0];

const DEFAULT_ORDERING: LeaderboardOrdering =
  LEADERBOARD_ORDERINGS.find((ordering) => ordering.id === DEFAULT_ORDERING_ID) ??
  LEADERBOARD_ORDERINGS[0];

export function isPeriodId(value: string): value is LeaderboardPeriodId {
  return LEADERBOARD_PERIODS.some((period) => period.id === value);
}

export function isOrderingId(value: string): value is LeaderboardOrderingId {
  return LEADERBOARD_ORDERINGS.some((ordering) => ordering.id === value);
}

/** Resolves a wire value to a period, falling back to the default on anything unrecognised. */
export function resolvePeriod(id: string | null | undefined): LeaderboardPeriod {
  return LEADERBOARD_PERIODS.find((period) => period.id === id) ?? DEFAULT_PERIOD;
}

export function resolveOrdering(id: string | null | undefined): LeaderboardOrdering {
  return LEADERBOARD_ORDERINGS.find((ordering) => ordering.id === id) ?? DEFAULT_ORDERING;
}

/**
 * Best available name for a trader — the leaderboard's counterpart to
 * `displayName` in `market-social.ts`, which reads a different set of fields
 * (`name` / `pseudonym` / `displayUsernamePublic`) off a different endpoint.
 *
 * 🚩 Two shapes have to be caught here, both measured on a 50-row sample
 * 2026-08-17. `userName` is **empty** on some rows, and on others it is the
 * account's own address with a creation timestamp glued on:
 * `0x3DFb153c197D4C19D3B31c1ecD2c7B6860eeabAf-1722957908185`. That is
 * Polymarket's placeholder for an account that never picked a name. Rendering
 * it verbatim overflows the card and tells the reader nothing the (much
 * shorter) address doesn't.
 */
export function traderDisplayName(userName: string | undefined, address: string): string {
  const name = (userName ?? "").trim();
  if (!name || name.toLowerCase().startsWith("0x")) return shortenAddress(address);
  return name;
}
