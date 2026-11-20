import type { BrowserClient } from "./browser-client";
import { fetchDataApiPage } from "./data-api";

/**
 * Trade history / account activity (FR-4.4, implementation.md Step 4.2's
 * deferred half).
 *
 * Browser-side, for the same structural reason as `portfolio.ts` and
 * `redeem.ts`: the feed is keyed by the *Deposit Wallet*, which the server
 * never learns. The browser client knows it as `client.account.wallet`.
 *
 * 🚩 Reads `/v2/activity` directly, not `client.listActivity()`. The pinned SDK
 * (0.2.0) still calls the retired Data API v1, which has answered 410 since
 * 2026-11-02 — see `data-api.ts`. Verified live 2026-11-19:
 *
 *  - v2 serves **one flat row shape** with a `type` string, where the SDK had a
 *    nine-variant union. Credits (`REWARD`, `MAKER_REBATE`, …) arrive with an
 *    empty title, condition and token; `describeActivity` drops those.
 *  - The amount is **`usdc_size`** for every type. A losing redeem is a real 0.
 *  - **`TAKER_REBATE`** is a live type the SDK never had. Unknown types render
 *    as a neutral row under their own name, never as a trade — the old
 *    fall-through-to-trade default would have shown a rebate as "Bought".
 *  - Timestamps are epoch **seconds** on the wire and milliseconds here.
 *  - Only `TIMESTAMP DESC` sorting is accepted.
 *
 * ⚠️ **Rows carry no id**, and a transaction hash is not unique either — one
 * transaction routinely emits several rows. Keys are composed at list level
 * with an occurrence counter; see `describeActivityList`.
 *
 * ⚠️ Amounts are **human decimals**, not 6-decimal base units. Do not run them
 * through `fees.ts`'s `fromBaseUnits`.
 */

/** Coarse grouping for rendering — finer than "everything is a row", coarser than nine variants. */
export type ActivityKind = "trade" | "settlement" | "credit";

/**
 * Which way the cash moved.
 *
 * `neutral` exists for CONVERSION specifically: it is a market migration, and
 * the SDK's own description ("the amount converted or migrated") does not say
 * whether the wallet gained or lost that value. Rendering it as a credit or a
 * debit would be inventing a fact, so it renders unsigned.
 */
export type ActivityDirection = "in" | "out" | "neutral";

export type ActivityEntry = {
  /** Composed, not from the API — rows have no id. Stable within one list. */
  key: string;
  kind: ActivityKind;
  /** Human label: "Bought", "Redeemed", "Maker rebate", … */
  label: string;
  /** Market title, or `null` for account-level credits that belong to no market. */
  title: string | null;
  icon: string | null;
  /** Our detail route resolves *event* slugs — a market slug 404s. `null` renders unlinked. */
  eventSlug: string | null;
  /** Outcome label for CLOB trades; `null` for combo trades and everything else. */
  outcome: string | null;
  side: "BUY" | "SELL" | null;
  /** Shares traded, for trades only. */
  shares: number | null;
  /** Execution price per share, for trades only. */
  price: number | null;
  /** Magnitude in USD, always positive — `direction` carries the sign. */
  amount: number;
  direction: ActivityDirection;
  /** Unix epoch milliseconds. */
  timestamp: number;
  transactionHash: string;
};

/** One `/v2/activity` row, normalised. What lives in component state. */
export type ActivityRow = {
  type: string;
  isCombo: boolean;
  side: string;
  /** `size` on the wire — always shares, never USD. */
  shares: number;
  /** `usdc_size` on the wire. */
  amount: number;
  price: number;
  title: string | null;
  icon: string | null;
  eventSlug: string | null;
  outcome: string | null;
  /** Unix epoch milliseconds. */
  timestamp: number;
  transactionHash: string;
};

/** Normalises `/v2/activity` rows. Exported for testing. */
export function parseActivityRows(rows: unknown[]): ActivityRow[] {
  const parsed: ActivityRow[] = [];

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const type = typeof row.type === "string" ? row.type.toUpperCase() : "";
    if (!type) continue;

    parsed.push({
      type,
      isCombo: row.is_combo === true,
      side: typeof row.side === "string" ? row.side.toUpperCase() : "",
      shares: toNumber(row.size),
      amount: toNumber(row.usdc_size),
      price: toNumber(row.price),
      title: text(row.title),
      icon: text(row.icon),
      eventSlug: text(row.event_slug),
      outcome: text(row.outcome),
      timestamp: toNumber(row.timestamp) * 1000,
      transactionHash: text(row.transaction_hash) ?? "",
    });
  }

  return parsed;
}

const CREDIT_LABELS: Record<string, string> = {
  REWARD: "Reward",
  MAKER_REBATE: "Maker rebate",
  TAKER_REBATE: "Taker rebate",
  REFERRAL_REWARD: "Referral reward",
  YIELD: "Yield",
};

/**
 * Flattens one activity into a renderable row, minus the key (which needs
 * list context to disambiguate — see `describeActivityList`).
 *
 * Exported for testing; components should use `describeActivityList`.
 */
export function describeActivity(activity: ActivityRow): Omit<ActivityEntry, "key"> {
  const base = {
    title: null as string | null,
    icon: null as string | null,
    eventSlug: null as string | null,
    outcome: null as string | null,
    side: null as "BUY" | "SELL" | null,
    shares: null as number | null,
    price: null as number | null,
    amount: activity.amount,
    timestamp: activity.timestamp,
    transactionHash: activity.transactionHash,
  };
  const market = { title: activity.title, icon: activity.icon, eventSlug: activity.eventSlug };

  const credit = CREDIT_LABELS[activity.type];
  if (credit) {
    // Account-level credits belong to no market.
    return { ...base, kind: "credit", label: credit, direction: "in" };
  }

  switch (activity.type) {
    case "TRADE": {
      const isBuy = activity.side === "BUY";
      return {
        ...base,
        ...market,
        kind: "trade",
        label: isBuy ? "Bought" : "Sold",
        // Combo trades have no event page or single outcome, so they render
        // unlinked rather than pointing at a URL that can't resolve.
        eventSlug: activity.isCombo ? null : activity.eventSlug,
        outcome: activity.isCombo ? null : activity.outcome,
        side: isBuy ? "BUY" : "SELL",
        shares: activity.shares,
        price: activity.price,
        direction: isBuy ? "out" : "in",
      };
    }

    // Collateral goes *into* a complete set, so it leaves the cash balance.
    case "SPLIT":
      return { ...base, ...market, kind: "settlement", label: "Split", direction: "out" };

    case "MERGE":
      return { ...base, ...market, kind: "settlement", label: "Merged", direction: "in" };

    case "REDEEM":
      return { ...base, ...market, kind: "settlement", label: "Redeemed", direction: "in" };

    case "CONVERSION":
      return { ...base, ...market, kind: "settlement", label: "Converted", direction: "neutral" };

    default:
      // Unsigned, because guessing a direction would be inventing a fact.
      return { ...base, ...market, kind: "settlement", label: humanise(activity.type), direction: "neutral" };
  }
}

/**
 * Flattens a page (or an accumulation of pages) into renderable rows and
 * assigns each a stable key.
 *
 * Keys compose `transactionHash` + `type` + an occurrence counter rather than
 * using either alone, because **neither is unique**: rows have no id field,
 * and a single transaction routinely produces several rows. The counter
 * is what keeps two identical fills in one transaction from colliding, which
 * would make React drop a row.
 */
export function describeActivityList(activities: ActivityRow[]): ActivityEntry[] {
  const seen = new Map<string, number>();

  return activities.map((activity) => {
    const described = describeActivity(activity);
    const composite = `${described.transactionHash}:${activity.type}`;
    const occurrence = seen.get(composite) ?? 0;
    seen.set(composite, occurrence + 1);
    return { ...described, key: `${composite}:${occurrence}` };
  });
}

export type ActivityPage = {
  items: ActivityRow[];
  /** Pass back to `fetchActivityPage` to continue. `undefined` when the feed is exhausted. */
  nextCursor: string | undefined;
  hasMore: boolean;
};

const PAGE_SIZE = 25;

/**
 * One page of the authenticated account's activity, newest first.
 *
 * The same filters go with every page, cursor or not, so a later page can
 * never be asked a different question than the first one.
 * Deposits and withdrawals stay excluded, as they always were under the SDK.
 */
export async function fetchActivityPage(
  client: BrowserClient,
  cursor?: string,
): Promise<ActivityPage> {
  const page = await fetchDataApiPage("/v2/activity", {
    user: client.account.wallet,
    limit: String(PAGE_SIZE),
    sort_by: "TIMESTAMP",
    sort_direction: "DESC",
    exclude_deposits_withdrawals: "true",
    cursor,
  });

  return {
    items: parseActivityRows(page.rows),
    nextCursor: page.nextCursor ?? undefined,
    hasMore: page.hasMore,
  };
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** `DIRECTIONAL_SPLIT` → `Directional split`. */
function humanise(type: string): string {
  const words = type.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
