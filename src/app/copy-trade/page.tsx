import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";

import { CopyCta } from "@/components/copy-trade/copy-cta";
import { CopyTradeShell } from "@/components/copy-trade/copy-trade-shell";
import { TraderCard } from "@/components/copy-trade/trader-card";
import { getCachedLeaderboard } from "@/lib/polymarket/leaderboard";

/**
 * Copy Trading — one route, two faces.
 *
 * **Signed out** it is a landing page: what copying is, how it works, and a
 * live leaderboard to sign in for. **Signed in** it is the dashboard, with the
 * engine's status, the four headline figures, and the copy ledger.
 *
 * A server component throughout. The switch between the two is the only
 * client-side part, and both branches are built here so the leaderboard is
 * fetched once, on the server, for every visitor either way. See
 * `CopyTradeShell`.
 *
 * 🚩 The engine behind the buttons runs **in the user's browser tab**, signs
 * with their own wallet, and waits for a click before every copy. That is what
 * lets this page exist without the delegated server-side signing that OI-5 is
 * about. It is also why the small print here and in `EngineStatusBar` says
 * copies stop when the tab closes — a user who does not know that has been
 * misled by everything else on the page.
 */

export const metadata: Metadata = {
  title: "Copy Trading",
  description:
    "Follow a profitable Polymarket trader and mirror their positions into your own wallet, inside limits you control.",
};

const HOW_IT_WORKS = [
  {
    title: "Pick a trader",
    body: "Browse the leaderboard by profit or volume, check their open positions and history, then choose who to follow.",
  },
  {
    title: "Set your limits",
    body: "Choose how each of their trades is sized against your money, and cap the per-trade, daily and total spend.",
  },
  {
    title: "Confirm each copy",
    body: "When they trade, the matching order is worked out for you and waits for one click to place from your own wallet.",
  },
];

const CONTROLS = [
  {
    title: "Your wallet, your keys",
    body: "Every copy is signed by you. We never hold your funds or trade on your behalf.",
  },
  {
    title: "Hard spending caps",
    body: "Per-trade, daily and total budgets are enforced before an order is ever signed.",
  },
  {
    title: "Stop any time",
    body: "Pause or stop a trader in one click. Positions already open stay yours to manage.",
  },
  {
    title: "Full audit trail",
    body: "Every trade the engine saw is logged — including the ones it skipped, and why.",
  },
];

export default function CopyTradePage() {
  // Built once and handed to both branches. The same node renders inside the
  // landing page's section and inside the dashboard, so neither duplicates the
  // fetch nor ships it to the client.
  const traders = (
    <Suspense fallback={<TraderGridSkeleton />}>
      <TraderGrid />
    </Suspense>
  );

  return <CopyTradeShell landing={<CopyTradeLanding traders={traders} />} traders={traders} />;
}

function CopyTradeLanding({ traders }: { traders: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-12">
      <section className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          Copy the traders who are winning
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-zinc-400">
          Follow a profitable Polymarket trader and their positions are mirrored into your own
          wallet, inside limits you control.
        </p>
        <div className="mt-8">
          <CopyCta variant="hero" label="Get started" />
        </div>
      </section>

      <ol className="mt-16 grid gap-4 md:grid-cols-3">
        {HOW_IT_WORKS.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
            <span className="flex size-7 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
              {index + 1}
            </span>
            <h2 className="mt-4 text-base font-semibold text-zinc-100">{step.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{step.body}</p>
          </li>
        ))}
      </ol>

      <section className="mt-16">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
              Top traders this week
            </h2>
            <p className="mt-1 text-sm text-zinc-500">Log in to copy any of them.</p>
          </div>
          <Link
            href="/leaderboard"
            className="shrink-0 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
          >
            See all
          </Link>
        </header>
        {traders}
      </section>

      <section className="mt-16">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100">You stay in control</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CONTROLS.map((item) => (
            <div key={item.title} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h3 className="text-sm font-semibold text-zinc-100">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/*
        Not decoration, and not lawyer-padding either. This page shows six-figure
        P&L numbers above a button; the two sentences that follow are the
        cheapest honest counterweight to that, and the second one names the
        specific mechanical reason a copy underperforms the trader it copied.
      */}
      <p className="mt-12 max-w-2xl text-xs leading-relaxed text-zinc-500">
        Copy trading places real orders with real money. Past performance is not a promise of future
        results, and copies can fill at different prices than the trader you follow.
      </p>
    </div>
  );
}

/**
 * Six real rows off the live leaderboard — the grid only, with no heading.
 *
 * The heading lives with each caller because the two say different things: the
 * landing page frames it as "log in to copy any of them", the dashboard as
 * where to add another trader. The window and ordering stay written out as
 * literals rather than read from `DEFAULT_PERIOD_ID`, because both callers
 * label these numbers "7d" in prose — sourcing them from a default would mean
 * changing that default silently relabels real numbers with the wrong window.
 */
async function TraderGrid() {
  const result = await getCachedLeaderboard({ periodId: "1w", orderingId: "pnl", limit: 6 });

  // A failed or empty board costs this page one section. It must not throw —
  // the rest of the page is what the visitor came for.
  if (!result.ok || result.traders.length === 0) {
    return (
      <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center text-sm text-zinc-500">
        The leaderboard is unavailable right now. Try again shortly.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {result.traders.map((trader) => (
        <TraderCard key={trader.address} trader={trader} periodLabel="7d" />
      ))}
    </div>
  );
}

function TraderGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="h-44 rounded-xl border border-zinc-800 bg-zinc-900/40" />
      ))}
    </div>
  );
}
