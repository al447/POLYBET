"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { MarketCard } from "@/components/markets/market-card";
import {
  DEFAULT_FILTER_ID,
  DEFAULT_SORT_ID,
  ENDING_FILTERS,
  EVENT_SORTS,
  LIQUIDITY_FILTERS,
  VOLUME_FILTERS,
} from "@/lib/polymarket/gamma-types";
import type {
  EndingFilterId,
  EventSortId,
  GammaEvent,
  GammaTag,
  LiquidityFilterId,
  VolumeFilterId,
} from "@/lib/polymarket/gamma-types";

/** Everything that narrows the browse grid. Any change invalidates the cursor. */
type GridSelection = {
  tagId: number | null;
  sort: EventSortId;
  volume: VolumeFilterId;
  liquidity: LiquidityFilterId;
  ending: EndingFilterId;
};

/**
 * What's currently on screen, plus how to get more of it.
 *
 * Browse paginates by cursor and search by page number, so both live here and
 * `hasMore` is the single thing the "Load more" button reads — it doesn't need
 * to know which mode produced the list.
 */
type Results = {
  items: GammaEvent[];
  cursor: string | null;
  page: number;
  hasMore: boolean;
  totalResults: number | null;
};

/** True when the selection still matches what `DiscoverySection` rendered server-side. */
function isServerRenderedSelection(selection: GridSelection): boolean {
  return (
    selection.tagId === null &&
    selection.sort === DEFAULT_SORT_ID &&
    selection.volume === DEFAULT_FILTER_ID &&
    selection.liquidity === DEFAULT_FILTER_ID &&
    selection.ending === DEFAULT_FILTER_ID
  );
}

/**
 * Interactive discovery grid (FR-2.1, FR-2.2, FR-2.3, FR-2.4).
 *
 * Client component so category chips, sort, filters and "Load more" can update
 * in place — everything it fetches after the first paint goes through
 * `/api/markets` or `/api/markets/search` (never Gamma directly, per
 * implementation.md Step 2.2). The server-rendered `initialEvents` avoid a
 * redundant client-side fetch on first load.
 *
 * Two modes, decided by `?q=` (set by the nav bar's search box):
 *
 * - **Browse** — `/api/markets`, cursor-paginated, narrowed by the category /
 *   sort / range-filter chips.
 * - **Search** — `/api/markets/search`, page-numbered, whole catalogue.
 *
 * The chips are hidden while searching rather than disabled, because Gamma's
 * search endpoint genuinely ignores sort and range filters (verified
 * 2026-08-15) — leaving them visible would imply they still apply. Sort is a
 * closed set of ids (`EVENT_SORTS`) rather than a free-form order/direction
 * pair, because the two must stay paired to be replayed on a cursor.
 */
export function MarketGrid({
  initialEvents,
  initialCursor,
  tags,
}: {
  initialEvents: GammaEvent[];
  initialCursor: string | null;
  tags: GammaTag[];
}) {
  const searchParams = useSearchParams();
  // Seeds from `?tagId=` so links (e.g. the sidebar's Trending topics) land
  // pre-filtered. When present this costs one client-side refetch replacing
  // `initialEvents` (which was fetched unfiltered) — a Server Component that
  // also read `searchParams` could avoid that, left as a fast-follow.
  const initialTagId = searchParams.get("tagId");
  // One object rather than five `useState`s so the reset effect has a single
  // dependency: every one of these invalidates the current cursor, and any
  // change has to restart from page 1. `sort` starts on the same default
  // `DiscoverySection` server-rendered with — see `fetchBrowsePage` for why.
  const [selection, setSelection] = useState<GridSelection>({
    tagId: initialTagId ? Number(initialTagId) : null,
    sort: DEFAULT_SORT_ID,
    volume: DEFAULT_FILTER_ID,
    liquidity: DEFAULT_FILTER_ID,
    ending: DEFAULT_FILTER_ID,
  });
  const [results, setResults] = useState<Results>({
    items: initialEvents,
    cursor: initialCursor,
    page: 1,
    hasMore: initialCursor !== null,
    totalResults: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = (searchParams.get("q") ?? "").trim();
  const isSearching = query.length > 0;

  const select = (patch: Partial<GridSelection>) => setSelection((prev) => ({ ...prev, ...patch }));

  // 🚩 The whole selection goes on every request, paginated or not. Gamma
  // binds a keyset cursor to the sort that produced it and 422s on a mismatch,
  // so "Load more" has to ask for page 2 under exactly what fetched page 1.
  const fetchBrowsePage = useCallback(async (current: GridSelection, cursor: string | null) => {
    const params = new URLSearchParams();
    params.set("limit", "24");
    params.set("sort", current.sort);
    if (current.tagId !== null) params.set("tagId", String(current.tagId));
    if (current.volume !== DEFAULT_FILTER_ID) params.set("volume", current.volume);
    if (current.liquidity !== DEFAULT_FILTER_ID) params.set("liquidity", current.liquidity);
    if (current.ending !== DEFAULT_FILTER_ID) params.set("ending", current.ending);
    if (cursor) params.set("cursor", cursor);

    const body = await getJson(`/api/markets?${params.toString()}`);
    const page = body as { items: GammaEvent[]; nextCursor: string | null };
    return {
      items: page.items,
      cursor: page.nextCursor,
      page: 1,
      hasMore: page.nextCursor !== null,
      totalResults: null,
    } satisfies Results;
  }, []);

  const fetchSearchPage = useCallback(async (term: string, page: number) => {
    const params = new URLSearchParams({ q: term, page: String(page) });

    const body = await getJson(`/api/markets/search?${params.toString()}`);
    const result = body as {
      items: GammaEvent[];
      page: number;
      hasMore: boolean;
      totalResults: number;
    };
    return {
      items: result.items,
      cursor: null,
      page: result.page,
      hasMore: result.hasMore,
      totalResults: result.totalResults,
    } satisfies Results;
  }, []);

  // Re-fetch whenever the search term or anything in the selection changes.
  // Every change resets to the first page: a cursor from the previous
  // selection is meaningless under a new one, and for sort it actively 422s.
  //
  // Only the very first render is special-cased: if there's no search term and
  // the selection is still exactly what `DiscoverySection` server-rendered,
  // `initialEvents` already covers it and a fetch would be redundant. Landing
  // with `?tagId=` or `?q=` makes it differ, so those cases do fetch. Every
  // render after that, "All" with no filters means the user actively cleared
  // everything and must refetch — treating the default as "skip"
  // unconditionally was the bug: clicking "All" after another chip left
  // whatever (possibly empty) results that chip had fetched sitting in state,
  // since nothing told it to reset.
  const isFirstEffectRun = useRef(true);
  useEffect(() => {
    if (isFirstEffectRun.current) {
      isFirstEffectRun.current = false;
      if (!isSearching && isServerRenderedSelection(selection)) return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const request = isSearching ? fetchSearchPage(query, 1) : fetchBrowsePage(selection, null);

    request
      .then((page) => {
        if (!cancelled) setResults(page);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load markets");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selection, query, isSearching, fetchBrowsePage, fetchSearchPage]);

  async function loadMore() {
    if (!results.hasMore || loading) return;
    setLoading(true);
    setError(null);
    try {
      const next = isSearching
        ? await fetchSearchPage(query, results.page + 1)
        : await fetchBrowsePage(selection, results.cursor);

      // Append, but keep the *new* pagination state — `next.items` is only
      // this page's worth.
      setResults((prev) => ({ ...next, items: [...prev.items, ...next.items] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more markets");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isSearching ? (
        <p className="text-sm text-zinc-400">
          {results.totalResults === 0 ? (
            <>No markets found for &ldquo;{query}&rdquo;.</>
          ) : (
            <>
              <span className="text-zinc-200">{results.totalResults?.toLocaleString() ?? "—"}</span> result
              {results.totalResults === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
            </>
          )}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <CategoryChip
              label="All"
              active={selection.tagId === null}
              onClick={() => select({ tagId: null })}
            />
            {tags.map((tag) => (
              <CategoryChip
                key={tag.id}
                label={tag.label ?? tag.slug ?? tag.id}
                active={selection.tagId === Number(tag.id)}
                onClick={() => select({ tagId: Number(tag.id) })}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <ChipGroup
              label="Sort"
              options={EVENT_SORTS}
              value={selection.sort}
              onSelect={(sort) => select({ sort })}
            />
            <ChipGroup
              label="Volume"
              options={VOLUME_FILTERS}
              value={selection.volume}
              onSelect={(volume) => select({ volume })}
            />
            <ChipGroup
              label="Liquidity"
              options={LIQUIDITY_FILTERS}
              value={selection.liquidity}
              onSelect={(liquidity) => select({ liquidity })}
            />
            <ChipGroup
              label="Ending in"
              options={ENDING_FILTERS}
              value={selection.ending}
              onSelect={(ending) => select({ ending })}
            />
          </div>
        </>
      )}

      {error ? (
        <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>
      ) : null}

      {results.items.length === 0 && !loading ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center text-sm text-zinc-500">
          No markets match{isSearching ? ` "${query}"` : " this filter"}.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {results.items.map((event) => (
            <MarketCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {results.hasMore ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="mx-auto rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

/** Fetches JSON, surfacing the route's own `error` message when there is one. */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : null;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return response.json();
}

/** A labelled row of mutually-exclusive chips — sort and each range filter. */
function ChipGroup<Id extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: readonly { id: Id; label: string }[];
  value: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      {options.map((option) => (
        <CategoryChip
          key={option.id}
          label={option.label}
          active={value === option.id}
          onClick={() => onSelect(option.id)}
        />
      ))}
    </div>
  );
}

function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
          : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );
}
