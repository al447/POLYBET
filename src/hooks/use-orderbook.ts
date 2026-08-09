"use client";

import { useEffect, useRef, useState } from "react";

import { applyMarketEvent, subscribeOrderBook, type OrderBookState } from "@/lib/polymarket/market-data";

export type OrderBookStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Live order book for a single token (FR-3.4, Step 3.1). Public data — no
 * wallet/session required, works before login.
 *
 * The SDK's `subscribe()` exposes no reconnect/error state on its public
 * type surface (confirmed against the shipped `.d.ts` — see market-data.ts),
 * so this hook supplies its own outer resilience layer: any exit from the
 * `for await` loop (thrown error or a closed iterator) is treated as
 * "connection lost," and we re-subscribe from scratch with exponential
 * backoff. A fresh subscribe always starts with a full `"book"` snapshot, so
 * this also satisfies NFR-6's full state resync — `book` is reset to `null`
 * at the start of every attempt rather than left showing a possibly-stale
 * view across the gap.
 *
 * All `setState` calls live inside the nested `run()` async function rather
 * than the effect body itself — `react-hooks/set-state-in-effect` flags
 * setState called synchronously in an effect's own lexical body (a real
 * pre-existing violation of this rule sits in `trading-panel.tsx`'s outcome
 * -reset effect, untouched here — out of scope for this change).
 */
export function useOrderBook(tokenId: string | undefined): {
  book: OrderBookState | null;
  status: OrderBookStatus;
} {
  const [book, setBook] = useState<OrderBookState | null>(null);
  const [status, setStatus] = useState<OrderBookStatus>("idle");
  const bookRef = useRef<OrderBookState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let activeHandle: { close: () => Promise<void> } | undefined;

    async function run() {
      if (!tokenId) {
        bookRef.current = null;
        setBook(null);
        setStatus("idle");
        return;
      }

      while (!controller.signal.aborted) {
        setStatus(attempt === 0 ? "connecting" : "reconnecting");
        bookRef.current = null;
        setBook(null);

        try {
          const handle = await subscribeOrderBook([tokenId]);
          if (controller.signal.aborted) {
            await handle.close();
            return;
          }
          activeHandle = handle;
          setStatus("live");
          attempt = 0;

          for await (const event of handle) {
            if (controller.signal.aborted) break;
            bookRef.current = applyMarketEvent(bookRef.current, event);
            setBook(bookRef.current);
          }
        } catch {
          // Falls through to the retry below — any thrown error means the
          // subscription died; there's nothing more specific to branch on.
        } finally {
          activeHandle = undefined;
        }

        if (controller.signal.aborted) return;
        attempt += 1;
        setStatus("reconnecting");
        await sleep(Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS), controller.signal);
      }
    }

    run().catch(() => {
      if (!controller.signal.aborted) setStatus("error");
    });

    return () => {
      controller.abort();
      activeHandle?.close();
    };
  }, [tokenId]);

  return { book, status };
}
