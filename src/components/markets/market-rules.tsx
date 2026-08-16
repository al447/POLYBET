"use client";

import { useState } from "react";

import { formatUsd } from "@/lib/format";
import { parseGammaJsonArray } from "@/lib/polymarket/gamma-types";
import type { GammaEvent, GammaMarket } from "@/lib/polymarket/gamma-types";

/**
 * Resolution criteria and the surrounding facts, as two tabs.
 *
 * **Rules** is Gamma's own `description` — the text that decides how the market
 * settles — plus the resolution source. It is quoted verbatim and never
 * summarised: this is the paragraph a user loses money to.
 *
 * **Market Context** is the metadata that changes how you read those rules:
 * size, liquidity, when it opened and closes, and whether UMA has already been
 * asked to resolve it. Gamma has no separate "context" document, so rather
 * than leave the tab empty or invent prose, it shows the facts we do hold.
 */

const COLLAPSED_CHARS = 320;

export function MarketRules({ event, market }: { event: GammaEvent; market?: GammaMarket }) {
  const [tab, setTab] = useState<"rules" | "context">("rules");

  // The market's own description is more specific than the event's when they
  // differ (an event bundles many markets); they're often identical.
  const rules = market?.description ?? event.description ?? "";

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-6 border-b border-zinc-800 px-5">
        <Tab active={tab === "rules"} onClick={() => setTab("rules")}>
          Rules
        </Tab>
        <Tab active={tab === "context"} onClick={() => setTab("context")}>
          Market Context
        </Tab>
      </div>

      <div className="p-5">
        {tab === "rules" ? (
          <RulesBody text={rules} event={event} market={market} />
        ) : (
          <ContextBody event={event} market={market} />
        )}
      </div>
    </section>
  );
}

function RulesBody({
  text,
  event,
  market,
}: {
  text: string;
  event: GammaEvent;
  market?: GammaMarket;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!text) {
    return <p className="text-sm text-zinc-500">No resolution rules published for this market.</p>;
  }

  const isLong = text.length > COLLAPSED_CHARS;
  const shown = expanded || !isLong ? text : `${text.slice(0, COLLAPSED_CHARS).trimEnd()}…`;
  const source = market?.resolutionSource || event.resolutionSource;

  return (
    <div>
      <p className="text-sm leading-relaxed whitespace-pre-line text-zinc-300">{shown}</p>

      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 text-sm font-semibold text-zinc-100 transition hover:text-emerald-300"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}

      {source ? (
        <p className="mt-4 border-t border-zinc-800/60 pt-3 text-xs text-zinc-500">
          Resolution source:{" "}
          <a
            href={source}
            target="_blank"
            rel="noreferrer noopener"
            className="text-emerald-400 underline underline-offset-2"
          >
            {source}
          </a>
        </p>
      ) : null}
    </div>
  );
}

function ContextBody({ event, market }: { event: GammaEvent; market?: GammaMarket }) {
  // `umaResolutionStatuses` is a JSON-encoded array like '["proposed"]' —
  // same Gamma string-array quirk as `outcomes`.
  const umaStatus = parseGammaJsonArray<string>(market?.umaResolutionStatuses)[0];

  const rows: { label: string; value: string }[] = [
    { label: "Total volume", value: formatUsd(event.volume) },
    { label: "Liquidity", value: formatUsd(event.liquidity) },
    { label: "Opened", value: formatDate(event.startDate) },
    { label: "Closes", value: formatDate(event.endDate) },
    { label: "Status", value: event.closed ? "Resolved" : "Open for trading" },
  ];

  if (umaStatus) {
    // Worth surfacing: once a resolution is proposed, the market is in its
    // dispute window and the price stops being a live probability.
    rows.push({ label: "UMA resolution", value: umaStatus });
  }

  const tags = (event.tags ?? []).map((tag) => tag.label ?? tag.slug).filter(Boolean);

  return (
    <div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 border-b border-zinc-800/60 py-2"
          >
            <dt className="text-sm text-zinc-500">{row.label}</dt>
            <dd className="text-sm font-medium text-zinc-200 tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      {tags.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-400"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <p className="mt-4 text-xs text-zinc-600">
        Markets are hosted on Polymarket. Prices shown here are periodic snapshots — the tradeable
        price is the one in the order ticket.
      </p>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`-mb-px border-b-2 py-3 text-sm font-semibold transition ${
        active
          ? "border-emerald-400 text-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
