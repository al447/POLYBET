import { formatUsd } from "@/lib/format";
import { rankEventOutcomes } from "@/lib/polymarket/gamma-types";
import type { GammaEvent, GammaMarket } from "@/lib/polymarket/gamma-types";

/**
 * Frequently asked questions for a market.
 *
 * Generated from the event's own data rather than authored per market — there
 * are tens of thousands of markets, and the five questions people actually ask
 * are the same five every time. Every answer is derived from data on the page,
 * so nothing here can drift from what the rest of the page says.
 *
 * Built on `<details>/<summary>`, so it expands with **no JavaScript** and no
 * `"use client"`: native disclosure widgets are keyboard-accessible and
 * screen-reader-correct for free, and this is a block of static prose that
 * would otherwise cost the bundle a client component for the sake of a chevron.
 */
export function MarketFaq({ event, market }: { event: GammaEvent; market?: GammaMarket }) {
  const ranked = rankEventOutcomes(event);
  const leader = ranked[0];
  const source = market?.resolutionSource || event.resolutionSource;

  const odds =
    ranked.length > 0
      ? ranked
          .slice(0, 3)
          .map((outcome) => `${outcome.label} at ${outcome.pct !== null ? `${outcome.pct}%` : "—"}`)
          .join(", ")
      : null;

  const faqs: { question: string; answer: string }[] = [
    {
      question: `What is the “${event.title}” prediction market?`,
      answer:
        (market?.description ?? event.description ?? "").trim() ||
        `“${event.title}” is a prediction market hosted on Polymarket. You buy shares in an outcome; if it happens, each share settles at $1.`,
    },
    {
      question: `How much trading activity has “${event.title}” generated?`,
      answer: `${formatUsd(event.volume)} has traded on this market in total, with ${formatUsd(
        event.liquidity,
      )} of liquidity currently in the order book.`,
    },
    {
      question: `How do I trade on “${event.title}”?`,
      answer:
        "Sign in, add funds to your deposit wallet, then pick an outcome and use the order ticket. " +
        "Orders are signed in your browser by your own wallet — we never take custody of your funds, " +
        "and a builder fee is shown in the ticket before you commit.",
    },
    {
      question: `What are the current odds for “${event.title}”?`,
      answer: odds
        ? `${odds}. These are snapshot prices from the last cache refresh, so treat the order ticket as the live number.`
        : "No priced outcomes are available for this market right now.",
    },
    {
      question: `How will “${event.title}” be resolved?`,
      answer:
        (leader
          ? `The market settles once the outcome is known${
              event.endDate ? `, on or around ${formatDate(event.endDate)}` : ""
            }. `
          : "") +
        (source
          ? `Resolution follows ${source}, verified through UMA's optimistic oracle.`
          : "Resolution is verified through UMA's optimistic oracle, per the rules above."),
    },
  ];

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-zinc-100">
        Frequently Asked Questions
      </h2>

      <div className="divide-y divide-zinc-800/60">
        {faqs.map((faq) => (
          <details key={faq.question} className="group py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-zinc-200 transition hover:text-zinc-50">
              {faq.question}
              {/* Rotated by the open state — no state, no handler. */}
              <span
                aria-hidden
                className="shrink-0 text-zinc-600 transition group-open:rotate-180"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-4">
                  <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </summary>
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-zinc-400">
              {faq.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "its close date";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}
