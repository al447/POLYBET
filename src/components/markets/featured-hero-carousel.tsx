"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";

/**
 * The featured-market carousel.
 *
 * Takes fully-resolved slides as props and fetches nothing — every price
 * series, comment and formatted string is computed server-side in
 * `FeaturedHero`. That keeps ~169 points per series out of the RSC payload
 * (they arrive as one already-rendered SVG path) and keeps this component to
 * pure presentation.
 *
 * **No autoplay.** The reference design rotates on a timer; this doesn't. A
 * panel that moves on its own sits directly above a grid of links to
 * order-signing pages, so a mistimed slide turns a deliberate click into the
 * wrong market. It also fights screen readers and anyone reading slowly.
 */

export type HeroChartSeries = {
  /** Pre-rendered SVG path in the viewBox below. */
  path: string;
  label: string;
  /** Tailwind text-* class; the stroke reads `currentColor` off it. */
  colorClass: string;
};

export type HeroSlide = {
  id: string;
  slug: string;
  title: string;
  icon?: string;
  /** Tag labels, at most two — the "US Election · Elections" line. */
  categories: string[];
  outcomes: { label: string; pct: number | null }[];
  chart: {
    series: HeroChartSeries[];
    /**
     * The box the paths were generated against. Carried in the data rather
     * than shared as a constant: this is a `"use client"` module, and a Server
     * Component importing a runtime value across that boundary gets a client
     * reference, not the number.
     */
    width: number;
    height: number;
    /** Axis labels: high/low on the right, window ends underneath. */
    highLabel: string;
    lowLabel: string;
    startLabel: string;
    endLabel: string;
  } | null;
  comment: { name: string; body: string; ago: string; avatar?: string } | null;
  volume: string;
  ends: string;
};

export function FeaturedHeroCarousel({ slides }: { slides: HeroSlide[] }) {
  const [index, setIndex] = useState(0);

  const count = slides.length;
  const go = useCallback(
    (delta: number) => setIndex((current) => (current + delta + count) % count),
    [count],
  );

  useEffect(() => {
    if (count < 2) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (typing) return;

      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [go, count]);

  if (count === 0) return null;

  const slide = slides[index];
  const previous = slides[(index - 1 + count) % count];
  const next = slides[(index + 1) % count];

  return (
    <section aria-roledescription="carousel" aria-label="Featured markets">
      <div
        // `aria-live` announces the new slide when the user steps through it,
        // which is safe precisely because nothing advances on a timer.
        aria-live="polite"
        className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5"
      >
        <Slide slide={slide} />
      </div>

      {count > 1 ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {slides.map((item, dot) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setIndex(dot)}
                aria-label={`Show ${item.title}`}
                aria-current={dot === index}
                className={`h-1.5 rounded-full transition ${
                  dot === index ? "w-6 bg-emerald-400" : "w-1.5 bg-zinc-700 hover:bg-zinc-600"
                }`}
              />
            ))}
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <StepButton direction="previous" title={previous.title} onClick={() => go(-1)} />
            <StepButton direction="next" title={next.title} onClick={() => go(1)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Slide({ slide }: { slide: HeroSlide }) {
  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4 lg:w-2/5">
        <div>
          {slide.categories.length > 0 ? (
            <p className="mb-1.5 truncate text-xs font-medium text-emerald-400/90">
              {slide.categories.join(" · ")}
            </p>
          ) : null}

          <div className="flex items-start gap-3">
            {slide.icon ? (
              // `unoptimized` for the same reason as `MarketCard`: the image
              // transform pipeline is untested on this Workers/OpenNext setup.
              <Image
                src={slide.icon}
                alt=""
                width={44}
                height={44}
                className="size-11 shrink-0 rounded-lg object-cover"
                unoptimized
              />
            ) : null}
            <Link
              href={`/market/${slide.slug}`}
              className="text-xl font-semibold tracking-tight text-zinc-100 transition hover:text-emerald-300"
            >
              {slide.title}
            </Link>
          </div>
        </div>

        <ul className="flex flex-col">
          {slide.outcomes.map((outcome) => (
            <li
              key={outcome.label}
              className="flex items-center justify-between gap-3 border-b border-zinc-800/60 py-2.5 last:border-b-0"
            >
              <span className="truncate text-sm text-zinc-300">{outcome.label}</span>
              <span className="shrink-0 text-lg font-semibold text-zinc-100">
                {outcome.pct !== null ? `${outcome.pct}%` : "—"}
              </span>
            </li>
          ))}
        </ul>

        {slide.comment ? <Comment comment={slide.comment} /> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {slide.chart ? <Chart chart={slide.chart} /> : <ChartUnavailable />}

        <dl className="mt-3 flex items-center justify-between border-t border-zinc-800/60 pt-3 text-xs text-zinc-500">
          <div>
            <dt className="sr-only">Volume</dt>
            <dd>{slide.volume} Vol</dd>
          </div>
          <div>
            <dt className="sr-only">Ends</dt>
            <dd>
              {slide.ends} · <span className="text-zinc-600">Polymarket</span>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function Chart({ chart }: { chart: NonNullable<HeroSlide["chart"]> }) {
  return (
    <div className="flex min-w-0 flex-1 gap-2">
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {chart.series.map((series) => (
            <span key={series.label} className="flex items-center gap-1.5 text-xs text-zinc-400">
              <span className={`size-2 rounded-full bg-current ${series.colorClass}`} aria-hidden />
              <span className="truncate">{series.label}</span>
            </span>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Price over the last week: ${chart.series.map((s) => s.label).join(", ")}`}
          className="h-40 w-full"
        >
          {chart.series.map((series) => (
            <path
              key={series.label}
              d={series.path}
              fill="none"
              // `vectorEffect` keeps the stroke 2px after the non-uniform
              // scaling that `preserveAspectRatio="none"` applies.
              vectorEffect="non-scaling-stroke"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className={series.colorClass}
              stroke="currentColor"
            />
          ))}
        </svg>

        <div className="mt-1 flex justify-between text-[11px] text-zinc-600">
          <span>{chart.startLabel}</span>
          <span>{chart.endLabel}</span>
        </div>
      </div>

      <div className="flex shrink-0 flex-col justify-between py-6 text-[11px] text-zinc-600">
        <span>{chart.highLabel}</span>
        <span>{chart.lowLabel}</span>
      </div>
    </div>
  );
}

function ChartUnavailable() {
  return (
    <div className="flex h-40 flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-600">
      No price history for this market yet
    </div>
  );
}

function Comment({ comment }: { comment: NonNullable<HeroSlide["comment"]> }) {
  return (
    <div className="flex items-start gap-2.5 border-t border-zinc-800/60 pt-3">
      {comment.avatar ? (
        <Image
          src={comment.avatar}
          alt=""
          width={24}
          height={24}
          className="size-6 shrink-0 rounded-full object-cover"
          unoptimized
        />
      ) : (
        <div className="size-6 shrink-0 rounded-full bg-zinc-800" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="text-xs text-zinc-500">
          {comment.name} · {comment.ago}
        </p>
        <p className="line-clamp-2 text-sm text-zinc-300">{comment.body}</p>
      </div>
    </div>
  );
}

function StepButton({
  direction,
  title,
  onClick,
}: {
  direction: "previous" | "next";
  title: string;
  onClick: () => void;
}) {
  const isNext = direction === "next";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${isNext ? "Next" : "Previous"} featured market: ${title}`}
      className="flex min-w-0 max-w-44 items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-100"
    >
      {isNext ? null : <ChevronLeftIcon className="size-3.5 shrink-0" />}
      <span className="truncate">{title}</span>
      {isNext ? <ChevronRightIcon className="size-3.5 shrink-0" /> : null}
    </button>
  );
}
