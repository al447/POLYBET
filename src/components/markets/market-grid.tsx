"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { MarketCard } from "@/components/markets/market-card";
import type { GammaEvent, GammaTag } from "@/lib/polymarket/gamma-types";

/**
 * Interactive discovery grid (FR-2.1, FR-2.2, FR-2.4).
 *
 * Client component so category chips and "Load more" can update in place —
 * everything it fetches after the first paint goes through `/api/markets`
 * (never Gamma directly, per implementation.md Step 2.2). The server-rendered
 * `initialEvents` avoid a redundant client-side fetch on first load.
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
  const [selectedTagId, setSelectedTagId] = useState<number | null>(
    initialTagId ? Number(initialTagId) : null,
  );
  const [items, setItems] = useState<GammaEvent[]>(initialEvents);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = (searchParams.get("q") ?? "").trim().toLowerCase();

  const fetchPage = useCallback(async (tagId: number | null, cursorParam: string | null) => {
    const search = new URLSearchParams();
    search.set("limit", "24");
    if (tagId !== null) search.set("tagId", String(tagId));
    if (cursorParam) search.set("cursor", cursorParam);

    const response = await fetch(`/api/markets?${search.toString()}`);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : null;
      throw new Error(message ?? `Request failed (${response.status})`);
    }
    return (await response.json()) as { items: GammaEvent[]; nextCursor: string | null };
  }, []);

  // Re-fetch whenever the category changes — including back to "All"
  // (tagId null). Only the very first render is special-cased: if it landed
  // with no `?tagId=`, `initialEvents` (server-fetched, unfiltered) already
  // covers it and a fetch would be redundant. Every render after that,
  // `selectedTagId === null` means the user actively clicked "All" and must
  // refetch — treating null as "skip" unconditionally was the bug: clicking
  // "All" after another chip left whatever (possibly empty) results that
  // chip had fetched sitting in state, since nothing told it to reset.
  const isFirstEffectRun = useRef(true);
  useEffect(() => {
    if (isFirstEffectRun.current) {
      isFirstEffectRun.current = false;
      if (selectedTagId === null) return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(selectedTagId, null)
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
  }, [selectedTagId, fetchPage]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(selectedTagId, cursor);
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
        <CategoryChip label="All" active={selectedTagId === null} onClick={() => setSelectedTagId(null)} />
        {tags.map((tag) => (
          <CategoryChip
            key={tag.id}
            label={tag.label ?? tag.slug ?? tag.id}
            active={selectedTagId === Number(tag.id)}
            onClick={() => setSelectedTagId(Number(tag.id))}
          />
        ))}
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
