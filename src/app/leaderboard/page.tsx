import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";

import { TraderAvatar } from "@/components/ui/avatar";
import { getCachedLeaderboard } from "@/lib/polymarket/leaderboard";
import {
  DEFAULT_ORDERING_ID,
  DEFAULT_PERIOD_ID,
  LEADERBOARD_ORDERINGS,
  LEADERBOARD_PERIODS,
  resolveOrdering,
  resolvePeriod,
} from "@/lib/polymarket/leaderboard-types";
import type {
  LeaderboardOrderingId,
  LeaderboardPeriod,
} from "@/lib/polymarket/leaderboard-types";
import { formatUsd, formatUsdExact, shortenAddress } from "@/lib/format";

/**
 * Full trader leaderboard — where the copy-trade page's "See all" lands, and
 * the page behind the previously-inert "Leaderboard" row in the nav menu.
 *
 * Entirely server-rendered, tabs included. The period and ordering tabs are
 * plain `<Link>`s writing the query string, so switching one is a server
 * navigation that re-reads the shared cache — no client component, no
 * client-side fetch, and therefore no proxy route needed. Same "selection
 * lives in the URL" mechanism as `NavCategories`, and it keeps the JS this
 * page ships at zero, which matters given the bundle budget.
 *
 * 50 rows is the API's own ceiling, not a display choice: asking for more
 * silently returns 50 (verified 2026-08-17), so there is no "load more" to
 * offer without paging, and one page of 50 is the whole board Polymarket
 * exposes.
 */

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Top Polymarket traders by profit and volume.",
};

const ROW_COUNT = 50;

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; order?: string }>;
}) {
  // Next 16 removed synchronous access — `searchParams` is a promise.
  const params = await searchParams;

  // Both resolvers fall back to the default on absent or unrecognised input,
  // so a bare `/leaderboard` and `/leaderboard?period=nonsense` both render the
  // default board rather than erroring. That is the right call for a page a
  // user can land on from a stale link; the strict-rejection rule applies to
  // API callers, not to navigation.
  const period = resolvePeriod(params.period);
  const ordering = resolveOrdering(params.order);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The most profitable traders on Polymarket, by realised and mark-to-market P&amp;L.{" "}
          <Link href="/copy-trade" className="text-blue-400 transition hover:text-blue-300">
            Copy trading
          </Link>{" "}
          is how you follow one.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <TabGroup
          label="Period"
          options={LEADERBOARD_PERIODS.map((option) => ({ id: option.id, label: option.label }))}
          activeId={period.id}
          defaultId={DEFAULT_PERIOD_ID}
          param="period"
          otherParam={{ key: "order", value: ordering.id, defaultValue: DEFAULT_ORDERING_ID }}
        />
        <TabGroup
          label="Rank by"
          options={LEADERBOARD_ORDERINGS.map((option) => ({ id: option.id, label: option.label }))}
          activeId={ordering.id}
          defaultId={DEFAULT_ORDERING_ID}
          param="order"
          otherParam={{ key: "period", value: period.id, defaultValue: DEFAULT_PERIOD_ID }}
        />
      </div>

      {/* Keyed on the selection so switching tabs shows the skeleton again
          rather than the previous window's numbers under the new label. */}
      <Suspense key={`${period.id}:${ordering.id}`} fallback={<BoardSkeleton />}>
        <Board period={period} orderingId={ordering.id} />
      </Suspense>
    </div>
  );
}

async function Board({
  period,
  orderingId,
}: {
  period: LeaderboardPeriod;
  orderingId: LeaderboardOrderingId;
}) {
  const result = await getCachedLeaderboard({
    periodId: period.id,
    orderingId,
    limit: ROW_COUNT,
  });

  if (!result.ok || result.traders.length === 0) {
    return (
      <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
        The leaderboard is unavailable right now. Try again shortly.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs text-zinc-500">
            <th scope="col" className="w-14 px-4 py-3 font-medium">
              #
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Trader
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              P&amp;L ({period.label.toLowerCase()})
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Volume
            </th>
          </tr>
        </thead>
        <tbody>
          {result.traders.map((trader) => (
            <tr
              key={trader.address}
              className="border-b border-zinc-800/60 last:border-b-0 hover:bg-zinc-900/40"
            >
              <td className="px-4 py-3 text-zinc-500">{trader.rank}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <TraderAvatar
                    src={trader.avatar}
                    name={trader.name}
                    seed={trader.address}
                    size={28}
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-zinc-100" title={trader.name}>
                      {trader.name}
                    </p>
                    <p className="truncate font-mono text-xs text-zinc-600" title={trader.address}>
                      {shortenAddress(trader.address)}
                    </p>
                  </div>
                </div>
              </td>
              <td
                className={`px-4 py-3 text-right font-semibold ${
                  trader.pnl < 0 ? "text-red-400" : "text-emerald-400"
                }`}
              >
                {formatUsdExact(trader.pnl)}
              </td>
              <td className="px-4 py-3 text-right text-zinc-300">{formatUsd(trader.volume)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A row of link-tabs writing one query param.
 *
 * `otherParam` is carried through explicitly rather than merged from the
 * current URL, because a server component has no `useSearchParams` to read
 * back. Passing the sibling's current value keeps period and ordering
 * independent — picking "All time" must not reset the ranking to P&L.
 *
 * The default value is dropped from the URL rather than written, so the
 * canonical `/leaderboard` and `/leaderboard?period=1w&order=pnl` are the same
 * page instead of two URLs for one view.
 */
function TabGroup({
  label,
  options,
  activeId,
  defaultId,
  param,
  otherParam,
}: {
  label: string;
  options: readonly { id: string; label: string }[];
  activeId: string;
  defaultId: string;
  param: string;
  otherParam: { key: string; value: string; defaultValue: string };
}) {
  function href(id: string): string {
    const query = new URLSearchParams();
    if (id !== defaultId) query.set(param, id);
    if (otherParam.value !== otherParam.defaultValue) {
      query.set(otherParam.key, otherParam.value);
    }
    const search = query.toString();
    return search ? `/leaderboard?${search}` : "/leaderboard";
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-600">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const isActive = option.id === activeId;
          return (
            <Link
              key={option.id}
              href={href(option.id)}
              aria-current={isActive ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                isActive
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      {Array.from({ length: 10 }, (_, index) => (
        <div key={index} className="h-14 border-b border-zinc-800/60 bg-zinc-900/40 last:border-b-0" />
      ))}
    </div>
  );
}
