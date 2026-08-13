"use client";

import { useEffect, useState } from "react";

import type { UserFill } from "@/lib/polymarket/user-events";

/**
 * Toast on fill (FR-4.5, Step 3.7) — the visible half of `useUserChannel`.
 * Purely presentational: the caller owns the subscription and passes its
 * accumulated fills down, the same lift-the-state arrangement `OrderBook` has
 * with `useOrderBook`.
 *
 * A fill is announced **once**, even though the same trade id arrives several
 * times as its status walks `MATCHED → MINED → CONFIRMED`: the reducer
 * replaces the entry in place (see `applyUserEvent`), and once a toast is
 * dismissed here its id stays dismissed, so a later status update can't
 * resurrect it. The status shown inside a *visible* toast does keep updating.
 */

const TOAST_MS = 10_000;
const MAX_VISIBLE = 3;

/**
 * `TRADE_STATUS_MATCHED` is the CLOB accepting the match; `MINED`/`CONFIRMED`
 * are on-chain settlement. Only the failure states are worth alarming about —
 * the rest is normal progression the user doesn't need explained.
 */
function describeStatus(status: string): { label: string; failed: boolean } {
  switch (status) {
    case "TRADE_STATUS_FAILED":
      return { label: "Failed to settle", failed: true };
    case "TRADE_STATUS_RETRYING":
      return { label: "Retrying settlement", failed: true };
    case "TRADE_STATUS_CONFIRMED":
    case "TRADE_STATUS_MINED":
      return { label: "Settled", failed: false };
    default:
      return { label: "Matched", failed: false };
  }
}

export function FillToasts({ fills }: { fills: UserFill[] }) {
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const visible = fills.filter((fill) => !dismissed.includes(fill.id)).slice(0, MAX_VISIBLE);
  // Effect key rather than the array itself: `visible` is a fresh array every
  // render, so depending on it directly would clear and restart every timer on
  // each render — including the ones caused by an unrelated re-render.
  const visibleIds = visible.map((fill) => fill.id).join(",");

  useEffect(() => {
    if (!visibleIds) return;
    const timers = visibleIds.split(",").map((id) =>
      setTimeout(() => {
        setDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
      }, TOAST_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [visibleIds]);

  if (visible.length === 0) return null;

  return (
    <div
      // `polite`, not `assertive`: a fill is worth announcing to a screen
      // reader but must not interrupt someone mid-way through the order form.
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {visible.map((fill) => {
        const { label, failed } = describeStatus(fill.status);
        const isBuy = fill.side === "BUY";
        return (
          <div
            key={fill.id}
            className={`pointer-events-auto rounded-xl border px-4 py-3 shadow-lg backdrop-blur ${
              failed ? "border-red-900/60 bg-red-950/80" : "border-zinc-700 bg-zinc-900/90"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-100">
                  <span className={isBuy ? "text-emerald-400" : "text-red-400"}>
                    {isBuy ? "Bought" : "Sold"}
                  </span>{" "}
                  {fill.size.toFixed(2)} {fill.outcome ?? "shares"} @ {(fill.price * 100).toFixed(1)}¢
                </p>
                <p className={`mt-0.5 text-xs ${failed ? "text-red-300" : "text-zinc-500"}`}>{label}</p>
              </div>
              <button
                type="button"
                onClick={() => setDismissed((prev) => [...prev, fill.id])}
                aria-label="Dismiss notification"
                className="shrink-0 text-zinc-500 transition hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
