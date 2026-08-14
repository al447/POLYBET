import type { PaginationCursor } from "@polymarket/bindings";
import type { Activity } from "@polymarket/bindings/data";

import type { BrowserClient } from "./browser-client";

/**
 * Trade history / account activity (FR-4.4, implementation.md Step 4.2's
 * deferred half).
 *
 * Browser-side against the user's own authenticated client, for the same
 * structural reason as `portfolio.ts` and `redeem.ts`: `ListActivityRequest`
 * requires a `user` address and that address is the *Deposit Wallet*, which the
 * server never learns. `SecureClient.listActivity()` defaults it to its own
 * account.
 *
 * **The whole difficulty here is that `Activity` is a nine-variant union** and
 * the variants genuinely disagree about what fields exist — a REWARD credit has
 * no market, title, icon or condition id at all, and a Combo trade has no
 * `outcome`/`slug`/`eventSlug` where a CLOB trade does. `describeActivity`
 * collapses all nine into one flat renderable row so no component has to narrow
 * the union itself. It is pure, so the interesting part is unit-tested without a
 * network.
 *
 * Two SDK details that shape this file:
 *
 *  1. ⚠️ **`Activity` carries no `id`.** Only `ComboActivity` does. A
 *     transaction hash is *not* unique either — one transaction routinely emits
 *     several activity rows (a trade filling against multiple makers, a batched
 *     operation). Keys are therefore composed at list level with an occurrence
 *     counter; see `describeActivityList`.
 *  2. `type` discriminates the union, but the TRADE variant types it as the
 *     `ActivityType` **enum member** while the other eight use plain string
 *     literals. TypeScript treats string enums as nominal, so
 *     `activity.type === "TRADE"` is a compile error. Switching on the eight
 *     literals and letting `default` narrow to the trade sidesteps that *and*
 *     avoids a value import of `@polymarket/bindings/data`, which would drag
 *     that module's zod schemas into the client bundle for the sake of one enum
 *     comparison. The bundle is already ~48% of the paid cap.
 *
 * ⚠️ Amounts are **human decimals** from the Data API, not 6-decimal base
 * units. Do not run them through `fees.ts`'s `fromBaseUnits`.
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
  /** Composed, not from the API — `Activity` has no id. Stable within one list. */
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

/**
 * Flattens one activity into a renderable row, minus the key (which needs
 * list context to disambiguate — see `describeActivityList`).
 *
 * Exported for testing; components should use `describeActivityList`.
 */
export function describeActivity(activity: Activity): Omit<ActivityEntry, "key"> {
  const base = {
    title: null as string | null,
    icon: null as string | null,
    eventSlug: null as string | null,
    outcome: null as string | null,
    side: null as "BUY" | "SELL" | null,
    shares: null as number | null,
    price: null as number | null,
    timestamp: Number(activity.timestamp),
    transactionHash: String(activity.transactionHash),
  };

  switch (activity.type) {
    case "SPLIT":
      return {
        ...base,
        kind: "settlement",
        label: "Split",
        title: activity.title,
        icon: activity.icon,
        eventSlug: activity.eventSlug,
        // Collateral goes *into* a complete set, so it leaves the cash balance.
        amount: toNumber(activity.amount),
        direction: "out",
      };

    case "MERGE":
      return {
        ...base,
        kind: "settlement",
        label: "Merged",
        title: activity.title,
        icon: activity.icon,
        eventSlug: activity.eventSlug,
        amount: toNumber(activity.amount),
        direction: "in",
      };

    case "REDEEM":
      return {
        ...base,
        kind: "settlement",
        label: "Redeemed",
        title: activity.title,
        icon: activity.icon,
        eventSlug: activity.eventSlug,
        amount: toNumber(activity.amount),
        direction: "in",
      };

    case "CONVERSION":
      return {
        ...base,
        kind: "settlement",
        label: "Converted",
        title: activity.title,
        icon: activity.icon,
        eventSlug: activity.eventSlug,
        amount: toNumber(activity.amount),
        direction: "neutral",
      };

    // The four account-level credits carry an amount and nothing else — no
    // market, no title, no condition id.
    case "REWARD":
      return { ...base, kind: "credit", label: "Reward", amount: toNumber(activity.amount), direction: "in" };

    case "MAKER_REBATE":
      return { ...base, kind: "credit", label: "Maker rebate", amount: toNumber(activity.amount), direction: "in" };

    case "REFERRAL_REWARD":
      return { ...base, kind: "credit", label: "Referral reward", amount: toNumber(activity.amount), direction: "in" };

    case "YIELD":
      return { ...base, kind: "credit", label: "Yield", amount: toNumber(activity.amount), direction: "in" };

    default: {
      // Narrows to TradeActivity — see the enum note in the module docstring.
      const trade = activity;
      const isBuy = trade.side === "BUY";
      return {
        ...base,
        kind: "trade",
        label: isBuy ? "Bought" : "Sold",
        title: trade.title,
        icon: trade.icon,
        // Combo trades have no market/event slug or outcome label at all, so
        // they render unlinked rather than pointing at a URL that can't resolve.
        eventSlug: trade.isCombo ? null : trade.eventSlug,
        outcome: trade.isCombo ? null : trade.outcome,
        side: isBuy ? "BUY" : "SELL",
        shares: toNumber(trade.shares),
        price: toNumber(trade.price),
        amount: toNumber(trade.amount),
        direction: isBuy ? "out" : "in",
      };
    }
  }
}

/**
 * Flattens a page (or an accumulation of pages) into renderable rows and
 * assigns each a stable key.
 *
 * Keys compose `transactionHash` + `type` + an occurrence counter rather than
 * using either alone, because **neither is unique**: `Activity` has no id
 * field, and a single transaction routinely produces several rows. The counter
 * is what keeps two identical fills in one transaction from colliding, which
 * would make React drop a row.
 */
export function describeActivityList(activities: Activity[]): ActivityEntry[] {
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
  items: Activity[];
  /**
   * Pass back to `fetchActivityPage` to continue. `undefined` when the feed is
   * exhausted. Kept as the SDK's branded `PaginationCursor` rather than widened
   * to `string` — widening would only force a cast back at the call site.
   */
  nextCursor: PaginationCursor | undefined;
  /**
   * ⚠️ Optimistic. The SDK documents that a full page reports `true` even when
   * the collection ended exactly on a page boundary, and the follow-up request
   * then returns an empty page. So a "Load more" driven by this can produce one
   * final no-op click; treat it as "maybe more", never as "definitely more".
   */
  hasMore: boolean;
};

const PAGE_SIZE = 25;

/**
 * One page of the authenticated account's activity, newest first.
 *
 * `user` is deliberately not passed — `SecureClient` defaults it to its own
 * account, which is the Deposit Wallet we want and the only one we can name.
 */
export async function fetchActivityPage(
  client: BrowserClient,
  cursor?: PaginationCursor,
): Promise<ActivityPage> {
  const paginator = client.listActivity({
    pageSize: PAGE_SIZE,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });

  const page = cursor
    ? await paginator.from(cursor).firstPage()
    : await paginator.firstPage();

  return {
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
