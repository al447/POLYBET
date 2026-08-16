"use client";

import Image from "next/image";
import { useState } from "react";

import { formatUsd } from "@/lib/format";
import { MarketPositionsTab } from "@/components/markets/market-positions-tab";

/**
 * Comments / Top Holders / Positions / Activity.
 *
 * The first, second and fourth tabs arrive fully resolved from
 * `MarketDiscussion` — no fetching here, so switching between them is instant.
 * "Positions" is the exception and owns its own loading, because it is the
 * viewer's own data and needs a wallet connection to read.
 *
 * Comments are **read-only**. Posting would need a Polymarket account we don't
 * hold and a moderation story we haven't designed, so there is no composer:
 * showing one that rejects every submission would be worse than not having it.
 */

export type CommentView = {
  id: string;
  body: string;
  name: string;
  avatar?: string;
  ago: string;
  reactions: number;
};

export type HolderView = {
  address: string;
  name: string;
  avatar?: string;
  shares: number;
  outcomeLabel: string;
};

export type TradeView = {
  key: string;
  name: string;
  avatar?: string;
  side: "BUY" | "SELL";
  outcome: string;
  shares: number;
  price: number;
  ago: string;
};

type TabId = "comments" | "holders" | "positions" | "activity";

export function MarketDiscussionTabs({
  eventSlug,
  comments,
  holders,
  trades,
}: {
  eventSlug: string;
  comments: CommentView[];
  holders: HolderView[];
  trades: TradeView[];
}) {
  const [tab, setTab] = useState<TabId>("comments");

  const tabs: { id: TabId; label: string }[] = [
    { id: "comments", label: comments.length > 0 ? `Comments (${comments.length})` : "Comments" },
    { id: "holders", label: "Top Holders" },
    { id: "positions", label: "Positions" },
    { id: "activity", label: "Activity" },
  ];

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-6 overflow-x-auto border-b border-zinc-800 px-5">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-pressed={tab === entry.id}
            className={`-mb-px shrink-0 border-b-2 py-3 text-sm font-semibold whitespace-nowrap transition ${
              tab === entry.id
                ? "border-emerald-400 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="p-5">
        {tab === "comments" ? <CommentsTab comments={comments} /> : null}
        {tab === "holders" ? <HoldersTab holders={holders} /> : null}
        {tab === "positions" ? <MarketPositionsTab eventSlug={eventSlug} /> : null}
        {tab === "activity" ? <ActivityTab trades={trades} /> : null}
      </div>
    </section>
  );
}

function CommentsTab({ comments }: { comments: CommentView[] }) {
  if (comments.length === 0) {
    return <Empty>No comments on this market yet.</Empty>;
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-800/60">
      {comments.map((comment) => (
        <li key={comment.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
          <Avatar src={comment.avatar} alt="" size={32} />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-500">
              <span className="font-medium text-zinc-400">{comment.name}</span>
              {comment.ago ? ` · ${comment.ago}` : null}
            </p>
            <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-line text-zinc-300">
              {comment.body}
            </p>
          </div>
          {comment.reactions > 0 ? (
            <span className="shrink-0 text-xs text-zinc-600 tabular-nums">♥ {comment.reactions}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function HoldersTab({ holders }: { holders: HolderView[] }) {
  if (holders.length === 0) {
    return <Empty>No holder data available for this market.</Empty>;
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-800/60">
      {holders.map((holder, rank) => (
        <li key={`${holder.address}-${holder.outcomeLabel}`} className="flex items-center gap-3 py-2.5">
          <span className="w-5 shrink-0 text-xs text-zinc-600 tabular-nums">{rank + 1}</span>
          <Avatar src={holder.avatar} alt="" size={28} />
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{holder.name}</span>
          <span className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-xs text-zinc-400">
            {holder.outcomeLabel}
          </span>
          <span className="w-24 shrink-0 text-right text-sm font-medium text-zinc-200 tabular-nums">
            {formatShares(holder.shares)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActivityTab({ trades }: { trades: TradeView[] }) {
  if (trades.length === 0) {
    return <Empty>No trades on this market yet.</Empty>;
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-800/60">
      {trades.map((trade) => (
        <li key={trade.key} className="flex items-center gap-3 py-2.5">
          <Avatar src={trade.avatar} alt="" size={28} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-zinc-300">
              <span className="text-zinc-400">{trade.name}</span>{" "}
              <span className={trade.side === "BUY" ? "text-emerald-400" : "text-red-400"}>
                {trade.side === "BUY" ? "bought" : "sold"}
              </span>{" "}
              {formatShares(trade.shares)} {trade.outcome}
            </p>
            <p className="text-xs text-zinc-600">{trade.ago}</p>
          </div>
          <span className="shrink-0 text-sm font-medium text-zinc-200 tabular-nums">
            {(trade.price * 100).toFixed(1)}¢
          </span>
          <span className="w-20 shrink-0 text-right text-xs text-zinc-500 tabular-nums">
            {formatUsd(trade.shares * trade.price)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Avatar({ src, alt, size }: { src?: string; alt: string; size: number }) {
  if (!src) {
    return (
      <div
        aria-hidden
        className="shrink-0 rounded-full bg-zinc-800"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      // Same reasoning as `MarketCard`: the transform pipeline is untested on
      // this Workers/OpenNext setup and these are hundreds of distinct avatars.
      unoptimized
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
}

/** Share counts, not dollars — 12,450 shares reads better than 12450. */
function formatShares(shares: number): string {
  if (!Number.isFinite(shares)) return "—";
  if (shares >= 1_000_000) return `${(shares / 1_000_000).toFixed(1)}M`;
  if (shares >= 1_000) return `${(shares / 1_000).toFixed(1)}K`;
  return shares.toFixed(shares < 10 ? 2 : 0);
}
