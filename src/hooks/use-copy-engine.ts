"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { decideCopy, selectCopyableIntents, summariseBudget } from "@/lib/copy-trade/engine";
import {
  hasExpired,
  placeCopy,
  planResolution,
  readAvailableUsd,
  requiredUsd,
  runPreflight,
} from "@/lib/copy-trade/execute";
import {
  appendLedger,
  readFollows,
  readLedger,
  updateLedgerEntry,
  writeFollows,
} from "@/lib/copy-trade/store";
import { fetchTraderPositionSizes, fetchTraderTrades } from "@/lib/copy-trade/trader-feed";
import {
  COPY_EXECUTION_MODE,
  type CopyDecision,
  type CopyIntent,
  type CopyLedgerEntry,
  type CopySettings,
  type ExitContext,
  type FollowedTrader,
} from "@/lib/copy-trade/types";
import type { BrowserClient } from "@/lib/polymarket/browser-client";
import { listPortfolioPositions } from "@/lib/polymarket/portfolio";

import { useBrowserClient, type BrowserClientStatus } from "./use-browser-client";

/**
 * The copy engine's loop: poll the traders the user follows, decide what each
 * of their trades means for this user, and write the result to the ledger.
 *
 * 🚩 **This is the entire "daemon", and it lives in a browser tab.** That is
 * the design, not a limitation to route around later. A server-side copier
 * would need the authority to sign for the user without asking — the exact
 * property that makes copy trading a custody question (OI-5) — and Workers
 * cannot host a long-lived loop anyway (OI-3). Running here means the engine
 * has no more authority than the user sitting at the screen.
 *
 * The honest costs, both surfaced in the UI rather than hidden:
 *
 *  - Copies only happen **while the tab is open**. Close it and nothing is
 *    watched.
 *  - Browsers throttle timers in background tabs to roughly one per minute, so
 *    a backgrounded tab checks far less often than {@link POLL_INTERVAL_MS}.
 *    A `visibilitychange` listener catches up the moment it is foregrounded.
 *
 * All decision logic lives in `engine.ts` and is pure; this hook is only
 * plumbing — fetch, call the engine, persist, repeat. Anything here that starts
 * looking like a rule about *whether* to copy belongs in `engine.ts` where it
 * can be tested.
 */

/**
 * How often to poll each followed trader.
 *
 * A floor, not a guarantee: this is per-trader network work, and background
 * tabs are throttled well below it. Twenty seconds keeps a copy within roughly
 * half a minute of the source trade while staying polite to a public,
 * unauthenticated API that we are calling on every user's behalf.
 */
export const POLL_INTERVAL_MS = 20_000;

export type CopyEngineStatus = "signed-out" | "idle" | "watching" | "paused";

export type CopyEngine = {
  status: CopyEngineStatus;
  follows: FollowedTrader[];
  ledger: CopyLedgerEntry[];
  /** Copies waiting on the user's confirmation, newest first. */
  queue: CopyLedgerEntry[];
  /** ISO timestamp of the last completed pass, or `null` before the first. */
  lastCheckedAt: string | null;
  checking: boolean;
  /** False until localStorage has been read — nothing renders from it before. */
  hydrated: boolean;
  /**
   * The wallet that will sign copies, and its state.
   *
   * 🚩 Exposed rather than let the queue UI call `useBrowserClient` itself. A
   * second instance would be a *different* client: the user would connect one
   * and place with the other, and "Connect wallet" would appear to do nothing.
   * There is exactly one signer on this page, and this is it.
   */
  client: BrowserClient | null;
  walletStatus: BrowserClientStatus;
  connectWallet: () => Promise<void>;
  /** Ids currently being placed — the button that started them is disabled until they land. */
  placing: string[];
  checkNow: () => void;
  pauseAll: () => void;
  resumeAll: () => void;
  followTrader: (
    trader: { address: string; name: string; avatar?: string },
    settings: CopySettings,
  ) => void;
  unfollowTrader: (address: string) => void;
  dismissQueued: (id: string) => void;
  /** Signs and sends one queued copy. The only path in this feature that spends money. */
  placeQueued: (id: string) => Promise<void>;
};

export function useCopyEngine(): CopyEngine {
  const { client, status: clientStatus, connect: connectWallet } = useBrowserClient();

  const [follows, setFollows] = useState<FollowedTrader[]>([]);
  const [ledger, setLedger] = useState<CopyLedgerEntry[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [placing, setPlacing] = useState<string[]>([]);

  // Refs shadow the state so the polling loop reads current values without
  // being torn down and rebuilt every time either one changes.
  const followsRef = useRef<FollowedTrader[]>([]);
  const ledgerRef = useRef<CopyLedgerEntry[]>([]);
  const runningRef = useRef(false);
  const clientRef = useRef<BrowserClient | null>(null);
  // 🚩 The double-click guard, and it must be a ref. State updates are batched,
  // so two clicks in the same tick would both read `placing` as empty and both
  // sign — one intent, two orders, twice the exposure the user agreed to.
  const placingRef = useRef<Set<string>>(new Set());
  /**
   * Aborts the in-flight poll when the engine stops.
   *
   * `dataApiFetch` in `trader-feed.ts` was written to compose a caller's signal
   * with its own 8s timeout, but nothing ever passed one — so a poll that began
   * just before an unmount ran to completion against a hook nobody was reading.
   */
  const abortRef = useRef<AbortController | null>(null);

  // Written in an effect, not during render: a ref mutated while rendering is
  // read by whichever pass happens to be in flight, which is exactly the kind
  // of ambiguity a polling loop does not need.
  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  const commitFollows = useCallback((next: FollowedTrader[]) => {
    followsRef.current = next;
    setFollows(next);
    writeFollows(next);
  }, []);

  /**
   * Clears the queue: every `queued` row is preflighted, balance-checked and
   * resolved.
   *
   * 🚩 **Dry run only.** Under `"live"`, `queued` means "waiting for the user's
   * click" and this must not touch it — the click-to-place path runs its own
   * preflight at the moment of the click, because a preflight answer from five
   * minutes ago says nothing about whether the order is placeable now.
   *
   * Sweeping the whole queue rather than only this pass's additions is what
   * recovers rows stranded by a closed tab: the engine stops when the tab does,
   * so a reopened tab always finds whatever the last session left mid-flight.
   * Those rows are almost always expired by then, which `planResolution`
   * cancels rather than acting on.
   *
   * Persisting per row, rather than once at the end, is deliberate for the same
   * reason — a sweep interrupted halfway keeps what it already decided.
   */
  const resolveQueue = useCallback(async () => {
    const queued = ledgerRef.current.filter((entry) => entry.status === "queued");
    if (queued.length === 0) return;

    // Read once per sweep, then decremented locally as buys are approved.
    // Re-reading per row would return the same figure every time — nothing has
    // settled on chain — so ten copies would each pass the same check and
    // overdraw together, exactly the bug `summariseBudget` avoids for caps.
    let available = await readAvailableUsd(clientRef.current);

    let next = ledgerRef.current;
    for (const entry of queued) {
      // Fresh per row: a preflight round trip takes real time, and the expiry
      // check has to be against the clock now, not when the sweep started.
      const nowMs = Date.now();
      const preflight = hasExpired(entry, nowMs) ? null : await runPreflight(entry);
      const patch = planResolution({ entry, preflight, availableUsd: available, nowMs });

      if (patch.status === "simulated" && entry.side === "BUY" && available !== null) {
        available -= requiredUsd(entry.amountUsd ?? 0, patch.feeBps ?? 0);
      }

      next = updateLedgerEntry(next, entry.id, patch);
    }

    ledgerRef.current = next;
    setLedger(next);
  }, []);

  /**
   * Cancels queued copies that have aged out. The live path's counterpart to
   * `resolveQueue`, which does not run under `"live"`.
   *
   * 🚩 Without this a queue row would wait forever, and the Place button on a
   * three-hour-old decision would size an order against a price that is long
   * gone — while still holding its share of the caps. Expiring is the honest
   * answer: the copy did not happen. See {@link QUEUE_EXPIRY_MS}.
   *
   * A row mid-placement is left alone. `placeCopy` re-checks expiry itself, and
   * cancelling underneath an in-flight signature would file "expired" over a
   * copy that is about to come back `placed`.
   */
  const expireQueue = useCallback(() => {
    const nowMs = Date.now();
    const stale = ledgerRef.current.filter(
      (entry) =>
        entry.status === "queued" && !placingRef.current.has(entry.id) && hasExpired(entry, nowMs),
    );
    if (stale.length === 0) return;

    let next = ledgerRef.current;
    for (const entry of stale) {
      next = updateLedgerEntry(next, entry.id, {
        status: "cancelled",
        error: "Expired before it could be placed",
      });
    }

    ledgerRef.current = next;
    setLedger(next);
  }, []);

  /**
   * Signs and sends one queued copy, then records what came back.
   *
   * All the interesting work is in `placeCopy` — this is the plumbing around
   * it: refuse anything not currently `queued` (a second click on a row that
   * already went through), hold the id so the button can disable itself, and
   * write the patch against `ledgerRef.current` rather than a snapshot taken
   * before the round trip, since a poll may have appended rows meanwhile.
   */
  const placeQueued = useCallback(async (id: string) => {
    if (placingRef.current.has(id)) return;

    const entry = ledgerRef.current.find((row) => row.id === id);
    if (!entry || entry.status !== "queued") return;

    placingRef.current.add(id);
    setPlacing([...placingRef.current]);

    try {
      const patch = await placeCopy(clientRef.current, entry);
      const next = updateLedgerEntry(ledgerRef.current, id, patch);
      ledgerRef.current = next;
      setLedger(next);
    } finally {
      placingRef.current.delete(id);
      setPlacing([...placingRef.current]);
    }
  }, []);

  // localStorage is read in an effect, never during render: reading it while
  // rendering would make the server and client markup disagree.
  //
  // `react-hooks/set-state-in-effect` is disabled here deliberately. The rule's
  // own remedy — subscribe to the external system with `useSyncExternalStore` —
  // does not fit: this is a **one-shot hydration read**, not a subscription, and
  // the engine owns `followsRef`/`ledgerRef` as the source of truth that the
  // poll loop mutates directly. Routing that ownership through an external store
  // is a real refactor of this hook, not a lint fix, and there is nothing to
  // subscribe to — no other tab writes these keys mid-session.
  //
  // The cascading render the rule warns about is one extra pass, once per mount,
  // which `hydrated` already exists to gate the UI through.
  //
  // Disabled as a block, not with `eslint-disable-next-line`: the rule reports
  // the `setFollows` **call**, not the `useEffect` it sits in, so a directive
  // above the hook suppresses nothing and is itself flagged as unused.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const storedFollows = readFollows();
    const storedLedger = readLedger();
    followsRef.current = storedFollows;
    ledgerRef.current = storedLedger;
    setFollows(storedFollows);
    setLedger(storedLedger);
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  /**
   * One pass over every active trader.
   *
   * Guarded against overlapping itself: a slow poll must not have a second poll
   * start behind it, or the same intent is evaluated twice against a ledger
   * that has not yet been written.
   */
  const runCheck = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setChecking(true);

    // Read once per pass rather than per fetch: the effect below replaces the
    // controller when the engine restarts, and a pass should be cancelled by
    // the controller it started under, not by whichever one is current when it
    // happens to finish.
    const signal = abortRef.current?.signal;

    try {
      const nowMs = Date.now();
      const nowSeconds = Math.floor(nowMs / 1000);

      let nextFollows = followsRef.current;
      const additions: CopyLedgerEntry[] = [];

      // Both are fetched at most once per pass, and only if an exit actually
      // needs them — the common pass has no new trades at all and should cost
      // one request per trader, not three.
      let ourShares: Map<string, number> | null = null;
      const theirSizes = new Map<string, Map<string, number>>();

      for (const followed of followsRef.current) {
        if (followed.paused) continue;

        // A cursor of null means the record was never seeded, or was corrupt
        // on the way in. Seed it and copy nothing this pass — the alternative
        // reading, zero, would replay the trader's entire history as orders.
        if (followed.cursor === null) {
          nextFollows = nextFollows.map((entry) =>
            entry.address === followed.address ? { ...entry, cursor: nowSeconds } : entry,
          );
          continue;
        }

        const trades = await fetchTraderTrades(followed.address, { signal });

        // Bail before using the result, never after: an aborted fetch returns
        // an **empty array**, indistinguishable from "this trader did nothing".
        // The cursor is safe either way — `selectCopyableIntents` only ever
        // advances it to an intent it actually returned — but the SELL branch
        // below is not, so the loop must not continue past an abort. Every
        // commit happens below the loop, so returning here writes nothing.
        if (signal?.aborted) return;

        const { intents, nextCursor } = selectCopyableIntents({
          trades,
          cursor: followed.cursor,
          nowSeconds,
        });

        for (const intent of intents) {
          // The dedup that survives a page reload. Without it, a refresh
          // re-evaluates whatever sat between the stored cursor and now.
          const known = [...ledgerRef.current, ...additions].some(
            (entry) => entry.intentKey === intent.key,
          );
          if (known) continue;

          let exit: ExitContext | undefined;
          if (intent.side === "SELL") {
            if (!ourShares) ourShares = await readOurShares(clientRef.current);
            if (!theirSizes.has(followed.address)) {
              theirSizes.set(
                followed.address,
                await fetchTraderPositionSizes(followed.address, { signal }),
              );
            }

            // 🚩 The load-bearing abort check. An aborted `/positions` read
            // yields an **empty map**, and the line below reads a missing entry
            // as `null`, which `decideCopy` deliberately answers with a **full
            // exit**. That is the right default for a genuine outage and the
            // wrong one for "we walked away mid-request" — without this, closing
            // the tab could queue a full exit the trader never made.
            if (signal?.aborted) return;

            const theirs = theirSizes.get(followed.address);
            exit = {
              ourShares: ourShares.get(intent.tokenId) ?? 0,
              // `undefined` from the map and a failed fetch both mean "we could
              // not read it", which `decideCopy` answers with a full exit.
              theirSharesAfter: theirs?.get(intent.tokenId) ?? null,
            };
          }

          const decision = decideCopy({
            intent,
            settings: followed.settings,
            budget: summariseBudget(
              [...ledgerRef.current, ...additions],
              followed.address,
              nowMs,
            ),
            exit,
          });

          additions.push(buildEntry(intent, followed, decision, nowMs));
        }

        if (nextCursor !== followed.cursor) {
          nextFollows = nextFollows.map((entry) =>
            entry.address === followed.address ? { ...entry, cursor: nextCursor } : entry,
          );
        }
      }

      if (nextFollows !== followsRef.current) commitFollows(nextFollows);

      if (additions.length > 0) {
        // Oldest-first within the pass, so the ledger's newest-first order
        // reflects the order the trader actually traded in.
        const next = appendLedger(ledgerRef.current, additions.reverse());
        ledgerRef.current = next;
        setLedger(next);
      }

      // Inside the same `runningRef` guard as the poll above, so a slow sweep
      // cannot have the next tick's poll start behind it and re-evaluate an
      // intent against a ledger this sweep has not finished writing.
      //
      // Under `"live"` the queue is the user's to clear, so the pass only ages
      // out what they never got to — it must never place anything itself.
      if (COPY_EXECUTION_MODE === "simulated") await resolveQueue();
      else expireQueue();

      setLastCheckedAt(new Date(nowMs).toISOString());
    } finally {
      runningRef.current = false;
      setChecking(false);
    }
  }, [commitFollows, resolveQueue, expireQueue]);

  // Held in a ref so the interval below is created once and never restarted by
  // a change of identity, which would reset its phase on every render. Declared
  // before the interval effect so this assignment runs first.
  const runCheckRef = useRef(runCheck);
  useEffect(() => {
    runCheckRef.current = runCheck;
  }, [runCheck]);

  const active = useMemo(() => follows.filter((entry) => !entry.paused), [follows]);
  const watching = clientStatus !== "signed-out" && hydrated;

  useEffect(() => {
    if (!watching) return;

    // Fresh per run of this effect, so a restart is not cancelled by the
    // previous run's abort. `runCheck` reads it through `abortRef`.
    const controller = new AbortController();
    abortRef.current = controller;

    void runCheckRef.current();

    const id = setInterval(() => {
      // The timer still fires in a background tab, just rarely. Skipping the
      // work when hidden keeps a throttled tab from doing a burst of catch-up
      // requests the moment the browser lets it.
      if (typeof document !== "undefined" && document.hidden) return;
      void runCheckRef.current();
    }, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (!document.hidden) void runCheckRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      controller.abort();
      // Only clear the shared ref if it is still ours — blanking a newer run's
      // controller would leave that run's poll unabortable. The abort above is
      // what actually stops the in-flight pass; this is just tidying.
      if (abortRef.current === controller) abortRef.current = null;
    };
    // `active.length` deliberately: following the first trader should start a
    // pass immediately rather than waiting out the current interval.
  }, [watching, active.length]);

  const setPausedAll = useCallback(
    (paused: boolean) => {
      commitFollows(followsRef.current.map((entry) => ({ ...entry, paused })));
    },
    [commitFollows],
  );

  const followTrader = useCallback<CopyEngine["followTrader"]>(
    (trader, settings) => {
      const address = trader.address.toLowerCase();
      const next: FollowedTrader = {
        address,
        name: trader.name,
        avatar: trader.avatar,
        followedAt: new Date().toISOString(),
        // Seeded here, not left null: "follow" means "from this moment", and
        // the trader's history must never become a burst of live orders.
        cursor: Math.floor(Date.now() / 1000),
        paused: false,
        settings,
      };

      commitFollows([...followsRef.current.filter((entry) => entry.address !== address), next]);
    },
    [commitFollows],
  );

  const unfollowTrader = useCallback(
    (address: string) => {
      const lower = address.toLowerCase();
      commitFollows(followsRef.current.filter((entry) => entry.address !== lower));
    },
    [commitFollows],
  );

  const dismissQueued = useCallback((id: string) => {
    const next = updateLedgerEntry(ledgerRef.current, id, { status: "cancelled" });
    ledgerRef.current = next;
    setLedger(next);
  }, []);

  const queue = useMemo(() => ledger.filter((entry) => entry.status === "queued"), [ledger]);

  const status: CopyEngineStatus =
    clientStatus === "signed-out"
      ? "signed-out"
      : follows.length === 0
        ? "idle"
        : active.length === 0
          ? "paused"
          : "watching";

  return {
    status,
    follows,
    ledger,
    queue,
    lastCheckedAt,
    checking,
    hydrated,
    client,
    walletStatus: clientStatus,
    connectWallet,
    placing,
    checkNow: () => void runCheckRef.current(),
    pauseAll: () => setPausedAll(true),
    resumeAll: () => setPausedAll(false),
    followTrader,
    unfollowTrader,
    dismissQueued,
    placeQueued,
  };
}

/**
 * The user's own holdings as `tokenId → shares`, for sizing an exit.
 *
 * An empty map when the wallet is not connected yet, which `decideCopy` reads
 * as "nothing to exit" — correct, and it keeps a not-yet-connected client from
 * being an error case in the loop.
 */
async function readOurShares(client: BrowserClient | null): Promise<Map<string, number>> {
  const shares = new Map<string, number>();
  if (!client) return shares;

  try {
    // 🚩 `tokenId`, not `asset`. Two different position shapes are in play:
    // the Data API's raw JSON rows (`trader-feed.ts`, where the field really is
    // `asset`) and the SDK's typed `Position` returned here, where it is
    // `tokenId`. Reading `asset` off this one is silently `undefined`, so every
    // holding was skipped, the map came back empty, and `decideCopy` read that
    // as "nothing to exit" — exits were never sized.
    for (const position of await listPortfolioPositions(client)) {
      if (!position.tokenId) continue;
      const size = Number(position.size);
      if (Number.isFinite(size) && size > 0) shares.set(position.tokenId, size);
    }
  } catch {
    // A failed read must not stop the pass. It reads as "no position", which
    // skips the exit rather than guessing at a size.
  }

  return shares;
}

/**
 * Turns a decision into the row the tabs render.
 *
 * A copy the engine approved always lands as **`queued`** first, never straight
 * to a terminal status. `resolveQueue` is what moves it on — to `simulated` in
 * a dry run, or, under `"live"`, not at all until the user clicks.
 *
 * Writing the row before resolving it, rather than after, buys three things:
 * the user sees the decision immediately, a tab closed mid-resolution leaves a
 * record instead of a hole, and `queued` already counts against the caps (see
 * `summariseBudget`) so the budget is reserved for the whole round trip.
 */
function buildEntry(
  intent: CopyIntent,
  followed: FollowedTrader,
  decision: CopyDecision,
  nowMs: number,
): CopyLedgerEntry {
  const base = {
    id: newId(intent.key),
    intentKey: intent.key,
    address: followed.address,
    traderName: followed.name,
    side: intent.side,
    tokenId: intent.tokenId,
    conditionId: intent.conditionId,
    title: intent.title,
    outcome: intent.outcome,
    slug: intent.slug,
    eventSlug: intent.eventSlug,
    icon: intent.icon,
    decidedAt: new Date(nowMs).toISOString(),
    sourceTimestamp: intent.timestamp,
    expectedPrice: intent.avgPrice,
  };

  if (decision.action === "skip") {
    return { ...base, status: "skipped", skipReason: decision.reason };
  }

  if (decision.action === "sell") {
    return {
      ...base,
      status: "queued",
      shares: decision.shares,
      // Recorded in USD too, because the budget nets exits out of deployed
      // capital and cannot do that from a share count alone.
      amountUsd: decision.shares * intent.avgPrice,
    };
  }

  return { ...base, status: "queued", amountUsd: decision.amountUsd };
}

function newId(seed: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${seed}#${Date.now()}#${Math.random().toString(36).slice(2)}`;
}
