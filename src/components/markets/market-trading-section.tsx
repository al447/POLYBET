"use client";

import { useState, type ReactNode } from "react";

import { OutcomeList } from "@/components/markets/outcome-list";
import { TradingPanel } from "@/components/trade/trading-panel";
import type { GammaEvent, GammaMarket } from "@/lib/polymarket/gamma-types";

/**
 * Two-column layout matching Polymarket's own event page: price chart then
 * outcome list on the left, sticky order ticket on the right, both starting at
 * the same height. Owns the "which outcome is selected" state so a click in
 * `OutcomeList` updates `TradingPanel` in place — see trading-panel.tsx for
 * why the panel itself splits wallet connection (persists across selections)
 * from the ticket (resets per selection).
 *
 * `chart` is a **slot**, not something this component builds. The chart is an
 * async Server Component (it fetches price history upstream); this file is
 * `"use client"`, so it can't render one itself. Taking it as a prop lets the
 * page compose the two — a server-rendered subtree handed to a client parent —
 * which is what puts the chart inside this grid's left column instead of
 * stranded full-width above it.
 */
export function MarketTradingSection({
  event,
  chart,
  sections,
}: {
  event: GammaEvent;
  chart?: ReactNode;
  /** Rules, FAQ and the discussion tabs — below the outcomes, same column. */
  sections?: ReactNode;
}) {
  const markets = event.markets ?? [];
  const [selected, setSelected] = useState<{ market: GammaMarket; outcomeIndex: number } | null>(
    markets[0] ? { market: markets[0], outcomeIndex: 0 } : null,
  );

  return (
    <div className="lg:grid lg:grid-cols-[1fr_400px] lg:items-start lg:gap-8">
      <div className="min-w-0">
        {chart ? <div className="mb-6">{chart}</div> : null}

        <OutcomeList
          markets={markets}
          selectedMarketId={selected?.market.id ?? null}
          onSelect={(market, outcomeIndex) => setSelected({ market, outcomeIndex })}
        />

        {sections ? <div className="mt-6 flex flex-col gap-6">{sections}</div> : null}
      </div>

      {/*
        `top-28` clears the masthead, which is two rows now (h-16 + the ~44px
        category strip). At the old `top-20` the ticket slid under the nav.
      */}
      <div className="mt-6 lg:sticky lg:top-28 lg:mt-0 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
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
