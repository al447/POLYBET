"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { MarketCard } from "@/components/markets/market-card";
import {
  DEFAULT_FILTER_ID,
  DEFAULT_SORT_ID,
  ENDING_FILTERS,
  EVENT_SORTS,
  LIQUIDITY_FILTERS,
  VOLUME_FILTERS,
  resolveEndingFilter,
  resolveLiquidityFilter,
  resolveSort,
  resolveVolumeFilter,
} from "@/lib/polymarket/gamma-types";
import type {
  EndingFilterId,
  EventSortId,
  GammaEvent,
  LiquidityFilterId,
  VolumeFilterId,
} from "@/lib/polymarket/gamma-types";

/**
 * Ceiling on a call to our own `/api/markets*` routes.
 *
 * 8s rather than something tighter because those routes sit above `gammaFetch`,
 * whose own deadline is 6s — a shorter bound here would report a generic timeout
 * for a request that was a beat away from returning Gamma's real error message.
 */
const REQUEST_TIMEOUT_MS = 8000;

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
 *
 * Category selection is NOT here any more — it's the nav bar's second row
 * (`NavCategories`), which lives in the root layout and so cannot share React
 * state with this component. The query string is the one thing both can see,
 * which is why the whole selection is read from and written to the URL below.
 */
export function MarketGrid({
  initialEvents,
  initialCursor,
}: {
  /**
   * The server-rendered first page, or `null` when the server ran out of time
   * building it (see `DISCOVERY_BUDGET_MS` in `discovery-section.tsx`).
   *
   * 🚩 `null` and `[]` mean different things and must stay distinguishable.
   * `[]` is "Gamma returned no events", a finished answer. `null` is "no answer
   * yet, fetch it yourself" — and the first-render skip below has to be turned
   * off for it, or the grid renders empty forever.
   */
  initialEvents: GammaEvent[] | null;
  initialCursor: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read as individual primitives, not as one `searchParams` object: the memo
  // below — and the fetch effect keyed on it — must only refire when a value
  // genuinely changed, and `useSearchParams()` returns a new instance on every
  // navigation. Each `resolve*` helper falls back to the default on absent or
  // junk input, so a hand-typed `?sort=banana` degrades to "Top" rather than
  // sending nonsense to Gamma.
  const tagIdParam = searchParams.get("tagId");
  const sortParam = searchParams.get("sort");
  const volumeParam = searchParams.get("volume");
  const liquidityParam = searchParams.get("liquidity");
  const endingParam = searchParams.get("ending");

  const selection = useMemo<GridSelection>(() => {
    const parsedTagId = tagIdParam ? Number(tagIdParam) : Number.NaN;
    return {
      tagId: Number.isFinite(parsedTagId) ? parsedTagId : null,
      sort: resolveSort(sortParam).id,
      volume: resolveVolumeFilter(volumeParam).id,
      liquidity: resolveLiquidityFilter(liquidityParam).id,
      ending: resolveEndingFilter(endingParam).id,
    };
  }, [tagIdParam, sortParam, volumeParam, liquidityParam, endingParam]);

  const [results, setResults] = useState<Results>({
    items: initialEvents ?? [],
    cursor: initialCursor,
    page: 1,
    hasMore: initialCursor !== null,
    totalResults: null,
  });
  const [loading, setLoading] = useState(false);
  /**
   * Two error slots, because the two failures belong in different places.
   *
   * `error` is "the grid itself failed" and renders at the top, next to the
   * chips that triggered it. `pageError` is "Load more failed" and renders at
   * the button — 🚩 a single slot put it above the card grid, which is a screen
   * or more out of view from the button the user just pressed, so a failed
   * pagination looked like a button that did nothing at all.
   */
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const query = (searchParams.get("q") ?? "").trim();
  const isSearching = query.length > 0;

  // Writes the URL rather than local state, so the nav bar's tabs and these
  // chips are the same control by two routes. Defaults are deleted rather than
  // written, which keeps a fully-cleared grid at a bare `/` — the same shape
  // `isServerRenderedSelection` matches, so clearing everything still skips
  // the redundant first fetch.
  const select = useCallback(
    (patch: Partial<GridSelection>) => {
      const next = { ...selection, ...patch };
      const params = new URLSearchParams(searchParams.toString());

      setParam(
        params,
        "tagId",
        next.tagId === null ? null : String(next.tagId),
      );
      setParam(
        params,
        "sort",
        next.sort === DEFAULT_SORT_ID ? null : next.sort,
      );
      setParam(
        params,
        "volume",
        next.volume === DEFAULT_FILTER_ID ? null : next.volume,
      );
      setParam(
        params,
        "liquidity",
        next.liquidity === DEFAULT_FILTER_ID ? null : next.liquidity,
      );
      setParam(
        params,
        "ending",
        next.ending === DEFAULT_FILTER_ID ? null : next.ending,
      );

      // Not named `query` — that's the search term a few lines up.
      const queryString = params.toString();
      router.replace(queryString ? `/?${queryString}` : "/", { scroll: false });
    },
    [router, searchParams, selection],
  );

  // 🚩 The whole selection goes on every request, paginated or not. Gamma
  // binds a keyset cursor to the sort that produced it and 422s on a mismatch,
  // so "Load more" has to ask for page 2 under exactly what fetched page 1.
  const fetchBrowsePage = useCallback(
    async (current: GridSelection, cursor: string | null) => {
      const params = new URLSearchParams();
      params.set("limit", "24");
      params.set("sort", current.sort);
      if (current.tagId !== null) params.set("tagId", String(current.tagId));
      if (current.volume !== DEFAULT_FILTER_ID)
        params.set("volume", current.volume);
      if (current.liquidity !== DEFAULT_FILTER_ID)
        params.set("liquidity", current.liquidity);
      if (current.ending !== DEFAULT_FILTER_ID)
        params.set("ending", current.ending);
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
    },
    [],
  );

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
  // Captured once at mount rather than read from the prop inside the effect:
  // the skip is a statement about what the *first* render was handed, and the
  // effect must not re-decide it later. `null` means the server timed out and
  // sent nothing, so there is no initial page to be redundant with — that case
  // has to fetch even though the selection is the default one.
  const hadServerData = useRef(initialEvents !== null);
  useEffect(() => {
    if (isFirstEffectRun.current) {
      isFirstEffectRun.current = false;
      if (
        hadServerData.current &&
        !isSearching &&
        isServerRenderedSelection(selection)
      )
        return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    // The selection changed, so we're back to page 1 — a pagination error from
    // the previous selection describes a request nobody will retry.
    setPageError(null);

    const request = isSearching
      ? fetchSearchPage(query, 1)
      : fetchBrowsePage(selection, null);

    request
      .then((page) => {
        if (!cancelled) setResults(page);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load markets",
          );
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
    setPageError(null);
    try {
      const next = isSearching
        ? await fetchSearchPage(query, results.page + 1)
        : await fetchBrowsePage(selection, results.cursor);

      // Append, but keep the *new* pagination state — `next.items` is only
      // this page's worth.
      setResults((prev) => ({
        ...next,
        items: [...prev.items, ...next.items],
      }));
    } catch (err) {
      setPageError(
        err instanceof Error ? err.message : "Failed to load more markets",
      );
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
              <span className="text-zinc-200">
                {results.totalResults?.toLocaleString() ?? "—"}
              </span>{" "}
              result
              {results.totalResults === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
            </>
          )}
        </p>
      ) : (
        // Category chips moved to the nav bar's second row. What's left are the
        // sort and range filters, which have no home up there.
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
      )}

      {error ? (
        <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
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

      {/*
        Grouped with the button rather than placed near the top: this is the
        one error the user is looking straight at when it happens, and the
        button on its own re-enabling reads as "nothing happened".
      */}
      {results.hasMore ? (
        <div className="flex flex-col items-center gap-3">
          {pageError ? (
            <p
              role="status"
              className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-center text-sm text-red-300"
            >
              {pageError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Loading…" : pageError ? "Try again" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Sets a query param, or removes it entirely when the value is the default. */
function setParam(params: URLSearchParams, key: string, value: string | null) {
  if (value === null) params.delete(key);
  else params.set(key, value);
}

/**
 * Fetches JSON, surfacing the route's own `error` message when there is one.
 *
 * The timeout covers the body read as well as the response, which is why the
 * whole thing sits in one `try` — aborting the request errors the body stream
 * too, so a `response.json()` left outside would reject with a raw
 * `AbortError` the callers would render verbatim.
 */
async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : null;
      throw new Error(message ?? `Request failed (${response.status})`);
    }
    return await response.json();
  } catch (err) {
    // `AbortSignal.timeout` rejects with a `TimeoutError`; a manual
    // `controller.abort()` would be an `AbortError`. Only the first is the
    // user's problem — the second means we walked away from the request.
    // No "try again" in the wording: on the pagination path the button beside
    // this message already says exactly that.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error("This is taking longer than expected.");
    }
    throw err;
  }
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

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
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
