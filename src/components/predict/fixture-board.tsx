"use client";

import { useEffect, useMemo, useState } from "react";

import { FixtureRow } from "@/components/predict/fixture-row";
import { CloseIcon, SearchIcon } from "@/components/ui/icons";
import {
  DEFAULT_PREDICT_SORT_ID,
  PREDICT_SORTS,
  fixtureMatchesQuery,
  leaguesOf,
  sortFixtures,
} from "@/lib/polymarket/fixtures-types";
import type { Fixture, PredictSortId } from "@/lib/polymarket/fixtures-types";

/**
 * The fixture list, with search, league chips and sort.
 *
 * Seeded with the whole window from the server — same pattern as
 * `DiscoverySection` → `MarketGrid` — but unlike `MarketGrid` this one never
 * fetches again. The board is at most a few hundred fixtures, so filtering in
 * memory is instant and needs no `/api/fixtures` route to exist at all.
 *
 * 🚩 Nothing time-dependent renders until `mounted` flips. Kickoff times and
 * day headers are formatted in the *viewer's* timezone, and the server runs
 * UTC, so rendering them on both sides is a hydration mismatch. Worse than the
 * warning: a 01:00 local kickoff falls on a different UTC day, so the server
 * and client would disagree about which day *group* a match belongs to —
 * `suppressHydrationWarning` patches over mismatched text, not a mismatched
 * tree. Gating on mount costs one frame of skeleton and no extra network,
 * because the fixtures already arrived in the RSC payload.
 */
export function FixtureBoard({ fixtures }: { fixtures: Fixture[] }) {
  const [query, setQuery] = useState("");
  const [league, setLeague] = useState<string | null>(null);
  const [sortId, setSortId] = useState<PredictSortId>(DEFAULT_PREDICT_SORT_ID);
  const [mounted, setMounted] = useState(false);

  // The "am I on the client yet" flag the docstring above explains. Disabled
  // deliberately: `react-hooks/set-state-in-effect` points at
  // `useSyncExternalStore`, which has nothing to subscribe to here — mounting is
  // a one-way transition, not a changing external value. The one extra render is
  // the entire mechanism, and it buys a correct day-grouped tree instead of a
  // hydration mismatch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const leagues = useMemo(() => leaguesOf(fixtures), [fixtures]);

  const visible = useMemo(() => {
    const filtered = fixtures.filter(
      (fixture) =>
        (league === null || fixture.leagueSlug === league) &&
        fixtureMatchesQuery(fixture, query),
    );
    return sortFixtures(filtered, sortId);
  }, [fixtures, league, query, sortId]);

  // Grouped only for the kickoff ordering. Under "league" or "liquidity" a day
  // header would cut the ordering into meaningless slices — the whole point of
  // those sorts is a single ranked list.
  const groups = useMemo(
    () => (sortId === "kickoff" && mounted ? groupByDay(visible) : null),
    [visible, sortId, mounted],
  );

  return (
    <div>
      <div className="relative w-full max-w-xl">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a team or league — Arsenal, La Liga, MLS..."
          aria-label="Search fixtures by team or league"
          className="w-full appearance-none rounded-xl border border-zinc-800 bg-zinc-900/70 py-2.5 pr-11 pl-10 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600 focus:bg-zinc-900 focus:ring-1 focus:ring-zinc-600 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer rounded-md p-1 text-zinc-500 transition hover:text-zinc-200"
          >
            <CloseIcon className="size-4" />
          </button>
        ) : null}
      </div>

      {/*
        The chip strip scrolls horizontally and the sort row is a SIBLING of it,
        never a child: `overflow-x: auto` clips vertically too, so anything that
        needs to escape the strip's box has to live outside it. Same gotcha
        recorded in `nav-categories.tsx`.
      */}
      <div className="mt-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Chip label="All leagues" count={fixtures.length} active={league === null} onClick={() => setLeague(null)} />
        {leagues.map((entry) => (
          <Chip
            key={entry.slug}
            label={entry.label}
            count={entry.count}
            active={league === entry.slug}
            onClick={() => setLeague(entry.slug)}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-xs font-medium text-zinc-500">Sort by</span>
        <div className="flex flex-wrap items-center gap-2">
          {PREDICT_SORTS.map((sort) => (
            <Chip
              key={sort.id}
              label={sort.label}
              active={sortId === sort.id}
              onClick={() => setSortId(sort.id)}
            />
          ))}
        </div>
      </div>

      <div className="mt-6">
        {!mounted ? (
          <FixtureBoardSkeleton />
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 px-6 py-16 text-center">
            <p className="text-base font-semibold text-zinc-300">No matches found</p>
            <p className="mt-2 text-sm text-zinc-500">
              {query || league !== null
                ? "Try a different team, league, or clear the filters."
                : "There are no football fixtures in the next few days."}
            </p>
          </div>
        ) : groups ? (
          <div className="space-y-8">
            {groups.map((group) => (
              <section key={group.key}>
                <header className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-semibold tracking-tight text-zinc-200">
                    {group.label}
                  </h2>
                  <span className="text-xs text-zinc-600">
                    {group.fixtures.length} {group.fixtures.length === 1 ? "match" : "matches"}
                  </span>
                </header>
                <ul className="space-y-2">
                  {group.fixtures.map((fixture) => (
                    <FixtureRow
                      key={fixture.slug}
                      fixture={fixture}
                      kickoffLabel={formatKickoff(fixture.kickoff)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((fixture) => (
              <FixtureRow
                key={fixture.slug}
                fixture={fixture}
                kickoffLabel={formatKickoffWithDay(fixture.kickoff)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${
        active
          ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
          : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}
    >
      {label}
      {count === undefined ? null : (
        <span className={`ml-1.5 ${active ? "text-emerald-400/70" : "text-zinc-600"}`}>{count}</span>
      )}
    </button>
  );
}

export function FixtureBoardSkeleton() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 8 }, (_, index) => (
        <li
          key={index}
          className="h-[124px] animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40"
        />
      ))}
    </ul>
  );
}

type DayGroup = { key: string; label: string; fixtures: Fixture[] };

/** `2026-08-20` for the viewer's own timezone — the key day grouping happens on. */
function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * "Today" / "Tomorrow" / "Friday, August 21".
 *
 * Compares day keys rather than subtracting milliseconds: "tomorrow" is a
 * calendar question, and a 23-hour gap can cross two midnights while a 25-hour
 * gap can cross one.
 */
function dayLabel(date: Date, now: Date): string {
  const today = localDayKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const key = localDayKey(date);
  if (key === today) return "Today";
  if (key === localDayKey(tomorrow)) return "Tomorrow";

  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

/** Splits an already-kickoff-sorted list into consecutive day groups. */
function groupByDay(fixtures: Fixture[]): DayGroup[] {
  const now = new Date();
  const groups: DayGroup[] = [];

  for (const fixture of fixtures) {
    const date = new Date(fixture.kickoff);
    const key = localDayKey(date);
    const last = groups[groups.length - 1];

    if (last && last.key === key) {
      last.fixtures.push(fixture);
    } else {
      groups.push({ key, label: dayLabel(date, now), fixtures: [fixture] });
    }
  }

  return groups;
}

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Kickoff with the date attached, for the sorts that have no day headers to carry it. */
function formatKickoffWithDay(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${formatKickoff(iso)}`;
}
