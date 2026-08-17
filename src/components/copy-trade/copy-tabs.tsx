"use client";

import { useState } from "react";
import Link from "next/link";

import { SKIP_REASON_LABELS, type CopyLedgerEntry } from "@/lib/copy-trade/types";
import { formatUsdExact } from "@/lib/format";

/**
 * The three views onto the ledger.
 *
 * 🚩 **Skipped is a first-class tab, not a debug log.** An engine that silently
 * declines to copy something is indistinguishable from one that is broken, and
 * the user cannot tell whether their caps are working or the poller has died.
 * Every decision that did not become an order is shown here with the reason,
 * which is why `SkipReason` is a closed set with reader-facing labels rather
 * than free text.
 *
 * Selection is local state rather than the URL: unlike the leaderboard's tabs,
 * these render client-only data that does not survive a navigation anyway.
 */

type TabId = "positions" | "activity" | "skipped";

const TABS: { id: TabId; label: string }[] = [
  { id: "positions", label: "Copied positions" },
  { id: "activity", label: "Copy activity" },
  { id: "skipped", label: "Skipped" },
];

export function CopyTabs({ ledger }: { ledger: CopyLedgerEntry[] }) {
  const [tab, setTab] = useState<TabId>("positions");

  const positions = ledger.filter(
    (entry) => entry.side === "BUY" && (entry.status === "placed" || entry.status === "simulated"),
  );
  const activity = ledger.filter((entry) => entry.status !== "skipped");
  const skipped = ledger.filter((entry) => entry.status === "skipped");

  const counts: Record<TabId, number> = {
    positions: positions.length,
    activity: activity.length,
    skipped: skipped.length,
  };

  return (
    <section className="mt-10">
      <div role="tablist" aria-label="Copy trading" className="flex gap-6 border-b border-zinc-800">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`-mb-px cursor-pointer border-b-2 px-1 pb-3 text-sm font-medium transition ${
              tab === item.id
                ? "border-blue-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {item.label}
            {counts[item.id] > 0 ? (
              <span className="ml-2 text-xs text-zinc-600">{counts[item.id]}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="pt-6">
        {tab === "positions" ? (
          <EntryList
            entries={positions}
            emptyTitle="No copied positions yet"
            emptyBody="Positions opened by the copy engine appear here."
          />
        ) : null}
        {tab === "activity" ? (
          <EntryList
            entries={activity}
            emptyTitle="No copy activity yet"
            emptyBody="Every copy the engine works out is listed here, newest first."
          />
        ) : null}
        {tab === "skipped" ? (
          <EntryList
            entries={skipped}
            emptyTitle="Nothing skipped"
            emptyBody="Trades the engine saw but did not copy are listed here, with the reason."
          />
        ) : null}
      </div>
    </section>
  );
}

function EntryList({
  entries,
  emptyTitle,
  emptyBody,
}: {
  entries: CopyLedgerEntry[];
  emptyTitle: string;
  emptyBody: string;
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 px-6 py-16 text-center">
        <p className="text-base font-semibold text-zinc-300">{emptyTitle}</p>
        <p className="mt-2 text-sm text-zinc-500">{emptyBody}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}

const STATUS_STYLES: Record<CopyLedgerEntry["status"], { label: string; className: string }> = {
  queued: { label: "Awaiting you", className: "bg-blue-500/10 text-blue-300" },
  placed: { label: "Placed", className: "bg-emerald-500/10 text-emerald-300" },
  simulated: { label: "Simulated", className: "bg-amber-500/10 text-amber-200" },
  skipped: { label: "Skipped", className: "bg-zinc-700/40 text-zinc-400" },
  failed: { label: "Failed", className: "bg-red-500/10 text-red-300" },
  cancelled: { label: "Dismissed", className: "bg-zinc-700/40 text-zinc-400" },
};

function EntryRow({ entry }: { entry: CopyLedgerEntry }) {
  const status = STATUS_STYLES[entry.status];
  const lag = latencySeconds(entry);

  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${status.className}`}
            >
              {status.label}
            </span>
            <span className="text-xs font-medium text-zinc-400">{entry.traderName}</span>
            {lag !== null ? (
              <span className="text-xs text-zinc-600">{lag}s after their trade</span>
            ) : null}
          </div>

          <p className="mt-2 truncate text-sm font-medium text-zinc-100" title={entry.title}>
            <span className={entry.side === "BUY" ? "text-emerald-400" : "text-red-400"}>
              {entry.side}
            </span>{" "}
            {entry.outcome} · {entry.title || "Unknown market"}
          </p>

          {entry.skipReason ? (
            <p className="mt-1 text-xs text-zinc-500">{SKIP_REASON_LABELS[entry.skipReason]}</p>
          ) : null}
          {entry.error ? <p className="mt-1 text-xs text-red-400/80">{entry.error}</p> : null}
        </div>

        <div className="shrink-0 text-right">
          {entry.amountUsd !== undefined ? (
            <p className="text-sm font-semibold text-zinc-100">{formatUsdExact(entry.amountUsd)}</p>
          ) : null}
          {entry.expectedPrice !== undefined ? (
            <p className="text-xs text-zinc-500">at ~{entry.expectedPrice.toFixed(3)}</p>
          ) : null}
          {entry.feeBps !== undefined ? (
            <p className="text-xs text-zinc-600">fee {entry.feeBps} bps</p>
          ) : null}
        </div>
      </div>

      {entry.eventSlug ? (
        <Link
          href={`/market/${entry.eventSlug}`}
          className="mt-2 inline-block text-xs text-blue-400 transition hover:text-blue-300"
        >
          View market
        </Link>
      ) : null}
    </li>
  );
}

/**
 * How far behind the source trade this copy was decided.
 *
 * Worth showing rather than hiding: it is the number that says whether copying
 * is working well, and it is bounded below by the poll interval plus
 * `SETTLE_DELAY_SECONDS`. A user seeing "45s after their trade" understands the
 * fill difference; one seeing nothing assumes the copy was instant.
 */
function latencySeconds(entry: CopyLedgerEntry): number | null {
  if (!entry.decidedAt || !entry.sourceTimestamp) return null;
  const decided = Date.parse(entry.decidedAt);
  if (Number.isNaN(decided)) return null;
  const lag = Math.round(decided / 1000 - entry.sourceTimestamp);
  return lag >= 0 && lag < 3600 ? lag : null;
}
