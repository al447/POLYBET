"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import Image from "next/image";

import {
  createBrowserClient,
  enableTradingApprovals,
  hasDeployedWalletCached,
  hasTradingApprovals,
  markWalletDeployedCached,
  placeLimitBuy,
  placeLimitSell,
  placeMarketBuy,
  placeMarketSell,
  preflightOrder,
  readCollateralBalance,
} from "@/lib/polymarket/browser-client";
import type { BrowserClient } from "@/lib/polymarket/browser-client";
import { outcomeTokens, outcomePriceFractions } from "@/lib/polymarket/gamma-types";
import type { GammaMarket, OutcomeToken } from "@/lib/polymarket/gamma-types";
import { calculateFeeBreakdown, checkBalance, fromBaseUnits, limitOrderNotional, toBaseUnits } from "@/lib/polymarket/fees";
import { computeGtdExpiration, type GtdDuration } from "@/lib/polymarket/config";
import { useOrderBook } from "@/hooks/use-orderbook";
import { useUserChannel } from "@/hooks/use-user-channel";
import { OrderBook } from "@/components/trade/order-book";
import { OpenOrdersPanel } from "@/components/trade/open-orders-panel";
import { FillToasts } from "@/components/trade/fill-toasts";

/**
 * Sticky order ticket (FR-3.1, FR-3.2, FR-3.6, FR-3.3) — market and limit
 * orders. The live order book (Step 3.1/3.2, `useOrderBook`/`OrderBook`,
 * built 2026-08-09) anchors the market-order slippage guard when it's live;
 * the "Snapshot price" text shown to the user is still Gamma's cached price
 * on purpose — that copy is about what price the order was *quoted* at, not
 * what it's actually guarded against. Limit orders (Step 3.6, built
 * 2026-08-09) rest via `placeLimitBuy`/`placeLimitSell`, GTC by default or
 * GTD via `computeGtdExpiration`; `OpenOrdersPanel` below the ticket shows
 * and cancels whatever's resting for the selected outcome. Lives on the
 * market detail page next to `OutcomeList` (replaced the modal-per-card
 * design 2026-08-07 to match Polymarket's own browse-then-trade layout).
 *
 * Splits state into two pieces deliberately:
 *   - `connection` (wallet client, balance, approvals, fee rate) persists
 *     across outcome switches — clicking a different row must NOT force a
 *     reconnect or re-prompt a wallet signature.
 *   - the ticket itself (side, amount, order type, submission) resets
 *     whenever `market` changes, via the effect below, since "amount to
 *     buy" for one outcome has no business carrying over to a different one.
 *
 * Every step that costs relay quota or asks for a wallet signature —
 * connecting, granting trading approvals, submitting — is gated behind an
 * explicit button click, matching `DepositWalletPanel`'s established rule.
 *
 * The user channel (Step 3.7, `useUserChannel`, built 2026-08-09) keeps this
 * panel honest while it's open: a fill refreshes the collateral balance the
 * order checks run against, any order event refetches the resting-order list,
 * and `FillToasts` announces fills — including ones placed from another
 * device, since the channel is per-account, not per-tab.
 *
 * SELL isn't checked against actual holdings: that needs the Data API
 * (Milestone 4, not built). A sell for shares you don't hold is rejected by
 * Polymarket, not caught client-side.
 */

const SLIPPAGE = 0.05;
const QUICK_AMOUNTS = ["1", "5", "10", "100"];
const EXPIRY_OPTIONS: readonly { value: Expiry; label: string }[] = [
  { value: "gtc", label: "GTC" },
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
  { value: "1w", label: "1w" },
];

type Side = "BUY" | "SELL";
type OrderType = "market" | "limit";
type Expiry = "gtc" | GtdDuration;

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
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("gtc");
  const [submission, setSubmission] = useState<Submission>({ state: "idle" });
  const [refreshOrdersToken, setRefreshOrdersToken] = useState(0);

  /**
   * Reset the ticket when the caller switches market or outcome — done during
   * render (React's "adjusting state when a prop changes" pattern) rather than
   * in an effect. An effect paints one frame of the *previous* ticket against
   * the new outcome before resetting, which on an order form means briefly
   * showing a size and fee breakdown that belong to a different token. The
   * other obvious fix — re-keying this component from the parent — would also
   * tear down `connection`, forcing a wallet reconnect on every outcome click.
   */
  const ticketKey = `${market.id}:${outcomeIndex}`;
  const [prevTicketKey, setPrevTicketKey] = useState(ticketKey);
  if (prevTicketKey !== ticketKey) {
    setPrevTicketKey(ticketKey);
    setSelectedOutcome(outcomeIndex);
    setSide("BUY");
    setAmount("");
    setOrderType("market");
    setLimitPrice("");
    setExpiry("gtc");
    setSubmission({ state: "idle" });
  }

  const outcome = outcomes[selectedOutcome];
  const prices = outcomePriceFractions(market);
  const price = prices[selectedOutcome];
  const validPrice = Number.isFinite(price) ? price : null;

  const { book, status: bookStatus } = useOrderBook(outcome?.tokenId);
  // Anchor the slippage guard to the live best ask/bid when the book is
  // actually live; otherwise fall back to exactly today's behavior (Gamma's
  // cached snapshot). Never worse than before, strictly fresher when the WS
  // is connected — never trust `book` while it isn't "live" (NFR-6: a stale
  // book after a silent disconnect is how users get filled unexpectedly).
  const liveAsk = bookStatus === "live" ? book?.asks[0]?.price : undefined;
  const liveBid = bookStatus === "live" ? book?.bids[0]?.price : undefined;
  const buyAnchor: number | null = liveAsk ?? validPrice;
  const sellAnchor: number | null = liveBid ?? validPrice;

  /**
   * The user channel (Step 3.7) rides whichever authenticated client we
   * already hold — it's live from `needs-approval` onward, since fills can
   * land from another tab or device before this panel's own wallet is fully
   * set up. The client object's identity is stable across those transitions,
   * so approving trading doesn't tear down the subscription.
   */
  const liveClient =
    connection.state === "ready" || connection.state === "needs-approval" || connection.state === "approving"
      ? connection.client
      : null;
  const { state: userChannel } = useUserChannel(liveClient);

  /**
   * Single source of truth for "how much collateral does a BUY need" —
   * shared by the balance check in `submit` and the fee-breakdown display,
   * so the two can never disagree. Market buy: `amount` already is USD
   * notional. Limit buy: `amount` is shares, so notional is shares × price.
   */
  const notionalBaseUnits: bigint | null = (() => {
    if (side !== "BUY" || !amount) return null;
    try {
      return orderType === "market"
        ? toBaseUnits(amount)
        : limitPrice
          ? limitOrderNotional(amount, limitPrice)
          : null;
    } catch {
      return null;
    }
  })();

  /**
   * Switching to Limit prefills the price from the live book/snapshot
   * anchor (if the field is still empty) — a lightweight, toggle-time
   * version of click-to-fill; per-row click-to-fill on the book itself is
   * still deferred.
   */
  const handleOrderTypeChange = useCallback(
    (next: OrderType) => {
      setOrderType(next);
      if (next === "limit" && !limitPrice) {
        const anchor = side === "BUY" ? buyAnchor : sellAnchor;
        if (anchor !== null) setLimitPrice(clampPrice(anchor).toFixed(3));
      }
    },
    [limitPrice, side, buyAnchor, sellAnchor],
  );

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
      // Reaching here proves the Deposit Wallet exists (deployed just now, or
      // already existed) — cache it so a future mount can skip this button.
      markWalletDeployedCached(embedded.address);
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

  /**
   * Auto-reconnect on return visits (reload, or navigating to a different
   * market's page — both remount this component from scratch). Gated on
   * `connection.state === "connect"` so it fires at most once per mount and
   * never after an explicit error (no silent retry loop), and on the
   * localStorage cache so it only ever calls `connect()` for a wallet we've
   * personally observed succeed before — never risks an unprompted deploy
   * for a genuinely new wallet, which still gets the manual button.
   */
  useEffect(() => {
    if (connection.state !== "connect" || !ready || !authenticated) return;
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded || !hasDeployedWalletCached(embedded.address)) return;

    async function attemptAutoConnect() {
      await connect();
    }
    void attemptAutoConnect();
  }, [connection.state, ready, authenticated, wallets, connect]);

  /**
   * A fill spends collateral, so the balance this panel checks orders against
   * goes stale the moment one lands. `revision` bumps on every user event
   * *and* on every (re)connect of the channel, so this also covers fills that
   * happened while the socket was down — see `useUserChannel`.
   *
   * Failure is swallowed on purpose: a balance read that fails leaves the
   * previous figure in place, which is exactly where we'd be without the
   * channel at all. Surfacing an error box over the order form for it would
   * be a downgrade.
   */
  useEffect(() => {
    if (!liveClient || userChannel.revision === 0) return;
    let cancelled = false;

    async function refreshBalance(client: BrowserClient) {
      try {
        const balance = await readCollateralBalance(client);
        if (!cancelled) setConnection((prev) => (prev.state === "ready" ? { ...prev, balance } : prev));
      } catch {
        // Intentionally ignored — see above.
      }
    }
    void refreshBalance(liveClient);

    return () => {
      cancelled = true;
    };
  }, [liveClient, userChannel.revision]);

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

    if (orderType === "limit") {
      const priceNum = Number(limitPrice);
      if (!limitPrice || !Number.isFinite(priceNum) || priceNum <= 0 || priceNum >= 1) {
        setSubmission({ state: "error", message: "Enter a limit price between 0 and 1." });
        return;
      }
    }

    if (side === "BUY") {
      if (notionalBaseUnits === null || notionalBaseUnits <= 0n) {
        setSubmission({
          state: "error",
          message: orderType === "market" ? "Enter an amount greater than zero." : "Enter a valid price and share amount.",
        });
        return;
      }
      const check = checkBalance({ balance, notional: notionalBaseUnits, builderFeeBps: feeBps });
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
      const preflight = await preflightOrder({
        tokenId: outcome.tokenId,
        side,
        amount,
        ...(orderType === "limit" ? { limitPrice } : {}),
      });
      if (!preflight.allowed) {
        setSubmission({ state: "error", message: preflight.message });
        return;
      }

      const expiration = orderType === "limit" && expiry !== "gtc" ? computeGtdExpiration(expiry, Math.floor(Date.now() / 1000)) : undefined;

      const response =
        orderType === "market"
          ? side === "BUY"
            ? await placeMarketBuy(client, {
                tokenId: outcome.tokenId,
                amount,
                ...(buyAnchor !== null ? { maxPrice: clampPrice(buyAnchor * (1 + SLIPPAGE)).toFixed(3) } : {}),
              })
            : await placeMarketSell(client, {
                tokenId: outcome.tokenId,
                shares: amount,
                ...(sellAnchor !== null ? { minPrice: clampPrice(sellAnchor * (1 - SLIPPAGE)).toFixed(3) } : {}),
              })
          : side === "BUY"
            ? await placeLimitBuy(client, {
                tokenId: outcome.tokenId,
                price: limitPrice,
                size: amount,
                ...(expiration ? { expiration } : {}),
              })
            : await placeLimitSell(client, {
                tokenId: outcome.tokenId,
                price: limitPrice,
                size: amount,
                ...(expiration ? { expiration } : {}),
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
      if (orderType === "limit") setRefreshOrdersToken((token) => token + 1);
    } catch (error) {
      setSubmission({ state: "error", message: error instanceof Error ? error.message : "order_failed" });
    }
  }, [connection, outcome, side, amount, buyAnchor, sellAnchor, orderType, limitPrice, expiry, notionalBaseUnits]);

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

      {outcome ? (
        <div className="mb-5">
          <OrderBook book={book} status={bookStatus} outcomeLabel={outcome.label} />
        </div>
      ) : null}

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
        <>
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
            orderType={orderType}
            onOrderTypeChange={handleOrderTypeChange}
            limitPrice={limitPrice}
            onLimitPriceChange={setLimitPrice}
            expiry={expiry}
            onExpiryChange={setExpiry}
            notional={notionalBaseUnits}
            submission={submission}
            onSubmit={submit}
            onRetrySubmission={() => setSubmission({ state: "idle" })}
          />
          {outcome ? (
            <div className="mt-5">
              {/*
                Remount to refetch. Two triggers: our own limit-order
                submissions (`refreshOrdersToken`), and anything the user
                channel reports — a resting order filling, being cancelled from
                another device, or expiring server-side. Folding the live
                trigger into the existing key costs nothing and avoids a second
                refresh mechanism that could disagree with this one.
              */}
              <OpenOrdersPanel
                key={`${refreshOrdersToken}:${userChannel.revision}`}
                client={connection.client}
                tokenId={outcome.tokenId}
                outcomeLabel={outcome.label}
              />
            </div>
          ) : null}
        </>
      )}

      <FillToasts fills={userChannel.fills} />
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
  orderType,
  onOrderTypeChange,
  limitPrice,
  onLimitPriceChange,
  expiry,
  onExpiryChange,
  notional,
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
  orderType: OrderType;
  onOrderTypeChange: (type: OrderType) => void;
  limitPrice: string;
  onLimitPriceChange: (value: string) => void;
  expiry: Expiry;
  onExpiryChange: (value: Expiry) => void;
  notional: bigint | null;
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
  const breakdown = notional !== null ? calculateFeeBreakdown({ notional, builderFeeBps: feeBps }) : null;
  const amountLabel =
    orderType === "market" && side === "BUY" ? "Amount to spend (USD)" : `Shares to ${side === "BUY" ? "buy" : "sell"}`;

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
        <div className="flex overflow-hidden rounded-lg border border-zinc-800 text-sm font-medium">
          {(["market", "limit"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onOrderTypeChange(t)}
              disabled={submitting}
              className={`px-3 py-1.5 transition ${
                orderType === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t === "market" ? "Market" : "Limit"}
            </button>
          ))}
        </div>
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

      {orderType === "limit" ? (
        <>
          <label className="mb-2 block text-sm font-medium text-zinc-400">Limit price</label>
          <input
            type="text"
            inputMode="decimal"
            value={limitPrice}
            onChange={(event) => onLimitPriceChange(event.target.value)}
            disabled={submitting}
            placeholder="0.50"
            className="mb-3 w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-lg font-bold text-zinc-100 tabular-nums placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
          />
        </>
      ) : null}

      <label className="mb-2 block text-sm font-medium text-zinc-400">{amountLabel}</label>
      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(event) => onAmountChange(event.target.value)}
        disabled={submitting}
        placeholder={orderType === "market" && side === "BUY" ? "$0" : "0"}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3.5 text-2xl font-bold text-zinc-100 tabular-nums placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
      />

      {orderType === "market" && side === "BUY" ? (
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

      {orderType === "limit" ? (
        <div className="mt-3 flex gap-2">
          {EXPIRY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onExpiryChange(option.value)}
              disabled={submitting}
              className={`flex-1 rounded-lg border py-2 text-sm font-semibold transition ${
                expiry === option.value
                  ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      {orderType === "market" && price !== null ? (
        <p className="mt-4 text-sm text-zinc-500">
          Snapshot price ≈ {(price * 100).toFixed(1)}¢ — a cached estimate, not a live quote. The order
          carries a {(SLIPPAGE * 100).toFixed(0)}% slippage cap so an unexpectedly bad fill is rejected
          rather than executed.
        </p>
      ) : orderType === "limit" ? (
        <p className="mt-4 text-sm text-zinc-500">
          Rests in the book at this price until filled or canceled —{" "}
          {expiry === "gtc" ? "good til canceled." : `expires in ${expiry}.`}
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
