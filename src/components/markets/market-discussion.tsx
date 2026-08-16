import { getCachedEventComments } from "@/lib/polymarket/gamma";
import { getCachedMarketTrades, getCachedTopHolders } from "@/lib/polymarket/market-social";
import { formatRelativeTime } from "@/lib/format";
import type { GammaEvent, GammaMarket } from "@/lib/polymarket/gamma-types";
import { MarketDiscussionTabs } from "@/components/markets/market-discussion-tabs";
import type { CommentView, HolderView, TradeView } from "@/components/markets/market-discussion-tabs";

/**
 * Server half of the Comments / Top Holders / Positions / Activity block.
 *
 * All three public tabs are fetched **here, in parallel, and cached**, then
 * handed to the client component as plain data. Tab switching is therefore
 * instant and costs no request — which is the right trade when the payloads are
 * this small and every visitor opens at most one or two of them.
 *
 * The Positions tab is deliberately absent from this fetch: Polymarket's
 * `/positions` endpoint is per-**user**, not per-market, so it can only be read
 * for the signed-in viewer. It loads on demand inside the client component.
 */

const COMMENT_LIMIT = 20;
const HOLDER_LIMIT = 10;
const TRADE_LIMIT = 20;

export async function MarketDiscussion({
  event,
  market,
}: {
  event: GammaEvent;
  market?: GammaMarket;
}) {
  const conditionId = market?.conditionId;

  const [comments, holders, trades] = await Promise.all([
    getCachedEventComments(event.id, COMMENT_LIMIT),
    conditionId ? getCachedTopHolders(conditionId, HOLDER_LIMIT) : Promise.resolve([]),
    conditionId ? getCachedMarketTrades(conditionId, TRADE_LIMIT) : Promise.resolve([]),
  ]);

  // Timestamps are formatted server-side. `formatRelativeTime` reads the clock,
  // and doing it in the browser instead would produce a different string on
  // first render than the server sent — a hydration mismatch on every row.
  const commentViews: CommentView[] = comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    name: comment.profile?.name || comment.profile?.pseudonym || "Anonymous",
    avatar: comment.profile?.profileImage,
    ago: formatRelativeTime(comment.createdAt),
    reactions: comment.reactionCount ?? 0,
  }));

  const holderViews: HolderView[] = holders.map((holder) => ({
    address: holder.address,
    name: holder.name,
    avatar: holder.avatar,
    shares: holder.shares,
    outcomeLabel: outcomeLabelFor(market, holder.outcomeIndex),
  }));

  const tradeViews: TradeView[] = trades.map((trade) => ({
    key: trade.key,
    name: trade.name,
    avatar: trade.avatar,
    side: trade.side,
    outcome: trade.outcome,
    shares: trade.shares,
    price: trade.price,
    ago: formatRelativeTime(new Date(trade.timestamp * 1000).toISOString()),
  }));

  return (
    <MarketDiscussionTabs
      eventSlug={event.slug}
      comments={commentViews}
      holders={holderViews}
      trades={tradeViews}
    />
  );
}

/**
 * Maps a holder's `outcomeIndex` back to its label.
 *
 * Falls back to "Yes"/"No" rather than showing a bare index: those are the
 * labels on every binary market, and an unexplained "0" next to a position
 * size is worse than a close guess.
 */
function outcomeLabelFor(market: GammaMarket | undefined, index: number): string {
  if (!market) return index === 0 ? "Yes" : "No";
  try {
    const labels = JSON.parse(market.outcomes) as unknown;
    if (Array.isArray(labels) && typeof labels[index] === "string") return labels[index];
  } catch {
    // Malformed `outcomes` is a known Gamma condition — fall through.
  }
  return index === 0 ? "Yes" : "No";
}

export function MarketDiscussionSkeleton() {
  return <div className="h-64 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/40" />;
}
