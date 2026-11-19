import type { BrowserClient } from "./browser-client";
import { fetchDataApiPage } from "./data-api";

/**
 * Portfolio reads — positions and PnL (FR-4.2, FR-4.3, implementation.md
 * Steps 4.1–4.2).
 *
 * Runs in the **browser** against the user's own authenticated client, not as
 * a server-side proxy the way `gamma.ts` does. Two reasons, both structural:
 *
 *  1. The Data API needs a wallet address (`user`), and that's the *Deposit
 *     Wallet* — which our server never learns. The session only carries the
 *     EOA signer address. The browser client knows it as
 *     `client.account.wallet`, so reading from the browser sidesteps the
 *     problem entirely rather than plumbing an address through a route.
 *  2. Gamma's proxy exists to *cache* — one shared market list serving every
 *     visitor. Positions are per-user and uncacheable, and Step 4.2's bar is
 *     "every figure reconciles against on-chain truth," which a 30-60s cache
 *     would break rather than help.
 *
 * `data-api.polymarket.com` is already in the CSP's `connect-src`
 * (next.config.ts), so no policy change is needed for this to work.
 *
 * 🚩 Reads `/v2/positions` directly, not `client.listPositions()`. The pinned
 * SDK (0.2.0) still calls the retired Data API v1, which has answered 410
 * since 2026-11-02 — see `data-api.ts`.
 *
 * ⚠️ These values are **human decimals**, NOT 6-decimal base units. Do not run
 * them through `fees.ts`'s `fromBaseUnits` — that would divide by 10^6 and
 * render every position as ~0.
 */

/**
 * One open position, normalised from a `/v2/positions` row.
 *
 * Field names are the ones every consumer already read off the SDK's
 * `Position`, so the v2 move changed no component. `initialValue` and `cashPnl`
 * keep their v1 names over v2 values; the mapping was checked on a live row
 * 2026-11-19, where `current_value − entry_cost_usdc = unrealized_pnl` held.
 */
export type PortfolioPosition = {
  tokenId: string;
  conditionId: string;
  title: string | null;
  icon: string | null;
  /** Our detail route resolves *event* slugs — a market slug 404s. */
  eventSlug: string | null;
  outcome: string | null;
  /** `current_size` — shares held now. Never `total_size`, which is lifetime bought. */
  size: number;
  avgPrice: number;
  /** `current_price`. */
  curPrice: number;
  currentValue: number;
  /** `entry_cost_usdc` — fee-exclusive cost of the current holding. */
  initialValue: number;
  /** `unrealized_pnl` — mark-to-market on what is still held. */
  cashPnl: number;
  /** Already a percent (4.33 means +4.33%). `null` when the API sends none. */
  percentPnl: number | null;
  realizedPnl: number;
  /** Resolved and still held — losing sides included, so not the same as "won". */
  redeemable: boolean;
};

export type PortfolioSummary = {
  positionCount: number;
  /** Σ currentValue — what the open positions are worth right now. */
  positionsValue: number;
  /** Σ initialValue — what they cost. */
  costBasis: number;
  /** Σ cashPnl — mark-to-market on still-open positions. */
  unrealizedPnl: number;
  /** Σ realizedPnl — already banked, from partial closes. */
  realizedPnl: number;
  /** `null` rather than NaN/Infinity when there's no cost basis to divide by. */
  unrealizedPnlPercent: number | null;
};

/**
 * Open positions for the authenticated account. First page only — the same
 * call shape and the same reasoning as `listOpenOrdersForToken`: a user with
 * more than 100 simultaneously-open positions isn't a scenario worth building
 * pagination for yet.
 *
 * `status` is left at its default, `OPEN`, which v2 documents as the superset:
 * a resolved-but-unredeemed position is still open, so `redeem.ts` sees it.
 */
export async function listPortfolioPositions(client: BrowserClient): Promise<PortfolioPosition[]> {
  const page = await fetchDataApiPage("/v2/positions", {
    user: client.account.wallet,
    limit: "100",
  });
  return parsePortfolioPositions(page.rows);
}

/**
 * Normalises `/v2/positions` rows. Exported for testing.
 *
 * Drops rows with no token id (nothing to trade or redeem) and rows holding
 * zero shares (v2 can leave a ~0 residual on a fully exited position).
 */
export function parsePortfolioPositions(rows: unknown[]): PortfolioPosition[] {
  const positions: PortfolioPosition[] = [];

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const tokenId = text(row.token_id);
    const size = toNumber(row.current_size);
    if (!tokenId || size <= 0) continue;

    const percent = Number(row.percent_pnl);

    positions.push({
      tokenId,
      conditionId: text(row.condition_id) ?? "",
      title: text(row.title),
      icon: text(row.icon),
      eventSlug: text(row.event_slug),
      outcome: text(row.outcome),
      size,
      avgPrice: toNumber(row.avg_price),
      curPrice: toNumber(row.current_price),
      currentValue: toNumber(row.current_value),
      initialValue: toNumber(row.entry_cost_usdc),
      cashPnl: toNumber(row.unrealized_pnl),
      percentPnl: row.percent_pnl != null && Number.isFinite(percent) ? percent : null,
      realizedPnl: toNumber(row.realized_pnl),
      redeemable: row.redeemable === true,
    });
  }

  return positions;
}

/**
 * Aggregates positions into the page's headline figures. Pure, so it's
 * unit-testable without a client or a network (matching `fees.ts` /
 * `market-data.ts`).
 *
 * Coercion happens once, in `parsePortfolioPositions`, so every money field
 * here is already a finite number.
 */
export function summarizePositions(positions: PortfolioPosition[]): PortfolioSummary {
  let positionsValue = 0;
  let costBasis = 0;
  let unrealizedPnl = 0;
  let realizedPnl = 0;

  for (const position of positions) {
    positionsValue += position.currentValue;
    costBasis += position.initialValue;
    unrealizedPnl += position.cashPnl;
    realizedPnl += position.realizedPnl;
  }

  return {
    positionCount: positions.length,
    positionsValue,
    costBasis,
    unrealizedPnl,
    realizedPnl,
    unrealizedPnlPercent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : null,
  };
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Empty strings read as `null` — v2 sends `""` rather than omitting a field. */
function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
