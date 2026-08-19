/**
 * Copy-trading shapes, presets and the execution switch.
 *
 * Deliberately **not** `server-only`, and deliberately importing nothing at all
 * — the whole copy engine runs in the browser tab, so these types are consumed
 * by client components, the poller hook and the pure decision core alike. Same
 * split as `leaderboard-types.ts` / `leaderboard.ts`.
 *
 * 🚩 Nothing in this directory may run on the server. The engine watches other
 * traders and places orders from the user's own Privy wallet; there is no
 * delegation and no daemon, which is precisely what keeps this on the right
 * side of OI-5. A "small" server-side helper that signs, or a cron that polls
 * on the user's behalf, re-opens the custody question this design exists to
 * avoid.
 */

/**
 * 🚩 The one switch that decides whether copies spend real money. **Currently
 * `"live"`** — set 2026-08-19.
 *
 * `"live"` does not mean hands-off. Every approved copy stops at `queued` and
 * waits for the user to click **Place**, which is what keeps this on the right
 * side of OI-5: the engine has no more authority than the person at the screen,
 * and nothing is signed without a human action. See `placeCopy` in `execute.ts`
 * for what that click actually does.
 *
 * `"simulated"` runs the entire pipeline — poll, group, size, cap, preflight —
 * and records what it *would* have done, without ever calling `placeMarketBuy`.
 * That is the only way to exercise this against live traders without risk:
 * there is no testnet for the production CLOB, so the alternative to a dry run
 * is debugging with real pUSD. Switch back to it to test engine changes.
 *
 * A code constant, not a UI toggle, on purpose. A switch that turns on real
 * spending is not something a user should be able to hit by accident.
 */
export const COPY_EXECUTION_MODE: CopyExecutionMode = "live";

export type CopyExecutionMode = "simulated" | "live";

/**
 * How far the price may move against the copy before it is not worth placing.
 *
 * 🚩 A copy is a decision about the price **they** got. By the time the user
 * clicks Place, the source trade is at least a poll interval old and the book
 * has had time to move — often *because* of the trade being copied. Filling at
 * any price would turn "copy their 0.32 entry" into "buy at 0.61 because they
 * bought", which is the opposite of copying them.
 *
 * So every copy carries a `maxPrice` (buy) or `minPrice` (sell) anchored on
 * their fill. Outside the band the order does not fill and the row lands as
 * `failed` with the reason visible — a missed copy the user can see, rather
 * than a silent bad fill they discover in their positions.
 *
 * Same 5% band `TradingPanel` uses, for the same reason; the difference is only
 * what it is anchored on (their fill price, not our order book).
 */
export const COPY_MAX_SLIPPAGE = 0.05;

/**
 * Our own floor on a copy's notional, chosen to clear the CLOB's floor by
 * arithmetic rather than by luck.
 *
 * 🚩 The CLOB's `min_order_size` is denominated in **shares**, not dollars —
 * typically 5. Shares are `usd / price` and a price never exceeds `1.00`, so
 * **$5 buys at least 5 shares at any price**, whatever the market. At the old
 * value of $1 a copy could be sized perfectly legally by our own caps and then
 * rejected upstream, landing as a red `failed` row carrying a raw SDK message:
 *
 * ```text
 * $2 at price 0.90 -> 2.22 shares -> rejected
 * $5 at price 0.99 -> 5.05 shares -> fine
 * ```
 *
 * ⚠️ This still is not *the* Polymarket minimum, because that number is
 * per-market and can be higher. `checkCopyPreconditions` reads the market's own
 * `minOrderSize` at click time and skips honestly; this constant is the cheap
 * layer that keeps almost every copy from reaching that check at all.
 */
export const MIN_COPY_USD = 5;

/**
 * How long an order is given to finish filling before we act on it.
 *
 * 🚩 This is what stops one order being copied twice. A large order fills in
 * several rows (see `groupFillsIntoIntents`), and the poller can easily observe
 * the first two fills on one tick and the third on the next — copying the same
 * intent twice, at two different sizes. Ignoring anything younger than this
 * means an order has stopped filling before it is ever grouped.
 *
 * The cost is latency: copies lag the source trade by at least this much, on
 * top of the poll interval. Five seconds is cheap against a poll interval
 * measured in tens of seconds.
 */
export const SETTLE_DELAY_SECONDS = 5;

/**
 * A sell that closes at least this fraction of their position is treated as a
 * full exit of ours.
 *
 * Without it, a trader closing 99.4% of a position leaves us holding 0.6% —
 * dust that is too small to sell again, too small to matter, and clutters the
 * positions list forever. Rounding *up* to a full exit is the safe direction:
 * it can only reduce exposure.
 */
export const FULL_EXIT_THRESHOLD = 0.98;

/**
 * How long a `queued` copy stays actionable before it is abandoned.
 *
 * 🚩 A copy is a decision about a price that existed at `decidedAt`. Resolving
 * one that has been sitting since yesterday would record a "position" opened at
 * a price nobody could get today, and the four headline tiles are computed from
 * exactly those rows. The tab-closed case makes this ordinary rather than
 * exotic: the engine only runs while the tab is open, so a reopened tab always
 * finds whatever the last session left mid-flight.
 *
 * Expiring is the honest answer — the copy did not happen, and pretending
 * otherwise corrupts the dry run's numbers, which is the one thing the dry run
 * is for. Ten minutes is well past the poll interval and well short of a price
 * moving out from under the decision.
 */
export const QUEUE_EXPIRY_MS = 10 * 60 * 1000;

/**
 * One trade by a followed trader, normalised from `data-api.polymarket.com/v1`
 * `/trades?user=<addr>`.
 *
 * Field names are ours, not the wire's — `asset` becomes `tokenId` because that
 * is what `placeMarketBuy` calls it, and reading `asset` at an order call site
 * invites passing the wrong id. Verified shape 2026-08-17; see
 * `trader-feed.ts` for the parser.
 */
export type TraderTrade = {
  /** The trader's `proxyWallet`. */
  address: string;
  side: "BUY" | "SELL";
  /** CLOB token id — one side of one market. The `asset` field on the wire. */
  tokenId: string;
  conditionId: string;
  /** Outcome tokens, human decimals. */
  size: number;
  /** Per-share price, 0–1. */
  price: number;
  /** Unix **seconds**, not milliseconds. */
  timestamp: number;
  title: string;
  outcome: string;
  slug: string;
  eventSlug: string;
  icon?: string;
  transactionHash: string;
};

/**
 * Several fills of one order, collapsed into the single decision they
 * represent.
 *
 * The distinction matters more than it looks: a trader's $12K buy arrives as
 * three rows with three different transaction hashes, and treating each as a
 * copyable event places three orders for one intent.
 */
export type CopyIntent = {
  /**
   * `address:tokenId:side:timestamp` — also the dedup key written to the
   * ledger, so a restart cannot re-copy something already handled.
   */
  key: string;
  address: string;
  side: "BUY" | "SELL";
  tokenId: string;
  conditionId: string;
  /** Σ shares across the grouped fills. */
  shares: number;
  /** Σ (shares × price) — what they actually put in or took out. */
  notionalUsd: number;
  /** Size-weighted average fill price, 0–1. */
  avgPrice: number;
  /** Unix seconds of the earliest fill in the group. */
  timestamp: number;
  /** How many wire rows collapsed into this. `1` is the common case. */
  fillCount: number;
  title: string;
  outcome: string;
  slug: string;
  eventSlug: string;
  icon?: string;
};

/**
 * How a copy is sized against the source trade.
 *
 * `fixed` is the honest default: the same dollar amount every time, regardless
 * of whether the trader put in $200 or $200,000. `percent` mirrors their
 * conviction but is dangerous unbounded, which is why `perTradeCapUsd` applies
 * to both modes rather than only to `percent`.
 */
export type CopySizing =
  | { mode: "fixed"; usd: number }
  | { mode: "percent"; percentOfTheirNotional: number };

/**
 * Per-trader spending limits. Every one of these is a hard stop evaluated
 * *before* an order is signed, never a warning after the fact.
 */
export type CopySettings = {
  sizing: CopySizing;
  /** Ceiling on a single copy. */
  perTradeCapUsd: number;
  /** Ceiling on copies opened since UTC midnight. */
  dailyCapUsd: number;
  /** Ceiling on notional currently deployed in open copies of this trader. */
  totalCapUsd: number;
};

export const DEFAULT_COPY_SETTINGS: CopySettings = {
  sizing: { mode: "fixed", usd: 25 },
  perTradeCapUsd: 25,
  dailyCapUsd: 100,
  totalCapUsd: 500,
};

/** A trader the user follows, plus everything needed to resume watching them. */
export type FollowedTrader = {
  address: string;
  /** Snapshotted at follow time from `traderDisplayName` — the board may re-rank. */
  name: string;
  avatar?: string;
  /** ISO 8601. */
  followedAt: string;
  /**
   * 🚩 Unix **seconds** of the newest trade already accounted for. `null` means
   * "not yet seeded" — the poller sets it to `now` and copies nothing on that
   * pass.
   *
   * Nullable rather than defaulting to `0`, and that is the whole point.
   * `/trades` has no practical page cap — asking for 500 returned a trader's
   * entire 279-row history — so a cursor of `0` means *copy every trade this
   * person has ever made, right now*. `null` is the only honest value for
   * "unknown", and it fails toward copying nothing instead of copying
   * everything. A corrupt stored cursor is normalised to `null` for the same
   * reason.
   */
  cursor: number | null;
  paused: boolean;
  settings: CopySettings;
};

/** Why a detected trade did not become an order. Surfaced verbatim in the Skipped tab. */
export type SkipReason =
  | "per_trade_cap"
  | "daily_cap"
  | "total_cap"
  | "below_minimum"
  | "market_closed"
  | "trader_paused"
  | "no_position_to_exit"
  | "insufficient_balance"
  | "preflight_rejected";

/**
 * Reader-facing text for each reason.
 *
 * Written as statements of fact about the user's own limits rather than as
 * errors: a skipped copy is the caps working, not a failure. The two that
 * genuinely are failures (`insufficient_balance`, `preflight_rejected`) say so.
 */
export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  per_trade_cap: "Above your per-trade cap",
  daily_cap: "Daily cap reached",
  total_cap: "Total cap reached",
  // Deliberately not interpolating MIN_COPY_USD: the same reason also covers a
  // market whose own minimum is higher than our floor, so naming one figure
  // would be wrong half the time.
  below_minimum: "Too small to place",
  market_closed: "Market already settled",
  trader_paused: "Trader paused",
  no_position_to_exit: "You held none of this outcome",
  insufficient_balance: "Not enough pUSD",
  preflight_rejected: "Rejected before signing",
};

/**
 * What the engine decided to do about one intent.
 *
 * A buy is sized in **USD**, a sell in **shares** — matching `placeMarketBuy`'s
 * `amount` and `placeMarketSell`'s `shares` exactly, so no call site has to
 * convert between the two and get the direction wrong.
 */
export type CopyDecision =
  | { action: "buy"; amountUsd: number; cappedBy: SkipReason | null }
  | { action: "sell"; shares: number; fraction: number }
  | { action: "skip"; reason: SkipReason };

/** Per-trader accounting the decision needs. Computed from the ledger by `summariseBudget`. */
export type CopyBudgetState = {
  /** Σ copy notional opened for this trader since UTC midnight. */
  spentTodayUsd: number;
  /** Σ copy notional for this trader still held in open copies. */
  deployedUsd: number;
};

/** What an exit needs to know that the intent alone cannot say. */
export type ExitContext = {
  /** Shares of this token the user currently holds. `0` means nothing to exit. */
  ourShares: number;
  /**
   * Their remaining shares of this token **after** the sell, read from
   * `/positions`. `null` when it could not be read — see `decideCopy` for why
   * that falls back to a full exit rather than a proportional guess.
   */
  theirSharesAfter: number | null;
};

/**
 * One row of the copy ledger — the single source for all three tabs and for
 * the four headline tiles.
 *
 * `status` is what separates them: `skipped` rows are the Skipped tab,
 * everything else is Copy activity, and the open `placed`/`simulated` rows with
 * remaining shares are Copied positions.
 */
export type CopyLedgerEntry = {
  /** Unique per row. The intent key plus a suffix, since one intent can retry. */
  id: string;
  /** The originating intent — a stable dedup key across restarts. */
  intentKey: string;
  address: string;
  traderName: string;
  side: "BUY" | "SELL";
  tokenId: string;
  conditionId: string;
  title: string;
  outcome: string;
  slug: string;
  eventSlug: string;
  icon?: string;
  /** ISO 8601, when we decided — not when they traded. */
  decidedAt: string;
  /** Unix seconds of the source trade, for the "12s after source" latency read. */
  sourceTimestamp: number;
  status: CopyEntryStatus;
  /** Set on skip. */
  skipReason?: SkipReason;
  /** USD notional for a buy; shares for a sell. Absent on a skip. */
  amountUsd?: number;
  shares?: number;
  /** Price we saw at decision time — not necessarily the fill. */
  expectedPrice?: number;
  /** Disclosed taker fee in bps from `preflightOrder`. */
  feeBps?: number;
  /**
   * The CLOB's own order id, set only on `placed`.
   *
   * The one field in this row that proves a real order exists — everything else
   * is our own record of a decision. Its presence is what separates a copy that
   * reached Polymarket from one that merely looks like it did.
   */
  orderId?: string;
  /** Free text on a failure, straight from the SDK or the preflight message. */
  error?: string;
};

/**
 * `queued` — approved by the engine, not yet acted on. A transient state in a
 *   dry run, where the resolution sweep clears it within a second; the state a
 *   copy *waits* in under `"live"`, where it needs the user's click.
 * `simulated` — the dry run's stand-in for `placed`; never touched money.
 * `placed` — really signed and sent to the CLOB.
 * `cancelled` — dismissed by the user, or expired before it could be acted on
 *   (see {@link QUEUE_EXPIRY_MS}). Both mean the same thing to every reader of
 *   the ledger: it never became an order and never will.
 */
export type CopyEntryStatus =
  | "queued"
  | "placed"
  | "simulated"
  | "skipped"
  | "failed"
  | "cancelled";
