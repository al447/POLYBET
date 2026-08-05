"use client";

import { usePrivy } from "@privy-io/react-auth";

import { StatusDot, shortenAddress } from "@/components/ui/primitives";

/**
 * Compact nav-bar auth chip. Split out of `NavBar` so the hooks-using half is
 * the only client boundary — same reasoning as `AccountPanel` /
 * `PrivyAccountPanel`.
 *
 * Deliberately lighter than `AccountPanel`: no server round trip to
 * `/api/auth/me` here. This chip only needs to answer "signed in or not" for
 * the nav rail; the fuller, server-verified session detail lives in the
 * sidebar's `AccountPanel`.
 */
export function PrivyAuthArea() {
  const { ready, authenticated, user, login, logout } = usePrivy();

  if (!ready) {
    return <span className="text-sm text-zinc-600">…</span>;
  }

  if (!authenticated) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={login}
          className="text-sm font-medium text-zinc-300 transition hover:text-zinc-100"
        >
          Log in
        </button>
        <button
          onClick={login}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-black transition hover:bg-emerald-400"
        >
          Sign up
        </button>
      </div>
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
  const identity = address ? shortenAddress(address) : (user?.email?.address ?? "account");

  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300"
        title={address ?? undefined}
      >
        <StatusDot tone="ok" />
        {identity}
      </span>
      <button
        onClick={logout}
        className="text-sm font-medium text-zinc-500 transition hover:text-zinc-300"
      >
        Sign out
      </button>
    </div>
  );
}
