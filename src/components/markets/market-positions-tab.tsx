"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready" || !client) return;
    let cancelled = false;

    // Every `setState` here is inside a promise callback, never in the effect
    // body. Calling one synchronously — which an `async` helper invoked from
    // here does, before its first `await` — schedules a second render on the
    // same commit, which is what `react-hooks/set-state-in-effect` catches.
    listPortfolioPositions(client)
      .then((all) => {
        // Filtered here rather than fetched per-market: one page covers the
        // whole account and the API has no per-event query, but `eventSlug` is
        // on every position.
        if (!cancelled) setPositions(all.filter((position) => position.eventSlug === eventSlug));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Couldn't load your positions.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [status, client, eventSlug]);

  // Derived, not stored. A `loading` state would need setting before the fetch
  // starts — i.e. synchronously in the effect above — and it carries no
  // information these three don't already have.
  const loading = status === "ready" && positions === null && loadError === null;

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

  if (loading) {
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
