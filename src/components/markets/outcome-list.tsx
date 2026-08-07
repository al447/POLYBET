import Image from "next/image";

import { outcomePriceFractions, outcomeTokens, snapshotPrice } from "@/lib/polymarket/gamma-types";
import type { GammaMarket } from "@/lib/polymarket/gamma-types";

/**
 * Left-column outcome list on the market detail page. Every outcome gets its
 * own Buy Yes / Buy No buttons directly in the row (matching Polymarket's own
 * layout) — clicking one selects that market+outcome in the sticky
 * `TradingPanel` alongside it, rather than opening a modal.
 *
 * Sized deliberately large (big percentages, solid-color buttons) per a
 * direct request 2026-08-07 to match the visual weight of Polymarket's own
 * reference UI, not just its structure.
 */
export function OutcomeList({
  markets,
  selectedMarketId,
  onSelect,
}: {
  markets: GammaMarket[];
  selectedMarketId: string | null;
  onSelect: (market: GammaMarket, outcomeIndex: number) => void;
}) {
  const ranked = markets
    .map((market) => ({ market, price: snapshotPrice(market) }))
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));

  if (ranked.length === 0) {
    return <p className="text-sm text-zinc-500">No outcomes to trade.</p>;
  }

  if (ranked.length === 1) {
    const { market, price } = ranked[0];
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <div className="mb-5 flex items-center gap-4">
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-400"
              style={{ width: `${price !== null ? price * 100 : 50}%` }}
            />
          </div>
          <span className="text-3xl font-bold text-zinc-100 tabular-nums">
            {price !== null ? `${Math.round(price * 100)}%` : "—"}
          </span>
        </div>
        <OutcomeButtons market={market} active={selectedMarketId === market.id} onSelect={onSelect} />
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900/40">
      {ranked.map(({ market, price }) => (
        <li key={market.id} className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {market.icon ? (
              <Image
                src={market.icon}
                alt=""
                width={36}
                height={36}
                className="size-9 shrink-0 rounded-full object-cover"
                unoptimized
              />
            ) : null}
            <p className="truncate text-base font-medium text-zinc-200">{market.question}</p>
          </div>
          <span className="w-16 shrink-0 text-right text-2xl font-bold text-zinc-100 tabular-nums">
            {price !== null ? `${Math.round(price * 100)}%` : "—"}
          </span>
          <OutcomeButtons
            market={market}
            active={selectedMarketId === market.id}
            onSelect={onSelect}
            compact
          />
        </li>
      ))}
    </ul>
  );
}

function OutcomeButtons({
  market,
  active,
  compact,
  onSelect,
}: {
  market: GammaMarket;
  active: boolean;
  compact?: boolean;
  onSelect: (market: GammaMarket, outcomeIndex: number) => void;
}) {
  const outcomes = outcomeTokens(market);
  const prices = outcomePriceFractions(market);

  if (outcomes.length === 0) {
    return <span className="shrink-0 text-sm text-zinc-600">Unavailable</span>;
  }

  return (
    <div className={`flex shrink-0 gap-2 ${compact ? "" : "text-base"}`}>
      {outcomes.map((o, i) => {
        const isYes = o.label.toLowerCase() === "yes";
        const cents = Number.isFinite(prices[i]) ? `${(prices[i] * 100).toFixed(1)}¢` : "—";
        return (
          <button
            key={o.tokenId}
            type="button"
            onClick={() => onSelect(market, i)}
            className={`rounded-xl font-bold transition ${compact ? "px-4 py-2.5 text-sm" : "px-6 py-3 text-base"} ${
              isYes
                ? "bg-emerald-500 text-black hover:bg-emerald-400"
                : "bg-red-500/90 text-white hover:bg-red-500"
            } ${active ? "ring-2 ring-inset ring-zinc-100" : ""}`}
          >
            {compact ? `${o.label} ${cents}` : `Buy ${o.label} ${cents}`}
          </button>
        );
      })}
    </div>
  );
}
