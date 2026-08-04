"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

import { isAuthConfigured, isTradingConfigured } from "@/lib/auth/public-config";
import type { BrowserClient } from "@/lib/polymarket/browser-client";
import { Card, Row, StatusDot, shortenAddress } from "@/components/ui/primitives";

/**
 * Deposit Wallet provisioning and funding (FR-1.2, FR-1.4).
 *
 * Everything here runs in the browser against the user's own Privy wallet.
 * There is no server round trip for wallet state, because server-side signing
 * would require the user to delegate their wallet to us — standing authority we
 * deliberately do not take. Our server's only involvement is supplying builder
 * authorization per request via `/api/builder/sign`, which never exposes the
 * builder secret.
 *
 * ⚠️ Setup is explicitly user-initiated and never runs on render.
 * `createSecureClient` derives the deterministic Deposit Wallet and, if it does
 * not exist, deploys it — spending one of **100 daily relay transactions**
 * shared across dev, QA and production. Constructing it again once the wallet
 * exists is free, which is what makes an explicit button both safe and
 * sufficient: we do not need to know the address in advance to avoid waste.
 */

type WalletState = {
  address: string;
  deployed: boolean;
  balance: { formatted: string; symbol: string } | null;
};

type Phase =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "ready"; wallet: WalletState }
  | { state: "error"; reason: string };

const COLLATERAL_SYMBOL = "pUSD";
const COLLATERAL_DECIMALS = 6;

/** Base units to a fixed-2 string. Integer math only — no float rounding. */
function formatCollateral(raw: bigint): string {
  const divisor = 10n ** BigInt(COLLATERAL_DECIMALS);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(COLLATERAL_DECIMALS, "0");
  return `${whole}.${fraction.slice(0, 2)}`;
}

async function readBalance(client: BrowserClient): Promise<bigint> {
  const { fetchBalanceAllowance } = await import("@polymarket/client/actions");
  const { AssetType } = await import("@polymarket/bindings/clob");
  const result = await fetchBalanceAllowance(client, {
    assetType: AssetType.COLLATERAL,
  });
  return BigInt(result.balance ?? 0n);
}

function walletStateFrom(client: BrowserClient, balance: bigint): WalletState {
  const account = (client as unknown as { account?: { wallet?: string } }).account;
  return {
    address: account?.wallet ?? "",
    deployed: true,
    balance: { formatted: formatCollateral(balance), symbol: COLLATERAL_SYMBOL },
  };
}

export function DepositWalletPanel() {
  if (!isAuthConfigured || !isTradingConfigured) return <WalletUnavailable />;
  return <ConnectedWalletPanel />;
}

function ConnectedWalletPanel() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();

  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  // Held so balance refreshes reuse the authenticated client rather than
  // rebuilding it, which would re-prompt the user's wallet to sign.
  const clientRef = useRef<BrowserClient | null>(null);

  const connect = useCallback(async () => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded) {
      setPhase({ state: "error", reason: "No Privy embedded wallet on this account." });
      return;
    }

    setPhase({ state: "connecting" });
    try {
      const { createBrowserClient } = await import("@/lib/polymarket/browser-client");
      const provider = await embedded.getEthereumProvider();
      const client = await createBrowserClient(provider as never, embedded.address);
      clientRef.current = client;

      setPhase({ state: "ready", wallet: walletStateFrom(client, await readBalance(client)) });
    } catch (error) {
      setPhase({
        state: "error",
        reason: error instanceof Error ? error.message : "wallet_setup_failed",
      });
    }
  }, [wallets]);

  // Poll only while funded-but-empty. A deposit arrives out of band, so there
  // is nothing for the UI to react to; polling stops as soon as funds land.
  const awaitingFunds =
    phase.state === "ready" &&
    (!phase.wallet.balance || phase.wallet.balance.formatted === "0.00");

  useEffect(() => {
    const client = clientRef.current;
    if (!awaitingFunds || !client) return;

    let cancelled = false;
    const timer = setInterval(() => {
      void readBalance(client)
        .then((balance) => {
          if (!cancelled) {
            setPhase({ state: "ready", wallet: walletStateFrom(client, balance) });
          }
        })
        .catch(() => {
          /* Transient; the next tick retries. */
        });
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [awaitingFunds]);

  // Rendered client-side so the deposit address never needs a server route.
  const address = phase.state === "ready" ? phase.wallet.address : null;
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void import("qrcode").then(({ default: QRCode }) =>
      QRCode.toDataURL(address, { margin: 1, width: 224 }).then((url) => {
        if (!cancelled) setQr(url);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [address]);

  const copyAddress = useCallback(async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  if (!ready || !authenticated) {
    return (
      <Card title="Deposit Wallet">
        <p className="text-sm text-zinc-500">Sign in to provision your wallet.</p>
      </Card>
    );
  }

  if (phase.state === "connecting") {
    return (
      <Card title="Deposit Wallet">
        <p className="text-sm text-zinc-500">
          Waiting for your wallet to sign… approve the request to continue.
        </p>
      </Card>
    );
  }

  if (phase.state === "idle" || phase.state === "error") {
    return (
      <Card title="Deposit Wallet">
        {phase.state === "error" && (
          <p className="mb-3 inline-flex items-start gap-1.5 text-sm text-amber-400">
            <StatusDot tone="warn" />
            <span className="min-w-0 break-words">{phase.reason}</span>
          </p>
        )}
        <p className="text-sm text-zinc-500">
          Your trading wallet is created the first time you set it up. It is
          gasless — you pay nothing and need no POL. You will be asked to sign
          once with your own wallet.
        </p>
        <button
          onClick={connect}
          className="mt-4 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-emerald-400"
        >
          {phase.state === "error" ? "Try again" : "Set up trading wallet"}
        </button>
      </Card>
    );
  }

  const { wallet } = phase;

  return (
    <Card title="Deposit Wallet">
      <div className="space-y-1">
        <Row
          label="Address"
          value={wallet.address ? shortenAddress(wallet.address) : "—"}
          mono
          title={wallet.address}
        />
        <Row
          label="Status"
          value={
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <StatusDot tone="ok" />
              ready
            </span>
          }
        />
        {wallet.balance && (
          <Row
            label="Balance"
            value={`${wallet.balance.formatted} ${wallet.balance.symbol}`}
          />
        )}
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-5">
        <h3 className="mb-3 text-sm font-medium text-zinc-300">Add funds</h3>
        <div className="flex gap-4">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr}
              alt={`QR code for deposit address ${wallet.address}`}
              className="size-28 shrink-0 rounded-lg bg-white p-1"
              width={112}
              height={112}
            />
          ) : (
            <div className="size-28 shrink-0 rounded-lg bg-zinc-900" />
          )}

          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-400">
              Send <strong className="text-zinc-200">USDC on Polygon</strong> to
              this address. It arrives as{" "}
              <strong className="text-zinc-200">pUSD</strong> — $1 in, $1
              available to trade.
            </p>
            <button
              onClick={() => copyAddress(wallet.address)}
              className="mt-3 w-full truncate rounded-lg border border-zinc-700 px-3 py-2 text-left font-mono text-xs text-zinc-300 transition hover:bg-zinc-800"
              title={wallet.address}
            >
              {copied ? "Copied" : wallet.address}
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs text-zinc-600">
          Polygon network only. Funds sent on another chain cannot be recovered.
        </p>
      </div>
    </Card>
  );
}

function WalletUnavailable() {
  return (
    <Card title="Deposit Wallet">
      <p className="text-sm text-zinc-500">
        Wallet provisioning needs the Privy credentials (P-6) and the Polymarket
        builder code (P-1). Until then this panel is inert by design — no wallet
        is deployed and no relay quota is spent.
      </p>
    </Card>
  );
}
