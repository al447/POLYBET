import { Suspense } from "react";
import Link from "next/link";

import { isAuthConfigured } from "@/lib/auth/public-config";
import { LogoMark } from "@/components/ui/icons";
import { PrivyAuthArea } from "@/components/layout/privy-auth-area";
import { NavSearch } from "@/components/layout/nav-search";
import { NavMenu, PrivyMenuAuthRow } from "@/components/layout/nav-menu";
import { NavCategories } from "@/components/layout/nav-categories";

/**
 * Global masthead — two rows.
 *
 * Row 1 is brand, search, and account. Search is the centre of gravity rather
 * than a 224px box in the corner, because finding a market is the first thing
 * anyone does here.
 *
 * Row 2 (`NavCategories`) is the feed and category tabs. These used to live
 * inside `MarketGrid`, below the page heading, the geo banner and the
 * readiness panel — far enough down that browsing looked like it wasn't
 * offered. Hoisting them means the selection had to move into the URL; see
 * `NavCategories` and `MarketGrid` for why that was the right mechanism.
 *
 * The old inline Markets / Portfolio / Activity / Ranks / Rewards rail is
 * gone: Portfolio and Activity moved into the hamburger menu, Ranks and
 * Rewards became "coming soon" rows there, and Markets is the logo.
 *
 * No `"use client"` here: only the search box, the menu and the category tabs
 * need client hooks, and each is its own file. Same split as `AccountPanel` /
 * `PrivyAccountPanel`.
 */
export function NavBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-6 sm:gap-5">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <LogoMark className="size-6 text-emerald-400" />
          <span className="hidden text-base font-semibold tracking-tight text-zinc-100 sm:inline">
            Prediction Markets
          </span>
        </Link>

        <div className="min-w-0 flex-1 lg:mx-auto lg:max-w-xl">
          <Suspense fallback={<div className="h-10 w-full rounded-xl bg-zinc-900/60" />}>
            <NavSearch />
          </Suspense>
        </div>

        {/*
          Inert rather than a link: there is no "how it works" page, and adding
          one wasn't part of this change. Same convention as the menu's
          placeholder rows — show it, explain it, don't fake it.
        */}
        <span
          title="Coming soon"
          className="hidden shrink-0 cursor-default text-sm font-medium text-zinc-600 lg:inline"
        >
          How it works
        </span>

        <div className="flex shrink-0 items-center gap-2">
          {isAuthConfigured ? <PrivyAuthArea /> : <AuthNotConfiguredArea />}
          <NavMenu authRow={isAuthConfigured ? <PrivyMenuAuthRow /> : null} />
        </div>
      </div>

      <div className="mx-auto max-w-7xl">
        <Suspense fallback={<div className="h-11" />}>
          <NavCategories />
        </Suspense>
      </div>
    </header>
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
      <span className="hidden cursor-not-allowed sm:inline">Log in</span>
      <span className="cursor-not-allowed rounded-lg bg-zinc-800 px-3 py-1.5 font-semibold text-zinc-500">
        Sign up
      </span>
    </div>
  );
}
