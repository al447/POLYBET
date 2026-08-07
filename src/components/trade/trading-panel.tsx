"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import Image from "next/image";

import {
  createBrowserClient,
  enableTradingApprovals,
  hasTradingApprovals,
  placeMarketBuy,
  placeMarketSell,
  preflightOrder,
  readCollateralBalance,
} from "@/lib/polymarket/browser-client";
import type { BrowserClient } from "@/lib/polymarket/browser-client";
import { outcomeTokens, outcomePriceFractions } from "@/lib/polymarket/gamma-types";
import type { GammaMarket, OutcomeToken } from "@/lib/polymarket/gamma-types";
import { calculateFeeBreakdown, checkBalance, fromBaseUnits, toBaseUnits } from "@/lib/polymarket/fees";

/**
 * Sticky order ticket (FR-3.1, FR-3.2, FR-3.6) — market orders only. Limit
 * orders and the live order-book WebSocket are separate, not-yet-built steps
 * (implementation.md Steps 3.1, 3.6): prices shown here are Gamma's cached
 * snapshot, not a live book. Lives on the market detail page next to
 * `OutcomeList` (replaced the modal-per-card design 2026-08-07 to match
 * Polymarket's own browse-then-trade layout).
 *
 * Splits state into two pieces deliberately:
 *   - `connection` (wallet client, balance, approvals, fee rate) persists
 *     across outcome switches — clicking a different row must NOT force a
 *     reconnect or re-prompt a wallet signature.
 *   - the ticket itself (side, amount, submission) resets whenever `market`
 *     changes, via the effect below, since "amount to buy" for one outcome
 *     has no business carrying over to a different one.
 *
 * Every step that costs relay quota or asks for a wallet signature —
 * connecting, granting trading approvals, submitting — is gated behind an
 * explicit button click, matching `DepositWalletPanel`'s established rule.
 *
 * SELL isn't checked against actual holdings: that needs the Data API
 * (Milestone 4, not built). A sell for shares you don't hold is rejected by
 * Polymarket, not caught client-side.
 */

const SLIPPAGE = 0.05;
const QUICK_AMOUNTS = ["1", "5", "10", "100"];

type Side = "BUY" | "SELL";

type Connection =
  | { state: "connect" }
  | { state: "connecting" }
  | { state: "preparing" }
  | { state: "needs-approval"; client: BrowserClient; balance: bigint }
  | { state: "approving"; client: BrowserClient; balance: bigint }
  | { state: "ready"; client: BrowserClient; balance: bigint; feeBps: number }
  | { state: "error"; message: string; fallback: Connection };

type Submission =
  | { state: "idle" }
  | { state: "submitting" }
  | { state: "success"; orderId: string; status: string; makingAmount: string; takingAmount: string }
  | { state: "error"; message: string };

export function TradingPanel({
  market,
  outcomeIndex,
  eventTitle,
}: {
  market: GammaMarket;
  outcomeIndex: number;
  eventTitle: string;
}) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const outcomes = outcomeTokens(market);

  const [connection, setConnection] = useState<Connection>({ state: "connect" });
  const [selectedOutcome, setSelectedOutcome] = useState(outcomeIndex);
  const [side, setSide] = useState<Side>("BUY");
  const [amount, setAmount] = useState("");
  const [submission, setSubmission] = useState<Submission>({ state: "idle" });

  useEffect(() => {
    setSelectedOutcome(outcomeIndex);
    setSide("BUY");
    setAmount("");
    setSubmission({ state: "idle" });
  }, [market.id, outcomeIndex]);

  const outcome = outcomes[selectedOutcome];
  const prices = outcomePriceFractions(market);
  const price = prices[selectedOutcome];
  const validPrice = Number.isFinite(price) ? price : null;

  /**
   * `feeBps` is read from the server (never guessed client-side — a
   * hardcoded rate could silently drift from `BUILDER_FEE_BPS_TAKER`).
   * `tokenId`/`amount` are nominal placeholders: the route returns a flat
   * configured rate, not one computed from the request body.
   */
  const enterReady = useCallback(async (client: BrowserClient, balance: bigint) => {
    const quote = await preflightOrder({ tokenId: "1", side: "BUY", amount: "1" });
    if (!quote.allowed) {
      setConnection({ state: "error", message: quote.message, fallback: { state: "connect" } });
      return;
    }
    setConnection({ state: "ready", client, balance, feeBps: quote.feeBps.taker });
  }, []);

  const connect = useCallback(async () => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded) {
      setConnection({
        state: "error",
        message: "No Privy embedded wallet on this account.",
        fallback: { state: "connect" },
      });
      return;
    }

    setConnection({ state: "connecting" });
    try {
      const provider = await embedded.getEthereumProvider();
      const client = await createBrowserClient(provider as never, embedded.address);
      setConnection({ state: "preparing" });

      const [balance, approved] = await Promise.all([
        readCollateralBalance(client),
        hasTradingApprovals(client),
      ]);

      if (!approved) {
        setConnection({ state: "needs-approval", client, balance });
        return;
      }
      await enterReady(client, balance);
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : "wallet_setup_failed",
        fallback: { state: "connect" },
      });
    }
  }, [wallets, enterReady]);

  const approve = useCallback(async () => {
    if (connection.state !== "needs-approval") return;
    const { client, balance } = connection;
    setConnection({ state: "approving", client, balance });
    try {
      await enableTradingApprovals(client);
      await enterReady(client, balance);
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : "approval_failed",
        fallback: { state: "needs-approval", client, balance },
      });
    }
  }, [connection, enterReady]);

  const submit = useCallback(async () => {
    if (connection.state !== "ready" || !outcome) return;
    const { client, balance, feeBps } = connection;

    if (side === "BUY") {
      let notional: bigint;
      try {
        notional = toBaseUnits(amount || "0");
      } catch {
        setSubmission({ state: "error", message: "Enter a valid amount." });
        return;
      }
      if (notional <= 0n) {
        setSubmission({ state: "error", message: "Enter an amount greater than zero." });
        return;
      }
      const check = checkBalance({ balance, notional, builderFeeBps: feeBps });
      if (!check.ok) {
        setSubmission({ state: "error", message: check.reason });
        return;
      }
    } else if (!amount || Number(amount) <= 0) {
      setSubmission({ state: "error", message: "Enter a share amount greater than zero." });
      return;
    }

    setSubmission({ state: "submitting" });
    try {
      const preflight = await preflightOrder({ tokenId: outcome.tokenId, side, amount });
      if (!preflight.allowed) {
        setSubmission({ state: "error", message: preflight.message });
        return;
      }

      const response =
        side === "BUY"
          ? await placeMarketBuy(client, {
              tokenId: outcome.tokenId,
              amount,
              ...(validPrice !== null ? { maxPrice: clampPrice(validPrice * (1 + SLIPPAGE)).toFixed(3) } : {}),
            })
          : await placeMarketSell(client, {
              tokenId: outcome.tokenId,
              shares: amount,
              ...(validPrice !== null ? { minPrice: clampPrice(validPrice * (1 - SLIPPAGE)).toFixed(3) } : {}),
            });

      if (!response.ok) {
        setSubmission({ state: "error", message: response.message });
        return;
      }

      setSubmission({
        state: "success",
        orderId: response.orderId,
        status: response.status,
        makingAmount: response.makingAmount,
        takingAmount: response.takingAmount,
      });
    } catch (error) {
      setSubmission({ state: "error", message: error instanceof Error ? error.message : "order_failed" });
    }
  }, [connection, outcome, side, amount, validPrice]);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
      <div className="mb-5 flex items-center gap-3">
        {market.icon ? (
          <Image
            src={market.icon}
            alt=""
            width={44}
            height={44}
            className="size-11 shrink-0 rounded-lg object-cover"
            unoptimized
          />
        ) : (
          <div className="size-11 shrink-0 rounded-lg bg-zinc-800" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="truncate text-xs text-zinc-500">{eventTitle}</p>
          <p className="truncate text-lg font-semibold text-zinc-100">
            {market.question}
            {outcome ? (
              <>
                {" · "}
                <span className={outcome.label.toLowerCase() === "yes" ? "text-emerald-400" : "text-red-400"}>
                  {outcome.label}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      {!ready || !authenticated ? (
        <SignInStep ready={ready} onLogin={login} />
      ) : outcomes.length === 0 ? (
        <p className="text-base text-zinc-500">
          Trading isn&apos;t available for this market yet — Gamma hasn&apos;t indexed its CLOB token IDs.
        </p>
      ) : connection.state === "connect" || connection.state === "connecting" ? (
        <ConnectStep connecting={connection.state === "connecting"} onConnect={connect} />
      ) : connection.state === "preparing" ? (
        <p className="text-base text-zinc-500">Checking your wallet&apos;s trading status…</p>
      ) : connection.state === "needs-approval" || connection.state === "approving" ? (
        <ApprovalStep approving={connection.state === "approving"} onApprove={approve} />
      ) : connection.state === "error" ? (
        <ErrorBox message={connection.message} onRetry={() => setConnection(connection.fallback)} />
      ) : (
        <TicketBody
          feeBps={connection.feeBps}
          outcomes={outcomes}
          prices={prices}
          selectedOutcome={selectedOutcome}
          onSelectOutcome={setSelectedOutcome}
          side={side}
          onSideChange={setSide}
          amount={amount}
          onAmountChange={setAmount}
          price={validPrice}
          submission={submission}
          onSubmit={submit}
          onRetrySubmission={() => setSubmission({ state: "idle" })}
        />
      )}
    </div>
  );
}

function SignInStep({ ready, onLogin }: { ready: boolean; onLogin: () => void }) {
  return (
    <div>
      <p className="mb-4 text-base text-zinc-400">Sign in to place a trade.</p>
      <button
        type="button"
        onClick={onLogin}
        disabled={!ready}
        className="w-full rounded-xl bg-emerald-500 px-4 py-3.5 text-base font-bold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
      >
        Log in
      </button>
    </div>
  );
}

function ConnectStep({ connecting, onConnect }: { connecting: boolean; onConnect: () => void }) {
  return (
    <div>
      <p className="mb-4 text-base text-zinc-500">
        Connect your trading wallet to continue. This is the same wallet from the sidebar — nothing new
        to set up if you&apos;ve already funded it.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={connecting}
        className="w-full rounded-xl bg-emerald-500 px-4 py-3.5 text-base font-bold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
      >
        {connecting ? "Waiting for your wallet…" : "Connect wallet"}
      </button>
    </div>
  );
}

function ApprovalStep({ approving, onApprove }: { approving: boolean; onApprove: () => void }) {
  return (
    <div>
      <p className="mb-4 text-base text-zinc-500">
        One-time setup: authorize the exchange to move your pUSD and outcome tokens. Gasless, and only
        needed once — not before every trade.
      </p>
      <button
        type="button"
        onClick={onApprove}
        disabled={approving}
        className="w-full rounded-xl bg-emerald-500 px-4 py-3.5 text-base font-bold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
      >
        {approving ? "Waiting for your wallet…" : "Enable trading"}
      </button>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 text-sm font-semibold text-red-200 underline underline-offset-2"
      >
        Try again
      </button>
    </div>
  );
}

function TicketBody({
  feeBps,
  outcomes,
  prices,
  selectedOutcome,
  onSelectOutcome,
  side,
  onSideChange,
  amount,
  onAmountChange,
  price,
  submission,
  onSubmit,
  onRetrySubmission,
}: {
  feeBps: number;
  outcomes: OutcomeToken[];
  prices: number[];
  selectedOutcome: number;
  onSelectOutcome: (index: number) => void;
  side: Side;
  onSideChange: (side: Side) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  price: number | null;
  submission: Submission;
  onSubmit: () => void;
  onRetrySubmission: () => void;
}) {
  if (submission.state === "success") {
    return (
      <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/30 px-4 py-4 text-base">
        <p className="text-lg font-bold text-emerald-300">Order {submission.status.toLowerCase()}</p>
        <p className="mt-2 text-sm text-zinc-400">
          Order ID: <span className="font-mono">{submission.orderId}</span>
        </p>
        <p className="mt-1 text-sm text-zinc-400">
          Making amount: {submission.makingAmount} · Taking amount: {submission.takingAmount}
        </p>
      </div>
    );
  }

  const submitting = submission.state === "submitting";
  const breakdown = (() => {
    if (side !== "BUY" || !amount) return null;
    try {
      return calculateFeeBreakdown({ notional: toBaseUnits(amount), builderFeeBps: feeBps });
    } catch {
      return null;
    }
  })();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-5 text-lg font-bold">
          {(["BUY", "SELL"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSideChange(s)}
              disabled={submitting}
              className={`border-b-2 pb-1.5 transition ${
                side === s ? "border-zinc-100 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s === "BUY" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <span
          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-400"
          title="Limit orders aren't built yet — market orders only"
        >
          Market
        </span>
      </div>

      <div className="mb-5 flex gap-3">
        {outcomes.map((o, i) => {
          const cents = Number.isFinite(prices[i]) ? `${(prices[i] * 100).toFixed(1)}¢` : "—";
          const active = i === selectedOutcome;
          const isYes = o.label.toLowerCase() === "yes";
          return (
            <button
              key={o.tokenId}
              type="button"
              onClick={() => onSelectOutcome(i)}
              disabled={submitting}
              className={`flex-1 rounded-xl px-4 py-4 text-lg font-bold transition ${
                active
                  ? isYes
                    ? "bg-emerald-500 text-black"
                    : "bg-red-500 text-white"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {o.label} {cents}
            </button>
          );
        })}
      </div>

      <label className="mb-2 block text-sm font-medium text-zinc-400">
        {side === "BUY" ? "Amount to spend (USD)" : "Shares to sell"}
      </label>
      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(event) => onAmountChange(event.target.value)}
        disabled={submitting}
        placeholder="$0"
        className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3.5 text-2xl font-bold text-zinc-100 tabular-nums placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
      />

      {side === "BUY" ? (
        <div className="mt-3 flex gap-2">
          {QUICK_AMOUNTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAmountChange(String((Number(amount) || 0) + Number(q)))}
              disabled={submitting}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/40 py-2 text-sm font-semibold text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
            >
              +${q}
            </button>
          ))}
        </div>
      ) : null}

      {price !== null ? (
        <p className="mt-4 text-sm text-zinc-500">
          Snapshot price ≈ {(price * 100).toFixed(1)}¢ — a cached estimate, not a live quote. The order
          carries a {(SLIPPAGE * 100).toFixed(0)}% slippage cap so an unexpectedly bad fill is rejected
          rather than executed.
        </p>
      ) : null}

      {breakdown ? (
        <div className="mt-4 space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-400">
          <div className="flex justify-between">
            <span>Order</span>
            <span className="font-medium text-zinc-200">{fromBaseUnits(breakdown.notional)} pUSD</span>
          </div>
          <div className="flex justify-between">
            <span>Builder fee ({breakdown.builderFeeBps} bps)</span>
            <span className="font-medium text-zinc-200">{fromBaseUnits(breakdown.builderFee)} pUSD</span>
          </div>
          <div className="flex justify-between border-t border-zinc-800 pt-1.5 text-base font-bold">
            <span className="text-zinc-300">Total (excl. Polymarket&apos;s own fee)</span>
            <span className="text-zinc-100">{fromBaseUnits(breakdown.totalRequired)} pUSD</span>
          </div>
        </div>
      ) : null}

      {submission.state === "error" ? (
        <div className="mt-4">
          <ErrorBox message={submission.message} onRetry={onRetrySubmission} />
        </div>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting || !amount}
        className="mt-5 w-full rounded-xl bg-emerald-500 px-4 py-4 text-lg font-bold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
      >
        {submitting ? "Submitting…" : `${side === "BUY" ? "Buy" : "Sell"} — sign to confirm`}
      </button>

      <p className="mt-3 text-center text-xs text-zinc-600">
        This signs a real order on Polygon mainnet. There is no testnet for the CLOB.
      </p>
    </div>
  );
}

function clampPrice(value: number): number {
  return Math.min(Math.max(value, 0.001), 0.999);
}
