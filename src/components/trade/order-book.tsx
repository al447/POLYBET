import { Card, StatusDot } from "@/components/ui/primitives";
import type { OrderBookStatus } from "@/hooks/use-orderbook";
import type { OrderBookLevel, OrderBookState } from "@/lib/polymarket/market-data";

/**
 * Live bid/ask depth for the currently-selected outcome (FR-3.4, Step 3.2).
 * Purely presentational — `book`/`status` come from `useOrderBook`, lifted
 * into `TradingPanel` so the same subscription also feeds the slippage
 * guard, rather than subscribing twice.
 *
 * Rows are display-only: implementation.md's "click-to-fill price into the
 * ticket" presumes a price input, which only exists once limit orders land.
 * Wiring a click handler onto a market-order ticket with no price field
 * would be a fake affordance, so it's deferred rather than faked.
 */

const DEPTH_ROWS = 8;

const STATUS_TONE: Record<OrderBookStatus, "ok" | "warn" | "bad" | "idle"> = {
  live: "ok",
  connecting: "warn",
  reconnecting: "warn",
  error: "bad",
  idle: "idle",
};

const STATUS_LABEL: Record<OrderBookStatus, string> = {
  live: "Live",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  error: "Unavailable",
  idle: "—",
};

export function OrderBook({
  book,
  status,
  outcomeLabel,
}: {
  book: OrderBookState | null;
  status: OrderBookStatus;
  outcomeLabel?: string;
}) {
  const bestBid = book?.bids[0];
  const bestAsk = book?.asks[0];
  const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;

  return (
    <Card
      title={`Order book${outcomeLabel ? ` — ${outcomeLabel}` : ""}`}
      action={
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
          <StatusDot tone={STATUS_TONE[status]} />
          {STATUS_LABEL[status]}
        </span>
      }
    >
      {!book ? (
        <p className="py-1 text-sm text-zinc-500">
          {status === "error"
            ? "Order book unavailable — trading still works from the snapshot price."
            : "Waiting for live prices…"}
        </p>
      ) : (
        <div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <BookSide title="Bids" levels={book.bids.slice(0, DEPTH_ROWS)} tone="bid" />
            <BookSide title="Asks" levels={book.asks.slice(0, DEPTH_ROWS)} tone="ask" />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-zinc-800 pt-2 text-xs text-zinc-500">
            <span>{spread !== null ? `Spread ${(spread * 100).toFixed(1)}¢` : "—"}</span>
            <span>
              {book.lastTradePrice !== null ? `Last ${(book.lastTradePrice * 100).toFixed(1)}¢` : ""}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function BookSide({
  title,
  levels,
  tone,
}: {
  title: string;
  levels: OrderBookLevel[];
  tone: "bid" | "ask";
}) {
  const maxSize = Math.max(1, ...levels.map((level) => level.size));
  const textColor = tone === "bid" ? "text-emerald-400" : "text-red-400";
  const barColor = tone === "bid" ? "bg-emerald-500/10" : "bg-red-500/10";

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-600 uppercase">{title}</p>
      <div className="space-y-0.5">
        {levels.length === 0 ? (
          <p className="text-zinc-700">—</p>
        ) : (
          levels.map((level) => (
            <div
              key={level.price}
              className="relative flex items-center justify-between rounded px-1.5 py-0.5"
            >
              <div
                aria-hidden
                className={`absolute inset-y-0 ${tone === "bid" ? "right-0" : "left-0"} ${barColor}`}
                style={{ width: `${Math.min(100, (level.size / maxSize) * 100)}%` }}
              />
              <span className={`relative font-mono ${textColor}`}>{(level.price * 100).toFixed(1)}¢</span>
              <span className="relative text-zinc-500">{formatSize(level.size)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatSize(size: number): string {
  if (size >= 1000) return `${(size / 1000).toFixed(1)}k`;
  return size.toFixed(size < 10 ? 1 : 0);
}
