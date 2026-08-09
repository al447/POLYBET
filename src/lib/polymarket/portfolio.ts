import type { Position } from "@polymarket/bindings/data";

import type { BrowserClient } from "./browser-client";

/**
 * Portfolio reads — positions and PnL (FR-4.2, FR-4.3, implementation.md
 * Steps 4.1–4.2).
 *
 * Runs in the **browser** against the user's own authenticated client, not as
 * a server-side proxy the way `gamma.ts` does. Two reasons, both structural:
 *
 *  1. The Data API needs a wallet address (`ListPositionsRequest.user`), and
 *     that's the *Deposit Wallet* — which our server never learns. The session
 *     only carries the EOA signer address, and the SDK has no
 *     `deriveDepositWalletAddress`. `SecureClient.listPositions()` defaults
 *     `user` to its own account, so calling it from the browser sidesteps the
 *     problem entirely rather than plumbing an address through a route.
 *  2. Gamma's proxy exists to *cache* — one shared market list serving every
 *     visitor. Positions are per-user and uncacheable, and Step 4.2's bar is
 *     "every figure reconciles against on-chain truth," which a 30-60s cache
 *     would break rather than help.
 *
 * `data-api.polymarket.com` is already in the CSP's `connect-src`
 * (next.config.ts), so no policy change is needed for this to work.
 *
 * ⚠️ These values are **human decimals** (`DecimalString`), NOT 6-decimal base
 * units. Do not run them through `fees.ts`'s `fromBaseUnits` — that would
 * divide by 10^6 and render every position as ~0.
 */

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
 */
export async function listPortfolioPositions(client: BrowserClient): Promise<Position[]> {
  const { items } = await client.listPositions({ pageSize: 100 }).firstPage();
  return items;
}

/**
 * Aggregates positions into the page's headline figures. Pure, so it's
 * unit-testable without a client or a network (matching `fees.ts` /
 * `market-data.ts`).
 *
 * Coerces defensively: nearly every money field on `Position` is typed
 * `DecimalString | null | undefined`, so a missing one must read as 0 rather
 * than poisoning a total with NaN.
 */
export function summarizePositions(positions: Position[]): PortfolioSummary {
  let positionsValue = 0;
  let costBasis = 0;
  let unrealizedPnl = 0;
  let realizedPnl = 0;

  for (const position of positions) {
    positionsValue += toNumber(position.currentValue);
    costBasis += toNumber(position.initialValue);
    unrealizedPnl += toNumber(position.cashPnl);
    realizedPnl += toNumber(position.realizedPnl);
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

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
