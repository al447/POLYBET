"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The wall clock, as a value a component may read during render.
 *
 * 🚩 `Date.now()` called in a render body is an impurity: two renders of the
 * same state produce different output, which is exactly what React's concurrent
 * rendering and the compiler are allowed to assume cannot happen. It is also
 * what `react-hooks/purity` flags. The clock is an **external system**, so the
 * supported way to read it is to subscribe — which is what this does.
 *
 * Two components were each carrying their own `setInterval` plus a throwaway
 * counter, and then reading `Date.now()` during render anyway (`useTimeLeft` in
 * `copy-queue.tsx`, `useSecondsSince` in `engine-status-bar.tsx`). Both now read
 * this instead.
 *
 * @param intervalMs how often to re-read. Sub-second values are pointless given
 * the quantisation below; 1000 is the intended case.
 */
export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const id = setInterval(onStoreChange, intervalMs);
      return () => clearInterval(id);
    },
    [intervalMs],
  );

  return useSyncExternalStore(subscribe, getNowSnapshot, getServerSnapshot);
}

/**
 * ⚠️ **Quantised to the second, and it has to be.** React calls `getSnapshot` on
 * every render and re-renders whenever the result differs by `Object.is`. A raw
 * `Date.now()` changes on literally every call, so it would never settle — that
 * is a render loop, not a clock. Rounding down to the second keeps the value
 * stable between ticks.
 */
function getNowSnapshot(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

/**
 * `0` on the server, because a real timestamp there would differ from the
 * client's first snapshot and trip a hydration mismatch.
 *
 * Safe for every current caller: each one renders "" or a dash for a
 * non-positive clock, and all of them live inside the copy dashboard, whose
 * data is read from `localStorage` after mount and is therefore empty during
 * server render regardless.
 */
function getServerSnapshot(): number {
  return 0;
}
