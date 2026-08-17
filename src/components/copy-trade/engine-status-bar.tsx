"use client";

import { useEffect, useState } from "react";

import { COPY_EXECUTION_MODE } from "@/lib/copy-trade/types";
import type { CopyEngineStatus } from "@/hooks/use-copy-engine";

/**
 * The engine's heartbeat: whether it is watching, how many traders, how long
 * since the last pass, and the two controls that matter.
 *
 * The two lines of small print are not boilerplate. They are the honest
 * description of an engine that lives in a browser tab, and a user who does not
 * know that copies stop when they close the tab has been misled by the rest of
 * the page. Both statements are true of this build specifically — see
 * `use-copy-engine.ts`.
 */

type Props = {
  status: CopyEngineStatus;
  traderCount: number;
  lastCheckedAt: string | null;
  checking: boolean;
  onCheckNow: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
};

export function EngineStatusBar({
  status,
  traderCount,
  lastCheckedAt,
  checking,
  onCheckNow,
  onPauseAll,
  onResumeAll,
}: Props) {
  const since = useSecondsSince(lastCheckedAt);
  const paused = status === "paused";

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`size-2.5 rounded-full ${
              paused ? "bg-zinc-600" : "bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60"
            }`}
          />
          <div>
            <p className="text-sm font-semibold text-zinc-100">
              {paused ? "Paused" : "Watching"}
            </p>
            <p className="text-xs text-zinc-500">
              {traderCount} {traderCount === 1 ? "trader" : "traders"}
              {since ? ` · checked ${since}` : " · not checked yet"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCheckNow}
            disabled={checking}
            className="cursor-pointer rounded-lg border border-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-wait disabled:text-zinc-500"
          >
            {checking ? "Checking…" : "Check now"}
          </button>
          <button
            type="button"
            onClick={paused ? onResumeAll : onPauseAll}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              paused
                ? "border-emerald-500/40 text-emerald-300 hover:border-emerald-500/60"
                : "border-red-500/40 text-red-300 hover:border-red-500/60"
            }`}
          >
            {paused ? "Resume all" : "Pause all"}
          </button>
        </div>
      </div>

      <div className="space-y-1 border-t border-zinc-800/80 px-5 py-3">
        {COPY_EXECUTION_MODE === "simulated" ? (
          <p className="text-sm text-amber-200/90">
            <span className="font-semibold">Dry run.</span> Copies are worked out in full and
            recorded below, but no order is placed and no money moves.
          </p>
        ) : (
          <p className="text-sm text-zinc-300">
            <span className="font-semibold">Confirm each copy.</span> Every copy waits for you to
            place it, so nothing is signed from your wallet without a click.
          </p>
        )}
        <p className="text-xs text-zinc-500">
          Copies are only worked out while this tab is open, and browsers slow background tabs to
          about one check a minute.
        </p>
      </div>
    </section>
  );
}

/**
 * Seconds-level "8s ago", ticking once a second.
 *
 * `formatRelativeTime` in `lib/format.ts` is deliberately coarse — it answers
 * "just now" for anything under a minute, which is right for a comment and
 * useless for a heartbeat the user is watching to see whether the engine is
 * alive. Loosening the shared helper would make every comment timestamp noisier
 * to serve this one caller, so the precision lives here instead.
 */
function useSecondsSince(iso: string | null): string {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [iso]);

  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
