"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpenOrder } from "@polymarket/bindings/clob";

import { cancelOpenOrder, listOpenOrdersForToken, type BrowserClient } from "@/lib/polymarket/browser-client";
import { Card } from "@/components/ui/primitives";

/**
 * Resting limit orders for the currently-selected outcome (Step 3.6). Shows
 * nothing when there are none — most of the time a ticket has no open
 * orders, and an empty card would just be clutter — and nothing during the
 * first fetch, to avoid a loading flash for something that's usually empty
 * anyway.
 *
 * No bulk "cancel all" here — `cancelAll`/`cancelOrders` exist on the SDK
 * but aren't wired to a UI action; per-order cancel is what Step 3.6's
 * acceptance criterion actually asks for.
 */
export function OpenOrdersPanel({
  client,
  tokenId,
  outcomeLabel,
}: {
  client: BrowserClient;
  tokenId: string;
  outcomeLabel: string;
}) {
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const items = await listOpenOrdersForToken(client, tokenId);
      setOrders(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load open orders.");
    }
  }, [client, tokenId]);

  useEffect(() => {
    async function load() {
      setOrders(null);
      await refresh();
    }
    void load();
  }, [refresh]);

  const cancel = useCallback(
    async (orderId: string) => {
      setCancelingId(orderId);
      try {
        await cancelOpenOrder(client, orderId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Cancel failed.");
      } finally {
        setCancelingId(null);
      }
    },
    [client, refresh],
  );

  if (!orders || orders.length === 0) return null;

  return (
    <Card title={`Open orders — ${outcomeLabel}`}>
      <div className="space-y-2">
        {orders.map((order) => {
          const remaining = Number(order.originalSize) - Number(order.sizeMatched);
          const isBuy = order.side === "BUY";
          return (
            <div key={order.id} className="flex items-center justify-between gap-3 text-sm">
              <span className={isBuy ? "text-emerald-400" : "text-red-400"}>
                {order.side} {remaining.toFixed(2)} @ {(Number(order.price) * 100).toFixed(1)}¢
              </span>
              <button
                type="button"
                onClick={() => cancel(order.id)}
                disabled={cancelingId === order.id}
                className="shrink-0 text-xs font-semibold text-zinc-400 underline underline-offset-2 transition hover:text-zinc-200 disabled:cursor-wait disabled:opacity-50"
              >
                {cancelingId === order.id ? "Canceling…" : "Cancel"}
              </button>
            </div>
          );
        })}
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </Card>
  );
}
