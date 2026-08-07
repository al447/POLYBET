import { Suspense } from "react";
import Link from "next/link";

import { isAuthConfigured } from "@/lib/auth/public-config";
import {
  ActivityIcon,
  BellIcon,
  ChartIcon,
  GiftIcon,
  GridIcon,
  LogoMark,
  MenuIcon,
  TrophyIcon,
} from "@/components/ui/icons";
import { PrivyAuthArea } from "@/components/layout/privy-auth-area";
import { NavSearch } from "@/components/layout/nav-search";

/**
 * Global masthead (implementation.md UI shell).
 *
 * "Markets" (this app's one real page), search (`NavSearch`, Milestone 2),
 * and the auth area are live. `Dashboards` / `Activity` / `Ranks` / `Rewards` /
 * notifications still have no feature behind them — they render muted and
 * non-interactive rather than being hidden, matching the rest of the app's
 * convention of explaining an inert control instead of pretending it isn't
 * there (`AuthNotConfigured`, `WalletUnavailable`).
 *
 * No `"use client"` here: only the auth area and search need client hooks, so
 * the split mirrors `AccountPanel` / `PrivyAccountPanel`.
 */
export function NavBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <LogoMark className="size-6 text-emerald-400" />
          <span className="text-base font-semibold tracking-tight text-zinc-100">
            Prediction Markets
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-100"
          >
            <GridIcon className="size-4" />
            Markets
          </Link>
          <InertNavItem icon={<ChartIcon className="size-4" />} label="Dashboards" />
          <InertNavItem icon={<ActivityIcon className="size-4" />} label="Activity" />
          <InertNavItem icon={<TrophyIcon className="size-4" />} label="Ranks" />
          <InertNavItem icon={<GiftIcon className="size-4" />} label="Rewards" />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Suspense fallback={<div className="hidden h-9 w-56 rounded-lg bg-zinc-900/60 lg:block" />}>
            <NavSearch />
          </Suspense>

          <button
            type="button"
            disabled
            title="Notifications are not available yet"
            className="hidden cursor-not-allowed rounded-lg p-2 text-zinc-600 sm:inline-flex"
          >
            <BellIcon className="size-5" />
          </button>

          {isAuthConfigured ? <PrivyAuthArea /> : <AuthNotConfiguredArea />}

          <button
            type="button"
            disabled
            title="Menu (coming soon)"
            className="inline-flex cursor-not-allowed rounded-lg p-2 text-zinc-600 md:hidden"
          >
            <MenuIcon className="size-5" />
          </button>
        </div>
      </div>
    </header>
  );
}

function InertNavItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span
      title="Coming soon"
      className="flex cursor-default items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 opacity-60"
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * Mirrors `AuthNotConfigured` in `AccountPanel`: same reason (P-6 absent),
 * same tone, compact enough for the nav rail.
 */
function AuthNotConfiguredArea() {
  return (
    <div
      className="flex items-center gap-2 text-sm text-zinc-600"
      title="Login is unavailable until the Privy credentials (P-6) are supplied."
    >
      <span className="cursor-not-allowed">Log in</span>
      <span className="cursor-not-allowed rounded-lg bg-zinc-800 px-3 py-1.5 font-semibold text-zinc-500">
        Sign up
      </span>
    </div>
  );
}
