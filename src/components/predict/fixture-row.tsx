"use client";

import { useState } from "react";
import Link from "next/link";

import { TraderAvatar } from "@/components/ui/avatar";
import type { Fixture } from "@/lib/polymarket/fixtures-types";

/**
 * One football match, collapsed to a row and expandable to its result markets.
 *
 * 🚩 The expanded panel shows **market** percentages in a column of its own and
 * leaves the Predict AI column as em-dashes, with a line saying why. That is
 * FR-7.4 ("label AI output as non-advice; never present as a guaranteed
 * outcome") applied to the case the requirement doesn't cover — there being no
 * model at all yet. Filling that column with the market number relabelled as a
 * forecast would be the single most misleading thing this page could do.
 *
 * `TraderAvatar` stands in for team badges. It is named for the leaderboard but
 * is generic — `name` supplies the letter, `seed` picks a stable colour — and
 * Gamma has no per-team crest to use here (every soccer market shares one
 * generic ball icon), so the coloured initial is the honest placeholder rather
 * than a broken image.
 */
export function FixtureRow({ fixture, kickoffLabel }: { fixture: Fixture; kickoffLabel: string }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `fixture-${fixture.slug}`;

  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-zinc-700">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium tracking-wide text-zinc-500 uppercase">
            {fixture.leagueLabel}
          </span>
          {fixture.tradeable ? (
            <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-emerald-300 uppercase">
              Tradeable
            </span>
          ) : (
            <span
              title="This match's markets have stopped accepting orders."
              className="shrink-0 rounded bg-zinc-700/40 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase"
            >
              Closed
            </span>
          )}
        </div>

        <span className="shrink-0 text-xs text-zinc-500 tabular-nums">{kickoffLabel}</span>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Team name={fixture.homeTeam} />
        <span className="shrink-0 text-xs font-medium text-zinc-600">VS</span>
        <Team name={fixture.awayTeam} align="right" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="shrink-0 cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
        >
          {expanded ? "Hide" : "Predict"}
        </button>
        <p className="text-xs text-zinc-500">
          {expanded
            ? "Percentages below are the market's, not a forecast."
            : "See the chance of each result"}
        </p>
      </div>

      {expanded ? <ResultTable id={panelId} fixture={fixture} /> : null}
    </li>
  );
}

function Team({ name, align = "left" }: { name: string; align?: "left" | "right" }) {
  return (
    <div
      className={`flex min-w-0 flex-1 items-center gap-2.5 ${align === "right" ? "flex-row-reverse" : ""}`}
    >
      <TraderAvatar name={name} seed={name} size={28} />
      <p
        className={`truncate text-sm font-medium text-zinc-100 ${align === "right" ? "text-right" : ""}`}
        title={name}
      >
        {name}
      </p>
    </div>
  );
}

function ResultTable({ id, fixture }: { id: string; fixture: Fixture }) {
  return (
    <div id={id} className="mt-4 border-t border-zinc-800/60 pt-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th scope="col" className="pb-2 font-medium">
              Result
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Market
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Predict AI
            </th>
          </tr>
        </thead>
        <tbody>
          {fixture.outcomes.map((outcome) => (
            <tr key={outcome.kind} className="border-t border-zinc-800/60">
              <td className="py-2 text-zinc-300">{outcome.label}</td>
              <td className="py-2 text-right font-semibold text-zinc-100 tabular-nums">
                {outcome.marketPct === null ? "—" : `${outcome.marketPct}%`}
              </td>
              <td className="py-2 text-right text-zinc-600 tabular-nums">—</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-xs text-zinc-500">
          Predict AI is not live yet. The percentages above are what the market is pricing,
          not a forecast, and nothing here is investment advice.
        </p>
        <Link
          href={`/market/${fixture.slug}`}
          className="shrink-0 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
        >
          Trade this market →
        </Link>
      </div>
    </div>
  );
}
