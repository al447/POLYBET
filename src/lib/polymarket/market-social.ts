import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { POLYMARKET_ENDPOINTS } from "./config";

/**
 * Public per-market social data: who holds it, and what just traded.
 *
 * Verified live 2026-08-16 against `data-api.polymarket.com`. Both take a
 * **condition id**, not a slug or a token id:
 *
 * ```
 * GET /holders?market=<conditionId>&limit=N
 *   → [{ token, holders: [{ proxyWallet, name, pseudonym, amount, outcomeIndex, profileImage, … }] }]
 *     one entry per token, so a binary market returns two
 *
 * GET /trades?market=<conditionId>&limit=N
 *   → [{ proxyWallet, side, outcome, outcomeIndex, size, price, timestamp, transactionHash, name, pseudonym, … }]
 * ```
 *
 * 🚩 The neighbouring `/positions` and `/activity` endpoints are **per-user,
 * not per-market** — both 400 with `required query param 'user' not provided`.
 * That is why the "Positions" tab is the signed-in user's own positions rather
 * than everyone's, and why it can't be server-rendered with these.
 *
 * Server-side only, same rule as `gamma.ts`: browsing traffic stays off the
 * user's IP and the results stay edge-cached.
 */

export type MarketHolder = {
  address: string;
  name: string;
  avatar?: string;
  /** Share count, not dollars — the API calls it `amount`. */
  shares: number;
  outcomeIndex: number;
};

export type MarketTrade = {
  key: string;
  address: string;
  name: string;
  avatar?: string;
  side: "BUY" | "SELL";
  outcome: string;
  shares: number;
  /** 0-1. Multiply by `shares` for the notional. */
  price: number;
  /** Unix seconds. */
  timestamp: number;
  transactionHash?: string;
};

/** 6s, matching `gammaFetch`'s whole-call budget. No retries, so this is the worst case. */
const REQUEST_TIMEOUT_MS = 6000;

/** Both readers return `[]` rather than throwing — these are side panels, not the page. */
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
 * Largest holders, flattened across both sides of the market.
 *
 * The API groups by token; we flatten and keep `outcomeIndex` so the UI can
 * label which side each holder is on. Sorted by size across the whole market,
 * because "biggest holder" reads oddly when it means "biggest holder of the
 * token that happened to come back first".
 */
export async function fetchTopHolders(conditionId: string, limit = 10): Promise<MarketHolder[]> {
  const data = await dataApiFetch<
    { token?: string; holders?: unknown[] }[]
  >(`/holders?market=${encodeURIComponent(conditionId)}&limit=${limit}`);

  if (!Array.isArray(data)) return [];

  const holders: MarketHolder[] = [];
  for (const group of data) {
    for (const entry of group.holders ?? []) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;

      const address = typeof row.proxyWallet === "string" ? row.proxyWallet : null;
      const shares = typeof row.amount === "number" ? row.amount : 0;
      if (!address || shares <= 0) continue;

      holders.push({
        address,
        name: displayName(row, address),
        avatar: typeof row.profileImage === "string" && row.profileImage ? row.profileImage : undefined,
        shares,
        outcomeIndex: typeof row.outcomeIndex === "number" ? row.outcomeIndex : 0,
      });
    }
  }

  return holders.sort((a, b) => b.shares - a.shares).slice(0, limit);
}

/** Most recent trades on this market, newest first. */
export async function fetchMarketTrades(conditionId: string, limit = 20): Promise<MarketTrade[]> {
  const data = await dataApiFetch<unknown[]>(
    `/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}`,
  );
  if (!Array.isArray(data)) return [];

  const trades: MarketTrade[] = [];
  data.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const row = entry as Record<string, unknown>;

    const address = typeof row.proxyWallet === "string" ? row.proxyWallet : null;
    if (!address) return;

    const hash = typeof row.transactionHash === "string" ? row.transactionHash : undefined;

    trades.push({
      // One transaction can settle several fills, so the hash alone is not
      // unique enough for a React key.
      key: `${hash ?? address}-${index}`,
      address,
      name: displayName(row, address),
      avatar: typeof row.profileImage === "string" && row.profileImage ? row.profileImage : undefined,
      side: row.side === "SELL" ? "SELL" : "BUY",
      outcome: typeof row.outcome === "string" ? row.outcome : "—",
      shares: typeof row.size === "number" ? row.size : 0,
      price: typeof row.price === "number" ? row.price : 0,
      timestamp: typeof row.timestamp === "number" ? row.timestamp : 0,
      transactionHash: hash,
    });
  });

  return trades.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Best available name for a trader.
 *
 * `name` is the chosen display name, `pseudonym` the auto-generated one
 * ("Expert-Statement"). `displayUsernamePublic` gates whether the real name is
 * meant to be shown at all, so it is respected rather than ignored — falling
 * back to the pseudonym, then a shortened address.
 */
function displayName(row: Record<string, unknown>, address: string): string {
  const isPublic = row.displayUsernamePublic !== false;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const pseudonym = typeof row.pseudonym === "string" ? row.pseudonym.trim() : "";

  if (isPublic && name) return name;
  if (pseudonym) return pseudonym;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Cached readers. Trades move faster than holders, so they get a shorter
 * window — but neither is a price feed, and nothing here may inform an order.
 */
export async function getCachedTopHolders(conditionId: string, limit = 10): Promise<MarketHolder[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag(`data:holders:${conditionId}`);
  return fetchTopHolders(conditionId, limit);
}

export async function getCachedMarketTrades(conditionId: string, limit = 20): Promise<MarketTrade[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  cacheTag(`data:trades:${conditionId}`);
  return fetchMarketTrades(conditionId, limit);
}
