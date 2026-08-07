import Image from "next/image";
import Link from "next/link";

import { snapshotPrice } from "@/lib/polymarket/gamma-types";
import type { GammaEvent, GammaMarket } from "@/lib/polymarket/gamma-types";

/**
 * One event tile for the discovery grid (FR-2.1, FR-2.3).
 *
 * The probability shown here is a Gamma snapshot (best bid/ask as of the last
 * ~30-60s cache refresh, falling back to last-traded outcome price), good
 * enough to browse by — NOT the live tradeable price. That comes from the
 * CLOB order-book WebSocket once a market is opened (Milestone 3); never wire
 * this number to anything that fills an order.
 *
 * Navigates to `/market/[slug]` (the event's slug) rather than trading
 * directly from the card — changed 2026-08-07 to match Polymarket's own
 * browse-then-trade flow. The ticket (`TradingPanel`, via
 * `MarketTradingSection`) now lives on that page, not here.
 */
export function MarketCard({ event }: { event: GammaEvent }) {
  const markets = event.markets ?? [];
  const primary = markets[0];
  const isBinary = markets.length === 1 && primary !== undefined;

  return (
    <Link
      href={`/market/${event.slug}`}
      className="flex h-full flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-zinc-700 hover:bg-zinc-900/70"
    >
      <div className="flex items-start gap-3">
        {event.icon ? (
          // `unoptimized`: skips Next's image-transform pipeline (untested on
          // this Workers/OpenNext setup, hundreds of distinct market icons)
          // in favor of the plain original URL — still gets next/image's lazy
          // loading and layout stability, just not the resize/reformat step.
          <Image
            src={event.icon}
            alt=""
            width={40}
            height={40}
            className="size-10 shrink-0 rounded-lg object-cover"
            unoptimized
          />
        ) : (
          <div className="size-10 shrink-0 rounded-lg bg-zinc-800" aria-hidden />
        )}
        <h3 className="line-clamp-2 text-sm font-medium text-zinc-100">{event.title}</h3>
      </div>

      {isBinary ? <BinaryOutcome market={primary} /> : <MultiOutcome markets={markets} />}

      <dl className="mt-auto flex items-center justify-between border-t border-zinc-800/60 pt-3 text-xs text-zinc-500">
        <div>
          <dt className="sr-only">Volume</dt>
          <dd>{formatUsd(event.volume)} vol</dd>
        </div>
        <div>
          <dt className="sr-only">Ends</dt>
          <dd>{formatEndDate(event.endDate)}</dd>
        </div>
      </dl>
    </Link>
  );
}

function BinaryOutcome({ market }: { market: GammaMarket }) {
  const price = snapshotPrice(market);
  const pct = price !== null ? Math.round(price * 100) : null;

  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-400" style={{ width: `${pct ?? 50}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-sm font-semibold text-zinc-100">
        {pct !== null ? `${pct}%` : "—"}
      </span>
    </div>
  );
}

function MultiOutcome({ markets }: { markets: GammaMarket[] }) {
  const ranked = markets
    .map((market) => {
      const price = snapshotPrice(market);
      return { market, pct: price !== null ? Math.round(price * 100) : null };
    })
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
    .slice(0, 3);

  return (
    <ul className="flex flex-col gap-1.5">
      {ranked.map(({ market, pct }) => (
        <li key={market.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-zinc-400">{market.question}</span>
          <span className="shrink-0 font-medium text-zinc-200">{pct !== null ? `${pct}%` : "—"}</span>
        </li>
      ))}
      {markets.length > ranked.length ? (
        <li className="text-xs text-zinc-600">+{markets.length - ranked.length} more</li>
      ) : null}
    </ul>
  );
}

function formatUsd(value: number | string | undefined): string {
  const num = typeof value === "string" ? Number(value) : value;
  if (!num || !Number.isFinite(num)) return "$0";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

function formatEndDate(endDate: string | undefined): string {
  if (!endDate) return "No end date";
  const date = new Date(endDate);
  if (Number.isNaN(date.getTime())) return "No end date";
  if (date.getTime() < Date.now()) return "Ended";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
