"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Menu, MenuItem } from "@/components/ui/menu";
import { ChevronDownIcon, TrendingIcon } from "@/components/ui/icons";
import {
  DEFAULT_SORT_ID,
  EVENT_SORTS,
  TOP_CATEGORIES,
  resolveSort,
} from "@/lib/polymarket/gamma-types";
import type { EventSortId } from "@/lib/polymarket/gamma-types";

/**
 * Second masthead row: feed tabs, then category tabs, then a "More" overflow.
 *
 * Every tab is a plain `<Link>`, not a button. That is the whole reason the
 * discovery selection moved into the URL: this row lives in the root layout,
 * a different React subtree from `MarketGrid`, so it cannot share state with
 * the grid — but it can write the query string the grid reads. It also means
 * these tabs work from `/portfolio` or `/activity`, landing the user back on a
 * pre-filtered home page.
 *
 * The reference design's "Breaking" tab has no equivalent here and is omitted:
 * Gamma exposes no such sort, and inventing one would mean a tab whose label
 * doesn't describe what it returns. "Most liquid" is likewise left out of the
 * masthead — it stays reachable through the grid's own Sort control, which is
 * the right home for a fifth option nobody browses by.
 */

/** Feed tabs, in reference order. A curated subset of `EVENT_SORTS`. */
const FEED_TAB_IDS: readonly EventSortId[] = ["trending", "top", "new", "ending"];

/** How many categories sit inline before the rest fall into "More". */
const INLINE_CATEGORY_COUNT = 8;

export function NavCategories() {
  const searchParams = useSearchParams();

  // `resolveSort` falls back to the default on absent/garbage input, so a bare
  // `/` correctly lights up the "Top" tab.
  const activeSort = resolveSort(searchParams.get("sort")).id;
  const activeTagId = searchParams.get("tagId");

  /**
   * Builds a tab href by merging into the *current* params.
   *
   * 🚩 Merging rather than replacing matters: dropping `sort` when picking a
   * category would change the sort out from under the grid's keyset cursor,
   * and Gamma 422s when a cursor is replayed under a different sort. That
   * exact bug shipped once already ("Load more" silently never worked).
   */
  function tabHref(patch: { sort?: EventSortId; tagId?: string | null }) {
    const params = new URLSearchParams(searchParams.toString());

    if (patch.sort !== undefined) {
      if (patch.sort === DEFAULT_SORT_ID) params.delete("sort");
      else params.set("sort", patch.sort);
    }

    if (patch.tagId !== undefined) {
      if (patch.tagId === null) params.delete("tagId");
      else params.set("tagId", patch.tagId);
    }

    // Browsing by tab leaves search mode. The two are different modes — the
    // grid hides its filters entirely while `q` is set, because Gamma's
    // `/public-search` ignores sort and range filters.
    params.delete("q");

    const query = params.toString();
    return query ? `/?${query}` : "/";
  }

  const inlineCategories = TOP_CATEGORIES.slice(0, INLINE_CATEGORY_COUNT);
  const overflowCategories = TOP_CATEGORIES.slice(INLINE_CATEGORY_COUNT);
  // When the selected category is hidden inside "More", the button takes its
  // name — otherwise the active filter would be invisible from the masthead.
  const activeOverflow = overflowCategories.find((tag) => tag.id === activeTagId);

  return (
    // 🚩 The "More" menu is a SIBLING of the scrolling strip, not inside it.
    // `overflow-x: auto` also clips vertically, so a dropdown panel rendered
    // within it would be cut off at the nav's bottom edge.
    <div className="flex items-center gap-1 px-6">
      <nav
        aria-label="Market categories"
        // Horizontal scroll keeps the row usable on a phone; the scrollbar is
        // hidden because a visible one under a nav row reads as a stray border.
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {FEED_TAB_IDS.map((id) => {
          const sort = EVENT_SORTS.find((option) => option.id === id);
          if (!sort) return null;
          return (
            // Keeps the current category: "Trending" while on Politics means
            // trending politics, not a reset. Same behaviour as the grid's own
            // Sort chips, which only ever patch `sort`.
            <Tab key={id} href={tabHref({ sort: id })} active={activeSort === id}>
              {id === "trending" ? <TrendingIcon className="size-4" /> : null}
              {sort.label}
            </Tab>
          );
        })}

        <span aria-hidden className="mx-2 h-5 w-px shrink-0 bg-zinc-800" />

        <Tab href={tabHref({ tagId: null })} active={activeTagId === null}>
          All
        </Tab>
        {inlineCategories.map((tag) => (
          <Tab key={tag.id} href={tabHref({ tagId: tag.id })} active={activeTagId === tag.id}>
            {tag.label ?? tag.slug ?? tag.id}
          </Tab>
        ))}
      </nav>

      {overflowCategories.length > 0 ? (
        <Menu
          label="More categories"
          align="right"
          triggerClassName={`flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
            activeOverflow ? "text-emerald-300" : "text-zinc-400 hover:text-zinc-100"
          }`}
          trigger={(open) => (
            <>
              {activeOverflow?.label ?? "More"}
              <ChevronDownIcon className={`size-4 transition ${open ? "rotate-180" : ""}`} />
            </>
          )}
        >
          {overflowCategories.map((tag) => (
            <MenuItem key={tag.id} href={tabHref({ tagId: tag.id })}>
              {tag.label ?? tag.slug ?? tag.id}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
    </div>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition ${
        active
          ? "border-emerald-400 text-zinc-100"
          : "border-transparent text-zinc-400 hover:text-zinc-100"
      }`}
    >
      {children}
    </Link>
  );
}
