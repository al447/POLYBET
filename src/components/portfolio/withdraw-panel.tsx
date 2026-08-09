"use client";

import { useCallback, useState } from "react";

import { transferCollateral, type BrowserClient } from "@/lib/polymarket/browser-client";
import {
  assertBridgeAssetsUnchanged,
  createWithdrawAddress,
  fetchWithdrawQuote,
  validateWithdrawal,
  type WithdrawQuote,
} from "@/lib/polymarket/withdraw";
import { fromBaseUnits } from "@/lib/polymarket/fees";
import { Card } from "@/components/ui/primitives";

/**
 * Withdraw pUSD as USDC to an external Polygon address (FR-4.6).
 *
 * Destination is fixed to **USDC on Polygon** for now. The bridge supports 13
 * chains and 200+ tokens, but a chain picker is the single worst footgun in a
 * flow this irreversible — pick the wrong one and the funds are unrecoverable.
 * Multi-chain is a later UI change on the same plumbing.
 *
 * The step machine exists to make the confirm screen unskippable: a
 * withdrawal is signed only after the user has seen the real quote, the exact
 * amount arriving, and their destination address in full (untruncated, so a
 * typo is actually visible). Nothing here signs on a single click.
 */

const CHAIN_LABEL = "Polygon";

type Step =
  | { state: "form" }
  | { state: "quoting" }
  | { state: "confirm"; quote: WithdrawQuote; amountBaseUnit: bigint; recipient: string }
  | { state: "sending" }
  | { state: "submitted"; txHash: string }
  | { state: "error"; message: string };

export function WithdrawPanel({
  client,
  balance,
  onComplete,
}: {
  client: BrowserClient;
  balance: bigint;
  onComplete: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<Step>({ state: "form" });

  const validation = validateWithdrawal({ amount, recipient, balance });
  // Only surface a validation message once the user has actually typed
  // something — an empty form shouldn't read as an error.
  const showValidation = (amount !== "" || recipient !== "") && !validation.ok;

  const requestQuote = useCallback(async () => {
    const check = validateWithdrawal({ amount, recipient, balance });
    if (!check.ok) return;

    setStep({ state: "quoting" });
    try {
      // Refuse to proceed if the token addresses we'd send to have drifted
      // from what was verified — see withdraw.ts.
      await assertBridgeAssetsUnchanged();
      const quote = await fetchWithdrawQuote({
        amountBaseUnit: check.amountBaseUnit,
        recipientAddress: recipient,
      });
      setStep({ state: "confirm", quote, amountBaseUnit: check.amountBaseUnit, recipient });
    } catch (error) {
      setStep({
        state: "error",
        message: error instanceof Error ? error.message : "Couldn't get a withdrawal quote.",
      });
    }
  }, [amount, recipient, balance]);

  const submit = useCallback(async () => {
    if (step.state !== "confirm") return;
    const { amountBaseUnit, recipient: to } = step;

    setStep({ state: "sending" });
    try {
      const bridgeAddress = await createWithdrawAddress({
        walletAddress: accountWallet(client),
        recipientAddress: to,
      });
      const txHash = await transferCollateral(client, {
        to: bridgeAddress,
        amountBaseUnit,
      });
      setStep({ state: "submitted", txHash });
      setAmount("");
      setRecipient("");
      onComplete();
    } catch (error) {
      setStep({
        state: "error",
        message: error instanceof Error ? error.message : "Withdrawal failed.",
      });
    }
  }, [step, client, onComplete]);

  if (step.state === "submitted") {
    return (
      <Card title="Withdraw">
        <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-4 py-3">
          <p className="font-semibold text-emerald-300">Withdrawal sent</p>
          <p className="mt-1.5 text-sm text-zinc-400">
            USDC typically arrives within about 30 seconds.
          </p>
          <p className="mt-2 truncate font-mono text-xs text-zinc-500" title={step.txHash}>
            {step.txHash}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setStep({ state: "form" })}
          className="mt-3 text-sm font-medium text-zinc-400 underline underline-offset-2 transition hover:text-zinc-200"
        >
          Make another withdrawal
        </button>
      </Card>
    );
  }

  if (step.state === "error") {
    return (
      <Card title="Withdraw">
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          <p>{step.message}</p>
          <p className="mt-2 text-xs text-red-200/70">
            No funds have moved unless a transaction hash was shown.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setStep({ state: "form" })}
          className="mt-3 text-sm font-medium text-zinc-400 underline underline-offset-2 transition hover:text-zinc-200"
        >
          Back
        </button>
      </Card>
    );
  }

  if (step.state === "confirm") {
    const received = Number(step.quote.estToTokenBaseUnit) / 1e6;
    return (
      <Card title="Confirm withdrawal">
        <dl className="space-y-2 text-sm">
          <Line label="You send" value={`${fromBaseUnits(step.amountBaseUnit)} pUSD`} />
          <Line label="You receive (est.)" value={`${received.toFixed(4)} USDC on ${CHAIN_LABEL}`} />
          <Line label="Network fee (est.)" value={`$${step.quote.estFeeBreakdown.gasUsd.toFixed(4)}`} />
          <Line label="Minimum received" value={`${step.quote.estFeeBreakdown.minReceived.toFixed(4)} USDC`} />
          <Line
            label="Arrives in"
            value={`~${Math.round(step.quote.estCheckoutTimeMs / 1000)}s`}
          />
        </dl>

        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
          <p className="text-xs text-zinc-500">Recipient ({CHAIN_LABEL})</p>
          {/* Full address, never truncated — a typo has to be visible here. */}
          <p className="mt-1 font-mono text-xs break-all text-zinc-200">{step.recipient}</p>
        </div>

        <p className="mt-3 text-xs text-amber-400">
          This cannot be undone. Funds are sent on {CHAIN_LABEL} only — check the address carefully.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setStep({ state: "form" })}
            className="flex-1 rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
          >
            Back
          </button>
          <button
            type="button"
            onClick={submit}
            className="flex-1 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-emerald-400"
          >
            Confirm withdrawal
          </button>
        </div>
      </Card>
    );
  }

  const busy = step.state === "quoting" || step.state === "sending";

  return (
    <Card title="Withdraw">
      <div className="mb-3 flex items-center justify-between">
        <label htmlFor="withdraw-amount" className="text-sm font-medium text-zinc-400">
          Amount (pUSD)
        </label>
        <button
          type="button"
          onClick={() => setAmount(fromBaseUnits(balance))}
          disabled={busy}
          className="text-xs font-semibold text-emerald-400 transition hover:text-emerald-300"
        >
          Max ({fromBaseUnits(balance)})
        </button>
      </div>
      <input
        id="withdraw-amount"
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        disabled={busy}
        placeholder="0.00"
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-lg font-semibold text-zinc-100 tabular-nums placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
      />

      <label htmlFor="withdraw-to" className="mt-4 mb-2 block text-sm font-medium text-zinc-400">
        Send to ({CHAIN_LABEL} address)
      </label>
      <input
        id="withdraw-to"
        type="text"
        value={recipient}
        onChange={(event) => setRecipient(event.target.value)}
        disabled={busy}
        placeholder="0x…"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
      />

      {showValidation ? (
        <p className="mt-2 text-xs text-amber-400">{validation.ok ? null : validation.reason}</p>
      ) : (
        <p className="mt-2 text-xs text-zinc-600">
          Converted to USDC and sent on {CHAIN_LABEL}. Polymarket charges no withdrawal fee.
        </p>
      )}

      <button
        type="button"
        onClick={requestQuote}
        disabled={busy || !validation.ok}
        className="mt-4 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {step.state === "quoting" ? "Getting quote…" : "Review withdrawal"}
      </button>
    </Card>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium text-zinc-200 tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The Deposit Wallet address the bridge should expect funds from. Read off
 * the client the same way `deposit-wallet-panel.tsx` does — the SDK's public
 * types don't expose `account` on the client surface.
 */
function accountWallet(client: BrowserClient): string {
  const account = (client as unknown as { account?: { wallet?: string } }).account;
  return account?.wallet ?? "";
}
