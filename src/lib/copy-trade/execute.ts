import type { BrowserClient, PreflightResult } from "@/lib/polymarket/browser-client";

import { COPY_MAX_SLIPPAGE, QUEUE_EXPIRY_MS, type CopyLedgerEntry } from "./types";

/**
 * What happens to a copy after the engine has approved it.
 *
 * `engine.ts` answers "should we copy this, and how big" from data alone. This
 * file answers the three questions that need the outside world: **is the market
 * still tradeable**, **may this order be placed at all** (the server preflight),
 * and **can the wallet afford it** (the pUSD balance) — then, on the live path,
 * places it. Same split as `trader-feed.ts`: the decisions are pure and
 * unit-tested, the I/O is a thin wrapper around helpers that already exist.
 *
 * 🚩 **`placeCopy` is the only function in this feature that signs anything,
 * and it is only ever reached from a user's click.** Everything else here is
 * checks. `/api/orders` in particular is pre-trade authorization, not order
 * placement — it checks auth, geo, legal acceptance and input shape, then
 * discloses the fee, which is what makes it safe to call on every copy in a dry
 * run.
 *
 * The dry run and the live click share `checkCopyPreconditions` deliberately.
 * Two copies of "may this copy proceed" would drift, and the dry run's whole
 * purpose is to predict what the live path will do.
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
  /**
   * Whether the market still accepts orders. `null` means it could not be read,
   * and `undefined` means it was never looked up — the dry run does not spend a
   * request on it. Neither blocks; only an explicit `false` does.
   */
  marketOpen?: boolean | null;
  nowMs: number;
};

/** Blocked with the row's final state, or clear to proceed with the disclosed fee. */
export type CopyPrecheck =
  | { blocked: true; patch: Partial<CopyLedgerEntry> }
  | { blocked: false; feeBps: number };

/**
 * Everything that can stop an approved copy, in the order it is checked.
 *
 * Pure, so every branch below is testable without a wallet, a signed-in user or
 * a live trader. Check order is part of the contract, same as `decideCopy`: the
 * first thing that makes the copy impossible wins, so the reason the user reads
 * is the one that actually stopped it. `market_closed` sits above the preflight
 * because it is a fact about the world — more useful to read than "rejected
 * before signing".
 *
 * ⚠️ An unreadable balance (`availableUsd === null`) does **not** block. The
 * wallet may simply not be connected yet, and refusing every copy on a failed
 * read would make a transient RPC blip look like a permanent "Not enough pUSD".
 * Over-reporting what could be afforded is recoverable — the CLOB rejects an
 * unfunded order anyway; silently reporting nothing is not.
 */
export function checkCopyPreconditions(input: ResolutionInput): CopyPrecheck {
  const { entry, preflight, availableUsd, marketOpen, nowMs } = input;

  // First, and before a single request is worth spending: a decision this old
  // is about a price that no longer exists.
  if (hasExpired(entry, nowMs)) {
    return {
      blocked: true,
      patch: { status: "cancelled", error: "Expired before it could be placed" },
    };
  }

  // Explicit `false` only — see `isMarketAcceptingOrders` on why a missing flag
  // or a failed lookup is not evidence of a settled market.
  if (marketOpen === false) {
    return { blocked: true, patch: { status: "skipped", skipReason: "market_closed" } };
  }

  if (!preflight) {
    return {
      blocked: true,
      patch: { status: "failed", error: "Could not reach the pre-trade check" },
    };
  }

  if (!preflight.allowed) {
    return {
      blocked: true,
      patch: { status: "skipped", skipReason: "preflight_rejected", error: preflight.message },
    };
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
      return { blocked: true, patch: { status: "failed", error: "Copy had no usable size" } };
    }

    if (availableUsd !== null && availableUsd < requiredUsd(amountUsd as number, feeBps)) {
      return {
        blocked: true,
        patch: { status: "skipped", skipReason: "insufficient_balance", feeBps },
      };
    }
  } else if (!Number.isFinite(entry.shares) || (entry.shares as number) <= 0) {
    // The sell-side twin of the check above. `placeMarketSell` takes shares, so
    // a row without them has nothing to send.
    return { blocked: true, patch: { status: "failed", error: "Copy had no usable size" } };
  }

  return { blocked: false, feeBps };
}

/**
 * The dry run's answer for one queued copy, as a ledger patch.
 *
 * Everything a live placement would refuse, refused identically — the only
 * difference is that a copy which passes lands as `simulated` instead of being
 * signed. That is the whole value of the dry run: if it says a copy would go
 * through, the live path agrees.
 */
export function planResolution(input: ResolutionInput): Partial<CopyLedgerEntry> {
  const check = checkCopyPreconditions(input);
  return check.blocked ? check.patch : { status: "simulated", feeBps: check.feeBps };
}

/** The slippage bound sent with a copy — one side or neither, never both. Empty when there is no usable anchor price. */
export type PriceGuard = { maxPrice?: string; minPrice?: string };

/**
 * The price band a copy may fill inside, anchored on the trader's own fill.
 *
 * Returns nothing when `expectedPrice` is unusable — an unguarded market order
 * is worse than a guarded one, but a *wrongly* guarded one is worse still: a
 * garbage anchor would set `maxPrice` somewhere arbitrary and every copy of
 * that market would silently fail to fill.
 *
 * ⚠️ **This is the intended band, not a placeable one.** Prices must sit on the
 * market's tick grid, and that grid differs per market — see
 * {@link quantiseToTick}, which `placeCopy` applies once it knows the tick.
 * What comes out of here is safe to *display* and never safe to send.
 */
export function priceGuard(entry: CopyLedgerEntry): PriceGuard {
  const anchor = entry.expectedPrice;
  if (!Number.isFinite(anchor) || (anchor as number) <= 0 || (anchor as number) >= 1) return {};

  return entry.side === "BUY"
    ? { maxPrice: ((anchor as number) * (1 + COPY_MAX_SLIPPAGE)).toFixed(3) }
    : { minPrice: ((anchor as number) * (1 - COPY_MAX_SLIPPAGE)).toFixed(3) };
}

/**
 * 🚩 Snaps a price bound onto one market's tick grid.
 *
 * Without this, **most copies never reach the CLOB at all.** The SDK validates
 * `maxPrice`/`minPrice` against the market's tick size before signing
 * (`nr()` in `@polymarket/client`) and throws on three separate counts: a value
 * outside `[tick, 1 - tick]`, more decimal places than the tick has, or a value
 * that is not a whole multiple of the tick.
 *
 * Measured 2026-08-19 across ten markets that live leaderboard traders had just
 * traded: **nine had a tick of `0.01`**, and **seven of ten** bounds produced by
 * a plain three-decimal format were rejected —
 * `maxPrice must conform to tick size 0.01 with at most 2 decimal places.`
 *
 * Worse, it failed *intermittently*. The SDK coerces the string to a number, so
 * `"0.420"` arrives as `0.42` and passes while `"0.336"` throws — meaning the
 * old code worked roughly one time in ten, depending on whether the third
 * decimal happened to be zero. That is the failure mode this function exists to
 * remove.
 *
 * @param direction `"up"` for a BUY `maxPrice`, `"down"` for a SELL `minPrice` —
 * both meaning "keep the copy placeable". Rounding the other way tightens the
 * band by up to one tick and buys silent no-fills, which `priceGuard` above
 * already argues is the worse outcome. The cost is that the effective band is
 * {@link COPY_MAX_SLIPPAGE} plus up to one tick — at most a cent on a `0.01`
 * market.
 */
export function quantiseToTick(
  price: number,
  tickSize: number,
  direction: "up" | "down",
): string | null {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return null;

  const decimals = decimalsOf(tickSize);

  // 🚩 The quotient is de-noised before rounding, and it matters in both
  // directions. `0.29 / 0.01` is 28.999999999999996, so a bare `Math.floor`
  // gives 0.28 — a sell bound a full tick tighter than asked for. `0.34 / 0.01`
  // is 34.000000000000004, so a bare `Math.ceil` gives 0.35. Nine decimal
  // places is far below any real tick and far above the noise.
  const quotient = Math.round((price / tickSize) * 1e9) / 1e9;
  const steps = direction === "up" ? Math.ceil(quotient) : Math.floor(quotient);

  // The SDK's accepted range is `[tick, 1 - tick]` — not the `[0.001, 0.999]`
  // this used to clamp to, which is *outside* it on any market coarser than
  // 0.001 and throws on the range check instead of the decimals one.
  const clamped = Math.min(Math.max(steps * tickSize, tickSize), 1 - tickSize);

  // `toFixed` is load-bearing, not cosmetic: `34 * 0.01` is 0.34000000000000002
  // in binary floating point, which fails the SDK's decimal-count check far more
  // spectacularly than the bug being fixed here.
  return clamped.toFixed(decimals);
}

/** Decimal places in a tick size — `0.01` → 2. Drives both the rounding and the output format. */
function decimalsOf(tickSize: number): number {
  const text = String(tickSize);
  // Ticks are small decimals in practice, but `String(1e-7)` is exponential and
  // would otherwise be counted as zero decimals.
  if (text.includes("e") || text.includes("E")) {
    const [, exponent = "0"] = text.toLowerCase().split("e");
    return Math.max(0, -Number.parseInt(exponent, 10));
  }
  const [, fraction = ""] = text.split(".");
  return fraction.length;
}

/**
 * The bound actually sent with an order: the intended band, snapped to this
 * market's grid.
 *
 * `null` tick — the lookup failed — deliberately yields **no guard at all**
 * rather than an unsnapped one. An unguarded copy is worse than a guarded one,
 * but an invalid guard fails 100% of the time, which is worse than both.
 */
export function placeableGuard(entry: CopyLedgerEntry, tickSize: number | null): PriceGuard {
  if (tickSize === null) return {};

  const intended = priceGuard(entry);
  if (intended.maxPrice !== undefined) {
    const maxPrice = quantiseToTick(Number(intended.maxPrice), tickSize, "up");
    return maxPrice === null ? {} : { maxPrice };
  }
  if (intended.minPrice !== undefined) {
    const minPrice = quantiseToTick(Number(intended.minPrice), tickSize, "down");
    return minPrice === null ? {} : { minPrice };
  }
  return {};
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

/** Whether the copied market still takes orders. `null` when it could not be read — see `isMarketAcceptingOrders`. */
export async function readMarketOpen(
  client: BrowserClient | null,
  slug: string,
): Promise<boolean | null> {
  if (!client) return null;
  const { isMarketAcceptingOrders } = await import("@/lib/polymarket/browser-client");
  return isMarketAcceptingOrders(client, slug);
}

/**
 * This market's price grid, or `null` when it could not be read.
 *
 * The SDK's own `fetchTickSize` rather than a number of ours, because it is the
 * same value the SDK validates the guard against — deriving it independently
 * would be a second source of truth for the one field that decides whether an
 * order is signable. See {@link quantiseToTick}.
 */
export async function readTickSize(
  client: BrowserClient | null,
  tokenId: string,
): Promise<number | null> {
  if (!client) return null;
  try {
    const { fetchTickSize } = await import("@polymarket/client/actions");
    const tickSize = await fetchTickSize(client, { tokenId });
    return Number.isFinite(Number(tickSize)) ? Number(tickSize) : null;
  } catch {
    return null;
  }
}

/**
 * 🚩 Places one queued copy for real. **The only path in this feature that
 * signs an order, and it runs only from the user's click.**
 *
 * Everything is re-checked here, at click time, and none of it is reused from
 * when the engine queued the row. A preflight answer from five minutes ago says
 * nothing about now: the market may have settled, the geo tier may have
 * changed, the balance may have been spent by another tab. The row's *size* is
 * the only thing carried forward from the decision, because that is what the
 * user is agreeing to when they click.
 *
 * Returns a ledger patch rather than throwing, so one failed copy leaves an
 * honest row and never takes down the queue around it. The three outcomes:
 * `placed` with the CLOB's order id, `failed` with the reason, or one of the
 * skip reasons when a precondition — settled market, rejected preflight, no
 * pUSD — stopped it.
 *
 * ⚠️ `placed` means the CLOB **accepted** the order, not that it fully filled.
 * A market order guarded by {@link COPY_MAX_SLIPPAGE} can fill partially and
 * rest, and later fills arrive on the user channel, not here. The positions
 * tiles read real holdings for exactly this reason.
 */
export async function placeCopy(
  client: BrowserClient | null,
  entry: CopyLedgerEntry,
): Promise<Partial<CopyLedgerEntry>> {
  if (!client) {
    return { status: "failed", error: "Connect your wallet before placing a copy." };
  }

  // Cheap and first: an expired decision is not worth three network round
  // trips. `checkCopyPreconditions` checks it again against a fresher clock.
  if (hasExpired(entry, Date.now())) {
    return { status: "cancelled", error: "Expired before it could be placed" };
  }

  // In parallel: they are independent reads, and doing them in series would add
  // a second or more to a click the user is watching — during which the price
  // this copy is anchored on keeps moving.
  const [preflight, marketOpen, availableUsd, tickSize] = await Promise.all([
    runPreflight(entry),
    readMarketOpen(client, entry.slug),
    readAvailableUsd(client),
    readTickSize(client, entry.tokenId),
  ]);

  const check = checkCopyPreconditions({
    entry,
    preflight,
    marketOpen,
    availableUsd,
    nowMs: Date.now(),
  });
  if (check.blocked) return check.patch;

  try {
    const { placeMarketBuy, placeMarketSell } = await import("@/lib/polymarket/browser-client");
    // Snapped to this market's tick, not the raw band — an unsnapped bound is
    // rejected before the order is ever signed. See `quantiseToTick`.
    const guard = placeableGuard(entry, tickSize);

    // USD for a buy, shares for a sell — the same split `CopyDecision` records
    // and `/api/orders` expects, carried through unchanged so no call site has
    // to convert and get the direction wrong.
    const response =
      entry.side === "BUY"
        ? await placeMarketBuy(client, {
            tokenId: entry.tokenId,
            amount: String(entry.amountUsd),
            ...(guard.maxPrice ? { maxPrice: guard.maxPrice } : {}),
          })
        : await placeMarketSell(client, {
            tokenId: entry.tokenId,
            shares: String(entry.shares),
            ...(guard.minPrice ? { minPrice: guard.minPrice } : {}),
          });

    if (!response.ok) {
      return { status: "failed", feeBps: check.feeBps, error: response.message };
    }

    return { status: "placed", feeBps: check.feeBps, orderId: response.orderId };
  } catch (error) {
    // Includes the user rejecting the signature, which is a legitimate answer
    // and lands as a failed row they can see rather than a silent no-op.
    return {
      status: "failed",
      feeBps: check.feeBps,
      error: error instanceof Error ? error.message : "order_failed",
    };
  }
}
