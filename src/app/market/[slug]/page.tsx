import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getCachedEventBySlug } from "@/lib/polymarket/gamma";
import { MarketTradingSection } from "@/components/markets/market-trading-section";

/**
 * Market detail page (FR-2.1, implementation.md Step 2.4) — added 2026-08-07
 * once trading existed to put on it, redesigned same day into a two-column
 * layout (`MarketTradingSection`) matching Polymarket's own event pages —
 * outcome list + sticky trading panel — after a direct request to match
 * that reference rather than the earlier single-button-per-row modal design.
 *
 * Keyed by *event* slug, not a single market's slug — an event can bundle
 * many binary markets (e.g. one per candidate), and this page needs all of
 * them to render the outcome list.
 */
export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let event;
  try {
    event = await getCachedEventBySlug(slug);
  } catch (error) {
    return (
      <div className="mx-auto w-full max-w-7xl px-6 py-12">
        <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-6 text-center text-sm text-red-300">
          Couldn&apos;t load this market right now (
          {error instanceof Error ? error.message : "unknown error"}). Try refreshing.
        </p>
      </div>
    );
  }

  if (!event) notFound();

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <Link href="/" className="text-sm text-zinc-500 transition hover:text-zinc-300">
        ← Back to markets
      </Link>

      <header className="mt-4 mb-8 flex items-start gap-5">
        {event.icon ? (
          <Image
            src={event.icon}
            alt=""
            width={72}
            height={72}
            className="size-[72px] shrink-0 rounded-xl object-cover"
            unoptimized
          />
        ) : (
          <div className="size-[72px] shrink-0 rounded-xl bg-zinc-800" aria-hidden />
        )}
        <div className="min-w-0">
          <h1 className="text-3xl font-bold text-zinc-100">{event.title}</h1>
          <p className="mt-2 text-sm text-zinc-500">
            {formatUsd(event.volume)} volume · {event.closed ? "Closed" : formatEndDate(event.endDate)}
            {" · "}
            <a
              href={`https://polymarket.com/event/${event.slug}`}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-600 transition hover:text-zinc-400"
            >
              View on polymarket.com ↗
            </a>
          </p>
        </div>
      </header>

      {event.description ? (
        <p className="mb-8 max-w-2xl text-base whitespace-pre-line text-zinc-400">{event.description}</p>
      ) : null}

      <MarketTradingSection event={event} />
    </div>
  );
}

function formatUsd(value: number | string | undefined): string {
  const num = typeof value === "string" ? Number(value) : value;
  if (!num || !Number.isFinite(num)) return "$0";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

function formatEndDate(endDate: string | undefined): string {
  if (!endDate) return "no end date";
  const date = new Date(endDate);
  if (Number.isNaN(date.getTime())) return "no end date";
  if (date.getTime() < Date.now()) return "ended";
  return `ends ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}
