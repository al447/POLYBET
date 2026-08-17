"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { CopyStats } from "@/components/copy-trade/copy-stats";
import { CopyTabs } from "@/components/copy-trade/copy-tabs";
import { EngineStatusBar } from "@/components/copy-trade/engine-status-bar";
import { useCopyEngineContext } from "@/components/copy-trade/copy-engine-provider";
import { TraderAvatar } from "@/components/ui/avatar";
import { formatUsdExact } from "@/lib/format";

/**
 * The signed-in copy-trading view.
 *
 * `traders` is the **server-rendered** leaderboard grid, handed down from the
 * page rather than refetched here. That is what keeps the live board off the
 * client bundle and out of a second network round trip: the same node renders
 * on the signed-out landing page and inside this dashboard, and neither copy
 * ships the fetch.
 *
 * The engine itself is read from context, never instantiated here — see
 * `copy-engine-provider.tsx` for why a second instance would double every copy.
 */
export function CopyDashboard({ traders }: { traders: ReactNode }) {
  const engine = useCopyEngineContext();
  if (!engine) return null;

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Copy trading</h1>
        <Link
          href="/leaderboard"
          className="shrink-0 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
        >
          Find traders
        </Link>
      </header>

      <EngineStatusBar
        status={engine.status}
        traderCount={engine.follows.length}
        lastCheckedAt={engine.lastCheckedAt}
        checking={engine.checking}
        onCheckNow={engine.checkNow}
        onPauseAll={engine.pauseAll}
        onResumeAll={engine.resumeAll}
      />

      <div className="mt-6">
        <CopyStats ledger={engine.ledger} />
      </div>

      {engine.follows.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
            Traders you follow
          </h2>
          <ul className="mt-4 space-y-2">
            {engine.follows.map((followed) => (
              <li
                key={followed.address}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <TraderAvatar
                    src={followed.avatar}
                    name={followed.name}
                    seed={followed.address}
                    size={36}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-100">{followed.name}</p>
                    <p className="text-xs text-zinc-500">
                      {followed.settings.sizing.mode === "fixed"
                        ? `${formatUsdExact(followed.settings.sizing.usd)} per copy`
                        : `${followed.settings.sizing.percentOfTheirNotional}% of their trade`}
                      {" · "}
                      {formatUsdExact(followed.settings.dailyCapUsd)}/day
                      {followed.paused ? " · paused" : ""}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => engine.unfollowTrader(followed.address)}
                  className="shrink-0 cursor-pointer rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-red-500/40 hover:text-red-300"
                >
                  Stop copying
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <header className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
            {engine.follows.length === 0 ? "Start by copying a trader" : "Top traders this week"}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Live leaderboard, ranked by profit over the last 7 days.
          </p>
        </header>
        {traders}
      </section>

      <CopyTabs ledger={engine.ledger} />

      <p className="mt-12 max-w-2xl text-xs leading-relaxed text-zinc-500">
        Copy trading places real orders with real money. Past performance is not a promise of future
        results, and copies can fill at different prices than the trader you follow.
      </p>
    </div>
  );
}
