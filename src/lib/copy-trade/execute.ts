import type { BrowserClient, PreflightResult } from "@/lib/polymarket/browser-client";

import { QUEUE_EXPIRY_MS, type CopyLedgerEntry } from "./types";

/**
 * What happens to a copy after the engine has approved it.
 *
 * `engine.ts` answers "should we copy this, and how big" from data alone.
 * This file answers the two questions that need the outside world: **may this
 * order be placed at all** (the server preflight), and **can the wallet
 * afford it** (the pUSD balance). Same split as `trader-feed.ts` — the
 * decision is pure and unit-tested, the I/O is a thin wrapper around helpers
 * that already exist elsewhere.
 *
 * 🚩 **Nothing here signs anything.** `/api/orders` is pre-trade authorization,
 * not order placement — it checks auth, geo, legal acceptance and input shape,
 * then discloses the fee. That is what makes it safe to call on every copy in a
 * dry run: it exercises the real gate without touching the CLOB. The actual
 * signing lives in `browser-client.ts` and is called by the click-to-place path,
 * not from here.
 */

/**
 * pUSD needed to open a copy, fee included.
 *
 * ⚠️ Not the bare notional. Users need collateral for notional **plus** platform
 * and builder fees combined, so a balance check against `amountUsd` alone passes
 * orders that then fail upstream on collateral — the failure arriving from
 * Polymarket rather than from us, with no useful message attached.
 */
export function requiredUsd(amountUsd: number, takerBps: number): number {
  const fee = Number.isFinite(takerBps) && takerBps > 0 ? takerBps : 0;
  return amountUsd * (1 + fee / 10_000);
}

/** True once a queued copy is too old for its decision to still mean anything. */
export function hasExpired(entry: CopyLedgerEntry, nowMs: number): boolean {
  const decidedAt = Date.parse(entry.decidedAt);
  if (!Number.isFinite(decidedAt)) return false;
  return nowMs - decidedAt > QUEUE_EXPIRY_MS;
}

export type ResolutionInput = {
  entry: CopyLedgerEntry;
  /** `null` when the preflight could not be completed at all — a network failure. */
  preflight: PreflightResult | null;
  /** Spendable pUSD, or `null` when it could not be read. */
  availableUsd: number | null;
  nowMs: number;
};

/**
 * The whole post-approval decision for one queued copy, as a ledger patch.
 *
 * Pure, so every branch below is testable without a wallet, a signed-in user or
 * a live trader. Check order is part of the contract, same as `decideCopy`: the
 * first thing that makes the copy impossible wins, so the reason the user reads
 * is the one that actually stopped it.
 *
 * ⚠️ An unreadable balance (`availableUsd === null`) does **not** block. The
 * wallet may simply not be connected yet, and refusing every copy on a failed
 * read would make a transient RPC blip look like a permanent "Not enough pUSD".
 * A dry run over-reporting what it could afford is recoverable; a dry run that
 * silently reports nothing is not.
 */
export function planResolution(input: ResolutionInput): Partial<CopyLedgerEntry> {
  const { entry, preflight, availableUsd, nowMs } = input;

  // First, and before the preflight is even worth spending a request on: a
  // decision this old is about a price that no longer exists.
  if (hasExpired(entry, nowMs)) {
    return { status: "cancelled", error: "Expired before it could be placed" };
  }

  if (!preflight) {
    return { status: "failed", error: "Could not reach the pre-trade check" };
  }

  if (!preflight.allowed) {
    return { status: "skipped", skipReason: "preflight_rejected", error: preflight.message };
  }

  const feeBps = preflight.feeBps.taker;

  // Only a buy spends collateral. A sell returns money — its fee comes out of
  // the proceeds, so a zero pUSD balance is no obstacle to closing a position.
  if (entry.side === "BUY") {
    const amountUsd = entry.amountUsd;

    // A buy with no readable size is a corrupt row, not a free one. `localStorage`
    // is user-writable and `sanitiseLedger` keeps `amountUsd` optional, so this
    // is reachable — and reading it as 0 would clear every balance check and
    // file a $0 "position" the tiles then sum.
    if (!Number.isFinite(amountUsd) || (amountUsd as number) <= 0) {
      return { status: "failed", error: "Copy had no usable size" };
    }

    if (availableUsd !== null && availableUsd < requiredUsd(amountUsd as number, feeBps)) {
      return { status: "skipped", skipReason: "insufficient_balance", feeBps };
    }
  }

  return { status: "simulated", feeBps };
}

/* ------------------------------------------------------------------ *
 * I/O — thin wrappers, so the hook holds no fetch logic of its own.
 *
 * ⚠️ `browser-client.ts` is imported **dynamically** below and `import type`
 * above, never as a static value import. It pulls `@polymarket/client` and
 * `viem` at module scope, so a static import would drag the whole SDK into
 * anything that touches this file — including `execute.test.ts`, which tests
 * pure arithmetic and has no business loading a wallet library. Same reason
 * `browser-client.ts` itself defers `@polymarket/client/actions`; the bundle
 * budget is real (CLAUDE.md).
 * ------------------------------------------------------------------ */

/**
 * Runs the server pre-trade check for one queued copy.
 *
 * The amount sent matches `/api/orders`'s contract exactly: **USD notional for
 * a buy, share count for a sell**. Getting that backwards would send a share
 * count where a dollar figure is expected and quote a fee on the wrong number.
 *
 * `null` on a network failure rather than a throw, so one unreachable request
 * cannot abort the sweep over the rest of the queue.
 */
export async function runPreflight(entry: CopyLedgerEntry): Promise<PreflightResult | null> {
  const amount = entry.side === "BUY" ? entry.amountUsd : entry.shares;
  if (!Number.isFinite(amount) || (amount as number) <= 0) return null;

  try {
    const { preflightOrder } = await import("@/lib/polymarket/browser-client");
    return await preflightOrder({
      tokenId: entry.tokenId,
      side: entry.side,
      amount: String(amount),
    });
  } catch {
    return null;
  }
}

/**
 * Spendable pUSD as a plain USD number, or `null` when it cannot be read.
 *
 * `readCollateralBalance` returns base units at 6 decimals — the same scale
 * `POLYGON_TOKENS` records for pUSD — so the divisor is not a guess.
 */
export async function readAvailableUsd(client: BrowserClient | null): Promise<number | null> {
  if (!client) return null;
  try {
    const { readCollateralBalance } = await import("@/lib/polymarket/browser-client");
    return Number(await readCollateralBalance(client)) / 1e6;
  } catch {
    return null;
  }
}
