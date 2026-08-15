"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** Everything that narrows the grid. Any change invalidates the cursor. */
type GridSelection = {
  tagId: number | null;
  sort: EventSortId;
  volume: VolumeFilterId;
  liquidity: LiquidityFilterId;
  ending: EndingFilterId;
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
 * Interactive discovery grid (FR-2.1, FR-2.2, FR-2.4).
 *
 * Client component so category chips, sort and "Load more" can update in
 * place — everything it fetches after the first paint goes through
 * `/api/markets` (never Gamma directly, per implementation.md Step 2.2). The
 * server-rendered `initialEvents` avoid a redundant client-side fetch on first
 * load.
 *
 * Sort is a closed set of ids (`EVENT_SORTS`) rather than a free-form
 * order/direction pair, because the two must stay paired to be replayed on a
 * cursor — see `fetchPage`.
 *
 * Search (`?q=`, wired from the nav bar) is a client-side substring filter
 * over whatever page(s) are already loaded — FR-2.4 is a "Should", and real
 * full-catalog search would mean wiring Gamma's separate `/search` endpoint,
 * which is a reasonable fast-follow, not done here. Said plainly in the UI
 * when a query is active, so it doesn't read as "search found nothing" when
 * it actually means "not loaded yet."
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
  // `DiscoverySection` server-rendered with — see `fetchPage` for why.
  const [selection, setSelection] = useState<GridSelection>({
    tagId: initialTagId ? Number(initialTagId) : null,
    sort: DEFAULT_SORT_ID,
    volume: DEFAULT_FILTER_ID,
    liquidity: DEFAULT_FILTER_ID,
    ending: DEFAULT_FILTER_ID,
  });
  const [items, setItems] = useState<GammaEvent[]>(initialEvents);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = (searchParams.get("q") ?? "").trim().toLowerCase();

  const select = (patch: Partial<GridSelection>) => setSelection((prev) => ({ ...prev, ...patch }));

  // 🚩 The whole selection goes on every request, paginated or not. Gamma
  // binds a keyset cursor to the sort that produced it and 422s on a mismatch,
  // so "Load more" has to ask for page 2 under exactly what fetched page 1.
  const fetchPage = useCallback(
    async (current: GridSelection, cursorParam: string | null) => {
      const search = new URLSearchParams();
      search.set("limit", "24");
      search.set("sort", current.sort);
      if (current.tagId !== null) search.set("tagId", String(current.tagId));
      if (current.volume !== DEFAULT_FILTER_ID) search.set("volume", current.volume);
      if (current.liquidity !== DEFAULT_FILTER_ID) search.set("liquidity", current.liquidity);
      if (current.ending !== DEFAULT_FILTER_ID) search.set("ending", current.ending);
      if (cursorParam) search.set("cursor", cursorParam);

      const response = await fetch(`/api/markets?${search.toString()}`);
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : null;
        throw new Error(message ?? `Request failed (${response.status})`);
      }
      return (await response.json()) as { items: GammaEvent[]; nextCursor: string | null };
    },
    [],
  );

  // Re-fetch whenever anything in the selection changes — including back to
  // "All" (tagId null). Every change resets to page 1: a cursor from the
  // previous selection is meaningless under a new one, and for sort it
  // actively 422s.
  //
  // Only the very first render is special-cased: if the selection is still
  // exactly what `DiscoverySection` server-rendered, `initialEvents` already
  // covers it and a fetch would be redundant. Landing with `?tagId=` makes it
  // differ, so that case does fetch. Every render after that, "All" with no
  // filters means the user actively cleared everything and must refetch —
  // treating the default as "skip" unconditionally was the bug: clicking "All"
  // after another chip left whatever (possibly empty) results that chip had
  // fetched sitting in state, since nothing told it to reset.
  const isFirstEffectRun = useRef(true);
  useEffect(() => {
    if (isFirstEffectRun.current) {
      isFirstEffectRun.current = false;
      if (isServerRenderedSelection(selection)) return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(selection, null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
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
  }, [selection, fetchPage]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(selection, cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more markets");
    } finally {
      setLoading(false);
    }
  }

  const visibleItems = useMemo(() => {
    if (!query) return items;
    return items.filter((event) => event.title.toLowerCase().includes(query));
  }, [items, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <CategoryChip label="All" active={selection.tagId === null} onClick={() => select({ tagId: null })} />
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

      {query ? (
        <p className="text-xs text-zinc-500">
          Filtering {items.length} loaded market{items.length === 1 ? "" : "s"} for &ldquo;{query}&rdquo; — this
          searches what&apos;s currently on screen, not the full catalog yet.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>
      ) : null}

      {visibleItems.length === 0 && !loading ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center text-sm text-zinc-500">
          No markets match{query ? ` "${query}"` : " this filter"}.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map((event) => (
            <MarketCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {cursor && !query ? (
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
