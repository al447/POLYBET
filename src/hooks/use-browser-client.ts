"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

import {
  createBrowserClient,
  hasDeployedWalletCached,
  markWalletDeployedCached,
  type BrowserClient,
} from "@/lib/polymarket/browser-client";

export type BrowserClientStatus = "signed-out" | "idle" | "connecting" | "ready" | "error";

/**
 * The connect / auto-reconnect state machine, extracted once a third screen
 * needed it (`PortfolioView`, after `TradingPanel` and `DepositWalletPanel`).
 *
 * Exposes only the part all three share — "do we have an authenticated client
 * yet." The other two layer extra states on top that don't belong here
 * (`TradingPanel` tracks trading approvals and the fee rate;
 * `DepositWalletPanel` tracks the wallet address and balance), and both are
 * left on their own copies for now: folding a refactor of working, manually
 * verified screens into a feature increment would make any regression
 * ambiguous about which change caused it.
 *
 * ⚠️ The auto-connect rule is the safety-critical part, and matches the other
 * two exactly: only auto-run when `hasDeployedWalletCached` says we've
 * *previously observed* this wallet's Deposit Wallet exist. `createSecureClient`
 * deploys the wallet when it doesn't exist yet — spending one of 100 daily
 * relay transactions — so a wallet we've never connected before must still
 * require an explicit click and never deploy on render.
 */
export function useBrowserClient(): {
  client: BrowserClient | null;
  status: BrowserClientStatus;
  error: string | null;
  connect: () => Promise<void>;
} {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();

  const [client, setClient] = useState<BrowserClient | null>(null);
  const [status, setStatus] = useState<BrowserClientStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded) {
      setStatus("error");
      setError("No Privy embedded wallet on this account.");
      return;
    }

    setStatus("connecting");
    setError(null);
    try {
      const provider = await embedded.getEthereumProvider();
      const next = await createBrowserClient(provider as never, embedded.address);
      // Success proves the Deposit Wallet exists — cache it so later mounts
      // can skip straight past the manual button.
      markWalletDeployedCached(embedded.address);
      setClient(next);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "wallet_setup_failed");
    }
  }, [wallets]);

  useEffect(() => {
    async function maybeAutoConnect() {
      if (!ready) return;
      if (!authenticated) {
        setStatus("signed-out");
        setClient(null);
        return;
      }
      if (status !== "idle" && status !== "signed-out") return;

      const embedded = wallets.find((w) => w.walletClientType === "privy");
      if (!embedded || !hasDeployedWalletCached(embedded.address)) {
        setStatus("idle");
        return;
      }
      await connect();
    }
    void maybeAutoConnect();
  }, [ready, authenticated, status, wallets, connect]);

  return { client, status, error, connect };
}
