"use client";

import { useCallback, useEffect, useState } from "react";

import type { CopyEngine } from "@/hooks/use-copy-engine";
import { priceGuard } from "@/lib/copy-trade/execute";
import {
  COPY_EXECUTION_MODE,
  QUEUE_EXPIRY_MS,
  type CopyLedgerEntry,
} from "@/lib/copy-trade/types";
import { formatUsdExact } from "@/lib/format";

/**
 * The copies waiting on the user, and the button that places them.
 *
 * 🚩 **This panel is the human in "nothing is signed without a human action".**
 * The engine can watch, size and queue all day; the only way a copy becomes a
 * real order is a click here. That is what keeps a browser-tab copier from
 * being the discretionary trading service OI-5 is about — so nothing in here
 * should ever grow an "always place automatically" shortcut without that
 * decision being taken deliberately, and elsewhere.
 *
 * Three things are surfaced because hiding any of them would make the click
 * dishonest:
 *
 *  - **The price bound.** A copy will not fill above (or below) a band around
 *    the trader's own fill, so a click can legitimately produce no position.
 *    Saying so beforehand is the difference between "the guard worked" and
 *    "the app is broken".
 *  - **The countdown.** A queued copy expires; a user reading a stale list
 *    would otherwise click into a decision that is already void.
 *  - **Trading approvals.** The first copy from a fresh wallet fails on
 *    allowance with an opaque SDK error unless the one-off grant happens first.
 *
 * Renders nothing under `"simulated"`: the dry run's sweep resolves the queue
 * within a second of it appearing, so a queue panel there would be a box that
 * is always empty.
 */

type Props = { engine: CopyEngine };

type Approvals = "unknown" | "checking" | "ready" | "needed" | "granting" | "error";

export function CopyQueue({ engine }: Props) {
  const { queue, client, walletStatus, connectWallet, placing, placeQueued, dismissQueued } = engine;
  const [approvals, setApprovals] = useState<Approvals>("unknown");
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // Only checked when there is something to place. It is a network read on the
  // user's wallet, and a dashboard with an empty queue has no reason to make it.
  useEffect(() => {
    // Back to unknown when the wallet goes away, so a reconnect re-checks
    // rather than trusting an answer about a client that no longer exists.
    if (!client) {
      setApprovals("unknown");
      return;
    }
    if (queue.length === 0 || approvals !== "unknown") return;

    let cancelled = false;
    setApprovals("checking");
    void (async () => {
      try {
        const { hasTradingApprovals } = await import("@/lib/polymarket/browser-client");
        const granted = await hasTradingApprovals(client);
        if (!cancelled) setApprovals(granted ? "ready" : "needed");
      } catch {
        // A failed check must not block placing. The check is a heuristic (see
        // `hasTradingApprovals`); the CLOB is the real authority, and its
        // rejection is a better answer than a button we disabled on a guess.
        if (!cancelled) setApprovals("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, queue.length, approvals]);

  const grantApprovals = useCallback(async () => {
    if (!client) return;
    setApprovals("granting");
    setApprovalError(null);
    try {
      const { enableTradingApprovals } = await import("@/lib/polymarket/browser-client");
      await enableTradingApprovals(client);
      setApprovals("ready");
    } catch (error) {
      setApprovals("needed");
      setApprovalError(error instanceof Error ? error.message : "Could not enable trading.");
    }
  }, [client]);

  if (COPY_EXECUTION_MODE === "simulated") return null;
  if (queue.length === 0) return null;

  const walletReady = walletStatus === "ready" && client !== null;
  // "checking" blocks too: it is sub-second, and letting a click through it
  // would place the copy that needs approvals with no approvals. An `error`
  // deliberately does not block — see the catch above.
  const blocked =
    !walletReady ||
    approvals === "checking" ||
    approvals === "needed" ||
    approvals === "granting";

  return (
    <section className="mt-6 rounded-xl border border-blue-500/30 bg-blue-500/[0.03]">
      <header className="border-b border-blue-500/20 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-100">
          Waiting for you
          <span className="ml-2 rounded bg-blue-500/15 px-1.5 py-0.5 text-xs text-blue-300">
            {queue.length}
          </span>
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Nothing is signed until you place it. Each copy expires{" "}
          {Math.round(QUEUE_EXPIRY_MS / 60_000)} minutes after the engine works it out, because the
          price it was sized against stops being real.
        </p>
      </header>

      {!walletReady ? (
        <WalletGate status={walletStatus} onConnect={() => void connectWallet()} />
      ) : null}

      {walletReady && (approvals === "needed" || approvals === "granting") ? (
        <div className="border-b border-blue-500/20 px-5 py-4">
          <p className="text-sm text-zinc-300">
            <span className="font-semibold">One-off setup.</span> Your wallet has not approved the
            exchange to move pUSD and outcome tokens yet. Copies cannot fill without it.
          </p>
          <button
            type="button"
            onClick={() => void grantApprovals()}
            disabled={approvals === "granting"}
            className="mt-3 cursor-pointer rounded-lg border border-emerald-500/40 px-3 py-1.5 text-sm font-medium text-emerald-300 transition hover:border-emerald-500/60 disabled:cursor-wait disabled:text-zinc-500"
          >
            {approvals === "granting" ? "Enabling…" : "Enable trading"}
          </button>
          {approvalError ? <p className="mt-2 text-xs text-red-400/80">{approvalError}</p> : null}
        </div>
      ) : null}

      <ul className="divide-y divide-zinc-800/60">
        {queue.map((entry) => (
          <QueueRow
            key={entry.id}
            entry={entry}
            placing={placing.includes(entry.id)}
            blocked={blocked}
            onPlace={() => void placeQueued(entry.id)}
            onDismiss={() => dismissQueued(entry.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function WalletGate({
  status,
  onConnect,
}: {
  status: CopyEngine["walletStatus"];
  onConnect: () => void;
}) {
  return (
    <div className="border-b border-blue-500/20 px-5 py-4">
      <p className="text-sm text-zinc-300">
        {status === "connecting"
          ? "Connecting your wallet…"
          : status === "error"
            ? "Your wallet could not be connected. Try again to place these copies."
            : "Connect your wallet to place these copies."}
      </p>
      {status !== "connecting" ? (
        <button
          type="button"
          onClick={onConnect}
          className="mt-3 cursor-pointer rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition hover:border-zinc-600"
        >
          Connect wallet
        </button>
      ) : null}
    </div>
  );
}

function QueueRow({
  entry,
  placing,
  blocked,
  onPlace,
  onDismiss,
}: {
  entry: CopyLedgerEntry;
  placing: boolean;
  blocked: boolean;
  onPlace: () => void;
  onDismiss: () => void;
}) {
  const remaining = useTimeLeft(entry.decidedAt);
  const guard = priceGuard(entry);
  const size =
    entry.side === "BUY"
      ? entry.amountUsd !== undefined
        ? formatUsdExact(entry.amountUsd)
        : "—"
      : `${trimShares(entry.shares)} shares`;

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-100" title={entry.title}>
          <span className={entry.side === "BUY" ? "text-emerald-400" : "text-red-400"}>
            {entry.side}
          </span>{" "}
          {entry.outcome} · {entry.title || "Unknown market"}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Copying {entry.traderName}
          {entry.expectedPrice !== undefined ? ` · they filled at ~${entry.expectedPrice.toFixed(3)}` : ""}
          {remaining ? ` · expires in ${remaining}` : " · expired"}
        </p>
        {guard.maxPrice ? (
          <p className="mt-1 text-xs text-zinc-600">Will not fill above {guard.maxPrice}</p>
        ) : null}
        {guard.minPrice ? (
          <p className="mt-1 text-xs text-zinc-600">Will not fill below {guard.minPrice}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onDismiss}
          disabled={placing}
          className="cursor-pointer rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onPlace}
          disabled={placing || blocked}
          className="cursor-pointer rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {placing ? "Placing…" : `Place ${size}`}
        </button>
      </div>
    </li>
  );
}

/** `1.5` shares reads better than `1.5000000000000002`, which is what the exit fraction produces. */
function trimShares(shares: number | undefined): string {
  if (shares === undefined || !Number.isFinite(shares)) return "—";
  return String(Math.round(shares * 1e4) / 1e4);
}

/**
 * Time left before this decision expires, ticking once a second.
 *
 * Empty string once it is up — the row is then cancelled by the next engine
 * pass, but the button is already the wrong thing to click, and a countdown
 * frozen at "0s" would suggest otherwise.
 */
function useTimeLeft(decidedAt: string): string {
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const decided = Date.parse(decidedAt);
  if (!Number.isFinite(decided)) return "";

  const left = decided + QUEUE_EXPIRY_MS - Date.now();
  if (left <= 0) return "";

  const seconds = Math.floor(left / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
