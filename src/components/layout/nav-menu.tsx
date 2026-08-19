"use client";

import type { ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";

import { Menu, MenuButton, MenuDivider, MenuItem, MenuItemInert } from "@/components/ui/menu";
import {
  ActivityIcon,
  BookmarkIcon,
  ChartIcon,
  GiftIcon,
  HelpIcon,
  MenuIcon,
  SparkleIcon,
  TrophyIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

/**
 * The masthead's hamburger menu.
 *
 * Several of these rows have no feature behind them. They render muted and
 * non-interactive with a "Coming soon" tooltip rather than being hidden —
 * the same convention the nav bar used for its old inline `Ranks`/`Rewards`
 * placeholders, and that `AuthNotConfigured` / `WalletUnavailable` use
 * elsewhere. Showing them advertises the roadmap without pretending the
 * feature exists.
 *
 * Leaderboard and Copy Trading became real links on 2026-08-17. Note what that
 * does and doesn't mean: `/leaderboard` is a complete feature, but
 * `/copy-trade` is a landing page over live leaderboard data with no copy
 * engine behind it — the buttons there are honest about that (see `CopyCta`).
 * The row is a link because the page exists, not because the feature ships.
 * Predict AI joined them on 2026-08-19 on exactly the same terms: `/predict-ai`
 * is a real fixture board over live Gamma data, but the model it is named for
 * does not exist and the page is explicit about that on every row.
 *
 * No "Dark mode" row, unlike the reference design: this app is dark-only by
 * decision (see the comment in `globals.css`), so a toggle would either lie or
 * need a theme system that doesn't exist yet.
 *
 * `authRow` is passed in from the server-rendered `NavBar` rather than read
 * here, so the Privy-dependent half never mounts when Privy isn't configured —
 * same split as `PrivyAuthArea`.
 */
export function NavMenu({ authRow }: { authRow?: ReactNode }) {
  return (
    <Menu
      label="Menu"
      align="right"
      triggerClassName="inline-flex cursor-pointer rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100"
      trigger={() => <MenuIcon className="size-5" />}
    >
      <MenuItem href="/leaderboard" icon={<TrophyIcon className="size-4" />}>
        Leaderboard
      </MenuItem>
      <MenuItem href="/copy-trade" icon={<UsersIcon className="size-4" />}>
        Copy Trading
      </MenuItem>
      <MenuItem href="/predict-ai" icon={<SparkleIcon className="size-4" />}>
        Predict AI
      </MenuItem>
      <MenuItemInert icon={<BookmarkIcon className="size-4" />}>Watchlist</MenuItemInert>
      <MenuItemInert icon={<GiftIcon className="size-4" />}>Rewards</MenuItemInert>

      <MenuDivider />

      <MenuItem href="/portfolio" icon={<ChartIcon className="size-4" />}>
        Portfolio
      </MenuItem>
      <MenuItem href="/activity" icon={<ActivityIcon className="size-4" />}>
        Activity
      </MenuItem>

      <MenuDivider />

      <MenuItemInert icon={<HelpIcon className="size-4" />}>Help Center</MenuItemInert>
      {/* Paths come from the registry, not literals — `LEGAL_DOCUMENTS` is what
          the footer and Privy's signup modal also read (FR-6.4). */}
      <MenuItem href={LEGAL_DOCUMENTS.terms.path}>{LEGAL_DOCUMENTS.terms.title}</MenuItem>
      <MenuItem href={LEGAL_DOCUMENTS.risk.path}>{LEGAL_DOCUMENTS.risk.title}</MenuItem>

      {authRow ? (
        <>
          <MenuDivider />
          {authRow}
        </>
      ) : null}
    </Menu>
  );
}

/**
 * Sign-in / sign-out row for the menu.
 *
 * Deliberately thin — the primary Log in / Sign up buttons live in the
 * masthead itself (`PrivyAuthArea`). This is the reference layout's duplicate
 * entry, useful on narrow screens where those buttons collapse.
 */
export function PrivyMenuAuthRow() {
  const { ready, authenticated, login, logout } = usePrivy();

  if (!ready) return null;

  return (
    <MenuButton onClick={authenticated ? logout : login}>
      {authenticated ? "Sign out" : "Log in"}
    </MenuButton>
  );
}
