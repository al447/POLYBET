import type { Position } from "@polymarket/bindings/data";

import type { BrowserClient } from "./browser-client";

/**
 * Redeeming resolved positions — the last gap in the money path.
 *
 * Deposit → trade → **redeem** → withdraw. Everything either side of this was
 * already built; without it a user who wins a market can see the win on the
 * portfolio page (`redeemable`, rendered as a "Resolved" badge) and has no way
 * to turn it back into pUSD, which then has no way to reach `withdraw.ts`.
 *
 * Runs browser-side against the user's own authenticated client, for the same
 * structural reason as `portfolio.ts`: the account being redeemed is the
 * *Deposit Wallet*, which the server never learns, and `SecureClient` defaults
 * every request to its own account.
 *
 * **Redemption is keyed by condition, not by position.** `redeemPositions`
 * takes a `conditionId` and settles every outcome token the account holds in
 * that condition in one transaction — so a user holding both YES and NO of the
 * same market is one redemption, not two. `groupRedeemable` exists to enforce
 * that at the UI level; listing raw positions would offer the same claim twice
 * and the second click would spend a relay transaction to do nothing.
 *
 * ⚠️ **Each redemption spends one of the 100 daily relay transactions** — it
 * executes gaslessly through the Relayer like every other Deposit Wallet
 * operation. Callers must guard against double-submission (the panel disables
 * the button in flight); a redeem is not a free read.
 *
 * Verified against the shipped SDK 2026-08-14: `redeemPositions` resolves the
 * market internally and picks `negRiskCollateralAdapter` for negative-risk
 * (multi-outcome) markets and `collateralAdapter` otherwise, so **no special
 * negRisk handling is needed here** — one call covers both. It also looks the
 * market up with `closed: true` and throws `No market found for condition …`
 * if the market has not actually resolved yet, which is the correct failure
 * and is surfaced verbatim rather than swallowed.
 */

export type RedeemableMarket = {
  /** The redemption unit. Passed straight to `redeemPositions`. */
  conditionId: string;
  title: string | null;
  icon: string | null;
  /** For linking back to the market page — our detail route resolves event slugs, not market slugs. */
  eventSlug: string | null;
  /** Outcome labels held in this condition — usually one, both when the user holds each side. */
  outcomes: string[];
  /** Σ size across the condition's positions. */
  shares: number;
  /** Σ currentValue — what redeeming pays out, since a resolved market marks each share at 1 or 0. */
  payout: number;
};

/**
 * Collapses a position list into the set of claimable markets.
 *
 * Pure, so it's unit-testable without a client or a network — same shape as
 * `summarizePositions`, `applyMarketEvent` and `validateWithdrawal`.
 *
 * **Deliberately does not filter on payout.** A resolved market where the user
 * held only the losing side claims $0, and hiding those would be tidier — but
 * every money field on `Position` is `DecimalString | null | undefined`, so a
 * payout that reads as 0 is indistinguishable from a payout the API simply
 * didn't return. Hiding a real claim because a field was null is a much worse
 * failure than showing a $0.00 row the user can ignore, so the figure is
 * displayed and the choice is left to them. Only genuinely empty groups (no
 * shares *and* no value) are dropped.
 *
 * ⚠️ Values here are **human decimals** from the Data API, not 6-decimal base
 * units. Do not run them through `fees.ts`'s `fromBaseUnits`.
 */
export function groupRedeemable(positions: Position[]): RedeemableMarket[] {
  const groups = new Map<string, RedeemableMarket>();

  for (const position of positions) {
    if (position.redeemable !== true) continue;

    const conditionId = position.conditionId;
    if (!conditionId) continue;

    let group = groups.get(conditionId);
    if (!group) {
      group = {
        conditionId,
        title: position.title ?? null,
        icon: position.icon ?? null,
        eventSlug: position.eventSlug ?? null,
        outcomes: [],
        shares: 0,
        payout: 0,
      };
      groups.set(conditionId, group);
    }

    const outcome = position.outcome ?? null;
    if (outcome && !group.outcomes.includes(outcome)) group.outcomes.push(outcome);

    group.shares += toNumber(position.size);
    group.payout += toNumber(position.currentValue);
  }

  return [...groups.values()]
    .filter((group) => group.shares > 0 || group.payout > 0)
    .sort((a, b) => b.payout - a.payout);
}

/** Σ payout across claimable markets — the headline "you have this much waiting" figure. */
export function totalClaimable(markets: RedeemableMarket[]): number {
  return markets.reduce((sum, market) => sum + market.payout, 0);
}

/**
 * Redeems every position the account holds in one condition. Gasless via the
 * Relayer, so it spends relay quota; returns the settlement transaction hash.
 *
 * Not pre-flighted against `/api/orders`: redemption is not an order. It opens
 * no position, carries no builder fee, and is the *exit* path a close-only
 * jurisdiction is explicitly still allowed to use (FR-6.3), so gating it on
 * `canOpenPositions` would lock users out of their own settled funds.
 *
 * The adapter must be an approved ERC-1155 operator for this to succeed —
 * `setupTradingApprovals` grants exactly that alongside the trading
 * approvals, so anyone who has traded through this app already has it. Rather
 * than adding another heuristic pre-check (see Step 3.4a's, which is already
 * imperfect), an approval failure surfaces as the SDK's own error and the
 * "Enable trading" action in the ticket remains the fallback.
 */
export async function redeemMarketPositions(
  client: BrowserClient,
  conditionId: string,
): Promise<string> {
  const handle = await client.redeemPositions({ conditionId });
  const outcome = await handle.wait();
  return outcome.transactionHash;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
