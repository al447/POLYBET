"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Position } from "@polymarket/bindings/data";

import { useBrowserClient } from "@/hooks/use-browser-client";
import { useUserChannel } from "@/hooks/use-user-channel";
import { readCollateralBalance, type BrowserClient } from "@/lib/polymarket/browser-client";
import { listPortfolioPositions, summarizePositions, type PortfolioSummary } from "@/lib/polymarket/portfolio";
import { groupRedeemable } from "@/lib/polymarket/redeem";
import { fromBaseUnits } from "@/lib/polymarket/fees";
import { Card, StatusDot } from "@/components/ui/primitives";
import { PositionList } from "@/components/portfolio/position-list";
import { RedeemPanel } from "@/components/portfolio/redeem-panel";
import { WithdrawPanel } from "@/components/portfolio/withdraw-panel";
import { FillToasts } from "@/components/trade/fill-toasts";

/**
 * Portfolio dashboard (FR-4.1–4.3, implementation.md Step 4.2).
 *
 * Reads entirely from the browser against the user's own authenticated
 * client — see `lib/polymarket/portfolio.ts` for why this isn't a cached
 * server proxy like Gamma is.
 *
 * Note the two different number formats deliberately in play: the **cash
 * balance** comes from the CLOB in 6-decimal base units (hence
 * `fromBaseUnits`), while every **position** figure comes from the Data API
 * already as a human decimal (hence plain `toFixed`). Mixing those up renders
 * either ~0 or a number 10^6 too large.
 *
 * Live updates (FR-4.5) arrive via `useUserChannel` (Step 3.7): a fill or
 * order event re-runs the same REST read this page already does. The socket
 * is the *trigger*, never the source of the numbers — a fill event carries no
 * post-trade position size or cash balance, so refetching is the only way to
 * get figures that reconcile. The manual refresh button stays for the case
 * where the socket is down.
 */

type Data =
  | { state: "loading" }
  | { state: "ready"; positions: Position[]; summary: PortfolioSummary; cash: bigint }
  | { state: "error"; message: string };

export function PortfolioView() {
  const { client, status, error, connect } = useBrowserClient();
  const { state: userChannel, status: liveStatus } = useUserChannel(client);
  const [data, setData] = useState<Data>({ state: "loading" });

  const load = useCallback(async (active: BrowserClient) => {
    try {
      const [positions, cash] = await Promise.all([
        listPortfolioPositions(active),
        readCollateralBalance(active),
      ]);
      setData({ state: "ready", positions, summary: summarizePositions(positions), cash });
    } catch (err) {
      setData({
        state: "error",
        message: err instanceof Error ? err.message : "Couldn't load your portfolio.",
      });
    }
  }, []);

  useEffect(() => {
    if (!client) return;
    async function run(active: BrowserClient) {
      setData({ state: "loading" });
      await load(active);
    }
    void run(client);
  }, [client, load]);

  /**
   * Live refresh on any fill or order event. Deliberately *silent* — no
   * skeleton, no spinner: the numbers on screen stay readable and are replaced
   * when the new ones land. A loading state here would make the page flicker
   * every time an unrelated resting order ticked.
   *
   * `revision` also bumps once when the channel first connects, which costs
   * one duplicate read per page load. That's the price of closing the race
   * where a fill lands between this page's initial fetch and the socket
   * attaching — cheap, and the alternative is a position count that stays
   * silently wrong until the user reloads.
   */
  useEffect(() => {
    if (!client || userChannel.revision === 0) return;
    // Wrapped like the mount effect above: `react-hooks/set-state-in-effect`
    // traces through `load`'s `setData` and flags a bare call in the body.
    async function refresh(active: BrowserClient) {
      await load(active);
    }
    void refresh(client);
  }, [client, userChannel.revision, load]);

  if (status === "signed-out") {
    return <Notice>Sign in to see your positions.</Notice>;
  }

  if (status === "idle" || status === "connecting" || status === "error") {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        {status === "error" && error ? (
          <p className="mb-3 text-sm text-red-400">{error}</p>
        ) : null}
        <p className="mb-4 text-sm text-zinc-500">
          Connect your trading wallet to load your positions. This is the same wallet you trade with —
          nothing new to set up.
        </p>
        <button
          type="button"
          onClick={connect}
          disabled={status === "connecting"}
          className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
        >
          {status === "connecting" ? "Waiting for your wallet…" : status === "error" ? "Try again" : "Connect wallet"}
        </button>
      </div>
    );
  }

  if (data.state === "loading") {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl border border-zinc-800 bg-zinc-900/40" />
          ))}
        </div>
        <div className="h-64 rounded-xl border border-zinc-800 bg-zinc-900/40" />
      </div>
    );
  }

  if (data.state === "error") {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
        <p>{data.message}</p>
        <button
          type="button"
          onClick={() => client && void load(client)}
          className="mt-2 text-sm font-semibold text-red-200 underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }

  const { positions, summary, cash } = data;
  /**
   * Derived, not fetched: `redeemable` already rides along on every position,
   * so claimable markets cost no extra request and stay consistent with the
   * table below by construction. Recomputed each render rather than memoised —
   * it's a single pass over at most 100 positions.
   */
  const redeemable = groupRedeemable(positions);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash" value={`${fromBaseUnits(cash)} pUSD`} />
        <Stat label="Positions value" value={`$${summary.positionsValue.toFixed(2)}`} />
        <Stat
          label="Unrealized PnL"
          value={signed(summary.unrealizedPnl)}
          sub={
            summary.unrealizedPnlPercent !== null
              ? `${summary.unrealizedPnlPercent >= 0 ? "+" : "−"}${Math.abs(summary.unrealizedPnlPercent).toFixed(1)}%`
              : undefined
          }
          tone={summary.unrealizedPnl >= 0 ? "up" : "down"}
        />
        <Stat
          label="Realized PnL"
          value={signed(summary.realizedPnl)}
          tone={summary.realizedPnl >= 0 ? "up" : "down"}
        />
      </div>

      {/*
        Above the positions table on purpose: settled winnings are money the
        user has already earned and can act on right now, which outranks a
        mark-to-market view of everything still open.
      */}
      {client ? (
        <RedeemPanel
          client={client}
          markets={redeemable}
          onRedeemed={() => void load(client)}
        />
      ) : null}

      {positions.length === 0 ? (
        <Card title="Positions">
          <p className="text-sm text-zinc-500">
            No open positions yet.{" "}
            <Link href="/" className="text-emerald-400 underline underline-offset-2">
              Browse markets
            </Link>{" "}
            to place your first trade.
          </p>
        </Card>
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">
              Positions ({summary.positionCount})
            </h2>
            <div className="flex items-center gap-3">
              {/*
                Says whether these figures are self-updating or frozen. Without
                it a live page and a page whose socket died an hour ago look
                identical, and the user has no way to know the second one needs
                a manual refresh.
              */}
              <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <StatusDot tone={liveStatus === "live" ? "ok" : liveStatus === "error" ? "bad" : "idle"} />
                {liveStatus === "live" ? "Live" : liveStatus === "error" ? "Offline" : "Connecting…"}
              </span>
              <button
                type="button"
                onClick={() => client && void load(client)}
                className="text-xs font-medium text-zinc-500 transition hover:text-zinc-300"
              >
                Refresh
              </button>
            </div>
          </div>
          <PositionList positions={positions} />
        </div>
      )}

      {client ? (
        <div className="max-w-md">
          <WithdrawPanel
            client={client}
            balance={cash}
            onComplete={() => void load(client)}
          />
        </div>
      ) : null}

      <FillToasts fills={userChannel.fills} />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down";
}) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <p className="text-xs tracking-wide text-zinc-500 uppercase">{label}</p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      {sub ? <p className={`mt-0.5 text-sm tabular-nums ${color} opacity-70`}>{sub}</p> : null}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-500">
      {children}
    </div>
  );
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}
