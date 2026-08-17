/**
 * Display formatters shared across market surfaces.
 *
 * These lived as private copies in `market-card.tsx` and the market detail
 * page. The hero would have been a third copy, so they moved here instead —
 * a market's volume should read the same everywhere it appears.
 *
 * No `server-only` guard: pure string work, safe on either side of the
 * boundary (same reasoning as `gamma-types.ts`).
 */

/** Compact USD, e.g. `$1.3M`, `$263.7K`, `$412`. */
export function formatUsd(value: number | string | undefined): string {
  const num = typeof value === "string" ? Number(value) : value;
  if (!num || !Number.isFinite(num)) return "$0";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

/**
 * Exact USD to the cent, e.g. `$287,429.03`, `-$1,204.50`.
 *
 * The counterpart to `formatUsd`, not a replacement: a volume stat reads
 * better compact (`$2.3M`), but a P&L headline is a specific amount someone
 * actually made, and rounding it to `$287.4K` reads as an estimate. Use the
 * compact one for context figures and this one for money that is the point of
 * the row.
 *
 * The sign goes before the dollar, not inside it — `-$1,204.50` rather than
 * `$-1,204.50`.
 */
export function formatUsdExact(value: number | string | undefined): string {
  const num = typeof value === "string" ? Number(value) : value;
  // `Number.isFinite` already rejects undefined and NaN — but unlike
  // `formatUsd`'s `!num` guard it lets 0 through, which must render "$0.00"
  // rather than being treated as missing.
  if (!Number.isFinite(num)) return "$0.00";

  const magnitude = Math.abs(num as number).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${(num as number) < 0 ? "-" : ""}$${magnitude}`;
}

/**
 * `0x1234…cdef` — the full value belongs in a `title` attribute, never
 * truncated silently.
 *
 * Lives here rather than in `ui/primitives.tsx` (which re-exports it for its
 * existing callers) because `lib/` must not import from `components/`: the
 * leaderboard parser needs this while running server-side, and dragging a
 * component module into a data path to get one pure string function is the
 * wrong direction of dependency.
 */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Card-style end date: `Nov 3, 2026`, `Ended`, or `No end date`.
 *
 * Gamma leaves plenty of events undated or expired-but-open (see
 * `isLiveEvent`), so both fallbacks are load-bearing rather than defensive
 * padding.
 */
export function formatEndDate(endDate: string | undefined, now: Date = new Date()): string {
  if (!endDate) return "No end date";
  const date = new Date(endDate);
  if (Number.isNaN(date.getTime())) return "No end date";
  if (date.getTime() < now.getTime()) return "Ended";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Coarse "how long ago", e.g. `20h ago` — the timestamp style on comments.
 *
 * Deliberately coarse: comments are context, not an audit trail, and a
 * to-the-minute figure would imply a precision the cached data doesn't have.
 * `now` is a parameter so this stays pure and testable, matching
 * `endingBefore` in gamma-types.ts.
 */
export function formatRelativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}
