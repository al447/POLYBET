"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { PaginationCursor } from "@polymarket/bindings";
import type { Activity } from "@polymarket/bindings/data";

import { describeActivityList, fetchActivityPage, type ActivityEntry } from "@/lib/polymarket/activity";
import type { BrowserClient } from "@/lib/polymarket/browser-client";
import { Card } from "@/components/ui/primitives";

/**
 * Trade history (FR-4.4).
 *
 * Cursor-paginated with an explicit "Load more" rather than infinite scroll —
 * a ledger is something people scan for a specific entry and then stop, so a
 * feed that keeps growing under the scrollbar fights that rather than helping.
 * It also keeps the page's end reachable, which matters on mobile (NFR-4).
 *
 * Raw `Activity[]` is what lives in state; the flattened rows are derived on
 * render. That ordering matters — `describeActivityList` assigns keys with an
 * occurrence counter over the *whole* list (rows sharing a transaction hash are
 * otherwise indistinguishable, since `Activity` has no id), so appending a page
 * has to re-key everything. Keeping the raw items is what makes that possible;
 * describing eagerly and re-describing later would silently mangle the rows.
 *
 * Refetches from scratch when `revision` changes — the user-channel counter
 * from `useUserChannel` (Step 3.7). A fill event says "your cached reads are
 * stale", never what the new values are, so a fresh first page is the only
 * correct response. Accumulated later pages are dropped on purpose: splicing a
 * new row into the middle of a paginated feed whose cursor has already moved is
 * a good way to render duplicates.
 */
export function ActivityList({ client, revision }: { client: BrowserClient; revision: number }) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [cursor, setCursor] = useState<PaginationCursor | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = useCallback(async (active: BrowserClient) => {
    try {
      const page = await fetchActivityPage(active);
      setActivities(page.items);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore && page.nextCursor !== undefined);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your activity.");
    }
  }, []);

  useEffect(() => {
    async function run(active: BrowserClient) {
      await loadFirstPage(active);
    }
    void run(client);
  }, [client, revision, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchActivityPage(client, cursor);
      setActivities((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore && page.nextCursor !== undefined);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load more activity.");
    } finally {
      setLoadingMore(false);
    }
  }, [client, cursor]);

  if (activities === null && error === null) {
    return (
      <Card title="Activity">
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 rounded-lg bg-zinc-900/60" />
          ))}
        </div>
      </Card>
    );
  }

  if (activities === null) {
    return (
      <Card title="Activity">
        <p className="text-sm text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => void loadFirstPage(client)}
          className="mt-2 text-sm font-semibold text-zinc-400 underline underline-offset-2 transition hover:text-zinc-200"
        >
          Try again
        </button>
      </Card>
    );
  }

  if (activities.length === 0) {
    return (
      <Card title="Activity">
        <p className="text-sm text-zinc-500">
          Nothing here yet. Trades, redemptions and rewards will appear as they happen.
        </p>
      </Card>
    );
  }

  const entries = describeActivityList(activities);

  return (
    <Card title="Activity">
      <ul className="divide-y divide-zinc-800">
        {entries.map((entry) => (
          <ActivityRow key={entry.key} entry={entry} />
        ))}
      </ul>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-4 w-full rounded-lg border border-zinc-800 py-2 text-xs font-semibold text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-wait disabled:opacity-60"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </Card>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const body = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {entry.icon ? (
        <Image
          src={entry.icon}
          alt=""
          width={28}
          height={28}
          className="size-7 shrink-0 rounded-full object-cover"
          unoptimized
        />
      ) : (
        <div className="size-7 shrink-0 rounded-full bg-zinc-800" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm text-zinc-200">
          <span className={`font-semibold ${labelColor(entry)}`}>{entry.label}</span>
          {entry.outcome ? <span className="text-zinc-400"> {entry.outcome}</span> : null}
          {entry.title ? <span className="text-zinc-500"> · {entry.title}</span> : null}
        </p>
        <p className="mt-0.5 truncate text-xs text-zinc-600">
          {entry.shares !== null && entry.price !== null
            ? `${entry.shares.toFixed(2)} shares @ ${(entry.price * 100).toFixed(1)}¢ · `
            : ""}
          {formatTime(entry.timestamp)}
        </p>
      </div>
    </div>
  );

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      {/* By eventSlug, not slug — the detail route resolves event slugs. Combo trades and account credits have none and render unlinked. */}
      {entry.eventSlug ? (
        <Link href={`/market/${entry.eventSlug}`} className="flex min-w-0 flex-1">
          {body}
        </Link>
      ) : (
        body
      )}
      <span className={`shrink-0 text-sm tabular-nums ${amountColor(entry.direction)}`}>
        {entry.direction === "in" ? "+" : entry.direction === "out" ? "−" : ""}$
        {entry.amount.toFixed(2)}
      </span>
    </li>
  );
}

function labelColor(entry: ActivityEntry): string {
  if (entry.kind === "credit") return "text-sky-400";
  if (entry.side === "BUY") return "text-emerald-400";
  if (entry.side === "SELL") return "text-red-400";
  return "text-zinc-300";
}

function amountColor(direction: ActivityEntry["direction"]): string {
  return direction === "in" ? "text-emerald-400" : "text-zinc-400";
}

/**
 * Absolute date, not "3 hours ago". Relative timestamps need a re-render to
 * stay true and read as approximate — on a financial ledger the exact moment is
 * the point, and it's what reconciles against a block explorer.
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
