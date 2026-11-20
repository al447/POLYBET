import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { POLYMARKET_ENDPOINTS } from "./config";
import {
  LEADERBOARD_MAX_LIMIT,
  resolveOrdering,
  resolvePeriod,
  traderDisplayName,
} from "./leaderboard-types";
import type {
  LeaderboardOrderingId,
  LeaderboardPeriodId,
  LeaderboardTrader,
} from "./leaderboard-types";

/**
 * Public trader leaderboard — who is up the most, and by how much.
 *
 * 🚩 Data API v1 was retired 2026-11-02 — `/v1/leaderboard` is now a 410.
 * Re-verified live 2026-11-19 against `data-api.polymarket.com/v2/openapi.json`:
 *
 * ```
 * GET /v2/leaderboard?time_period=week&sort_by=PNL&limit=6
 *   → { data: [{ rank:1, user_id:"0x2ecb…ecb8", user_name:"DrSlips", x_username:"",
 *                verified:false, volume:617375.14, pnl:1555271.92, profile_image:"" }],
 *       pagination: { limit, has_more, next_cursor } }
 * ```
 *
 * v2 pages by opaque cursor only and **400s on `offset`, even `offset=0`**, so
 * nothing here sends one. Both consumers only ever want page 1.
 *
 * Server-side only, same rule as `gamma.ts` and `market-social.ts`: browsing
 * traffic stays off the user's IP and the results stay edge-cached.
 *
 * Wire quirks the parser below absorbs:
 *
 *  - **`profile_image` is empty on most rows.** A letter-avatar fallback is
 *    the normal case, not the edge case. The few that exist are all on the
 *    `polymarket-upload` S3 bucket already allowed by `next.config.ts`.
 *  - **`volume` is genuinely 0** for several top-PnL traders on the week board.
 *    That is real data, not a missing field — the row still belongs on the
 *    board and should read `$0`.
 *
 * ⚠️ Nothing here may inform an order. These are period-aggregated P&L
 * rankings refreshed on a five-minute cache; they are not a price feed, and
 * "this trader is up" says nothing about what a market is tradeable at.
 */

/** 6s, matching `gammaFetch`'s whole-call budget. No retries, so this is the worst case. */
const REQUEST_TIMEOUT_MS = 6000;

export type LeaderboardParams = {
  periodId?: LeaderboardPeriodId;
  orderingId?: LeaderboardOrderingId;
  limit?: number;
};

/** Returns `null` rather than throwing — the caller decides how loud the failure is. */
async function dataApiFetch<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${POLYMARKET_ENDPOINTS.data}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Top traders for one period and ordering.
 *
 * Period and ordering arrive as **ids**, never as raw `time_period`/`sort_by`
 * strings — see `leaderboard-types.ts` for why that boundary matters here
 * specifically (`window=` is silently ignored by this endpoint, so a wrong
 * parameter name produces plausible data for the wrong window rather than an
 * error).
 */
export async function fetchLeaderboard(
  params: LeaderboardParams = {},
): Promise<LeaderboardTrader[]> {
  const period = resolvePeriod(params.periodId);
  const ordering = resolveOrdering(params.orderingId);
  const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 25)), LEADERBOARD_MAX_LIMIT);

  const query = new URLSearchParams({
    time_period: period.timePeriod,
    sort_by: ordering.sortBy,
    limit: String(limit),
  });

  const payload = await dataApiFetch<{ data?: unknown }>(`/v2/leaderboard?${query.toString()}`);
  const data = payload?.data;
  if (!Array.isArray(data)) return [];

  const traders: LeaderboardTrader[] = [];
  data.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const row = entry as Record<string, unknown>;

    const address = typeof row.user_id === "string" ? row.user_id : null;
    if (!address) return;

    const parsedRank = Number(row.rank);
    const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : index + 1;

    traders.push({
      rank,
      address,
      name: traderDisplayName(
        typeof row.user_name === "string" ? row.user_name : undefined,
        address,
      ),
      avatar:
        typeof row.profile_image === "string" && row.profile_image ? row.profile_image : undefined,
      verified: row.verified === true,
      pnl: toNumber(row.pnl),
      volume: toNumber(row.volume),
    });
  });

  return traders;
}

function toNumber(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : 0;
}

export type CachedLeaderboardResult =
  | { ok: true; generatedAt: string; traders: LeaderboardTrader[] }
  | { ok: false; error: string };

/**
 * Cached leaderboard.
 *
 * Five-minute revalidate, deliberately longer than the 60s on market data: a
 * period-aggregated P&L ranking barely moves inside a minute, and the whole
 * point of the proxy is that one shared fetch serves every visitor. Same
 * policy as `getCachedTopHolders`.
 *
 * Errors come back as data rather than thrown, for the reason documented on
 * `getCachedEvents`: an Error thrown from inside a `"use cache"` function
 * reaches the caller as a different object and no longer passes `instanceof`,
 * so a caller's `catch` misses it and it surfaces as an unhandled 500 instead
 * of the clean failure the UI wanted to render.
 */
export async function getCachedLeaderboard(
  params: LeaderboardParams = {},
): Promise<CachedLeaderboardResult> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag("data:leaderboard");

  try {
    const traders = await fetchLeaderboard(params);
    return { ok: true, generatedAt: new Date().toISOString(), traders };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}
