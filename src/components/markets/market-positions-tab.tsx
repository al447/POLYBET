"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Position } from "@polymarket/bindings/data";

import { useBrowserClient } from "@/hooks/use-browser-client";
import { listPortfolioPositions } from "@/lib/polymarket/portfolio";
import { PositionList } from "@/components/portfolio/position-list";

/**
 * The viewer's own positions in this event.
 *
 * Separate from the other three tabs because it is the only one that isn't
 * public: Polymarket's `/positions` endpoint is keyed by **user**, not by
 * market (it 400s without one), and the address it needs is the Deposit
 * Wallet, which the server never learns — see `portfolio.ts`. So this reads
 * browser-side through the user's own authenticated client.
 *
 * 🚩 **It does not connect on mount.** Building the client triggers an L1
 * signature prompt, and a market page must not throw a wallet signature at
 * someone who only opened a tab to look. Same call the right sidebar makes
 * about not mounting the activity feed. Connecting is an explicit button —
 * unless the ticket on this page already connected, in which case the client
 * is there and this just uses it.
 */
export function MarketPositionsTab({ eventSlug }: { eventSlug: string }) {
  const { client, status, error, connect } = useBrowserClient();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!client) return;
      setLoading(true);
      setLoadError(null);
      try {
        const all = await listPortfolioPositions(client);
        // Filter to this event rather than fetching per-market: one page of
        // positions covers the whole account, and the API has no per-event
        // query. `eventSlug` is on every position.
        if (!signal.cancelled) setPositions(all.filter((p) => p.eventSlug === eventSlug));
      } catch (err) {
        if (!signal.cancelled) {
          setLoadError(err instanceof Error ? err.message : "Couldn't load your positions.");
        }
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [client, eventSlug],
  );

  useEffect(() => {
    if (status !== "ready" || !client) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [status, client, load]);

  if (status === "signed-out") {
    return (
      <Notice>
        Sign in to see the positions you hold in this market.
      </Notice>
    );
  }

  if (status !== "ready") {
    return (
      <div className="py-6 text-center">
        <p className="text-sm text-zinc-500">
          Your positions are read from your own wallet, so this needs a connection.
        </p>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={status === "connecting"}
          className="mt-3 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
        >
          {status === "connecting" ? "Connecting…" : "Load my positions"}
        </button>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (loading && positions === null) {
    return <Notice>Loading your positions…</Notice>;
  }

  if (loadError) {
    return (
      <p role="alert" className="py-6 text-center text-sm text-red-400">
        {loadError}
      </p>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <Notice>
        You don&apos;t hold a position in this market.{" "}
        <Link href="/portfolio" className="text-emerald-400 underline underline-offset-2">
          See your full portfolio
        </Link>
        .
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Reuses the portfolio table wholesale — same columns, same PnL
          formatting, so a position reads identically in both places. */}
      <PositionList positions={positions} />
      <Link
        href="/portfolio"
        className="self-start text-sm text-emerald-400 underline underline-offset-2"
      >
        See your full portfolio
      </Link>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
}
