import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getCachedEventBySlug } from "@/lib/polymarket/gamma";
import { MarketTradingSection } from "@/components/markets/market-trading-section";
import {
  MarketChartSection,
  MarketChartSkeleton,
} from "@/components/markets/market-chart-section";
import {
  MarketDiscussion,
  MarketDiscussionSkeleton,
} from "@/components/markets/market-discussion";
import { MarketRules } from "@/components/markets/market-rules";
import { MarketFaq } from "@/components/markets/market-faq";
import { formatUsd } from "@/lib/format";

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

  // Holders and trades are keyed by condition id, which lives on a market, not
  // the event. The first market is the right one for a binary event and the
  // representative one for a multi-outcome event — the same market the outcome
  // list opens on.
  const primaryMarket = event.markets?.[0];

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

      {/*
        The chart is passed *into* the trading section rather than rendered
        above it, so it sits in that grid's left column with the order ticket
        alongside at the same height — the reference layout. It keeps its own
        Suspense boundary: it waits on up to five CLOB calls, and the outcome
        list and ticket shouldn't be held back by them. `MarketChartSection`
        renders nothing at all when there's no history.
      */}
      <MarketTradingSection
        event={event}
        chart={
          <Suspense fallback={<MarketChartSkeleton />}>
            <MarketChartSection event={event} />
          </Suspense>
        }
        sections={
          <>
            {/* Rules and FAQ render from data already on this page — no fetch,
                so no Suspense boundary. The discussion block does fetch
                (comments, holders, trades), hence its own. */}
            <MarketRules event={event} market={primaryMarket} />
            <MarketFaq event={event} market={primaryMarket} />
            <Suspense fallback={<MarketDiscussionSkeleton />}>
              <MarketDiscussion event={event} market={primaryMarket} />
            </Suspense>
          </>
        }
      />
    </div>
  );
}

/**
 * Lowercase and prefixed, unlike the shared `formatEndDate` — this one reads
 * inline in a sentence ("$1.2M vol · ends Nov 3, 2026"), not as a card label.
 */
function formatEndDate(endDate: string | undefined): string {
  if (!endDate) return "no end date";
  const date = new Date(endDate);
  if (Number.isNaN(date.getTime())) return "no end date";
  if (date.getTime() < Date.now()) return "ended";
  return `ends ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}
