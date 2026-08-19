"use client";

import { useEffect, useMemo, useState } from "react";

import { useCopyEngineContext } from "@/components/copy-trade/copy-engine-provider";
import { summariseBudget } from "@/lib/copy-trade/engine";
import type { CopyLedgerEntry } from "@/lib/copy-trade/types";
import { formatUsdExact } from "@/lib/format";
import { listPortfolioPositions, summarizePositions } from "@/lib/polymarket/portfolio";

/**
 * The four headline figures.
 *
 * They come from two different places on purpose, and the split is the point:
 *
 *  - **Capital deployed** is *our* number, from the ledger — cost basis of
 *    copies we opened and have not closed. It answers "how much have I
 *    committed to copying", which is the same basis the caps are enforced on,
 *    so this tile and `totalCapUsd` can never disagree.
 *  - **Open value, unrealised, realised** are *Polymarket's* numbers, read from
 *    the user's own positions and filtered to tokens the ledger says we copied.
 *    Deriving them from our own records instead would drift from on-chain truth
 *    the moment a price moved.
 *
 * ⚠️ The filter is by **token id**, so a position the user opened by hand on an
 * outcome a copy also touched is counted here too. There is no way to separate
 * them — the CLOB has one position per token, not one per reason for holding
 * it. Overlap is rare in practice and the alternative (tracking a synthetic
 * share count ourselves) would be a second, quietly wrong set of books.
 */

type Props = { ledger: CopyLedgerEntry[] };

type MarketFigures = {
  openValue: number;
  unrealisedPnl: number;
  realisedPnl: number;
};

export function CopyStats({ ledger }: Props) {
  // 🚩 The engine's client, not a second `useBrowserClient()`. That hook holds
  // its own state, so calling it here built a *different* client on this page —
  // a second authentication, and a direct contradiction of the invariant
  // `useCopyEngine` states ("there is exactly one signer on this page").
  // `null` outside a provider is already the not-connected case below.
  const client = useCopyEngineContext()?.client ?? null;
  const [market, setMarket] = useState<MarketFigures | null>(null);

  // Cost basis of every copy still open, across all followed traders. Summed
  // per trader because `summariseBudget` scopes to one address — the same
  // function the caps use, so there is one definition of "deployed".
  const addresses = [...new Set(ledger.map((entry) => entry.address))];
  const deployed = addresses.reduce(
    (total, address) => total + summariseBudget(ledger, address, Date.now()).deployedUsd,
    0,
  );

  // A sorted, comma-joined key rather than the Set itself: a new Set is built
  // on every render and would never compare equal, refetching positions each
  // time. The string only changes when the copied tokens actually change.
  const copiedTokenKey = useMemo(
    () =>
      [
        ...new Set(
          ledger
            .filter((entry) => entry.status === "placed" || entry.status === "simulated")
            .map((entry) => entry.tokenId),
        ),
      ]
        .sort()
        .join(","),
    [ledger],
  );

  useEffect(() => {
    const copiedTokens = new Set(copiedTokenKey ? copiedTokenKey.split(",") : []);
    if (!client || copiedTokens.size === 0) {
      setMarket(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const positions = await listPortfolioPositions(client);
        // `tokenId`, not `asset` — see the note in `readOurShares`. The SDK's
        // `Position` and the Data API's raw rows name this field differently.
        const mine = positions.filter((p) => p.tokenId && copiedTokens.has(p.tokenId));
        const summary = summarizePositions(mine);
        if (cancelled) return;
        setMarket({
          openValue: summary.positionsValue,
          unrealisedPnl: summary.unrealizedPnl,
          realisedPnl: summary.realizedPnl,
        });
      } catch {
        // A failed read shows dashes rather than stale or invented numbers.
        if (!cancelled) setMarket(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, copiedTokenKey]);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Capital deployed" value={formatUsdExact(deployed)} />
      <Tile label="Open value" value={market ? formatUsdExact(market.openValue) : "—"} />
      <Tile
        label="Unrealised P&L"
        value={market ? formatUsdExact(market.unrealisedPnl) : "—"}
        tone={market?.unrealisedPnl}
      />
      <Tile
        label="Realised P&L"
        value={market ? formatUsdExact(market.realisedPnl) : "—"}
        tone={market?.realisedPnl}
      />
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const colour =
    tone === undefined || tone === 0
      ? "text-zinc-100"
      : tone > 0
        ? "text-emerald-400"
        : "text-red-400";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${colour}`}>{value}</p>
    </div>
  );
}
