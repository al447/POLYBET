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
