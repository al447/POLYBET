import {
  DEFAULT_COPY_SETTINGS,
  type CopyEntryStatus,
  type CopyLedgerEntry,
  type CopySettings,
  type CopySizing,
  type FollowedTrader,
  type SkipReason,
} from "./types";

/**
 * Where the follow list and the copy ledger live: the browser, and only the
 * browser.
 *
 * This is consistent with the engine itself — copies are placed by the user's
 * own wallet, in their own tab, while that tab is open. Storing the settings
 * anywhere else would imply something is watching on their behalf when nothing
 * is. The visible cost is that follows and history are **per-device** and are
 * lost by clearing site data; that trade is deliberate, and the upgrade path
 * (Privy `custom_metadata`, already used for legal acceptance) is a drop-in
 * replacement for `readFollows`/`writeFollows` if it is ever wanted.
 *
 * Everything here is defensive to the point of paranoia about what it reads
 * back. `localStorage` is user-writable, survives deploys that change these
 * shapes, and is shared with every other script on the origin — so a stored
 * value is untrusted input, not a value we wrote. The sanitisers are pure and
 * unit-tested against exactly that.
 */

/**
 * Versioned so a future shape change cannot be silently misread as the current
 * one. Bumping `v1` abandons old data rather than migrating it — appropriate
 * for a local cache of things the user can re-create in a few clicks, and much
 * safer than a half-correct migration of records that drive spending caps.
 */
export const COPY_STORAGE_KEYS = {
  follows: "polybet.copy.v1.follows",
  ledger: "polybet.copy.v1.ledger",
} as const;

/**
 * Ledger rows kept, newest first. Bounds unbounded growth in a store with a
 * ~5MB budget shared across the whole origin.
 *
 * ⚠️ Trimming discards *history*, never *state*. The four headline tiles are
 * computed from this list, so a trimmed ledger under-reports lifetime deployed
 * capital. 500 rows is far beyond what a browser-tab engine will produce in
 * normal use; if that ever stops being true, the tiles need a separate running
 * total rather than a bigger cap.
 */
export const LEDGER_MAX_ENTRIES = 500;

const VALID_STATUSES: readonly CopyEntryStatus[] = [
  "queued",
  "placed",
  "simulated",
  "skipped",
  "failed",
  "cancelled",
];

const VALID_SKIP_REASONS: readonly SkipReason[] = [
  "per_trade_cap",
  "daily_cap",
  "total_cap",
  "below_minimum",
  "market_closed",
  "trader_paused",
  "no_position_to_exit",
  "insufficient_balance",
  "preflight_rejected",
];

/* ------------------------------------------------------------------ *
 * Sanitisers — pure, so the untrusted-input handling is testable.
 * ------------------------------------------------------------------ */

/**
 * Coerces stored JSON into a follow list, dropping anything unusable.
 *
 * The one rule that matters: a **corrupt or missing cursor becomes `null`**,
 * never `0`. `0` would mean "copy this trader's entire history immediately" —
 * a bad value in storage would turn into hundreds of real orders. `null` means
 * "seed me", and copies nothing until it is.
 */
export function sanitiseFollows(payload: unknown): FollowedTrader[] {
  if (!Array.isArray(payload)) return [];

  const follows: FollowedTrader[] = [];
  const seen = new Set<string>();

  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const address = str(row.address).toLowerCase();
    if (!address.startsWith("0x")) continue;
    // A duplicated address would double every copy for that trader.
    if (seen.has(address)) continue;
    seen.add(address);

    const cursor = row.cursor;
    follows.push({
      address,
      name: str(row.name) || address,
      avatar: str(row.avatar) || undefined,
      followedAt: isoOrEmpty(row.followedAt),
      cursor:
        typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0
          ? Math.trunc(cursor)
          : null,
      paused: row.paused === true,
      settings: sanitiseSettings(row.settings),
    });
  }

  return follows;
}

/**
 * Caps fall back to the defaults, never to "unlimited".
 *
 * A missing `dailyCapUsd` read as `Infinity`, or as absent-so-ignore, would
 * turn a storage glitch into uncapped spending. Every unreadable limit
 * therefore lands on `DEFAULT_COPY_SETTINGS`, which is conservative by
 * construction.
 */
export function sanitiseSettings(payload: unknown): CopySettings {
  if (typeof payload !== "object" || payload === null) return { ...DEFAULT_COPY_SETTINGS };
  const row = payload as Record<string, unknown>;

  return {
    sizing: sanitiseSizing(row.sizing),
    perTradeCapUsd: positive(row.perTradeCapUsd, DEFAULT_COPY_SETTINGS.perTradeCapUsd),
    dailyCapUsd: positive(row.dailyCapUsd, DEFAULT_COPY_SETTINGS.dailyCapUsd),
    totalCapUsd: positive(row.totalCapUsd, DEFAULT_COPY_SETTINGS.totalCapUsd),
  };
}

function sanitiseSizing(payload: unknown): CopySizing {
  if (typeof payload !== "object" || payload === null) return { ...DEFAULT_COPY_SETTINGS.sizing };
  const row = payload as Record<string, unknown>;

  if (row.mode === "percent") {
    return {
      mode: "percent",
      percentOfTheirNotional: positive(row.percentOfTheirNotional, 0.2),
    };
  }
  if (row.mode === "fixed") {
    return { mode: "fixed", usd: positive(row.usd, 25) };
  }
  return { ...DEFAULT_COPY_SETTINGS.sizing };
}

/**
 * Coerces stored JSON into ledger rows.
 *
 * Rows missing an id, an intent key or a recognised status are dropped rather
 * than repaired: the intent key is what stops a copy being placed twice across
 * a page reload, and a row that cannot be identified cannot do that job.
 */
export function sanitiseLedger(payload: unknown): CopyLedgerEntry[] {
  if (!Array.isArray(payload)) return [];

  const entries: CopyLedgerEntry[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const id = str(row.id);
    const intentKey = str(row.intentKey);
    const status = str(row.status) as CopyEntryStatus;
    const side = str(row.side).toUpperCase();

    if (!id || !intentKey) continue;
    if (!VALID_STATUSES.includes(status)) continue;
    if (side !== "BUY" && side !== "SELL") continue;

    const skipReason = str(row.skipReason) as SkipReason;

    entries.push({
      id,
      intentKey,
      address: str(row.address).toLowerCase(),
      traderName: str(row.traderName),
      side,
      tokenId: str(row.tokenId),
      conditionId: str(row.conditionId),
      title: str(row.title),
      outcome: str(row.outcome),
      slug: str(row.slug),
      eventSlug: str(row.eventSlug),
      icon: str(row.icon) || undefined,
      decidedAt: isoOrEmpty(row.decidedAt),
      sourceTimestamp: finite(row.sourceTimestamp, 0),
      status,
      skipReason: VALID_SKIP_REASONS.includes(skipReason) ? skipReason : undefined,
      amountUsd: optionalFinite(row.amountUsd),
      shares: optionalFinite(row.shares),
      expectedPrice: optionalFinite(row.expectedPrice),
      feeBps: optionalFinite(row.feeBps),
      orderId: str(row.orderId) || undefined,
      error: str(row.error) || undefined,
    });
  }

  return entries;
}

/* ------------------------------------------------------------------ *
 * Storage access
 * ------------------------------------------------------------------ */

/**
 * `null` during SSR and in any environment without storage (Safari private
 * mode has historically thrown on access, not just on write).
 */
function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Corrupt JSON reads as empty rather than throwing. A half-written value
    // must not be able to take down the page that would let the user fix it.
    return null;
  }
}

/**
 * Writes, and on a quota failure sheds the oldest half of the payload and tries
 * once more.
 *
 * Only meaningful for the ledger, which is the only list that grows without
 * bound. Returns whether the value was stored, so a caller can tell the
 * difference between "saved" and "kept in memory for this session only".
 */
function writeJson(key: string, value: unknown): boolean {
  const store = storage();
  if (!store) return false;

  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    if (!Array.isArray(value) || value.length < 2) return false;
    try {
      store.setItem(key, JSON.stringify(value.slice(0, Math.floor(value.length / 2))));
      return true;
    } catch {
      return false;
    }
  }
}

export function readFollows(): FollowedTrader[] {
  return sanitiseFollows(readJson(COPY_STORAGE_KEYS.follows));
}

export function writeFollows(follows: readonly FollowedTrader[]): boolean {
  return writeJson(COPY_STORAGE_KEYS.follows, follows);
}

/** Newest first, matching how every tab renders it. */
export function readLedger(): CopyLedgerEntry[] {
  return sanitiseLedger(readJson(COPY_STORAGE_KEYS.ledger));
}

export function writeLedger(entries: readonly CopyLedgerEntry[]): boolean {
  return writeJson(COPY_STORAGE_KEYS.ledger, entries.slice(0, LEDGER_MAX_ENTRIES));
}

/**
 * Prepends rows and persists, returning the new list.
 *
 * Pure in its return value — the caller sets React state from what comes back
 * rather than re-reading storage, so a failed write still shows the user what
 * happened in this session instead of silently dropping it from the UI.
 */
export function appendLedger(
  existing: readonly CopyLedgerEntry[],
  additions: readonly CopyLedgerEntry[],
): CopyLedgerEntry[] {
  if (additions.length === 0) return existing as CopyLedgerEntry[];
  const next = [...additions, ...existing].slice(0, LEDGER_MAX_ENTRIES);
  writeLedger(next);
  return next;
}

/** Replaces one row by id — how a `queued` copy becomes `placed`, `failed` or `cancelled`. */
export function updateLedgerEntry(
  existing: readonly CopyLedgerEntry[],
  id: string,
  patch: Partial<CopyLedgerEntry>,
): CopyLedgerEntry[] {
  const next = existing.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  writeLedger(next);
  return next;
}

/** Wipes both keys. Used by the "stop copying and forget" path and by tests. */
export function clearCopyStorage(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(COPY_STORAGE_KEYS.follows);
    store.removeItem(COPY_STORAGE_KEYS.ledger);
  } catch {
    // Nothing useful to do — the caller's in-memory state is already cleared.
  }
}

/* ------------------------------------------------------------------ *
 * Coercion helpers
 * ------------------------------------------------------------------ */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Keeps a parseable ISO timestamp, discards anything else. */
function isoOrEmpty(value: unknown): string {
  const raw = str(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : "";
}
