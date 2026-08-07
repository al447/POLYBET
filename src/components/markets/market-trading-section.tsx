"use client";

import { useState } from "react";

import { OutcomeList } from "@/components/markets/outcome-list";
import { TradingPanel } from "@/components/trade/trading-panel";
import type { GammaEvent, GammaMarket } from "@/lib/polymarket/gamma-types";

/**
 * Two-column layout matching Polymarket's own event page: outcome list on
 * the left, sticky trading panel on the right. Owns the "which outcome is
 * selected" state so a click in `OutcomeList` updates `TradingPanel`
 * in place — see trading-panel.tsx for why the panel itself splits wallet
 * connection (persists across selections) from the ticket (resets per
 * selection).
 */
export function MarketTradingSection({ event }: { event: GammaEvent }) {
  const markets = event.markets ?? [];
  const [selected, setSelected] = useState<{ market: GammaMarket; outcomeIndex: number } | null>(
    markets[0] ? { market: markets[0], outcomeIndex: 0 } : null,
  );

  return (
    <div className="lg:grid lg:grid-cols-[1fr_400px] lg:items-start lg:gap-8">
      <div className="min-w-0">
        <OutcomeList
          markets={markets}
          selectedMarketId={selected?.market.id ?? null}
          onSelect={(market, outcomeIndex) => setSelected({ market, outcomeIndex })}
        />
      </div>

      <div className="mt-6 lg:sticky lg:top-20 lg:mt-0">
        {selected ? (
          <TradingPanel market={selected.market} outcomeIndex={selected.outcomeIndex} eventTitle={event.title} />
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 text-base text-zinc-500">
            No tradeable outcomes for this event.
          </div>
        )}
      </div>
    </div>
  );
}
