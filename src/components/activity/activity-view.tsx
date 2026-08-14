"use client";

import { useBrowserClient } from "@/hooks/use-browser-client";
import { useUserChannel } from "@/hooks/use-user-channel";
import { ActivityList } from "@/components/activity/activity-list";
import { FillToasts } from "@/components/trade/fill-toasts";
import { StatusDot } from "@/components/ui/primitives";

/**
 * Activity page shell (FR-4.4).
 *
 * Lives on its own route rather than inside the portfolio because the two
 * answer different questions — the portfolio is "what do I hold and what is it
 * worth", this is "what have I done". The nav shell was built expecting exactly
 * this split: `Activity` sat as an inert placeholder next to `Portfolio` from
 * the start, the same way `Dashboards` held the slot `Portfolio` later took.
 *
 * ⚠️ The connect gating below is a third near-copy of the one in
 * `PortfolioView` (and `TradingPanel`, and `DepositWalletPanel`). Deliberate,
 * and the same call the codebase already made when `use-browser-client.ts` was
 * extracted: the shared *state machine* is the part worth centralising, while
 * folding a refactor of working screens into a feature increment makes any
 * regression ambiguous about which change caused it. A shared `<ConnectGate>`
 * is the obvious follow-up once these screens have been verified against a real
 * wallet — it should not ride along with the feature that first needed it.
 */
export function ActivityView() {
  const { client, status, error, connect } = useBrowserClient();
  const { state: userChannel, status: liveStatus } = useUserChannel(client);

  if (status === "signed-out") {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-500">
        Sign in to see your activity.
      </div>
    );
  }

  if (status !== "ready" || !client) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        {status === "error" && error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}
        <p className="mb-4 text-sm text-zinc-500">
          Connect your trading wallet to load your history. This is the same wallet you trade with —
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

  return (
    <div className="space-y-4">
      {/*
        Same reasoning as the portfolio's indicator: a page that is silently
        self-updating and one whose socket died an hour ago look identical
        without it, and only the second needs a reload.
      */}
      <div className="flex items-center justify-end">
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
          <StatusDot tone={liveStatus === "live" ? "ok" : liveStatus === "error" ? "bad" : "idle"} />
          {liveStatus === "live" ? "Live" : liveStatus === "error" ? "Offline" : "Connecting…"}
        </span>
      </div>

      <ActivityList client={client} revision={userChannel.revision} />

      <FillToasts fills={userChannel.fills} />
    </div>
  );
}
