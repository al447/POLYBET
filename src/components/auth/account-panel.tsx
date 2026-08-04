"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

import { isAuthConfigured } from "@/lib/auth/public-config";
import { Card, Row, StatusDot, shortenAddress } from "@/components/ui/primitives";

/**
 * Login and session panel (FR-1.1, implementation.md Step 1.5).
 *
 * Shows both halves of the session deliberately: what the browser believes
 * (Privy client state) and what the server independently verified. They can
 * disagree — an access token without an identity token leaves the browser
 * "logged in" while every signing route rejects the user — and surfacing only
 * the client half would hide exactly the failure that matters.
 */
export function AccountPanel() {
  // Hooks live in the inner component so they are never called without a
  // PrivyProvider ancestor, which throws.
  if (!isAuthConfigured) return <AuthNotConfigured />;
  return <PrivyAccountPanel />;
}

type ServerSession =
  | { state: "loading" }
  | { state: "authenticated"; address: string; email: string | null }
  | { state: "rejected"; reason: string };

/**
 * Asks the server who it thinks we are. Free of setState so it can be called
 * from an effect: React requires state updates to happen in a callback rather
 * than synchronously in an effect body.
 */
async function loadServerSession(): Promise<ServerSession> {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    const data = await response.json();
    return data.authenticated
      ? {
          state: "authenticated",
          address: data.user.signerAddress,
          email: data.user.email,
        }
      : { state: "rejected", reason: data.reason ?? "unknown" };
  } catch {
    return { state: "rejected", reason: "network_error" };
  }
}

function PrivyAccountPanel() {
  const { ready, authenticated, user, login, logout } = usePrivy();

  // Starts as "loading" rather than being set to it inside an effect, which
  // would trigger a cascading render.
  const [server, setServer] = useState<ServerSession>({ state: "loading" });

  // Privy writes its cookies as part of login, so the server check runs once
  // the client is authenticated rather than on mount.
  useEffect(() => {
    if (!ready || !authenticated) return;

    let cancelled = false;
    void loadServerSession().then((next) => {
      if (!cancelled) setServer(next);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated]);

  // Event handlers may set state directly — the effect-body restriction does
  // not apply, so the button can show its own pending state.
  const reverify = useCallback(() => {
    setServer({ state: "loading" });
    void loadServerSession().then(setServer);
  }, []);

  if (!ready) {
    return (
      <Card title="Account">
        <p className="text-sm text-zinc-500">Loading session…</p>
      </Card>
    );
  }

  if (!authenticated) {
    return (
      <Card title="Account">
        <p className="mb-4 text-sm text-zinc-500">
          Sign in with your email. A self-custodial wallet is created for you —
          no seed phrase, no browser extension.
        </p>
        <button
          onClick={login}
          className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-emerald-400"
        >
          Sign in with email
        </button>
      </Card>
    );
  }

  const embeddedWallet = user?.linkedAccounts.find(
    (account) =>
      account.type === "wallet" &&
      "walletClientType" in account &&
      account.walletClientType === "privy",
  );
  const address =
    embeddedWallet && "address" in embeddedWallet
      ? (embeddedWallet.address as string)
      : null;

  return (
    <Card title="Account">
      <div className="space-y-1">
        <Row label="Email" value={user?.email?.address ?? "—"} />
        <Row
          label="Signer (EOA)"
          value={address ? shortenAddress(address) : "not provisioned"}
          mono
          title={address ?? undefined}
        />
        <Row label="Server session" value={<ServerStatus session={server} />} />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={reverify}
          className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
        >
          Re-verify
        </button>
        <button
          onClick={logout}
          className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
        >
          Sign out
        </button>
      </div>
    </Card>
  );
}

function ServerStatus({ session }: { session: ServerSession }) {
  switch (session.state) {
    case "loading":
      return <span className="text-zinc-500">verifying…</span>;
    case "authenticated":
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-400">
          <StatusDot tone="ok" />
          verified
        </span>
      );
    case "rejected":
      return (
        <span
          className="inline-flex items-center gap-1.5 text-amber-400"
          title={session.reason}
        >
          <StatusDot tone="warn" />
          {session.reason}
        </span>
      );
  }
}

function AuthNotConfigured() {
  return (
    <Card title="Account">
      <p className="text-sm text-zinc-500">
        Login is unavailable until the Privy credentials (P-6) are supplied. The
        rest of the platform runs normally in this mode — every screen renders
        and every code path is exercised, but nothing is signed.
      </p>
      {/*
        Deliberately does NOT spell out the server secret's env var name: the
        leak guard (scripts/check-client-bundle.mjs) treats any occurrence of a
        server-only secret NAME in client output as a finding, which is what
        catches a server module being pulled into a Client Component. Naming it
        here in prose would make that check permanently red.
      */}
      <p className="mt-3 font-mono text-xs text-zinc-600">
        NEXT_PUBLIC_PRIVY_APP_ID · Privy app secret (server-side)
      </p>
    </Card>
  );
}
