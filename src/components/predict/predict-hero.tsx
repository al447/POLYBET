import { SparkleIcon } from "@/components/ui/icons";
import { FIXTURE_WINDOW_DAYS } from "@/lib/polymarket/fixtures-types";

/**
 * Banner at the top of the Predict AI page.
 *
 * Amber rather than the app's usual blue/emerald: that is already Predict AI's
 * accent in `RightSidebar`'s promo card, and `icons.tsx` reserves `SparkleIcon`
 * for this feature. Keeping them consistent means the promo card and the page
 * it links to read as the same thing.
 *
 * 🚩 The market-type pills are honest about a real gap. Match result is live —
 * it is what the board below shows. Over/Under, Both teams to score and Correct
 * score all exist on Gamma as separate events per fixture (`totals`,
 * `soccer_exact_score`, ...) but we do not fetch them yet, so they render muted
 * with a "Coming soon" tooltip. Same convention as `MenuItemInert`: advertising
 * the roadmap is fine, implying a market type is covered when it isn't is not.
 */

/** What the model will eventually forecast. Only the first is wired to anything. */
const MARKET_TYPES = [
  { label: "Match result", live: true },
  { label: "Over/Under 2.5", live: false },
  { label: "Both teams to score", live: false },
  { label: "Correct score", live: false },
];

export function PredictHero({
  matchCount,
  leagueCount,
}: {
  /** Omitted while the fixtures are still loading — the stats render as dashes. */
  matchCount?: number;
  leagueCount?: number;
}) {
  return (
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 sm:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-center gap-2.5">
            <span className="text-amber-400">
              <SparkleIcon className="size-6" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Predict AI</h1>
          </div>

          <p className="mt-3 text-sm text-zinc-400">
            Upcoming football matches, shown next to what the market is pricing for each
            result.
          </p>

          <ul className="mt-5 flex flex-wrap gap-2">
            {MARKET_TYPES.map((type) => (
              <li key={type.label}>
                <span
                  title={type.live ? undefined : "Coming soon"}
                  aria-disabled={type.live ? undefined : true}
                  className={`inline-block rounded-full border px-3 py-1.5 text-xs font-medium ${
                    type.live
                      ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                      : "cursor-default border-zinc-800 bg-zinc-900/40 text-zinc-600"
                  }`}
                >
                  {type.label}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <dl className="grid shrink-0 grid-cols-3 gap-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 lg:w-72 lg:grid-cols-1 lg:gap-3">
          <Stat value={matchCount} label="matches listed" />
          <Stat value={leagueCount} label="leagues covered" />
          <Stat value={FIXTURE_WINDOW_DAYS} label="days ahead" />
        </dl>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="lg:flex lg:items-baseline lg:gap-2">
      <dt className="order-2 text-xs text-zinc-500 lg:text-sm">{label}</dt>
      <dd className="order-1 text-xl font-semibold text-zinc-100 lg:w-10 lg:text-right">
        {value === undefined ? "—" : value}
      </dd>
    </div>
  );
}
