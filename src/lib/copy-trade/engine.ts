import {
  FULL_EXIT_THRESHOLD,
  MIN_COPY_USD,
  SETTLE_DELAY_SECONDS,
  type CopyBudgetState,
  type CopyDecision,
  type CopyIntent,
  type CopyLedgerEntry,
  type CopySettings,
  type ExitContext,
  type SkipReason,
  type TraderTrade,
} from "./types";

/**
 * The copy engine's decision core — **pure**, and deliberately so.
 *
 * No network, no React, no `Date.now()`: every function here takes the clock as
 * an argument. That is what lets the interesting behaviour (fill grouping,
 * cap arithmetic, exit fractions) be unit-tested exactly, without a browser, a
 * wallet, or a live trader who happens to be trading right now. Same discipline
 * as `fees.ts` and `market-data.ts`'s reducer.
 *
 * The impure parts live elsewhere: `trader-feed.ts` fetches, `store.ts`
 * persists, `use-copy-engine.ts` holds the interval and calls the SDK. If you
 * find yourself needing `fetch` or `Date.now()` in this file, the logic
 * probably belongs in the hook instead.
 */

/**
 * Collapses fill rows into the orders they came from.
 *
 * 🚩 This is the single most consequential function here. A trader's one order
 * is reported by `/trades` as **several rows**: measured 2026-08-17 on a 25-row
 * page, all 25 had distinct `transactionHash` values but only **15** distinct
 * `(asset, side, timestamp)` triples. Copying per row therefore places roughly
 * 1.7 orders for every one the trader made — silently, with each one passing
 * every cap check on its own.
 *
 * So the dedup key is `(address, tokenId, side, timestamp)`, **not** the
 * transaction hash. The hash is unique per row and is exactly the wrong key.
 *
 * `windowSeconds` widens that from an exact timestamp match to a short bucket,
 * because an order that fills across a second boundary is plausible even though
 * the sample did not show one. Keep it small: too wide and two genuinely
 * separate orders on the same outcome merge into one copy.
 *
 * Rows that are not tradeable fills are dropped rather than grouped —
 * `/activity` carries `REDEEM` entries with `side: ""` and `price: 0`, and a
 * price of exactly 0 or 1 is a settlement artifact, not something to copy.
 */
export function groupFillsIntoIntents(
  trades: readonly TraderTrade[],
  windowSeconds = 2,
): CopyIntent[] {
  const usable = trades
    .filter(
      (trade) =>
        (trade.side === "BUY" || trade.side === "SELL") &&
        Number.isFinite(trade.size) &&
        trade.size > 0 &&
        Number.isFinite(trade.price) &&
        trade.price > 0 &&
        trade.price < 1 &&
        Number.isFinite(trade.timestamp) &&
        Boolean(trade.tokenId),
    )
    // Oldest first: buckets are opened by the earliest fill they contain, and
    // copies must be applied in the order the trader made them.
    .sort((a, b) => a.timestamp - b.timestamp);

  const buckets = new Map<string, TraderTrade[]>();
  const openBucketKey = new Map<string, { key: string; startedAt: number }>();

  for (const trade of usable) {
    const base = `${trade.address}:${trade.tokenId}:${trade.side}`;
    const open = openBucketKey.get(base);

    // A new bucket starts when nothing is open for this outcome+side, or when
    // this fill is further from the open bucket's first fill than the window.
    if (!open || trade.timestamp - open.startedAt > windowSeconds) {
      const key = `${base}:${trade.timestamp}`;
      openBucketKey.set(base, { key, startedAt: trade.timestamp });
      buckets.set(key, [trade]);
      continue;
    }

    buckets.get(open.key)?.push(trade);
  }

  const intents: CopyIntent[] = [];
  for (const [key, fills] of buckets) {
    const first = fills[0];
    let shares = 0;
    let notionalUsd = 0;
    for (const fill of fills) {
      shares += fill.size;
      notionalUsd += fill.size * fill.price;
    }

    intents.push({
      key,
      address: first.address,
      side: first.side,
      tokenId: first.tokenId,
      conditionId: first.conditionId,
      shares,
      notionalUsd,
      // Size-weighted, not a plain mean: a 10,000-share fill at 0.31 and a
      // 10-share fill at 0.80 average to 0.31, not 0.55.
      avgPrice: shares > 0 ? notionalUsd / shares : first.price,
      timestamp: first.timestamp,
      fillCount: fills.length,
      title: first.title,
      outcome: first.outcome,
      slug: first.slug,
      eventSlug: first.eventSlug,
      icon: first.icon,
    });
  }

  return intents.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Everything new enough to be worth copying and old enough to be safe to copy.
 *
 * Two filters, for two different failure modes:
 *
 *  - **`cursor`** stops us copying history. `/trades` has no practical page cap
 *    (asking for 500 returned a trader's whole 279-row history), so an unseeded
 *    cursor means every trade they have ever made becomes a copy the instant
 *    they are followed. `FollowedTrader.cursor` is seeded to the follow time
 *    for exactly this reason.
 *  - **`settleDelaySeconds`** stops us copying the same order twice. An order
 *    still filling can be observed half-complete on one tick and completed on
 *    the next, producing two intents with two different sizes from one order.
 *    Holding anything younger than the delay means an order has finished before
 *    it is ever considered.
 *
 * 🚩 **Grouping happens over the whole page, and the cursor filters the
 * intents — never the trades.** Filtering first looks equivalent and is not: a
 * bucket is named after its earliest fill, so dropping that fill re-forms the
 * same order as a *new* bucket under a *new* key. Fixed 2026-08-19 after this
 * was measured double-copying one order across two ticks:
 *
 * ```text
 * // fills at t=1000, t=1000, t=1001 — one order
 * tick 1 (cursor 500)  -> 0xabc:tok1:BUY:1000, 300 shares, cursor -> 1000
 * tick 2 (cursor 1000) -> 0xabc:tok1:BUY:1001,  50 shares   ← the tail, again
 * ```
 *
 * The two keys differ, so the ledger's `intentKey` dedup could not catch it and
 * each copy passed the caps on its own. Grouping the full page keeps a given
 * order's bucket start stable across ticks, which is what makes that dedup a
 * real backstop rather than an accident of timing.
 *
 * The remaining asymmetry is deliberate: a fill that lands *after* its bucket
 * was already emitted joins that bucket and is not copied again. Under-copying,
 * which is the direction {@link SETTLE_DELAY_SECONDS} already chose.
 *
 * `nextCursor` only ever advances to the newest intent actually returned, never
 * to the newest trade seen — otherwise the held-back tail would be skipped
 * permanently rather than picked up on the following tick.
 */
export function selectCopyableIntents(input: {
  trades: readonly TraderTrade[];
  cursor: number;
  nowSeconds: number;
  settleDelaySeconds?: number;
  groupWindowSeconds?: number;
}): { intents: CopyIntent[]; nextCursor: number } {
  const settleDelay = input.settleDelaySeconds ?? SETTLE_DELAY_SECONDS;
  const horizon = input.nowSeconds - settleDelay;

  const intents = groupFillsIntoIntents(input.trades, input.groupWindowSeconds).filter(
    (intent) => intent.timestamp > input.cursor && intent.timestamp <= horizon,
  );

  const nextCursor = intents.reduce((max, intent) => Math.max(max, intent.timestamp), input.cursor);

  return { intents, nextCursor };
}

/** Midnight UTC for the day containing `nowMs`. The daily cap's window boundary. */
export function utcDayStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Statuses that consume budget.
 *
 * `queued` counts even though nothing has been signed yet: a copy waiting for
 * the user's click is money they are about to commit, and not counting it lets
 * a backed-up queue authorise ten copies that each pass the cap individually
 * and blow through it together.
 *
 * `simulated` counts too — otherwise a dry run never exercises the cap logic,
 * which is most of what the dry run exists to test.
 */
const BUDGET_STATUSES = new Set(["queued", "placed", "simulated"]);

/**
 * Per-trader spend, computed from the ledger.
 *
 * ⚠️ `deployedUsd` is **cost basis**, not market value: buys in, estimated sell
 * proceeds out, floored at zero. That is deliberate. `totalCapUsd` answers "how
 * much of my money have I committed to following this person", and a cap that
 * moved every time the market did would tighten and loosen on its own — a
 * position drifting up in value would silently block new copies.
 */
export function summariseBudget(
  entries: readonly CopyLedgerEntry[],
  address: string,
  nowMs: number,
): CopyBudgetState {
  const dayStart = utcDayStartMs(nowMs);

  let spentTodayUsd = 0;

  for (const entry of entries) {
    if (!countsTowardBudget(entry, address)) continue;
    // Only opening a position spends the daily budget. An exit returns money;
    // charging the day's cap for it would punish the user for closing.
    if (entry.side !== "BUY") continue;
    if (Date.parse(entry.decidedAt) >= dayStart) spentTodayUsd += entry.amountUsd as number;
  }

  return { spentTodayUsd, deployedUsd: deployedUsdFor(entries, address) };
}

/**
 * Cost basis still committed to one trader — the `deployedUsd` half of
 * {@link summariseBudget}, split out because **it does not depend on the clock**.
 *
 * That matters at the call site, not here. `CopyStats` renders this figure and
 * used to reach for it through `summariseBudget(ledger, address, Date.now())`,
 * passing a timestamp that could not affect the answer — an impurity during
 * render (`react-hooks/purity`) bought for nothing. A component that needs the
 * deployed figure should be able to ask for exactly that.
 */
export function deployedUsdFor(entries: readonly CopyLedgerEntry[], address: string): number {
  let boughtUsd = 0;
  let soldUsd = 0;

  for (const entry of entries) {
    if (!countsTowardBudget(entry, address)) continue;
    if (entry.side === "BUY") boughtUsd += entry.amountUsd as number;
    else soldUsd += entry.amountUsd as number;
  }

  return Math.max(0, boughtUsd - soldUsd);
}

/** One trader's rows that represent committed money, with a usable amount on them. */
function countsTowardBudget(entry: CopyLedgerEntry, address: string): boolean {
  if (entry.address !== address) return false;
  if (!BUDGET_STATUSES.has(entry.status)) return false;
  return Number.isFinite(entry.amountUsd) && (entry.amountUsd as number) > 0;
}

/**
 * The whole decision for one intent: copy it, and at what size, or skip it and
 * why.
 *
 * Ordering of the checks is part of the contract — the first thing that makes
 * a copy impossible wins, so the reason shown to the user is the one that
 * actually stopped it rather than whichever check happened to run first.
 */
export function decideCopy(input: {
  intent: CopyIntent;
  settings: CopySettings;
  budget: CopyBudgetState;
  /** Required for a SELL; ignored for a BUY. */
  exit?: ExitContext;
  /** From Gamma. A settled leg is untradeable in either direction. */
  marketClosed?: boolean;
  paused?: boolean;
}): CopyDecision {
  const { intent, settings, budget } = input;

  if (input.paused) return { action: "skip", reason: "trader_paused" };

  // Checked before the side split: `closed` is the flag that separates a
  // settled leg from a live one, and a settled outcome can be neither bought
  // nor exited. `active` is useless here — it stays true on settled legs.
  if (input.marketClosed) return { action: "skip", reason: "market_closed" };

  if (intent.side === "SELL") return decideExit(intent, input.exit);

  const desiredUsd = sizeFromSettings(intent, settings);

  // Each limit as "how much headroom is left", so the binding one is just the
  // smallest. Negative headroom (a cap lowered below what is already committed)
  // clamps to zero rather than going negative and inverting the comparison.
  const limits: { reason: SkipReason; remaining: number }[] = [
    { reason: "per_trade_cap", remaining: safeAmount(settings.perTradeCapUsd) },
    {
      reason: "daily_cap",
      remaining: Math.max(0, safeAmount(settings.dailyCapUsd) - budget.spentTodayUsd),
    },
    {
      reason: "total_cap",
      remaining: Math.max(0, safeAmount(settings.totalCapUsd) - budget.deployedUsd),
    },
  ];

  let amountUsd = desiredUsd;
  let cappedBy: SkipReason | null = null;
  for (const limit of limits) {
    if (limit.remaining < amountUsd) {
      amountUsd = limit.remaining;
      cappedBy = limit.reason;
    }
  }

  // Floor rather than round: rounding a cent upward would let a copy exceed the
  // very cap that just sized it.
  amountUsd = Math.floor(amountUsd * 100) / 100;

  if (amountUsd < MIN_COPY_USD) {
    // When a cap is what shrank it below the floor, that cap is the honest
    // reason — "Daily cap reached" tells the user something actionable, where
    // "too small to place" would look like a bug in the sizing.
    return { action: "skip", reason: cappedBy ?? "below_minimum" };
  }

  return { action: "buy", amountUsd, cappedBy };
}

/**
 * Mirror a trader's exit at the same *fraction*, not the same size.
 *
 * They may hold 280,000 shares where the user holds 60. Copying the raw share
 * count would try to sell shares that do not exist; copying the fraction keeps
 * the user's position tracking theirs proportionally, which is the only reading
 * of "copy their sell" that generalises.
 *
 * Their pre-sell position is reconstructed as `sold + whatever is left`, since
 * `/positions` is necessarily read *after* the trade has already landed.
 *
 * ⚠️ When their remaining size cannot be read, this exits **fully** rather than
 * guessing a fraction. Over-exiting costs upside; under-exiting leaves a
 * position the user believes they have closed. Only one of those is a surprise
 * that can keep losing money.
 */
function decideExit(intent: CopyIntent, exit: ExitContext | undefined): CopyDecision {
  const ourShares = exit && Number.isFinite(exit.ourShares) ? exit.ourShares : 0;
  if (ourShares <= 0) return { action: "skip", reason: "no_position_to_exit" };

  const theirAfter = exit?.theirSharesAfter;
  const theirBefore =
    theirAfter !== null && theirAfter !== undefined && Number.isFinite(theirAfter)
      ? theirAfter + intent.shares
      : null;

  let fraction = theirBefore && theirBefore > 0 ? intent.shares / theirBefore : 1;
  if (!Number.isFinite(fraction) || fraction <= 0) fraction = 1;
  fraction = Math.min(1, fraction);

  // Snap a near-total exit to a total one so a 99.4% close does not leave 0.6%
  // of dust that is too small to ever sell again.
  const full = fraction >= FULL_EXIT_THRESHOLD;
  const shares = full ? ourShares : Math.floor(ourShares * fraction * 1e4) / 1e4;

  if (shares <= 0) return { action: "skip", reason: "no_position_to_exit" };
  if (shares * intent.avgPrice < MIN_COPY_USD) {
    return { action: "skip", reason: "below_minimum" };
  }

  return { action: "sell", shares, fraction: full ? 1 : fraction };
}

/**
 * `fixed` ignores the source size entirely; `percent` tracks their conviction.
 *
 * `percentOfTheirNotional` is a percent, so `0.2` means 0.2% — copying $24.60
 * of a $12,300 buy. Expressing it as a fraction instead would make an
 * innocent-looking `0.2` mean 20% of a five-figure trade.
 */
function sizeFromSettings(intent: CopyIntent, settings: CopySettings): number {
  if (settings.sizing.mode === "fixed") return safeAmount(settings.sizing.usd);
  const percent = safeAmount(settings.sizing.percentOfTheirNotional);
  return (intent.notionalUsd * percent) / 100;
}

/** A corrupt or hand-edited store must not produce NaN caps that compare false against everything. */
function safeAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
