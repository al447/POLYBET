import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { withBudget } from "@/lib/budget";
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
 *
 * 🚩 The event fetch is awaited HERE, before anything streams, and it must stay
 * that way. Moving it into a <Suspense> boundary was tried on 2026-08-23 and
 * reverted the same hour: the response is `Transfer-Encoding: chunked`, so the
 * status line is flushed with the shell, and a `notFound()` that resolves later
 * cannot change it. Measured — a nonexistent slug rendered the correct 404 UI
 * under an HTTP **200**. This site is actively probed by scanners (see
 * improvement.md Trap 1); answering 200 to every `/market/<garbage>` is worse
 * than a slightly later first paint.
 *
 * What DID have to change is the bound. Until the same day this await had no
 * ceiling at all, so a slow cache rebuild held the whole page open to the 100s
 * edge timeout — which is why `/market/*` was 13 of the 15 paths 504ing in the
 * window after a deploy (a deploy re-keys the entire R2 cache, so the first
 * visitor to each slug pays the rebuild inline). `withBudget` is the fix; the
 * Suspense split was a first-paint nicety that cost correctness.
 */
/**
 * Hard ceiling on the event fetch. Rationale for bounding the whole operation
 * rather than its parts is on `withBudget` in `lib/budget.ts`. 8s is well past
 * a healthy render (1.6-2.6s measured, warm or cold) and far under the ~100s
 * edge timeout.
 */
const MARKET_BUDGET_MS = 8000;

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let result: { event: Awaited<ReturnType<typeof getCachedEventBySlug>> } | null;
  try {
    // 🚩 The `.then()` wrapper is load-bearing, not style. `getCachedEventBySlug`
    // already returns `null` for a genuine 404, so racing it directly would make
    // "slow" and "no such market" indistinguishable — and a slow rebuild would
    // render a 404 page for a market that exists. Boxing the result means only
    // the *outer* null can mean "out of time".
    result = await withBudget(
      getCachedEventBySlug(slug).then((event) => ({ event })),
      MARKET_BUDGET_MS,
    );
  } catch (error) {
    return (
      <Notice tone="error">
        Couldn&apos;t load this market right now (
        {error instanceof Error ? error.message : "unknown error"}). Try refreshing.
      </Notice>
    );
  }

  // Three distinct outcomes, deliberately: Gamma errored (above), we ran out of
  // time (here), or the market genuinely does not exist (below). Collapsing the
  // middle one into either of the others is how a transient slow rebuild starts
  // looking like a permanently missing market.
  if (result === null) {
    return (
      <Notice tone="slow">
        This market is taking longer than usual to load. Refresh to try again.
      </Notice>
    );
  }

  const event = result.event;
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

      {/* `mb-6` matches the gap between the chart and the outcome list below,
          so the header sits in the same rhythm now that it's flush to the chart. */}
      <header className="mt-4 mb-6 flex items-start gap-5">
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

      {/*
        No description block here any more. It's the same prose the Rules tab
        renders further down (`MarketRules` reads `market.description ??
        event.description`), and at full length — the Fed market's runs to
        seven paragraphs — it pushed the chart and the order ticket below the
        fold. Nothing is lost by dropping it: Rules is where a reader looks for
        resolution criteria, and it has the "Show more" affordance this didn't.
      */}

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
 * Full-page message for the two non-render outcomes.
 *
 * `error` is red because something broke and refreshing may not help; `slow` is
 * amber because nothing is wrong — the cache is cold and a retry very likely
 * works. Keeping them visually distinct matters more than it looks: a cold
 * rebuild after a deploy is routine, and dressing it as an error trains people
 * to ignore the real one.
 */
function Notice({ tone, children }: { tone: "error" | "slow"; children: React.ReactNode }) {
  const styles =
    tone === "error"
      ? "border-red-900/50 bg-red-950/30 text-red-300"
      : "border-amber-500/30 bg-amber-500/10 text-amber-200";

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-12">
      <p className={`rounded-lg border px-4 py-6 text-center text-sm ${styles}`}>{children}</p>
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
