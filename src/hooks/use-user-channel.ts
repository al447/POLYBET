"use client";

import { useEffect, useRef, useState } from "react";

import {
  applyUserEvent,
  subscribeUserChannel,
  EMPTY_USER_CHANNEL_STATE,
  type UserChannelState,
} from "@/lib/polymarket/user-events";
import type { BrowserClient } from "@/lib/polymarket/browser-client";

export type UserChannelStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

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
 * Live fills and order status for the signed-in user (FR-4.5, Step 3.7).
 * Pass `null` before the wallet is connected — the hook simply stays `idle`.
 *
 * Resilience mirrors `useOrderBook`: the SDK's `subscribe()` exposes no
 * reconnect state on its public type surface, so any exit from the `for await`
 * loop is treated as "connection lost" and re-subscribed with exponential
 * backoff.
 *
 * ⚠️ **The resync differs from the order book's, and this is the part worth
 * understanding.** A market re-subscribe replays a full `"book"` snapshot, so
 * dropping local state and waiting is correct there. The user channel has no
 * snapshot — it only ever pushes *events* — so anything that happened during a
 * gap is simply gone from the socket's perspective. What we do instead is bump
 * `revision` on every successful (re)connect, which tells consumers to refetch
 * positions, cash, and open orders over REST. That REST read, not the socket,
 * is the state of record after a disconnect.
 *
 * Accumulated `fills` are deliberately *kept* across a reconnect: they're a
 * display log of what this session saw, and clearing them would blank the
 * user's recent-activity list every time a laptop lid closes.
 */
export function useUserChannel(client: BrowserClient | null): {
  state: UserChannelState;
  status: UserChannelStatus;
} {
  const [state, setState] = useState<UserChannelState>(EMPTY_USER_CHANNEL_STATE);
  const [status, setStatus] = useState<UserChannelStatus>("idle");
  const stateRef = useRef<UserChannelState>(EMPTY_USER_CHANNEL_STATE);

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let activeHandle: { close: () => Promise<void> } | undefined;

    async function run() {
      if (!client) {
        setStatus("idle");
        return;
      }

      while (!controller.signal.aborted) {
        setStatus(attempt === 0 ? "connecting" : "reconnecting");

        try {
          const handle = await subscribeUserChannel(client);
          if (controller.signal.aborted) {
            await handle.close();
            return;
          }
          activeHandle = handle;
          setStatus("live");
          attempt = 0;

          // Every connect — including the first — invalidates cached reads:
          // on a reconnect we missed whatever happened during the gap, and on
          // the first one the consumer may have loaded before we attached.
          stateRef.current = { ...stateRef.current, revision: stateRef.current.revision + 1 };
          setState(stateRef.current);

          for await (const event of handle) {
            if (controller.signal.aborted) break;
            stateRef.current = applyUserEvent(stateRef.current, event);
            setState(stateRef.current);
          }
        } catch {
          // Any throw means the subscription died; nothing more specific to
          // branch on, so fall through to the backoff below.
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
  }, [client]);

  return { state, status };
}
